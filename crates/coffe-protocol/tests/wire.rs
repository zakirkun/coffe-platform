use coffe_protocol::*;
use serde_json::json;
use uuid::Uuid;

fn id(n: u128) -> Uuid {
    Uuid::from_u128(n)
}

#[test]
fn runner_envelope_is_flat_with_type_and_payload() {
    let env = RunnerEnvelope {
        id: id(1),
        re: None,
        ts: "2026-11-16T10:00:00.000Z".into(),
        msg: RunnerMessage::RunOutput(RunOutput { run_id: id(2), seq: 42, data: "aGk=".into() }),
    };
    let value = serde_json::to_value(&env).unwrap();
    assert_eq!(
        value,
        json!({
            "id": id(1).to_string(),
            "ts": "2026-11-16T10:00:00.000Z",
            "type": "run.output",
            "payload": { "run_id": id(2).to_string(), "seq": 42, "data": "aGk=" }
        })
    );
    let back: RunnerEnvelope = serde_json::from_value(value).unwrap();
    assert_eq!(back, env);
}

#[test]
fn server_envelope_round_trips_with_re() {
    let env = ServerEnvelope {
        id: id(3),
        re: Some(id(1)),
        ts: "2026-11-16T10:00:00.000Z".into(),
        msg: ServerMessage::RunSignal(RunSignal { run_id: id(2), signal: RunSignalKind::Pause }),
    };
    let text = serde_json::to_string(&env).unwrap();
    assert!(text.contains(r#""type":"run.signal""#));
    assert!(text.contains(r#""signal":"pause""#));
    let back: ServerEnvelope = serde_json::from_str(&text).unwrap();
    assert_eq!(back, env);
}

#[test]
fn unit_like_payloads_round_trip() {
    let text = format!(
        r#"{{"id":"{}","ts":"2026-11-16T10:00:00Z","type":"clis.detect","payload":{{}}}}"#,
        id(9)
    );
    let env: ServerEnvelope = serde_json::from_str(&text).unwrap();
    assert_eq!(env.msg, ServerMessage::ClisDetect(ClisDetect {}));
}

#[test]
fn unknown_fields_are_ignored() {
    let text = format!(
        r#"{{"id":"{}","ts":"t","type":"heartbeat","payload":{{"running_runs":2,"future_field":true}},"extra":1}}"#,
        id(5)
    );
    let env: RunnerEnvelope = serde_json::from_str(&text).unwrap();
    assert_eq!(env.msg, RunnerMessage::Heartbeat(Heartbeat { running_runs: 2, load_avg: None }));
}

#[test]
fn agent_events_use_kind_tag() {
    let event = AgentEvent::ToolCall {
        call_id: "c1".into(),
        name: "Bash".into(),
        tool_kind: ToolKind::Execute,
        input: json!({ "command": "ls" }),
        title: None,
    };
    let value = serde_json::to_value(&event).unwrap();
    assert_eq!(value["kind"], "tool_call");
    assert_eq!(value["tool_kind"], "execute");
    let back: AgentEvent = serde_json::from_value(value).unwrap();
    assert_eq!(back, event);
}

#[test]
fn agent_input_interrupt_is_tag_only() {
    let value = serde_json::to_value(AgentInput::Interrupt).unwrap();
    assert_eq!(value, json!({ "kind": "interrupt" }));
}

#[test]
fn protocol_version_compatibility() {
    assert_eq!(parse_protocol_version(PROTOCOL_VERSION), Some((PROTOCOL_MAJOR, PROTOCOL_MINOR)));
    assert!(is_compatible("1.0", 0));
    assert!(is_compatible("1.7", 3));
    assert!(!is_compatible("1.2", 3));
    assert!(!is_compatible("2.0", 0));
    assert!(!is_compatible("garbage", 0));
}

#[test]
fn run_status_terminal_states() {
    assert!(RunStatus::Completed.is_terminal());
    assert!(RunStatus::Failed.is_terminal());
    assert!(RunStatus::Cancelled.is_terminal());
    assert!(!RunStatus::Interrupted.is_terminal());
    assert!(!RunStatus::Running.is_terminal());
}
