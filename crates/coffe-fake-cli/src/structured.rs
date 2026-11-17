//! Structured mode (`run`): scripted turns emitted as JSON lines.
//!
//! Without `--input-format jsonl` the prompt is the positional argument and the process exits
//! after one turn. With it, stdin carries [`Input`] lines: every `user` line runs another turn,
//! `interrupt` aborts the running turn, `permission` answers a pending request, and EOF ends the
//! process (exit 0) once the running turn has finished.

use std::collections::{HashMap, VecDeque};
use std::fs::OpenOptions;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use clap::{Args, ValueEnum};
use serde_json::json;
use uuid::Uuid;

use crate::protocol::{Event, Input, emit};
use crate::{DELAY_ENV, FAILURE_EXIT, FAILURE_MESSAGE, Failure, Scenario};

const DEFAULT_MODEL: &str = "fake-model-1";
/// File the `edit` scenario appends to (relative to the working directory).
const CHANGES_FILE: &str = "FAKE_CHANGES.md";
const DONE_MESSAGE: &str = "Done: appended a line to FAKE_CHANGES.md";
const LONG_OUTPUT_LINES: u32 = 2000;
/// `[[fake:<scenario>]]` inside a prompt selects the scenario of that turn.
const DIRECTIVE_OPEN: &str = "[[fake:";
const DIRECTIVE_CLOSE: &str = "]]";
/// Usage reported by every successful turn.
const TURN_USAGE: Event<'static> =
    Event::Usage { input_tokens: 120, output_tokens: 45, cache_read_tokens: 30, cost_usd: 0.0025 };

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum Format {
    Jsonl,
}

#[derive(Debug, Args)]
pub struct RunArgs {
    /// Output format (only `jsonl`).
    #[arg(long, value_enum, default_value_t = Format::Jsonl)]
    output_format: Format,
    /// Read `user` / `interrupt` / `permission` JSON lines from stdin and stay alive between
    /// turns.
    #[arg(long, value_enum)]
    input_format: Option<Format>,
    /// Session id to report (a random UUID when omitted).
    #[arg(long, conflicts_with = "resume")]
    session_id: Option<String>,
    /// Continue the session with this id.
    #[arg(long)]
    resume: Option<String>,
    #[arg(long)]
    model: Option<String>,
    #[arg(long, value_enum)]
    scenario: Option<Scenario>,
    /// Milliseconds before every event of the `slow` scenario.
    #[arg(long, env = DELAY_ENV, default_value_t = 300)]
    delay_ms: u64,
    /// Instructions file; must be readable.
    #[arg(long)]
    system_prompt_file: Option<PathBuf>,
    /// Prompt of the single turn (without `--input-format jsonl`).
    #[arg(conflicts_with = "input_format")]
    prompt: Option<String>,
}

pub fn run(args: RunArgs) -> Result<ExitCode, Failure> {
    // `jsonl` is the only format; the flag exists so invocations read like the real CLIs.
    let Format::Jsonl = args.output_format;
    let scenario = Scenario::resolve(args.scenario)?;
    if args.input_format.is_none() && args.prompt.is_none() {
        return Err(Failure::Usage(
            "a prompt argument is required unless --input-format jsonl is given".to_owned(),
        ));
    }
    if let Some(path) = &args.system_prompt_file
        && let Err(error) = std::fs::read(path)
    {
        let message = format!("cannot read system prompt file {}: {error}", path.display());
        emit(&Event::Error { message: &message })?;
        return Err(Failure::Usage(message));
    }

    let cwd = std::env::current_dir()?;
    let session_id =
        args.resume.or(args.session_id).unwrap_or_else(|| Uuid::new_v4().to_string());
    let model = args.model.unwrap_or_else(|| DEFAULT_MODEL.to_owned());
    emit(&Event::Init { session_id: &session_id, model: &model, cwd: &cwd.to_string_lossy() })?;

    let mut agent = Agent {
        session_id,
        cwd,
        scenario,
        slow_delay: Duration::from_millis(args.delay_ms),
        inbox: if args.prompt.is_some() { Inbox::detached() } else { Inbox::streaming() },
        turns: 0,
        delay: Duration::ZERO,
        events: 0,
    };
    if let Some(prompt) = args.prompt {
        return Ok(agent.turn(&prompt)?.unwrap_or(ExitCode::SUCCESS));
    }
    while let Some(prompt) = agent.inbox.next_prompt() {
        if let Some(code) = agent.turn(&prompt)? {
            return Ok(code);
        }
    }
    Ok(ExitCode::SUCCESS)
}

/// How a turn ended.
struct Outcome {
    ok: bool,
    text: String,
    /// Exit code when the scenario ends the process after this turn.
    exit: Option<u8>,
}

impl Outcome {
    fn completed(text: impl Into<String>) -> Self {
        Self { ok: true, text: text.into(), exit: None }
    }

    fn failed(text: impl Into<String>) -> Self {
        Self { ok: false, text: text.into(), exit: None }
    }
}

/// Why a turn stopped before its script ended.
enum Abort {
    Interrupted,
    Io(io::Error),
}

impl From<io::Error> for Abort {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

struct Agent {
    session_id: String,
    cwd: PathBuf,
    /// Scenario of turns whose prompt carries no directive.
    scenario: Scenario,
    slow_delay: Duration,
    inbox: Inbox,
    /// Turns started by this process.
    turns: u32,
    /// Pause before every event of the running turn.
    delay: Duration,
    /// Events emitted by the running turn.
    events: u64,
}

impl Agent {
    /// Runs one turn and reports its `result`. Returns the exit code when the scenario ends the
    /// process.
    fn turn(&mut self, prompt: &str) -> io::Result<Option<ExitCode>> {
        self.turns += 1;
        self.events = 0;
        self.delay = Duration::ZERO;
        let outcome = match self.scenario_of(prompt) {
            Ok(scenario) => {
                if scenario == Scenario::Slow {
                    self.delay = self.slow_delay;
                }
                match self.play(scenario, prompt) {
                    Ok(outcome) => outcome,
                    Err(Abort::Interrupted) => Outcome::failed("interrupted"),
                    Err(Abort::Io(error)) => return Err(error),
                }
            }
            Err(message) => {
                emit(&Event::Error { message: &message })?;
                Outcome::failed(message)
            }
        };
        // Deterministic stand-in for wall time: one millisecond per event plus the pauses.
        let pace = u64::try_from(self.delay.as_millis()).unwrap_or(u64::MAX).saturating_add(1);
        emit(&Event::Result {
            ok: outcome.ok,
            text: &outcome.text,
            session_id: &self.session_id,
            duration_ms: self.events.saturating_mul(pace),
            num_turns: self.turns,
        })?;
        Ok(outcome.exit.map(ExitCode::from))
    }

    fn scenario_of(&self, prompt: &str) -> Result<Scenario, String> {
        let directive = prompt
            .split_once(DIRECTIVE_OPEN)
            .and_then(|(_, rest)| rest.split_once(DIRECTIVE_CLOSE));
        match directive {
            Some((name, _)) => Scenario::from_str(name.trim(), true)
                .map_err(|_| format!("unknown scenario in prompt directive: {}", name.trim())),
            None => Ok(self.scenario),
        }
    }

    fn play(&mut self, scenario: Scenario, prompt: &str) -> Result<Outcome, Abort> {
        match scenario {
            Scenario::Edit | Scenario::Slow => self.edit(prompt),
            Scenario::Fail => {
                self.step(&Event::Error { message: FAILURE_MESSAGE })?;
                Ok(Outcome { ok: false, text: FAILURE_MESSAGE.to_owned(), exit: Some(FAILURE_EXIT) })
            }
            Scenario::Permission => self.permission(prompt),
            Scenario::LongOutput => self.long_output(),
            Scenario::Plan => self.plan(),
        }
    }

    /// Emits one event after the turn's pause. An interrupt received meanwhile aborts the turn
    /// before the event is written.
    fn step(&mut self, event: &Event<'_>) -> Result<(), Abort> {
        if self.inbox.interrupted_within(self.delay) {
            return Err(Abort::Interrupted);
        }
        emit(event)?;
        self.events += 1;
        Ok(())
    }

    fn edit(&mut self, prompt: &str) -> Result<Outcome, Abort> {
        let subject = one_line(prompt);
        self.step(&Event::Delta { text: "Working on: " })?;
        self.step(&Event::Delta { text: &subject })?;
        self.step(&Event::Delta { text: "\n" })?;

        let call_id = format!("tool_{}", self.turns);
        let content = format!("- {subject}\n");
        self.step(&Event::ToolUse {
            id: &call_id,
            name: "write_file",
            input: json!({ "path": CHANGES_FILE, "content": content }),
        })?;
        let appended = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.cwd.join(CHANGES_FILE))
            .and_then(|mut file| file.write_all(content.as_bytes()));
        if let Err(error) = appended {
            let output = format!("cannot write {CHANGES_FILE}: {error}");
            self.step(&Event::ToolResult { id: &call_id, ok: false, output: &output })?;
            return Ok(Outcome::failed(output));
        }
        let output = format!("appended 1 line to {CHANGES_FILE}");
        self.step(&Event::ToolResult { id: &call_id, ok: true, output: &output })?;

        self.step(&Event::Message { text: DONE_MESSAGE })?;
        self.step(&TURN_USAGE)?;
        Ok(Outcome::completed(DONE_MESSAGE))
    }

    fn permission(&mut self, prompt: &str) -> Result<Outcome, Abort> {
        let request_id = format!("perm_{}", self.turns);
        self.step(&Event::PermissionRequest {
            id: &request_id,
            tool: "write_file",
            description: "Append a line to FAKE_CHANGES.md",
        })?;
        match self.inbox.permission(&request_id) {
            Decision::Allow => self.edit(prompt),
            Decision::Deny => Ok(Outcome::failed("permission denied")),
            Decision::Interrupted => Err(Abort::Interrupted),
        }
    }

    fn long_output(&mut self) -> Result<Outcome, Abort> {
        for number in 1..=LONG_OUTPUT_LINES {
            let text = format!("line {number:04} of {LONG_OUTPUT_LINES}\n");
            self.step(&Event::Delta { text: &text })?;
        }
        let summary = format!("Printed {LONG_OUTPUT_LINES} lines");
        self.step(&Event::Message { text: &summary })?;
        self.step(&TURN_USAGE)?;
        Ok(Outcome::completed(summary))
    }

    /// A planner's answer: the plan JSON as the final message (no file is touched).
    fn plan(&mut self) -> Result<Outcome, Abort> {
        let plan = json!({
            "tickets": [
                {
                    "title": "Add the badge component",
                    "description": "A small badge that shows a count.",
                    "acceptance_criteria": ["The badge renders the count"],
                    "depends_on": [],
                    "suggested_role": "implementer",
                    "estimate": "S"
                },
                {
                    "title": "Show the badge on the cart icon",
                    "description": "Wire the badge to the cart item count.",
                    "acceptance_criteria": ["The cart icon shows the number of items"],
                    "depends_on": [0],
                    "suggested_role": "implementer",
                    "estimate": "M"
                }
            ]
        })
        .to_string();
        self.step(&Event::Message { text: &plan })?;
        self.step(&TURN_USAGE)?;
        Ok(Outcome::completed(plan))
    }
}

/// The prompt as a single line (it becomes one markdown list item).
fn one_line(prompt: &str) -> String {
    prompt.lines().map(str::trim).filter(|line| !line.is_empty()).collect::<Vec<_>>().join(" ")
}

enum Decision {
    Allow,
    Deny,
    Interrupted,
}

/// Inputs that arrived before anything was waiting for them.
#[derive(Default)]
struct Backlog {
    /// Prompts received while a turn was running.
    prompts: VecDeque<String>,
    /// Permission answers by request id.
    answers: HashMap<String, bool>,
}

impl Backlog {
    /// Files `input` for later; true when it is an interrupt (which is never kept).
    fn stash(&mut self, input: Input) -> bool {
        match input {
            Input::Interrupt => return true,
            Input::User { text } => self.prompts.push_back(text),
            Input::Permission { id, allow } => {
                self.answers.insert(id, allow);
            }
        }
        false
    }
}

/// Protocol input read from stdin by a background thread.
struct Inbox {
    /// `None` when stdin carries no protocol (prompt given as argument). The channel disconnects
    /// when stdin reaches EOF.
    rx: Option<Receiver<Input>>,
    backlog: Backlog,
}

impl Inbox {
    fn detached() -> Self {
        Self { rx: None, backlog: Backlog::default() }
    }

    fn streaming() -> Self {
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            for line in io::stdin().lock().lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                let delivered = match serde_json::from_str::<Input>(&line) {
                    Ok(input) => tx.send(input).is_ok(),
                    Err(error) => {
                        let message = format!("invalid input line: {error}");
                        emit(&Event::Error { message: &message }).is_ok()
                    }
                };
                if !delivered {
                    break;
                }
            }
        });
        Self { rx: Some(rx), backlog: Backlog::default() }
    }

    /// Waits `pause` for input; true when the running turn was interrupted meanwhile.
    fn interrupted_within(&mut self, pause: Duration) -> bool {
        let Some(rx) = &self.rx else {
            thread::sleep(pause);
            return false;
        };
        let deadline = Instant::now() + pause;
        loop {
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(input) => {
                    if self.backlog.stash(input) {
                        return true;
                    }
                }
                Err(RecvTimeoutError::Timeout) => return false,
                Err(RecvTimeoutError::Disconnected) => {
                    // stdin is closed: the turn still finishes at the scenario's pace.
                    thread::sleep(deadline.saturating_duration_since(Instant::now()));
                    return false;
                }
            }
        }
    }

    /// Blocks until the request is answered. Nobody can answer once stdin is closed (or carries
    /// no protocol), which counts as a denial.
    fn permission(&mut self, request_id: &str) -> Decision {
        loop {
            if let Some(allow) = self.backlog.answers.remove(request_id) {
                return if allow { Decision::Allow } else { Decision::Deny };
            }
            let Some(Ok(input)) = self.rx.as_ref().map(Receiver::recv) else {
                return Decision::Deny;
            };
            if self.backlog.stash(input) {
                return Decision::Interrupted;
            }
        }
    }

    /// Next prompt to run; `None` once stdin is closed and nothing is queued.
    fn next_prompt(&mut self) -> Option<String> {
        loop {
            if let Some(prompt) = self.backlog.prompts.pop_front() {
                return Some(prompt);
            }
            let input = self.rx.as_ref()?.recv().ok()?;
            // An interrupt between turns has nothing to abort.
            self.backlog.stash(input);
        }
    }
}
