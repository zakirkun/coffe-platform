//! The ACP driver of every CLI with a native Agent Client Protocol server (`gemini --acp`,
//! `opencode acp`, `agy acp`, `grok agent stdio`, `muse acp`, `kiro-cli acp`). Live permission
//! prompts, steering and cancel; the process stays alive between turns.

use std::time::Duration;

use crate::acp::AcpClient;
use crate::{
    AdapterError, AgentEvent, AgentInput, IoAction, IoMode, LaunchPlan, RunMode, RunSpec, SessionState, StopMode,
    StopStep, StreamKind, Usage, default_stop_steps,
};

use super::stderr_events;
use super::support::full_prompt;

const CLOSE_STDIN_WAIT: Duration = Duration::from_secs(3);

/// `SessionState::ext` of a run on the ACP driver.
#[derive(Debug)]
pub(crate) struct AcpState {
    client: AcpClient,
}

/// Launch plan for `program args…` speaking ACP on stdio; the `initialize` request goes out first.
pub(crate) fn start(spec: &RunSpec, args: Vec<String>, env: Vec<(String, String)>) -> Result<(LaunchPlan, SessionState), AdapterError> {
    let (client, init) = AcpClient::new(spec.cwd.display().to_string(), full_prompt(spec), spec.resume_session_id.clone());
    let IoAction::Write(initial_stdin) = init else {
        return Err(AdapterError::Other("the ACP client produced no initialize request".to_owned()));
    };
    let plan = LaunchPlan {
        program: spec.program.clone(),
        args,
        env: spec.env.iter().cloned().chain(env).collect(),
        cwd: spec.cwd.clone(),
        io: IoMode::Pipes,
        initial_stdin,
        close_stdin: false,
        files: Vec::new(),
    };
    Ok((plan, SessionState::new(spec.run_id, RunMode::Structured).with_ext(AcpState { client })))
}

pub(crate) fn is_acp(session: &SessionState) -> bool {
    session.ext::<AcpState>().is_some()
}

pub(crate) fn parse(session: &mut SessionState, stream: StreamKind, chunk: &[u8]) -> Vec<AgentEvent> {
    match stream {
        StreamKind::Stdout => {
            let lines = session.stdout_lines.push(chunk);
            let mut events = Vec::new();
            let mut out = Vec::new();
            let Some(state) = session.ext_mut::<AcpState>() else { return events };
            for line in &lines {
                events.extend(state.client.handle_line(line, &mut out));
            }
            let session_id = state.client.session_id().map(str::to_owned);
            let usage = state.client.updates.usage.clone();
            session.outbox.extend(out);
            if session_id.is_some() {
                session.session_id = session_id;
            }
            session.usage = Usage { available: session.usage.available, ..usage };
            for event in &events {
                if let AgentEvent::TurnCompleted { result, .. } = event {
                    session.turn_completed = true;
                    session.result_text.clone_from(result);
                }
            }
            events
        }
        StreamKind::Stderr => stderr_events(session, chunk),
        StreamKind::Pty => Vec::new(),
    }
}

pub(crate) fn send_input(session: &mut SessionState, input: AgentInput) -> Result<Vec<IoAction>, AdapterError> {
    let Some(state) = session.ext_mut::<AcpState>() else {
        return Err(AdapterError::Other("not an ACP session".to_owned()));
    };
    Ok(match input {
        AgentInput::Text { text } => {
            let actions = state.client.send_text(text);
            session.turn_completed = false;
            actions
        }
        AgentInput::Permission { request_id, allow, remember } => match state.client.answer_permission(&request_id, allow, remember) {
            Some(action) => vec![action],
            None => vec![IoAction::Unsupported(format!("no open permission request {request_id}"))],
        },
        AgentInput::Interrupt => state.client.cancel(),
        AgentInput::Keys { .. } => vec![IoAction::Unsupported("raw keystrokes are only available in PTY mode".to_owned())],
    })
}

pub(crate) fn stop(session: &mut SessionState, mode: StopMode) -> Vec<StopStep> {
    let cancel = session.ext_mut::<AcpState>().map(|state| state.client.cancel()).unwrap_or_default();
    let mut steps: Vec<StopStep> = cancel.into_iter().map(|action| StopStep { action, wait: Duration::ZERO }).collect();
    match mode {
        StopMode::InterruptTurn => {}
        StopMode::Graceful => {
            steps.push(StopStep { action: IoAction::CloseStdin, wait: CLOSE_STDIN_WAIT });
            steps.extend(default_stop_steps(StopMode::Graceful));
        }
        StopMode::Kill => return default_stop_steps(StopMode::Kill),
    }
    steps
}

/// ACP reports cost or credits, not per-turn tokens.
pub(crate) fn usage(session: &SessionState) -> Option<Usage> {
    (session.usage.available || session.usage.cost_usd.is_some() || session.usage.credits.is_some()).then(|| session.usage.clone())
}
