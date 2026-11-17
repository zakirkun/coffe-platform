//! Run supervisor (architecture §7.5): prepares the worktree and context, launches the CLI
//! through its adapter, pumps output and events, applies user controls and post-processes a
//! successful run (commit, diff, tests). Adapters stay pure translators; everything that
//! touches processes happens here.

mod finish;
mod prepare;

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::time::Duration;

use coffe_adapters::render::{render_event, render_usage};
use coffe_adapters::{
    AgentEvent, AgentInput, CliAdapter, IoAction, LaunchPlan, RunSpec, SessionState, SharedAdapter,
    Sig, StopMode, StopStep, StreamKind, Usage,
};
use coffe_protocol::{MessageRole, PermissionMode, RunDriver, RunMode, RunSignalKind, RunStart, RunStatus};
use tokio::sync::mpsc;
use tokio::time::Instant;

use self::prepare::{Workspace, prepare};

use crate::error::RunnerError;
use crate::git;
use crate::process::{self, ChildProcess, Launch, Spawned};
use crate::repos;
use crate::run_api::{
    RunCompletion, RunContext, RunControl, RunEmit, RunEmitter, RunHandle, RunStateUpdate,
};

const DIM: &str = "\x1b[2m";
const YELLOW: &str = "\x1b[33m";
const RESET: &str = "\x1b[0m";

/// Validates the request against the runner's policy and starts the run in the background.
/// Errors returned here are answered to the control plane right away; failures later in the
/// run end it with `run.completed { status: failed }`.
pub fn start_run(ctx: RunContext, start: RunStart, emit: RunEmitter) -> Result<RunHandle, RunnerError> {
    let adapter = ctx
        .registry
        .get(&start.cli_id)
        .ok_or_else(|| RunnerError::NotFound(format!("this runner has no adapter for {:?}", start.cli_id)))?;
    if let Some(allowed) = &ctx.config.policy.allowed_clis {
        if !allowed.iter().any(|id| id == &start.cli_id) {
            return Err(RunnerError::Policy(format!("{} is not in this runner's allowed_clis", start.cli_id)));
        }
    }
    if start.permissions.mode == PermissionMode::FullAuto && !ctx.config.policy.allow_full_auto {
        return Err(RunnerError::Policy(
            "full-auto runs are disabled on this runner (policy allow_full_auto)".to_owned(),
        ));
    }
    let (program, cli_version) = resolve_program(&ctx, adapter.as_ref(), &start.cli_id)?;
    let repo = repos::resolve(&ctx.config, &start.repo_key)?;

    let (control_tx, control_rx) = mpsc::unbounded_channel();
    let run_id = start.run_id;
    let task = tokio::spawn(async move {
        let supervisor = Supervisor { ctx, start, adapter, program, cli_version, repo, emit };
        let completion = supervisor.execute(control_rx).await;
        let _ = supervisor.emit.send(RunEmit::Completed(completion));
    });
    Ok(RunHandle { run_id, control: control_tx, task })
}

/// The binary detected for `cli_id`, else (tests) the adapter's binary in `extra_bin_dir`.
fn resolve_program(
    ctx: &RunContext,
    adapter: &dyn CliAdapter,
    cli_id: &str,
) -> Result<(PathBuf, Option<String>), RunnerError> {
    if let Some(entry) = ctx.clis.iter().find(|entry| entry.info.id == cli_id) {
        return Ok((entry.path.clone(), entry.version.clone()));
    }
    if let Some(dir) = &ctx.extra_bin_dir {
        for binary in adapter.info().binaries {
            let candidate = dir.join(format!("{binary}{}", std::env::consts::EXE_SUFFIX));
            if candidate.is_file() {
                return Ok((candidate, None));
            }
        }
    }
    Err(RunnerError::NotFound(format!("{} is not installed on this runner", adapter.info().name)))
}

struct Supervisor {
    ctx: RunContext,
    start: RunStart,
    adapter: SharedAdapter,
    program: PathBuf,
    cli_version: Option<String>,
    repo: PathBuf,
    emit: RunEmitter,
}

/// How the CLI process(es) of a run ended.
struct Outcome {
    exit_code: Option<i32>,
    cancelled: bool,
    timed_out: bool,
    /// Error reported by the CLI itself (error event or failed turn).
    cli_error: Option<String>,
    /// Problem of the supervisor while the CLI ran (spawn failure of a follow-up process).
    failure: Option<String>,
    /// What the session reported: final result text, CLI session id, cumulative usage.
    summary: Option<String>,
    cli_session_id: Option<String>,
    usage: Option<Usage>,
}

impl Supervisor {
    async fn execute(&self, mut controls: mpsc::UnboundedReceiver<RunControl>) -> RunCompletion {
        self.state(RunStateUpdate {
            status: Some(RunStatus::Starting),
            detail: Some("preparing the worktree".to_owned()),
            ..RunStateUpdate::default()
        });
        let workspace = {
            let (home, repo, start) = (self.ctx.home.clone(), self.repo.clone(), self.start.clone());
            match tokio::task::spawn_blocking(move || prepare(&home, &repo, &start)).await {
                Ok(Ok(workspace)) => workspace,
                Ok(Err(err)) => return failed(format!("cannot prepare the worktree: {err}")),
                Err(err) => return failed(format!("worktree preparation crashed: {err}")),
            }
        };
        self.state(RunStateUpdate {
            detail: Some(format!("starting {}", self.adapter.info().name)),
            worktree: Some(workspace.info.clone()),
            ..RunStateUpdate::default()
        });

        let mut env = vec![("COFFE_RUN_ID".to_owned(), self.start.run_id.to_string())];
        if let Some(key) = &self.start.ticket_key {
            env.push(("COFFE_TICKET_KEY".to_owned(), key.clone()));
        }
        if !self.ctx.config.policy.allow_push {
            match git::push_block_env(&self.repo) {
                Ok(block) => env.extend(block),
                Err(err) => return failed(format!("cannot block git push for the agent: {err}")),
            }
        }
        let spec = RunSpec {
            run_id: self.start.run_id,
            program: self.program.clone(),
            cwd: workspace.path.clone(),
            mode: self.start.mode,
            driver: self.start.driver.unwrap_or(RunDriver::Native),
            cli_version: self.cli_version.clone(),
            prompt: self.start.prompt.clone(),
            context: workspace.context.clone(),
            model: self.start.model.clone(),
            permissions: self.start.permissions.clone(),
            resume_session_id: self.start.resume.as_ref().map(|resume| resume.cli_session_id.clone()),
            output_schema: self.start.output_schema.clone(),
            terminal: self.start.terminal,
            env,
        };
        let (plan, session) = match self.adapter.start(&spec) {
            Ok(started) => started,
            Err(err) => return self.cleanup(&workspace, failed(err.to_string())).await,
        };

        let mut driver = Driver::new(self.adapter.clone(), session, self.emit.clone(), self.start.mode, &workspace.path);
        let timeout = Duration::from_secs(self.start.timeout_secs.max(1));
        let outcome = driver.drive(plan, &mut controls, timeout).await;
        drop(driver);
        let completion = self.complete(&workspace, outcome).await;
        self.cleanup(&workspace, completion).await
    }

    /// Turns the outcome into the completion; successful ticket runs are committed, diffed and
    /// tested.
    async fn complete(&self, workspace: &Workspace, outcome: Outcome) -> RunCompletion {
        let mut completion = RunCompletion {
            status: RunStatus::Completed,
            exit_code: outcome.exit_code,
            summary: outcome.summary,
            error: None,
            cli_session_id: outcome.cli_session_id,
            head_commit: None,
            diff: None,
            tests: None,
            usage: outcome.usage,
        };
        if outcome.cancelled {
            completion.status = RunStatus::Cancelled;
            completion.error = Some("stopped by a user".to_owned());
            return completion;
        }
        let error = if outcome.timed_out {
            Some(format!("timed out after {} s", self.start.timeout_secs))
        } else if let Some(failure) = outcome.failure {
            Some(failure)
        } else if let Some(error) = outcome.cli_error {
            Some(error)
        } else if outcome.exit_code != Some(0) {
            Some(match outcome.exit_code {
                Some(code) => format!("{} exited with code {code}", self.adapter.info().name),
                None => format!("{} was killed by a signal", self.adapter.info().name),
            })
        } else {
            None
        };
        if let Some(error) = error {
            completion.status = RunStatus::Failed;
            completion.error = Some(error);
            return completion;
        }

        if self.start.auto_commit && !workspace.detached {
            self.state(RunStateUpdate { detail: Some("committing the changes".to_owned()), ..RunStateUpdate::default() });
            let message = self
                .start
                .commit_message
                .clone()
                .unwrap_or_else(|| format!("COFFE run {}", self.start.run_id));
            let (path, run_id, base) =
                (workspace.path.clone(), self.start.run_id, self.start.worktree.base_branch.clone());
            match tokio::task::spawn_blocking(move || finish::commit_and_diff(&path, run_id, &base, &message)).await {
                Ok(Ok((_, diff))) => {
                    completion.head_commit = Some(diff.head_commit.clone());
                    completion.diff = Some(diff);
                }
                Ok(Err(err)) => {
                    completion.status = RunStatus::Failed;
                    completion.error = Some(format!("cannot commit the changes: {err}"));
                    return completion;
                }
                Err(err) => {
                    completion.status = RunStatus::Failed;
                    completion.error = Some(format!("committing crashed: {err}"));
                    return completion;
                }
            }
        }
        if let Some(command) = self.start.test_command.as_deref().filter(|command| !command.trim().is_empty()) {
            if completion.diff.as_ref().is_some_and(|diff| !diff.files.is_empty()) {
                self.state(RunStateUpdate { detail: Some("running the tests".to_owned()), ..RunStateUpdate::default() });
                completion.tests = Some(finish::run_tests(command, &workspace.path, &self.emit).await);
            }
        }
        completion
    }

    /// Scratch worktrees of read-only runs disappear with the run.
    async fn cleanup(&self, workspace: &Workspace, completion: RunCompletion) -> RunCompletion {
        if workspace.detached {
            let (repo, path) = (self.repo.clone(), workspace.path.clone());
            if let Ok(Err(err)) = tokio::task::spawn_blocking(move || git::remove_worktree_dir(&repo, &path)).await {
                tracing::warn!(run_id = %self.start.run_id, "removing the scratch worktree failed: {err}");
            }
        }
        completion
    }

    fn state(&self, update: RunStateUpdate) {
        let _ = self.emit.send(RunEmit::State(update));
    }
}

fn failed(error: String) -> RunCompletion {
    RunCompletion {
        status: RunStatus::Failed,
        exit_code: None,
        summary: None,
        error: Some(error),
        cli_session_id: None,
        head_commit: None,
        diff: None,
        tests: None,
        usage: None,
    }
}

/// Live state of the CLI process(es) of one run.
struct Driver {
    adapter: SharedAdapter,
    session: SessionState,
    emit: RunEmitter,
    mode: RunMode,
    worktree: PathBuf,
    /// Assistant deltas were rendered since the last complete message.
    streamed: bool,
    reported_session: Option<String>,
    reported_usage: Option<Usage>,
    /// Follow-up turns the CLI has not answered yet (structured mode).
    queued_turns: u32,
    stdin_closed: bool,
    respawn: Option<LaunchPlan>,
    stop_steps: VecDeque<StopStep>,
    next_stop_step: Option<Instant>,
    cancelled: bool,
    timed_out: bool,
    cli_error: Option<String>,
}

impl Driver {
    fn new(adapter: SharedAdapter, session: SessionState, emit: RunEmitter, mode: RunMode, worktree: &Path) -> Self {
        Self {
            adapter,
            session,
            emit,
            mode,
            worktree: worktree.to_path_buf(),
            streamed: false,
            reported_session: None,
            reported_usage: None,
            queued_turns: 0,
            stdin_closed: false,
            respawn: None,
            stop_steps: VecDeque::new(),
            next_stop_step: None,
            cancelled: false,
            timed_out: false,
            cli_error: None,
        }
    }

    async fn drive(
        &mut self,
        plan: LaunchPlan,
        controls: &mut mpsc::UnboundedReceiver<RunControl>,
        timeout: Duration,
    ) -> Outcome {
        let deadline = Instant::now() + timeout;
        let mut spawned = match self.launch(&plan) {
            Ok(spawned) => spawned,
            Err(err) => return self.outcome(None, Some(format!("cannot start the CLI: {err}"))),
        };
        self.emit(RunEmit::State(RunStateUpdate {
            status: Some(RunStatus::Running),
            detail: None,
            ..RunStateUpdate::default()
        }));
        let mut controls_open = true;
        let mut output_open = true;
        loop {
            let step_at = self.next_stop_step;
            tokio::select! {
                chunk = spawned.output.recv(), if output_open => match chunk {
                    Some((kind, bytes)) => self.on_output(&mut spawned.child, kind, &bytes),
                    None => output_open = false,
                },
                code = &mut spawned.exit => {
                    let code = code.ok().flatten();
                    while let Some((kind, bytes)) = spawned.next_trailing().await {
                        self.on_output(&mut spawned.child, kind, &bytes);
                    }
                    match self.respawn.take() {
                        Some(next) if !self.cancelled && !self.timed_out => {
                            spawned = match self.launch(&next) {
                                Ok(spawned) => spawned,
                                Err(err) => return self.outcome(code, Some(format!("cannot start the follow-up turn: {err}"))),
                            };
                            output_open = true;
                            self.stdin_closed = false;
                        }
                        _ => return self.outcome(code, None),
                    }
                }
                control = controls.recv(), if controls_open => match control {
                    Some(control) => self.on_control(&mut spawned.child, control),
                    None => controls_open = false,
                },
                () = tokio::time::sleep_until(step_at.unwrap_or(deadline)), if step_at.is_some() => {
                    self.advance_stop(&mut spawned.child);
                }
                () = tokio::time::sleep_until(deadline), if !self.timed_out => {
                    self.timed_out = true;
                    self.notice("the run reached its time limit; stopping the CLI");
                    self.begin_stop(&mut spawned.child, StopMode::Graceful);
                }
            }
        }
    }

    fn outcome(&self, exit_code: Option<i32>, failure: Option<String>) -> Outcome {
        Outcome {
            exit_code,
            cancelled: self.cancelled,
            timed_out: self.timed_out,
            cli_error: self.cli_error.clone(),
            failure,
            summary: self.session.result_text.clone(),
            cli_session_id: self.session.session_id.clone(),
            usage: self.adapter.get_usage(&self.session),
        }
    }

    /// Writes the plan's files, spawns the process and types the initial input.
    fn launch(&mut self, plan: &LaunchPlan) -> Result<Spawned, RunnerError> {
        for (path, content) in &plan.files {
            if !path.starts_with(&self.worktree) {
                return Err(RunnerError::Scope(format!("{} is outside the worktree", path.display())));
            }
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(path, content)?;
        }
        let mut spawned = process::spawn(Launch::from(plan))?;
        if !plan.initial_stdin.is_empty() {
            spawned.child.write(plan.initial_stdin.clone())?;
        }
        if plan.close_stdin {
            spawned.child.close_stdin();
            self.stdin_closed = true;
        }
        Ok(spawned)
    }

    fn on_output(&mut self, child: &mut ChildProcess, kind: StreamKind, bytes: &[u8]) {
        let structured = self.mode == RunMode::Structured;
        if !structured {
            self.emit(RunEmit::Output(bytes.to_vec()));
        } else if kind == StreamKind::Stderr {
            let mut text = String::from(DIM);
            text.push_str(&String::from_utf8_lossy(bytes).replace("\r\n", "\n").replace('\n', "\r\n"));
            text.push_str(RESET);
            self.emit(RunEmit::Output(text.into_bytes()));
        }
        let events = self.adapter.parse_events(&mut self.session, kind, bytes);
        for event in events {
            self.on_event(child, event, structured);
        }
        self.flush_outbox(child);
        self.report_progress();
    }

    fn on_event(&mut self, child: &mut ChildProcess, event: AgentEvent, render: bool) {
        if render {
            let bytes = render_event(&event, self.streamed);
            if !bytes.is_empty() {
                self.emit(RunEmit::Output(bytes));
            }
        }
        match &event {
            AgentEvent::MessageDelta { .. } => self.streamed = true,
            AgentEvent::Message { role: MessageRole::Assistant, .. } => self.streamed = false,
            AgentEvent::Error { message } => self.cli_error = Some(message.clone()),
            AgentEvent::PermissionRequest { .. } => self.emit(RunEmit::State(RunStateUpdate {
                status: Some(RunStatus::WaitingInput),
                detail: Some("waiting for a permission decision".to_owned()),
                ..RunStateUpdate::default()
            })),
            AgentEvent::TurnCompleted { is_error, result, .. } => {
                if *is_error {
                    self.cli_error = Some(result.clone().unwrap_or_else(|| "the turn ended with an error".to_owned()));
                } else {
                    self.cli_error = None;
                }
                if render {
                    if let Some(usage) = self.adapter.get_usage(&self.session) {
                        self.emit(RunEmit::Output(render_usage(&usage)));
                    }
                }
                // A structured session ends with its last turn unless follow-ups are queued.
                if self.queued_turns > 0 {
                    self.queued_turns -= 1;
                } else if self.mode == RunMode::Structured && !self.stdin_closed {
                    child.close_stdin();
                    self.stdin_closed = true;
                }
            }
            _ => {}
        }
        self.emit(RunEmit::Event(event));
    }

    fn on_control(&mut self, child: &mut ChildProcess, control: RunControl) {
        match control {
            RunControl::Input(input) => self.on_input(child, input),
            RunControl::Resize { cols, rows } => {
                if child.is_pty() {
                    let _ = child.resize(cols, rows);
                }
            }
            RunControl::Signal(RunSignalKind::Pause) => match child.signal(Sig::Stop) {
                Ok(()) => self.emit(RunEmit::State(RunStateUpdate {
                    status: Some(RunStatus::Paused),
                    detail: Some("paused by a user".to_owned()),
                    ..RunStateUpdate::default()
                })),
                Err(err) => self.notice(&format!("cannot pause: {err}")),
            },
            RunControl::Signal(RunSignalKind::Resume) => match child.signal(Sig::Continue) {
                Ok(()) => self.emit(RunEmit::State(RunStateUpdate {
                    status: Some(RunStatus::Running),
                    detail: None,
                    ..RunStateUpdate::default()
                })),
                Err(err) => self.notice(&format!("cannot resume: {err}")),
            },
            RunControl::Signal(RunSignalKind::Interrupt) => self.begin_stop(child, StopMode::InterruptTurn),
            RunControl::Signal(RunSignalKind::Stop) => {
                self.cancelled = true;
                self.notice("stopping the CLI");
                self.begin_stop(child, StopMode::Graceful);
            }
            RunControl::Signal(RunSignalKind::Kill) => {
                self.cancelled = true;
                self.begin_stop(child, StopMode::Kill);
            }
        }
    }

    fn on_input(&mut self, child: &mut ChildProcess, input: AgentInput) {
        let structured = self.mode == RunMode::Structured;
        match &input {
            AgentInput::Text { text } if structured => {
                if self.stdin_closed {
                    self.notice("the session already ended; request changes to continue on this ticket");
                    return;
                }
                let event = AgentEvent::Message { role: MessageRole::User, text: text.clone() };
                self.emit(RunEmit::Output(render_event(&event, false)));
                self.emit(RunEmit::Event(event));
                self.queued_turns += 1;
            }
            AgentInput::Permission { .. } => self.emit(RunEmit::State(RunStateUpdate {
                status: Some(RunStatus::Running),
                detail: None,
                ..RunStateUpdate::default()
            })),
            _ => {}
        }
        match self.adapter.send_input(&mut self.session, input) {
            Ok(actions) => {
                for action in actions {
                    self.perform(child, action);
                }
            }
            Err(err) => self.notice(&format!("the input could not be delivered: {err}")),
        }
        self.flush_outbox(child);
    }

    fn begin_stop(&mut self, child: &mut ChildProcess, mode: StopMode) {
        self.stop_steps = self.adapter.stop(&mut self.session, mode).into();
        self.advance_stop(child);
    }

    /// Runs stop steps until one has to wait for the process to exit.
    fn advance_stop(&mut self, child: &mut ChildProcess) {
        self.next_stop_step = None;
        while let Some(step) = self.stop_steps.pop_front() {
            let delivered = self.perform(child, step.action);
            if delivered && !step.wait.is_zero() && !self.stop_steps.is_empty() {
                self.next_stop_step = Some(Instant::now() + step.wait);
                return;
            }
        }
    }

    /// Performs one adapter action; false when it could not be delivered.
    fn perform(&mut self, child: &mut ChildProcess, action: IoAction) -> bool {
        let result = match action {
            IoAction::Write(bytes) => child.write(bytes),
            IoAction::CloseStdin => {
                child.close_stdin();
                self.stdin_closed = true;
                Ok(())
            }
            IoAction::Signal(sig) => child.signal(sig),
            IoAction::Respawn(plan) => {
                self.respawn = Some(*plan);
                Ok(())
            }
            IoAction::Unsupported(message) => Err(RunnerError::Unsupported(message)),
        };
        match result {
            Ok(()) => true,
            Err(err) => {
                self.notice(&err.to_string());
                false
            }
        }
    }

    fn flush_outbox(&mut self, child: &mut ChildProcess) {
        for action in self.session.take_outbox() {
            self.perform(child, action);
        }
    }

    /// Reports a newly learned CLI session id and changed usage.
    fn report_progress(&mut self) {
        if self.session.session_id.is_some() && self.session.session_id != self.reported_session {
            self.reported_session = self.session.session_id.clone();
            self.emit(RunEmit::State(RunStateUpdate {
                cli_session_id: self.reported_session.clone(),
                ..RunStateUpdate::default()
            }));
        }
        if let Some(usage) = self.adapter.get_usage(&self.session) {
            if self.reported_usage.as_ref() != Some(&usage) {
                self.reported_usage = Some(usage.clone());
                self.emit(RunEmit::Usage(usage));
            }
        }
    }

    /// A supervisor message in the terminal (not part of the CLI's output).
    fn notice(&self, message: &str) {
        self.emit(RunEmit::Output(format!("\r\n{YELLOW}● {message}{RESET}\r\n").into_bytes()));
    }

    fn emit(&self, item: RunEmit) {
        let _ = self.emit.send(item);
    }
}
