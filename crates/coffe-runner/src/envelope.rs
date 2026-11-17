//! Building and parsing protocol frames.

use coffe_protocol::{RunnerEnvelope, RunnerMessage, ServerEnvelope};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

/// RFC 3339 UTC timestamp for `ts` fields.
pub fn now_rfc3339() -> String {
    OffsetDateTime::now_utc().format(&Rfc3339).unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

/// A runner frame, optionally answering the control-plane request `re`.
pub fn envelope(msg: RunnerMessage, re: Option<Uuid>) -> RunnerEnvelope {
    RunnerEnvelope { id: Uuid::now_v7(), re, ts: now_rfc3339(), msg }
}

/// Serialized runner frame (text WebSocket message).
pub fn encode(msg: RunnerMessage, re: Option<Uuid>) -> String {
    serde_json::to_string(&envelope(msg, re)).unwrap_or_default()
}

/// A server frame that failed to parse: what is needed to answer it.
#[derive(Debug)]
pub struct UnparsedFrame {
    pub id: Option<Uuid>,
    pub message_type: Option<String>,
    pub error: String,
}

/// Parses a server frame; on failure returns the request id and type when they are readable.
pub fn decode(text: &str) -> Result<ServerEnvelope, UnparsedFrame> {
    serde_json::from_str::<ServerEnvelope>(text).map_err(|err| {
        let value = serde_json::from_str::<serde_json::Value>(text).ok();
        UnparsedFrame {
            id: value
                .as_ref()
                .and_then(|v| v.get("id"))
                .and_then(|v| v.as_str())
                .and_then(|s| Uuid::parse_str(s).ok()),
            message_type: value
                .as_ref()
                .and_then(|v| v.get("type"))
                .and_then(|v| v.as_str())
                .map(str::to_owned),
            error: err.to_string(),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use coffe_protocol::{Heartbeat, ServerMessage};

    #[test]
    fn encodes_flat_envelopes() {
        let re = Uuid::nil();
        let text = encode(RunnerMessage::Heartbeat(Heartbeat { running_runs: 1, load_avg: None }), Some(re));
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["type"], "heartbeat");
        assert_eq!(value["re"], re.to_string());
        assert!(value["ts"].as_str().unwrap().ends_with('Z'));
    }

    #[test]
    fn decode_reports_id_and_type_of_unknown_messages() {
        let id = Uuid::now_v7();
        let text = format!(r#"{{"id":"{id}","ts":"t","type":"teleport","payload":{{}}}}"#);
        let err = decode(&text).unwrap_err();
        assert_eq!(err.id, Some(id));
        assert_eq!(err.message_type.as_deref(), Some("teleport"));

        let ok = format!(r#"{{"id":"{id}","ts":"t","type":"clis.detect","payload":{{}}}}"#);
        assert!(matches!(decode(&ok).unwrap().msg, ServerMessage::ClisDetect(_)));
    }
}
