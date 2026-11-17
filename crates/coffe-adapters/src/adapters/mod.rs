//! One module per CLI. Each exposes a unit struct implementing [`crate::CliAdapter`].

use std::path::PathBuf;
use std::sync::Arc;

use crate::{AdapterError, AgentEvent, RunDriver, RunMode, RunSpec, SessionState, SharedAdapter};

pub mod claude_code;
pub mod fake;

pub use claude_code::ClaudeCodeAdapter;
pub use fake::FakeAdapter;

/// `cli_id` of the fake CLI fixture (tests and demos only).
pub const FAKE_ID: &str = "fake";

/// Every built-in adapter, in display order.
pub fn all() -> Vec<SharedAdapter> {
    vec![Arc::new(ClaudeCodeAdapter), Arc::new(FakeAdapter)]
}

/// File name (inside `<worktree>/.coffe/context/`) of the combined context that adapters hand to
/// the CLI as system prompt / instructions.
const SYSTEM_PROMPT_FILE: &str = "system-prompt.md";

/// Explanation attached to raw keystrokes sent to a structured session.
const KEYS_NEED_PTY: &str = "raw keystrokes are only available in PTY mode";

/// Rejects the ACP driver for CLIs that only have their native stream.
fn require_native_driver(spec: &RunSpec, cli_name: &str) -> Result<(), AdapterError> {
    if spec.mode == RunMode::Structured && spec.driver == RunDriver::Acp {
        return Err(AdapterError::Unsupported(format!("ACP driver not available for {cli_name}")));
    }
    Ok(())
}

/// The combined-context file to write before spawning: its absolute path, the same path as a
/// command-line argument, and the content. `None` when the run has no context.
fn system_prompt_file(spec: &RunSpec) -> Result<Option<(PathBuf, String, Vec<u8>)>, AdapterError> {
    let markdown = &spec.context.combined_markdown;
    if markdown.trim().is_empty() {
        return Ok(None);
    }
    let path = spec.cwd.join(".coffe").join("context").join(SYSTEM_PROMPT_FILE);
    let argument = path
        .to_str()
        .ok_or_else(|| AdapterError::InvalidSpec("worktree path is not valid UTF-8".to_owned()))?
        .to_owned();
    Ok(Some((path, argument, markdown.clone().into_bytes())))
}

/// One protocol message as a line for the CLI's stdin.
fn json_line(message: &serde_json::Value) -> Vec<u8> {
    let mut line = message.to_string().into_bytes();
    line.push(b'\n');
    line
}

/// stderr carries diagnostics only: every non-empty line becomes a `Raw` event.
fn stderr_events(session: &mut SessionState, chunk: &[u8]) -> Vec<AgentEvent> {
    session
        .stderr_lines
        .push(chunk)
        .into_iter()
        .filter(|line| !line.trim().is_empty())
        .map(|text| AgentEvent::Raw { text })
        .collect()
}
