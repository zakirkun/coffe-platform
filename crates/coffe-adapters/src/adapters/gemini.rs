//! Gemini CLI adapter (`gemini`).
//!
//! Structured driver: `gemini -p <task> -o stream-json`, one process per turn; follow-ups respawn
//! with `-r <session_id>` (limitation L4: no streaming input). `git push` and the persona's deny
//! rules go into a policy file passed with `--policy`. ACP driver: `gemini --acp` (live permission
//! prompts). PTY driver: the TUI with `-i <task>`.
//!
//! Written against the v0.68.0 docs (headless.md, policy-engine.md, acp-mode.md) and
//! `packages/core/src/output/types.ts`. Not installed on the reference machine (L12): the parser
//! is tested against documented shapes only.

use std::fmt::Write as _;
use std::sync::LazyLock;

use coffe_protocol::MessageRole;
use serde_json::Value;

use super::acp_driver;
use super::support::{
    Relaunch, add_tokens, auth_from_env, context_dir, detect_version, full_prompt, new_session_id, prompt_argument, str_at,
    tool_kind_of, tool_title, turn_completed, u64_at, GIT_PUSH,
};
use super::{KEYS_NEED_PTY, stderr_events};
use crate::{
    AdapterError, AdapterInfo, AgentEvent, AgentInput, CliAdapter, CliCapabilities, DetectedCli, Injection, IoAction, IoMode,
    LaunchPlan, PermissionMode, Probe, RunDriver, RunMode, RunSpec, SessionState, StopMode, StopStep, StreamKind, Usage,
    WireProtocol, default_stop_steps, pty_input,
};

pub const ID: &str = "gemini";
const BINARY: &str = "gemini";
const POLICY_FILE: &str = "gemini-policy.toml";

static INFO: LazyLock<AdapterInfo> = LazyLock::new(|| AdapterInfo {
    id: ID,
    name: "Gemini CLI",
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
        tool_filters: true,
        schema_output: false,
        modes: vec![RunMode::Structured, RunMode::Pty],
    },
    injection: Injection::PromptPreamble,
    wire: WireProtocol::JsonLines,
    docs_url: "https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md",
    tested_versions: "0.68.0 (documentation)",
});

#[derive(Debug, Clone, Copy, Default)]
pub struct GeminiAdapter;

#[derive(Debug)]
struct GeminiState {
    relaunch: Relaunch,
    /// Assistant text of the running turn.
    turn_text: String,
}

fn approval_mode(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::ReadOnly => "plan",
        PermissionMode::WorkspaceWrite => "auto_edit",
        PermissionMode::FullAuto => "yolo",
    }
}

/// The policy file: `git push` and every persona deny rule are denied. `Bash(prefix…)` rules
/// become shell command prefixes; other entries are tool names.
fn policy(spec: &RunSpec) -> String {
    let mut rules = vec![("run_shell_command".to_owned(), Some(GIT_PUSH.to_owned()))];
    for rule in &spec.permissions.deny_tools {
        let rule = rule.trim();
        match rule.strip_prefix("Bash(").and_then(|inner| inner.strip_suffix(')')) {
            Some(prefix) => {
                let prefix = prefix.trim_end_matches('*').trim_end_matches(':').trim();
                rules.push(("run_shell_command".to_owned(), Some(prefix.to_owned())));
            }
            None if !rule.is_empty() => rules.push((rule.to_owned(), None)),
            None => {}
        }
    }
    let mut toml = String::from("# Written by COFFE for this run.\n");
    for (tool, prefix) in rules {
        let _ = write!(toml, "\n[[rule]]\ntoolName = {}\n", Value::String(tool));
        if let Some(prefix) = prefix {
            let _ = writeln!(toml, "commandPrefix = {}", Value::String(prefix));
        }
        toml.push_str("decision = \"deny\"\npriority = 900\n");
    }
    toml
}

fn handle(session: &mut SessionState, line: Value, events: &mut Vec<AgentEvent>) {
    match line.get("type").and_then(Value::as_str) {
        Some("init") => {
            let model = line.get("model").and_then(Value::as_str).map(str::to_owned);
            if model.is_some() {
                session.usage.model.clone_from(&model);
            }
            if let Some(id) = new_session_id(session, line.get("session_id").and_then(Value::as_str)) {
                events.push(AgentEvent::SessionStarted { session_id: Some(id), model, cwd: None, tools: Vec::new() });
            }
        }
        Some("message") if line.get("role").and_then(Value::as_str) == Some("assistant") => {
            let text = line.get("content").and_then(Value::as_str).unwrap_or_default().to_owned();
            if text.is_empty() {
                return;
            }
            if let Some(state) = session.ext_mut::<GeminiState>() {
                state.turn_text.push_str(&text);
            }
            events.push(if line.get("delta").and_then(Value::as_bool).unwrap_or(false) {
                AgentEvent::MessageDelta { text }
            } else {
                AgentEvent::Message { role: MessageRole::Assistant, text }
            });
        }
        Some("message") => {}
        Some("tool_use") => {
            let name = line.get("tool_name").and_then(Value::as_str).unwrap_or("tool").to_owned();
            let input = line.get("parameters").cloned().unwrap_or(Value::Null);
            events.push(AgentEvent::ToolCall {
                call_id: line.get("tool_id").and_then(Value::as_str).unwrap_or_default().to_owned(),
                tool_kind: tool_kind_of(&name),
                title: tool_title(&input),
                name,
                input,
            });
        }
        Some("tool_result") => {
            let output = line
                .get("output")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| str_at(&line, "/error/message").map(str::to_owned))
                .unwrap_or_default();
            events.push(AgentEvent::ToolResult {
                call_id: line.get("tool_id").and_then(Value::as_str).unwrap_or_default().to_owned(),
                ok: line.get("status").and_then(Value::as_str) == Some("success"),
                output,
            });
        }
        Some("error") => {
            let message = line.get("message").and_then(Value::as_str).unwrap_or("error").to_owned();
            events.push(if line.get("severity").and_then(Value::as_str) == Some("warning") {
                AgentEvent::Raw { text: message }
            } else {
                AgentEvent::Error { message }
            });
        }
        Some("result") => {
            let stats = &line["stats"];
            let cached = u64_at(stats, "/cached");
            add_tokens(&mut session.usage, u64_at(stats, "/input_tokens").saturating_sub(cached), u64_at(stats, "/output_tokens"), cached, 0, 0);
            events.push(AgentEvent::Usage { usage: session.usage.clone() });
            let text = session.ext_mut::<GeminiState>().map(|state| std::mem::take(&mut state.turn_text)).unwrap_or_default();
            let failed = line.get("status").and_then(Value::as_str) != Some("success");
            let result = if text.is_empty() { str_at(&line, "/error/message").map(str::to_owned) } else { Some(text) };
            let duration = stats.get("duration_ms").and_then(Value::as_u64);
            events.push(turn_completed(session, result, failed, duration));
        }
        _ => events.push(AgentEvent::Raw { text: line.to_string() }),
    }
}

impl CliAdapter for GeminiAdapter {
    fn info(&self) -> &AdapterInfo {
        &INFO
    }

    fn detect(&self, probe: &dyn Probe) -> Option<DetectedCli> {
        let (path, version) = detect_version(probe, BINARY)?;
        // No status command exists; an API key, Vertex settings or cached OAuth credentials mean
        // headless runs can authenticate.
        let mut auth = auth_from_env(probe, &["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI"]);
        if auth != crate::CliAuthStatus::Ok && probe.home_dir().is_some_and(|home| home.join(".gemini").join("oauth_creds.json").is_file()) {
            auth = crate::CliAuthStatus::Ok;
        }
        Some(DetectedCli { path, version: Some(version), auth })
    }

    fn start(&self, spec: &RunSpec) -> Result<(LaunchPlan, SessionState), AdapterError> {
        let env = vec![("GEMINI_CLI_TRUST_WORKSPACE".to_owned(), "true".to_owned())];
        let mut model_args = Vec::new();
        if let Some(model) = spec.model.as_deref().filter(|model| !model.trim().is_empty()) {
            model_args.extend(["-m".to_owned(), model.to_owned()]);
        }
        if spec.mode == RunMode::Structured && spec.driver == RunDriver::Acp {
            let mut args = vec!["--acp".to_owned(), "--approval-mode".to_owned(), approval_mode(spec.permissions.mode).to_owned()];
            args.extend(model_args);
            return acp_driver::start(spec, args, env);
        }

        let policy_path = context_dir(&spec.cwd).join(POLICY_FILE);
        let mut files = vec![(policy_path.clone(), policy(spec).into_bytes())];
        let prompt = prompt_argument(spec, &full_prompt(spec), "prompt.md", &mut files);
        let mut base = vec![
            "--skip-trust".to_owned(),
            "--approval-mode".to_owned(),
            approval_mode(spec.permissions.mode).to_owned(),
            "--policy".to_owned(),
            policy_path.display().to_string(),
        ];
        base.extend(model_args);

        if spec.mode == RunMode::Pty {
            base.extend(["-i".to_owned(), prompt]);
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

        base.extend(["-o".to_owned(), "stream-json".to_owned()]);
        let mut relaunch = Relaunch::new(spec, base);
        relaunch.env.extend(env);
        let session_args = match &spec.resume_session_id {
            Some(id) => vec!["-r".to_owned(), id.clone()],
            None => vec!["--session-id".to_owned(), spec.run_id.to_string()],
        };
        let mut turn_args = session_args;
        turn_args.extend(["-p".to_owned(), prompt]);
        let plan = relaunch.plan(turn_args, Vec::new(), files);
        let mut session = SessionState::new(spec.run_id, RunMode::Structured).with_ext(GeminiState { relaunch, turn_text: String::new() });
        session.session_id = Some(spec.resume_session_id.clone().unwrap_or_else(|| spec.run_id.to_string()));
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
                    return Ok(vec![IoAction::Unsupported("Gemini has not reported its session id yet".to_owned())]);
                };
                let Some(state) = session.ext_mut::<GeminiState>() else {
                    return Err(AdapterError::Other("Gemini session state is missing".to_owned()));
                };
                let mut files = Vec::new();
                let prompt = state.relaunch.prompt(text, &mut files);
                let plan = state.relaunch.plan(vec!["-r".to_owned(), id, "-p".to_owned(), prompt], Vec::new(), files);
                session.turn_completed = false;
                IoAction::Respawn(Box::new(plan))
            }
            AgentInput::Interrupt => IoAction::Signal(crate::Sig::Interrupt),
            AgentInput::Permission { .. } => IoAction::Unsupported(
                "headless Gemini denies approval prompts; use the ACP driver for live permission answers".to_owned(),
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
    fn policy_denies_push_and_translates_shell_rules() {
        let mut spec = crate::adapters::tests_support::spec(RunMode::Structured);
        spec.permissions.deny_tools = vec!["Bash(rm -rf:*)".to_owned(), "web_fetch".to_owned()];
        let toml = policy(&spec);
        assert!(toml.contains("commandPrefix = \"git push\""));
        assert!(toml.contains("commandPrefix = \"rm -rf\""));
        assert!(toml.contains("toolName = \"web_fetch\""));
        assert_eq!(toml.matches("decision = \"deny\"").count(), 3);
    }
}
