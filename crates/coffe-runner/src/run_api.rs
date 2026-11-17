//! Internal contract between the daemon (connection, spool, message dispatch) and the run
//! supervisor (processes, adapters, git post-processing).
//!
//! Flow: the daemon receives `run.start`, checks capacity, creates a per-run emitter channel and
//! calls [`crate::supervisor::start_run`]. The supervisor sends [`RunEmit`] items; the daemon's
//! run stream assigns `seq`, coalesces output (16 ms / 32 KiB), spools, journals and sends them
//! as `run.*` frames. The daemon forwards `run.input` / `run.resize` / `run.signal` as
//! [`RunControl`] through [`RunHandle::control`].

use std::path::PathBuf;

use coffe_adapters::AdapterRegistry;
use coffe_protocol::{
    AgentEvent, AgentInput, DiffSummary, RunSignalKind, RunStatus, TestReport, Usage, WorktreeInfo,
};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::config::RunnerConfig;
use crate::detect::DetectedEntry;
use crate::paths::RunnerHome;

/// `run.state` without `run_id` / `seq` (filled in by the run stream).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RunStateUpdate {
    pub status: Option<RunStatus>,
    pub detail: Option<String>,
    pub exit_code: Option<i32>,
    pub cli_session_id: Option<String>,
    pub worktree: Option<WorktreeInfo>,
    pub resumable: Option<bool>,
}

/// `run.completed` without `run_id` / `seq`. `status` is `Completed`, `Failed` or `Cancelled`.
#[derive(Debug, Clone, PartialEq)]
pub struct RunCompletion {
    pub status: RunStatus,
    pub exit_code: Option<i32>,
    pub summary: Option<String>,
    pub error: Option<String>,
    pub cli_session_id: Option<String>,
    pub head_commit: Option<String>,
    pub diff: Option<DiffSummary>,
    pub tests: Option<TestReport>,
    pub usage: Option<Usage>,
}

/// Everything a run reports, in order. `Completed` is always the last item.
#[derive(Debug, Clone, PartialEq)]
pub enum RunEmit {
    State(RunStateUpdate),
    /// Terminal bytes: raw PTY output, or rendered events in structured mode.
    Output(Vec<u8>),
    Event(AgentEvent),
    /// Cumulative usage.
    Usage(Usage),
    Completed(RunCompletion),
}

pub type RunEmitter = mpsc::UnboundedSender<RunEmit>;

/// Commands for a live run.
#[derive(Debug, Clone, PartialEq)]
pub enum RunControl {
    Input(AgentInput),
    Resize { cols: u16, rows: u16 },
    Signal(RunSignalKind),
}

/// What the supervisor needs to start a run.
#[derive(Clone)]
pub struct RunContext {
    pub home: RunnerHome,
    /// Snapshot of `runner.toml` (policy + repo registry) at dispatch time.
    pub config: RunnerConfig,
    pub registry: AdapterRegistry,
    /// Detected CLIs (binary path + version per `cli_id`).
    pub clis: Vec<DetectedEntry>,
    /// Directory containing `coffe-fake-cli` when it is not on `PATH` (tests); optional.
    pub extra_bin_dir: Option<PathBuf>,
}

/// A started run. Dropping `control` does not stop the run; send `RunControl::Signal(Kill)`.
pub struct RunHandle {
    pub run_id: Uuid,
    pub control: mpsc::UnboundedSender<RunControl>,
    /// Finishes after `RunEmit::Completed` was sent.
    pub task: JoinHandle<()>,
}
