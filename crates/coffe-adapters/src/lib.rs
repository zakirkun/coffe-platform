//! CLI adapters: one implementation per agentic coding CLI behind a uniform interface.
//!
//! Adapters are pure translators. They build launch plans, encode user input and parse
//! output into normalized [`AgentEvent`]s. The runner's generic supervisor owns processes,
//! PTYs, signals, timeouts and I/O, so every adapter can be tested with recorded fixtures
//! and the fake CLI, without a real agent installed.

use std::any::Any;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

pub use coffe_protocol::{
    AgentEvent, AgentInput, CliAuthStatus, CliCapabilities, CliInfo, PermissionMode,
    PermissionPolicy, RunDriver, RunMode, TermSize, ToolKind, Usage,
};
use uuid::Uuid;

pub mod acp;
pub mod adapters;
pub mod line_buffer;
pub mod registry;
pub mod render;

pub use line_buffer::LineBuffer;
pub use registry::AdapterRegistry;

/// How project/persona/ticket context reaches the CLI (besides the files written into
/// `<worktree>/.coffe/context/`, which every adapter gets).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Injection {
    /// A flag such as `--append-system-prompt`.
    SystemPromptFlag,
    /// A CLI-specific instructions file or config override.
    InstructionsFile,
    /// Prepended to the prompt text.
    PromptPreamble,
}

/// Wire protocol spoken with the CLI process in structured mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireProtocol {
    /// Newline-delimited JSON events on stdout (optionally JSON input on stdin).
    JsonLines,
    /// Agent Client Protocol (JSON-RPC 2.0 over stdio).
    Acp,
    /// CLI-specific JSON-RPC over stdio (e.g. an app-server mode).
    JsonRpc,
    /// No structured mode: the TUI runs in a PTY.
    RawPty,
}

/// Static description of an adapter.
#[derive(Debug, Clone)]
pub struct AdapterInfo {
    /// Stable id, also used as `cli_id` on the wire.
    pub id: &'static str,
    pub name: &'static str,
    /// Candidate executable names, in lookup order.
    pub binaries: &'static [&'static str],
    pub capabilities: CliCapabilities,
    pub injection: Injection,
    pub wire: WireProtocol,
    /// Official documentation the adapter was written against.
    pub docs_url: &'static str,
    /// CLI versions the fixtures were recorded with (informational, shown in `doctor`).
    pub tested_versions: &'static str,
}

/// Result of a probe command.
#[derive(Debug, Clone, Default)]
pub struct ProbeOutput {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Side-effect boundary for detection (mockable in tests).
pub trait Probe: Send + Sync {
    /// Resolve an executable on `PATH` (plus well-known install dirs).
    fn which(&self, binary: &str) -> Option<PathBuf>;
    /// Run a short, non-consuming command (e.g. `--version`) with a timeout.
    fn run(&self, program: &Path, args: &[&str], timeout: Duration) -> Option<ProbeOutput>;
    fn env(&self, key: &str) -> Option<String>;
    fn home_dir(&self) -> Option<PathBuf>;
}

#[derive(Debug, Clone, PartialEq)]
pub struct DetectedCli {
    pub path: PathBuf,
    pub version: Option<String>,
    pub auth: CliAuthStatus,
}

/// Context files already written by the runner before `start` is called.
#[derive(Debug, Clone, Default)]
pub struct ContextFiles {
    /// `<worktree>/.coffe/context`
    pub dir: PathBuf,
    /// Absolute paths of the written files (markdown first, then attachments).
    pub files: Vec<PathBuf>,
    /// All markdown context concatenated (for system-prompt injection).
    pub combined_markdown: String,
}

/// Everything an adapter needs to launch a run.
#[derive(Debug, Clone)]
pub struct RunSpec {
    pub run_id: Uuid,
    /// Resolved executable (from detection).
    pub program: PathBuf,
    /// Worktree directory.
    pub cwd: PathBuf,
    pub mode: RunMode,
    /// Structured protocol to use when `mode` is `Structured` (`RunStart.driver`, default native).
    /// Adapters without an ACP implementation return `AdapterError::Unsupported` for `Acp`.
    pub driver: RunDriver,
    /// Version reported by detection (e.g. to choose OpenCode V1 vs V2 flags).
    pub cli_version: Option<String>,
    pub prompt: String,
    pub context: ContextFiles,
    pub model: Option<String>,
    pub permissions: PermissionPolicy,
    pub resume_session_id: Option<String>,
    pub output_schema: Option<serde_json::Value>,
    pub terminal: TermSize,
    /// Extra environment (e.g. git push blocking), merged by the supervisor.
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IoMode {
    Pty { cols: u16, rows: u16 },
    Pipes,
}

/// What the supervisor must spawn.
#[derive(Debug, Clone)]
pub struct LaunchPlan {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: PathBuf,
    pub io: IoMode,
    /// Bytes written to stdin right after spawn.
    pub initial_stdin: Vec<u8>,
    /// Close stdin after `initial_stdin` (one-shot CLIs that wait for EOF).
    pub close_stdin: bool,
    /// Files to write before spawning (absolute paths inside the worktree's `.coffe/`).
    pub files: Vec<(PathBuf, Vec<u8>)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sig {
    Interrupt,
    Terminate,
    Kill,
    Stop,
    Continue,
}

/// An action the supervisor performs on the adapter's behalf.
#[derive(Debug, Clone)]
pub enum IoAction {
    Write(Vec<u8>),
    CloseStdin,
    Signal(Sig),
    /// Start a new process (e.g. a follow-up turn via the CLI's resume flag) once the
    /// current one exited; output continues on the same run stream.
    Respawn(Box<LaunchPlan>),
    /// The input cannot be delivered with this CLI/mode; shown to the user.
    Unsupported(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopMode {
    /// Cancel the current turn, keep the session.
    InterruptTurn,
    /// End the session gracefully.
    Graceful,
    /// Immediate kill.
    Kill,
}

#[derive(Debug, Clone)]
pub struct StopStep {
    pub action: IoAction,
    /// How long to wait for the process to exit before the next step.
    pub wait: Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamKind {
    Stdout,
    Stderr,
    /// Merged PTY output.
    Pty,
}

/// Per-run parser/session state owned by the supervisor and threaded through every call.
pub struct SessionState {
    pub run_id: Uuid,
    pub mode: RunMode,
    /// CLI session id once known (enables resume).
    pub session_id: Option<String>,
    /// Cumulative usage.
    pub usage: Usage,
    /// Protocol replies the adapter wants written (ACP/JSON-RPC handshakes); drained by the
    /// supervisor after every `parse_events` call.
    pub outbox: Vec<IoAction>,
    pub stdout_lines: LineBuffer,
    pub stderr_lines: LineBuffer,
    /// Final result text of the last completed turn.
    pub result_text: Option<String>,
    /// Set when the CLI reported the end of the run/turn.
    pub turn_completed: bool,
    /// Adapter-specific state.
    pub ext: Box<dyn Any + Send>,
}

impl SessionState {
    pub fn new(run_id: Uuid, mode: RunMode) -> Self {
        Self {
            run_id,
            mode,
            session_id: None,
            usage: Usage::default(),
            outbox: Vec::new(),
            stdout_lines: LineBuffer::default(),
            stderr_lines: LineBuffer::default(),
            result_text: None,
            turn_completed: false,
            ext: Box::new(()),
        }
    }

    pub fn with_ext<T: Any + Send>(mut self, ext: T) -> Self {
        self.ext = Box::new(ext);
        self
    }

    pub fn ext<T: Any + Send>(&self) -> Option<&T> {
        self.ext.downcast_ref::<T>()
    }

    pub fn ext_mut<T: Any + Send>(&mut self) -> Option<&mut T> {
        self.ext.downcast_mut::<T>()
    }

    pub fn take_outbox(&mut self) -> Vec<IoAction> {
        std::mem::take(&mut self.outbox)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AdapterError {
    #[error("unsupported: {0}")]
    Unsupported(String),
    #[error("invalid run spec: {0}")]
    InvalidSpec(String),
    #[error("{0}")]
    Other(String),
}

/// Uniform interface every CLI adapter implements: detect, start, send_input, stop,
/// parse_events, get_usage.
pub trait CliAdapter: Send + Sync + 'static {
    /// Static identity + capability matrix (shown in the UI).
    fn info(&self) -> &AdapterInfo;

    /// Locate the binary and read its version without consuming tokens.
    fn detect(&self, probe: &dyn Probe) -> Option<DetectedCli>;

    /// Translate a run request into a launch plan + fresh per-session state.
    fn start(&self, spec: &RunSpec) -> Result<(LaunchPlan, SessionState), AdapterError>;

    /// Encode user input (follow-up message, raw keys, permission decision, interrupt)
    /// into I/O actions for the supervisor.
    fn send_input(
        &self,
        session: &mut SessionState,
        input: AgentInput,
    ) -> Result<Vec<IoAction>, AdapterError>;

    /// Ordered, adapter-specific stop procedure.
    fn stop(&self, session: &mut SessionState, mode: StopMode) -> Vec<StopStep>;

    /// Incremental parser: raw output bytes in, normalized events out. Replies the adapter
    /// must send are queued in `session.outbox`.
    fn parse_events(
        &self,
        session: &mut SessionState,
        stream: StreamKind,
        chunk: &[u8],
    ) -> Vec<AgentEvent>;

    /// Cumulative usage so far (from parsed events or post-run artifacts).
    fn get_usage(&self, session: &SessionState) -> Option<Usage>;
}

pub type SharedAdapter = Arc<dyn CliAdapter>;

/// Default graceful stop used by most adapters: SIGINT, wait, SIGTERM, wait, SIGKILL.
pub fn default_stop_steps(mode: StopMode) -> Vec<StopStep> {
    match mode {
        StopMode::InterruptTurn => vec![StopStep { action: IoAction::Signal(Sig::Interrupt), wait: Duration::from_secs(0) }],
        StopMode::Graceful => vec![
            StopStep { action: IoAction::Signal(Sig::Interrupt), wait: Duration::from_secs(3) },
            StopStep { action: IoAction::Signal(Sig::Terminate), wait: Duration::from_secs(5) },
            StopStep { action: IoAction::Signal(Sig::Kill), wait: Duration::from_secs(0) },
        ],
        StopMode::Kill => vec![StopStep { action: IoAction::Signal(Sig::Kill), wait: Duration::from_secs(0) }],
    }
}

/// PTY-mode input encoding shared by adapters: text becomes keystrokes + Enter.
pub fn pty_input(input: AgentInput) -> Result<Vec<IoAction>, AdapterError> {
    match input {
        AgentInput::Text { text } => {
            let mut bytes = text.into_bytes();
            bytes.push(b'\r');
            Ok(vec![IoAction::Write(bytes)])
        }
        AgentInput::Keys { data } => Ok(vec![IoAction::Write(data.into_bytes())]),
        AgentInput::Interrupt => Ok(vec![IoAction::Write(vec![0x03])]),
        AgentInput::Permission { .. } => Ok(vec![IoAction::Unsupported(
            "permission answers must be typed into the terminal in PTY mode".into(),
        )]),
    }
}
