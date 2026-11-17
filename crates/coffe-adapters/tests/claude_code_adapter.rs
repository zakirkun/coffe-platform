//! Claude Code adapter against recorded `stream-json` sessions (no `claude` binary needed).

use std::path::{Path, PathBuf};
use std::time::Duration;

use coffe_adapters::adapters::ClaudeCodeAdapter;
use coffe_adapters::{
    AdapterError, AgentEvent, AgentInput, CliAdapter, CliAuthStatus, ContextFiles, IoAction, IoMode,
    PermissionMode, PermissionPolicy, Probe, ProbeOutput, RunDriver, RunMode, RunSpec, SessionState,
    Sig, StopMode, StreamKind, TermSize, ToolKind,
};
use serde_json::Value;
use uuid::Uuid;

fn fixture(name: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/claude-code").join(name);
    std::fs::read(&path).unwrap_or_else(|err| panic!("cannot read {}: {err}", path.display()))
}

fn spec(mode: RunMode) -> RunSpec {
    RunSpec {
        run_id: Uuid::new_v4(),
        program: PathBuf::from("/usr/local/bin/claude"),
        cwd: PathBuf::from("/work/repo"),
        mode,
        driver: RunDriver::Native,
        cli_version: Some("2.1.325".to_owned()),
        prompt: "Fix the parser".to_owned(),
        context: ContextFiles::default(),
        model: None,
        permissions: PermissionPolicy {
            mode: PermissionMode::WorkspaceWrite,
            allow_tools: Vec::new(),
            deny_tools: Vec::new(),
            network: true,
            max_turns: None,
            max_budget_usd: None,
        },
        resume_session_id: None,
        output_schema: None,
        terminal: TermSize { cols: 100, rows: 30 },
        env: Vec::new(),
    }
}

/// The values following `flag`, up to the next option.
fn flag_values<'a>(args: &'a [String], flag: &str) -> Vec<&'a str> {
    let Some(start) = args.iter().position(|arg| arg == flag) else { return Vec::new() };
    args[start + 1..].iter().take_while(|arg| !arg.starts_with("--")).map(String::as_str).collect()
}

/// Feeds a recording in `chunk`-sized pieces, as pipes deliver it.
fn parse_in_chunks(session: &mut SessionState, bytes: &[u8], chunk: usize) -> Vec<AgentEvent> {
    bytes.chunks(chunk).flat_map(|piece| ClaudeCodeAdapter.parse_events(session, StreamKind::Stdout, piece)).collect()
}

fn structured_session() -> SessionState {
    ClaudeCodeAdapter.start(&spec(RunMode::Structured)).expect("structured start").1
}

#[test]
fn structured_launch_streams_json_with_context_and_tight_permissions() {
    let mut spec = spec(RunMode::Structured);
    spec.model = Some("opus".to_owned());
    spec.context.combined_markdown = "# Project rules\nUse tabs.".to_owned();
    spec.permissions.deny_tools = vec!["Bash(rm:*)".to_owned()];
    spec.permissions.network = false;
    spec.permissions.max_turns = Some(12);
    let (plan, _) = ClaudeCodeAdapter.start(&spec).unwrap();

    assert_eq!(
        &plan.args[..7],
        ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
    );
    assert_eq!(flag_values(&plan.args, "--session-id"), [spec.run_id.to_string()]);
    assert_eq!(flag_values(&plan.args, "--model"), ["opus"]);
    assert_eq!(flag_values(&plan.args, "--permission-mode"), ["acceptEdits"]);
    assert_eq!(flag_values(&plan.args, "--disallowedTools"), ["Bash(rm:*)", "WebFetch", "WebSearch", "Bash(git push:*)"]);
    assert_eq!(flag_values(&plan.args, "--max-turns"), ["12"]);

    let prompt_file = PathBuf::from("/work/repo").join(".coffe").join("context").join("system-prompt.md");
    assert_eq!(flag_values(&plan.args, "--append-system-prompt-file"), [prompt_file.to_str().unwrap()]);
    assert_eq!(plan.files, vec![(prompt_file, b"# Project rules\nUse tabs.".to_vec())]);

    assert_eq!(plan.io, IoMode::Pipes);
    assert!(!plan.close_stdin, "the session stays open for follow-up turns");
    let first_turn: Value = serde_json::from_slice(&plan.initial_stdin).unwrap();
    assert_eq!(first_turn["type"], "user");
    assert_eq!(first_turn["message"]["content"], "Fix the parser");
    assert!(plan.initial_stdin.ends_with(b"\n"));
}

#[test]
fn resumed_read_only_runs_allow_reading_and_deny_edits() {
    let mut spec = spec(RunMode::Structured);
    spec.resume_session_id = Some("5f0a7c1e-3b9d-4c52-8a61-9d2f4e7b1c30".to_owned());
    spec.permissions.mode = PermissionMode::ReadOnly;
    let (plan, _) = ClaudeCodeAdapter.start(&spec).unwrap();

    assert_eq!(flag_values(&plan.args, "--resume"), ["5f0a7c1e-3b9d-4c52-8a61-9d2f4e7b1c30"]);
    assert!(!plan.args.iter().any(|arg| arg == "--session-id"));
    assert_eq!(flag_values(&plan.args, "--permission-mode"), ["default"]);
    assert_eq!(flag_values(&plan.args, "--allowedTools"), ["Read", "Glob", "Grep"]);
    assert_eq!(flag_values(&plan.args, "--disallowedTools"), ["Edit", "Write", "NotebookEdit", "Bash(git push:*)"]);

    spec.resume_session_id = Some("--dangerous".to_owned());
    assert!(matches!(ClaudeCodeAdapter.start(&spec), Err(AdapterError::InvalidSpec(_))));
}

#[test]
fn full_auto_bypasses_prompts_but_keeps_deny_rules() {
    let mut spec = spec(RunMode::Structured);
    spec.permissions.mode = PermissionMode::FullAuto;
    spec.permissions.allow_tools = vec!["Bash".to_owned()];
    let (plan, _) = ClaudeCodeAdapter.start(&spec).unwrap();
    assert_eq!(flag_values(&plan.args, "--permission-mode"), ["bypassPermissions"]);
    assert!(flag_values(&plan.args, "--allowedTools").is_empty());
    assert_eq!(flag_values(&plan.args, "--disallowedTools"), ["Bash(git push:*)"]);
}

#[test]
fn pty_launch_runs_the_tui_with_the_prompt_after_the_options() {
    let mut spec = spec(RunMode::Pty);
    spec.prompt = "-starts with a dash".to_owned();
    let (plan, session) = ClaudeCodeAdapter.start(&spec).unwrap();

    assert_eq!(plan.io, IoMode::Pty { cols: 100, rows: 30 });
    assert!(!plan.args.iter().any(|arg| arg == "-p" || arg == "stream-json"));
    assert_eq!(plan.args[plan.args.len() - 2..], ["--".to_owned(), "-starts with a dash".to_owned()]);
    assert!(plan.initial_stdin.is_empty());
    assert_eq!(session.session_id, Some(spec.run_id.to_string()), "the assigned id is the only one known");

    spec.output_schema = Some(serde_json::json!({ "type": "object" }));
    assert!(matches!(ClaudeCodeAdapter.start(&spec), Err(AdapterError::Unsupported(_))));
}

#[test]
fn the_acp_driver_is_not_offered() {
    let mut spec = spec(RunMode::Structured);
    spec.driver = RunDriver::Acp;
    assert!(matches!(ClaudeCodeAdapter.start(&spec), Err(AdapterError::Unsupported(_))));
}

#[test]
fn a_basic_session_yields_the_same_events_however_the_bytes_are_split() {
    let bytes = fixture("stream_basic.jsonl");
    let mut whole = structured_session();
    let events = parse_in_chunks(&mut whole, &bytes, bytes.len());
    let mut split = structured_session();
    assert_eq!(parse_in_chunks(&mut split, &bytes, 7), events);

    let Some(AgentEvent::SessionStarted { session_id, model, .. }) = events.first() else {
        panic!("the first event is the session start: {events:?}");
    };
    assert_eq!(session_id.as_deref(), Some("5f0a7c1e-3b9d-4c52-8a61-9d2f4e7b1c30"));
    assert_eq!(model.as_deref(), Some("claude-sonnet-4-5-20250929"));
    let streamed: String = events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::MessageDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(streamed, "The worktree is clean — nothing to commit.");
    assert!(matches!(
        events.last(),
        Some(AgentEvent::TurnCompleted { is_error: false, result: Some(result), num_turns: Some(1), .. })
            if result == "The worktree is clean — nothing to commit."
    ));

    assert_eq!(whole.session_id.as_deref(), Some("5f0a7c1e-3b9d-4c52-8a61-9d2f4e7b1c30"));
    assert!(whole.turn_completed);
    let usage = ClaudeCodeAdapter.get_usage(&whole).expect("usage after the result");
    assert_eq!(
        (usage.input_tokens, usage.output_tokens, usage.cache_read_tokens, usage.cache_write_tokens),
        (3, 14, 14336, 2048)
    );
    assert_eq!(usage.cost_usd, Some(0.0131955));
    assert_eq!(usage.duration_ms, Some(2314));
}

#[test]
fn tool_calls_and_results_are_normalized() {
    let bytes = fixture("stream_tool_use.jsonl");
    let mut session = structured_session();
    let events = parse_in_chunks(&mut session, &bytes, 64);

    let calls: Vec<(&str, ToolKind, Option<&str>)> = events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::ToolCall { name, tool_kind, title, .. } => Some((name.as_str(), *tool_kind, title.as_deref())),
            _ => None,
        })
        .collect();
    let kinds: Vec<(&str, ToolKind)> = calls.iter().map(|(name, kind, _)| (*name, *kind)).collect();
    assert_eq!(
        kinds,
        [
            ("Read", ToolKind::Read),
            ("Grep", ToolKind::Search),
            ("Edit", ToolKind::Edit),
            ("Bash", ToolKind::Execute),
            ("WebFetch", ToolKind::Fetch),
            ("Task", ToolKind::Other),
            ("Read", ToolKind::Read),
        ]
    );
    assert_eq!(calls[0].2, Some("/work/repo/src/parser.rs"), "calls are titled by their file");

    let results: Vec<(&str, bool)> = events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::ToolResult { call_id, ok, .. } => Some((call_id.as_str(), *ok)),
            _ => None,
        })
        .collect();
    assert!(results.contains(&("toolu_04", false)), "a failed command is not ok: {results:?}");
    assert!(results.contains(&("toolu_01", true)));
    assert!(events.iter().any(|event| matches!(event, AgentEvent::Thinking { .. })));
    assert_eq!(session.result_text.as_deref(), Some("Parser fixed; tests pass."));
}

#[test]
fn failed_turns_report_the_reason_and_keep_unknown_lines() {
    let bytes = fixture("stream_error.jsonl");
    let mut session = structured_session();
    let events = parse_in_chunks(&mut session, &bytes, 33);

    assert!(
        matches!(events.first(), Some(AgentEvent::Raw { text }) if text.starts_with("Warning: no stdin data")),
        "non-JSON output is kept as raw text: {:?}",
        events.first()
    );
    assert!(events.iter().any(|event| matches!(event, AgentEvent::Raw { text } if text.contains("retry"))));
    assert!(events.iter().any(|event| matches!(event, AgentEvent::Error { message } if message.starts_with("maximum number of turns reached"))));
    assert!(matches!(events.last(), Some(AgentEvent::TurnCompleted { is_error: true, .. })));
}

#[test]
fn input_is_encoded_for_the_running_session() {
    let mut session = structured_session();
    let actions = ClaudeCodeAdapter.send_input(&mut session, AgentInput::Text { text: "Also add tests".to_owned() }).unwrap();
    let [IoAction::Write(line)] = actions.as_slice() else {
        panic!("a follow-up is one stdin line");
    };
    let message: Value = serde_json::from_slice(line).unwrap();
    assert_eq!(message["message"]["content"], "Also add tests");

    let actions = ClaudeCodeAdapter.send_input(&mut session, AgentInput::Interrupt).unwrap();
    let [IoAction::Write(line)] = actions.as_slice() else {
        panic!("an interrupt is one control request");
    };
    let request: Value = serde_json::from_slice(line).unwrap();
    assert_eq!(request["type"], "control_request");
    assert_eq!(request["request"]["subtype"], "interrupt");

    let permission = AgentInput::Permission { request_id: "p1".to_owned(), allow: true, remember: false };
    assert!(matches!(ClaudeCodeAdapter.send_input(&mut session, permission).unwrap().as_slice(), [IoAction::Unsupported(_)]));
    assert!(matches!(
        ClaudeCodeAdapter.send_input(&mut session, AgentInput::Keys { data: "y".to_owned() }).unwrap().as_slice(),
        [IoAction::Unsupported(_)]
    ));

    let (_, mut tui) = ClaudeCodeAdapter.start(&spec(RunMode::Pty)).unwrap();
    let actions = ClaudeCodeAdapter.send_input(&mut tui, AgentInput::Text { text: "yes".to_owned() }).unwrap();
    let [IoAction::Write(bytes)] = actions.as_slice() else {
        panic!("text is typed into the TUI");
    };
    assert_eq!(bytes, b"yes\r");
}

#[test]
fn stopping_closes_stdin_first_and_escalates() {
    let mut session = structured_session();
    let steps = ClaudeCodeAdapter.stop(&mut session, StopMode::Graceful);
    let actions: Vec<String> = steps.iter().map(|step| format!("{:?}", step.action)).collect();
    assert_eq!(actions[0], "CloseStdin");
    assert!(matches!(steps.last().map(|step| &step.action), Some(IoAction::Signal(Sig::Kill))));
    assert!(steps[0].wait > Duration::ZERO, "the CLI gets time to finish the turn");

    let (_, mut tui) = ClaudeCodeAdapter.start(&spec(RunMode::Pty)).unwrap();
    let interrupt = ClaudeCodeAdapter.stop(&mut tui, StopMode::InterruptTurn);
    assert!(matches!(interrupt.as_slice(), [step] if matches!(&step.action, IoAction::Write(bytes) if bytes == &[0x03])));
}

struct FakeProbe {
    version_stdout: &'static str,
    auth: Option<ProbeOutput>,
}

impl Probe for FakeProbe {
    fn which(&self, binary: &str) -> Option<PathBuf> {
        (binary == "claude").then(|| PathBuf::from("/usr/local/bin/claude"))
    }
    fn run(&self, _program: &Path, args: &[&str], _timeout: Duration) -> Option<ProbeOutput> {
        match args {
            ["--version"] => Some(ProbeOutput { status: Some(0), stdout: self.version_stdout.to_owned(), stderr: String::new() }),
            ["auth", "status"] => self.auth.clone(),
            _ => None,
        }
    }
    fn env(&self, _key: &str) -> Option<String> {
        None
    }
    fn home_dir(&self) -> Option<PathBuf> {
        None
    }
}

#[test]
fn detection_reads_the_version_and_login_state() {
    let logged_in = FakeProbe {
        version_stdout: "2.1.325 (Claude Code)\n",
        auth: Some(ProbeOutput { status: Some(0), stdout: r#"{"loggedIn":true}"#.to_owned(), stderr: String::new() }),
    };
    let detected = ClaudeCodeAdapter.detect(&logged_in).expect("claude is detected");
    assert_eq!(detected.version.as_deref(), Some("2.1.325"));
    assert_eq!(detected.auth, CliAuthStatus::Ok);

    let logged_out = FakeProbe {
        version_stdout: "2.1.325 (Claude Code)",
        auth: Some(ProbeOutput { status: Some(1), stdout: String::new(), stderr: String::new() }),
    };
    assert_eq!(ClaudeCodeAdapter.detect(&logged_out).map(|cli| cli.auth), Some(CliAuthStatus::Unauthenticated));

    // Builds without `claude auth status` are never asked (they would take it as a prompt).
    let old = FakeProbe { version_stdout: "2.0.1 (Claude Code)", auth: None };
    assert_eq!(ClaudeCodeAdapter.detect(&old).map(|cli| cli.auth), Some(CliAuthStatus::Unknown));

    let impostor = FakeProbe { version_stdout: "claude 1.0 (some other tool)", auth: None };
    assert!(ClaudeCodeAdapter.detect(&impostor).is_none());
}
