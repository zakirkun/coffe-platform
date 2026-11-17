//! Claude Code adapter (`claude`).
//!
//! Structured driver: `claude -p --input-format stream-json --output-format stream-json
//! --verbose --include-partial-messages`, the Agent SDK wire format over stdio. User messages and
//! control requests are JSON lines on stdin, SDK messages are JSON lines on stdout. The process
//! stays alive between turns and exits when stdin closes.
//!
//! PTY driver: the interactive `claude` TUI with the prompt as positional argument. Its screen is
//! forwarded verbatim by the supervisor and not parsed, so usage is unavailable in that mode.
//!
//! Written against <https://code.claude.com/docs/en/headless>, the CLI reference, the Agent SDK
//! message reference and its cost-tracking guide; flags checked with `claude --help` 2.1.325.
//!
//! Limitation L5 (architecture Appendix A.3): the CLI reference documents no way to answer
//! permission prompts over stdio. Permissions are therefore decided up front through the
//! permission mode and allow/deny rules, and `AgentInput::Permission` is reported as unsupported.

use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;

use coffe_protocol::MessageRole;
use serde_json::{Value, json};

use super::{KEYS_NEED_PTY, json_line, require_native_driver, stderr_events, system_prompt_file};
use crate::{
    AdapterError, AdapterInfo, AgentEvent, AgentInput, CliAdapter, CliAuthStatus, CliCapabilities,
    DetectedCli, Injection, IoAction, IoMode, LaunchPlan, PermissionMode, PermissionPolicy, Probe,
    RunMode, RunSpec, SessionState, StopMode, StopStep, StreamKind, ToolKind, Usage, WireProtocol,
    default_stop_steps, pty_input,
};

/// `cli_id` of this adapter.
pub const ID: &str = "claude-code";
const BINARY: &str = "claude";
/// `claude --version` prints `2.1.325 (Claude Code)`.
const VERSION_MARKER: &str = "Claude Code";
/// First release with the `claude auth status` subcommand. Older builds would read the words
/// as a prompt, so they are never probed for authentication.
const AUTH_STATUS_SINCE: (u64, u64, u64) = (2, 1, 41);
const VERSION_TIMEOUT: Duration = Duration::from_secs(10);
const AUTH_TIMEOUT: Duration = Duration::from_secs(15);
/// How long the CLI gets to finish and exit after its stdin was closed.
const CLOSE_STDIN_WAIT: Duration = Duration::from_secs(5);
const CTRL_C: u8 = 0x03;

const STREAM_ARGS: [&str; 7] = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
];
/// Tools a read-only persona may always use.
const READ_TOOLS: [&str; 3] = ["Read", "Glob", "Grep"];
/// Tools removed from a read-only persona (a deny rule also overrides allow rules from the
/// machine's own Claude settings).
const EDIT_TOOLS: [&str; 3] = ["Edit", "Write", "NotebookEdit"];
/// Tools denied when the persona has no network access.
const NETWORK_TOOLS: [&str; 2] = ["WebFetch", "WebSearch"];
/// Agents never push; the runner pushes after approval (architecture §7.6).
const NO_PUSH_RULE: &str = "Bash(git push:*)";

/// Message types that only report liveness or UI hints.
const SILENT_TYPES: [&str; 6] = [
    "tool_progress",
    "tool_use_summary",
    "auth_status",
    "rate_limit_event",
    "prompt_suggestion",
    "keep_alive",
];
/// Tool input fields that describe a call best, in order of preference.
const TITLE_KEYS: [&str; 6] = ["command", "file_path", "pattern", "notebook_path", "url", "query"];
const TITLE_CHARS: usize = 200;

static INFO: LazyLock<AdapterInfo> = LazyLock::new(|| AdapterInfo {
    id: ID,
    name: "Claude Code",
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
        schema_output: true,
        modes: vec![RunMode::Structured, RunMode::Pty],
    },
    injection: Injection::SystemPromptFlag,
    wire: WireProtocol::JsonLines,
    docs_url: "https://code.claude.com/docs/en/headless",
    tested_versions: "2.1.325",
});

/// The `claude-code` adapter.
#[derive(Debug, Clone, Copy, Default)]
pub struct ClaudeCodeAdapter;

/// Parser state kept in `SessionState::ext`.
#[derive(Debug, Default)]
struct ClaudeState {
    /// Control requests sent so far (request ids are `coffe-<n>`).
    control_requests: u64,
    /// Session id and model of the last announced `system/init`. The CLI repeats the message at
    /// the start of every turn.
    announced: Option<(Option<String>, Option<String>)>,
    /// Sums of the per-turn `duration_ms` and `num_turns` of all results.
    duration_ms: u64,
    num_turns: u32,
}

fn state_mut(session: &mut SessionState) -> &mut ClaudeState {
    if !session.ext.is::<ClaudeState>() {
        session.ext = Box::new(ClaudeState::default());
    }
    match session.ext.downcast_mut::<ClaudeState>() {
        Some(state) => state,
        None => unreachable!("the extension was just set to ClaudeState"),
    }
}

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn count(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/// `2.1.325 (Claude Code)` → `2.1.325`. `None` when the output is not Claude Code's.
fn parse_version(stdout: &str) -> Option<String> {
    let line = stdout.lines().find(|line| line.contains(VERSION_MARKER))?;
    let version = line.split_whitespace().next()?;
    version.starts_with(|first: char| first.is_ascii_digit()).then(|| version.to_owned())
}

fn version_triple(version: &str) -> Option<(u64, u64, u64)> {
    let mut parts = version.split('.').map(|part| part.parse::<u64>().ok());
    Some((parts.next()??, parts.next()??, parts.next()??))
}

/// `claude auth status` prints JSON and exits 0 when logged in, 1 when not.
fn auth_status(probe: &dyn Probe, program: &Path) -> CliAuthStatus {
    let Some(output) = probe.run(program, &["auth", "status"], AUTH_TIMEOUT) else {
        return CliAuthStatus::Unknown;
    };
    let logged_in = serde_json::from_str::<Value>(output.stdout.trim())
        .ok()
        .and_then(|status| status.get("loggedIn").and_then(Value::as_bool));
    match (logged_in, output.status) {
        (Some(true), _) | (None, Some(0)) => CliAuthStatus::Ok,
        (Some(false), _) | (None, Some(1)) => CliAuthStatus::Unauthenticated,
        (None, _) => CliAuthStatus::Unknown,
    }
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

/// Persona policy → permission flags (architecture Appendix A.2). Tool rules are passed as
/// separate values of the variadic options, exactly as written by the persona.
fn permission_args(policy: &PermissionPolicy, args: &mut Vec<String>) {
    let mut allow: Vec<&str> = Vec::new();
    let mut deny: Vec<&str> = Vec::new();
    let mode = match policy.mode {
        PermissionMode::ReadOnly => {
            allow.extend(READ_TOOLS);
            deny.extend(EDIT_TOOLS);
            "default"
        }
        PermissionMode::WorkspaceWrite => "acceptEdits",
        PermissionMode::FullAuto => "bypassPermissions",
    };
    // `bypassPermissions` already allows everything; deny rules still apply in every mode.
    if policy.mode != PermissionMode::FullAuto {
        allow.extend(policy.allow_tools.iter().map(String::as_str));
    }
    deny.extend(policy.deny_tools.iter().map(String::as_str));
    if !policy.network {
        deny.extend(NETWORK_TOOLS);
    }
    deny.push(NO_PUSH_RULE);

    args.extend(["--permission-mode".to_owned(), mode.to_owned()]);
    for (flag, rules) in [("--allowedTools", allow), ("--disallowedTools", deny)] {
        let mut unique: Vec<&str> = Vec::new();
        for rule in rules.into_iter().map(str::trim).filter(|rule| !rule.is_empty()) {
            if !unique.contains(&rule) {
                unique.push(rule);
            }
        }
        if !unique.is_empty() {
            args.push(flag.to_owned());
            args.extend(unique.into_iter().map(str::to_owned));
        }
    }
}

/// A user turn in the SDK's streaming-input format.
fn user_line(text: &str) -> Vec<u8> {
    json_line(&json!({
        "type": "user",
        "message": { "role": "user", "content": text },
        "parent_tool_use_id": null,
        "session_id": "default",
    }))
}

/// The SDK control request that cancels the running turn and keeps the session.
fn interrupt_line(session: &mut SessionState) -> Vec<u8> {
    let state = state_mut(session);
    state.control_requests += 1;
    json_line(&json!({
        "type": "control_request",
        "request_id": format!("coffe-{}", state.control_requests),
        "request": { "subtype": "interrupt" },
    }))
}

// ---------------------------------------------------------------------------
// stream-json parsing
// ---------------------------------------------------------------------------

fn parse_line(session: &mut SessionState, line: &str, events: &mut Vec<AgentEvent>) {
    if line.trim().is_empty() {
        return;
    }
    let message = match serde_json::from_str::<Value>(line) {
        Ok(message) if message.is_object() => message,
        _ => {
            events.push(AgentEvent::Raw { text: line.to_owned() });
            return;
        }
    };
    match str_field(&message, "type") {
        Some("system") => system_message(session, &message, events),
        Some("stream_event") => events.extend(text_delta(&message)),
        Some("assistant") => assistant_blocks(&message, events),
        Some("user") => tool_results(&message, events),
        Some("result") => turn_result(session, &message, events),
        Some("control_response") => control_response(&message, events),
        Some(kind) if SILENT_TYPES.contains(&kind) => {}
        _ => events.push(AgentEvent::Raw { text: line.to_owned() }),
    }
}

fn system_message(session: &mut SessionState, message: &Value, events: &mut Vec<AgentEvent>) {
    match str_field(message, "subtype") {
        Some("init") => {
            let session_id = str_field(message, "session_id").map(str::to_owned);
            let model = str_field(message, "model").map(str::to_owned);
            if session_id.is_some() {
                session.session_id.clone_from(&session_id);
            }
            let announced = Some((session_id.clone(), model.clone()));
            let state = state_mut(session);
            if state.announced == announced {
                return;
            }
            state.announced = announced;
            let tools: Vec<String> = message
                .get("tools")
                .and_then(Value::as_array)
                .map(|tools| tools.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                .unwrap_or_default();
            events.push(AgentEvent::SessionStarted {
                session_id,
                model,
                cwd: str_field(message, "cwd").map(str::to_owned),
                tools,
            });
        }
        Some("api_retry") => events.push(AgentEvent::Raw { text: retry_note(message) }),
        Some("compact_boundary") => events.push(AgentEvent::Message {
            role: MessageRole::System,
            text: "Conversation compacted".to_owned(),
        }),
        Some("informational") => {
            if let Some(content) = str_field(message, "content").filter(|text| !text.is_empty()) {
                events.push(AgentEvent::Message {
                    role: MessageRole::System,
                    text: content.to_owned(),
                });
            }
        }
        // status, hooks, tasks, plugin installs, permission denials (repeated by the failed
        // tool result): bookkeeping of an open set of subtypes.
        _ => {}
    }
}

/// `API retry 2/10 in 1.5s (overloaded, HTTP 529)`: the request is retried by the CLI, so this is
/// a note and not an error.
fn retry_note(message: &Value) -> String {
    let delay = Duration::from_millis(count(message, "retry_delay_ms")).as_secs_f64();
    let mut cause = str_field(message, "error").unwrap_or("unknown").to_owned();
    if let Some(status) = message.get("error_status").and_then(Value::as_u64) {
        cause.push_str(&format!(", HTTP {status}"));
    }
    format!(
        "API retry {}/{} in {delay:.1}s ({cause})",
        count(message, "attempt"),
        count(message, "max_retries"),
    )
}

/// Partial assistant text: `stream_event` → `content_block_delta` → `text_delta`.
fn text_delta(message: &Value) -> Option<AgentEvent> {
    let event = message.get("event")?;
    let delta = event.get("delta")?;
    if str_field(event, "type") != Some("content_block_delta")
        || str_field(delta, "type") != Some("text_delta")
    {
        return None;
    }
    let text = str_field(delta, "text").filter(|text| !text.is_empty())?;
    Some(AgentEvent::MessageDelta { text: text.to_owned() })
}

fn tool_kind(name: &str) -> ToolKind {
    match name {
        "Read" | "LS" => ToolKind::Read,
        "Glob" | "Grep" => ToolKind::Search,
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => ToolKind::Edit,
        "Bash" | "PowerShell" => ToolKind::Execute,
        "WebFetch" | "WebSearch" => ToolKind::Fetch,
        _ => ToolKind::Other,
    }
}

/// One-line summary of a tool call: its command, file or pattern.
fn tool_title(input: &Value) -> Option<String> {
    let text = TITLE_KEYS.iter().find_map(|key| str_field(input, key))?.trim();
    let first_line = text.lines().next()?;
    let mut title: String = first_line.chars().take(TITLE_CHARS).collect();
    if title.len() < text.len() {
        title.push('…');
    }
    Some(title)
}

/// Content blocks of a complete assistant message.
fn assistant_blocks(message: &Value, events: &mut Vec<AgentEvent>) {
    let Some(blocks) = message.pointer("/message/content").and_then(Value::as_array) else {
        return;
    };
    for block in blocks {
        match str_field(block, "type") {
            Some("text") => {
                if let Some(text) = str_field(block, "text").filter(|text| !text.is_empty()) {
                    events.push(AgentEvent::Message {
                        role: MessageRole::Assistant,
                        text: text.to_owned(),
                    });
                }
            }
            Some("thinking") => {
                if let Some(text) = str_field(block, "thinking").filter(|text| !text.is_empty()) {
                    events.push(AgentEvent::Thinking { text: text.to_owned() });
                }
            }
            Some("tool_use") => {
                let name = str_field(block, "name").unwrap_or("unknown");
                let input = block.get("input").cloned().unwrap_or(Value::Null);
                events.push(AgentEvent::ToolCall {
                    call_id: str_field(block, "id").unwrap_or_default().to_owned(),
                    name: name.to_owned(),
                    tool_kind: tool_kind(name),
                    title: tool_title(&input),
                    input,
                });
            }
            _ => {}
        }
    }
}

/// `tool_result` blocks of a user message. Other user content (subagent prompts, synthetic
/// notices) has no normalized counterpart.
fn tool_results(message: &Value, events: &mut Vec<AgentEvent>) {
    let Some(blocks) = message.pointer("/message/content").and_then(Value::as_array) else {
        return;
    };
    for block in blocks.iter().filter(|block| str_field(block, "type") == Some("tool_result")) {
        let output = match block.get("content") {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Array(parts)) => {
                parts.iter().filter_map(|part| str_field(part, "text")).collect::<Vec<_>>().join("\n")
            }
            _ => String::new(),
        };
        events.push(AgentEvent::ToolResult {
            call_id: str_field(block, "tool_use_id").unwrap_or_default().to_owned(),
            ok: !block.get("is_error").and_then(Value::as_bool).unwrap_or(false),
            output,
        });
    }
}

/// Token counters of a `result` message.
#[derive(Debug, Clone, Copy, Default)]
struct Tokens {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    /// Part of `output`, reported separately by recent CLIs.
    thinking: u64,
}

impl Tokens {
    fn of(usage: &Usage) -> Self {
        Self {
            input: usage.input_tokens,
            output: usage.output_tokens,
            cache_read: usage.cache_read_tokens,
            cache_write: usage.cache_write_tokens,
            thinking: usage.reasoning_tokens,
        }
    }

    fn plus(self, other: Self) -> Self {
        Self {
            input: self.input.saturating_add(other.input),
            output: self.output.saturating_add(other.output),
            cache_read: self.cache_read.saturating_add(other.cache_read),
            cache_write: self.cache_write.saturating_add(other.cache_write),
            thinking: self.thinking.saturating_add(other.thinking),
        }
    }

    fn total(self) -> u64 {
        self.input
            .saturating_add(self.output)
            .saturating_add(self.cache_read)
            .saturating_add(self.cache_write)
    }
}

/// `modelUsage` summed across models: the running totals of the whole process (main loop,
/// subagents, compaction). `None` when the result has no per-model data.
fn model_usage(message: &Value) -> Option<Tokens> {
    let models = message.get("modelUsage")?.as_object()?;
    if models.is_empty() {
        return None;
    }
    Some(models.values().fold(Tokens::default(), |sum, usage| {
        sum.plus(Tokens {
            input: count(usage, "inputTokens"),
            output: count(usage, "outputTokens"),
            cache_read: count(usage, "cacheReadInputTokens"),
            cache_write: count(usage, "cacheCreationInputTokens"),
            thinking: count(usage, "thinkingTokens"),
        })
    }))
}

/// `usage` of a result: the main loop of one turn only.
fn turn_usage(message: &Value) -> Tokens {
    let Some(usage) = message.get("usage") else {
        return Tokens::default();
    };
    Tokens {
        input: count(usage, "input_tokens"),
        output: count(usage, "output_tokens"),
        cache_read: count(usage, "cache_read_input_tokens"),
        cache_write: count(usage, "cache_creation_input_tokens"),
        thinking: 0,
    }
}

/// The only model of `modelUsage`, when there is exactly one.
fn sole_model(message: &Value) -> Option<String> {
    let models = message.get("modelUsage")?.as_object()?;
    if models.len() != 1 {
        return None;
    }
    models.keys().next().cloned()
}

/// Why a result with an error subtype ended the turn.
fn failure_reason(subtype: &str, message: &Value) -> String {
    let reason = match subtype {
        "error_max_turns" => "maximum number of turns reached",
        "error_max_budget_usd" => "budget limit reached",
        "error_during_execution" => "error during execution",
        "error_max_structured_output_retries" => "structured output could not be produced",
        other => other,
    };
    let details = message
        .get("errors")
        .and_then(Value::as_array)
        .map(|errors| errors.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("\n"))
        .filter(|details| !details.is_empty());
    match details {
        Some(details) => format!("{reason}: {details}"),
        None => reason.to_owned(),
    }
}

/// End of a turn: cumulative usage, then the turn result.
fn turn_result(session: &mut SessionState, message: &Value, events: &mut Vec<AgentEvent>) {
    if let Some(session_id) = str_field(message, "session_id") {
        session.session_id = Some(session_id.to_owned());
    }
    let duration_ms = message.get("duration_ms").and_then(Value::as_u64);
    let num_turns = message
        .get("num_turns")
        .and_then(Value::as_u64)
        .and_then(|turns| u32::try_from(turns).ok());

    let state = state_mut(session);
    state.duration_ms = state.duration_ms.saturating_add(duration_ms.unwrap_or(0));
    state.num_turns = state.num_turns.saturating_add(num_turns.unwrap_or(0));
    let (total_duration, total_turns) = (state.duration_ms, state.num_turns);
    let model =
        state.announced.as_ref().and_then(|(_, model)| model.clone()).or_else(|| sole_model(message));

    let known = Tokens::of(&session.usage);
    let tokens = match model_usage(message) {
        // Running totals; a crashing CLI may report zeroes in its last result, which must not
        // erase what earlier results reported.
        Some(running) if running.total() >= known.total() => running,
        Some(_) => known,
        // Without per-model data only `usage` is left, which covers a single turn.
        None => known.plus(turn_usage(message)),
    };
    // `total_cost_usd` is a running total as well and never shrinks within a process.
    let reported_cost = message.get("total_cost_usd").and_then(Value::as_f64);
    let cost_usd = match (reported_cost, session.usage.cost_usd) {
        (Some(reported), Some(previous)) => Some(reported.max(previous)),
        (reported, previous) => reported.or(previous),
    };
    session.usage = Usage {
        available: true,
        input_tokens: tokens.input,
        output_tokens: tokens.output,
        cache_read_tokens: tokens.cache_read,
        cache_write_tokens: tokens.cache_write,
        reasoning_tokens: tokens.thinking,
        cost_usd,
        model,
        duration_ms: Some(total_duration),
        num_turns: Some(total_turns),
        credits: None,
    };
    events.push(AgentEvent::Usage { usage: session.usage.clone() });

    let failure = str_field(message, "subtype")
        .filter(|subtype| *subtype != "success")
        .map(|subtype| failure_reason(subtype, message));
    if let Some(reason) = &failure {
        events.push(AgentEvent::Error { message: reason.clone() });
    }
    let is_error =
        failure.is_some() || message.get("is_error").and_then(Value::as_bool).unwrap_or(false);
    // A schema-constrained answer (`--json-schema`) is the result the caller asked for.
    let result = message
        .get("structured_output")
        .filter(|output| !output.is_null())
        .map(Value::to_string)
        .or_else(|| str_field(message, "result").map(str::to_owned))
        .or(failure);
    session.result_text.clone_from(&result);
    session.turn_completed = true;
    events.push(AgentEvent::TurnCompleted { result, is_error, duration_ms, num_turns });
}

/// Replies to our control requests: an accepted interrupt needs no event (the interrupted turn
/// ends with its own result), a rejected request is reported.
fn control_response(message: &Value, events: &mut Vec<AgentEvent>) {
    let Some(response) = message.get("response") else {
        return;
    };
    if str_field(response, "subtype") == Some("error") {
        let detail = str_field(response, "error").unwrap_or("unknown error");
        events.push(AgentEvent::Error {
            message: format!("Claude Code rejected a control request: {detail}"),
        });
    }
}

impl CliAdapter for ClaudeCodeAdapter {
    fn info(&self) -> &AdapterInfo {
        &INFO
    }

    fn detect(&self, probe: &dyn Probe) -> Option<DetectedCli> {
        let path = probe.which(BINARY)?;
        let output = probe.run(&path, &["--version"], VERSION_TIMEOUT)?;
        let version = parse_version(&output.stdout)?;
        let auth = if version_triple(&version) >= Some(AUTH_STATUS_SINCE) {
            auth_status(probe, &path)
        } else {
            CliAuthStatus::Unknown
        };
        Some(DetectedCli { path, version: Some(version), auth })
    }

    fn start(&self, spec: &RunSpec) -> Result<(LaunchPlan, SessionState), AdapterError> {
        require_native_driver(spec, INFO.name)?;
        let structured = spec.mode == RunMode::Structured;
        if !structured && spec.output_schema.is_some() {
            return Err(AdapterError::Unsupported(
                "a JSON schema for the final answer requires structured mode".to_owned(),
            ));
        }
        let mut session = SessionState::new(spec.run_id, spec.mode).with_ext(ClaudeState::default());
        let mut args: Vec<String> = Vec::new();
        if structured {
            args.extend(STREAM_ARGS.map(String::from));
        }

        match &spec.resume_session_id {
            // `--resume` takes an optional value: an empty or dash-led id would be read as
            // "open the session picker" plus another option.
            Some(id) if id.is_empty() || id.starts_with('-') => {
                return Err(AdapterError::InvalidSpec(format!("invalid session id to resume: {id:?}")));
            }
            Some(id) => args.extend(["--resume".to_owned(), id.clone()]),
            None => args.extend(["--session-id".to_owned(), spec.run_id.to_string()]),
        }
        if !structured {
            // The TUI is not parsed, so the id assigned here is the only one ever known.
            session.session_id =
                Some(spec.resume_session_id.clone().unwrap_or_else(|| spec.run_id.to_string()));
        }
        if let Some(model) = spec.model.as_deref().filter(|model| !model.trim().is_empty()) {
            args.extend(["--model".to_owned(), model.to_owned()]);
        }
        let mut files = Vec::new();
        if let Some((path, argument, content)) = system_prompt_file(spec)? {
            args.extend(["--append-system-prompt-file".to_owned(), argument]);
            files.push((path, content));
        }
        permission_args(&spec.permissions, &mut args);

        let has_prompt = !spec.prompt.trim().is_empty();
        let mut initial_stdin = Vec::new();
        let io = if structured {
            // Print-mode-only limits and output options.
            if let Some(turns) = spec.permissions.max_turns {
                args.extend(["--max-turns".to_owned(), turns.to_string()]);
            }
            if let Some(budget) = spec.permissions.max_budget_usd {
                args.extend(["--max-budget-usd".to_owned(), budget.to_string()]);
            }
            if let Some(schema) = &spec.output_schema {
                args.extend(["--json-schema".to_owned(), schema.to_string()]);
            }
            if has_prompt {
                initial_stdin = user_line(&spec.prompt);
            }
            IoMode::Pipes
        } else {
            if has_prompt {
                // `--` ends option parsing: the variadic tool lists cannot swallow the prompt
                // and a prompt starting with `-` is not read as an option.
                args.extend(["--".to_owned(), spec.prompt.clone()]);
            }
            IoMode::Pty { cols: spec.terminal.cols, rows: spec.terminal.rows }
        };

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
        Ok((plan, session))
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
            AgentInput::Interrupt => IoAction::Write(interrupt_line(session)),
            AgentInput::Permission { .. } => IoAction::Unsupported(
                "Claude Code takes no permission answers over stdio; change the persona's \
                 permission mode or allowed tools instead"
                    .to_owned(),
            ),
            AgentInput::Keys { .. } => IoAction::Unsupported(KEYS_NEED_PTY.to_owned()),
        };
        Ok(vec![action])
    }

    fn stop(&self, session: &mut SessionState, mode: StopMode) -> Vec<StopStep> {
        let interrupt = match (mode, session.mode) {
            (StopMode::InterruptTurn, RunMode::Structured) => interrupt_line(session),
            // In the TUI Ctrl+C cancels the running generation.
            (StopMode::InterruptTurn, RunMode::Pty) => vec![CTRL_C],
            (StopMode::Graceful, RunMode::Structured) => {
                // With stdin closed the CLI finishes the turn and exits; SIGINT then ends a
                // turn that takes too long before the process is terminated.
                let mut steps =
                    vec![StopStep { action: IoAction::CloseStdin, wait: CLOSE_STDIN_WAIT }];
                steps.extend(default_stop_steps(StopMode::Graceful));
                return steps;
            }
            (StopMode::Graceful, RunMode::Pty) | (StopMode::Kill, _) => {
                return default_stop_steps(mode);
            }
        };
        vec![StopStep { action: IoAction::Write(interrupt), wait: Duration::ZERO }]
    }

    fn parse_events(
        &self,
        session: &mut SessionState,
        stream: StreamKind,
        chunk: &[u8],
    ) -> Vec<AgentEvent> {
        match stream {
            StreamKind::Stdout => {
                let mut events = Vec::new();
                for line in session.stdout_lines.push(chunk) {
                    parse_line(session, &line, &mut events);
                }
                events
            }
            StreamKind::Stderr => stderr_events(session, chunk),
            // The supervisor forwards PTY bytes to the terminal verbatim; the TUI redraws its
            // screen and has no line structure to normalize.
            StreamKind::Pty => Vec::new(),
        }
    }

    fn get_usage(&self, session: &SessionState) -> Option<Usage> {
        session.usage.available.then(|| session.usage.clone())
    }
}
