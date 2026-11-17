//! Git operations (§7.6). The runner shells out to `git` (>= 2.38); every function here is
//! synchronous and is called from blocking tasks.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use coffe_protocol::{
    DiffFile, DiffSummary, FileStatus, GitFileResult, GitMergeResult, MergeStatus, MergeStrategy,
    WorktreeInfo,
};
use uuid::Uuid;

use crate::paths::canonical;

/// Ticket branches live in this namespace; nothing else is created, merged from or deleted.
pub const BRANCH_NAMESPACE: &str = "coffe/";
/// `pushurl` given to agent processes for every remote (defence in depth, §7.6).
pub const PUSH_BLOCK_URL: &str = "coffe-blocked://push-disabled";
/// Cap of the unified patch stored by the control plane.
pub const PATCH_CAP_BYTES: usize = 2 * 1024 * 1024;
/// Largest file relayed by `git.file`, whatever the request asks for.
pub const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
/// Oldest supported git (`merge-tree --write-tree`).
pub const MIN_GIT_VERSION: (u32, u32) = (2, 38);

const EXCLUDE_ENTRY: &str = ".coffe/";
const FALLBACK_IDENTITY: [&str; 4] =
    ["-c", "user.name=COFFE Runner", "-c", "user.email=runner@coffe.local"];

#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("git: {0}")]
    Io(#[from] io::Error),
    #[error("git {command} failed ({}): {stderr}", exit_label(*.code))]
    Failed { command: String, code: Option<i32>, stderr: String },
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Scope(String),
}

fn exit_label(code: Option<i32>) -> String {
    code.map_or_else(|| "killed by a signal".to_owned(), |code| format!("exit code {code}"))
}

macro_rules! git_args {
    ($($arg:expr),* $(,)?) => { [$(::std::ffi::OsStr::new($arg)),*] };
}

#[derive(Debug)]
pub struct GitOutput {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

impl GitOutput {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }

    /// Stdout as trimmed text.
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).trim().to_owned()
    }

    /// Most useful human-readable line for an error message.
    fn reason(&self) -> String {
        let stderr = self.stderr.trim();
        let text = if stderr.is_empty() { self.text() } else { stderr.to_owned() };
        text.lines().find(|line| !line.trim().is_empty()).unwrap_or("no output").trim().to_owned()
    }
}

fn command(dir: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Runs git and returns its output whatever the exit status.
pub fn run<I, S>(dir: &Path, args: I) -> Result<GitOutput, GitError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = command(dir).args(args).output()?;
    Ok(GitOutput {
        code: output.status.code(),
        stdout: output.stdout,
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// Runs git and fails on a non-zero exit status.
pub fn run_checked<I, S>(dir: &Path, args: I) -> Result<GitOutput, GitError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let args: Vec<OsString> = args.into_iter().map(|arg| arg.as_ref().to_os_string()).collect();
    let output = run(dir, &args)?;
    if output.success() {
        return Ok(output);
    }
    let command = args.iter().map(|arg| arg.to_string_lossy()).collect::<Vec<_>>().join(" ");
    Err(GitError::Failed { command, code: output.code, stderr: output.reason() })
}

// ---------------------------------------------------------------------------
// Repository facts
// ---------------------------------------------------------------------------

/// `(major, minor, patch)` of the installed git.
pub fn version() -> Result<(u32, u32, u32), GitError> {
    let text = run_checked(Path::new("."), ["--version"])?.text();
    parse_version(&text)
        .ok_or_else(|| GitError::Invalid(format!("unrecognized `git --version` output: {text}")))
}

pub fn parse_version(text: &str) -> Option<(u32, u32, u32)> {
    fn leading_number(part: &str) -> Option<u32> {
        let digits: String = part.chars().take_while(char::is_ascii_digit).collect();
        digits.parse().ok()
    }
    let mut parts = text.trim().strip_prefix("git version ")?.split('.');
    let major = leading_number(parts.next()?)?;
    let minor = leading_number(parts.next()?)?;
    let patch = parts.next().and_then(leading_number).unwrap_or(0);
    Some((major, minor, patch))
}

/// Root of the work tree containing `path`.
pub fn toplevel(path: &Path) -> Result<PathBuf, GitError> {
    if !path.is_dir() {
        return Err(GitError::Invalid(format!("{} is not a directory", path.display())));
    }
    let output = run(path, ["rev-parse", "--show-toplevel"])?;
    let root = output.text();
    if !output.success() || root.is_empty() {
        return Err(GitError::Invalid(format!("{} is not inside a git work tree", path.display())));
    }
    Ok(PathBuf::from(root))
}

fn rev_parse(repo: &Path, rev: &str) -> Result<Option<String>, GitError> {
    let output = run(repo, ["rev-parse", "--verify", "--quiet", rev])?;
    let commit = output.text();
    Ok((output.success() && !commit.is_empty()).then_some(commit))
}

pub fn head_commit(dir: &Path) -> Result<Option<String>, GitError> {
    rev_parse(dir, "HEAD^{commit}")
}

pub fn current_branch(dir: &Path) -> Result<Option<String>, GitError> {
    let output = run(dir, ["symbolic-ref", "--short", "-q", "HEAD"])?;
    let branch = output.text();
    Ok((output.success() && !branch.is_empty()).then_some(branch))
}

/// `origin`'s default branch, else the current branch, else `main`.
pub fn default_branch(dir: &Path) -> Result<String, GitError> {
    let output = run(dir, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"])?;
    let remote_head = output.text();
    if output.success() {
        if let Some(branch) = remote_head.strip_prefix("origin/").filter(|name| !name.is_empty()) {
            return Ok(branch.to_owned());
        }
    }
    Ok(current_branch(dir)?.unwrap_or_else(|| "main".to_owned()))
}

pub fn remotes(dir: &Path) -> Result<Vec<String>, GitError> {
    let output = run_checked(dir, ["remote"])?;
    Ok(output.text().lines().map(str::trim).filter(|name| !name.is_empty()).map(str::to_owned).collect())
}

/// URL of `origin` (or the first remote) with credentials removed.
pub fn remote_url(dir: &Path) -> Result<Option<String>, GitError> {
    let names = remotes(dir)?;
    let Some(name) = names.iter().find(|name| *name == "origin").or_else(|| names.first()) else {
        return Ok(None);
    };
    let output = run(dir, ["config", "--get", &format!("remote.{name}.url")])?;
    let url = output.text();
    Ok((output.success() && !url.is_empty()).then(|| strip_credentials(&url)))
}

/// Removes embedded credentials: the whole userinfo for http(s), only the password elsewhere
/// (`ssh://git@host/…` keeps its login name). scp-like `git@host:path` has none.
pub fn strip_credentials(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_owned();
    };
    let (authority, tail) = match rest.find('/') {
        Some(index) => rest.split_at(index),
        None => (rest, ""),
    };
    let Some((userinfo, host)) = authority.rsplit_once('@') else {
        return url.to_owned();
    };
    if scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https") {
        return format!("{scheme}://{host}{tail}");
    }
    let user = userinfo.split(':').next().unwrap_or_default();
    format!("{scheme}://{user}@{host}{tail}")
}

fn identity_args(dir: &Path) -> Result<&'static [&'static str], GitError> {
    for key in ["user.name", "user.email"] {
        let output = run(dir, ["config", "--get", key])?;
        if !output.success() || output.text().is_empty() {
            return Ok(&FALLBACK_IDENTITY);
        }
    }
    Ok(&[])
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/// `git check-ref-format --branch`, with option-like and `@{…}` forms rejected up front.
pub fn check_branch_format(repo: &Path, name: &str) -> Result<(), GitError> {
    let invalid = || GitError::Invalid(format!("invalid branch name {name:?}"));
    if name.is_empty()
        || name.starts_with('-')
        || name.contains("@{")
        || name.chars().any(char::is_control)
    {
        return Err(invalid());
    }
    let output = run(repo, ["check-ref-format", "--branch", name])?;
    if output.success() && output.text() == name { Ok(()) } else { Err(invalid()) }
}

/// A ticket branch: well-formed and inside the `coffe/` namespace.
pub fn validate_branch(repo: &Path, branch: &str) -> Result<(), GitError> {
    if branch.strip_prefix(BRANCH_NAMESPACE).is_none_or(str::is_empty) {
        return Err(GitError::Scope(format!(
            "branch {branch:?} is outside the {BRANCH_NAMESPACE} namespace"
        )));
    }
    check_branch_format(repo, branch)
}

fn validate_rev(rev: &str) -> Result<(), GitError> {
    let well_formed = !rev.is_empty()
        && rev.len() <= 255
        && !rev.starts_with('-')
        && !rev.contains("..")
        && rev.chars().all(|c| {
            !c.is_whitespace() && !c.is_control() && !matches!(c, ':' | '\\' | '?' | '*' | '[')
        });
    if well_formed { Ok(()) } else { Err(GitError::Invalid(format!("invalid revision {rev:?}"))) }
}

/// A repo-relative path: forward slashes, no absolute form, no `.`/`..`/empty components.
pub fn validate_repo_path(path: &str) -> Result<(), GitError> {
    let escapes = path.is_empty()
        || path.starts_with('-')
        || path.contains('\\')
        || path.contains('\0')
        || Path::new(path).is_absolute()
        || path.split('/').any(|part| part.is_empty() || part == "." || part == "..")
        || path.split('/').next().is_some_and(|first| first.ends_with(':'));
    if escapes {
        return Err(GitError::Scope(format!("path {path:?} is not a repo-relative path")));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeEntry {
    pub path: PathBuf,
    pub head: Option<String>,
    /// Short branch name; `None` when detached or bare.
    pub branch: Option<String>,
    pub prunable: bool,
}

pub fn list_worktrees(repo: &Path) -> Result<Vec<WorktreeEntry>, GitError> {
    let output = run_checked(repo, ["worktree", "list", "--porcelain", "-z"])?;
    Ok(parse_worktree_list(&output.stdout))
}

fn parse_worktree_list(raw: &[u8]) -> Vec<WorktreeEntry> {
    let mut entries = Vec::new();
    let mut current: Option<WorktreeEntry> = None;
    for field in raw.split(|byte| *byte == 0) {
        if field.is_empty() {
            entries.extend(current.take());
            continue;
        }
        let text = String::from_utf8_lossy(field);
        let (key, value) = text.split_once(' ').unwrap_or((text.as_ref(), ""));
        if key == "worktree" {
            entries.extend(current.take());
            current = Some(WorktreeEntry {
                path: PathBuf::from(value),
                head: None,
                branch: None,
                prunable: false,
            });
            continue;
        }
        let Some(entry) = current.as_mut() else { continue };
        match key {
            "HEAD" => entry.head = Some(value.to_owned()),
            "branch" => {
                entry.branch = Some(value.strip_prefix("refs/heads/").unwrap_or(value).to_owned());
            }
            "prunable" => entry.prunable = true,
            _ => {}
        }
    }
    entries.extend(current);
    entries
}

fn worktree_for_branch(repo: &Path, branch: &str) -> Result<Option<WorktreeEntry>, GitError> {
    Ok(list_worktrees(repo)?.into_iter().find(|entry| entry.branch.as_deref() == Some(branch)))
}

/// Directory of the live worktree that has `branch` checked out, if any.
pub fn worktree_path(repo: &Path, branch: &str) -> Result<Option<PathBuf>, GitError> {
    Ok(worktree_for_branch(repo, branch)?.map(|entry| entry.path).filter(|path| path.is_dir()))
}

fn branch_exists(repo: &Path, branch: &str) -> Result<bool, GitError> {
    let reference = format!("refs/heads/{branch}");
    Ok(run(repo, ["show-ref", "--verify", "--quiet", reference.as_str()])?.success())
}

/// Commit of a base branch: the local branch, else `origin/<branch>`.
fn resolve_base(repo: &Path, base_branch: &str) -> Result<String, GitError> {
    check_branch_format(repo, base_branch)?;
    for reference in
        [format!("refs/heads/{base_branch}"), format!("refs/remotes/origin/{base_branch}")]
    {
        if let Some(commit) = rev_parse(repo, &format!("{reference}^{{commit}}"))? {
            return Ok(commit);
        }
    }
    Err(GitError::NotFound(format!("base branch {base_branch:?} does not exist")))
}

fn merge_base(repo: &Path, left: &str, right: &str) -> Result<Option<String>, GitError> {
    let output = run(repo, ["merge-base", left, right])?;
    let commit = output.text();
    Ok((output.success() && !commit.is_empty()).then_some(commit))
}

/// Base branch recorded when the ticket worktree was created.
pub fn recorded_base(repo: &Path, branch: &str) -> Result<Option<String>, GitError> {
    let output = run(repo, ["config", "--get", &format!("branch.{branch}.coffe-base")])?;
    let base = output.text();
    Ok((output.success() && !base.is_empty()).then_some(base))
}

#[derive(Debug, Clone, PartialEq)]
pub struct PreparedWorktree {
    pub path: PathBuf,
    pub info: WorktreeInfo,
}

/// Creates (or reuses) the worktree of a ticket branch under `managed_root/<dir_name>`.
pub fn ensure_branch_worktree(
    repo: &Path,
    managed_root: &Path,
    dir_name: &str,
    branch: &str,
    base_branch: &str,
) -> Result<PreparedWorktree, GitError> {
    validate_branch(repo, branch)?;
    let base_tip = resolve_base(repo, base_branch)?;
    std::fs::create_dir_all(managed_root)?;
    let managed_root = canonical(managed_root)?;

    let mut existing = worktree_for_branch(repo, branch)?;
    if existing.as_ref().is_some_and(|entry| entry.prunable || !entry.path.is_dir()) {
        run_checked(repo, ["worktree", "prune"])?;
        existing = None;
    }
    let path = match existing {
        Some(entry) => {
            let resolved = canonical(&entry.path)?;
            if !resolved.starts_with(&managed_root) {
                return Err(GitError::Scope(format!(
                    "branch {branch} is checked out outside the runner-managed worktrees ({})",
                    entry.path.display()
                )));
            }
            resolved
        }
        None => {
            let path = managed_root.join(dir_name);
            if path.exists() {
                run_checked(repo, ["worktree", "prune"])?;
                if !path.is_dir() || std::fs::read_dir(&path)?.next().is_some() {
                    return Err(GitError::Invalid(format!(
                        "{} already exists and is not the worktree of {branch}",
                        path.display()
                    )));
                }
            }
            if branch_exists(repo, branch)? {
                run_checked(repo, git_args!["worktree", "add", &path, branch])?;
            } else {
                run_checked(repo, git_args!["worktree", "add", "-b", branch, &path, &base_tip])?;
            }
            canonical(&path)?
        }
    };

    run_checked(repo, ["config", &format!("branch.{branch}.coffe-base"), base_branch])?;
    let base_commit =
        merge_base(repo, &base_tip, &format!("refs/heads/{branch}"))?.unwrap_or(base_tip);
    let info = WorktreeInfo {
        path: path.display().to_string(),
        branch: Some(branch.to_owned()),
        base_branch: base_branch.to_owned(),
        base_commit,
    };
    Ok(PreparedWorktree { path, info })
}

/// Detached scratch worktree at `base_branch` for read-only runs.
pub fn add_detached_worktree(
    repo: &Path,
    path: &Path,
    base_branch: &str,
) -> Result<PreparedWorktree, GitError> {
    let base_commit = resolve_base(repo, base_branch)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    run_checked(repo, git_args!["worktree", "add", "--detach", path, &base_commit])?;
    let path = canonical(path)?;
    let info = WorktreeInfo {
        path: path.display().to_string(),
        branch: None,
        base_branch: base_branch.to_owned(),
        base_commit,
    };
    Ok(PreparedWorktree { path, info })
}

/// Removes a runner-managed worktree directory (used for detached scratch worktrees).
pub fn remove_worktree_dir(repo: &Path, path: &Path) -> Result<(), GitError> {
    run_checked(repo, git_args!["worktree", "remove", "--force", path])?;
    Ok(())
}

/// Removes the worktree of a ticket branch (only inside `managed_root`) and optionally the
/// branch itself. Missing pieces are not an error, so the operation is idempotent.
pub fn remove_branch_worktree(
    repo: &Path,
    managed_root: &Path,
    branch: &str,
    delete_branch: bool,
) -> Result<(), GitError> {
    validate_branch(repo, branch)?;
    if let Some(entry) = worktree_for_branch(repo, branch)? {
        if entry.path.is_dir() {
            let resolved = canonical(&entry.path)?;
            let inside = canonical(managed_root).is_ok_and(|root| resolved.starts_with(root));
            if !inside {
                return Err(GitError::Scope(format!(
                    "branch {branch} is checked out outside the runner-managed worktrees ({})",
                    entry.path.display()
                )));
            }
            run_checked(repo, git_args!["worktree", "remove", "--force", &resolved])?;
        }
        run_checked(repo, ["worktree", "prune"])?;
    }
    if delete_branch && branch_exists(repo, branch)? {
        run_checked(repo, ["branch", "-D", branch])?;
    }
    Ok(())
}

/// Adds `.coffe/` to `<git-common-dir>/info/exclude` so context files never show up in diffs.
pub fn exclude_coffe_dir(worktree: &Path) -> Result<(), GitError> {
    let mut common = PathBuf::from(run_checked(worktree, ["rev-parse", "--git-common-dir"])?.text());
    if common.is_relative() {
        common = worktree.join(common);
    }
    let info = common.join("info");
    std::fs::create_dir_all(&info)?;
    let exclude = info.join("exclude");
    let mut contents = match std::fs::read_to_string(&exclude) {
        Ok(text) => text,
        Err(err) if err.kind() == io::ErrorKind::NotFound => String::new(),
        Err(err) => return Err(err.into()),
    };
    if contents.lines().any(|line| line.trim() == EXCLUDE_ENTRY) {
        return Ok(());
    }
    if !contents.is_empty() && !contents.ends_with('\n') {
        contents.push('\n');
    }
    contents.push_str(EXCLUDE_ENTRY);
    contents.push('\n');
    std::fs::write(&exclude, contents)?;
    Ok(())
}

/// Environment that points every remote's `pushurl` at an unusable URL for agent processes.
pub fn push_block_env(repo: &Path) -> Result<Vec<(String, String)>, GitError> {
    let names = remotes(repo)?;
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let mut env = Vec::with_capacity(1 + names.len() * 2);
    env.push(("GIT_CONFIG_COUNT".to_owned(), names.len().to_string()));
    for (index, name) in names.iter().enumerate() {
        env.push((format!("GIT_CONFIG_KEY_{index}"), format!("remote.{name}.pushurl")));
        env.push((format!("GIT_CONFIG_VALUE_{index}"), PUSH_BLOCK_URL.to_owned()));
    }
    Ok(env)
}

// ---------------------------------------------------------------------------
// Commit, diff, file
// ---------------------------------------------------------------------------

/// `git add -A` + commit with a `Coffe-Run` trailer. Returns the new commit, or `None` when
/// the worktree had no changes.
pub fn commit_all(worktree: &Path, run_id: Uuid, message: &str) -> Result<Option<String>, GitError> {
    run_checked(worktree, ["add", "-A"])?;
    let staged = run(worktree, ["diff", "--cached", "--quiet"])?;
    match staged.code {
        Some(0) => return Ok(None),
        Some(1) => {}
        _ => {
            return Err(GitError::Failed {
                command: "diff --cached --quiet".to_owned(),
                code: staged.code,
                stderr: staged.reason(),
            });
        }
    }
    let trailer = format!("Coffe-Run: {run_id}");
    let mut args: Vec<&str> = identity_args(worktree)?.to_vec();
    args.extend(["-c", "commit.gpgsign=false", "commit", "--no-verify", "-q", "-m", message, "-m"]);
    args.push(&trailer);
    run_checked(worktree, &args)?;
    head_commit(worktree)
}

/// Summary of `base...head` (changes on `head` since it forked from `base`).
pub fn diff_summary(
    dir: &Path,
    base: &str,
    head: &str,
    include_patch: bool,
    patch_cap: usize,
) -> Result<DiffSummary, GitError> {
    let commit_of = |rev: &str| -> Result<String, GitError> {
        rev_parse(dir, &format!("{rev}^{{commit}}"))?
            .ok_or_else(|| GitError::NotFound(format!("revision {rev:?} does not exist")))
    };
    let head_commit = commit_of(head)?;
    let base_tip = commit_of(base)?;
    let base_commit = merge_base(dir, &base_tip, &head_commit)?.unwrap_or(base_tip);

    let range = [base_commit.as_str(), head_commit.as_str()];
    let numstat = run_checked(dir, ["diff", "--numstat", "-M", "-z"].into_iter().chain(range))?;
    let name_status =
        run_checked(dir, ["diff", "--name-status", "-M", "-z"].into_iter().chain(range))?;
    let mut stats = parse_numstat(&numstat.stdout);

    let mut files = Vec::new();
    let (mut additions, mut deletions) = (0u64, 0u64);
    for (status, path, old_path) in parse_name_status(&name_status.stdout) {
        let (added, deleted) = stats.remove(&path).unwrap_or((None, None));
        additions += added.unwrap_or(0);
        deletions += deleted.unwrap_or(0);
        files.push(DiffFile {
            binary: added.is_none() && deleted.is_none(),
            path,
            old_path,
            status,
            additions: added,
            deletions: deleted,
        });
    }

    let (patch, truncated) = if include_patch {
        capped_patch(dir, &base_commit, &head_commit, patch_cap)?
    } else {
        (String::new(), false)
    };
    Ok(DiffSummary { base_commit, head_commit, files, additions, deletions, patch, truncated })
}

type LineCounts = (Option<u64>, Option<u64>);

/// `--numstat -z`: `added TAB deleted TAB path NUL`, renames as `added TAB deleted TAB NUL
/// old NUL new NUL`. Binary files report `-` for both counts.
fn parse_numstat(raw: &[u8]) -> HashMap<String, LineCounts> {
    let mut stats = HashMap::new();
    let mut fields = raw.split(|byte| *byte == 0);
    while let Some(field) = fields.next() {
        let text = String::from_utf8_lossy(field);
        let mut parts = text.splitn(3, '\t');
        let (Some(added), Some(deleted), Some(path)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let path = if path.is_empty() {
            let _old_path = fields.next();
            match fields.next() {
                Some(new_path) => String::from_utf8_lossy(new_path).into_owned(),
                None => break,
            }
        } else {
            path.to_owned()
        };
        stats.insert(path, (added.parse().ok(), deleted.parse().ok()));
    }
    stats
}

/// `--name-status -z`: `status NUL path NUL`, renames/copies as `Rnnn NUL old NUL new NUL`.
fn parse_name_status(raw: &[u8]) -> Vec<(FileStatus, String, Option<String>)> {
    let lossy = |bytes: &[u8]| String::from_utf8_lossy(bytes).into_owned();
    let mut entries = Vec::new();
    let mut fields = raw.split(|byte| *byte == 0).filter(|field| !field.is_empty());
    while let Some(code) = fields.next() {
        let status = match code.first() {
            Some(b'A') => FileStatus::Added,
            Some(b'M') => FileStatus::Modified,
            Some(b'D') => FileStatus::Deleted,
            Some(b'R') => FileStatus::Renamed,
            Some(b'C') => FileStatus::Copied,
            Some(b'T') => FileStatus::TypeChanged,
            Some(b'U') => FileStatus::Unmerged,
            _ => FileStatus::Unknown,
        };
        if matches!(status, FileStatus::Renamed | FileStatus::Copied) {
            let (Some(old_path), Some(new_path)) = (fields.next(), fields.next()) else { break };
            entries.push((status, lossy(new_path), Some(lossy(old_path))));
        } else {
            let Some(path) = fields.next() else { break };
            entries.push((status, lossy(path), None));
        }
    }
    entries
}

/// Unified patch, cut at the last complete line within `cap` bytes.
fn capped_patch(dir: &Path, base: &str, head: &str, cap: usize) -> Result<(String, bool), GitError> {
    let mut child = command(dir)
        .args(["diff", "--no-color", "--no-ext-diff", "-M", base, head])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut buffer = Vec::new();
    if let Some(stdout) = child.stdout.as_mut() {
        stdout.take(cap as u64 + 1).read_to_end(&mut buffer)?;
    }
    let truncated = buffer.len() > cap;
    if truncated {
        // git may still be writing; it is not needed any more.
        let _ = child.kill();
        buffer.truncate(cap);
        if let Some(newline) = buffer.iter().rposition(|byte| *byte == b'\n') {
            buffer.truncate(newline + 1);
        }
    }
    drop(child.stdout.take());
    let status = child.wait()?;
    if !truncated && !status.success() {
        return Err(GitError::Failed {
            command: "diff".to_owned(),
            code: status.code(),
            stderr: "could not produce the patch".to_owned(),
        });
    }
    Ok((String::from_utf8_lossy(&buffer).into_owned(), truncated))
}

/// Content of `path` at `rev` (`git show <rev>:<path>`), size-capped; binary files (NUL byte)
/// are reported without content.
pub fn read_file(repo: &Path, rev: &str, path: &str, max_bytes: u64) -> Result<GitFileResult, GitError> {
    validate_rev(rev)?;
    validate_repo_path(path)?;
    let object = format!("{rev}:{path}");
    let mut result = GitFileResult {
        path: path.to_owned(),
        rev: rev.to_owned(),
        content: None,
        size: 0,
        binary: false,
        too_large: false,
        missing: false,
    };
    let kind = run(repo, ["cat-file", "-t", object.as_str()])?;
    if !kind.success() || kind.text() != "blob" {
        result.missing = true;
        return Ok(result);
    }
    let size_text = run_checked(repo, ["cat-file", "-s", object.as_str()])?.text();
    result.size = size_text
        .parse()
        .map_err(|_| GitError::Invalid(format!("unexpected `git cat-file -s` output: {size_text}")))?;
    if result.size > max_bytes.min(MAX_FILE_BYTES) {
        result.too_large = true;
        return Ok(result);
    }
    let blob = run_checked(repo, ["show", object.as_str()])?.stdout;
    if blob.contains(&0) {
        result.binary = true;
        return Ok(result);
    }
    result.content = Some(BASE64.encode(&blob));
    Ok(result)
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct MergeRequest<'a> {
    pub branch: &'a str,
    pub into: &'a str,
    pub strategy: MergeStrategy,
    pub message: &'a str,
    /// Requested by the control plane (review approval with `push_on_approve`).
    pub push: bool,
    pub remote: Option<&'a str>,
    pub remove_worktree: bool,
    /// Runner policy `allow_push`; pushing needs both.
    pub allow_push: bool,
    /// Runner-managed worktree root of this repo (cleanup scope).
    pub managed_root: &'a Path,
}

fn merge_result(status: MergeStatus, merge_commit: Option<String>, message: Option<String>) -> GitMergeResult {
    GitMergeResult { status, merge_commit, pushed: false, conflicts: Vec::new(), message }
}

fn merge_failed(message: String) -> GitMergeResult {
    merge_result(MergeStatus::Failed, None, Some(message))
}

fn merge_conflict(mut conflicts: Vec<String>, output: &GitOutput) -> GitMergeResult {
    if conflicts.is_empty() {
        return merge_failed(output.reason());
    }
    conflicts.sort();
    conflicts.dedup();
    GitMergeResult {
        status: MergeStatus::Conflict,
        merge_commit: None,
        pushed: false,
        message: Some(format!("{} conflicting file(s)", conflicts.len())),
        conflicts,
    }
}

fn nul_separated(raw: &[u8]) -> Vec<String> {
    raw.split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .map(|field| String::from_utf8_lossy(field).into_owned())
        .collect()
}

/// Merges a ticket branch into its target (§7.6): in the checkout that has the target
/// branch (which must be clean), or object-only when it is not checked out anywhere.
/// Operational failures are reported in the result; `Err` means the request was invalid.
pub fn merge(repo: &Path, request: &MergeRequest<'_>) -> Result<GitMergeResult, GitError> {
    validate_branch(repo, request.branch)?;
    check_branch_format(repo, request.into)?;
    let into_ref = format!("refs/heads/{}", request.into);
    let Some(tip) = rev_parse(repo, &format!("refs/heads/{}^{{commit}}", request.branch))? else {
        return Ok(merge_failed(format!("branch {} does not exist", request.branch)));
    };
    let Some(target) = rev_parse(repo, &format!("{into_ref}^{{commit}}"))? else {
        return Ok(merge_failed(format!("target branch {} does not exist", request.into)));
    };
    let ahead = run_checked(repo, ["rev-list", "--count", &format!("{target}..{tip}")])?.text();
    if ahead == "0" {
        return Ok(merge_result(
            MergeStatus::NothingToMerge,
            None,
            Some(format!("{} has no commits that are not in {}", request.branch, request.into)),
        ));
    }
    let default_message = format!("Merge {} into {}", request.branch, request.into);
    let message =
        if request.message.trim().is_empty() { default_message.as_str() } else { request.message };

    let checkout = list_worktrees(repo)?
        .into_iter()
        .find(|entry| entry.branch.as_deref() == Some(request.into) && entry.path.is_dir());
    let mut result = match checkout {
        Some(entry) => merge_in_checkout(&entry.path, request, message)?,
        None => merge_objects(repo, request.strategy, &into_ref, &target, &tip, message)?,
    };
    if result.status != MergeStatus::Merged {
        return Ok(result);
    }

    let mut notes = Vec::new();
    if request.push {
        match push_target(repo, request, &into_ref)? {
            Ok(()) => result.pushed = true,
            Err(note) => notes.push(note),
        }
    }
    if request.remove_worktree {
        if let Err(err) = remove_branch_worktree(repo, request.managed_root, request.branch, true) {
            notes.push(format!("worktree cleanup failed: {err}"));
        }
    }
    if !notes.is_empty() {
        result.message = Some(notes.join("; "));
    }
    Ok(result)
}

fn merge_in_checkout(
    checkout: &Path,
    request: &MergeRequest<'_>,
    message: &str,
) -> Result<GitMergeResult, GitError> {
    let dirty = run_checked(checkout, ["status", "--porcelain", "--untracked-files=no"])?;
    if !dirty.stdout.is_empty() {
        return Ok(merge_failed(format!(
            "{} is checked out at {} with uncommitted changes",
            request.into,
            checkout.display()
        )));
    }
    let identity = identity_args(checkout)?;
    match request.strategy {
        MergeStrategy::FfOnly => {
            let output = run(checkout, ["merge", "--ff-only", request.branch])?;
            if !output.success() {
                return Ok(merge_failed(format!(
                    "{} cannot be fast-forwarded to {}: {}",
                    request.into,
                    request.branch,
                    output.reason()
                )));
            }
        }
        MergeStrategy::Merge => {
            let mut args = identity.to_vec();
            args.extend(["-c", "commit.gpgsign=false", "merge", "--no-ff", "--no-verify", "-m"]);
            args.extend([message, request.branch]);
            let output = run(checkout, &args)?;
            if !output.success() {
                let conflicts = unmerged_paths(checkout)?;
                run(checkout, ["merge", "--abort"])?;
                return Ok(merge_conflict(conflicts, &output));
            }
        }
        MergeStrategy::Squash => {
            let output = run(checkout, ["merge", "--squash", request.branch])?;
            if !output.success() {
                let conflicts = unmerged_paths(checkout)?;
                run(checkout, ["reset", "--merge"])?;
                return Ok(merge_conflict(conflicts, &output));
            }
            if run(checkout, ["diff", "--cached", "--quiet"])?.success() {
                return Ok(merge_result(
                    MergeStatus::NothingToMerge,
                    None,
                    Some(format!("{} introduces no changes to {}", request.branch, request.into)),
                ));
            }
            let mut args = identity.to_vec();
            args.extend(["-c", "commit.gpgsign=false", "commit", "--no-verify", "-q", "-m", message]);
            run_checked(checkout, &args)?;
        }
    }
    Ok(merge_result(MergeStatus::Merged, head_commit(checkout)?, None))
}

fn unmerged_paths(checkout: &Path) -> Result<Vec<String>, GitError> {
    let output = run(checkout, ["diff", "--name-only", "--diff-filter=U", "-z"])?;
    Ok(nul_separated(&output.stdout))
}

/// Merge without a checkout: `merge-tree --write-tree` + `commit-tree` + `update-ref` guarded
/// by the expected old value.
fn merge_objects(
    repo: &Path,
    strategy: MergeStrategy,
    into_ref: &str,
    target: &str,
    tip: &str,
    message: &str,
) -> Result<GitMergeResult, GitError> {
    let merge_commit = match strategy {
        MergeStrategy::FfOnly => {
            if !run(repo, ["merge-base", "--is-ancestor", target, tip])?.success() {
                return Ok(merge_failed(
                    "the target branch has diverged; a fast-forward is not possible".to_owned(),
                ));
            }
            tip.to_owned()
        }
        MergeStrategy::Merge | MergeStrategy::Squash => {
            let output = run(
                repo,
                ["merge-tree", "--write-tree", "-z", "--name-only", "--no-messages", target, tip],
            )?;
            let mut fields = nul_separated(&output.stdout).into_iter();
            let tree = fields.next();
            match (output.code, tree) {
                (Some(0), Some(tree)) => {
                    let mut args = identity_args(repo)?.to_vec();
                    args.extend(["commit-tree", tree.as_str(), "-p", target]);
                    if strategy == MergeStrategy::Merge {
                        args.extend(["-p", tip]);
                    }
                    args.extend(["-m", message]);
                    run_checked(repo, &args)?.text()
                }
                (Some(1), Some(_)) => return Ok(merge_conflict(fields.collect(), &output)),
                _ => return Ok(merge_failed(output.reason())),
            }
        }
    };
    let update = run(
        repo,
        ["update-ref", "-m", "coffe: merge approved ticket branch", into_ref, &merge_commit, target],
    )?;
    if !update.success() {
        return Ok(merge_failed(format!(
            "the target branch moved during the merge: {}",
            update.reason()
        )));
    }
    Ok(merge_result(MergeStatus::Merged, Some(merge_commit), None))
}

/// Pushes the merged target branch. The outer error is a git failure; the inner one is a
/// note for the merge result (the merge itself stays successful).
fn push_target(
    repo: &Path,
    request: &MergeRequest<'_>,
    into_ref: &str,
) -> Result<Result<(), String>, GitError> {
    if !request.allow_push {
        return Ok(Err("push skipped: runner policy allow_push is false".to_owned()));
    }
    let remote = request.remote.unwrap_or("origin");
    if !remotes(repo)?.iter().any(|name| name == remote) {
        return Ok(Err(format!("push skipped: remote {remote:?} is not configured")));
    }
    let output = run(repo, ["push", remote, &format!("{into_ref}:{into_ref}")])?;
    if output.success() { Ok(Ok(())) } else { Ok(Err(format!("push failed: {}", output.reason()))) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_git_version_strings() {
        assert_eq!(parse_version("git version 2.47.1.windows.1"), Some((2, 47, 1)));
        assert_eq!(parse_version("git version 2.39.5 (Apple Git-154)\n"), Some((2, 39, 5)));
        assert_eq!(parse_version("git version 2.38"), Some((2, 38, 0)));
        assert_eq!(parse_version("not git"), None);
    }

    #[test]
    fn strips_credentials_from_remote_urls() {
        assert_eq!(
            strip_credentials("https://user:s3cret@github.com/org/repo.git"),
            "https://github.com/org/repo.git"
        );
        assert_eq!(
            strip_credentials("https://ghp_token@github.com/org/repo.git"),
            "https://github.com/org/repo.git"
        );
        assert_eq!(
            strip_credentials("ssh://git:pw@host.example:2222/org/repo.git"),
            "ssh://git@host.example:2222/org/repo.git"
        );
        assert_eq!(strip_credentials("ssh://git@host/org/repo.git"), "ssh://git@host/org/repo.git");
        assert_eq!(strip_credentials("git@github.com:org/repo.git"), "git@github.com:org/repo.git");
        assert_eq!(strip_credentials("https://github.com/a@b/repo"), "https://github.com/a@b/repo");
        assert_eq!(strip_credentials("/srv/git/repo.git"), "/srv/git/repo.git");
    }

    #[test]
    fn ticket_branches_must_be_namespaced_and_well_formed() {
        let dir = tempfile::tempdir().unwrap();
        validate_branch(dir.path(), "coffe/COF-12").unwrap();
        for outside in ["main", "feature/coffe/x", "coffe/", "coffe"] {
            let err = validate_branch(dir.path(), outside).unwrap_err();
            assert!(matches!(err, GitError::Scope(_)), "{outside}: {err}");
        }
        for malformed in ["coffe/a..b", "coffe/a b", "coffe/x.lock", "coffe/@{-1}", "coffe/a\nb", "coffe/a~1"] {
            let err = validate_branch(dir.path(), malformed).unwrap_err();
            assert!(matches!(err, GitError::Invalid(_)), "{malformed}: {err}");
        }
        for option_like in ["-D", "--force", "@{-1}", ""] {
            assert!(check_branch_format(dir.path(), option_like).is_err(), "{option_like}");
        }
        check_branch_format(dir.path(), "release/1.x").unwrap();
    }

    #[test]
    fn repo_paths_cannot_escape() {
        for ok in ["README.md", "src/lib.rs", "a/b/c.txt", ".github/workflows/ci.yml"] {
            validate_repo_path(ok).unwrap();
        }
        for bad in ["", "/etc/passwd", "../secret", "a/../../b", "a//b", "./a", "a\\b", "C:/x", "-rf", "a/./b"] {
            let err = validate_repo_path(bad).unwrap_err();
            assert!(matches!(err, GitError::Scope(_)), "{bad}: {err}");
        }
    }

    #[test]
    fn revisions_cannot_smuggle_options_or_ranges() {
        for ok in ["HEAD", "main", "coffe/COF-1", "0a1b2c3", "HEAD~2", "main^"] {
            validate_rev(ok).unwrap();
        }
        for bad in ["", "-p", "a..b", "HEAD:path", "a b", "x\ny"] {
            assert!(validate_rev(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn parses_numstat_and_name_status_with_renames_and_binaries() {
        let numstat = b"3\t1\tsrc/a.rs\0-\t-\tlogo.png\x000\t0\t\0old name.txt\0new name.txt\0";
        let stats = parse_numstat(numstat);
        assert_eq!(stats["src/a.rs"], (Some(3), Some(1)));
        assert_eq!(stats["logo.png"], (None, None));
        assert_eq!(stats["new name.txt"], (Some(0), Some(0)));
        assert_eq!(stats.len(), 3);

        let name_status = b"M\0src/a.rs\0A\0logo.png\0R100\0old name.txt\0new name.txt\0D\0gone.txt\0";
        let entries = parse_name_status(name_status);
        assert_eq!(
            entries,
            vec![
                (FileStatus::Modified, "src/a.rs".to_owned(), None),
                (FileStatus::Added, "logo.png".to_owned(), None),
                (FileStatus::Renamed, "new name.txt".to_owned(), Some("old name.txt".to_owned())),
                (FileStatus::Deleted, "gone.txt".to_owned(), None),
            ]
        );
    }

    #[test]
    fn parses_worktree_porcelain() {
        let raw = b"worktree /srv/app\0HEAD 1111\0branch refs/heads/main\0\0worktree /data/wt/COF-1\0HEAD 2222\0branch refs/heads/coffe/COF-1\0\0worktree /data/wt/scratch\0HEAD 3333\0detached\0prunable gitdir file points to non-existent location\0\0";
        let entries = parse_worktree_list(raw);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].branch.as_deref(), Some("main"));
        assert_eq!(entries[1].path, PathBuf::from("/data/wt/COF-1"));
        assert_eq!(entries[1].branch.as_deref(), Some("coffe/COF-1"));
        assert_eq!(entries[1].head.as_deref(), Some("2222"));
        assert_eq!(entries[2].branch, None);
        assert!(entries[2].prunable && !entries[1].prunable);
    }
}
