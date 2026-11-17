//! Pi adapter (`pi`, `@earendil-works/pi-coding-agent`).
//!
//! Structured driver: `pi --mode rpc --session-id <id>`, one process for the whole session;
//! prompts, follow-ups and aborts are JSONL commands on stdin, events are the JSON-mode stream
//! (`message_update`, `message_end` with usage and USD cost, `tool_execution_*`, `agent_end`).
//! PTY driver: the TUI with the task as its first message.
//!
//! Written against `pi --help` 1.5.0 and the bundled docs (`json.md`, `rpc.md`,
//! `message-types.md`). L7: Pi has no permission system; read-only personas get a read-only tool
//! allowlist and every other limit is reported as not enforceable.

use std::sync::LazyLock;
use std::time::Duration;

use coffe_protocol::MessageRole;
use serde_json::{Value, json};

use super::support::{auth_from_env, detect_version, str_at, tool_kind_of, tool_title, turn_completed, u64_at};
use super::{KEYS_NEED_PTY, json_line, require_native_driver, stderr_events, system_prompt_file};
use crate::{
    AdapterError, AdapterInfo, AgentEvent, AgentInput, CliAdapter, CliCapabilities, DetectedCli, Injection, IoAction, IoMode,
    LaunchPlan, PermissionMode, Probe, RunMode, RunSpec, SessionState, StopMode, StopStep, StreamKind, Usage, WireProtocol,
    default_stop_steps, pty_input,
};

pub const ID: &str = "pi";
const BINARY: &str = "pi";
const READ_ONLY_TOOLS: &str = "read,grep,find,ls";
const CLOSE_STDIN_WAIT: Duration = Duration::from_secs(5);

static INFO: LazyLock<AdapterInfo> = LazyLock::new(|| AdapterInfo {
    id: ID,
    name: "Pi",
    binaries: &[BINARY],
    capabilities: CliCapabilities {
        headless: true,
        structured_output: true,
        streaming_input: true,
        resume: true,
        usage_tokens: true,
        usage_cost: true,
        permission_callbacks: false,
        model_select: true,
        tool_filters: true,
        schema_output: false,
        modes: vec![RunMode::Structured, RunMode::Pty],
    },
    injection: Injection::SystemPromptFlag,
    wire: WireProtocol::JsonRpc,
    docs_url: "https://pi.dev/docs/rpc",
    tested_versions: "1.5.0",
});

#[derive(Debug, Clone, Copy, Default)]
pub struct PiAdapter;

#[derive(Debug, Default)]
struct PiState {
    requests: u64,
    /// Text of the last complete assistant message of the running turn.
    last_text: Option<String>,
}

fn command(session: &mut SessionState, kind: &str, extra: Value) -> Vec<u8> {
    let id = session.ext_mut::<PiState>().map(|state| {
        state.requests += 1;
        state.requests
    });
    let mut message = json!({ "id": format!("coffe-{}", id.unwrap_or(0)), "type": kind });
    if let (Value::Object(target), Value::Object(fields)) = (&mut message, extra) {
        target.extend(fields);
    }
    json_line(&message)
}

/// Text blocks of an assistant message (`content` is a list of typed blocks).
fn message_text(message: &Value) -> String {
    message
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

fn handle(session: &mut SessionState, line: Value, events: &mut Vec<AgentEvent>) {
    match line.get("type").and_then(Value::as_str) {
        Some("session") => {
            if let Some(id) = super::support::new_session_id(session, line.get("id").and_then(Value::as_str)) {
                events.push(AgentEvent::SessionStarted {
                    session_id: Some(id),
                    model: None,
                    cwd: line.get("cwd").and_then(Value::as_str).map(str::to_owned),
                    tools: Vec::new(),
                });
            }
        }
        Some("message_update") => {
            let event = &line["assistantMessageEvent"];
            let delta = event.get("delta").and_then(Value::as_str).unwrap_or_default();
            match event.get("type").and_then(Value::as_str) {
                Some("text_delta") if !delta.is_empty() => events.push(AgentEvent::MessageDelta { text: delta.to_owned() }),
                Some("thinking_delta") if !delta.is_empty() => events.push(AgentEvent::Thinking { text: delta.to_owned() }),
                _ => {}
            }
        }
        Some("message_end") => {
            let message = &line["message"];
            if message.get("role").and_then(Value::as_str) != Some("assistant") {
                return;
            }
            let usage = &message["usage"];
            if usage.is_object() {
                session.usage.available = true;
                session.usage.input_tokens = session.usage.input_tokens.saturating_add(u64_at(usage, "/input"));
                session.usage.output_tokens = session.usage.output_tokens.saturating_add(u64_at(usage, "/output"));
                session.usage.cache_read_tokens = session.usage.cache_read_tokens.saturating_add(u64_at(usage, "/cacheRead"));
                session.usage.cache_write_tokens = session.usage.cache_write_tokens.saturating_add(u64_at(usage, "/cacheWrite"));
                if let Some(cost) = usage.pointer("/cost/total").and_then(Value::as_f64) {
                    session.usage.cost_usd = Some(session.usage.cost_usd.unwrap_or(0.0) + cost);
                }
                if let Some(model) = message.get("model").and_then(Value::as_str) {
                    session.usage.model = Some(model.to_owned());
                }
                events.push(AgentEvent::Usage { usage: session.usage.clone() });
            }
            let text = message_text(message);
            if !text.is_empty() {
                events.push(AgentEvent::Message { role: MessageRole::Assistant, text: text.clone() });
                if let Some(state) = session.ext_mut::<PiState>() {
                    state.last_text = Some(text);
                }
            }
            if message.get("stopReason").and_then(Value::as_str) == Some("error") {
                let error = message.get("errorMessage").and_then(Value::as_str).unwrap_or("the model call failed");
                events.push(AgentEvent::Error { message: error.to_owned() });
            }
        }
        Some("tool_execution_start") => {
            let name = line.get("toolName").and_then(Value::as_str).unwrap_or("tool").to_owned();
            let input = line.get("args").cloned().unwrap_or(Value::Null);
            events.push(AgentEvent::ToolCall {
                call_id: line.get("toolCallId").and_then(Value::as_str).unwrap_or_default().to_owned(),
                tool_kind: tool_kind_of(&name),
                title: tool_title(&input),
                name,
                input,
            });
        }
        Some("tool_execution_end") => {
            let output = line
                .pointer("/result/content")
                .and_then(Value::as_array)
                .map(|blocks| blocks.iter().filter_map(|block| block.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n"))
                .unwrap_or_default();
            events.push(AgentEvent::ToolResult {
                call_id: line.get("toolCallId").and_then(Value::as_str).unwrap_or_default().to_owned(),
                ok: !line.get("isError").and_then(Value::as_bool).unwrap_or(false),
                output,
            });
        }
        Some("agent_end") => {
            // A retry continues the same turn.
            if line.get("willRetry").and_then(Value::as_bool).unwrap_or(false) {
                return;
            }
            let last = session.ext_mut::<PiState>().and_then(|state| state.last_text.take());
            let failed = line
                .get("messages")
                .and_then(Value::as_array)
                .and_then(|messages| messages.last())
                .and_then(|message| message.get("stopReason").and_then(Value::as_str))
                .is_some_and(|reason| matches!(reason, "error" | "aborted"));
            events.push(turn_completed(session, last, failed, None));
        }
        Some("response") => {
            if line.get("success").and_then(Value::as_bool) == Some(false) {
                let command = line.get("command").and_then(Value::as_str).unwrap_or("command");
                let error = str_at(&line, "/error").unwrap_or("rejected");
                events.push(AgentEvent::Error { message: format!("Pi rejected {command}: {error}") });
            }
        }
        Some("auto_retry_start") => events.push(AgentEvent::Raw { text: "Pi retries the model call".to_owned() }),
        Some(_) => {}
        None => events.push(AgentEvent::Raw { text: line.to_string() }),
    }
}

impl CliAdapter for PiAdapter {
    fn info(&self) -> &AdapterInfo {
        &INFO
    }

    fn detect(&self, probe: &dyn Probe) -> Option<DetectedCli> {
        let (path, version) = detect_version(probe, BINARY)?;
        Some(DetectedCli {
            path,
            version: Some(version),
            auth: auth_from_env(probe, &["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY"]),
        })
    }

    fn start(&self, spec: &RunSpec) -> Result<(LaunchPlan, SessionState), AdapterError> {
        require_native_driver(spec, INFO.name)?;
        let mut args = Vec::new();
        let session_id = spec.resume_session_id.clone().unwrap_or_else(|| spec.run_id.to_string());
        args.extend(["--session-id".to_owned(), session_id.clone()]);
        if let Some(model) = spec.model.as_deref().filter(|model| !model.trim().is_empty()) {
            args.extend(["--model".to_owned(), model.to_owned()]);
        }
        if spec.permissions.mode == PermissionMode::ReadOnly {
            args.extend(["--tools".to_owned(), READ_ONLY_TOOLS.to_owned()]);
        }
        let denied: Vec<&str> = spec.permissions.deny_tools.iter().map(String::as_str).filter(|rule| !rule.contains('(')).collect();
        if !denied.is_empty() {
            args.extend(["--exclude-tools".to_owned(), denied.join(",")]);
        }
        let mut files = Vec::new();
        if let Some((path, argument, content)) = system_prompt_file(spec)? {
            args.extend(["--append-system-prompt".to_owned(), argument]);
            files.push((path, content));
        }

        if spec.mode == RunMode::Pty {
            args.extend(["--".to_owned(), spec.prompt.clone()]);
            let plan = LaunchPlan {
                program: spec.program.clone(),
                args,
                env: spec.env.clone(),
                cwd: spec.cwd.clone(),
                io: IoMode::Pty { cols: spec.terminal.cols, rows: spec.terminal.rows },
                initial_stdin: Vec::new(),
                close_stdin: false,
                files,
            };
            let mut session = SessionState::new(spec.run_id, RunMode::Pty);
            session.session_id = Some(session_id);
            return Ok((plan, session));
        }

        let mut rpc = vec!["--mode".to_owned(), "rpc".to_owned()];
        rpc.append(&mut args);
        let mut session = SessionState::new(spec.run_id, RunMode::Structured).with_ext(PiState::default());
        session.session_id = Some(session_id);
        let initial_stdin = command(&mut session, "prompt", json!({ "message": spec.prompt }));
        let plan = LaunchPlan {
            program: spec.program.clone(),
            args: rpc,
            env: spec.env.clone(),
            cwd: spec.cwd.clone(),
            io: IoMode::Pipes,
            initial_stdin,
            close_stdin: false,
            files,
        };
        Ok((plan, session))
    }

    fn send_input(&self, session: &mut SessionState, input: AgentInput) -> Result<Vec<IoAction>, AdapterError> {
        if session.mode == RunMode::Pty {
            return pty_input(input);
        }
        Ok(vec![match input {
            AgentInput::Text { text } => {
                session.turn_completed = false;
                // Queued after the running turn; starts a new one when idle.
                IoAction::Write(command(session, "prompt", json!({ "message": text, "streamingBehavior": "followUp" })))
            }
            AgentInput::Interrupt => IoAction::Write(command(session, "abort", json!({}))),
            AgentInput::Permission { .. } => IoAction::Unsupported("Pi has no permission prompts (limitation L7)".to_owned()),
            AgentInput::Keys { .. } => IoAction::Unsupported(KEYS_NEED_PTY.to_owned()),
        }])
    }

    fn stop(&self, session: &mut SessionState, mode: StopMode) -> Vec<StopStep> {
        if session.mode == RunMode::Pty {
            return default_stop_steps(mode);
        }
        match mode {
            StopMode::InterruptTurn => vec![StopStep { action: IoAction::Write(command(session, "abort", json!({}))), wait: Duration::ZERO }],
            StopMode::Graceful => {
                let mut steps = vec![
                    StopStep { action: IoAction::Write(command(session, "abort", json!({}))), wait: Duration::ZERO },
                    StopStep { action: IoAction::CloseStdin, wait: CLOSE_STDIN_WAIT },
                ];
                steps.extend(default_stop_steps(StopMode::Graceful));
                steps
            }
            StopMode::Kill => default_stop_steps(StopMode::Kill),
        }
    }

    fn parse_events(&self, session: &mut SessionState, stream: StreamKind, chunk: &[u8]) -> Vec<AgentEvent> {
        match stream {
            StreamKind::Stdout => super::support::json_lines(session, chunk, handle),
            StreamKind::Stderr => stderr_events(session, chunk),
            StreamKind::Pty => Vec::new(),
        }
    }

    fn get_usage(&self, session: &SessionState) -> Option<Usage> {
        session.usage.available.then(|| session.usage.clone())
    }
}
