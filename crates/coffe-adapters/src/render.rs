//! Renders normalized agent events as ANSI text for the browser terminal in structured mode.

use coffe_protocol::{AgentEvent, MessageRole, Usage};

const RESET: &str = "\x1b[0m";
const DIM: &str = "\x1b[2m";
const BOLD: &str = "\x1b[1m";
const CYAN: &str = "\x1b[36m";
const GREEN: &str = "\x1b[32m";
const RED: &str = "\x1b[31m";
const YELLOW: &str = "\x1b[33m";
const MAGENTA: &str = "\x1b[35m";

/// Maximum characters of tool input/output echoed into the terminal (the full value stays in
/// the event log).
const PREVIEW_CHARS: usize = 600;

/// Converts `\n` to `\r\n` (xterm.js does not translate newlines).
fn crlf(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\n', "\r\n")
}

fn preview(text: &str) -> String {
    let mut out: String = text.chars().take(PREVIEW_CHARS).collect();
    if text.chars().count() > PREVIEW_CHARS {
        out.push('…');
    }
    out
}

fn usage_line(usage: &Usage) -> String {
    if !usage.available {
        return match usage.credits {
            Some(credits) => format!("credits {credits:.2}"),
            None => "usage unavailable".to_owned(),
        };
    }
    let mut line = format!(
        "tokens in {} · out {} · cache r/w {}/{}",
        usage.input_tokens, usage.output_tokens, usage.cache_read_tokens, usage.cache_write_tokens
    );
    if let Some(cost) = usage.cost_usd {
        line.push_str(&format!(" · ${cost:.4}"));
    }
    line
}

/// Returns the terminal bytes for one event, or an empty vector when the event has no visual
/// representation. Streaming deltas are written inline; complete assistant messages that follow
/// deltas are therefore not repeated by callers that track `MessageDelta` (see `streamed`).
pub fn render_event(event: &AgentEvent, streamed: bool) -> Vec<u8> {
    let text = match event {
        AgentEvent::SessionStarted { session_id, model, .. } => {
            let model = model.as_deref().unwrap_or("default model");
            let session = session_id.as_deref().unwrap_or("-");
            format!("{DIM}● session {session} · {model}{RESET}\r\n")
        }
        AgentEvent::Message { role: MessageRole::Assistant, text } => {
            if streamed {
                "\r\n".to_owned()
            } else {
                format!("{}\r\n", crlf(text))
            }
        }
        AgentEvent::Message { role: MessageRole::User, text } => {
            format!("{BOLD}{CYAN}› {}{RESET}\r\n", crlf(text))
        }
        AgentEvent::Message { role: MessageRole::System, text } => {
            format!("{DIM}{}{RESET}\r\n", crlf(text))
        }
        AgentEvent::MessageDelta { text } => crlf(text),
        AgentEvent::Thinking { text } => format!("{DIM}{}{RESET}\r\n", crlf(&preview(text))),
        AgentEvent::ToolCall { name, title, input, .. } => {
            let detail = title.clone().unwrap_or_else(|| preview(&input.to_string()));
            format!("{YELLOW}⚙ {name}{RESET} {DIM}{}{RESET}\r\n", crlf(&detail))
        }
        AgentEvent::ToolResult { ok, output, .. } => {
            let (color, mark) = if *ok { (GREEN, "✓") } else { (RED, "✗") };
            let body = preview(output.trim_end());
            if body.is_empty() {
                format!("{color}{mark}{RESET}\r\n")
            } else {
                format!("{color}{mark}{RESET} {DIM}{}{RESET}\r\n", crlf(&body))
            }
        }
        AgentEvent::FileChange { path, change } => format!("{MAGENTA}✎ {change} {path}{RESET}\r\n"),
        AgentEvent::Plan { items } => {
            let mut out = format!("{BOLD}Plan{RESET}\r\n");
            for item in items {
                let mark = match item.status.as_str() {
                    "completed" => "☑",
                    "in_progress" => "▶",
                    _ => "☐",
                };
                out.push_str(&format!("  {mark} {}\r\n", crlf(&item.text)));
            }
            out
        }
        AgentEvent::PermissionRequest { tool, description, options, .. } => format!(
            "{BOLD}{YELLOW}? permission requested: {tool}{RESET} {}\r\n{DIM}  options: {}{RESET}\r\n",
            crlf(description),
            options.join(" / ")
        ),
        AgentEvent::Usage { .. } => String::new(),
        AgentEvent::TurnCompleted { is_error, duration_ms, num_turns, .. } => {
            let (color, label) = if *is_error { (RED, "turn failed") } else { (GREEN, "turn complete") };
            let mut extra = Vec::new();
            if let Some(ms) = duration_ms {
                extra.push(format!("{:.1}s", *ms as f64 / 1000.0));
            }
            if let Some(turns) = num_turns {
                extra.push(format!("{turns} turns"));
            }
            format!("{color}■ {label}{RESET} {DIM}{}{RESET}\r\n", extra.join(" · "))
        }
        AgentEvent::Error { message } => format!("{RED}error: {}{RESET}\r\n", crlf(message)),
        AgentEvent::Raw { text } => format!("{}\r\n", crlf(text)),
        AgentEvent::Gap { dropped_bytes } => {
            format!("{DIM}[… {dropped_bytes} bytes of output dropped …]{RESET}\r\n")
        }
    };
    text.into_bytes()
}

/// One-line usage summary appended at the end of a structured run.
pub fn render_usage(usage: &Usage) -> Vec<u8> {
    format!("{DIM}{}{RESET}\r\n", usage_line(usage)).into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use coffe_protocol::ToolKind;

    #[test]
    fn deltas_are_inline_and_final_message_not_repeated() {
        let delta = AgentEvent::MessageDelta { text: "Hel\nlo".into() };
        assert_eq!(render_event(&delta, true), b"Hel\r\nlo");
        let full = AgentEvent::Message { role: MessageRole::Assistant, text: "Hello".into() };
        assert_eq!(render_event(&full, true), b"\r\n");
        assert_eq!(render_event(&full, false), b"Hello\r\n");
    }

    #[test]
    fn tool_calls_prefer_titles_and_truncate_input() {
        let call = AgentEvent::ToolCall {
            call_id: "1".into(),
            name: "Bash".into(),
            tool_kind: ToolKind::Execute,
            input: serde_json::json!({ "command": "x".repeat(2000) }),
            title: None,
        };
        let out = String::from_utf8(render_event(&call, false)).unwrap();
        assert!(out.contains("Bash"));
        assert!(out.contains('…'));
    }

    #[test]
    fn usage_line_marks_unavailable_and_credits() {
        assert!(usage_line(&Usage::default()).contains("unavailable"));
        let credits = Usage { credits: Some(0.04), ..Usage::default() };
        assert_eq!(usage_line(&credits), "credits 0.04");
    }
}
