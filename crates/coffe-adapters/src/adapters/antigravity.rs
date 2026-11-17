//! Google Antigravity CLI adapter (`agy`).
//!
//! Structured driver: `agy --input-format stream-json --output-format stream-json`, one process
//! for the whole session; every turn is `{"event":"user","message":{"content":…}}` on stdin and
//! ends with a `result` event (usage, turns and duration are cumulative). ACP driver: `agy acp`.
//! PTY driver: the TUI with the task typed as its first message.
//!
//! Written against <https://antigravity.google/docs/cli/headless> and the CLI reference (1.5.9).
//! Not installed on the reference machine (L12). L10: headless soft-denies actions that need
//! approval and still exits 0, so personas must grant what the ticket needs up front.

use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::Duration;

use serde_json::{Value, json};

use super::acp_driver;
use super::support::{
    auth_from_env, context_dir, detect_version, full_prompt, new_session_id, str_at, tool_kind_of, tool_title, turn_completed,
    u64_at,
};
use super::{KEYS_NEED_PTY, json_line, stderr_events};
use crate::{
    AdapterError, AdapterInfo, AgentEvent, AgentInput, CliAdapter, CliCapabilities, DetectedCli, Injection, IoAction, IoMode,
    LaunchPlan, PermissionMode, Probe, RunDriver, RunMode, RunSpec, SessionState, Sig, StopMode, StopStep, StreamKind, Usage,
    WireProtocol, default_stop_steps, pty_input,
};

pub const ID: &str = "antigravity";
const BINARY: &str = "agy";
const CLOSE_STDIN_WAIT: Duration = Duration::from_secs(5);

static INFO: LazyLock<AdapterInfo> = LazyLock::new(|| AdapterInfo {
    id: ID,
    name: "Antigravity",
    binaries: &[BINARY],
    capabilities: CliCapabilities {
        headless: true,
        structured_output: true,
        streaming_input: true,
        resume: true,
        usage_tokens: true,
        usage_cost: false,
        permission_callbacks: true,
        model_select: true,
        tool_filters: false,
        schema_output: true,
        modes: vec![RunMode::Structured, RunMode::Pty],
    },
    injection: Injection::PromptPreamble,
    wire: WireProtocol::JsonLines,
    docs_url: "https://antigravity.google/docs/cli/headless",
    tested_versions: "1.5.9 (documentation)",
});

#[derive(Debug, Clone, Copy, Default)]
pub struct AntigravityAdapter;

#[derive(Debug, Default)]
struct AgyState {
    /// Tool steps already announced, by step index.
    tools: HashMap<u64, String>,
    turn_text: String,
}

fn mode_args(mode: PermissionMode) -> Vec<String> {
    match mode {
        PermissionMode::ReadOnly => vec!["--mode".into(), "plan".into()],
        PermissionMode::WorkspaceWrite => vec!["--mode".into(), "accept-edits".into()],
        PermissionMode::FullAuto => vec!["--dangerously-skip-permissions".into()],
    }
}

fn user_line(text: &str) -> Vec<u8> {
    json_line(&json!({ "event": "user", "message": { "content": text } }))
}

fn handle(session: &mut SessionState, line: Value, events: &mut Vec<AgentEvent>) {
    match line.get("event").and_then(Value::as_str) {
        Some("init") => {
            let model = str_at(&line, "/init/model").map(str::to_owned);
            if let Some(id) = new_session_id(session, line.get("conversation_id").and_then(Value::as_str)) {
                let tools = line
                    .pointer("/init/tools")
                    .and_then(Value::as_array)
                    .map(|tools| tools.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                    .unwrap_or_default();
                events.push(AgentEvent::SessionStarted {
                    session_id: Some(id),
                    model: model.clone(),
                    cwd: str_at(&line, "/init/cwd").map(str::to_owned),
                    tools,
                });
            }
            if model.is_some() {
                session.usage.model = model;
            }
        }
        Some("step_update") => step(session, &line["step_update"], events),
        Some("result") => {
            let result = &line["result"];
            let usage = &result["usage"];
            // Cumulative over the session: replace, do not add.
            session.usage.available = true;
            session.usage.input_tokens = u64_at(usage, "/input_tokens");
            session.usage.output_tokens = u64_at(usage, "/output_tokens");
            session.usage.cache_read_tokens = u64_at(usage, "/cache_read_tokens");
            session.usage.reasoning_tokens = u64_at(usage, "/thinking_tokens");
            events.push(AgentEvent::Usage { usage: session.usage.clone() });

            let status = result.get("status").and_then(Value::as_str).unwrap_or("SUCCESS");
            let text = session.ext_mut::<AgyState>().map(|state| std::mem::take(&mut state.turn_text)).unwrap_or_default();
            let answer = result
                .get("structured_output")
                .filter(|output| !output.is_null())
                .map(Value::to_string)
                .or_else(|| result.get("response").and_then(Value::as_str).map(str::to_owned))
                .or_else(|| (!text.is_empty()).then_some(text));
            let failed = status != "SUCCESS";
            if failed {
                let message = str_at(result, "/error/message")
                    .or_else(|| result.get("error").and_then(Value::as_str))
                    .unwrap_or(status)
                    .to_owned();
                events.push(AgentEvent::Error { message });
            }
            let duration = result
                .get("duration_seconds")
                .and_then(Value::as_f64)
                .and_then(|seconds| (seconds >= 0.0).then(|| (seconds * 1_000.0) as u64));
            events.push(turn_completed(session, answer, failed, duration));
        }
        _ => events.push(AgentEvent::Raw { text: line.to_string() }),
    }
}

fn step(session: &mut SessionState, update: &Value, events: &mut Vec<AgentEvent>) {
    let Some(state) = session.ext_mut::<AgyState>() else { return };
    let index = u64_at(update, "/step_index");
    let done = update.get("state").and_then(Value::as_str) == Some("DONE");
    match update.get("step_type").and_then(Value::as_str) {
        Some("agent_response") => {
            if let Some(text) = update.get("text_delta").and_then(Value::as_str).filter(|text| !text.is_empty()) {
                state.turn_text.push_str(text);
                events.push(AgentEvent::MessageDelta { text: text.to_owned() });
            }
        }
        Some("tool") => {
            let info = &update["tool_info"];
            let name = info
                .get("name")
                .or_else(|| update.get("tool_name"))
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_owned();
            let call_id = format!("step-{index}");
            if !state.tools.contains_key(&index) {
                state.tools.insert(index, name.clone());
                let input = info.get("parameters").cloned().unwrap_or(Value::Null);
                events.push(AgentEvent::ToolCall {
                    call_id: call_id.clone(),
                    tool_kind: tool_kind_of(&name),
                    title: tool_title(&input),
                    name,
                    input,
                });
            }
            if done {
                let error = info.get("error").filter(|error| !error.is_null());
                let output = error
                    .and_then(|error| error.get("message").and_then(Value::as_str))
                    .or_else(|| info.get("output").and_then(Value::as_str))
                    .unwrap_or_default()
                    .to_owned();
                events.push(AgentEvent::ToolResult { call_id, ok: error.is_none(), output });
            }
        }
        _ => {}
    }
}

impl CliAdapter for AntigravityAdapter {
    fn info(&self) -> &AdapterInfo {
        &INFO
    }

    fn detect(&self, probe: &dyn Probe) -> Option<DetectedCli> {
        let (path, version) = detect_version(probe, BINARY)?;
        Some(DetectedCli { path, version: Some(version), auth: auth_from_env(probe, &["GEMINI_API_KEY", "AGY_ADC_AUTH"]) })
    }

    fn start(&self, spec: &RunSpec) -> Result<(LaunchPlan, SessionState), AdapterError> {
        let mut model_args = Vec::new();
        if let Some(model) = spec.model.as_deref().filter(|model| !model.trim().is_empty()) {
            model_args.extend(["--model".to_owned(), model.to_owned()]);
        }
        if spec.mode == RunMode::Structured && spec.driver == RunDriver::Acp {
            let mut args = vec!["acp".to_owned()];
            if spec.permissions.mode == PermissionMode::FullAuto {
                args.push("--dangerously-skip-permissions".to_owned());
            }
            return acp_driver::start(spec, args, Vec::new());
        }
        let mut args = mode_args(spec.permissions.mode);
        args.extend(model_args);
        if let Some(id) = &spec.resume_session_id {
            args.extend(["--conversation".to_owned(), id.clone()]);
        }
        let prompt = full_prompt(spec);

        if spec.mode == RunMode::Pty {
            let typed = prompt.lines().map(str::trim).filter(|line| !line.is_empty()).collect::<Vec<_>>().join(" ");
            let plan = LaunchPlan {
                program: spec.program.clone(),
                args,
                env: spec.env.clone(),
                cwd: spec.cwd.clone(),
                io: IoMode::Pty { cols: spec.terminal.cols, rows: spec.terminal.rows },
                initial_stdin: if typed.is_empty() { Vec::new() } else { format!("{typed}\r").into_bytes() },
                close_stdin: false,
                files: Vec::new(),
            };
            return Ok((plan, SessionState::new(spec.run_id, RunMode::Pty)));
        }

        args.extend(["--input-format".to_owned(), "stream-json".to_owned(), "--output-format".to_owned(), "stream-json".to_owned()]);
        let mut files = Vec::new();
        if let Some(schema) = &spec.output_schema {
            let path = context_dir(&spec.cwd).join("output-schema.json");
            files.push((path.clone(), schema.to_string().into_bytes()));
            args.extend(["--json-schema".to_owned(), path.display().to_string()]);
        }
        let plan = LaunchPlan {
            program: spec.program.clone(),
            args,
            env: spec.env.clone(),
            cwd: spec.cwd.clone(),
            io: IoMode::Pipes,
            initial_stdin: user_line(&prompt),
            close_stdin: false,
            files,
        };
        let mut session = SessionState::new(spec.run_id, RunMode::Structured).with_ext(AgyState::default());
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
                session.turn_completed = false;
                IoAction::Write(user_line(&text))
            }
            AgentInput::Interrupt => IoAction::Signal(Sig::Interrupt),
            AgentInput::Permission { .. } => IoAction::Unsupported(
                "headless Antigravity soft-denies approvals; use the ACP driver for live permission answers".to_owned(),
            ),
            AgentInput::Keys { .. } => IoAction::Unsupported(KEYS_NEED_PTY.to_owned()),
        }])
    }

    fn stop(&self, session: &mut SessionState, mode: StopMode) -> Vec<StopStep> {
        if acp_driver::is_acp(session) {
            return acp_driver::stop(session, mode);
        }
        match (mode, session.mode) {
            // Closing stdin ends the session after the current turn.
            (StopMode::Graceful, RunMode::Structured) => {
                let mut steps = vec![StopStep { action: IoAction::CloseStdin, wait: CLOSE_STDIN_WAIT }];
                steps.extend(default_stop_steps(StopMode::Graceful));
                steps
            }
            _ => default_stop_steps(mode),
        }
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
