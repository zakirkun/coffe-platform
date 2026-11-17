//! Wire format of the structured mode: newline-delimited JSON in both directions.

use std::io::{self, Write};

use serde::{Deserialize, Serialize};

/// One stdout line.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event<'a> {
    /// First line of every process.
    Init { session_id: &'a str, model: &'a str, cwd: &'a str },
    /// Streaming text of the current assistant message.
    Delta { text: &'a str },
    ToolUse { id: &'a str, name: &'a str, input: serde_json::Value },
    ToolResult { id: &'a str, ok: bool, output: &'a str },
    /// The complete assistant message of the turn.
    Message { text: &'a str },
    /// The turn is blocked until a `permission` input with the same id arrives.
    PermissionRequest { id: &'a str, tool: &'a str, description: &'a str },
    /// Usage of the current turn (not cumulative).
    Usage { input_tokens: u64, output_tokens: u64, cache_read_tokens: u64, cost_usd: f64 },
    /// Last line of every turn. `num_turns` counts the turns of this process.
    Result { ok: bool, text: &'a str, session_id: &'a str, duration_ms: u64, num_turns: u32 },
    Error { message: &'a str },
}

/// One stdin line (`--input-format jsonl`).
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Input {
    /// Starts a turn (queued while another turn is running).
    User { text: String },
    /// Aborts the running turn.
    Interrupt,
    /// Answers a `permission_request`.
    Permission { id: String, allow: bool },
}

/// Writes one event as a complete line. Every call takes the stdout lock for the whole line, so
/// the main thread and the stdin reader never interleave partial lines.
pub fn emit(event: &Event<'_>) -> io::Result<()> {
    let mut line = serde_json::to_vec(event)?;
    line.push(b'\n');
    let mut stdout = io::stdout().lock();
    stdout.write_all(&line)?;
    stdout.flush()
}
