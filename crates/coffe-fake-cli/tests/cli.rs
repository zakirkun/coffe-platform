//! The fake CLI binary as the runner drives it: JSONL over pipes and a line-oriented TUI.

use assert_cmd::Command;
use coffe_adapters::adapters::FakeAdapter;
use coffe_adapters::{CliAdapter, SessionState, StreamKind};
use coffe_protocol::{AgentEvent, RunMode};
use uuid::Uuid;

fn fake(dir: &std::path::Path) -> Command {
    let mut command = Command::cargo_bin("coffe-fake-cli").unwrap();
    command.current_dir(dir).env_remove("COFFE_FAKE_SCENARIO").env("COFFE_FAKE_DELAY_MS", "0");
    command
}

fn run_args(session: &str) -> [&str; 7] {
    ["run", "--output-format", "jsonl", "--input-format", "jsonl", "--session-id", session]
}

/// The CLI's stdout as the adapter sees it.
fn events_of(stdout: &[u8]) -> Vec<AgentEvent> {
    let mut session = SessionState::new(Uuid::new_v4(), RunMode::Structured);
    FakeAdapter.parse_events(&mut session, StreamKind::Stdout, stdout)
}

#[test]
fn reports_its_version() {
    let dir = tempfile::tempdir().unwrap();
    let output = fake(dir.path()).arg("--version").output().unwrap();
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).starts_with("coffe-fake-cli "));
}

#[test]
fn an_edit_turn_appends_to_the_changes_file_and_streams_events() {
    let dir = tempfile::tempdir().unwrap();
    let output = fake(dir.path())
        .args(run_args("session-1"))
        .write_stdin("{\"type\":\"user\",\"text\":\"Add a cart badge\"}\n")
        .output()
        .unwrap();
    assert!(output.status.success(), "stderr: {}", String::from_utf8_lossy(&output.stderr));

    let events = events_of(&output.stdout);
    assert!(matches!(events.first(), Some(AgentEvent::SessionStarted { session_id: Some(id), .. }) if id == "session-1"));
    assert!(events.iter().any(|event| matches!(event, AgentEvent::ToolCall { name, .. } if name == "write_file")));
    assert!(events.iter().any(|event| matches!(event, AgentEvent::Usage { .. })));
    assert!(matches!(events.last(), Some(AgentEvent::TurnCompleted { is_error: false, .. })));
    assert_eq!(std::fs::read_to_string(dir.path().join("FAKE_CHANGES.md")).unwrap(), "- Add a cart badge\n");
}

#[test]
fn every_turn_of_a_session_is_answered_until_stdin_closes() {
    let dir = tempfile::tempdir().unwrap();
    let output = fake(dir.path())
        .args(run_args("session-2"))
        .write_stdin("{\"type\":\"user\",\"text\":\"first\"}\n{\"type\":\"user\",\"text\":\"second\"}\n")
        .output()
        .unwrap();
    assert!(output.status.success());
    let turns = events_of(&output.stdout)
        .into_iter()
        .filter(|event| matches!(event, AgentEvent::TurnCompleted { .. }))
        .count();
    assert_eq!(turns, 2);
    assert_eq!(std::fs::read_to_string(dir.path().join("FAKE_CHANGES.md")).unwrap(), "- first\n- second\n");
}

#[test]
fn a_fail_directive_reports_an_error_and_exits_with_code_3() {
    let dir = tempfile::tempdir().unwrap();
    let output = fake(dir.path())
        .args(run_args("session-3"))
        .write_stdin("{\"type\":\"user\",\"text\":\"[[fake:fail]] break things\"}\n")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(3));
    let events = events_of(&output.stdout);
    assert!(events.iter().any(|event| matches!(event, AgentEvent::Error { message } if message == "simulated failure")));
    assert!(!dir.path().join("FAKE_CHANGES.md").exists());
}

#[test]
fn a_permission_answer_unblocks_the_edit() {
    let dir = tempfile::tempdir().unwrap();
    let output = fake(dir.path())
        .args(run_args("session-4"))
        .write_stdin(concat!(
            "{\"type\":\"user\",\"text\":\"[[fake:permission]] edit\"}\n",
            "{\"type\":\"permission\",\"id\":\"perm_1\",\"allow\":true}\n",
        ))
        .output()
        .unwrap();
    assert!(output.status.success(), "stderr: {}", String::from_utf8_lossy(&output.stderr));
    let events = events_of(&output.stdout);
    assert!(events.iter().any(|event| matches!(event, AgentEvent::PermissionRequest { request_id, .. } if request_id == "perm_1")));
    assert!(dir.path().join("FAKE_CHANGES.md").exists());
}

#[test]
fn a_denied_permission_leaves_the_worktree_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let output = fake(dir.path())
        .args(run_args("session-5"))
        .write_stdin(concat!(
            "{\"type\":\"user\",\"text\":\"[[fake:permission]] edit\"}\n",
            "{\"type\":\"permission\",\"id\":\"perm_1\",\"allow\":false}\n",
        ))
        .output()
        .unwrap();
    let events = events_of(&output.stdout);
    assert!(matches!(events.last(), Some(AgentEvent::TurnCompleted { is_error: true, .. })));
    assert!(!dir.path().join("FAKE_CHANGES.md").exists());
}

#[test]
fn resuming_keeps_the_session_id() {
    let dir = tempfile::tempdir().unwrap();
    let output = fake(dir.path())
        .args(["run", "--output-format", "jsonl", "--input-format", "jsonl", "--resume", "earlier-session"])
        .write_stdin("{\"type\":\"user\",\"text\":\"continue\"}\n")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(matches!(
        events_of(&output.stdout).first(),
        Some(AgentEvent::SessionStarted { session_id: Some(id), .. }) if id == "earlier-session"
    ));
}

#[test]
fn interactive_mode_answers_line_by_line() {
    let dir = tempfile::tempdir().unwrap();
    let output = fake(dir.path()).arg("interactive").write_stdin("write notes.txt hi there\nhello\nexit\n").output().unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    for expected in ["fake-cli ready", "wrote notes.txt", "you said: hello", "bye"] {
        assert!(stdout.contains(expected), "missing {expected:?} in {stdout:?}");
    }
    assert_eq!(std::fs::read_to_string(dir.path().join("notes.txt")).unwrap().trim_end(), "hi there");
}

#[test]
fn interactive_writes_cannot_leave_the_working_directory() {
    let dir = tempfile::tempdir().unwrap();
    let output = fake(dir.path()).arg("interactive").write_stdin("write ../escape.txt nope\nexit\n").output().unwrap();
    assert!(!dir.path().parent().unwrap().join("escape.txt").exists());
    assert!(!String::from_utf8_lossy(&output.stdout).contains("wrote ../escape.txt"));
}
