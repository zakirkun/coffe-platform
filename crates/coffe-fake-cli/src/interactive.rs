//! Interactive mode: a line-oriented session for PTY tests.
//!
//! Prints `fake-cli ready` and the prompt `fake> `, then answers every line:
//! `write <path> <text>` writes `<text>` to `<path>` (inside the working directory) and prints
//! `wrote <path>`, `exit` prints `bye` and exits 0, anything else prints `you said: <line>`.
//! EOF also exits 0.

use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Component, Path, PathBuf};
use std::process::ExitCode;
use std::thread;
use std::time::Duration;

use clap::Args;

use crate::{DELAY_ENV, FAILURE_EXIT, FAILURE_MESSAGE, Failure, Scenario};

const BANNER: &str = "fake-cli ready";
const PROMPT: &str = "fake> ";

#[derive(Debug, Args)]
pub struct InteractiveArgs {
    /// `slow` pauses before every reply and `fail` exits with code 3 at startup; the other
    /// scenarios do not change this mode.
    #[arg(long, value_enum)]
    scenario: Option<Scenario>,
    /// Milliseconds before every reply of the `slow` scenario.
    #[arg(long, env = DELAY_ENV, default_value_t = 300)]
    delay_ms: u64,
}

pub fn run(args: InteractiveArgs) -> Result<ExitCode, Failure> {
    let scenario = Scenario::resolve(args.scenario)?;
    let mut out = io::stdout().lock();
    if scenario == Scenario::Fail {
        writeln!(out, "fake-cli error: {FAILURE_MESSAGE}")?;
        return Ok(ExitCode::from(FAILURE_EXIT));
    }
    let pause =
        if scenario == Scenario::Slow { Duration::from_millis(args.delay_ms) } else { Duration::ZERO };
    let cwd = std::env::current_dir()?;

    writeln!(out, "{BANNER}")?;
    let mut lines = io::stdin().lock().lines();
    loop {
        write!(out, "{PROMPT}")?;
        out.flush()?;
        let Some(line) = lines.next() else { break };
        let line = line?;
        thread::sleep(pause);
        match line.trim() {
            "exit" => {
                writeln!(out, "bye")?;
                break;
            }
            command => writeln!(out, "{}", reply(&cwd, command))?,
        }
    }
    Ok(ExitCode::SUCCESS)
}

/// Executes `write <path> <text>` and echoes anything else.
fn reply(cwd: &Path, line: &str) -> String {
    let Some(arguments) = line.strip_prefix("write ") else {
        return format!("you said: {line}");
    };
    let Some((path, text)) = arguments.trim_start().split_once(char::is_whitespace) else {
        return "usage: write <path> <text>".to_owned();
    };
    let Some(target) = workspace_path(cwd, path) else {
        return format!("error: {path} is outside the working directory");
    };
    let written = target
        .parent()
        .map_or(Ok(()), fs::create_dir_all)
        .and_then(|()| fs::write(&target, format!("{}\n", text.trim_start())));
    match written {
        Ok(()) => format!("wrote {path}"),
        Err(error) => format!("error: cannot write {path}: {error}"),
    }
}

/// Resolves a relative path that stays inside `cwd` (no root, drive or `..` components).
fn workspace_path(cwd: &Path, raw: &str) -> Option<PathBuf> {
    let path = Path::new(raw);
    path.components()
        .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
        .then(|| cwd.join(path))
}
