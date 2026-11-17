//! OpenCode adapter (`opencode`).
//!
//! Structured driver: `opencode run --format json --standalone <task>`, one process per turn;
//! follow-ups respawn with `-s <sessionID>`. Events: `step_start`, `text`, `reasoning`,
//! `tool_use`, `step_finish` (tokens and USD cost), `error`. Permission rules (no `git push`, the
//! persona's denies) travel in `OPENCODE_CONFIG_CONTENT`, in the V1 or V2 config shape. ACP
//! driver: `opencode acp`. PTY driver: the TUI with `--prompt`.
//!
//! Written against `opencode run --help` / `opencode --help` 1.19.5 and the V1/V2 docs. L6: V2
//! sometimes drops the last `step_finish`, so the result text is taken from `text` events.

use std::sync::LazyLock;

use coffe_protocol::MessageRole;
use serde_json::{Value, json};

use super::acp_driver;
use super::support::{
    GIT_PUSH, Relaunch, add_tokens, detect_version, full_prompt, major_minor, new_session_id, prompt_argument, str_at,
    tool_kind_of, tool_title, turn_completed, u64_at,
};
use super::{KEYS_NEED_PTY, stderr_events};
use crate::{
    AdapterError, AdapterInfo, AgentEvent, AgentInput, CliAdapter, CliAuthStatus, CliCapabilities, DetectedCli, Injection,
    IoAction, IoMode, LaunchPlan, PermissionMode, Probe, RunDriver, RunMode, RunSpec, SessionState, StopMode, StopStep,
    StreamKind, Usage, WireProtocol, default_stop_steps, pty_input,
};

pub const ID: &str = "opencode";
const BINARY: &str = "opencode";
const CONFIG_ENV: &str = "OPENCODE_CONFIG_CONTENT";

static INFO: LazyLock<AdapterInfo> = LazyLock::new(|| AdapterInfo {
    id: ID,
    name: "OpenCode",
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
    docs_url: "https://opencode.ai/docs/cli/",
    tested_versions: "1.19.5",
});

#[derive(Debug, Clone, Copy, Default)]
pub struct OpenCodeAdapter;

#[derive(Debug)]
struct OpenCodeState {
    relaunch: Relaunch,
}

fn is_v2(spec: &RunSpec) -> bool {
    spec.cli_version.as_deref().and_then(major_minor).is_some_and(|(major, _)| major >= 2)
}

/// `--standalone` keeps every run on its own private server (1.19+ and V2).
fn has_standalone(spec: &RunSpec) -> bool {
    spec.cli_version.as_deref().and_then(major_minor).is_none_or(|version| version >= (1, 19))
}

/// Deny rules as OpenCode configuration: `git push` plus `Bash(prefix…)` persona rules.
fn config_content(spec: &RunSpec) -> String {
    let mut prefixes = vec![format!("{GIT_PUSH} *")];
    for rule in &spec.permissions.deny_tools {
        if let Some(prefix) = rule.trim().strip_prefix("Bash(").and_then(|inner| inner.strip_suffix(')')) {
            prefixes.push(format!("{} *", prefix.trim_end_matches('*').trim_end_matches(':').trim()));
        }
    }
    if is_v2(spec) {
        let rules: Vec<Value> =
            prefixes.iter().map(|prefix| json!({ "action": "shell", "resource": prefix, "effect": "deny" })).collect();
        json!({ "permissions": rules }).to_string()
    } else {
        let bash: serde_json::Map<String, Value> = prefixes.into_iter().map(|prefix| (prefix, json!("deny"))).collect();
        json!({ "permission": { "bash": bash } }).to_string()
    }
}

fn handle(session: &mut SessionState, line: Value, events: &mut Vec<AgentEvent>) {
    if let Some(id) = new_session_id(session, line.get("sessionID").and_then(Value::as_str)) {
        events.push(AgentEvent::SessionStarted { session_id: Some(id), model: None, cwd: None, tools: Vec::new() });
    }
    let part = &line["part"];
    match line.get("type").and_then(Value::as_str) {
        Some("text") => {
            let text = part.get("text").and_then(Value::as_str).unwrap_or_default().to_owned();
            if !text.is_empty() {
                session.result_text = Some(text.clone());
                events.push(AgentEvent::Message { role: MessageRole::Assistant, text });
            }
        }
        Some("reasoning") => {
            if let Some(text) = part.get("text").and_then(Value::as_str).filter(|text| !text.is_empty()) {
                events.push(AgentEvent::Thinking { text: text.to_owned() });
            }
        }
        Some("tool_use") => {
            let name = part.get("tool").and_then(Value::as_str).unwrap_or("tool").to_owned();
            let call_id = part
                .get("callID")
                .or_else(|| part.get("id"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let input = part.pointer("/state/input").cloned().unwrap_or(Value::Null);
            let status = str_at(part, "/state/status").unwrap_or("completed");
            events.push(AgentEvent::ToolCall {
                call_id: call_id.clone(),
                tool_kind: tool_kind_of(&name),
                title: str_at(part, "/state/title").map(str::to_owned).or_else(|| tool_title(&input)),
                name,
                input,
            });
            let output = str_at(part, "/state/output").or_else(|| str_at(part, "/state/error")).unwrap_or_default().to_owned();
            events.push(AgentEvent::ToolResult { call_id, ok: status == "completed", output });
        }
        Some("step_finish") => {
            let tokens = &part["tokens"];
            add_tokens(
                &mut session.usage,
                u64_at(tokens, "/input"),
                u64_at(tokens, "/output"),
                u64_at(tokens, "/cache/read"),
                u64_at(tokens, "/cache/write"),
                u64_at(tokens, "/reasoning"),
            );
            if let Some(cost) = part.get("cost").and_then(Value::as_f64) {
                session.usage.cost_usd = Some(session.usage.cost_usd.unwrap_or(0.0) + cost);
            }
            events.push(AgentEvent::Usage { usage: session.usage.clone() });
            // `tool-calls` steps are followed by more steps; `stop` ends the turn.
            if part.get("reason").and_then(Value::as_str).is_none_or(|reason| reason != "tool-calls") {
                let result = session.result_text.clone();
                events.push(turn_completed(session, result, false, None));
            }
        }
        Some("error") => {
            let message = str_at(&line, "/error/data/message")
                .or_else(|| str_at(&line, "/error/message"))
                .or_else(|| str_at(&line, "/error/name"))
                .unwrap_or("OpenCode reported an error")
                .to_owned();
            events.push(AgentEvent::Error { message: message.clone() });
            events.push(turn_completed(session, Some(message), true, None));
        }
        Some("step_start") => {}
        _ => events.push(AgentEvent::Raw { text: line.to_string() }),
    }
}

impl CliAdapter for OpenCodeAdapter {
    fn info(&self) -> &AdapterInfo {
        &INFO
    }

    fn detect(&self, probe: &dyn Probe) -> Option<DetectedCli> {
        let (path, version) = detect_version(probe, BINARY)?;
        Some(DetectedCli { path, version: Some(version), auth: CliAuthStatus::Unknown })
    }

    fn start(&self, spec: &RunSpec) -> Result<(LaunchPlan, SessionState), AdapterError> {
        let env = vec![(CONFIG_ENV.to_owned(), config_content(spec))];
        if spec.mode == RunMode::Structured && spec.driver == RunDriver::Acp {
            return acp_driver::start(spec, vec!["acp".to_owned()], env);
        }
        let mut base = Vec::new();
        if has_standalone(spec) {
            base.push("--standalone".to_owned());
        }
        match spec.permissions.mode {
            PermissionMode::FullAuto => base.push("--auto".to_owned()),
            PermissionMode::ReadOnly | PermissionMode::WorkspaceWrite => {}
        }
        let mut files = Vec::new();
        let prompt = prompt_argument(spec, &full_prompt(spec), "prompt.md", &mut files);

        if spec.mode == RunMode::Pty {
            base.extend(["--prompt".to_owned(), prompt]);
            if let Some(id) = &spec.resume_session_id {
                base.extend(["-s".to_owned(), id.clone()]);
            }
            let plan = LaunchPlan {
                program: spec.program.clone(),
                args: base,
                env: spec.env.iter().cloned().chain(env).collect(),
                cwd: spec.cwd.clone(),
                io: IoMode::Pty { cols: spec.terminal.cols, rows: spec.terminal.rows },
                initial_stdin: Vec::new(),
                close_stdin: false,
                files,
            };
            return Ok((plan, SessionState::new(spec.run_id, RunMode::Pty)));
        }

        let mut run_args = vec!["run".to_owned(), "--format".to_owned(), "json".to_owned()];
        run_args.append(&mut base);
        if spec.permissions.mode == PermissionMode::ReadOnly {
            run_args.extend(["--agent".to_owned(), "plan".to_owned()]);
        }
        if let Some(model) = spec.model.as_deref().filter(|model| !model.trim().is_empty()) {
            run_args.extend(["-m".to_owned(), model.to_owned()]);
        }
        let mut relaunch = Relaunch::new(spec, run_args);
        relaunch.env.extend(env);
        let mut turn_args = Vec::new();
        if let Some(id) = &spec.resume_session_id {
            turn_args.extend(["-s".to_owned(), id.clone()]);
        }
        turn_args.extend(["--".to_owned(), prompt]);
        let plan = relaunch.plan(turn_args, Vec::new(), files);
        let mut session = SessionState::new(spec.run_id, RunMode::Structured).with_ext(OpenCodeState { relaunch });
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
                    return Ok(vec![IoAction::Unsupported("OpenCode has not reported its session id yet".to_owned())]);
                };
                let Some(state) = session.ext_mut::<OpenCodeState>() else {
                    return Err(AdapterError::Other("OpenCode session state is missing".to_owned()));
                };
                let mut files = Vec::new();
                let prompt = state.relaunch.prompt(text, &mut files);
                let plan = state.relaunch.plan(vec!["-s".to_owned(), id, "--".to_owned(), prompt], Vec::new(), files);
                session.turn_completed = false;
                IoAction::Respawn(Box::new(plan))
            }
            AgentInput::Interrupt => IoAction::Signal(crate::Sig::Interrupt),
            AgentInput::Permission { .. } => IoAction::Unsupported(
                "opencode run answers permission asks itself (rejects, or approves with --auto); use the ACP driver for live answers".to_owned(),
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
        session.usage.available.then(|| session.usage.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deny_rules_use_the_config_shape_of_the_installed_major_version() {
        let mut spec = crate::adapters::tests_support::spec(RunMode::Structured);
        spec.permissions.deny_tools = vec!["Bash(rm:*)".to_owned()];
        spec.cli_version = Some("1.19.5".to_owned());
        let v1: Value = serde_json::from_str(&config_content(&spec)).unwrap();
        assert_eq!(v1["permission"]["bash"]["git push *"], "deny");
        assert_eq!(v1["permission"]["bash"]["rm *"], "deny");

        spec.cli_version = Some("2.3.0".to_owned());
        let v2: Value = serde_json::from_str(&config_content(&spec)).unwrap();
        assert_eq!(v2["permissions"][0], json!({ "action": "shell", "resource": "git push *", "effect": "deny" }));
    }
}
