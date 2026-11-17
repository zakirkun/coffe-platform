//! Pieces shared by the adapters of CLIs that run one process per turn, take the task on the
//! command line, or need the COFFE context pointed out in the prompt.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

use crate::{AgentEvent, CliAuthStatus, IoMode, LaunchPlan, Probe, RunSpec, SessionState, ToolKind, Usage};

/// Longest task passed inline as an argument; longer ones go through a file (Windows caps a
/// command line at 32 767 characters, and the context alone can exceed that).
pub(crate) const INLINE_PROMPT_CHARS: usize = 6 * 1024;
pub(crate) const VERSION_TIMEOUT: Duration = Duration::from_secs(10);
/// Rule every adapter adds to its CLI's deny list: agents never push (architecture §7.6).
pub(crate) const GIT_PUSH: &str = "git push";

/// How the CLI is relaunched for a follow-up turn.
#[derive(Debug, Clone)]
pub(crate) struct Relaunch {
    pub program: PathBuf,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    /// Arguments every turn shares (model, permissions, output format).
    pub base_args: Vec<String>,
    /// Turns started so far; names the prompt files of follow-ups.
    pub turns: u32,
}

impl Relaunch {
    pub fn new(spec: &RunSpec, base_args: Vec<String>) -> Self {
        Self { program: spec.program.clone(), cwd: spec.cwd.clone(), env: spec.env.clone(), base_args, turns: 1 }
    }

    /// A one-shot process for the next turn: `base_args` followed by `turn_args`.
    pub fn plan(&self, turn_args: Vec<String>, initial_stdin: Vec<u8>, files: Vec<(PathBuf, Vec<u8>)>) -> LaunchPlan {
        let mut args = self.base_args.clone();
        args.extend(turn_args);
        LaunchPlan {
            program: self.program.clone(),
            args,
            env: self.env.clone(),
            cwd: self.cwd.clone(),
            io: IoMode::Pipes,
            close_stdin: true,
            initial_stdin,
            files,
        }
    }

    /// The text of a follow-up turn as an argument: inline when short, else written to a
    /// numbered file in `.coffe/context/` and replaced by a pointer to it.
    pub fn prompt(&mut self, text: String, files: &mut Vec<(PathBuf, Vec<u8>)>) -> String {
        self.turns += 1;
        if text.chars().count() <= INLINE_PROMPT_CHARS {
            return text;
        }
        let name = format!("prompt-{}.md", self.turns);
        files.push((context_dir(&self.cwd).join(&name), text.into_bytes()));
        format!("Your next task is in `.coffe/context/{name}`. Read it completely, then do what it says.")
    }
}

/// Points the agent at the context files for CLIs that cannot take a system prompt.
pub(crate) fn context_preamble(spec: &RunSpec) -> Option<String> {
    (!spec.context.files.is_empty()).then(|| {
        "Before you start, read every file in `.coffe/context/` in name order: they contain the COFFE \
         rules, the project rules and knowledge, your role and the full task. Follow them.\n\n"
            .to_owned()
    })
}

/// The task with the context pointer in front.
pub(crate) fn full_prompt(spec: &RunSpec) -> String {
    format!("{}{}", context_preamble(spec).unwrap_or_default(), spec.prompt)
}

/// The task as an argument: inline when short; otherwise written to `name` inside
/// `.coffe/context/` and replaced by a pointer to that file.
pub(crate) fn prompt_argument(
    spec: &RunSpec,
    text: &str,
    name: &str,
    files: &mut Vec<(PathBuf, Vec<u8>)>,
) -> String {
    if text.chars().count() <= INLINE_PROMPT_CHARS {
        return text.to_owned();
    }
    let path = context_dir(&spec.cwd).join(name);
    files.push((path, text.as_bytes().to_vec()));
    format!("Your task is in `.coffe/context/{name}`. Read it completely, then do what it says.")
}

pub(crate) fn context_dir(cwd: &Path) -> PathBuf {
    cwd.join(".coffe").join("context")
}

/// `name 1.2.3`, `v1.2.3` or `1.2.3 (Product)` → `1.2.3`: the first token starting with a digit.
pub(crate) fn version_token(text: &str) -> Option<String> {
    text.split_whitespace()
        .map(|token| token.trim_start_matches('v').trim_end_matches([',', ')']))
        .find(|token| token.starts_with(|c: char| c.is_ascii_digit()))
        .map(str::to_owned)
}

/// `(major, minor)` of a version string.
pub(crate) fn major_minor(version: &str) -> Option<(u64, u64)> {
    let mut parts = version.split(['.', '-']).map(|part| part.parse::<u64>().ok());
    Some((parts.next()??, parts.next().flatten().unwrap_or(0)))
}

/// Runs `<binary> --version`; `None` when the binary is missing or prints no version.
pub(crate) fn detect_version(probe: &dyn Probe, binary: &str) -> Option<(PathBuf, String)> {
    let path = probe.which(binary)?;
    let output = probe.run(&path, &["--version"], VERSION_TIMEOUT)?;
    let version = version_token(&output.stdout).or_else(|| version_token(&output.stderr))?;
    Some((path, version))
}

/// `Ok` when one of the variables is set, `Unknown` otherwise (the CLI has no status command).
pub(crate) fn auth_from_env(probe: &dyn Probe, keys: &[&str]) -> CliAuthStatus {
    if keys.iter().any(|key| probe.env(key).is_some_and(|value| !value.trim().is_empty())) {
        CliAuthStatus::Ok
    } else {
        CliAuthStatus::Unknown
    }
}

/// Parses complete stdout lines as JSON objects; anything else becomes a `Raw` event.
pub(crate) fn json_lines(session: &mut SessionState, chunk: &[u8], mut handle: impl FnMut(&mut SessionState, Value, &mut Vec<AgentEvent>)) -> Vec<AgentEvent> {
    let mut events = Vec::new();
    for line in session.stdout_lines.push(chunk) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(trimmed) {
            Ok(value) if value.is_object() => handle(session, value, &mut events),
            _ => events.push(AgentEvent::Raw { text: line }),
        }
    }
    events
}

pub(crate) fn str_at<'a>(value: &'a Value, pointer: &str) -> Option<&'a str> {
    value.pointer(pointer).and_then(Value::as_str)
}

pub(crate) fn u64_at(value: &Value, pointer: &str) -> u64 {
    value.pointer(pointer).and_then(Value::as_u64).unwrap_or(0)
}

/// Tool kind from common tool names across CLIs.
pub(crate) fn tool_kind_of(name: &str) -> ToolKind {
    let name = name.to_ascii_lowercase();
    if ["shell", "bash", "exec", "command", "powershell", "terminal"].iter().any(|word| name.contains(word)) {
        ToolKind::Execute
    } else if ["edit", "write", "replace", "patch", "create", "delete", "move"].iter().any(|word| name.contains(word)) {
        ToolKind::Edit
    } else if ["grep", "glob", "search", "find", "list", "ls"].iter().any(|word| name.contains(word)) {
        ToolKind::Search
    } else if ["fetch", "web", "http", "url"].iter().any(|word| name.contains(word)) {
        ToolKind::Fetch
    } else if name.contains("read") || name.contains("view") || name.contains("cat") {
        ToolKind::Read
    } else {
        ToolKind::Other
    }
}

/// One-line title of a tool call from its input: a command, a path or a pattern.
pub(crate) fn tool_title(input: &Value) -> Option<String> {
    ["command", "cmd", "CommandLine", "file_path", "filePath", "path", "pattern", "query", "url"]
        .iter()
        .find_map(|key| input.get(*key).and_then(Value::as_str))
        .and_then(|text| text.lines().next())
        .map(|line| line.chars().take(200).collect())
}

/// Adds the token counters of one turn or process to the session totals.
pub(crate) fn add_tokens(usage: &mut Usage, input: u64, output: u64, cache_read: u64, cache_write: u64, reasoning: u64) {
    usage.available = true;
    usage.input_tokens = usage.input_tokens.saturating_add(input);
    usage.output_tokens = usage.output_tokens.saturating_add(output);
    usage.cache_read_tokens = usage.cache_read_tokens.saturating_add(cache_read);
    usage.cache_write_tokens = usage.cache_write_tokens.saturating_add(cache_write);
    usage.reasoning_tokens = usage.reasoning_tokens.saturating_add(reasoning);
}

/// Records the end of a turn on the session and returns the event.
pub(crate) fn turn_completed(session: &mut SessionState, result: Option<String>, is_error: bool, duration_ms: Option<u64>) -> AgentEvent {
    session.turn_completed = true;
    if result.is_some() {
        session.result_text.clone_from(&result);
    }
    let turns = session.usage.num_turns.unwrap_or(0).saturating_add(1);
    session.usage.num_turns = Some(turns);
    if let Some(duration) = duration_ms {
        session.usage.duration_ms = Some(session.usage.duration_ms.unwrap_or(0).saturating_add(duration));
    }
    AgentEvent::TurnCompleted { result, is_error, duration_ms, num_turns: Some(turns) }
}

/// The session id the first time it is seen; `None` afterwards.
pub(crate) fn new_session_id(session: &mut SessionState, id: Option<&str>) -> Option<String> {
    let id = id.filter(|id| !id.is_empty())?;
    if session.session_id.as_deref() == Some(id) {
        return None;
    }
    session.session_id = Some(id.to_owned());
    Some(id.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_tokens_ignore_names_and_prefixes() {
        assert_eq!(version_token("codex-cli 0.153.4").as_deref(), Some("0.153.4"));
        assert_eq!(version_token("v1.5.0\n").as_deref(), Some("1.5.0"));
        assert_eq!(version_token("2.1.325 (Claude Code)").as_deref(), Some("2.1.325"));
        assert_eq!(version_token("no version here"), None);
        assert_eq!(major_minor("1.19.5"), Some((1, 19)));
    }

    #[test]
    fn tool_kinds_follow_common_names() {
        assert_eq!(tool_kind_of("run_shell_command"), ToolKind::Execute);
        assert_eq!(tool_kind_of("write_file"), ToolKind::Edit);
        assert_eq!(tool_kind_of("grep_search"), ToolKind::Search);
        assert_eq!(tool_kind_of("read_file"), ToolKind::Read);
        assert_eq!(tool_kind_of("web_fetch"), ToolKind::Fetch);
    }
}
