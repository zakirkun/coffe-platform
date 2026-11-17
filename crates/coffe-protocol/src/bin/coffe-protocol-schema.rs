//! Writes the protocol JSON Schema (draft 2020-12) consumed by `packages/protocol`.
//!
//! Usage: `coffe-protocol-schema <output.json>` (prints to stdout without an argument).

use coffe_protocol::{PROTOCOL_HEADER, PROTOCOL_VERSION, ProtocolSchemaRoot};

fn main() {
    let mut schema = serde_json::to_value(schemars::schema_for!(ProtocolSchemaRoot))
        .expect("schema serializes");
    let root = schema.as_object_mut().expect("root schema is an object");
    root.insert("title".into(), "CoffeProtocol".into());
    root.insert("x-protocol-version".into(), PROTOCOL_VERSION.into());
    root.insert("x-protocol-header".into(), PROTOCOL_HEADER.into());

    let mut json = serde_json::to_string_pretty(&schema).expect("schema to string");
    json.push('\n');
    match std::env::args().nth(1) {
        Some(path) => std::fs::write(&path, json).unwrap_or_else(|e| panic!("write {path}: {e}")),
        None => print!("{json}"),
    }
}
