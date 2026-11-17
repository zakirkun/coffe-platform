//! xAI Grok Build adapter (`grok`).
//!
//! Structured driver: `grok --prompt-file <task> --output-format streaming-json`, one process per
//! turn (piped stdin is not read); follow-ups respawn with `-r <sessionId>`. ACP driver:
//! `grok agent stdio`. PTY driver: the TUI.
//!
//! Written against xai-org/grok-build `docs/user-guide/14-headless-mode.md` and
//! <https://docs.x.ai/build/cli/headless-scripting> (1.0.77). Not installed on the reference
//! machine (L12). L9: the community `grok-cli` installs the same binary name, so detection
//! requires Grok Build's own flags in `grok --help`.

use std::sync::LazyLock;

use coffe_protocol::{MessageRole, PlanItem};
use serde_json::Value;

use super::acp_driver;
use super::support::{
    GIT_PUSH, Relaunch, VERSION_TIMEOUT, auth_from_env, context_dir, full_prompt, new_session_id, str_at, tool_kind_of, tool_title,
    turn_completed, u64_at, version_token,
};
use super::{KEYS_NEED_PTY, stderr_events};
use crate::{
    AdapterError, AdapterInfo, AgentEvent, AgentInput, CliAdapter, CliCapabilities, DetectedCli, Injection, IoAction, IoMode,
    LaunchPlan, PermissionMode, Probe, RunDriver, RunMode, RunSpec, SessionState, Sig, StopMode, StopStep, StreamKind, ToolKind,
    Usage, WireProtocol, default_stop_steps, pty_input,
};

pub const ID: &str = "grok";
const BINARY: &str = "grok";
/// Tokens only Grok Build's `--help` prints (the community CLI shares the binary name).
const OFFICIAL_HELP_TOKENS: [&str; 2] = ["streaming-json", "agent"];

static INFO: LazyLock<AdapterInfo> = LazyLock::new(|| AdapterInfo {
    id: ID,
    name: "Grok Build",
    binaries: &[BINARY],
    capabilities: CliCapabilities {
        headless: true,
        structured_output: true,
        streaming_input: false,
        resume: true,
        usage_tokens: true,
        usage_cost: true,
        permission_callbacks: true,
        model_select: true,
        tool_filters: true,
        schema_output: false,
        modes: vec![RunMode::Structured, RunMode::Pty],
    },
    injection: Injection::PromptPreamble,
    wire: WireProtocol::JsonLines,
    docs_url: "https://docs.x.ai/build/cli/headless-scripting",
    tested_versions: "1.0.77 (documentation)",
});

#[derive(Debug, Clone, Copy, Default)]
pub struct GrokAdapter;

#[derive(Debug)]
struct GrokState {
    relaunch: Relaunch,
    turn_text: String,
}

/// Permission flags (architecture Appendix A.2); `git push` is always denied.
fn permission_args(spec: &RunSpec) -> Vec<String> {
    let mut args = Vec::new();
    match spec.permissions.mode {
        PermissionMode::ReadOnly => {
            for tool in ["Edit", "Write", "Bash"] {
                args.extend(["--deny".to_owned(), tool.to_owned()]);
            }
        }
        PermissionMode::WorkspaceWrite => {
            for rule in &spec.permissions.allow_tools {
                args.extend(["--allow".to_owned(), rule.clone()]);
            }
        }
        PermissionMode::FullAuto => args.push("--always-approve".to_owned()),
    }
    args.extend(["--deny".to_owned(), format!("Bash({GIT_PUSH}*)")]);
    for rule in &spec.permissions.deny_tools {
        args.extend(["--deny".to_owned(), rule.clone()]);
    }
    if !spec.permissions.network {
        args.extend(["--deny".to_owned(), "WebFetch".to_owned()]);
    }
    args
}

fn handle(session: &mut SessionState, line: Value, events: &mut Vec<AgentEvent>) {
    match line.get("type").and_then(Value::as_str) {
        Some("text") => {
            let text = line.get("data").and_then(Value::as_str).unwrap_or_default().to_owned();
            if !text.is_empty() {
                if let Some(state) = session.ext_mut::<GrokState>() {
                    state.turn_text.push_str(&text);
                }
                events.push(AgentEvent::MessageDelta { text });
            }
        }
        Some("thought") => {
            if let Some(text) = line.get("data").and_then(Value::as_str).filter(|text| !text.is_empty()) {
                events.push(AgentEvent::Thinking { text: text.to_owned() });
            }
        }
        Some("tool_call") => {
            let name = line.get("toolName").or_else(|| line.get("title")).and_then(Value::as_str).unwrap_or("tool").to_owned();
            let input = line.get("rawInput").cloned().unwrap_or(Value::Null);
            let kind = match line.get("kind").and_then(Value::as_str) {
                Some("read") => ToolKind::Read,
                Some("edit" | "delete" | "move") => ToolKind::Edit,
                Some("execute") => ToolKind::Execute,
                Some("search") => ToolKind::Search,
                Some("fetch") => ToolKind::Fetch,
                _ => tool_kind_of(&name),
            };
            events.push(AgentEvent::ToolCall {
                call_id: line.get("toolCallId").and_then(Value::as_str).unwrap_or_default().to_owned(),
                tool_kind: kind,
                title: line.get("title").and_then(Value::as_str).map(str::to_owned).or_else(|| tool_title(&input)),
                name,
                input,
            });
        }
        Some("tool_call_update") => {
            let status = line.get("status").and_then(Value::as_str).unwrap_or_default();
            if status == "completed" || status == "failed" {
                let output = match line.get("rawOutput") {
                    Some(Value::String(text)) => text.clone(),
                    Some(other) if !other.is_null() => other.to_string(),
                    _ => String::new(),
                };
                events.push(AgentEvent::ToolResult {
                    call_id: line.get("toolCallId").and_then(Value::as_str).unwrap_or_default().to_owned(),
                    ok: status == "completed",
                    output,
                });
            }
        }
        Some("plan") => {
            let items = line
                .get("entries")
                .and_then(Value::as_array)
                .map(|entries| {
                    entries
                        .iter()
                        .map(|entry| PlanItem {
                            text: entry.get("content").and_then(Value::as_str).unwrap_or_default().to_owned(),
                            status: entry.get("status").and_then(Value::as_str).unwrap_or("pending").to_owned(),
                        })
                        .collect()
                })
                .unwrap_or_default();
            events.push(AgentEvent::Plan { items });
        }
        Some("end") => {
            if let Some(id) = new_session_id(session, line.get("sessionId").and_then(Value::as_str)) {
                events.push(AgentEvent::SessionStarted { session_id: Some(id), model: None, cwd: None, tools: Vec::new() });
            }
            let usage = &line["usage"];
            session.usage.available = true;
            session.usage.input_tokens = session.usage.input_tokens.saturating_add(u64_at(usage, "/input_tokens"));
            session.usage.output_tokens = session.usage.output_tokens.saturating_add(u64_at(usage, "/output_tokens"));
            session.usage.cache_read_tokens = session.usage.cache_read_tokens.saturating_add(u64_at(usage, "/cache_read_input_tokens"));
            session.usage.cache_write_tokens =
                session.usage.cache_write_tokens.saturating_add(u64_at(usage, "/cache_creation_input_tokens"));
            session.usage.reasoning_tokens = session.usage.reasoning_tokens.saturating_add(u64_at(usage, "/reasoning_tokens"));
            // Cost is only reported when complete (API-key traffic); partial costs are omitted.
            let costs: Vec<f64> = line
                .get("modelUsage")
                .and_then(Value::as_object)
                .map(|models| models.values().filter_map(|model| model.get("costUSD").and_then(Value::as_f64)).collect())
                .unwrap_or_default();
            if !costs.is_empty() {
                session.usage.cost_usd = Some(session.usage.cost_usd.unwrap_or(0.0) + costs.iter().sum::<f64>());
            }
            if let Some(model) = line.get("modelUsage").and_then(Value::as_object).and_then(|models| models.keys().next()) {
                session.usage.model = Some(model.clone());
            }
            events.push(AgentEvent::Usage { usage: session.usage.clone() });
            let text = session.ext_mut::<GrokState>().map(|state| std::mem::take(&mut state.turn_text)).unwrap_or_default();
            let stop = line.get("stopReason").and_then(Value::as_str).unwrap_or("end_turn");
            let failed = !matches!(stop, "end_turn" | "stop");
            events.push(turn_completed(session, (!text.is_empty()).then_some(text), failed, None));
        }
        Some("max_turns_reached") => events.push(AgentEvent::Error { message: "maximum number of turns reached".to_owned() }),
        Some("error") => events.push(AgentEvent::Error { message: str_at(&line, "/message").unwrap_or("error").to_owned() }),
        Some("usage" | "available_commands") => {}
        Some(kind) if kind.starts_with("auto_compact") => {
            events.push(AgentEvent::Message { role: MessageRole::System, text: "Conversation compacted".to_owned() });
        }
        _ => events.push(AgentEvent::Raw { text: line.to_string() }),
    }
}

impl CliAdapter for GrokAdapter {
    fn info(&self) -> &AdapterInfo {
        &INFO
    }

    fn detect(&self, probe: &dyn Probe) -> Option<DetectedCli> {
        let path = probe.which(BINARY)?;
        let help = probe.run(&path, &["--help"], VERSION_TIMEOUT)?;
        let text = format!("{}{}", help.stdout, help.stderr);
        if !OFFICIAL_HELP_TOKENS.iter().all(|token| text.contains(token)) {
            return None;
        }
        let version = probe
            .run(&path, &["--version"], VERSION_TIMEOUT)
            .and_then(|output| version_token(&output.stdout).or_else(|| version_token(&output.stderr)));
        let mut auth = auth_from_env(probe, &["XAI_API_KEY"]);
        if auth != crate::CliAuthStatus::Ok && probe.home_dir().is_some_and(|home| home.join(".grok").join("auth.json").is_file()) {
            auth = crate::CliAuthStatus::Ok;
        }
        Some(DetectedCli { path, version, auth })
    }

    fn start(&self, spec: &RunSpec) -> Result<(LaunchPlan, SessionState), AdapterError> {
        let env = vec![("GROK_DISABLE_AUTOUPDATER".to_owned(), "1".to_owned())];
        let mut model_args = Vec::new();
        if let Some(model) = spec.model.as_deref().filter(|model| !model.trim().is_empty()) {
            model_args.extend(["-m".to_owned(), model.to_owned()]);
        }
        if spec.mode == RunMode::Structured && spec.driver == RunDriver::Acp {
            let mut args = vec!["agent".to_owned()];
            if spec.permissions.mode == PermissionMode::FullAuto {
                args.push("--always-approve".to_owned());
            }
            args.extend(model_args);
            args.push("stdio".to_owned());
            return acp_driver::start(spec, args, env);
        }

        let mut base = permission_args(spec);
        base.extend(model_args);
        let prompt_path = context_dir(&spec.cwd).join("prompt.md");
        let files = vec![(prompt_path.clone(), full_prompt(spec).into_bytes())];
        if spec.mode == RunMode::Pty {
            let plan = LaunchPlan {
                program: spec.program.clone(),
                args: base,
                env: spec.env.iter().cloned().chain(env).collect(),
                cwd: spec.cwd.clone(),
                io: IoMode::Pty { cols: spec.terminal.cols, rows: spec.terminal.rows },
                initial_stdin: b"Read `.coffe/context/prompt.md` completely and do what it says.\r".to_vec(),
                close_stdin: false,
                files,
            };
            return Ok((plan, SessionState::new(spec.run_id, RunMode::Pty)));
        }

        base.extend(["--output-format".to_owned(), "streaming-json".to_owned(), "--no-auto-update".to_owned()]);
        if let Some(turns) = spec.permissions.max_turns {
            base.extend(["--max-turns".to_owned(), turns.to_string()]);
        }
        let mut relaunch = Relaunch::new(spec, base);
        relaunch.env.extend(env);
        let mut turn_args = Vec::new();
        if let Some(id) = &spec.resume_session_id {
            turn_args.extend(["-r".to_owned(), id.clone()]);
        }
        turn_args.extend(["--prompt-file".to_owned(), prompt_path.display().to_string()]);
        let plan = relaunch.plan(turn_args, Vec::new(), files);
        let mut session = SessionState::new(spec.run_id, RunMode::Structured).with_ext(GrokState { relaunch, turn_text: String::new() });
        session.session_id.clone_from(&spec.resume_session_id);
        Ok((plan, session))
    }

    fn send_input(&self, session: &mut SessionState, input: AgentInput) -> Result<Vec<IoAction>, AdapterError> {
        if acp_driver::is_acp(session) {
            return acp_driver::send_input(session, input);
        }
        if session.mode == RunMode::Pty {
            return pty_input(input);
        }
        Ok(vec![match input {
            AgentInput::Text { text } => {
                let Some(id) = session.session_id.clone() else {
                    return Ok(vec![IoAction::Unsupported("Grok has not reported its session id yet".to_owned())]);
                };
                let Some(state) = session.ext_mut::<GrokState>() else {
                    return Err(AdapterError::Other("Grok session state is missing".to_owned()));
                };
                state.relaunch.turns += 1;
                let path = context_dir(&state.relaunch.cwd).join(format!("prompt-{}.md", state.relaunch.turns));
                let plan = state.relaunch.plan(
                    vec!["-r".to_owned(), id, "--prompt-file".to_owned(), path.display().to_string()],
                    Vec::new(),
                    vec![(path, text.into_bytes())],
                );
                session.turn_completed = false;
                IoAction::Respawn(Box::new(plan))
            }
            AgentInput::Interrupt => IoAction::Signal(Sig::Interrupt),
            AgentInput::Permission { .. } => {
                IoAction::Unsupported("headless Grok applies the persona's rules; use the ACP driver for live answers".to_owned())
            }
            AgentInput::Keys { .. } => IoAction::Unsupported(KEYS_NEED_PTY.to_owned()),
        }])
    }

    fn stop(&self, session: &mut SessionState, mode: StopMode) -> Vec<StopStep> {
        if acp_driver::is_acp(session) {
            return acp_driver::stop(session, mode);
        }
        default_stop_steps(mode)
    }

    fn parse_events(&self, session: &mut SessionState, stream: StreamKind, chunk: &[u8]) -> Vec<AgentEvent> {
        if acp_driver::is_acp(session) {
            return acp_driver::parse(session, stream, chunk);
        }
        match stream {
            StreamKind::Stdout => super::support::json_lines(session, chunk, handle),
            StreamKind::Stderr => stderr_events(session, chunk),
            StreamKind::Pty => Vec::new(),
        }
    }

    fn get_usage(&self, session: &SessionState) -> Option<Usage> {
        if acp_driver::is_acp(session) {
            return acp_driver::usage(session);
        }
        session.usage.available.then(|| session.usage.clone())
    }
}
