//! OpenAI Codex CLI adapter (`codex`).
//!
//! Structured driver: `codex exec --json` with the task on stdin, one process per turn; follow-ups
//! respawn `codex exec resume <thread_id> -`. Events are the `--json` JSONL stream
//! (`thread.started`, `item.*`, `turn.completed`/`turn.failed`). PTY driver: the interactive TUI
//! with the task as its first message.
//!
//! Written against <https://learn.chatgpt.com/docs/non-interactive-mode.md>, the `exec_events.rs`
//! schema and `codex exec --help` 0.153.4. Limitation L1: `codex exec` never asks for approval
//! (it rejects what the sandbox does not allow), so autonomy comes from the sandbox mode; L2: no
//! USD cost, tokens only.

use std::sync::LazyLock;
use std::time::Duration;

use coffe_protocol::{MessageRole, PlanItem};
use serde_json::{Value, json};

use super::support::{
    Relaunch, add_tokens, detect_version, full_prompt, new_session_id, prompt_argument, str_at, tool_title, turn_completed,
    u64_at,
};
use super::{KEYS_NEED_PTY, require_native_driver, stderr_events};
use crate::{
    AdapterError, AdapterInfo, AgentEvent, AgentInput, CliAdapter, CliAuthStatus, CliCapabilities, DetectedCli, Injection,
    IoAction, IoMode, LaunchPlan, PermissionMode, Probe, RunMode, RunSpec, SessionState, StopMode, StopStep, StreamKind,
    ToolKind, Usage, WireProtocol, default_stop_steps, pty_input,
};

pub const ID: &str = "codex";
const BINARY: &str = "codex";
const AUTH_TIMEOUT: Duration = Duration::from_secs(15);

static INFO: LazyLock<AdapterInfo> = LazyLock::new(|| AdapterInfo {
    id: ID,
    name: "Codex",
    binaries: &[BINARY],
    capabilities: CliCapabilities {
        headless: true,
        structured_output: true,
        streaming_input: false,
        resume: true,
        usage_tokens: true,
        usage_cost: false,
        permission_callbacks: false,
        model_select: true,
        tool_filters: false,
        schema_output: true,
        modes: vec![RunMode::Structured, RunMode::Pty],
    },
    injection: Injection::PromptPreamble,
    wire: WireProtocol::JsonLines,
    docs_url: "https://learn.chatgpt.com/docs/non-interactive-mode.md",
    tested_versions: "0.153.4",
});

#[derive(Debug, Clone, Copy, Default)]
pub struct CodexAdapter;

#[derive(Debug)]
struct CodexState {
    relaunch: Relaunch,
    /// Command items announced by `item.started`, so `item.completed` only adds the result.
    started: Vec<String>,
    /// Last agent message of the running turn.
    last_message: Option<String>,
}

/// Sandbox flags for the persona's permission mode (architecture Appendix A.2).
fn sandbox_args(spec: &RunSpec) -> Vec<String> {
    match spec.permissions.mode {
        PermissionMode::ReadOnly => vec!["-s".into(), "read-only".into()],
        PermissionMode::WorkspaceWrite => {
            let mut args = vec!["-s".to_owned(), "workspace-write".to_owned()];
            // Network stays off in workspace-write unless the persona allows it (also blocks push).
            if spec.permissions.network {
                args.extend(["-c".to_owned(), "sandbox_workspace_write.network_access=true".to_owned()]);
            }
            args
        }
        PermissionMode::FullAuto => vec!["--dangerously-bypass-approvals-and-sandbox".into()],
    }
}

fn exec_base_args(spec: &RunSpec) -> Vec<String> {
    let mut args = vec!["exec".to_owned(), "--json".to_owned(), "--skip-git-repo-check".to_owned(), "-C".to_owned(), spec.cwd.display().to_string()];
    args.extend(sandbox_args(spec));
    if let Some(model) = spec.model.as_deref().filter(|model| !model.trim().is_empty()) {
        args.extend(["-m".to_owned(), model.to_owned()]);
    }
    args
}

fn item_events(state: &mut CodexState, item: &Value, completed: bool, events: &mut Vec<AgentEvent>) {
    let id = item.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
    match item.get("type").and_then(Value::as_str) {
        Some("agent_message") if completed => {
            let text = item.get("text").and_then(Value::as_str).unwrap_or_default().to_owned();
            if !text.is_empty() {
                state.last_message = Some(text.clone());
                events.push(AgentEvent::Message { role: MessageRole::Assistant, text });
            }
        }
        Some("reasoning") if completed => {
            if let Some(text) = item.get("text").and_then(Value::as_str).filter(|text| !text.is_empty()) {
                events.push(AgentEvent::Thinking { text: text.to_owned() });
            }
        }
        Some("command_execution") => {
            let command = item.get("command").and_then(Value::as_str).unwrap_or_default();
            if !state.started.contains(&id) {
                state.started.push(id.clone());
                events.push(AgentEvent::ToolCall {
                    call_id: id.clone(),
                    name: "shell".to_owned(),
                    tool_kind: ToolKind::Execute,
                    input: json!({ "command": command }),
                    title: Some(command.chars().take(200).collect()),
                });
            }
            if completed {
                let exit_code = item.get("exit_code").and_then(Value::as_i64);
                let status = item.get("status").and_then(Value::as_str).unwrap_or("completed");
                events.push(AgentEvent::ToolResult {
                    call_id: id,
                    ok: status == "completed" && exit_code.unwrap_or(0) == 0,
                    output: item.get("aggregated_output").and_then(Value::as_str).unwrap_or_default().to_owned(),
                });
            }
        }
        Some("file_change") if completed => {
            for change in item.get("changes").and_then(Value::as_array).into_iter().flatten() {
                if let Some(path) = change.get("path").and_then(Value::as_str) {
                    let kind = change.get("kind").and_then(Value::as_str).unwrap_or("update");
                    events.push(AgentEvent::FileChange { path: path.to_owned(), change: kind.to_owned() });
                }
            }
        }
        Some("mcp_tool_call" | "web_search") if completed => {
            let is_search = item.get("type").and_then(Value::as_str) == Some("web_search");
            let name = if is_search {
                "web_search".to_owned()
            } else {
                format!("{}.{}", str_at(item, "/server").unwrap_or("mcp"), str_at(item, "/tool").unwrap_or("tool"))
            };
            let input = item.get("arguments").cloned().unwrap_or_else(|| json!({ "query": item.get("query") }));
            events.push(AgentEvent::ToolCall {
                call_id: id.clone(),
                name,
                tool_kind: if is_search { ToolKind::Fetch } else { ToolKind::Other },
                title: tool_title(&input),
                input,
            });
            let error = item.get("error").filter(|error| !error.is_null());
            events.push(AgentEvent::ToolResult {
                call_id: id,
                ok: error.is_none() && item.get("status").and_then(Value::as_str) != Some("failed"),
                output: error.map(Value::to_string).or_else(|| item.get("result").map(Value::to_string)).unwrap_or_default(),
            });
        }
        Some("todo_list") => {
            let items = item
                .get("items")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .map(|entry| PlanItem {
                            text: entry.get("text").and_then(Value::as_str).unwrap_or_default().to_owned(),
                            status: if entry.get("completed").and_then(Value::as_bool).unwrap_or(false) { "completed" } else { "pending" }.to_owned(),
                        })
                        .collect()
                })
                .unwrap_or_default();
            events.push(AgentEvent::Plan { items });
        }
        Some("error") if completed => {
            events.push(AgentEvent::Error { message: item.get("message").and_then(Value::as_str).unwrap_or("error").to_owned() });
        }
        _ => {}
    }
}

fn handle(session: &mut SessionState, line: Value, events: &mut Vec<AgentEvent>) {
    match line.get("type").and_then(Value::as_str) {
        Some("thread.started") => {
            if let Some(id) = new_session_id(session, line.get("thread_id").and_then(Value::as_str)) {
                events.push(AgentEvent::SessionStarted { session_id: Some(id), model: None, cwd: None, tools: Vec::new() });
            }
        }
        Some(kind @ ("item.started" | "item.updated" | "item.completed")) => {
            if let Some(state) = session.ext_mut::<CodexState>() {
                item_events(state, &line["item"], kind == "item.completed", events);
            }
        }
        Some("turn.completed") => {
            let usage = &line["usage"];
            // OpenAI counts cached input inside `input_tokens`.
            let cached = u64_at(usage, "/cached_input_tokens");
            add_tokens(
                &mut session.usage,
                u64_at(usage, "/input_tokens").saturating_sub(cached),
                u64_at(usage, "/output_tokens"),
                cached,
                u64_at(usage, "/cache_write_input_tokens"),
                u64_at(usage, "/reasoning_output_tokens"),
            );
            events.push(AgentEvent::Usage { usage: session.usage.clone() });
            let result = session.ext_mut::<CodexState>().and_then(|state| state.last_message.take());
            events.push(turn_completed(session, result, false, None));
        }
        Some("turn.failed") => {
            let message = str_at(&line, "/error/message").unwrap_or("the turn failed").to_owned();
            events.push(AgentEvent::Error { message: message.clone() });
            events.push(turn_completed(session, Some(message), true, None));
        }
        Some("error") => events.push(AgentEvent::Error { message: str_at(&line, "/message").unwrap_or("error").to_owned() }),
        Some("turn.started") => {}
        _ => events.push(AgentEvent::Raw { text: line.to_string() }),
    }
}

impl CliAdapter for CodexAdapter {
    fn info(&self) -> &AdapterInfo {
        &INFO
    }

    fn detect(&self, probe: &dyn Probe) -> Option<DetectedCli> {
        let (path, version) = detect_version(probe, BINARY)?;
        let auth = match probe.run(&path, &["login", "status"], AUTH_TIMEOUT).map(|output| output.status) {
            Some(Some(0)) => CliAuthStatus::Ok,
            Some(Some(_)) => CliAuthStatus::Unauthenticated,
            _ => CliAuthStatus::Unknown,
        };
        Some(DetectedCli { path, version: Some(version), auth })
    }

    fn start(&self, spec: &RunSpec) -> Result<(LaunchPlan, SessionState), AdapterError> {
        require_native_driver(spec, INFO.name)?;
        let prompt = full_prompt(spec);
        if spec.mode == RunMode::Pty {
            let mut files = Vec::new();
            let mut args = sandbox_args(spec);
            if let Some(model) = &spec.model {
                args.extend(["-m".to_owned(), model.clone()]);
            }
            args.push(prompt_argument(spec, &prompt, "prompt.md", &mut files));
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
            return Ok((plan, SessionState::new(spec.run_id, RunMode::Pty)));
        }

        let relaunch = Relaunch::new(spec, exec_base_args(spec));
        let mut turn_args = Vec::new();
        let mut files = Vec::new();
        if let Some(schema) = &spec.output_schema {
            let path = super::support::context_dir(&spec.cwd).join("output-schema.json");
            files.push((path.clone(), schema.to_string().into_bytes()));
            turn_args.extend(["--output-schema".to_owned(), path.display().to_string()]);
        }
        match &spec.resume_session_id {
            Some(id) => turn_args.extend(["resume".to_owned(), id.clone(), "-".to_owned()]),
            None => turn_args.push("-".to_owned()),
        }
        let plan = relaunch.plan(turn_args, prompt.into_bytes(), files);
        let mut session = SessionState::new(spec.run_id, RunMode::Structured).with_ext(CodexState { relaunch, started: Vec::new(), last_message: None });
        session.session_id.clone_from(&spec.resume_session_id);
        Ok((plan, session))
    }

    fn send_input(&self, session: &mut SessionState, input: AgentInput) -> Result<Vec<IoAction>, AdapterError> {
        if session.mode == RunMode::Pty {
            return pty_input(input);
        }
        Ok(vec![match input {
            AgentInput::Text { text } => {
                let Some(thread) = session.session_id.clone() else {
                    return Ok(vec![IoAction::Unsupported("Codex has not reported its thread id yet; try again in a moment".to_owned())]);
                };
                let Some(state) = session.ext_mut::<CodexState>() else {
                    return Err(AdapterError::Other("Codex session state is missing".to_owned()));
                };
                state.relaunch.turns += 1;
                let plan = state.relaunch.plan(vec!["resume".to_owned(), thread, "-".to_owned()], text.into_bytes(), Vec::new());
                session.turn_completed = false;
                IoAction::Respawn(Box::new(plan))
            }
            AgentInput::Interrupt => IoAction::Signal(crate::Sig::Interrupt),
            AgentInput::Permission { .. } => IoAction::Unsupported(
                "codex exec never asks for approval; the persona's sandbox mode decides what it may do".to_owned(),
            ),
            AgentInput::Keys { .. } => IoAction::Unsupported(KEYS_NEED_PTY.to_owned()),
        }])
    }

    fn stop(&self, _session: &mut SessionState, mode: StopMode) -> Vec<StopStep> {
        default_stop_steps(mode)
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
