//! `coffe-runner` command line against a temporary `--home`.

use std::path::Path;
use std::process::Command as StdCommand;

use assert_cmd::Command;
use predicates::prelude::*;

fn runner(home: &Path) -> Command {
    let mut cmd = Command::cargo_bin("coffe-runner").unwrap();
    cmd.arg("--home").arg(home).env_remove("COFFE_RUNNER_HOME").env("RUST_LOG", "warn");
    cmd
}

fn git_repo(dir: &Path) {
    let status = StdCommand::new("git").args(["init", "-q", "-b", "main"]).current_dir(dir).status().unwrap();
    assert!(status.success());
}

#[test]
fn status_reports_an_unpaired_runner() {
    let home = tempfile::tempdir().unwrap();
    runner(home.path())
        .arg("status")
        .assert()
        .success()
        .stdout(predicate::str::contains("not paired"))
        .stdout(predicate::str::contains("repositories: 0"));
}

#[test]
fn repositories_are_registered_listed_and_removed_locally() {
    let home = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let repo = work.path().join("shop");
    std::fs::create_dir_all(&repo).unwrap();
    git_repo(&repo);

    runner(home.path())
        .args(["repo", "add"])
        .arg(&repo)
        .assert()
        .success()
        .stdout(predicate::str::contains("registered shop"));
    runner(home.path()).args(["repo", "add"]).arg(&repo).assert().failure();
    runner(home.path())
        .args(["repo", "list"])
        .assert()
        .success()
        .stdout(predicate::str::contains("shop").and(predicate::str::contains("ok")));
    runner(home.path())
        .args(["repo", "remove", "shop"])
        .assert()
        .success()
        .stdout(predicate::str::contains("unregistered shop"));
    runner(home.path())
        .args(["repo", "list"])
        .assert()
        .success()
        .stdout(predicate::str::contains("no repositories registered"));
}

#[test]
fn repo_add_rejects_directories_outside_git() {
    let home = tempfile::tempdir().unwrap();
    let plain = tempfile::tempdir().unwrap();
    runner(home.path()).args(["repo", "add"]).arg(plain.path()).assert().failure();
}

#[test]
fn start_requires_pairing() {
    let home = tempfile::tempdir().unwrap();
    runner(home.path())
        .arg("start")
        .assert()
        .failure()
        .stderr(predicate::str::contains("not paired"));
}

#[test]
fn cli_list_succeeds_without_supported_clis_allowed() {
    let home = tempfile::tempdir().unwrap();
    std::fs::write(home.path().join("runner.toml"), "[policy]\nallowed_clis = []\n").unwrap();
    runner(home.path())
        .args(["cli", "list"])
        .assert()
        .success()
        .stdout(predicate::str::contains("no supported agent CLI found"));
}
