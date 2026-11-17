//! Meta Muse Code adapter (`muse`), marked experimental.
//!
//! Structured driver: `muse exec --json --trust-workspace --session-id <uuid> --prompt-file <task>`,
//! one process per turn; follow-ups respawn with the same `--session-id`. ACP driver: `muse acp`
//! (`MUSE_EXPERIMENTAL_ACP=on`). PTY driver: the TUI.
//!
//! L8: Meta does not document the `exec --json` record schema. The parser follows the envelope
//! seen in community-captured fixtures (`payload_type` + `payload`) and treats everything it does
//! not know as raw output. Not installed on the reference machine (L12).

use std::sync::LazyLock;

use coffe_protocol::MessageRole;
use serde_json::Value;

use super::acp_driver;
use super::support::{
    Relaunch, auth_from_env, context_dir, detect_version, full_prompt, new_session_id, str_at, tool_kind_of, turn_completed,
    u64_at,
};
use super::{KEYS_NEED_PTY, stderr_events};
use crate::{
    AdapterError, AdapterInfo, AgentEvent, AgentInput, CliAdapter, CliCapabilities, DetectedCli, Injection, IoAction, IoMode,
    LaunchPlan, PermissionMode, Probe, RunDriver, RunMode, RunSpec, SessionState, Sig, StopMode, StopStep, StreamKind, Usage,
    WireProtocol, default_stop_steps, pty_input,
};

pub const ID: &str = "muse";
const BINARY: &str = "muse";

static INFO: LazyLock<AdapterInfo> = LazyLock::new(|| AdapterInfo {
    id: ID,
    name: "Muse Code",
    binaries: &[BINARY],
    capabilities: CliCapabilities {
        headless: true,
        structured_output: true,
        streaming_input: false,
        resume: true,
        usage_tokens: true,
        usage_cost: false,
        permission_callbacks: true,
        model_select: true,
        tool_filters: false,
        schema_output: false,
        modes: vec![RunMode::Structured, RunMode::Pty],
    },
    injection: Injection::PromptPreamble,
    wire: WireProtocol::JsonLines,
    docs_url: "https://dev.meta.ai/docs/muse-code/extending",
    tested_versions: "1.4.18 (documentation, experimental)",
});

#[derive(Debug, Clone, Copy, Default)]
pub struct MuseAdapter;

#[derive(Debug)]
struct MuseState {
    relaunch: Relaunch,
    turn_text: String,
}

/// Approval and sandbox flags (architecture Appendix A.2).
fn permission_args(mode: PermissionMode) -> Vec<String> {
    match mode {
        PermissionMode::ReadOnly => vec!["-c".into(), "profile=read-only".into()],
        // exec cannot hold approvals open: auto-review decides inside the sandbox.
        PermissionMode::WorkspaceWrite => vec!["--approval-mode".into(), "never".into()],
        PermissionMode::FullAuto => vec!["--yolo".into()],
    }
}

fn handle(session: &mut SessionState, line: Value, events: &mut Vec<AgentEvent>) {
    if str_at(&line, "/stream/kind") == Some("session") {
        if let Some(id) = new_session_id(session, str_at(&line, "/stream/id")) {
            events.push(AgentEvent::SessionStarted { session_id: Some(id), model: None, cwd: None, tools: Vec::new() });
        }
    }
    let payload = &line["payload"];
    match line.get("payload_type").and_then(Value::as_str) {
        Some("run.model.configured") => {
            if let Some(model) = payload.get("model_id").and_then(Value::as_str) {
                session.usage.model = Some(model.to_owned());
            }
        }
        Some("run.output.delta") => {
            let text = payload.get("text").and_then(Value::as_str).unwrap_or_default().to_owned();
            if !text.is_empty() {
                if let Some(state) = session.ext_mut::<MuseState>() {
                    state.turn_text.push_str(&text);
                }
                events.push(AgentEvent::MessageDelta { text });
            }
        }
        Some("task.lifecycle.started") => {
            let name = str_at(payload, "/tool_name").or_else(|| str_at(payload, "/name")).unwrap_or("task").to_owned();
            let call_id = str_at(payload, "/call_id").or_else(|| str_at(payload, "/task_id")).unwrap_or_default().to_owned();
            let input = payload.get("input").cloned().unwrap_or(Value::Null);
            events.push(AgentEvent::ToolCall { call_id, tool_kind: tool_kind_of(&name), title: None, name, input });
        }
        Some("tool.result") => {
            let outcome = str_at(payload, "/correlation_facts/outcome").unwrap_or("success");
            events.push(AgentEvent::ToolResult {
                call_id: payload.get("call_id").and_then(Value::as_str).unwrap_or_default().to_owned(),
                ok: !matches!(outcome, "failure" | "failed" | "error" | "rejected"),
                output: payload.get("text").and_then(Value::as_str).unwrap_or_default().to_owned(),
            });
        }
        Some("run.usage") => {
            // Running totals of the run: replace, per model summed.
            let models = payload.get("models").and_then(Value::as_array).cloned().unwrap_or_default();
            let sum = |key: &str| models.iter().map(|model| u64_at(model, &format!("/{key}"))).sum::<u64>();
            let cached = sum("cached_tokens");
            session.usage.available = true;
            session.usage.input_tokens = sum("input_tokens").saturating_sub(cached);
            session.usage.cache_read_tokens = cached;
            session.usage.output_tokens = sum("output_tokens");
            session.usage.reasoning_tokens = sum("reasoning_tokens");
            events.push(AgentEvent::Usage { usage: session.usage.clone() });
        }
        Some(kind) if kind.starts_with("run.terminal.") => {
            let terminal = payload.get("terminal").and_then(Value::as_str).unwrap_or(&kind["run.terminal.".len()..]);
            let text = session.ext_mut::<MuseState>().map(|state| std::mem::take(&mut state.turn_text)).unwrap_or_default();
            let result = if text.is_empty() { payload.get("text").and_then(Value::as_str).map(str::to_owned) } else { Some(text) };
            let failed = terminal != "completed";
            if failed {
                let reason = payload.get("reason").and_then(Value::as_str).unwrap_or(terminal);
                events.push(AgentEvent::Error { message: format!("Muse run {terminal}: {reason}") });
            }
            events.push(turn_completed(session, result, failed, None));
        }
        Some("turn.input.user") => {
            if let Some(text) = payload.get("text").and_then(Value::as_str) {
                events.push(AgentEvent::Message { role: MessageRole::User, text: text.to_owned() });
            }
        }
        // Lifecycle bookkeeping without a user-visible counterpart.
        Some(_) => {}
        None => events.push(AgentEvent::Raw { text: line.to_string() }),
    }
}

impl CliAdapter for MuseAdapter {
    fn info(&self) -> &AdapterInfo {
        &INFO
    }

    fn detect(&self, probe: &dyn Probe) -> Option<DetectedCli> {
        let (path, version) = detect_version(probe, BINARY)?;
        Some(DetectedCli { path, version: Some(version), auth: auth_from_env(probe, &["META_API_KEY"]) })
    }

    fn start(&self, spec: &RunSpec) -> Result<(LaunchPlan, SessionState), AdapterError> {
        let mut model_args = Vec::new();
        if let Some(model) = spec.model.as_deref().filter(|model| !model.trim().is_empty()) {
            model_args.extend(["--model".to_owned(), model.to_owned()]);
        }
        if spec.mode == RunMode::Structured && spec.driver == RunDriver::Acp {
            let mut args = vec!["acp".to_owned(), "--trust-workspace".to_owned()];
            args.extend(model_args);
            return acp_driver::start(spec, args, vec![("MUSE_EXPERIMENTAL_ACP".to_owned(), "on".to_owned())]);
        }
        let prompt_path = context_dir(&spec.cwd).join("prompt.md");
        let files = vec![(prompt_path.clone(), full_prompt(spec).into_bytes())];
        let session_id = spec.resume_session_id.clone().unwrap_or_else(|| spec.run_id.to_string());

        if spec.mode == RunMode::Pty {
            let mut args = vec!["--trust-workspace".to_owned()];
            args.extend(model_args);
            let plan = LaunchPlan {
                program: spec.program.clone(),
                args,
                env: spec.env.clone(),
                cwd: spec.cwd.clone(),
                io: IoMode::Pty { cols: spec.terminal.cols, rows: spec.terminal.rows },
                initial_stdin: b"Read `.coffe/context/prompt.md` completely and do what it says.\r".to_vec(),
                close_stdin: false,
                files,
            };
            return Ok((plan, SessionState::new(spec.run_id, RunMode::Pty)));
        }

        let mut base = vec!["exec".to_owned(), "--json".to_owned(), "--trust-workspace".to_owned()];
        base.extend(permission_args(spec.permissions.mode));
        base.extend(model_args);
        if let Some(turns) = spec.permissions.max_turns {
            base.extend(["--max-model-steps".to_owned(), turns.to_string()]);
        }
        base.extend(["--session-id".to_owned(), session_id.clone()]);
        let relaunch = Relaunch::new(spec, base);
        let plan = relaunch.plan(vec!["--prompt-file".to_owned(), prompt_path.display().to_string()], Vec::new(), files);
        let mut session = SessionState::new(spec.run_id, RunMode::Structured).with_ext(MuseState { relaunch, turn_text: String::new() });
        session.session_id = Some(session_id);
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
                let Some(state) = session.ext_mut::<MuseState>() else {
                    return Err(AdapterError::Other("Muse session state is missing".to_owned()));
                };
                state.relaunch.turns += 1;
                let path = context_dir(&state.relaunch.cwd).join(format!("prompt-{}.md", state.relaunch.turns));
                // `--session-id` is part of the base arguments, so the turn continues the session.
                let plan = state.relaunch.plan(
                    vec!["--prompt-file".to_owned(), path.display().to_string()],
                    Vec::new(),
                    vec![(path, text.into_bytes())],
                );
                session.turn_completed = false;
                IoAction::Respawn(Box::new(plan))
            }
            AgentInput::Interrupt => IoAction::Signal(Sig::Interrupt),
            AgentInput::Permission { .. } => {
                IoAction::Unsupported("muse exec cannot hold approvals open; use the ACP driver for live answers".to_owned())
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
