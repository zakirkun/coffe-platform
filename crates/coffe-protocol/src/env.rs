//! Phase 3 work-environment payloads: Docker, preview tunnel, database manager, SSH.
//! Wire names are assigned in the direction enums in `lib.rs` (`docker.*`, `preview.*`, `db.*`,
//! `ssh.*`). Binary data is base64; ciphertext for E2E features is opaque to the control plane.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PortMapping {
    pub container_port: u16,
    /// Host port; `None` lets Docker pick a free one.
    #[serde(default)]
    pub host_port: Option<u16>,
    /// `tcp` | `udp`.
    pub protocol: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DockerBuildSpec {
    /// Repo-relative build context directory.
    pub context: String,
    /// Repo-relative Dockerfile path.
    pub dockerfile: String,
}

/// What to run for a project/ticket environment (architecture §12.3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EnvironmentSpec {
    pub environment_id: Uuid,
    pub name: String,
    /// Image to run; ignored when `build` is set.
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub build: Option<DockerBuildSpec>,
    /// Command override (exec form).
    #[serde(default)]
    pub command: Option<Vec<String>>,
    /// Non-secret environment variables.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub ports: Vec<PortMapping>,
    /// Mount the repo (or the ticket worktree when `branch` is set) at `/workspace`.
    pub mount_worktree: bool,
    pub repo_key: String,
    #[serde(default)]
    pub branch: Option<String>,
    /// Labels added to the container (`coffe.*` labels are set by the runner).
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ContainerInfo {
    pub id: String,
    pub name: String,
    pub image: String,
    /// `created` | `running` | `paused` | `restarting` | `removing` | `exited` | `dead`.
    pub status: String,
    #[serde(default)]
    pub status_detail: Option<String>,
    #[serde(default)]
    pub ports: Vec<PortMapping>,
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
    #[serde(default)]
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DockerList {
    /// Only containers labelled with this environment/project (`coffe.project`).
    #[serde(default)]
    pub project_id: Option<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DockerListResult {
    /// False when the Docker Engine is unreachable (then `containers` is empty).
    pub engine_available: bool,
    #[serde(default)]
    pub engine_version: Option<String>,
    pub containers: Vec<ContainerInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DockerCreate {
    pub spec: EnvironmentSpec,
    pub project_id: Uuid,
    #[serde(default)]
    pub ticket_id: Option<Uuid>,
    pub start: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DockerContainerResult {
    pub container: ContainerInfo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DockerAction {
    Start,
    Stop,
    Restart,
    Remove,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DockerControl {
    pub container_id: String,
    pub action: DockerAction,
    #[serde(default)]
    pub timeout_secs: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DockerLogs {
    pub stream_id: Uuid,
    pub container_id: String,
    pub follow: bool,
    pub tail: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct StreamStop {
    pub stream_id: Uuid,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DockerLogsChunk {
    pub stream_id: Uuid,
    pub seq: u64,
    /// `stdout` | `stderr`.
    pub stream: String,
    pub data: String,
    /// Last chunk of the stream (container stopped or `follow` was false).
    pub end: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DockerStats {
    pub container_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DockerStatsResult {
    pub cpu_percent: f64,
    pub memory_bytes: u64,
    pub memory_limit_bytes: u64,
}

/// Unsolicited container state change (Docker events stream).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DockerEvent {
    pub container: ContainerInfo,
}

// ---------------------------------------------------------------------------
// Preview tunnel (architecture §12.4)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PreviewTarget {
    /// Port on the runner host (or inside the container when `container_id` is set).
    pub port: u16,
    #[serde(default)]
    pub container_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PreviewOpen {
    pub preview_id: Uuid,
    pub target: PreviewTarget,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PreviewOpenResult {
    /// Something accepted a TCP connection on the target port.
    pub reachable: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PreviewClose {
    pub preview_id: Uuid,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PreviewHttpRequest {
    pub stream_id: Uuid,
    pub preview_id: Uuid,
    pub method: String,
    /// Path + query, e.g. `/assets/app.js?v=1`.
    pub path: String,
    /// Header list (order and duplicates preserved), COFFE cookies already stripped.
    pub headers: Vec<(String, String)>,
    /// Request body follows in `preview.http.body` frames.
    pub has_body: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PreviewHttpHead {
    pub stream_id: Uuid,
    pub status: u16,
    pub headers: Vec<(String, String)>,
}

/// Body chunk in either direction (request body to the runner, response body back).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PreviewHttpBody {
    pub stream_id: Uuid,
    pub seq: u64,
    pub data: String,
    pub end: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PreviewStreamError {
    pub stream_id: Uuid,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PreviewWsOpen {
    pub stream_id: Uuid,
    pub preview_id: Uuid,
    pub path: String,
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub protocols: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PreviewWsOpened {
    pub stream_id: Uuid,
    #[serde(default)]
    pub protocol: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PreviewWsFrame {
    pub stream_id: Uuid,
    pub binary: bool,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PreviewWsClose {
    pub stream_id: Uuid,
    pub code: u16,
    #[serde(default)]
    pub reason: Option<String>,
}

// ---------------------------------------------------------------------------
// Database manager (architecture §12.5). Connections and credentials live only on the runner.
// ---------------------------------------------------------------------------

/// Sokudo-style capability level of a driver.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DbCapability {
    /// Connect + run raw commands.
    Connect,
    /// List namespaces/objects and preview data.
    Browse,
    /// Describe schemas (columns, types, keys).
    Understand,
    /// Write with confirmation.
    Operate,
    /// Message broker semantics (topics/queues), no SQL.
    Broker,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DbConnectionInfo {
    pub connection_id: Uuid,
    pub name: String,
    /// `postgres` | `mysql` | `sqlite` | `mongodb` | `redis` | `clickhouse` | …
    pub engine: String,
    /// `host:port/database` without credentials.
    pub display: String,
    pub capabilities: Vec<DbCapability>,
    /// Writes need confirmation unless the connection was saved with read_only = false.
    pub read_only: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DbConnectionsList {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DbConnectionsListResult {
    pub connections: Vec<DbConnectionInfo>,
    /// Engines this runner build supports.
    pub engines: Vec<String>,
}

/// New/updated connection. `sealed` = base64 `crypto_box_seal` (runner box key) of a JSON
/// `SealedSecret` with purpose `db_credential`; never readable by the control plane.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DbConnectionSave {
    pub connection_id: Uuid,
    pub name: String,
    pub engine: String,
    pub sealed: String,
    pub read_only: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DbConnectionRef {
    pub connection_id: Uuid,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DbTestResult {
    pub ok: bool,
    #[serde(default)]
    pub server_version: Option<String>,
    pub latency_ms: u64,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DbSchemaRequest {
    pub connection_id: Uuid,
    /// Database / schema / keyspace to describe; `None` lists namespaces only.
    #[serde(default)]
    pub namespace: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DbColumn {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub primary_key: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DbObject {
    pub name: String,
    /// `table` | `view` | `collection` | `index` | `key_pattern` | `topic` | …
    pub kind: String,
    #[serde(default)]
    pub columns: Vec<DbColumn>,
    #[serde(default)]
    pub row_estimate: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DbSchemaResult {
    pub namespaces: Vec<String>,
    #[serde(default)]
    pub namespace: Option<String>,
    #[serde(default)]
    pub objects: Vec<DbObject>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum StatementClass {
    Read,
    Write,
    Ddl,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DbQuery {
    pub connection_id: Uuid,
    #[serde(default)]
    pub namespace: Option<String>,
    /// SQL, or the engine's command syntax (MongoDB JSON command, Redis command line, …).
    pub query: String,
    pub limit: u32,
    /// Echo of a previous `confirmation_required.token` to execute a writing statement.
    #[serde(default)]
    pub confirm_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DbResultColumn {
    pub name: String,
    pub data_type: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum DbQueryResult {
    Rows {
        class: StatementClass,
        columns: Vec<DbResultColumn>,
        /// Row values as JSON (binary as base64 strings).
        rows: Vec<Vec<serde_json::Value>>,
        truncated: bool,
        #[serde(default)]
        affected: Option<u64>,
        elapsed_ms: u64,
    },
    /// The statement writes; nothing was executed. Re-send with `confirm_token` (valid 5 min,
    /// bound to the statement hash) after the user confirmed.
    ConfirmationRequired { class: StatementClass, token: String, statement_hash: String, reason: String },
    Error { message: String },
}

// ---------------------------------------------------------------------------
// SSH (architecture §12.6, §14.5) — credentials and terminal stream end-to-end encrypted.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SshHostSpec {
    pub host_id: Uuid,
    pub hostname: String,
    pub port: u16,
    pub username: String,
}

/// Browser side of the E2E terminal channel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SshE2eOffer {
    /// Browser ephemeral X25519 public key (base64) for `crypto_kx`.
    pub client_public_key: String,
    /// `crypto_secretstream_xchacha20poly1305` header of the browser → runner stream (base64).
    pub header_c2s: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SshOpen {
    pub session_id: Uuid,
    pub host: SshHostSpec,
    /// Base64 `crypto_box_seal` of a `SealedSecret` with purpose `ssh_key`.
    pub sealed_credential: String,
    pub e2e: SshE2eOffer,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SshOpened {
    pub session_id: Uuid,
    /// SHA-256 fingerprint of the server host key (`SHA256:…`), pinned by the runner.
    pub host_key_fingerprint: String,
    /// True when the key was pinned on this connection (first use).
    pub host_key_new: bool,
    /// Header of the runner → browser secretstream (base64).
    pub header_s2c: String,
}

/// Opaque E2E terminal bytes in either direction (secretstream message, base64).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SshData {
    pub session_id: Uuid,
    pub seq: u64,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SshResize {
    pub session_id: Uuid,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SshClose {
    pub session_id: Uuid,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SshClosed {
    pub session_id: Uuid,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub error: Option<String>,
    pub bytes_in: u64,
    pub bytes_out: u64,
}

/// Plaintext inside every sealed secret (architecture §14.3). The runner rejects it unless
/// `purpose`, `ref_id`, `workspace_id` and `runner_id` match the request context.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SealedSecret {
    pub v: u8,
    /// `ssh_key` | `db_credential`.
    pub purpose: String,
    pub ref_id: Uuid,
    pub workspace_id: String,
    pub runner_id: Uuid,
    pub secret: serde_json::Value,
}
