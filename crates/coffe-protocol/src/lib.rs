//! COFFE runner <-> control plane protocol: the single source of truth.
//!
//! * Wire format: one JSON object per WebSocket text frame (an *envelope*).
//! * JSON Schema is generated from these types by the `coffe-protocol-schema` binary;
//!   `packages/protocol` generates TypeScript types and Ajv validators from that schema.
//! * Versioning: `PROTOCOL_MAJOR.PROTOCOL_MINOR`. Minor bumps are additive only
//!   (new optional fields, new message types guarded by capabilities). Major bumps break.
//!
//! Field naming is `snake_case` on the wire. Message `type` strings are dotted (`run.output`).
//! Binary data (terminal bytes, file contents) is base64 (standard alphabet, padded).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub mod env;
pub mod knowledge;

pub const PROTOCOL_MAJOR: u16 = 1;
pub const PROTOCOL_MINOR: u16 = 0;
/// `"MAJOR.MINOR"`; sent in `hello.protocol`, `welcome.protocol` and the `X-Coffe-Protocol` header.
pub const PROTOCOL_VERSION: &str = "1.0";
/// HTTP header carrying the protocol version on the WebSocket upgrade request.
pub const PROTOCOL_HEADER: &str = "X-Coffe-Protocol";

/// WebSocket close codes used by the control plane.
pub mod close_codes {
    pub const PROTOCOL_VIOLATION: u16 = 4000;
    pub const UNAUTHORIZED: u16 = 4001;
    pub const REPLACED: u16 = 4002;
    pub const UPGRADE_REQUIRED: u16 = 4010;
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

/// Frame sent by the runner.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RunnerEnvelope {
    /// Unique message id (UUID v4 or v7).
    pub id: Uuid,
    /// Id of the control-plane request this message answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub re: Option<Uuid>,
    /// RFC 3339 UTC timestamp of creation.
    pub ts: String,
    #[serde(flatten)]
    pub msg: RunnerMessage,
}

/// Frame sent by the control plane.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ServerEnvelope {
    pub id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub re: Option<Uuid>,
    pub ts: String,
    #[serde(flatten)]
    pub msg: ServerMessage,
}

/// Runner -> control plane messages.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", content = "payload")]
pub enum RunnerMessage {
    /// First and only message on a pairing connection (`Bearer coffe_pt_…`).
    #[serde(rename = "pair")]
    Pair(Pair),
    #[serde(rename = "hello")]
    Hello(Hello),
    #[serde(rename = "heartbeat")]
    Heartbeat(Heartbeat),
    /// Generic success reply to a control-plane request (`re` set).
    #[serde(rename = "ack")]
    Ack(Ack),
    /// Generic failure reply (`re` set) or unsolicited error.
    #[serde(rename = "error")]
    Error(ErrorPayload),
    #[serde(rename = "run.state")]
    RunState(RunState),
    #[serde(rename = "run.output")]
    RunOutput(RunOutput),
    #[serde(rename = "run.event")]
    RunEvent(RunEventMsg),
    #[serde(rename = "run.usage")]
    RunUsage(RunUsage),
    #[serde(rename = "run.completed")]
    RunCompleted(RunCompleted),
    #[serde(rename = "clis.updated")]
    ClisUpdated(ClisUpdated),
    #[serde(rename = "repos.updated")]
    ReposUpdated(ReposUpdated),
    #[serde(rename = "git.diff.result")]
    GitDiffResult(GitDiffResult),
    #[serde(rename = "git.file.result")]
    GitFileResult(GitFileResult),
    #[serde(rename = "git.merge.result")]
    GitMergeResult(GitMergeResult),
    #[serde(rename = "pty.output")]
    PtyOutput(PtyOutput),
    #[serde(rename = "pty.exit")]
    PtyExit(PtyExit),
}

/// Control plane -> runner messages.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", content = "payload")]
pub enum ServerMessage {
    /// Reply to `pair`; the server closes the pairing connection afterwards.
    #[serde(rename = "paired")]
    Paired(Paired),
    #[serde(rename = "welcome")]
    Welcome(Welcome),
    #[serde(rename = "upgrade_required")]
    UpgradeRequired(UpgradeRequired),
    #[serde(rename = "ack")]
    Ack(Ack),
    #[serde(rename = "error")]
    Error(ErrorPayload),
    #[serde(rename = "run.ack")]
    RunAck(RunAck),
    #[serde(rename = "run.start")]
    RunStart(Box<RunStart>),
    #[serde(rename = "run.input")]
    RunInput(RunInput),
    #[serde(rename = "run.resize")]
    RunResize(RunResize),
    #[serde(rename = "run.signal")]
    RunSignal(RunSignal),
    #[serde(rename = "git.diff")]
    GitDiff(GitDiff),
    #[serde(rename = "git.file")]
    GitFile(GitFile),
    #[serde(rename = "git.merge")]
    GitMerge(GitMerge),
    #[serde(rename = "worktree.remove")]
    WorktreeRemove(WorktreeRemove),
    #[serde(rename = "clis.detect")]
    ClisDetect(ClisDetect),
    #[serde(rename = "pty.open")]
    PtyOpen(PtyOpen),
    #[serde(rename = "pty.input")]
    PtyInput(PtyInput),
    #[serde(rename = "pty.resize")]
    PtyResize(PtyResize),
    #[serde(rename = "pty.close")]
    PtyClose(PtyClose),
}

/// Root type used only to emit one schema containing both directions.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProtocolSchemaRoot {
    pub runner_to_server: RunnerEnvelope,
    pub server_to_runner: ServerEnvelope,
}

// ---------------------------------------------------------------------------
// Pairing and handshake
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Pair {
    /// Display name chosen by the user (`--name`), defaults to the hostname.
    pub name: String,
    pub hostname: String,
    pub os: String,
    pub arch: String,
    pub runner_version: String,
    pub keys: RunnerPublicKeys,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Paired {
    pub runner_id: Uuid,
    pub workspace_id: String,
    /// `coffe_rt_…`; sent exactly once, only its SHA-256 hash is stored server-side.
    pub runner_token: String,
    /// Human-readable fingerprint of `keys.sign_public_key` (§14.2).
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Hello {
    /// `"MAJOR.MINOR"`.
    pub protocol: String,
    /// Semver of the runner binary.
    pub runner_version: String,
    pub runner_id: Uuid,
    pub hostname: String,
    /// `linux` | `macos` | `windows`.
    pub os: String,
    /// `x86_64` | `aarch64` | ...
    pub arch: String,
    /// Feature flags: `pty`, `git`, `docker`, `db`, `ssh`, `preview`, `index`.
    pub capabilities: Vec<String>,
    pub policy: RunnerPolicy,
    pub clis: Vec<CliInfo>,
    pub repos: Vec<RepoInfo>,
    /// Runs still alive (or with unacked spool) on this runner.
    pub active_runs: Vec<ActiveRun>,
    pub keys: RunnerPublicKeys,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RunnerPolicy {
    pub max_concurrent_runs: u32,
    /// `None` = every detected CLI is allowed.
    #[serde(default)]
    pub allowed_clis: Option<Vec<String>>,
    pub allow_full_auto: bool,
    pub allow_docker: bool,
    pub allow_db: bool,
    pub allow_db_writes: bool,
    pub allow_ssh: bool,
    /// Inclusive port range string, e.g. `"3000-9999"`.
    pub allow_preview_ports: String,
    pub allow_push: bool,
    pub enable_fake_cli: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RunnerPublicKeys {
    /// X25519 public key (base64), recipient of sealed secrets.
    pub box_public_key: String,
    /// Ed25519 public key (base64), runner identity.
    pub sign_public_key: String,
    /// Ed25519 signature (base64) over the raw 32 bytes of `box_public_key`.
    pub box_key_signature: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ActiveRun {
    pub run_id: Uuid,
    pub status: RunStatus,
    /// Highest seq the runner has emitted for this run.
    pub last_seq: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Welcome {
    pub protocol: String,
    pub server_version: String,
    pub server_time: String,
    pub heartbeat_secs: u32,
    /// Highest persisted seq per run; the runner replays everything above it.
    pub resume: Vec<ResumeCursor>,
    /// Runs the control plane considers finished/cancelled; the runner must stop them.
    pub cancel: Vec<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ResumeCursor {
    pub run_id: Uuid,
    pub ack_seq: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UpgradeRequired {
    pub min_protocol: String,
    pub min_runner_version: String,
    #[serde(default)]
    pub download_url: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Heartbeat {
    pub running_runs: u32,
    #[serde(default)]
    pub load_avg: Option<f32>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Ack {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ErrorPayload {
    /// Stable machine code, e.g. `unsupported_type`, `invalid_payload`, `not_found`,
    /// `scope_violation`, `policy_denied`, `busy`, `internal`.
    pub code: String,
    pub message: String,
}

// ---------------------------------------------------------------------------
// CLIs and repositories
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CliInfo {
    /// Adapter id: `claude-code`, `codex`, `gemini`, `opencode`, `antigravity`, `grok`,
    /// `muse`, `pi`, `kiro`, `fake`.
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub version: Option<String>,
    pub auth: CliAuthStatus,
    pub capabilities: CliCapabilities,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CliAuthStatus {
    Ok,
    Unauthenticated,
    Unknown,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CliCapabilities {
    pub headless: bool,
    pub structured_output: bool,
    pub streaming_input: bool,
    pub resume: bool,
    pub usage_tokens: bool,
    pub usage_cost: bool,
    pub permission_callbacks: bool,
    pub model_select: bool,
    pub tool_filters: bool,
    pub schema_output: bool,
    /// Modes this adapter supports, in preference order.
    pub modes: Vec<RunMode>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RepoInfo {
    /// Stable runner-generated id (never a path).
    pub repo_key: String,
    pub name: String,
    /// Absolute path on the runner machine (display only; never used as input by the server).
    pub path: String,
    #[serde(default)]
    pub default_branch: Option<String>,
    /// Remote URL with any credentials stripped.
    #[serde(default)]
    pub remote_url: Option<String>,
    #[serde(default)]
    pub head_commit: Option<String>,
    /// False when the registered path no longer exists or is not a git repo.
    pub available: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ClisUpdated {
    pub clis: Vec<CliInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ReposUpdated {
    pub repos: Vec<RepoInfo>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ClisDetect {}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Queued,
    Dispatched,
    Starting,
    Running,
    Paused,
    WaitingInput,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

impl RunStatus {
    pub fn is_terminal(self) -> bool {
        matches!(self, RunStatus::Completed | RunStatus::Failed | RunStatus::Cancelled)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RunMode {
    /// Headless/structured protocol; the runner renders events into the terminal stream.
    Structured,
    /// The CLI's own interactive TUI in a PTY.
    Pty,
}

/// Which structured protocol to use with the CLI (only meaningful for `RunMode::Structured`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RunDriver {
    /// The CLI's own headless JSON stream (default).
    #[default]
    Native,
    /// Agent Client Protocol over stdio (live permission prompts, steering, cancel).
    Acp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RunKind {
    Ticket,
    Planning,
    Wiki,
    QueryAssist,
    Canvas,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeMode {
    /// `git worktree add -b <branch>` (reused when it already exists).
    Branch,
    /// Detached, read-only scratch worktree at `base_branch` (planning/wiki/query runs).
    Detached,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WorktreeSpec {
    pub mode: WorktreeMode,
    /// Required for `branch` mode, e.g. `coffe/COF-12`.
    #[serde(default)]
    pub branch: Option<String>,
    pub base_branch: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WorktreeInfo {
    pub path: String,
    #[serde(default)]
    pub branch: Option<String>,
    pub base_branch: String,
    pub base_commit: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct TermSize {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    ReadOnly,
    WorkspaceWrite,
    FullAuto,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PermissionPolicy {
    pub mode: PermissionMode,
    #[serde(default)]
    pub allow_tools: Vec<String>,
    #[serde(default)]
    pub deny_tools: Vec<String>,
    pub network: bool,
    #[serde(default)]
    pub max_turns: Option<u32>,
    #[serde(default)]
    pub max_budget_usd: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ContextFile {
    /// File name inside `<worktree>/.coffe/context/`, e.g. `01-rules.md`.
    pub name: String,
    /// UTF-8 markdown/text content.
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ContextAttachment {
    /// File name inside `<worktree>/.coffe/context/attachments/`.
    pub name: String,
    pub mime: String,
    /// Base64 content.
    pub data: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ContextBundle {
    pub files: Vec<ContextFile>,
    #[serde(default)]
    pub attachments: Vec<ContextAttachment>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PersonaRef {
    pub id: Uuid,
    pub name: String,
    pub role: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ResumeSpec {
    pub cli_session_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RunStart {
    pub run_id: Uuid,
    pub kind: RunKind,
    pub project_id: Uuid,
    #[serde(default)]
    pub ticket_key: Option<String>,
    pub repo_key: String,
    pub worktree: WorktreeSpec,
    pub cli_id: String,
    #[serde(default)]
    pub model: Option<String>,
    pub mode: RunMode,
    /// Structured protocol; absent = `native`.
    #[serde(default)]
    pub driver: Option<RunDriver>,
    /// The task prompt (context is delivered separately in `context`).
    pub prompt: String,
    pub context: ContextBundle,
    pub permissions: PermissionPolicy,
    #[serde(default)]
    pub persona: Option<PersonaRef>,
    #[serde(default)]
    pub resume: Option<ResumeSpec>,
    pub timeout_secs: u64,
    pub terminal: TermSize,
    /// JSON Schema the final answer must satisfy (planning runs).
    #[serde(default)]
    pub output_schema: Option<serde_json::Value>,
    /// Commit all changes after the run (ticket runs).
    pub auto_commit: bool,
    #[serde(default)]
    pub commit_message: Option<String>,
    /// Shell command run in the worktree after a successful run (review gate test results).
    #[serde(default)]
    pub test_command: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RunState {
    pub run_id: Uuid,
    pub seq: u64,
    pub status: RunStatus,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub cli_session_id: Option<String>,
    #[serde(default)]
    pub worktree: Option<WorktreeInfo>,
    /// Set with `interrupted`: whether the CLI session can be resumed.
    #[serde(default)]
    pub resumable: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RunOutput {
    pub run_id: Uuid,
    pub seq: u64,
    /// Base64 terminal bytes (raw PTY output or rendered transcript).
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RunEventMsg {
    pub run_id: Uuid,
    pub seq: u64,
    pub event: AgentEvent,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RunUsage {
    pub run_id: Uuid,
    pub seq: u64,
    /// Cumulative usage for the run so far.
    pub usage: Usage,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RunCompleted {
    pub run_id: Uuid,
    pub seq: u64,
    /// `completed` | `failed` | `cancelled`.
    pub status: RunStatus,
    #[serde(default)]
    pub exit_code: Option<i32>,
    /// Final assistant result / summary text.
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub cli_session_id: Option<String>,
    #[serde(default)]
    pub head_commit: Option<String>,
    #[serde(default)]
    pub diff: Option<DiffSummary>,
    #[serde(default)]
    pub tests: Option<TestReport>,
    #[serde(default)]
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RunAck {
    pub run_id: Uuid,
    /// Cumulative: every message with `seq <= ack` is persisted.
    pub seq: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RunInput {
    pub run_id: Uuid,
    pub input: AgentInput,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RunResize {
    pub run_id: Uuid,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RunSignalKind {
    Pause,
    Resume,
    Interrupt,
    Stop,
    Kill,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RunSignal {
    pub run_id: Uuid,
    pub signal: RunSignalKind,
}

// ---------------------------------------------------------------------------
// Agent events (normalized across CLIs) and inputs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MessageRole {
    Assistant,
    User,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    Read,
    Edit,
    Execute,
    Search,
    Fetch,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PlanItem {
    pub text: String,
    /// `pending` | `in_progress` | `completed`.
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentEvent {
    SessionStarted {
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        tools: Vec<String>,
    },
    /// A complete message.
    Message { role: MessageRole, text: String },
    /// Streaming text delta of the current assistant message.
    MessageDelta { text: String },
    Thinking { text: String },
    ToolCall {
        call_id: String,
        name: String,
        tool_kind: ToolKind,
        /// Tool input as reported by the CLI.
        input: serde_json::Value,
        #[serde(default)]
        title: Option<String>,
    },
    ToolResult {
        call_id: String,
        ok: bool,
        /// Truncated to 16 KiB by the runner.
        output: String,
    },
    FileChange { path: String, change: String },
    Plan { items: Vec<PlanItem> },
    PermissionRequest {
        request_id: String,
        tool: String,
        description: String,
        options: Vec<String>,
    },
    Usage { usage: Usage },
    TurnCompleted {
        #[serde(default)]
        result: Option<String>,
        is_error: bool,
        #[serde(default)]
        duration_ms: Option<u64>,
        #[serde(default)]
        num_turns: Option<u32>,
    },
    Error { message: String },
    /// Unparsed output (PTY mode, unknown structured lines).
    Raw { text: String },
    /// Output was dropped because the spool overflowed.
    Gap { dropped_bytes: u64 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentInput {
    /// A user message / follow-up turn.
    Text { text: String },
    /// Raw keystrokes for PTY mode (UTF-8 string as produced by xterm.js `onData`).
    Keys { data: String },
    /// Answer to a `permission_request` event.
    Permission {
        request_id: String,
        allow: bool,
        #[serde(default)]
        remember: bool,
    },
    /// Cancel the current turn without ending the session.
    Interrupt,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Usage {
    /// False when the CLI exposes no usage data at all (counts are then zero and meaningless).
    pub available: bool,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub reasoning_tokens: u64,
    /// Only when the CLI itself reports cost; estimates are computed by the control plane.
    #[serde(default)]
    pub cost_usd: Option<f64>,
    #[serde(default)]
    pub model: Option<String>,
    /// CLI-reported duration (API or wall time), when available.
    #[serde(default)]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub num_turns: Option<u32>,
    /// Vendor credits consumed (CLIs that meter in credits instead of tokens, e.g. Kiro).
    #[serde(default)]
    pub credits: Option<f64>,
}

// ---------------------------------------------------------------------------
// Git / review
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Unmerged,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DiffFile {
    pub path: String,
    #[serde(default)]
    pub old_path: Option<String>,
    pub status: FileStatus,
    /// `None` for binary files.
    #[serde(default)]
    pub additions: Option<u64>,
    #[serde(default)]
    pub deletions: Option<u64>,
    pub binary: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DiffSummary {
    pub base_commit: String,
    pub head_commit: String,
    pub files: Vec<DiffFile>,
    pub additions: u64,
    pub deletions: u64,
    /// Unified patch (`git diff base...head`), capped at 2 MiB.
    pub patch: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TestSource {
    Command,
    Agent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TestStatus {
    Passed,
    Failed,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TestFailure {
    pub name: String,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TestReport {
    pub source: TestSource,
    #[serde(default)]
    pub command: Option<String>,
    pub status: TestStatus,
    pub passed: u32,
    pub failed: u32,
    pub skipped: u32,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub failures: Vec<TestFailure>,
    /// Last ~8 KiB of the test command output.
    #[serde(default)]
    pub output_tail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct GitDiff {
    pub repo_key: String,
    pub branch: String,
    /// Defaults to the branch's recorded base.
    #[serde(default)]
    pub base: Option<String>,
    pub include_patch: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct GitDiffResult {
    pub diff: DiffSummary,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct GitFile {
    pub repo_key: String,
    /// Commit SHA or ref.
    pub rev: String,
    /// Repo-relative path.
    pub path: String,
    pub max_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct GitFileResult {
    pub path: String,
    pub rev: String,
    /// Base64 content; `None` when missing, binary or too large.
    #[serde(default)]
    pub content: Option<String>,
    pub size: u64,
    pub binary: bool,
    pub too_large: bool,
    pub missing: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MergeStrategy {
    FfOnly,
    Merge,
    Squash,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct GitMerge {
    pub repo_key: String,
    pub branch: String,
    pub into: String,
    pub strategy: MergeStrategy,
    pub message: String,
    pub push: bool,
    #[serde(default)]
    pub remote: Option<String>,
    pub remove_worktree: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MergeStatus {
    Merged,
    Conflict,
    Failed,
    NothingToMerge,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct GitMergeResult {
    pub status: MergeStatus,
    #[serde(default)]
    pub merge_commit: Option<String>,
    pub pushed: bool,
    #[serde(default)]
    pub conflicts: Vec<String>,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WorktreeRemove {
    pub repo_key: String,
    pub branch: String,
    pub delete_branch: bool,
}

// ---------------------------------------------------------------------------
// Plain PTY sessions (human shell in a worktree; SSH/container in phase 3)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PtyTarget {
    /// Shell in a ticket worktree.
    Worktree { repo_key: String, branch: String },
    /// Shell in the registered repo root.
    Repo { repo_key: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PtyOpen {
    pub session_id: Uuid,
    pub target: PtyTarget,
    #[serde(default)]
    pub shell: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PtyInput {
    pub session_id: Uuid,
    /// UTF-8 keystrokes.
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PtyResize {
    pub session_id: Uuid,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PtyClose {
    pub session_id: Uuid,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PtyOutput {
    pub session_id: Uuid,
    pub seq: u64,
    /// Base64 bytes.
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PtyExit {
    pub session_id: Uuid,
    #[serde(default)]
    pub exit_code: Option<i32>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Parse `"MAJOR.MINOR"`.
pub fn parse_protocol_version(v: &str) -> Option<(u16, u16)> {
    let (major, minor) = v.split_once('.')?;
    Some((major.parse().ok()?, minor.parse().ok()?))
}

/// Compatibility rule shared by both sides: same major, peer minor >= `min_minor`.
pub fn is_compatible(peer: &str, min_minor: u16) -> bool {
    matches!(parse_protocol_version(peer), Some((major, minor)) if major == PROTOCOL_MAJOR && minor >= min_minor)
}
