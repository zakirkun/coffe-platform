//! Generic Agent Client Protocol (ACP v1, JSON-RPC 2.0 over stdio) client.
//!
//! Adapters whose CLI speaks ACP natively (`gemini --acp`, `opencode acp`, `agy acp`,
//! `grok agent stdio`, `muse acp`, `kiro-cli acp`) embed an [`AcpClient`] in their
//! `SessionState::ext` and delegate parsing and input encoding to it. The client is a pure state
//! machine: it consumes stdout lines and returns normalized events plus the frames to write.
//!
//! Spec: <https://agentclientprotocol.com/protocol/v1> (initialization, session setup, prompt
//! turn, tool calls). COFFE advertises no `fs`/`terminal` client capabilities: the agent works
//! directly in the worktree, and requests for those methods are answered with "method not found".

use std::collections::{HashMap, VecDeque};

use coffe_protocol::{AgentEvent, MessageRole, PlanItem, ToolKind, Usage};
use serde_json::{Value, json};

use crate::IoAction;

pub const ACP_PROTOCOL_VERSION: u64 = 1;

const METHOD_NOT_FOUND: i64 = -32601;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Pending {
    Initialize,
    NewSession,
    LoadSession,
    Prompt,
}

#[derive(Debug, Clone)]
struct PermissionOption {
    option_id: String,
    kind: String,
}

#[derive(Debug)]
struct PendingPermission {
    rpc_id: Value,
    options: Vec<PermissionOption>,
}

/// ACP client state for one agent process.
#[derive(Debug)]
pub struct AcpClient {
    cwd: String,
    client_name: String,
    client_version: String,
    next_id: u64,
    pending: HashMap<u64, Pending>,
    session_id: Option<String>,
    resume_session_id: Option<String>,
    queued_prompts: VecDeque<String>,
    prompt_in_flight: bool,
    permissions: HashMap<String, PendingPermission>,
    turns: u32,
    /// Maps `session/update` notifications; holds the current turn's text and cumulative usage.
    pub updates: SessionUpdateMapper,
}

/// Maps ACP `SessionUpdate` objects to normalized events. Shared by the ACP driver and by CLIs
/// whose headless JSON stream embeds ACP updates (Kiro `--output-format stream-json`).
#[derive(Debug, Default)]
pub struct SessionUpdateMapper {
    /// Agent text streamed since the last [`SessionUpdateMapper::start_turn`].
    pub turn_text: String,
    /// Cumulative usage reported through `usage_update` (cost / credits only: ACP reports
    /// context-window occupancy, not per-turn token counts).
    pub usage: Usage,
}

fn line(value: &Value) -> IoAction {
    let mut bytes = serde_json::to_vec(value).unwrap_or_default();
    bytes.push(b'\n');
    IoAction::Write(bytes)
}

fn tool_kind(kind: Option<&str>) -> ToolKind {
    match kind {
        Some("read") => ToolKind::Read,
        Some("edit" | "delete" | "move") => ToolKind::Edit,
        Some("search") => ToolKind::Search,
        Some("execute") => ToolKind::Execute,
        Some("fetch") => ToolKind::Fetch,
        _ => ToolKind::Other,
    }
}

/// Concatenates the text of ACP `ContentBlock`s / `ToolCallContent` items.
fn content_text(value: &Value) -> String {
    match value {
        Value::Array(items) => items.iter().map(content_text).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n"),
        Value::Object(map) => {
            if let Some(Value::String(text)) = map.get("text") {
                return text.clone();
            }
            if let Some(inner) = map.get("content") {
                return content_text(inner);
            }
            if let Some(Value::String(diff_path)) = map.get("path") {
                return format!("diff {diff_path}");
            }
            String::new()
        }
        Value::String(text) => text.clone(),
        _ => String::new(),
    }
}

impl AcpClient {
    /// Creates the client and returns the `initialize` frame to write immediately.
    pub fn new(
        cwd: impl Into<String>,
        initial_prompt: impl Into<String>,
        resume_session_id: Option<String>,
    ) -> (Self, IoAction) {
        let mut client = Self {
            cwd: cwd.into(),
            client_name: "coffe-runner".into(),
            client_version: env!("CARGO_PKG_VERSION").into(),
            next_id: 0,
            pending: HashMap::new(),
            session_id: None,
            resume_session_id,
            queued_prompts: VecDeque::from([initial_prompt.into()]),
            prompt_in_flight: false,
            permissions: HashMap::new(),
            turns: 0,
            updates: SessionUpdateMapper::default(),
        };
        let init = client.request(
            Pending::Initialize,
            "initialize",
            json!({
                "protocolVersion": ACP_PROTOCOL_VERSION,
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false
                },
                "clientInfo": { "name": client.client_name, "title": "COFFE", "version": client.client_version }
            }),
        );
        (client, init)
    }

    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    pub fn prompt_in_flight(&self) -> bool {
        self.prompt_in_flight
    }

    fn request(&mut self, kind: Pending, method: &str, params: Value) -> IoAction {
        let id = self.next_id;
        self.next_id += 1;
        self.pending.insert(id, kind);
        line(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
    }

    fn send_next_prompt(&mut self, out: &mut Vec<IoAction>) {
        if self.prompt_in_flight {
            return;
        }
        let (Some(session_id), Some(text)) = (self.session_id.clone(), self.queued_prompts.pop_front()) else {
            return;
        };
        self.prompt_in_flight = true;
        self.updates.start_turn();
        out.push(self.request(
            Pending::Prompt,
            "session/prompt",
            json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": text }] }),
        ));
    }

    /// Queues a follow-up user message (sent when the current turn ends).
    pub fn send_text(&mut self, text: String) -> Vec<IoAction> {
        self.queued_prompts.push_back(text);
        let mut out = Vec::new();
        self.send_next_prompt(&mut out);
        out
    }

    /// Cancels the running turn; pending permission requests are answered `cancelled`.
    pub fn cancel(&mut self) -> Vec<IoAction> {
        let mut out = Vec::new();
        for (_, pending) in self.permissions.drain() {
            out.push(line(&json!({
                "jsonrpc": "2.0",
                "id": pending.rpc_id,
                "result": { "outcome": { "outcome": "cancelled" } }
            })));
        }
        if let Some(session_id) = &self.session_id {
            out.push(line(&json!({
                "jsonrpc": "2.0",
                "method": "session/cancel",
                "params": { "sessionId": session_id }
            })));
        }
        out
    }

    /// Answers a `permission_request` event. Returns `None` for an unknown request id.
    pub fn answer_permission(&mut self, request_id: &str, allow: bool, remember: bool) -> Option<IoAction> {
        let pending = self.permissions.remove(request_id)?;
        let preferred: &[&str] = match (allow, remember) {
            (true, true) => &["allow_always", "allow_once"],
            (true, false) => &["allow_once", "allow_always"],
            (false, true) => &["reject_always", "reject_once"],
            (false, false) => &["reject_once", "reject_always"],
        };
        let chosen = preferred
            .iter()
            .find_map(|kind| pending.options.iter().find(|o| o.kind == *kind))
            .map(|o| o.option_id.clone());
        let outcome = match chosen {
            Some(option_id) => json!({ "outcome": "selected", "optionId": option_id }),
            None => json!({ "outcome": "cancelled" }),
        };
        Some(line(&json!({ "jsonrpc": "2.0", "id": pending.rpc_id, "result": { "outcome": outcome } })))
    }

    /// Text produced by the agent during the last completed turn.
    pub fn last_turn_text(&self) -> &str {
        &self.updates.turn_text
    }

    /// Handles one stdout line. Returns normalized events; frames to write go to `out`.
    pub fn handle_line(&mut self, raw: &str, out: &mut Vec<IoAction>) -> Vec<AgentEvent> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Vec::new();
        }
        let Ok(message) = serde_json::from_str::<Value>(trimmed) else {
            return vec![AgentEvent::Raw { text: raw.to_owned() }];
        };
        let method = message.get("method").and_then(Value::as_str);
        let id = message.get("id").cloned().filter(|v| !v.is_null());
        match (method, id) {
            (Some(method), Some(id)) => self.handle_request(method, id, &message["params"], out),
            (Some(method), None) => self.handle_notification(method, &message["params"]),
            (None, Some(id)) => self.handle_response(&id, &message, out),
            (None, None) => vec![AgentEvent::Raw { text: raw.to_owned() }],
        }
    }

    fn handle_response(&mut self, id: &Value, message: &Value, out: &mut Vec<IoAction>) -> Vec<AgentEvent> {
        let Some(kind) = id.as_u64().and_then(|n| self.pending.remove(&n)) else {
            return Vec::new();
        };
        if let Some(error) = message.get("error") {
            let text = error.get("message").and_then(Value::as_str).unwrap_or("ACP error").to_owned();
            let mut events = vec![AgentEvent::Error { message: format!("{kind:?} failed: {text}") }];
            if kind == Pending::Prompt {
                self.prompt_in_flight = false;
            }
            if matches!(kind, Pending::Initialize | Pending::NewSession | Pending::LoadSession | Pending::Prompt) {
                events.push(AgentEvent::TurnCompleted {
                    result: Some(text),
                    is_error: true,
                    duration_ms: None,
                    num_turns: Some(self.turns),
                });
            }
            return events;
        }
        let result = &message["result"];
        match kind {
            Pending::Initialize => {
                let version = result.get("protocolVersion").and_then(Value::as_u64).unwrap_or(0);
                if version != ACP_PROTOCOL_VERSION {
                    return vec![
                        AgentEvent::Error { message: format!("agent speaks ACP v{version}, COFFE supports v{ACP_PROTOCOL_VERSION}") },
                        AgentEvent::TurnCompleted { result: None, is_error: true, duration_ms: None, num_turns: Some(0) },
                    ];
                }
                let can_load = result
                    .pointer("/agentCapabilities/loadSession")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                match self.resume_session_id.clone().filter(|_| can_load) {
                    Some(session_id) => {
                        self.session_id = Some(session_id.clone());
                        out.push(self.request(
                            Pending::LoadSession,
                            "session/load",
                            json!({ "sessionId": session_id, "cwd": self.cwd, "mcpServers": [] }),
                        ));
                    }
                    None => out.push(self.request(
                        Pending::NewSession,
                        "session/new",
                        json!({ "cwd": self.cwd, "mcpServers": [] }),
                    )),
                }
                Vec::new()
            }
            Pending::NewSession | Pending::LoadSession => {
                if kind == Pending::NewSession {
                    self.session_id = result.get("sessionId").and_then(Value::as_str).map(str::to_owned);
                }
                let model = result
                    .pointer("/models/currentModelId")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let event = AgentEvent::SessionStarted {
                    session_id: self.session_id.clone(),
                    model,
                    cwd: Some(self.cwd.clone()),
                    tools: Vec::new(),
                };
                self.send_next_prompt(out);
                vec![event]
            }
            Pending::Prompt => {
                self.prompt_in_flight = false;
                self.turns += 1;
                let stop_reason = result.get("stopReason").and_then(Value::as_str).unwrap_or("end_turn");
                let mut events = Vec::new();
                let turn_text = self.updates.turn_text.clone();
                if !turn_text.is_empty() {
                    events.push(AgentEvent::Message { role: MessageRole::Assistant, text: turn_text.clone() });
                }
                events.push(AgentEvent::TurnCompleted {
                    result: Some(if turn_text.is_empty() { stop_reason.to_owned() } else { turn_text }),
                    is_error: matches!(stop_reason, "refusal" | "max_tokens" | "max_turn_requests"),
                    duration_ms: None,
                    num_turns: Some(self.turns),
                });
                self.send_next_prompt(out);
                events
            }
        }
    }

    fn handle_request(&mut self, method: &str, id: Value, params: &Value, out: &mut Vec<IoAction>) -> Vec<AgentEvent> {
        if method != "session/request_permission" {
            out.push(line(&json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": METHOD_NOT_FOUND, "message": format!("{method} is not supported by COFFE") }
            })));
            return Vec::new();
        }
        let tool_call = &params["toolCall"];
        let options: Vec<PermissionOption> = params["options"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|o| {
                        Some(PermissionOption {
                            option_id: o.get("optionId")?.as_str()?.to_owned(),
                            kind: o.get("kind").and_then(Value::as_str).unwrap_or_default().to_owned(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let option_names = params["options"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|o| o.get("name").and_then(Value::as_str).map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        let request_id = match &id {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        let tool = tool_call
            .get("name")
            .or_else(|| tool_call.get("title"))
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_owned();
        let mut description = tool_call.get("title").and_then(Value::as_str).unwrap_or_default().to_owned();
        if let Some(raw) = tool_call.get("rawInput").filter(|v| !v.is_null()) {
            description = if description.is_empty() { raw.to_string() } else { format!("{description} {raw}") };
        }
        self.permissions.insert(request_id.clone(), PendingPermission { rpc_id: id, options });
        vec![AgentEvent::PermissionRequest { request_id, tool, description, options: option_names }]
    }

    fn handle_notification(&mut self, method: &str, params: &Value) -> Vec<AgentEvent> {
        if method != "session/update" {
            return Vec::new();
        }
        self.updates.map(&params["update"])
    }
}

impl SessionUpdateMapper {
    /// Clears the per-turn text before a new prompt.
    pub fn start_turn(&mut self) {
        self.turn_text.clear();
    }

    /// Normalized events for one ACP `SessionUpdate` object (`params.update`).
    pub fn map(&mut self, update: &Value) -> Vec<AgentEvent> {
        match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("agent_message_chunk") => {
                let text = content_text(&update["content"]);
                if text.is_empty() {
                    return Vec::new();
                }
                self.turn_text.push_str(&text);
                vec![AgentEvent::MessageDelta { text }]
            }
            Some("agent_thought_chunk") => {
                let text = content_text(&update["content"]);
                if text.is_empty() { Vec::new() } else { vec![AgentEvent::Thinking { text }] }
            }
            Some("tool_call") => {
                let call_id = update.get("toolCallId").and_then(Value::as_str).unwrap_or_default().to_owned();
                let title = update.get("title").and_then(Value::as_str).map(str::to_owned);
                let name = update
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| title.clone())
                    .unwrap_or_else(|| "tool".into());
                let mut events = vec![AgentEvent::ToolCall {
                    call_id: call_id.clone(),
                    name,
                    tool_kind: tool_kind(update.get("kind").and_then(Value::as_str)),
                    input: update.get("rawInput").cloned().unwrap_or(Value::Null),
                    title,
                }];
                events.extend(tool_status_event(&call_id, update));
                events
            }
            Some("tool_call_update") => {
                let call_id = update.get("toolCallId").and_then(Value::as_str).unwrap_or_default().to_owned();
                tool_status_event(&call_id, update).into_iter().collect()
            }
            Some("plan") => {
                let items = update["entries"]
                    .as_array()
                    .map(|entries| {
                        entries
                            .iter()
                            .map(|e| PlanItem {
                                text: e.get("content").and_then(Value::as_str).unwrap_or_default().to_owned(),
                                status: e.get("status").and_then(Value::as_str).unwrap_or("pending").to_owned(),
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                vec![AgentEvent::Plan { items }]
            }
            Some("usage_update") => {
                let amount = update.pointer("/cost/amount").and_then(Value::as_f64);
                let currency = update.pointer("/cost/currency").and_then(Value::as_str).unwrap_or_default();
                match (amount, currency.to_ascii_lowercase().as_str()) {
                    (Some(amount), "usd") => self.usage.cost_usd = Some(amount),
                    (Some(amount), "credits") => self.usage.credits = Some(amount),
                    _ => return Vec::new(),
                }
                vec![AgentEvent::Usage { usage: self.usage.clone() }]
            }
            _ => Vec::new(),
        }
    }
}

/// A `ToolResult` once a tool call reaches a terminal status.
fn tool_status_event(call_id: &str, update: &Value) -> Option<AgentEvent> {
    let status = update.get("status").and_then(Value::as_str)?;
    if !matches!(status, "completed" | "failed") {
        return None;
    }
    let mut output = content_text(&update["content"]);
    if output.is_empty() {
        if let Some(raw) = update.get("rawOutput").filter(|v| !v.is_null()) {
            output = raw.as_str().map(str::to_owned).unwrap_or_else(|| raw.to_string());
        }
    }
    Some(AgentEvent::ToolResult { call_id: call_id.to_owned(), ok: status == "completed", output })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frames(actions: &[IoAction]) -> Vec<Value> {
        actions
            .iter()
            .map(|a| match a {
                IoAction::Write(bytes) => serde_json::from_slice(bytes).unwrap(),
                other => panic!("unexpected action {other:?}"),
            })
            .collect()
    }

    fn feed(client: &mut AcpClient, value: Value) -> (Vec<AgentEvent>, Vec<Value>) {
        let mut out = Vec::new();
        let events = client.handle_line(&value.to_string(), &mut out);
        (events, frames(&out))
    }

    #[test]
    fn full_turn_with_permission_and_follow_up() {
        let (mut client, init) = AcpClient::new("/wt", "fix the bug", None);
        let init = frames(&[init]);
        assert_eq!(init[0]["method"], "initialize");
        assert_eq!(init[0]["params"]["clientCapabilities"]["terminal"], false);

        let (_, out) = feed(&mut client, json!({"jsonrpc":"2.0","id":0,"result":{"protocolVersion":1,"agentCapabilities":{}}}));
        assert_eq!(out[0]["method"], "session/new");
        assert_eq!(out[0]["params"]["cwd"], "/wt");

        let (events, out) = feed(&mut client, json!({"jsonrpc":"2.0","id":1,"result":{"sessionId":"sess_1"}}));
        assert!(matches!(&events[0], AgentEvent::SessionStarted { session_id: Some(s), .. } if s == "sess_1"));
        assert_eq!(out[0]["method"], "session/prompt");
        assert_eq!(out[0]["params"]["prompt"][0]["text"], "fix the bug");

        // A follow-up sent mid-turn is queued, not sent concurrently.
        assert!(frames(&client.send_text("also add tests".into())).is_empty());

        let (events, _) = feed(&mut client, json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess_1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Looking"}}}}));
        assert_eq!(events, vec![AgentEvent::MessageDelta { text: "Looking".into() }]);

        let (events, _) = feed(&mut client, json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess_1","update":{"sessionUpdate":"tool_call","toolCallId":"c1","title":"Run tests","name":"bash","kind":"execute","status":"pending","rawInput":{"command":"npm test"}}}}));
        assert!(matches!(&events[0], AgentEvent::ToolCall { tool_kind: ToolKind::Execute, name, .. } if name == "bash"));

        let (events, _) = feed(&mut client, json!({"jsonrpc":"2.0","id":"perm-7","method":"session/request_permission","params":{"sessionId":"sess_1","toolCall":{"toolCallId":"c1","title":"Run tests"},"options":[{"optionId":"a1","name":"Allow once","kind":"allow_once"},{"optionId":"a2","name":"Always","kind":"allow_always"},{"optionId":"r1","name":"Reject","kind":"reject_once"}]}}));
        assert!(matches!(&events[0], AgentEvent::PermissionRequest { request_id, options, .. } if request_id == "perm-7" && options.len() == 3));
        let answer = frames(&[client.answer_permission("perm-7", true, true).unwrap()]);
        assert_eq!(answer[0]["id"], "perm-7");
        assert_eq!(answer[0]["result"]["outcome"]["optionId"], "a2");
        assert!(client.answer_permission("perm-7", true, false).is_none());

        let (events, _) = feed(&mut client, json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess_1","update":{"sessionUpdate":"tool_call_update","toolCallId":"c1","status":"completed","content":[{"type":"content","content":{"type":"text","text":"3 passed"}}]}}}));
        assert_eq!(events, vec![AgentEvent::ToolResult { call_id: "c1".into(), ok: true, output: "3 passed".into() }]);

        let (events, _) = feed(&mut client, json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess_1","update":{"sessionUpdate":"usage_update","used":1000,"size":200000,"cost":{"amount":0.25,"currency":"USD"}}}}));
        assert!(matches!(&events[0], AgentEvent::Usage { usage } if usage.cost_usd == Some(0.25)));

        let (events, out) = feed(&mut client, json!({"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}));
        assert!(matches!(&events[0], AgentEvent::Message { text, .. } if text == "Looking"));
        assert!(matches!(&events[1], AgentEvent::TurnCompleted { is_error: false, num_turns: Some(1), .. }));
        // The queued follow-up goes out as soon as the turn ends.
        assert_eq!(out[0]["method"], "session/prompt");
        assert_eq!(out[0]["params"]["prompt"][0]["text"], "also add tests");
    }

    #[test]
    fn resume_uses_session_load_only_when_supported() {
        let (mut client, _) = AcpClient::new("/wt", "go on", Some("sess_old".into()));
        let (_, out) = feed(&mut client, json!({"jsonrpc":"2.0","id":0,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}}));
        assert_eq!(out[0]["method"], "session/load");
        assert_eq!(out[0]["params"]["sessionId"], "sess_old");

        let (mut client, _) = AcpClient::new("/wt", "go on", Some("sess_old".into()));
        let (_, out) = feed(&mut client, json!({"jsonrpc":"2.0","id":0,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":false}}}));
        assert_eq!(out[0]["method"], "session/new");
    }

    #[test]
    fn cancel_answers_pending_permissions_and_notifies() {
        let (mut client, _) = AcpClient::new("/wt", "x", None);
        feed(&mut client, json!({"jsonrpc":"2.0","id":0,"result":{"protocolVersion":1}}));
        feed(&mut client, json!({"jsonrpc":"2.0","id":1,"result":{"sessionId":"s"}}));
        feed(&mut client, json!({"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":{"sessionId":"s","toolCall":{"toolCallId":"t"},"options":[{"optionId":"o","name":"ok","kind":"allow_once"}]}}));
        let out = frames(&client.cancel());
        assert_eq!(out[0]["result"]["outcome"]["outcome"], "cancelled");
        assert_eq!(out[1]["method"], "session/cancel");
    }

    #[test]
    fn unsupported_client_methods_get_method_not_found() {
        let (mut client, _) = AcpClient::new("/wt", "x", None);
        let (events, out) = feed(&mut client, json!({"jsonrpc":"2.0","id":4,"method":"fs/read_text_file","params":{"path":"/etc/passwd"}}));
        assert!(events.is_empty());
        assert_eq!(out[0]["error"]["code"], METHOD_NOT_FOUND);
    }

    #[test]
    fn version_mismatch_and_errors_end_the_turn() {
        let (mut client, _) = AcpClient::new("/wt", "x", None);
        let (events, _) = feed(&mut client, json!({"jsonrpc":"2.0","id":0,"result":{"protocolVersion":2}}));
        assert!(matches!(events.last(), Some(AgentEvent::TurnCompleted { is_error: true, .. })));

        let (mut client, _) = AcpClient::new("/wt", "x", None);
        let (events, _) = feed(&mut client, json!({"jsonrpc":"2.0","id":0,"error":{"code":-32000,"message":"authentication required"}}));
        assert!(matches!(&events[0], AgentEvent::Error { message } if message.contains("authentication required")));
    }

    #[test]
    fn non_json_output_is_raw() {
        let (mut client, _) = AcpClient::new("/wt", "x", None);
        let mut out = Vec::new();
        assert_eq!(client.handle_line("Loading…", &mut out), vec![AgentEvent::Raw { text: "Loading…".into() }]);
    }
}
