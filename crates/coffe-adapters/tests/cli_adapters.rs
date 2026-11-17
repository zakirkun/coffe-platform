//! The adapters of Codex, Gemini CLI, OpenCode, Antigravity, Grok Build, Muse Code, Pi and Kiro
//! against streams shaped like their documented output (L12: most are not installed on the
//! reference machine, so these shapes come from the official docs and schemas).

use std::path::PathBuf;
use std::time::Duration;

use coffe_adapters::adapters::{
    AntigravityAdapter, CodexAdapter, GeminiAdapter, GrokAdapter, KiroAdapter, MuseAdapter, OpenCodeAdapter, PiAdapter,
};
use coffe_adapters::{
    AdapterRegistry, AgentEvent, AgentInput, CliAdapter, ContextFiles, IoAction, IoMode, LaunchPlan, PermissionMode,
    PermissionPolicy, Probe, ProbeOutput, RunDriver, RunMode, RunSpec, SessionState, StreamKind, TermSize, ToolKind,
};
use serde_json::Value;
use uuid::Uuid;

fn spec(mode: RunMode) -> RunSpec {
    RunSpec {
        run_id: Uuid::new_v4(),
        program: PathBuf::from("/usr/local/bin/cli"),
        cwd: PathBuf::from("/work/repo"),
        mode,
        driver: RunDriver::Native,
        cli_version: None,
        prompt: "Fix the parser".to_owned(),
        context: ContextFiles { combined_markdown: "# Rules".to_owned(), ..ContextFiles::default() },
        model: Some("model-x".to_owned()),
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

fn with_context_files(mut spec: RunSpec) -> RunSpec {
    spec.context.files = vec![spec.cwd.join(".coffe").join("context").join("40-ticket.md")];
    spec
}

/// Feeds a stream in small chunks, as pipes deliver it.
fn parse(adapter: &dyn CliAdapter, session: &mut SessionState, stream: &str) -> Vec<AgentEvent> {
    stream.as_bytes().chunks(9).flat_map(|chunk| adapter.parse_events(session, StreamKind::Stdout, chunk)).collect()
}

fn values_after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.iter().position(|arg| arg == flag).and_then(|index| args.get(index + 1)).map(String::as_str)
}

fn kinds(events: &[AgentEvent]) -> Vec<&'static str> {
    events
        .iter()
        .map(|event| match event {
            AgentEvent::SessionStarted { .. } => "session",
            AgentEvent::Message { .. } => "message",
            AgentEvent::MessageDelta { .. } => "delta",
            AgentEvent::Thinking { .. } => "thinking",
            AgentEvent::ToolCall { .. } => "tool_call",
            AgentEvent::ToolResult { .. } => "tool_result",
            AgentEvent::FileChange { .. } => "file_change",
            AgentEvent::Plan { .. } => "plan",
            AgentEvent::PermissionRequest { .. } => "permission",
            AgentEvent::Usage { .. } => "usage",
            AgentEvent::TurnCompleted { .. } => "turn_completed",
            AgentEvent::Error { .. } => "error",
            AgentEvent::Raw { .. } => "raw",
            AgentEvent::Gap { .. } => "gap",
        })
        .collect()
}

fn respawn(actions: Vec<IoAction>) -> LaunchPlan {
    match actions.into_iter().next() {
        Some(IoAction::Respawn(plan)) => *plan,
        other => panic!("expected a respawn, got {other:?}"),
    }
}

#[test]
fn the_registry_offers_every_supported_cli() {
    let mut ids: Vec<&str> = AdapterRegistry::builtin(false).all().map(|adapter| adapter.info().id).collect();
    ids.sort_unstable();
    assert_eq!(ids, ["antigravity", "claude-code", "codex", "gemini", "grok", "kiro", "muse", "opencode", "pi"]);
    assert!(AdapterRegistry::builtin(true).get("fake").is_some());
}

#[test]
fn codex_runs_exec_json_and_resumes_the_thread_for_follow_ups() {
    let mut spec = with_context_files(spec(RunMode::Structured));
    spec.permissions.network = false;
    let (plan, mut session) = CodexAdapter.start(&spec).unwrap();
    assert_eq!(&plan.args[..3], ["exec", "--json", "--skip-git-repo-check"]);
    assert_eq!(values_after(&plan.args, "-s"), Some("workspace-write"));
    assert!(!plan.args.iter().any(|arg| arg.contains("network_access")), "network stays off");
    assert_eq!(plan.args.last().map(String::as_str), Some("-"), "the task comes on stdin");
    assert!(String::from_utf8_lossy(&plan.initial_stdin).contains(".coffe/context/"));
    assert!(plan.close_stdin);

    let stream = concat!(
        r#"{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}"#, "\n",
        r#"{"type":"turn.started"}"#, "\n",
        r#"{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}"#, "\n",
        r#"{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","aggregated_output":"src\n","exit_code":0,"status":"completed"}}"#, "\n",
        r#"{"type":"item.completed","item":{"id":"item_2","type":"file_change","changes":[{"path":"src/parser.rs","kind":"update"}],"status":"completed"}}"#, "\n",
        r#"{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Fixed the parser."}}"#, "\n",
        r#"{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":8}}"#, "\n",
    );
    let events = parse(&CodexAdapter, &mut session, stream);
    assert_eq!(kinds(&events), ["session", "tool_call", "tool_result", "file_change", "message", "usage", "turn_completed"]);
    assert!(matches!(&events[1], AgentEvent::ToolCall { tool_kind: ToolKind::Execute, title: Some(title), .. } if title == "bash -lc ls"));
    let usage = CodexAdapter.get_usage(&session).unwrap();
    assert_eq!((usage.input_tokens, usage.cache_read_tokens, usage.output_tokens, usage.reasoning_tokens), (315, 24448, 122, 8));
    assert_eq!(usage.cost_usd, None, "Codex reports no cost (L2)");
    assert_eq!(session.result_text.as_deref(), Some("Fixed the parser."));

    let follow_up = respawn(CodexAdapter.send_input(&mut session, AgentInput::Text { text: "Add a test".to_owned() }).unwrap());
    let tail: Vec<&str> = follow_up.args.iter().rev().take(3).rev().map(String::as_str).collect();
    assert_eq!(tail, ["resume", "0199a213-81c0-7800-8aa1-bbab2a035a53", "-"]);
    assert_eq!(follow_up.initial_stdin, b"Add a test");
}

#[test]
fn gemini_uses_a_policy_file_and_respawns_with_the_session() {
    let mut spec = spec(RunMode::Structured);
    spec.permissions.mode = PermissionMode::ReadOnly;
    let (plan, mut session) = GeminiAdapter.start(&spec).unwrap();
    assert_eq!(values_after(&plan.args, "--approval-mode"), Some("plan"));
    assert_eq!(values_after(&plan.args, "-o"), Some("stream-json"));
    assert_eq!(values_after(&plan.args, "--session-id"), Some(spec.run_id.to_string().as_str()));
    let policy_path = values_after(&plan.args, "--policy").unwrap();
    let (_, policy) = plan.files.iter().find(|(path, _)| path.display().to_string() == policy_path).unwrap();
    assert!(String::from_utf8_lossy(policy).contains("commandPrefix = \"git push\""));

    let stream = concat!(
        r#"{"type":"init","timestamp":"2026-11-16T08:00:00Z","session_id":"a1b2","model":"gemini-x"}"#, "\n",
        r#"{"type":"message","role":"user","content":"Fix the parser"}"#, "\n",
        r#"{"type":"message","role":"assistant","content":"Checking ","delta":true}"#, "\n",
        r#"{"type":"tool_use","tool_name":"run_shell_command","tool_id":"t1","parameters":{"command":"git status"}}"#, "\n",
        r#"{"type":"tool_result","tool_id":"t1","status":"success","output":"On branch main"}"#, "\n",
        r#"{"type":"message","role":"assistant","content":"done.","delta":true}"#, "\n",
        r#"{"type":"result","status":"success","stats":{"total_tokens":1540,"input_tokens":1200,"output_tokens":340,"cached":200,"duration_ms":4100}}"#, "\n",
    );
    let events = parse(&GeminiAdapter, &mut session, stream);
    assert_eq!(kinds(&events), ["session", "delta", "tool_call", "tool_result", "delta", "usage", "turn_completed"]);
    assert!(matches!(events.last(), Some(AgentEvent::TurnCompleted { result: Some(text), is_error: false, .. }) if text == "Checking done."));
    let usage = GeminiAdapter.get_usage(&session).unwrap();
    assert_eq!((usage.input_tokens, usage.cache_read_tokens, usage.output_tokens), (1000, 200, 340));

    let follow_up = respawn(GeminiAdapter.send_input(&mut session, AgentInput::Text { text: "Now add tests".to_owned() }).unwrap());
    assert_eq!(values_after(&follow_up.args, "-r"), Some("a1b2"));
    assert_eq!(values_after(&follow_up.args, "-p"), Some("Now add tests"));
}

#[test]
fn acp_drivers_start_with_the_initialize_request() {
    let mut spec = spec(RunMode::Structured);
    spec.driver = RunDriver::Acp;
    for (adapter, first_arg) in [
        (&GeminiAdapter as &dyn CliAdapter, "--acp"),
        (&OpenCodeAdapter as &dyn CliAdapter, "acp"),
        (&AntigravityAdapter as &dyn CliAdapter, "acp"),
        (&GrokAdapter as &dyn CliAdapter, "agent"),
        (&MuseAdapter as &dyn CliAdapter, "acp"),
        (&KiroAdapter as &dyn CliAdapter, "acp"),
    ] {
        let (plan, _) = adapter.start(&spec).unwrap();
        assert_eq!(plan.args.first().map(String::as_str), Some(first_arg), "{}", adapter.info().name);
        let init: Value = serde_json::from_slice(&plan.initial_stdin).unwrap();
        assert_eq!(init["method"], "initialize", "{}", adapter.info().name);
        assert!(!plan.close_stdin);
    }
    for adapter in [&CodexAdapter as &dyn CliAdapter, &PiAdapter as &dyn CliAdapter] {
        assert!(adapter.start(&spec).is_err(), "{} has no native ACP", adapter.info().name);
    }
}

#[test]
fn opencode_blocks_push_through_config_and_ends_the_turn_on_stop() {
    let mut spec = spec(RunMode::Structured);
    spec.cli_version = Some("1.19.5".to_owned());
    let (plan, mut session) = OpenCodeAdapter.start(&spec).unwrap();
    assert_eq!(&plan.args[..3], ["run", "--format", "json"]);
    assert!(plan.args.contains(&"--standalone".to_owned()));
    let (_, config) = plan.env.iter().find(|(key, _)| key == "OPENCODE_CONFIG_CONTENT").unwrap();
    let config: Value = serde_json::from_str(config).unwrap();
    assert_eq!(config["permission"]["bash"]["git push *"], "deny");

    let stream = concat!(
        r#"{"type":"step_start","timestamp":1,"sessionID":"ses_0323","part":{"type":"step-start"}}"#, "\n",
        r#"{"type":"tool_use","timestamp":2,"sessionID":"ses_0323","part":{"type":"tool","tool":"bash","callID":"c1","state":{"status":"completed","input":{"command":"cargo test"},"output":"ok","title":"cargo test"}}}"#, "\n",
        r#"{"type":"step_finish","timestamp":3,"sessionID":"ses_0323","part":{"type":"step-finish","reason":"tool-calls","tokens":{"input":100,"output":10,"reasoning":0,"cache":{"read":50,"write":0}},"cost":0.01}}"#, "\n",
        r#"{"type":"text","timestamp":4,"sessionID":"ses_0323","part":{"type":"text","text":"All tests pass."}}"#, "\n",
        r#"{"type":"step_finish","timestamp":5,"sessionID":"ses_0323","part":{"type":"step-finish","reason":"stop","tokens":{"input":20,"output":5,"reasoning":0,"cache":{"read":0,"write":0}},"cost":0.002}}"#, "\n",
    );
    let events = parse(&OpenCodeAdapter, &mut session, stream);
    assert_eq!(kinds(&events), ["session", "tool_call", "tool_result", "usage", "message", "usage", "turn_completed"]);
    let usage = OpenCodeAdapter.get_usage(&session).unwrap();
    assert_eq!((usage.input_tokens, usage.output_tokens, usage.cache_read_tokens), (120, 15, 50));
    assert!((usage.cost_usd.unwrap() - 0.012).abs() < 1e-9);

    let follow_up = respawn(OpenCodeAdapter.send_input(&mut session, AgentInput::Text { text: "Thanks".to_owned() }).unwrap());
    assert_eq!(values_after(&follow_up.args, "-s"), Some("ses_0323"));
}

#[test]
fn antigravity_keeps_one_process_and_reads_cumulative_results() {
    let (plan, mut session) = AntigravityAdapter.start(&spec(RunMode::Structured)).unwrap();
    assert_eq!(values_after(&plan.args, "--mode"), Some("accept-edits"));
    assert_eq!(values_after(&plan.args, "--input-format"), Some("stream-json"));
    let first: Value = serde_json::from_slice(&plan.initial_stdin).unwrap();
    assert_eq!(first["event"], "user");

    let stream = concat!(
        r#"{"event":"init","conversation_id":"edb1","init":{"cwd":"/work/repo","tools":["run_command"],"permission_mode":"accept-edits","model":"gemini-x"}}"#, "\n",
        r#"{"event":"step_update","step_update":{"conversation_id":"edb1","step_index":3,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"cargo test"}}}}"#, "\n",
        r#"{"event":"step_update","step_update":{"conversation_id":"edb1","step_index":3,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"cargo test"},"output":"ok"}}}"#, "\n",
        r#"{"event":"step_update","step_update":{"conversation_id":"edb1","step_index":4,"state":"ACTIVE","step_type":"agent_response","text_delta":"Done."}}"#, "\n",
        r#"{"event":"result","result":{"conversation_id":"edb1","status":"SUCCESS","response":"Done.","duration_seconds":2.5,"num_turns":1,"usage":{"input_tokens":500,"output_tokens":40,"thinking_tokens":10,"cache_read_tokens":100,"total_tokens":650}}}"#, "\n",
    );
    let events = parse(&AntigravityAdapter, &mut session, stream);
    assert_eq!(kinds(&events), ["session", "tool_call", "tool_result", "delta", "usage", "turn_completed"]);
    assert!(matches!(&events[1], AgentEvent::ToolCall { tool_kind: ToolKind::Execute, title: Some(title), .. } if title == "cargo test"));
    assert!(matches!(events.last(), Some(AgentEvent::TurnCompleted { duration_ms: Some(2500), is_error: false, .. })));

    let actions = AntigravityAdapter.send_input(&mut session, AgentInput::Text { text: "More".to_owned() }).unwrap();
    assert!(matches!(actions.as_slice(), [IoAction::Write(line)] if serde_json::from_slice::<Value>(line).unwrap()["message"]["content"] == "More"));
}

struct HelpProbe {
    help: &'static str,
}

impl Probe for HelpProbe {
    fn which(&self, _binary: &str) -> Option<PathBuf> {
        Some(PathBuf::from("/usr/local/bin/grok"))
    }
    fn run(&self, _program: &std::path::Path, args: &[&str], _timeout: Duration) -> Option<ProbeOutput> {
        let stdout = match args {
            ["--help"] => self.help,
            ["--version"] => "grok 1.0.77",
            _ => return None,
        };
        Some(ProbeOutput { status: Some(0), stdout: stdout.to_owned(), stderr: String::new() })
    }
    fn env(&self, _key: &str) -> Option<String> {
        None
    }
    fn home_dir(&self) -> Option<PathBuf> {
        None
    }
}

#[test]
fn grok_detection_skips_the_community_cli_and_parses_streaming_json() {
    let official = HelpProbe { help: "Usage: grok [OPTIONS]\n  --output-format <plain|json|streaming-json>\n  agent  Run as an ACP agent" };
    assert_eq!(GrokAdapter.detect(&official).and_then(|cli| cli.version).as_deref(), Some("1.0.77"));
    let community = HelpProbe { help: "Usage: grok [options]\n  --format json\n  --max-tool-rounds" };
    assert!(GrokAdapter.detect(&community).is_none());

    let (plan, mut session) = GrokAdapter.start(&spec(RunMode::Structured)).unwrap();
    assert!(plan.args.windows(2).any(|pair| pair[0] == "--deny" && pair[1] == "Bash(git push*)"));
    assert_eq!(values_after(&plan.args, "--output-format"), Some("streaming-json"));
    assert!(values_after(&plan.args, "--prompt-file").is_some_and(|path| path.ends_with("prompt.md")));

    let stream = concat!(
        r#"{"type":"text","data":"Looking"}"#, "\n",
        r#"{"type":"tool_call","toolCallId":"t1","title":"cargo test","kind":"execute","status":"pending","toolName":"Bash","rawInput":{"command":"cargo test"}}"#, "\n",
        r#"{"type":"tool_call_update","toolCallId":"t1","status":"completed","rawOutput":"ok"}"#, "\n",
        r#"{"type":"end","stopReason":"end_turn","sessionId":"s-1","usage":{"input_tokens":300,"cache_read_input_tokens":100,"output_tokens":50,"reasoning_tokens":5},"num_turns":1,"modelUsage":{"grok-code":{"costUSD":0.003}}}"#, "\n",
    );
    let events = parse(&GrokAdapter, &mut session, stream);
    assert_eq!(kinds(&events), ["delta", "tool_call", "tool_result", "session", "usage", "turn_completed"]);
    let usage = GrokAdapter.get_usage(&session).unwrap();
    assert_eq!((usage.input_tokens, usage.cache_read_tokens, usage.output_tokens), (300, 100, 50));
    assert_eq!(usage.cost_usd, Some(0.003));
    assert_eq!(session.session_id.as_deref(), Some("s-1"));
}

#[test]
fn muse_reads_the_exec_envelope() {
    let spec = spec(RunMode::Structured);
    let (plan, mut session) = MuseAdapter.start(&spec).unwrap();
    assert_eq!(&plan.args[..2], ["exec", "--json"]);
    assert_eq!(values_after(&plan.args, "--session-id"), Some(spec.run_id.to_string().as_str()));
    assert!(values_after(&plan.args, "--prompt-file").is_some_and(|path| path.ends_with("prompt.md")));
    let stream = concat!(
        r#"{"schema_version":1,"stream":{"kind":"session","id":"0f1e"},"record_type":"event","payload_type":"run.model.configured","payload":{"model_id":"muse-spark-1.2"}}"#, "\n",
        r#"{"schema_version":1,"stream":{"kind":"session","id":"0f1e"},"record_type":"event","payload_type":"run.output.delta","payload":{"text":"echo: "}}"#, "\n",
        r#"{"schema_version":1,"stream":{"kind":"session","id":"0f1e"},"record_type":"event","payload_type":"tool.result","payload":{"call_id":"c1","correlation_facts":{"outcome":"success","tool_name":"shell"},"text":"hello"}}"#, "\n",
        r#"{"schema_version":1,"stream":{"kind":"exec.usage","id":"u"},"record_type":"status","payload_type":"run.usage","payload":{"kind":"run_usage","models":[{"cached_tokens":10,"input_tokens":110,"output_tokens":20,"reasoning_tokens":0,"model":null}]}}"#, "\n",
        r#"{"schema_version":1,"stream":{"kind":"session","id":"0f1e"},"record_type":"event","payload_type":"run.terminal.completed","payload":{"kind":"run_terminal","terminal":"completed","text":"echo: hello"}}"#, "\n",
    );
    let events = parse(&MuseAdapter, &mut session, stream);
    assert_eq!(kinds(&events), ["session", "delta", "tool_result", "usage", "turn_completed"]);
    let usage = MuseAdapter.get_usage(&session).unwrap();
    assert_eq!((usage.input_tokens, usage.cache_read_tokens, usage.output_tokens), (100, 10, 20));
    assert_eq!(usage.model.as_deref(), Some("muse-spark-1.2"));
}

#[test]
fn pi_speaks_rpc_and_sums_reported_costs() {
    let mut spec = spec(RunMode::Structured);
    spec.permissions.mode = PermissionMode::ReadOnly;
    let (plan, mut session) = PiAdapter.start(&spec).unwrap();
    assert_eq!(&plan.args[..2], ["--mode", "rpc"]);
    assert_eq!(values_after(&plan.args, "--tools"), Some("read,grep,find,ls"));
    assert!(values_after(&plan.args, "--append-system-prompt").is_some_and(|path| path.ends_with("system-prompt.md")));
    let first: Value = serde_json::from_slice(&plan.initial_stdin).unwrap();
    assert_eq!((first["type"].as_str(), first["message"].as_str()), (Some("prompt"), Some("Fix the parser")));

    let stream = concat!(
        r#"{"type":"session","version":3,"id":"pi-1","cwd":"/work/repo"}"#, "\n",
        r#"{"type":"agent_start"}"#, "\n",
        r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Reading "}}"#, "\n",
        r#"{"type":"tool_execution_start","toolCallId":"call_1","toolName":"read","args":{"path":"src/parser.rs"}}"#, "\n",
        r#"{"type":"tool_execution_end","toolCallId":"call_1","toolName":"read","result":{"content":[{"type":"text","text":"fn parse"}]},"isError":false}"#, "\n",
        r#"{"type":"message_end","message":{"role":"assistant","model":"claude-x","content":[{"type":"text","text":"Reading done."}],"usage":{"input":100,"output":20,"cacheRead":30,"cacheWrite":0,"totalTokens":150,"cost":{"total":0.0042}},"stopReason":"stop"}}"#, "\n",
        r#"{"type":"agent_end","messages":[],"willRetry":false}"#, "\n",
    );
    let events = parse(&PiAdapter, &mut session, stream);
    assert_eq!(kinds(&events), ["session", "delta", "tool_call", "tool_result", "usage", "message", "turn_completed"]);
    assert!(matches!(events.last(), Some(AgentEvent::TurnCompleted { result: Some(text), .. }) if text == "Reading done."));
    let usage = PiAdapter.get_usage(&session).unwrap();
    assert_eq!(usage.cost_usd, Some(0.0042));

    let actions = PiAdapter.send_input(&mut session, AgentInput::Interrupt).unwrap();
    assert!(matches!(actions.as_slice(), [IoAction::Write(line)] if serde_json::from_slice::<Value>(line).unwrap()["type"] == "abort"));
}

#[test]
fn kiro_runs_v3_headless_and_reports_credits() {
    let (plan, mut session) = KiroAdapter.start(&spec(RunMode::Structured)).unwrap();
    assert_eq!(&plan.args[..3], ["chat", "--v3", "--no-interactive"]);
    assert!(plan.args.iter().any(|arg| arg.starts_with("--trust-tools=")));
    assert_eq!(plan.io, IoMode::Pipes);

    let stream = concat!(
        r#"{"type":"runStarted","data":{"payloadSchema":"acp","acpProtocolVersion":1,"engine":"v3"}}"#, "\n",
        r#"{"type":"sessionUpdate","data":{"sessionId":"sess_1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Fixed."}}}}"#, "\n",
        r#"{"type":"sessionUpdate","data":{"sessionId":"sess_1","update":{"sessionUpdate":"tool_call","toolCallId":"t1","title":"Run tests","kind":"execute","status":"completed","rawInput":{"command":"cargo test"}}}}"#, "\n",
        r#"{"type":"sessionUpdate","data":{"sessionId":"sess_1","update":{"sessionUpdate":"session_info_update","_meta":{"kiro":{"kind":"turn_completion","promptTurnSummaries":[{"credits":0.04}]}}}}}"#, "\n",
        r#"{"type":"runFinished","data":{"sessionId":"sess_1","status":"success","stopReason":"end_turn","finalText":"Fixed."}}"#, "\n",
    );
    let events = parse(&KiroAdapter, &mut session, stream);
    assert_eq!(kinds(&events)[..2], ["session", "delta"]);
    assert!(events.iter().any(|event| matches!(event, AgentEvent::ToolCall { tool_kind: ToolKind::Execute, .. })));
    assert!(matches!(events.last(), Some(AgentEvent::TurnCompleted { is_error: false, .. })));
    let usage = KiroAdapter.get_usage(&session).unwrap();
    assert_eq!(usage.credits, Some(0.04));
    assert!(!usage.available, "Kiro reports credits, not tokens (L3)");
}

#[test]
fn every_adapter_types_or_passes_the_task_in_pty_mode() {
    for adapter in AdapterRegistry::builtin(false).all() {
        let (plan, session) = adapter.start(&spec(RunMode::Pty)).unwrap();
        assert!(matches!(plan.io, IoMode::Pty { cols: 100, rows: 30 }), "{}", adapter.info().name);
        assert_eq!(session.mode, RunMode::Pty);
        let delivers_task = !plan.initial_stdin.is_empty() || plan.args.iter().any(|arg| arg.contains("Fix the parser") || arg.contains("prompt.md"));
        assert!(delivers_task, "{} must receive the task", adapter.info().name);
    }
}
