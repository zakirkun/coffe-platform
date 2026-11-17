//! The run supervisor end to end with the fake CLI: worktree, context, process, controls,
//! commit, diff and tests (no control plane involved).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::LazyLock;
use std::time::Duration;

use coffe_adapters::AdapterRegistry;
use coffe_protocol::{
    AgentEvent, AgentInput, ContextBundle, ContextFile, PermissionMode, PermissionPolicy, RunKind,
    RunMode, RunSignalKind, RunStart, RunStatus, TermSize, TestStatus, WorktreeMode, WorktreeSpec,
};
use coffe_runner::config::{RepoEntry, RunnerConfig};
use coffe_runner::error::RunnerError;
use coffe_runner::git;
use coffe_runner::paths::RunnerHome;
use coffe_runner::run_api::{RunCompletion, RunContext, RunControl, RunEmit, RunHandle};
use coffe_runner::supervisor::start_run;
use tokio::sync::mpsc;
use uuid::Uuid;

const REPO_KEY: &str = "demo";
const WAIT: Duration = Duration::from_secs(60);

/// The directory `cargo build -p coffe-fake-cli` puts the binary in (built on first use).
static FAKE_CLI_DIR: LazyLock<PathBuf> = LazyLock::new(|| {
    let status = Command::new(env!("CARGO"))
        .args(["build", "-q", "-p", "coffe-fake-cli"])
        .status()
        .expect("cargo runs");
    assert!(status.success(), "building coffe-fake-cli failed");
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("target"));
    target.join("debug")
});

struct Fixture {
    _dir: tempfile::TempDir,
    repo: PathBuf,
    ctx: RunContext,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git::run_checked(&repo, ["init", "-q", "-b", "main"]).unwrap();
    std::fs::write(repo.join("README.md"), "# Demo\n").unwrap();
    git::run_checked(&repo, ["add", "-A"]).unwrap();
    git::run_checked(
        &repo,
        ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"],
    )
    .unwrap();

    let home = RunnerHome::resolve(Some(&dir.path().join("home"))).unwrap();
    let mut config = RunnerConfig::default();
    config.policy.enable_fake_cli = true;
    config.repos.push(RepoEntry { key: REPO_KEY.to_owned(), name: "demo".to_owned(), path: repo.clone() });
    let ctx = RunContext {
        home,
        config,
        registry: AdapterRegistry::builtin(true),
        clis: Vec::new(),
        extra_bin_dir: Some(FAKE_CLI_DIR.clone()),
    };
    Fixture { _dir: dir, repo, ctx }
}

fn ticket_run(prompt: &str, mode: RunMode) -> RunStart {
    RunStart {
        run_id: Uuid::new_v4(),
        kind: RunKind::Ticket,
        project_id: Uuid::new_v4(),
        ticket_key: Some("T-1".to_owned()),
        repo_key: REPO_KEY.to_owned(),
        worktree: WorktreeSpec { mode: WorktreeMode::Branch, branch: Some("coffe/T-1".to_owned()), base_branch: "main".to_owned() },
        cli_id: "fake".to_owned(),
        model: None,
        mode,
        driver: None,
        prompt: prompt.to_owned(),
        context: ContextBundle {
            files: vec![ContextFile { name: "01-ticket.md".to_owned(), content: "# T-1\nAdd a badge\n".to_owned() }],
            attachments: Vec::new(),
        },
        permissions: PermissionPolicy {
            mode: PermissionMode::WorkspaceWrite,
            allow_tools: Vec::new(),
            deny_tools: Vec::new(),
            network: true,
            max_turns: None,
            max_budget_usd: None,
        },
        persona: None,
        resume: None,
        timeout_secs: 120,
        terminal: TermSize { cols: 100, rows: 30 },
        output_schema: None,
        auto_commit: true,
        commit_message: Some("T-1: Add a badge".to_owned()),
        test_command: None,
    }
}

/// Everything a run emitted, with helpers for the assertions.
#[derive(Default)]
struct Emitted {
    items: Vec<RunEmit>,
}

impl Emitted {
    fn output(&self) -> String {
        let bytes: Vec<u8> = self
            .items
            .iter()
            .filter_map(|item| match item {
                RunEmit::Output(bytes) => Some(bytes.as_slice()),
                _ => None,
            })
            .flatten()
            .copied()
            .collect();
        String::from_utf8_lossy(&strip_ansi_escapes::strip(bytes)).into_owned()
    }

    fn events(&self) -> impl Iterator<Item = &AgentEvent> {
        self.items.iter().filter_map(|item| match item {
            RunEmit::Event(event) => Some(event),
            _ => None,
        })
    }

    fn statuses(&self) -> Vec<RunStatus> {
        self.items
            .iter()
            .filter_map(|item| match item {
                RunEmit::State(update) => update.status,
                _ => None,
            })
            .collect()
    }
}

/// Receives emits until `run.completed`, handing each one to `on_emit` (which may control the run).
async fn collect(
    handle: &RunHandle,
    rx: &mut mpsc::UnboundedReceiver<RunEmit>,
    mut on_emit: impl FnMut(&RunEmit, &Emitted, &mpsc::UnboundedSender<RunControl>),
) -> (Emitted, RunCompletion) {
    let mut emitted = Emitted::default();
    let completion = tokio::time::timeout(WAIT, async {
        while let Some(item) = rx.recv().await {
            if let RunEmit::Completed(done) = &item {
                return Some(done.clone());
            }
            on_emit(&item, &emitted, &handle.control);
            emitted.items.push(item);
        }
        None
    })
    .await
    .expect("the run completes in time")
    .expect("the run emits run.completed");
    (emitted, completion)
}

#[tokio::test]
async fn a_structured_run_edits_commits_diffs_and_tests_in_the_ticket_worktree() {
    let fx = fixture();
    let mut start = ticket_run("Add the cart badge", RunMode::Structured);
    start.test_command = Some("echo test result: ok. 3 passed; 0 failed; 1 ignored".to_owned());
    let run_id = start.run_id;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let handle = start_run(fx.ctx.clone(), start, tx).unwrap();
    let (emitted, done) = collect(&handle, &mut rx, |_, _, _| {}).await;

    assert_eq!(done.status, RunStatus::Completed, "error: {:?}\noutput: {}", done.error, emitted.output());
    assert_eq!(emitted.statuses(), vec![RunStatus::Starting, RunStatus::Running]);
    assert_eq!(done.cli_session_id.as_deref(), Some(run_id.to_string().as_str()));
    assert!(done.summary.as_deref().is_some_and(|summary| summary.contains("FAKE_CHANGES.md")));
    assert!(emitted.events().any(|event| matches!(event, AgentEvent::ToolCall { name, .. } if name == "write_file")));
    assert!(emitted.output().contains("Working on: Add the cart badge"));
    assert!(done.usage.is_some_and(|usage| usage.available));

    let diff = done.diff.expect("a diff of the ticket branch");
    let paths: Vec<_> = diff.files.iter().map(|file| file.path.as_str()).collect();
    assert_eq!(paths, vec!["FAKE_CHANGES.md"], "context files stay out of the diff");
    let branch_tip = git::run_checked(&fx.repo, ["rev-parse", "coffe/T-1"]).unwrap().text();
    assert_eq!(done.head_commit.as_deref(), Some(branch_tip.as_str()));
    let message = git::run_checked(&fx.repo, ["log", "-1", "--format=%B", "coffe/T-1"]).unwrap().text();
    assert!(message.starts_with("T-1: Add a badge"));
    assert!(message.contains(&format!("Coffe-Run: {run_id}")));

    let tests = done.tests.expect("the test command ran");
    assert_eq!(tests.status, TestStatus::Passed);
    assert_eq!((tests.passed, tests.failed, tests.skipped), (3, 0, 1));

    let worktree = git::worktree_path(&fx.repo, "coffe/T-1").unwrap().expect("the ticket worktree exists");
    assert!(worktree.join(".coffe").join("context").join("01-ticket.md").is_file());
}

#[tokio::test]
async fn a_failing_cli_fails_the_run_without_committing() {
    let fx = fixture();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let handle = start_run(fx.ctx.clone(), ticket_run("[[fake:fail]] break", RunMode::Structured), tx).unwrap();
    let (_, done) = collect(&handle, &mut rx, |_, _, _| {}).await;

    assert_eq!(done.status, RunStatus::Failed);
    assert!(done.error.is_some_and(|error| error.contains("simulated failure")));
    assert!(done.diff.is_none());
    assert!(done.head_commit.is_none());
}

#[tokio::test]
async fn stopping_a_run_cancels_it() {
    let fx = fixture();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let handle = start_run(fx.ctx.clone(), ticket_run("[[fake:slow]] take your time", RunMode::Structured), tx).unwrap();
    let mut stopped = false;
    let (_, done) = collect(&handle, &mut rx, |item, _, control| {
        if !stopped && matches!(item, RunEmit::Event(_)) {
            stopped = true;
            control.send(RunControl::Signal(RunSignalKind::Stop)).unwrap();
        }
    })
    .await;

    assert!(stopped, "the CLI emitted an event before it was stopped");
    assert_eq!(done.status, RunStatus::Cancelled);
    assert!(done.diff.is_none());
}

#[tokio::test]
async fn permission_answers_reach_the_cli() {
    let fx = fixture();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let handle = start_run(fx.ctx.clone(), ticket_run("[[fake:permission]] edit please", RunMode::Structured), tx).unwrap();
    let (emitted, done) = collect(&handle, &mut rx, |item, _, control| {
        if let RunEmit::Event(AgentEvent::PermissionRequest { request_id, .. }) = item {
            control
                .send(RunControl::Input(AgentInput::Permission { request_id: request_id.clone(), allow: true, remember: false }))
                .unwrap();
        }
    })
    .await;

    assert_eq!(done.status, RunStatus::Completed, "error: {:?}", done.error);
    assert!(emitted.statuses().contains(&RunStatus::WaitingInput));
    assert!(done.diff.is_some_and(|diff| diff.files.iter().any(|file| file.path == "FAKE_CHANGES.md")));
}

#[tokio::test]
async fn a_pty_run_takes_keystrokes_and_commits_what_the_tui_wrote() {
    let fx = fixture();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let handle = start_run(fx.ctx.clone(), ticket_run("write NOTES.md hello", RunMode::Pty), tx).unwrap();
    let mut exited = false;
    let (emitted, done) = collect(&handle, &mut rx, |item, so_far, control| {
        if !exited && matches!(item, RunEmit::Output(_)) && (so_far.output() + &output_of(item)).contains("wrote NOTES.md") {
            exited = true;
            control.send(RunControl::Resize { cols: 120, rows: 40 }).unwrap();
            control.send(RunControl::Input(AgentInput::Keys { data: "exit\r".to_owned() })).unwrap();
        }
    })
    .await;

    assert!(exited, "output: {}", emitted.output());
    assert_eq!(done.status, RunStatus::Completed, "error: {:?}\noutput: {}", done.error, emitted.output());
    assert!(emitted.output().contains("bye"));
    assert!(done.diff.is_some_and(|diff| diff.files.iter().any(|file| file.path == "NOTES.md")));
}

fn output_of(item: &RunEmit) -> String {
    match item {
        RunEmit::Output(bytes) => String::from_utf8_lossy(&strip_ansi_escapes::strip(bytes)).into_owned(),
        _ => String::new(),
    }
}

#[tokio::test]
async fn the_runner_policy_is_enforced_before_anything_starts() {
    let fx = fixture();
    let (tx, _rx) = mpsc::unbounded_channel();

    let mut full_auto = ticket_run("x", RunMode::Structured);
    full_auto.permissions.mode = PermissionMode::FullAuto;
    assert!(matches!(start_run(fx.ctx.clone(), full_auto, tx.clone()), Err(RunnerError::Policy(_))));

    let mut foreign = ticket_run("x", RunMode::Structured);
    foreign.repo_key = "elsewhere".to_owned();
    assert!(matches!(start_run(fx.ctx.clone(), foreign, tx.clone()), Err(RunnerError::Scope(_))));

    let mut unknown = ticket_run("x", RunMode::Structured);
    unknown.cli_id = "no-such-cli".to_owned();
    assert!(matches!(start_run(fx.ctx.clone(), unknown, tx), Err(RunnerError::NotFound(_))));
}
