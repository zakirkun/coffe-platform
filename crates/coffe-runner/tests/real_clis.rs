//! Opt-in smoke test against the agent CLIs installed on this machine (limitation L12: most
//! adapters are otherwise verified only against documented stream shapes).
//!
//! It sends one tiny prompt per CLI, which consumes tokens/credits, so it does nothing unless
//! `COFFE_SMOKE_REAL_CLIS=1`. `COFFE_SMOKE_CLIS=codex,gemini` limits it to some CLIs.

use std::path::PathBuf;
use std::time::Duration;

use coffe_adapters::AdapterRegistry;
use coffe_protocol::{
    AgentEvent, ContextBundle, ContextFile, PermissionMode, PermissionPolicy, RunKind, RunMode, RunStart, RunStatus,
    TermSize, WorktreeMode, WorktreeSpec,
};
use coffe_runner::config::{RepoEntry, RunnerConfig};
use coffe_runner::detect::{self, DetectedEntry, SystemProbe};
use coffe_runner::git;
use coffe_runner::paths::RunnerHome;
use coffe_runner::run_api::{RunContext, RunEmit};
use coffe_runner::supervisor::start_run;
use tokio::sync::mpsc;
use uuid::Uuid;

const REPO_KEY: &str = "smoke";
const RUN_TIMEOUT: Duration = Duration::from_secs(300);
const PROMPT: &str = "Create a file named SMOKE.md whose whole content is the word ok. Change nothing else, then stop.";

fn repository(dir: &std::path::Path) -> PathBuf {
    let repo = dir.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git::run_checked(&repo, ["init", "-q", "-b", "main"]).unwrap();
    std::fs::write(repo.join("README.md"), "# Smoke\n").unwrap();
    git::run_checked(&repo, ["add", "-A"]).unwrap();
    git::run_checked(
        &repo,
        ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"],
    )
    .unwrap();
    repo
}

fn run_start(cli_id: &str) -> RunStart {
    RunStart {
        run_id: Uuid::new_v4(),
        kind: RunKind::Ticket,
        project_id: Uuid::new_v4(),
        ticket_key: Some("SMOKE-1".to_owned()),
        repo_key: REPO_KEY.to_owned(),
        worktree: WorktreeSpec { mode: WorktreeMode::Branch, branch: Some(format!("coffe/SMOKE-{cli_id}")), base_branch: "main".to_owned() },
        cli_id: cli_id.to_owned(),
        model: None,
        mode: RunMode::Structured,
        driver: None,
        prompt: PROMPT.to_owned(),
        context: ContextBundle {
            files: vec![ContextFile { name: "40-ticket.md".to_owned(), content: format!("# SMOKE-1\n{PROMPT}\n") }],
            attachments: Vec::new(),
        },
        permissions: PermissionPolicy {
            mode: PermissionMode::WorkspaceWrite,
            allow_tools: Vec::new(),
            deny_tools: Vec::new(),
            network: true,
            max_turns: Some(10),
            max_budget_usd: Some(0.5),
        },
        persona: None,
        resume: None,
        timeout_secs: RUN_TIMEOUT.as_secs(),
        terminal: TermSize { cols: 120, rows: 40 },
        output_schema: None,
        auto_commit: true,
        commit_message: Some(format!("SMOKE-1: {cli_id}")),
        test_command: None,
    }
}

/// Runs the smoke prompt with one CLI; `Err` explains what went wrong.
async fn smoke(cli: &DetectedEntry, clis: &[DetectedEntry]) -> Result<(), String> {
    let dir = tempfile::tempdir().map_err(|error| error.to_string())?;
    let repo = repository(dir.path());
    let home = RunnerHome::resolve(Some(&dir.path().join("home"))).map_err(|error| error.to_string())?;
    let mut config = RunnerConfig::default();
    config.repos.push(RepoEntry { key: REPO_KEY.to_owned(), name: "smoke".to_owned(), path: repo });
    let ctx = RunContext { home, config, registry: AdapterRegistry::builtin(false), clis: clis.to_vec(), extra_bin_dir: None };

    let (tx, mut rx) = mpsc::unbounded_channel();
    let _handle = start_run(ctx, run_start(&cli.info.id), tx).map_err(|error| error.to_string())?;
    let mut turn_completed = false;
    let done = tokio::time::timeout(RUN_TIMEOUT + Duration::from_secs(30), async {
        while let Some(item) = rx.recv().await {
            match item {
                RunEmit::Completed(done) => return Some(done),
                RunEmit::Event(AgentEvent::TurnCompleted { .. }) => turn_completed = true,
                _ => {}
            }
        }
        None
    })
    .await
    .map_err(|_| "no run.completed within the timeout".to_owned())?
    .ok_or("the run ended without run.completed")?;

    if done.status != RunStatus::Completed {
        return Err(format!("status {:?}: {}", done.status, done.error.unwrap_or_default()));
    }
    if !turn_completed {
        return Err("the adapter never reported the end of the turn".to_owned());
    }
    let diff = done.diff.ok_or("no diff of the ticket branch")?;
    if !diff.files.iter().any(|file| file.path == "SMOKE.md") {
        return Err(format!("SMOKE.md missing from the diff ({:?})", diff.files.iter().map(|file| &file.path).collect::<Vec<_>>()));
    }
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn every_installed_cli_completes_a_tiny_structured_run() {
    if std::env::var("COFFE_SMOKE_REAL_CLIS").as_deref() != Ok("1") {
        eprintln!("skipped: set COFFE_SMOKE_REAL_CLIS=1 to send one small prompt to every installed CLI");
        return;
    }
    let only: Option<Vec<String>> = std::env::var("COFFE_SMOKE_CLIS")
        .ok()
        .map(|list| list.split(',').map(|id| id.trim().to_owned()).filter(|id| !id.is_empty()).collect());
    let registry = AdapterRegistry::builtin(false);
    let clis = detect::detect_all(&registry, &SystemProbe::new(), |id| only.as_ref().is_none_or(|ids| ids.iter().any(|wanted| wanted == id)));
    assert!(!clis.is_empty(), "no agent CLI was detected on this machine");

    let mut failures = Vec::new();
    for cli in &clis {
        eprintln!("smoke: {} {}", cli.info.id, cli.version.as_deref().unwrap_or("?"));
        if let Err(reason) = smoke(cli, &clis).await {
            failures.push(format!("{}: {reason}", cli.info.id));
        }
    }
    assert!(failures.is_empty(), "CLIs that failed the smoke run:\n{}", failures.join("\n"));
}
