//! Adapter for `coffe-fake-cli`, the deterministic fixture used by tests and demos.
//!
//! Structured driver: `coffe-fake-cli run --output-format jsonl --input-format jsonl`, one JSON
//! object per line in both directions (the process stays alive between turns and exits when
//! stdin closes). PTY driver: `coffe-fake-cli interactive`, a line-oriented prompt.

use std::path::PathBuf;
use std::sync::LazyLock;
use std::time::Duration;

use coffe_protocol::MessageRole;
use serde::Deserialize;
use serde_json::{Value, json};

use super::{FAKE_ID, KEYS_NEED_PTY, json_line, require_native_driver, stderr_events, system_prompt_file};
use crate::{
    AdapterError, AdapterInfo, AgentEvent, AgentInput, CliAdapter, CliAuthStatus, CliCapabilities,
    DetectedCli, Injection, IoAction, IoMode, LaunchPlan, Probe, RunMode, RunSpec, SessionState,
    StopMode, StopStep, StreamKind, ToolKind, Usage, WireProtocol, default_stop_steps, pty_input,
};

const BINARY: &str = "coffe-fake-cli";
/// Overrides the binary lookup with an explicit path (tests run the freshly built fixture).
pub const PATH_ENV: &str = "COFFE_FAKE_CLI";
/// Scenario selector; when present in `RunSpec::env` it is also passed as `--scenario`.
pub const SCENARIO_ENV: &str = "COFFE_FAKE_SCENARIO";
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long the CLI gets to exit after its stdin was closed.
const CLOSE_STDIN_WAIT: Duration = Duration::from_secs(2);

static INFO: LazyLock<AdapterInfo> = LazyLock::new(|| AdapterInfo {
    id: FAKE_ID,
    name: "Fake CLI",
    binaries: &[BINARY],
    capabilities: CliCapabilities {
        headless: true,
        structured_output: true,
        streaming_input: true,
        resume: true,
        usage_tokens: true,
        usage_cost: true,
        permission_callbacks: true,
        model_select: true,
        tool_filters: false,
        schema_output: false,
        modes: vec![RunMode::Structured, RunMode::Pty],
    },
    injection: Injection::InstructionsFile,
    wire: WireProtocol::JsonLines,
    docs_url: "docs/architecture.md#106-fake-cli-fixture",
    tested_versions: "0.1.0",
});

/// The `fake` adapter.
#[derive(Debug, Clone, Copy, Default)]
pub struct FakeAdapter;

/// One stdout line of `coffe-fake-cli run`.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Line {
    Init {
        session_id: String,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        cwd: Option<String>,
    },
    Delta {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        #[serde(default)]
        input: Value,
    },
    ToolResult {
        id: String,
        ok: bool,
        #[serde(default)]
        output: String,
    },
    Message {
        text: String,
    },
    PermissionRequest {
        id: String,
        tool: String,
        #[serde(default)]
        description: String,
    },
    /// Usage of one turn.
    Usage {
        #[serde(default)]
        input_tokens: u64,
        #[serde(default)]
        output_tokens: u64,
        #[serde(default)]
        cache_read_tokens: u64,
        #[serde(default)]
        cost_usd: Option<f64>,
    },
    Result {
        ok: bool,
        #[serde(default)]
        text: String,
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        duration_ms: Option<u64>,
        /// Turns completed by the process so far.
        #[serde(default)]
        num_turns: Option<u32>,
    },
    Error {
        message: String,
    },
}

fn tool_kind(name: &str) -> ToolKind {
    match name {
        "read_file" => ToolKind::Read,
        "write_file" | "edit_file" => ToolKind::Edit,
        "run_command" => ToolKind::Execute,
        "search" => ToolKind::Search,
        "fetch" => ToolKind::Fetch,
        _ => ToolKind::Other,
    }
}

/// Normalizes one stdout line. Lines that are not fake-CLI events are passed through as `Raw`.
fn parse_line(session: &mut SessionState, line: &str) -> Option<AgentEvent> {
    if line.trim().is_empty() {
        return None;
    }
    let Ok(parsed) = serde_json::from_str::<Line>(line) else {
        return Some(AgentEvent::Raw { text: line.to_owned() });
    };
    Some(match parsed {
        Line::Init { session_id, model, cwd } => {
            session.session_id = Some(session_id.clone());
            session.usage.model.clone_from(&model);
            AgentEvent::SessionStarted { session_id: Some(session_id), model, cwd, tools: Vec::new() }
        }
        Line::Delta { text } => AgentEvent::MessageDelta { text },
        Line::ToolUse { id, name, input } => AgentEvent::ToolCall {
            tool_kind: tool_kind(&name),
            title: input.get("path").and_then(Value::as_str).map(str::to_owned),
            call_id: id,
            name,
            input,
        },
        Line::ToolResult { id, ok, output } => AgentEvent::ToolResult { call_id: id, ok, output },
        Line::Message { text } => AgentEvent::Message { role: MessageRole::Assistant, text },
        Line::PermissionRequest { id, tool, description } => AgentEvent::PermissionRequest {
            request_id: id,
            tool,
            description,
            options: vec!["allow".to_owned(), "deny".to_owned()],
        },
        Line::Usage { input_tokens, output_tokens, cache_read_tokens, cost_usd } => {
            let usage = &mut session.usage;
            usage.available = true;
            usage.input_tokens += input_tokens;
            usage.output_tokens += output_tokens;
            usage.cache_read_tokens += cache_read_tokens;
            if let Some(cost) = cost_usd {
                usage.cost_usd = Some(usage.cost_usd.unwrap_or(0.0) + cost);
            }
            AgentEvent::Usage { usage: usage.clone() }
        }
        Line::Result { ok, text, session_id, duration_ms, num_turns } => {
            if session_id.is_some() {
                session.session_id = session_id;
            }
            if let Some(duration) = duration_ms {
                session.usage.duration_ms = Some(session.usage.duration_ms.unwrap_or(0) + duration);
            }
            if num_turns.is_some() {
                session.usage.num_turns = num_turns;
            }
            session.result_text = Some(text.clone());
            session.turn_completed = true;
            AgentEvent::TurnCompleted { result: Some(text), is_error: !ok, duration_ms, num_turns }
        }
        Line::Error { message } => AgentEvent::Error { message },
    })
}

fn interrupt_line() -> Vec<u8> {
    json_line(&json!({ "type": "interrupt" }))
}

fn user_line(text: &str) -> Vec<u8> {
    json_line(&json!({ "type": "user", "text": text }))
}

/// The prompt as the first line typed into the interactive prompt.
fn typed_prompt(prompt: &str) -> Vec<u8> {
    let line = prompt.lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ");
    if line.is_empty() {
        return Vec::new();
    }
    let mut bytes = line.into_bytes();
    bytes.push(b'\r');
    bytes
}

impl CliAdapter for FakeAdapter {
    fn info(&self) -> &AdapterInfo {
        &INFO
    }

    fn detect(&self, probe: &dyn Probe) -> Option<DetectedCli> {
        let path = probe
            .env(PATH_ENV)
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .or_else(|| probe.which(BINARY))?;
        let output = probe.run(&path, &["--version"], PROBE_TIMEOUT)?;
        // `coffe-fake-cli 0.1.0`; anything else is a different program.
        let version = output.stdout.trim().strip_prefix(BINARY)?.trim().to_owned();
        if output.status != Some(0) || version.is_empty() {
            return None;
        }
        let logged_in = probe
            .run(&path, &["auth", "status"], PROBE_TIMEOUT)
            .and_then(|status| serde_json::from_str::<Value>(status.stdout.trim()).ok())
            .and_then(|status| status.get("logged_in").and_then(Value::as_bool));
        let auth = match logged_in {
            Some(true) => CliAuthStatus::Ok,
            Some(false) => CliAuthStatus::Unauthenticated,
            None => CliAuthStatus::Unknown,
        };
        Some(DetectedCli { path, version: Some(version), auth })
    }

    fn start(&self, spec: &RunSpec) -> Result<(LaunchPlan, SessionState), AdapterError> {
        require_native_driver(spec, INFO.name)?;
        let scenario = spec
            .env
            .iter()
            .find(|(key, value)| key == SCENARIO_ENV && !value.is_empty())
            .map(|(_, value)| value.clone());
        let mut args: Vec<String> = Vec::new();
        let mut files = Vec::new();
        let (io, initial_stdin) = match spec.mode {
            RunMode::Structured => {
                args.extend(
                    ["run", "--output-format", "jsonl", "--input-format", "jsonl"].map(String::from),
                );
                match &spec.resume_session_id {
                    Some(id) => args.extend(["--resume".to_owned(), id.clone()]),
                    None => args.extend(["--session-id".to_owned(), spec.run_id.to_string()]),
                }
                if let Some(model) = &spec.model {
                    args.extend(["--model".to_owned(), model.clone()]);
                }
                if let Some((path, argument, content)) = system_prompt_file(spec)? {
                    args.extend(["--system-prompt-file".to_owned(), argument]);
                    files.push((path, content));
                }
                let first_turn =
                    if spec.prompt.trim().is_empty() { Vec::new() } else { user_line(&spec.prompt) };
                (IoMode::Pipes, first_turn)
            }
            RunMode::Pty => {
                args.push("interactive".to_owned());
                let io = IoMode::Pty { cols: spec.terminal.cols, rows: spec.terminal.rows };
                (io, typed_prompt(&spec.prompt))
            }
        };
        if let Some(scenario) = scenario {
            args.extend(["--scenario".to_owned(), scenario]);
        }
        let plan = LaunchPlan {
            program: spec.program.clone(),
            args,
            env: spec.env.clone(),
            cwd: spec.cwd.clone(),
            io,
            initial_stdin,
            close_stdin: false,
            files,
        };
        Ok((plan, SessionState::new(spec.run_id, spec.mode)))
    }

    fn send_input(
        &self,
        session: &mut SessionState,
        input: AgentInput,
    ) -> Result<Vec<IoAction>, AdapterError> {
        if session.mode == RunMode::Pty {
            return pty_input(input);
        }
        let action = match input {
            AgentInput::Text { text } => {
                session.turn_completed = false;
                IoAction::Write(user_line(&text))
            }
            AgentInput::Permission { request_id, allow, .. } => IoAction::Write(json_line(
                &json!({ "type": "permission", "id": request_id, "allow": allow }),
            )),
            AgentInput::Interrupt => IoAction::Write(interrupt_line()),
            AgentInput::Keys { .. } => IoAction::Unsupported(KEYS_NEED_PTY.to_owned()),
        };
        Ok(vec![action])
    }

    fn stop(&self, session: &mut SessionState, mode: StopMode) -> Vec<StopStep> {
        if session.mode == RunMode::Pty {
            return default_stop_steps(mode);
        }
        match mode {
            StopMode::InterruptTurn => {
                vec![StopStep { action: IoAction::Write(interrupt_line()), wait: Duration::ZERO }]
            }
            StopMode::Graceful => {
                let mut steps =
                    vec![StopStep { action: IoAction::CloseStdin, wait: CLOSE_STDIN_WAIT }];
                steps.extend(default_stop_steps(StopMode::Graceful));
                steps
            }
            StopMode::Kill => default_stop_steps(StopMode::Kill),
        }
    }

    fn parse_events(
        &self,
        session: &mut SessionState,
        stream: StreamKind,
        chunk: &[u8],
    ) -> Vec<AgentEvent> {
        match stream {
            StreamKind::Stdout => {
                let lines = session.stdout_lines.push(chunk);
                lines.iter().filter_map(|line| parse_line(session, line)).collect()
            }
            StreamKind::Stderr => stderr_events(session, chunk),
            // The supervisor forwards PTY bytes to the terminal verbatim; an interactive screen
            // has no event structure to normalize.
            StreamKind::Pty => Vec::new(),
        }
    }

    fn get_usage(&self, session: &SessionState) -> Option<Usage> {
        session.usage.available.then(|| session.usage.clone())
    }
}
