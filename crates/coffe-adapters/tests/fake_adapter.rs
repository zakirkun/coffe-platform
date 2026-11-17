//! Adapter of the fake CLI fixture against its recorded JSONL sessions.

use std::path::{Path, PathBuf};
use std::time::Duration;

use coffe_adapters::adapters::FakeAdapter;
use coffe_adapters::{
    AgentEvent, AgentInput, CliAdapter, CliAuthStatus, ContextFiles, IoAction, IoMode, PermissionMode,
    PermissionPolicy, Probe, ProbeOutput, RunDriver, RunMode, RunSpec, SessionState, StopMode, StreamKind,
    TermSize, ToolKind,
};
use serde_json::Value;
use uuid::Uuid;

fn fixture(name: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake").join(name);
    std::fs::read(&path).unwrap_or_else(|err| panic!("cannot read {}: {err}", path.display()))
}

fn spec(mode: RunMode) -> RunSpec {
    RunSpec {
        run_id: Uuid::new_v4(),
        program: PathBuf::from("/opt/coffe/coffe-fake-cli"),
        cwd: PathBuf::from("/work/repo"),
        mode,
        driver: RunDriver::Native,
        cli_version: Some("0.1.0".to_owned()),
        prompt: "Add a health endpoint\nwith a test".to_owned(),
        context: ContextFiles::default(),
        model: None,
        permissions: PermissionPolicy {
            mode: PermissionMode::WorkspaceWrite,
            allow_tools: Vec::new(),
            deny_tools: Vec::new(),
            network: false,
            max_turns: None,
            max_budget_usd: None,
        },
        resume_session_id: None,
        output_schema: None,
        terminal: TermSize { cols: 80, rows: 24 },
        env: Vec::new(),
    }
}

fn parse(session: &mut SessionState, bytes: &[u8]) -> Vec<AgentEvent> {
    bytes.chunks(5).flat_map(|piece| FakeAdapter.parse_events(session, StreamKind::Stdout, piece)).collect()
}

fn structured() -> SessionState {
    FakeAdapter.start(&spec(RunMode::Structured)).unwrap().1
}

#[test]
fn structured_launch_uses_jsonl_both_ways_and_forwards_the_scenario() {
    let mut spec = spec(RunMode::Structured);
    spec.env.push(("COFFE_FAKE_SCENARIO".to_owned(), "slow".to_owned()));
    spec.model = Some("fake-model-2".to_owned());
    spec.context.combined_markdown = "# Rules".to_owned();
    let (plan, _) = FakeAdapter.start(&spec).unwrap();

    let expected: Vec<String> = [
        "run",
        "--output-format",
        "jsonl",
        "--input-format",
        "jsonl",
        "--session-id",
        &spec.run_id.to_string(),
        "--model",
        "fake-model-2",
        "--system-prompt-file",
        PathBuf::from("/work/repo").join(".coffe").join("context").join("system-prompt.md").to_str().unwrap(),
        "--scenario",
        "slow",
    ]
    .map(str::to_owned)
    .to_vec();
    assert_eq!(plan.args, expected);
    assert_eq!(plan.io, IoMode::Pipes);
    let first: Value = serde_json::from_slice(&plan.initial_stdin).unwrap();
    assert_eq!(first, serde_json::json!({ "type": "user", "text": "Add a health endpoint\nwith a test" }));

    spec.resume_session_id = Some("0195c5a0".to_owned());
    let (resumed, _) = FakeAdapter.start(&spec).unwrap();
    assert_eq!(resumed.args[5..7], ["--resume".to_owned(), "0195c5a0".to_owned()]);
}

#[test]
fn pty_launch_types_the_prompt_as_one_line() {
    let (plan, _) = FakeAdapter.start(&spec(RunMode::Pty)).unwrap();
    assert_eq!(plan.args, ["interactive"]);
    assert_eq!(plan.io, IoMode::Pty { cols: 80, rows: 24 });
    assert_eq!(plan.initial_stdin, b"Add a health endpoint with a test\r");
}

#[test]
fn an_edit_session_becomes_normalized_events_and_usage() {
    let mut session = structured();
    let events = parse(&mut session, &fixture("edit.jsonl"));

    assert!(matches!(
        events.first(),
        Some(AgentEvent::SessionStarted { session_id: Some(id), model: Some(model), .. })
            if id == "0195c5a0-7d1e-7a3b-9c4d-2f6e8b1a3c5d" && model == "fake-model-1"
    ));
    let call = events.iter().find_map(|event| match event {
        AgentEvent::ToolCall { name, tool_kind, title, .. } => Some((name.clone(), *tool_kind, title.clone())),
        _ => None,
    });
    assert_eq!(call, Some(("write_file".to_owned(), ToolKind::Edit, Some("FAKE_CHANGES.md".to_owned()))));
    assert!(events.iter().any(|event| matches!(event, AgentEvent::ToolResult { ok: true, .. })));
    assert!(matches!(
        events.last(),
        Some(AgentEvent::TurnCompleted { is_error: false, result: Some(text), .. }) if text.contains("FAKE_CHANGES.md")
    ));

    let usage = FakeAdapter.get_usage(&session).expect("usage was reported");
    assert_eq!((usage.input_tokens, usage.output_tokens, usage.cache_read_tokens), (120, 45, 30));
    assert_eq!(usage.cost_usd, Some(0.0025));
    assert!(session.turn_completed);
}

#[test]
fn usage_accumulates_over_turns() {
    let mut session = structured();
    let events = parse(&mut session, &fixture("multi_turn.jsonl"));
    let turns = events.iter().filter(|event| matches!(event, AgentEvent::TurnCompleted { .. })).count();
    assert!(turns >= 2, "the recording has several turns: {events:?}");
    let per_turn: Vec<u64> = events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::Usage { usage } => Some(usage.input_tokens),
            _ => None,
        })
        .collect();
    assert!(per_turn.windows(2).all(|pair| pair[1] > pair[0]), "usage is cumulative: {per_turn:?}");
}

#[test]
fn failures_and_permission_requests_are_reported() {
    let mut failed = structured();
    let events = parse(&mut failed, &fixture("fail.jsonl"));
    assert!(events.iter().any(|event| matches!(event, AgentEvent::Error { message } if message == "simulated failure")));
    assert!(matches!(events.last(), Some(AgentEvent::TurnCompleted { is_error: true, .. })));

    let mut asking = structured();
    let events = parse(&mut asking, &fixture("permission.jsonl"));
    assert!(events.iter().any(|event| matches!(
        event,
        AgentEvent::PermissionRequest { request_id, tool, options, .. }
            if request_id == "perm_1" && tool == "write_file" && options == &["allow", "deny"]
    )));
}

#[test]
fn input_reaches_the_cli_as_jsonl() {
    let mut session = structured();
    let answer = AgentInput::Permission { request_id: "perm_1".to_owned(), allow: false, remember: false };
    let actions = FakeAdapter.send_input(&mut session, answer).unwrap();
    let [IoAction::Write(line)] = actions.as_slice() else {
        panic!("a permission answer is one line");
    };
    let message: Value = serde_json::from_slice(line).unwrap();
    assert_eq!(message, serde_json::json!({ "type": "permission", "id": "perm_1", "allow": false }));

    let actions = FakeAdapter.send_input(&mut session, AgentInput::Interrupt).unwrap();
    let [IoAction::Write(line)] = actions.as_slice() else {
        panic!("an interrupt is one line");
    };
    assert_eq!(serde_json::from_slice::<Value>(line).unwrap()["type"], "interrupt");
    assert!(matches!(
        FakeAdapter.send_input(&mut session, AgentInput::Keys { data: "x".to_owned() }).unwrap().as_slice(),
        [IoAction::Unsupported(_)]
    ));
}

#[test]
fn graceful_stop_closes_stdin_before_signalling() {
    let mut session = structured();
    let steps = FakeAdapter.stop(&mut session, StopMode::Graceful);
    assert!(matches!(steps.first().map(|step| &step.action), Some(IoAction::CloseStdin)));
    assert!(steps.len() > 1);
}

struct FixtureProbe {
    path_env: Option<String>,
}

impl Probe for FixtureProbe {
    fn which(&self, _binary: &str) -> Option<PathBuf> {
        None
    }
    fn run(&self, _program: &Path, args: &[&str], _timeout: Duration) -> Option<ProbeOutput> {
        let stdout = match args {
            ["--version"] => "coffe-fake-cli 0.1.0\n",
            ["auth", "status"] => r#"{"logged_in":true}"#,
            _ => return None,
        };
        Some(ProbeOutput { status: Some(0), stdout: stdout.to_owned(), stderr: String::new() })
    }
    fn env(&self, key: &str) -> Option<String> {
        (key == "COFFE_FAKE_CLI").then(|| self.path_env.clone()).flatten()
    }
    fn home_dir(&self) -> Option<PathBuf> {
        None
    }
}

#[test]
fn detection_honours_the_explicit_binary_path() {
    let probe = FixtureProbe { path_env: Some("/build/coffe-fake-cli".to_owned()) };
    let detected = FakeAdapter.detect(&probe).expect("found through COFFE_FAKE_CLI");
    assert_eq!(detected.path, PathBuf::from("/build/coffe-fake-cli"));
    assert_eq!(detected.version.as_deref(), Some("0.1.0"));
    assert_eq!(detected.auth, CliAuthStatus::Ok);

    assert!(FakeAdapter.detect(&FixtureProbe { path_env: None }).is_none(), "not on PATH and no override");
}
