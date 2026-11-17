//! Deterministic fake agent CLI: the fixture behind the `fake` adapter, the runner tests and the
//! end-to-end flows. It never talks to a model; every scenario is scripted.
//!
//! * `coffe-fake-cli run …` — structured mode, one JSON event per stdout line
//!   (see [`protocol`] for the wire format and [`structured`] for the scenarios).
//! * `coffe-fake-cli interactive` — line-oriented session for PTY tests.
//! * `coffe-fake-cli auth status` — prints `{"logged_in":true}`.

use std::fmt;
use std::io;
use std::process::ExitCode;

use clap::{Parser, Subcommand, ValueEnum};
use serde_json::json;

mod interactive;
mod protocol;
mod structured;

/// Selects the scenario when `--scenario` is not given.
const SCENARIO_ENV: &str = "COFFE_FAKE_SCENARIO";
/// Milliseconds between events of the `slow` scenario (default 300).
const DELAY_ENV: &str = "COFFE_FAKE_DELAY_MS";

/// Exit code of the `fail` scenario.
const FAILURE_EXIT: u8 = 3;
const FAILURE_MESSAGE: &str = "simulated failure";

#[derive(Debug, Parser)]
#[command(
    name = "coffe-fake-cli",
    version,
    about = "Deterministic fake agent CLI (COFFE test fixture)"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Structured run: one JSON event per stdout line.
    Run(structured::RunArgs),
    /// Line-oriented interactive session (PTY tests).
    Interactive(interactive::InteractiveArgs),
    /// Authentication commands.
    Auth {
        #[command(subcommand)]
        command: AuthCommand,
    },
}

#[derive(Debug, Subcommand)]
enum AuthCommand {
    /// Prints the login state as JSON.
    Status,
}

/// Scripted behaviours. `--scenario` wins over `COFFE_FAKE_SCENARIO`; in structured mode a
/// `[[fake:<name>]]` directive inside a prompt selects the scenario of that turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum Scenario {
    /// Streams a few deltas and appends a line with the prompt to `FAKE_CHANGES.md`.
    Edit,
    /// `edit` with a pause before every event (pause/stop tests).
    Slow,
    /// Reports an error and exits with code 3.
    Fail,
    /// Asks for permission before editing and waits for the answer.
    Permission,
    /// Streams 2000 lines of text.
    #[value(name = "long_output", alias = "long-output")]
    LongOutput,
}

impl Scenario {
    /// Resolves the process-wide scenario: flag, then environment, then `edit`.
    fn resolve(flag: Option<Self>) -> Result<Self, Failure> {
        if let Some(scenario) = flag {
            return Ok(scenario);
        }
        match std::env::var(SCENARIO_ENV) {
            Ok(name) if !name.trim().is_empty() => Self::from_str(name.trim(), true)
                .map_err(|_| Failure::Usage(format!("unknown scenario in {SCENARIO_ENV}: {name}"))),
            _ => Ok(Self::Edit),
        }
    }
}

/// Why the process ends unsuccessfully without a scripted exit code.
#[derive(Debug)]
pub enum Failure {
    /// Invalid invocation (exit code 2, like clap's own argument errors).
    Usage(String),
    /// stdin/stdout/file-system failure (exit code 1).
    Io(io::Error),
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Usage(message) => f.write_str(message),
            Self::Io(error) => write!(f, "i/o error: {error}"),
        }
    }
}

impl From<io::Error> for Failure {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

fn main() -> ExitCode {
    let outcome = match Cli::parse().command {
        Command::Run(args) => structured::run(args),
        Command::Interactive(args) => interactive::run(args),
        Command::Auth { command: AuthCommand::Status } => {
            println!("{}", json!({ "logged_in": true }));
            Ok(ExitCode::SUCCESS)
        }
    };
    match outcome {
        Ok(code) => code,
        Err(failure) => {
            eprintln!("coffe-fake-cli: {failure}");
            ExitCode::from(match failure {
                Failure::Usage(_) => 2,
                Failure::Io(_) => 1,
            })
        }
    }
}
