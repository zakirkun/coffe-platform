//! Kiro CLI adapter (`kiro-cli`).
//!
//! Structured driver: `kiro-cli chat --v3 --no-interactive --output-format stream-json <task>`,
//! one process per turn; follow-ups respawn with `--resume-id <session>`. The stream wraps ACP
//! `session/update` objects (`runStarted`, `sessionUpdate`, `runFinished`), mapped by the shared
//! ACP update mapper. ACP driver: `kiro-cli acp --agent-engine v3`. PTY driver: `kiro-cli chat`.
//!
//! L3: Kiro meters credits, not tokens; the stream-json record schema is not published (shape
//! from a third-party capture), and headless defaults to the V2 engine unless `--v3` is passed.
//! Not installed on the reference machine (L12).

use std::sync::LazyLock;

use coffe_protocol::MessageRole;
use serde_json::Value;

use super::acp_driver;
use super::support::{Relaunch, auth_from_env, context_dir, detect_version, full_prompt, new_session_id, str_at, turn_completed};
use super::{KEYS_NEED_PTY, stderr_events};
use crate::acp::SessionUpdateMapper;
use crate::{
    AdapterError, AdapterInfo, AgentEvent, AgentInput, CliAdapter, CliCapabilities, DetectedCli, Injection, IoAction, IoMode,
    LaunchPlan, PermissionMode, Probe, RunDriver, RunMode, RunSpec, SessionState, Sig, StopMode, StopStep, StreamKind, Usage,
    WireProtocol, default_stop_steps, pty_input,
};

pub const ID: &str = "kiro";
const BINARY: &str = "kiro-cli";
/// Tools a headless run may use without asking, per permission mode (V2 names, 3.3.0+).
const READ_TOOLS: &str = "fs_read,grep,glob";
const WRITE_TOOLS: &str = "fs_read,grep,glob,fs_write,execute_bash";

static INFO: LazyLock<AdapterInfo> = LazyLock::new(|| AdapterInfo {
    id: ID,
    name: "Kiro CLI",
    binaries: &[BINARY],
    capabilities: CliCapabilities {
        headless: true,
        structured_output: true,
        streaming_input: false,
        resume: true,
        usage_tokens: false,
        usage_cost: false,
        permission_callbacks: true,
        model_select: true,
        tool_filters: true,
        schema_output: false,
        modes: vec![RunMode::Structured, RunMode::Pty],
    },
    injection: Injection::PromptPreamble,
    wire: WireProtocol::JsonLines,
    docs_url: "https://kiro.dev/docs/cli/headless/",
    tested_versions: "3.3.0 (documentation)",
});

#[derive(Debug, Clone, Copy, Default)]
pub struct KiroAdapter;

#[derive(Debug)]
struct KiroState {
    relaunch: Relaunch,
    updates: SessionUpdateMapper,
}

fn trust_args(mode: PermissionMode) -> Vec<String> {
    match mode {
        PermissionMode::ReadOnly => vec![format!("--trust-tools={READ_TOOLS}")],
        PermissionMode::WorkspaceWrite => vec![format!("--trust-tools={WRITE_TOOLS}")],
        PermissionMode::FullAuto => vec!["--trust-all-tools".to_owned()],
    }
}

/// Credits of a turn summary (`_meta.kiro.kind == "turn_completion"`), when the update has any.
fn credits(update: &Value) -> Option<f64> {
    let meta = update.pointer("/_meta/kiro")?;
    if meta.get("kind").and_then(Value::as_str) != Some("turn_completion") {
        return None;
    }
    let summaries = meta.get("promptTurnSummaries").and_then(Value::as_array)?;
    let total: f64 = summaries
        .iter()
        .filter_map(|summary| summary.get("credits").or_else(|| summary.get("creditsUsed")).and_then(Value::as_f64))
        .sum();
    (total > 0.0).then_some(total)
}

fn handle(session: &mut SessionState, line: Value, events: &mut Vec<AgentEvent>) {
    let data = &line["data"];
    match line.get("type").and_then(Value::as_str) {
        Some("runStarted") => {}
        Some("sessionUpdate") => {
            if let Some(id) = new_session_id(session, data.get("sessionId").and_then(Value::as_str)) {
                events.push(AgentEvent::SessionStarted { session_id: Some(id), model: None, cwd: None, tools: Vec::new() });
            }
            let update = &data["update"];
            if let Some(amount) = credits(update) {
                session.usage.credits = Some(session.usage.credits.unwrap_or(0.0) + amount);
                events.push(AgentEvent::Usage { usage: session.usage.clone() });
            }
            if let Some(state) = session.ext_mut::<KiroState>() {
                events.extend(state.updates.map(update));
            }
        }
        Some("runFinished") => {
            if let Some(id) = new_session_id(session, data.get("sessionId").and_then(Value::as_str)) {
                events.push(AgentEvent::SessionStarted { session_id: Some(id), model: None, cwd: None, tools: Vec::new() });
            }
            let streamed = session.ext_mut::<KiroState>().map(|state| std::mem::take(&mut state.updates.turn_text)).unwrap_or_default();
            let text = data.get("finalText").and_then(Value::as_str).map(str::to_owned).unwrap_or(streamed);
            if !text.is_empty() {
                events.push(AgentEvent::Message { role: MessageRole::Assistant, text: text.clone() });
            }
            let failed = data.get("status").and_then(Value::as_str).is_some_and(|status| status != "success");
            if failed {
                let reason = data.get("stopReason").and_then(Value::as_str).unwrap_or("failed");
                events.push(AgentEvent::Error { message: format!("Kiro run ended: {reason}") });
            }
            events.push(turn_completed(session, (!text.is_empty()).then_some(text), failed, None));
        }
        Some("error") => {
            events.push(AgentEvent::Error { message: str_at(&line, "/data/message").or_else(|| str_at(&line, "/message")).unwrap_or("error").to_owned() })
        }
        _ => events.push(AgentEvent::Raw { text: line.to_string() }),
    }
}

impl CliAdapter for KiroAdapter {
    fn info(&self) -> &AdapterInfo {
        &INFO
    }

    fn detect(&self, probe: &dyn Probe) -> Option<DetectedCli> {
        let (path, version) = detect_version(probe, BINARY)?;
        Some(DetectedCli { path, version: Some(version), auth: auth_from_env(probe, &["KIRO_API_KEY"]) })
    }

    fn start(&self, spec: &RunSpec) -> Result<(LaunchPlan, SessionState), AdapterError> {
        let env = vec![("KIRO_NO_AUTO_UPDATE".to_owned(), "1".to_owned())];
        let mut model_args = Vec::new();
        if let Some(model) = spec.model.as_deref().filter(|model| !model.trim().is_empty()) {
            model_args.extend(["--model".to_owned(), model.to_owned()]);
        }
        if spec.mode == RunMode::Structured && spec.driver == RunDriver::Acp {
            return acp_driver::start(spec, vec!["acp".to_owned(), "--agent-engine".to_owned(), "v3".to_owned()], env);
        }
        let prompt_path = context_dir(&spec.cwd).join("prompt.md");
        let files = vec![(prompt_path, full_prompt(spec).into_bytes())];
        let pointer = "Read `.coffe/context/prompt.md` completely and do what it says.".to_owned();

        if spec.mode == RunMode::Pty {
            let mut args = vec!["chat".to_owned(), "--v3".to_owned()];
            args.extend(trust_args(spec.permissions.mode));
            args.extend(model_args);
            args.push(pointer);
            let plan = LaunchPlan {
                program: spec.program.clone(),
                args,
                env: spec.env.iter().cloned().chain(env).collect(),
                cwd: spec.cwd.clone(),
                io: IoMode::Pty { cols: spec.terminal.cols, rows: spec.terminal.rows },
                initial_stdin: Vec::new(),
                close_stdin: false,
                files,
            };
            return Ok((plan, SessionState::new(spec.run_id, RunMode::Pty)));
        }

        let mut base = vec![
            "chat".to_owned(),
            "--v3".to_owned(),
            "--no-interactive".to_owned(),
            "--output-format".to_owned(),
            "stream-json".to_owned(),
        ];
        base.extend(trust_args(spec.permissions.mode));
        base.extend(model_args);
        let mut relaunch = Relaunch::new(spec, base);
        relaunch.env.extend(env);
        let mut turn_args = Vec::new();
        if let Some(id) = &spec.resume_session_id {
            turn_args.extend(["--resume-id".to_owned(), id.clone()]);
        }
        turn_args.push(pointer);
        let plan = relaunch.plan(turn_args, Vec::new(), files);
        let mut session = SessionState::new(spec.run_id, RunMode::Structured)
            .with_ext(KiroState { relaunch, updates: SessionUpdateMapper::default() });
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
                    return Ok(vec![IoAction::Unsupported("Kiro has not reported its session id yet".to_owned())]);
                };
                let Some(state) = session.ext_mut::<KiroState>() else {
                    return Err(AdapterError::Other("Kiro session state is missing".to_owned()));
                };
                let mut files = Vec::new();
                let prompt = state.relaunch.prompt(text, &mut files);
                let plan = state.relaunch.plan(vec!["--resume-id".to_owned(), id, prompt], Vec::new(), files);
                session.turn_completed = false;
                IoAction::Respawn(Box::new(plan))
            }
            AgentInput::Interrupt => IoAction::Signal(Sig::Interrupt),
            AgentInput::Permission { .. } => IoAction::Unsupported(
                "headless Kiro denies untrusted tools; trust them in the persona or use the ACP driver".to_owned(),
            ),
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
        session.usage.credits.is_some().then(|| session.usage.clone())
    }
}
