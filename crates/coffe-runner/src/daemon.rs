//! The runner daemon (`coffe-runner start`): keeps the outbound connection alive, performs the
//! `hello` / `welcome` handshake, replays spooled run frames, and dispatches control-plane
//! commands to the supervisor, git and PTY sessions (architecture §7, §8).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use coffe_adapters::AdapterRegistry;
use coffe_protocol::{
    Ack, ActiveRun, ClisUpdated, ErrorPayload, GitDiffResult, Heartbeat, Hello, PROTOCOL_VERSION,
    PtyTarget, ReposUpdated, RunStart, RunStatus, RunnerMessage, ServerEnvelope, ServerMessage,
    Welcome, close_codes,
};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

use crate::backoff::{Backoff, STABLE_AFTER};
use crate::config::RunnerConfig;
use crate::connection::{self, ConnectError, WsStream};
use crate::detect::{self, DetectedEntry, SystemProbe};
use crate::envelope;
use crate::error::RunnerError;
use crate::git;
use crate::paths::RunnerHome;
use crate::pty_session::PtySessions;
use crate::repos;
use crate::run_api::{RunCompletion, RunContext, RunControl, RunEmit, RunStateUpdate};
use crate::secrets::{RunnerKeys, SecretStore};
use crate::spool::{self, Outbound, RunSpool, RunStream, SharedSpool};
use crate::supervisor;

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

/// Why the daemon stopped for good.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DaemonExit {
    /// The runner token was revoked or is unknown (close 4001 / HTTP 401): pair again.
    Revoked,
    /// Another process connected with the same token (close 4002).
    Replaced,
    /// This runner is too old for the control plane (close 4010).
    UpgradeRequired(String),
}

enum SessionEnd {
    Exit(DaemonExit),
    Disconnected(String),
}

pub struct DaemonOptions {
    pub home: RunnerHome,
    /// Directory holding `coffe-fake-cli` when it is not on PATH (tests, demos).
    pub extra_bin_dir: Option<PathBuf>,
}

struct LiveRun {
    control: mpsc::UnboundedSender<RunControl>,
}

pub struct Daemon {
    home: RunnerHome,
    server_url: String,
    runner_id: Uuid,
    token: String,
    keys: RunnerKeys,
    config: RwLock<RunnerConfig>,
    registry: AdapterRegistry,
    clis: RwLock<Vec<DetectedEntry>>,
    live: Mutex<HashMap<Uuid, LiveRun>>,
    spools: Mutex<HashMap<Uuid, SharedSpool>>,
    outbound: Outbound,
    pty: PtySessions,
    extra_bin_dir: Option<PathBuf>,
}

impl Daemon {
    /// Loads configuration, secrets and pending runs. Fails when the runner is not paired.
    pub fn new(options: DaemonOptions) -> anyhow::Result<Arc<Self>> {
        let config = RunnerConfig::load(&options.home.config_file())?;
        let pairing = config
            .pairing()
            .ok_or_else(|| anyhow::anyhow!("this runner is not paired; run `coffe-runner pair` first"))?;
        let secrets = SecretStore::new(options.home.secrets_dir());
        let token = secrets
            .load_token()?
            .ok_or_else(|| anyhow::anyhow!("no runner token found; run `coffe-runner pair` again"))?;
        let keys = secrets
            .load_keys()?
            .ok_or_else(|| anyhow::anyhow!("runner keys are missing; run `coffe-runner pair` again"))?;
        let registry = AdapterRegistry::builtin(config.policy.enable_fake_cli);
        let outbound = Outbound::default();
        let (pty_tx, mut pty_rx) = mpsc::unbounded_channel::<RunnerMessage>();
        let daemon = Arc::new(Self {
            home: options.home,
            server_url: pairing.server_url,
            runner_id: pairing.runner_id,
            token,
            keys,
            config: RwLock::new(config),
            registry,
            clis: RwLock::new(Vec::new()),
            live: Mutex::new(HashMap::new()),
            spools: Mutex::new(HashMap::new()),
            outbound: outbound.clone(),
            pty: PtySessions::new(pty_tx),
            extra_bin_dir: options.extra_bin_dir,
        });
        // PTY shell output is not spooled: it goes out when connected and is dropped otherwise.
        tokio::spawn(async move {
            while let Some(msg) = pty_rx.recv().await {
                outbound.send(msg);
            }
        });
        Ok(daemon)
    }

    /// Runs until the token is revoked, the runner is replaced or must be upgraded.
    pub async fn run(self: Arc<Self>) -> anyhow::Result<DaemonExit> {
        self.detect_clis().await;
        self.recover_runs()?;
        let mut backoff = Backoff::default();
        loop {
            match connection::connect(&self.server_url, &self.token).await {
                Ok(ws) => {
                    let connected_at = Instant::now();
                    tracing::info!("connected to {}", self.server_url);
                    let end = self.clone().session(ws).await;
                    self.outbound.set(None);
                    match end {
                        SessionEnd::Exit(exit) => return Ok(exit),
                        SessionEnd::Disconnected(reason) => {
                            tracing::warn!("disconnected: {reason}");
                            if connected_at.elapsed() >= STABLE_AFTER {
                                backoff.reset();
                            }
                        }
                    }
                }
                Err(ConnectError::Unauthorized { message, .. }) => {
                    tracing::error!("the control plane rejected this runner: {message}");
                    return Ok(DaemonExit::Revoked);
                }
                Err(err) => tracing::warn!("{err}"),
            }
            let delay = backoff.next_delay();
            tracing::info!("reconnecting in {:.1}s", delay.as_secs_f64());
            tokio::time::sleep(delay).await;
        }
    }

    async fn detect_clis(&self) {
        let registry = self.registry.clone();
        let policy = self.config_snapshot().policy;
        let found = tokio::task::spawn_blocking(move || {
            detect::detect_all(&registry, &SystemProbe::new(), |id| policy.cli_allowed(id))
        })
        .await
        .unwrap_or_default();
        if let Ok(mut clis) = self.clis.write() {
            *clis = found;
        }
    }

    /// Reopens spools left by a previous process; runs that were alive are now `interrupted`.
    fn recover_runs(&self) -> anyhow::Result<()> {
        for run_id in spool::list_runs(&self.home.runs_dir())? {
            let spool = RunSpool::open(&self.home.runs_dir(), run_id)?;
            if spool.is_settled() {
                spool.remove()?;
                continue;
            }
            let journal = spool.journal().clone();
            let shared: SharedSpool = Arc::new(Mutex::new(spool));
            if !journal.completed && journal.status != Some(RunStatus::Interrupted) {
                let mut stream = RunStream::new(shared.clone(), self.outbound.clone());
                stream.handle(RunEmit::State(RunStateUpdate {
                    status: Some(RunStatus::Interrupted),
                    detail: Some("the runner restarted while the run was active".to_owned()),
                    cli_session_id: journal.cli_session_id.clone(),
                    resumable: Some(journal.cli_session_id.is_some()),
                    ..RunStateUpdate::default()
                }));
            }
            self.lock_spools().insert(run_id, shared);
        }
        Ok(())
    }

    async fn session(self: Arc<Self>, ws: WsStream) -> SessionEnd {
        let (mut sink, mut stream) = ws.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let writer = tokio::spawn(async move {
            while let Some(text) = rx.recv().await {
                if sink.send(Message::Text(text.into())).await.is_err() {
                    break;
                }
            }
            let _ = sink.close().await;
        });

        let hello = match self.build_hello().await {
            Ok(hello) => hello,
            Err(err) => return SessionEnd::Disconnected(format!("cannot build hello: {err}")),
        };
        let _ = tx.send(envelope::encode(RunnerMessage::Hello(hello), None));

        let welcome = tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
            while let Some(message) = stream.next().await {
                match message {
                    Ok(Message::Text(text)) => match envelope::decode(text.as_str()) {
                        Ok(ServerEnvelope { msg: ServerMessage::Welcome(welcome), .. }) => return Ok(welcome),
                        Ok(ServerEnvelope { msg: ServerMessage::UpgradeRequired(up), .. }) => {
                            return Err(SessionEnd::Exit(DaemonExit::UpgradeRequired(format!(
                                "{} (minimum runner {}, protocol {})",
                                up.message, up.min_runner_version, up.min_protocol
                            ))));
                        }
                        Ok(ServerEnvelope { msg: ServerMessage::Error(err), .. }) => {
                            tracing::error!("handshake rejected: {} ({})", err.message, err.code);
                        }
                        _ => {}
                    },
                    Ok(Message::Close(frame)) => return Err(close_end(frame.map(|f| (u16::from(f.code), f.reason.to_string())))),
                    Ok(_) => {}
                    Err(err) => return Err(SessionEnd::Disconnected(err.to_string())),
                }
            }
            Err(SessionEnd::Disconnected("closed during the handshake".to_owned()))
        })
        .await;
        let welcome = match welcome {
            Ok(Ok(welcome)) => welcome,
            Ok(Err(end)) => {
                writer.abort();
                return end;
            }
            Err(_) => {
                writer.abort();
                return SessionEnd::Disconnected("no welcome within 15 s".to_owned());
            }
        };
        self.apply_welcome(&welcome, &tx);
        self.outbound.set(Some(tx.clone()));

        let heartbeat_tx = tx.clone();
        let heartbeat_daemon = self.clone();
        let heartbeat = tokio::spawn(async move {
            let mut interval = tokio::time::interval(HEARTBEAT_INTERVAL);
            interval.tick().await;
            loop {
                interval.tick().await;
                let running = heartbeat_daemon.lock_live().len() as u32;
                let frame = envelope::encode(RunnerMessage::Heartbeat(Heartbeat { running_runs: running, load_avg: None }), None);
                if heartbeat_tx.send(frame).is_err() {
                    break;
                }
            }
        });

        let end = loop {
            match stream.next().await {
                Some(Ok(Message::Text(text))) => match envelope::decode(text.as_str()) {
                    Ok(frame) => self.clone().dispatch(frame, &tx),
                    Err(unparsed) => {
                        let error = match unparsed.message_type {
                            Some(kind) => ErrorPayload { code: "unsupported_type".to_owned(), message: format!("{kind} is not supported by this runner") },
                            None => ErrorPayload { code: "invalid_payload".to_owned(), message: unparsed.error },
                        };
                        let _ = tx.send(envelope::encode(RunnerMessage::Error(error), unparsed.id));
                    }
                },
                Some(Ok(Message::Close(frame))) => break close_end(frame.map(|f| (u16::from(f.code), f.reason.to_string()))),
                Some(Ok(_)) => {}
                Some(Err(err)) => break SessionEnd::Disconnected(err.to_string()),
                None => break SessionEnd::Disconnected("connection closed".to_owned()),
            }
        };
        heartbeat.abort();
        writer.abort();
        end
    }

    async fn build_hello(&self) -> anyhow::Result<Hello> {
        let config = self.config_snapshot();
        let entries = config.repos.clone();
        let repos = tokio::task::spawn_blocking(move || entries.iter().map(repos::describe).collect::<Vec<_>>()).await?;
        let clis = self.clis.read().map(|c| c.iter().map(|e| e.info.clone()).collect()).unwrap_or_default();
        let active_runs = self
            .lock_spools()
            .iter()
            .filter_map(|(run_id, spool)| {
                let spool = spool.lock().ok()?;
                Some(ActiveRun {
                    run_id: *run_id,
                    status: spool.journal().status.unwrap_or(RunStatus::Starting),
                    last_seq: spool.last_seq(),
                })
            })
            .collect();
        Ok(Hello {
            protocol: PROTOCOL_VERSION.to_owned(),
            runner_version: env!("CARGO_PKG_VERSION").to_owned(),
            runner_id: self.runner_id,
            hostname: gethostname::gethostname().to_string_lossy().into_owned(),
            os: std::env::consts::OS.to_owned(),
            arch: std::env::consts::ARCH.to_owned(),
            capabilities: vec!["pty".to_owned(), "git".to_owned()],
            policy: config.policy.to_wire(),
            clis,
            repos,
            active_runs,
            keys: self.keys.public_keys()?,
        })
    }

    /// Replays unacked frames and stops runs the control plane considers finished.
    fn apply_welcome(&self, welcome: &Welcome, tx: &mpsc::UnboundedSender<String>) {
        let cursors: HashMap<Uuid, u64> = welcome.resume.iter().map(|c| (c.run_id, c.ack_seq)).collect();
        let spools: Vec<(Uuid, SharedSpool)> = self.lock_spools().iter().map(|(id, s)| (*id, s.clone())).collect();
        for (run_id, shared) in spools {
            let Ok(mut spool) = shared.lock() else { continue };
            let ack = cursors.get(&run_id).copied().unwrap_or(0);
            if let Err(err) = spool.ack(ack) {
                tracing::warn!(%run_id, "spool ack failed: {err}");
            }
            for msg in spool.replay(ack) {
                let _ = tx.send(envelope::encode(msg, None));
            }
        }
        for run_id in &welcome.cancel {
            if let Some(run) = self.lock_live().get(run_id) {
                let _ = run.control.send(RunControl::Signal(coffe_protocol::RunSignalKind::Kill));
                continue;
            }
            // Finished from the control plane's point of view: nothing left to deliver.
            if self.lock_spools().remove(run_id).is_some() {
                let _ = std::fs::remove_dir_all(self.home.run_dir(*run_id));
            }
        }
    }

    fn dispatch(self: Arc<Self>, frame: ServerEnvelope, tx: &mpsc::UnboundedSender<String>) {
        let request_id = frame.id;
        let reply = {
            let tx = tx.clone();
            move |result: Result<RunnerMessage, RunnerError>| {
                let msg = result.unwrap_or_else(|err| RunnerMessage::Error(err.to_payload()));
                let _ = tx.send(envelope::encode(msg, Some(request_id)));
            }
        };
        match frame.msg {
            ServerMessage::Welcome(_) | ServerMessage::Paired(_) | ServerMessage::Ack(_) => {}
            ServerMessage::UpgradeRequired(up) => tracing::error!("{}", up.message),
            ServerMessage::Error(err) => tracing::warn!("control plane error {}: {}", err.code, err.message),
            ServerMessage::RunAck(ack) => self.ack_run(ack.run_id, ack.seq),
            ServerMessage::RunStart(start) => reply(self.start_run(*start)),
            ServerMessage::RunInput(input) => reply(self.control(input.run_id, RunControl::Input(input.input))),
            ServerMessage::RunResize(resize) => {
                let _ = self.control(resize.run_id, RunControl::Resize { cols: resize.cols, rows: resize.rows });
            }
            ServerMessage::RunSignal(signal) => reply(self.control(signal.run_id, RunControl::Signal(signal.signal))),
            ServerMessage::GitDiff(request) => {
                let daemon = self.clone();
                tokio::task::spawn_blocking(move || {
                    let config = daemon.config_snapshot();
                    reply(daemon_git_diff(&config, &request.repo_key, &request.branch, request.base.as_deref(), request.include_patch));
                });
            }
            ServerMessage::GitFile(request) => {
                let daemon = self.clone();
                tokio::task::spawn_blocking(move || {
                    let config = daemon.config_snapshot();
                    reply(
                        repos::resolve(&config, &request.repo_key)
                            .and_then(|repo| git::read_file(&repo, &request.rev, &request.path, request.max_bytes).map_err(RunnerError::from))
                            .map(RunnerMessage::GitFileResult),
                    );
                });
            }
            ServerMessage::GitMerge(request) => {
                let daemon = self.clone();
                tokio::task::spawn_blocking(move || {
                    let config = daemon.config_snapshot();
                    let managed_root = daemon.home.repo_worktrees_dir(&request.repo_key);
                    let result = repos::resolve(&config, &request.repo_key).and_then(|repo| {
                        git::merge(
                            &repo,
                            &git::MergeRequest {
                                branch: &request.branch,
                                into: &request.into,
                                strategy: request.strategy,
                                message: &request.message,
                                push: request.push,
                                remote: request.remote.as_deref(),
                                remove_worktree: request.remove_worktree,
                                allow_push: config.policy.allow_push,
                                managed_root: &managed_root,
                            },
                        )
                        .map_err(RunnerError::from)
                    });
                    reply(result.map(RunnerMessage::GitMergeResult));
                });
            }
            ServerMessage::WorktreeRemove(request) => {
                let daemon = self.clone();
                tokio::task::spawn_blocking(move || {
                    let config = daemon.config_snapshot();
                    let managed_root = daemon.home.repo_worktrees_dir(&request.repo_key);
                    let result = repos::resolve(&config, &request.repo_key).and_then(|repo| {
                        git::remove_branch_worktree(&repo, &managed_root, &request.branch, request.delete_branch)
                            .map_err(RunnerError::from)
                    });
                    reply(result.map(|()| RunnerMessage::Ack(Ack {})));
                });
            }
            ServerMessage::ClisDetect(_) => {
                let daemon = self.clone();
                tokio::spawn(async move {
                    daemon.detect_clis().await;
                    let clis = daemon.clis.read().map(|c| c.iter().map(|e| e.info.clone()).collect()).unwrap_or_default();
                    reply(Ok(RunnerMessage::ClisUpdated(ClisUpdated { clis })));
                    let entries = daemon.config_snapshot().repos;
                    let repos = tokio::task::spawn_blocking(move || entries.iter().map(repos::describe).collect::<Vec<_>>())
                        .await
                        .unwrap_or_default();
                    daemon.outbound.send(RunnerMessage::ReposUpdated(ReposUpdated { repos }));
                });
            }
            ServerMessage::PtyOpen(open) => {
                let config = self.config_snapshot();
                let cwd = match &open.target {
                    PtyTarget::Repo { repo_key } => repos::resolve(&config, repo_key),
                    PtyTarget::Worktree { repo_key, branch } => repos::resolve(&config, repo_key).and_then(|repo| {
                        git::worktree_path(&repo, branch)
                            .map_err(RunnerError::from)?
                            .ok_or_else(|| RunnerError::NotFound(format!("no worktree for {branch}")))
                    }),
                };
                reply(cwd.and_then(|cwd| self.pty.open(open, cwd)).map(|()| RunnerMessage::Ack(Ack {})));
            }
            ServerMessage::PtyInput(input) => {
                if let Err(err) = self.pty.input(input) {
                    reply(Err(err));
                }
            }
            ServerMessage::PtyResize(resize) => {
                let _ = self.pty.resize(resize);
            }
            ServerMessage::PtyClose(close) => self.pty.close(close),
        }
    }

    fn start_run(self: &Arc<Self>, start: RunStart) -> Result<RunnerMessage, RunnerError> {
        let run_id = start.run_id;
        if self.lock_live().contains_key(&run_id) {
            return Ok(RunnerMessage::Ack(Ack {}));
        }
        let config = self.config_snapshot();
        if self.lock_live().len() as u32 >= config.policy.max_concurrent_runs {
            return Err(RunnerError::Busy(format!(
                "this runner already runs {} of {} allowed runs",
                self.lock_live().len(),
                config.policy.max_concurrent_runs
            )));
        }
        let spool = RunSpool::open(&self.home.runs_dir(), run_id)?;
        let shared: SharedSpool = Arc::new(Mutex::new(spool));
        self.lock_spools().insert(run_id, shared.clone());

        let (emit_tx, emit_rx) = mpsc::unbounded_channel();
        let stream = tokio::spawn(RunStream::new(shared, self.outbound.clone()).run(emit_rx));
        let context = RunContext {
            home: self.home.clone(),
            config,
            registry: self.registry.clone(),
            clis: self.clis.read().map(|c| c.clone()).unwrap_or_default(),
            extra_bin_dir: self.extra_bin_dir.clone(),
        };
        match supervisor::start_run(context, start, emit_tx.clone()) {
            Ok(handle) => {
                drop(emit_tx);
                self.lock_live().insert(run_id, LiveRun { control: handle.control });
                let daemon = self.clone();
                tokio::spawn(async move {
                    let _ = handle.task.await;
                    let _ = stream.await;
                    daemon.lock_live().remove(&run_id);
                    daemon.cleanup_if_settled(run_id);
                });
                Ok(RunnerMessage::Ack(Ack {}))
            }
            Err(err) => {
                // Report the failure through the run stream too, so the run does not stay
                // `dispatched` in the control plane.
                let _ = emit_tx.send(RunEmit::Completed(RunCompletion {
                    status: RunStatus::Failed,
                    exit_code: None,
                    summary: None,
                    error: Some(err.to_string()),
                    cli_session_id: None,
                    head_commit: None,
                    diff: None,
                    tests: None,
                    usage: None,
                }));
                drop(emit_tx);
                Err(err)
            }
        }
    }

    fn control(&self, run_id: Uuid, control: RunControl) -> Result<RunnerMessage, RunnerError> {
        let live = self.lock_live();
        let run = live.get(&run_id).ok_or_else(|| RunnerError::NotFound(format!("run {run_id} is not running on this runner")))?;
        run.control
            .send(control)
            .map_err(|_| RunnerError::NotFound(format!("run {run_id} already finished")))?;
        Ok(RunnerMessage::Ack(Ack {}))
    }

    fn ack_run(&self, run_id: Uuid, seq: u64) {
        let Some(shared) = self.lock_spools().get(&run_id).cloned() else { return };
        if let Ok(mut spool) = shared.lock() {
            if let Err(err) = spool.ack(seq) {
                tracing::warn!(%run_id, "spool ack failed: {err}");
            }
        }
        self.cleanup_if_settled(run_id);
    }

    /// Deletes the spool of a finished run once everything was acknowledged.
    fn cleanup_if_settled(&self, run_id: Uuid) {
        if self.lock_live().contains_key(&run_id) {
            return;
        }
        let mut spools = self.lock_spools();
        let settled = spools.get(&run_id).is_some_and(|s| s.lock().is_ok_and(|s| s.is_settled()));
        if !settled {
            return;
        }
        if let Some(shared) = spools.remove(&run_id) {
            let dir = self.home.run_dir(run_id);
            drop(shared);
            if let Err(err) = std::fs::remove_dir_all(&dir) {
                tracing::debug!(%run_id, "removing {} failed: {err}", dir.display());
            }
        }
    }

    fn config_snapshot(&self) -> RunnerConfig {
        self.config.read().map(|c| c.clone()).unwrap_or_default()
    }

    fn lock_live(&self) -> std::sync::MutexGuard<'_, HashMap<Uuid, LiveRun>> {
        self.live.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn lock_spools(&self) -> std::sync::MutexGuard<'_, HashMap<Uuid, SharedSpool>> {
        self.spools.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Diff of a ticket branch against its recorded base (or `base` when given).
fn daemon_git_diff(
    config: &RunnerConfig,
    repo_key: &str,
    branch: &str,
    base: Option<&str>,
    include_patch: bool,
) -> Result<RunnerMessage, RunnerError> {
    let repo = repos::resolve(config, repo_key)?;
    git::validate_branch(&repo, branch)?;
    let base = match base {
        Some(base) => base.to_owned(),
        None => match git::recorded_base(&repo, branch)? {
            Some(base) => base,
            None => git::default_branch(&repo)?,
        },
    };
    let diff = git::diff_summary(&repo, &base, &format!("refs/heads/{branch}"), include_patch, git::PATCH_CAP_BYTES)?;
    Ok(RunnerMessage::GitDiffResult(GitDiffResult { diff }))
}

fn close_end(frame: Option<(u16, String)>) -> SessionEnd {
    match frame {
        Some((code, _)) if code == close_codes::UNAUTHORIZED => SessionEnd::Exit(DaemonExit::Revoked),
        Some((code, _)) if code == close_codes::REPLACED => SessionEnd::Exit(DaemonExit::Replaced),
        Some((code, reason)) if code == close_codes::UPGRADE_REQUIRED => {
            SessionEnd::Exit(DaemonExit::UpgradeRequired(if reason.is_empty() { "upgrade required".to_owned() } else { reason }))
        }
        Some((code, reason)) => SessionEnd::Disconnected(format!("closed with {code} {reason}")),
        None => SessionEnd::Disconnected("closed".to_owned()),
    }
}
