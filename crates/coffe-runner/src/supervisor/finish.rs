//! Post-processing of a successful run: commit, diff against the base and the project's test
//! command (architecture §7.6, review gate §11.7).

use std::path::Path;
use std::time::{Duration, Instant};

use coffe_protocol::{DiffSummary, TestReport, TestSource, TestStatus};

use crate::error::RunnerError;
use crate::git;
use crate::process;
use crate::run_api::{RunEmit, RunEmitter};

/// Patch size cap of a stored diff (the full diff stays in git).
pub const PATCH_CAP_BYTES: usize = 2 * 1024 * 1024;
/// Longest the project's test command may take.
const TEST_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Tail of the test output kept in the report.
const OUTPUT_TAIL_BYTES: usize = 8 * 1024;

/// Commits everything the agent changed and summarizes the branch against its base.
pub fn commit_and_diff(
    worktree: &Path,
    run_id: uuid::Uuid,
    base_branch: &str,
    message: &str,
) -> Result<(Option<String>, DiffSummary), RunnerError> {
    let commit = git::commit_all(worktree, run_id, message)?;
    let diff = git::diff_summary(worktree, base_branch, "HEAD", true, PATCH_CAP_BYTES)?;
    Ok((commit, diff))
}

/// Runs the test command in the worktree, streaming its output into the run's terminal.
pub async fn run_tests(command: &str, worktree: &Path, emit: &RunEmitter) -> TestReport {
    let _ = emit.send(RunEmit::Output(format!("\r\n\x1b[1m▶ tests: {command}\x1b[0m\r\n").into_bytes()));
    let started = Instant::now();
    let mut spawned = match process::spawn_shell(command, worktree) {
        Ok(spawned) => spawned,
        Err(err) => return error_report(command, format!("cannot start the test command: {err}")),
    };

    let mut tail = OutputTail::default();
    let deadline = tokio::time::Instant::now() + TEST_TIMEOUT;
    let exit = loop {
        tokio::select! {
            chunk = spawned.output.recv() => match chunk {
                Some((_, bytes)) => tail.record(emit, &bytes),
                None => break (&mut spawned.exit).await.ok().flatten(),
            },
            code = &mut spawned.exit => break code.ok().flatten(),
            () = tokio::time::sleep_until(deadline) => {
                let _ = spawned.child.signal(coffe_adapters::Sig::Kill);
                let mut report = error_report(
                    command,
                    format!("the tests did not finish within {} minutes", TEST_TIMEOUT.as_secs() / 60),
                );
                report.output_tail = Some(tail.text());
                return report;
            }
        }
    };
    while let Some((_, bytes)) = spawned.next_trailing().await {
        tail.record(emit, &bytes);
    }

    let text = tail.text();
    let counts = count_tests(&text);
    let status = if exit == Some(0) { TestStatus::Passed } else { TestStatus::Failed };
    let _ = emit.send(RunEmit::Output(
        format!(
            "\x1b[{}m● tests {}\x1b[0m\r\n",
            if status == TestStatus::Passed { 32 } else { 31 },
            if status == TestStatus::Passed { "passed" } else { "failed" }
        )
        .into_bytes(),
    ));
    TestReport {
        source: TestSource::Command,
        command: Some(command.to_owned()),
        status,
        passed: counts.passed,
        failed: counts.failed,
        skipped: counts.skipped,
        duration_ms: Some(u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)),
        failures: Vec::new(),
        output_tail: Some(text),
    }
}

/// The last bytes of the test output; everything is mirrored into the run's terminal.
#[derive(Default)]
struct OutputTail {
    bytes: Vec<u8>,
}

impl OutputTail {
    fn record(&mut self, emit: &RunEmitter, bytes: &[u8]) {
        let _ = emit.send(RunEmit::Output(crlf(bytes)));
        self.bytes.extend_from_slice(bytes);
        if self.bytes.len() > OUTPUT_TAIL_BYTES * 2 {
            self.bytes.drain(..self.bytes.len() - OUTPUT_TAIL_BYTES);
        }
    }

    fn text(&self) -> String {
        let start = self.bytes.len().saturating_sub(OUTPUT_TAIL_BYTES);
        String::from_utf8_lossy(&self.bytes[start..]).into_owned()
    }
}

fn error_report(command: &str, message: String) -> TestReport {
    TestReport {
        source: TestSource::Command,
        command: Some(command.to_owned()),
        status: TestStatus::Error,
        passed: 0,
        failed: 0,
        skipped: 0,
        duration_ms: None,
        failures: Vec::new(),
        output_tail: Some(message),
    }
}

/// `\n` → `\r\n` for xterm.js, leaving existing `\r\n` alone.
fn crlf(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() + bytes.len() / 16);
    let mut previous = 0u8;
    for &byte in bytes {
        if byte == b'\n' && previous != b'\r' {
            out.push(b'\r');
        }
        out.push(byte);
        previous = byte;
    }
    out
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct TestCounts {
    pub passed: u32,
    pub failed: u32,
    pub skipped: u32,
}

/// Best-effort counts from the summary lines of common runners: cargo test, Vitest, Jest and
/// pytest. Unknown formats yield zeros (the exit code still decides pass/fail).
pub fn count_tests(output: &str) -> TestCounts {
    let mut counts = TestCounts::default();
    for line in output.lines() {
        let trimmed = line.trim();
        let summary = trimmed.starts_with("test result:")
            || trimmed.starts_with("Tests:")
            || (trimmed.starts_with("Tests ") && trimmed.contains('('))
            || (trimmed.starts_with('=') && trimmed.contains(" in "));
        if !summary {
            continue;
        }
        let words: Vec<&str> = trimmed
            .split(|c: char| c.is_whitespace() || matches!(c, ',' | ';' | '|' | '(' | ')' | '='))
            .filter(|word| !word.is_empty())
            .collect();
        for pair in words.windows(2) {
            let [count, label] = pair else { continue };
            let Ok(count) = count.parse::<u32>() else { continue };
            match label.trim_end_matches('.') {
                "passed" => counts.passed += count,
                "failed" | "errors" | "error" => counts.failed += count,
                "skipped" | "ignored" | "todo" | "pending" => counts.skipped += count,
                _ => {}
            }
        }
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_cargo_vitest_jest_and_pytest_summaries() {
        let cargo = "running 3 tests\ntest result: ok. 32 passed; 1 failed; 2 ignored; 0 measured\n\
                     test result: ok. 4 passed; 0 failed; 0 ignored";
        assert_eq!(count_tests(cargo), TestCounts { passed: 36, failed: 1, skipped: 2 });

        let vitest = " Test Files  3 passed (3)\n      Tests  5 failed | 29 passed | 1 skipped (35)\n";
        assert_eq!(count_tests(vitest), TestCounts { passed: 29, failed: 5, skipped: 1 });

        let jest = "Tests:       1 failed, 1 skipped, 12 passed, 14 total";
        assert_eq!(count_tests(jest), TestCounts { passed: 12, failed: 1, skipped: 1 });

        let pytest = "==== 3 passed, 1 skipped, 2 failed in 0.12s ====";
        assert_eq!(count_tests(pytest), TestCounts { passed: 3, failed: 2, skipped: 1 });

        assert_eq!(count_tests("all good"), TestCounts::default());
    }

    #[test]
    fn converts_lone_newlines_for_the_terminal() {
        assert_eq!(crlf(b"a\nb\r\nc"), b"a\r\nb\r\nc".to_vec());
    }
}
