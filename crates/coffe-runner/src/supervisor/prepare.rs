//! Worktree and context preparation before a CLI starts (architecture §7.4).

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use coffe_adapters::ContextFiles;
use coffe_protocol::{ContextBundle, RunStart, WorktreeInfo, WorktreeMode};

use crate::error::RunnerError;
use crate::git;
use crate::paths::RunnerHome;

/// Directory inside the worktree that holds everything COFFE writes (git-excluded).
pub const COFFE_DIR: &str = ".coffe";

/// The prepared working directory of a run.
#[derive(Debug, Clone)]
pub struct Workspace {
    pub path: PathBuf,
    pub info: WorktreeInfo,
    pub context: ContextFiles,
    /// Scratch worktree of a read-only run, removed when the run ends.
    pub detached: bool,
}

/// Creates or reuses the run's worktree, hides `.coffe/` from git and writes the context files.
pub fn prepare(home: &RunnerHome, repo: &Path, start: &RunStart) -> Result<Workspace, RunnerError> {
    let managed_root = home.repo_worktrees_dir(&start.repo_key);
    let (prepared, detached) = match start.worktree.mode {
        WorktreeMode::Branch => {
            let branch = start.worktree.branch.as_deref().filter(|branch| !branch.is_empty()).ok_or_else(|| {
                RunnerError::Invalid("a branch worktree needs a branch name".to_owned())
            })?;
            let prepared = git::ensure_branch_worktree(
                repo,
                &managed_root,
                &worktree_dir_name(branch),
                branch,
                &start.worktree.base_branch,
            )?;
            (prepared, false)
        }
        WorktreeMode::Detached => {
            let path = managed_root.join(format!("run-{}", start.run_id));
            (git::add_detached_worktree(repo, &path, &start.worktree.base_branch)?, true)
        }
    };
    git::exclude_coffe_dir(&prepared.path)?;
    let context = write_context(&prepared.path, &start.context)?;
    Ok(Workspace { path: prepared.path, info: prepared.info, context, detached })
}

/// `coffe/SHOP-1` → `coffe--SHOP-1`: one flat, readable directory per branch.
fn worktree_dir_name(branch: &str) -> String {
    branch
        .split('/')
        .map(|part| {
            part.chars()
                .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '-' })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("--")
}

/// A context file name must stay a plain file name inside the context directory.
fn checked_name(name: &str) -> Result<&str, RunnerError> {
    let valid = !name.is_empty()
        && name.len() <= 200
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if valid {
        Ok(name)
    } else {
        Err(RunnerError::Invalid(format!("invalid context file name {name:?}")))
    }
}

/// Replaces `<worktree>/.coffe/context` with the files of this run (stale files of an earlier
/// run on the same worktree must not leak into the next one).
fn write_context(worktree: &Path, bundle: &ContextBundle) -> Result<ContextFiles, RunnerError> {
    let dir = worktree.join(COFFE_DIR).join("context");
    match fs::remove_dir_all(&dir) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err.into()),
    }
    fs::create_dir_all(&dir)?;

    let mut markdown: Vec<_> = bundle.files.iter().collect();
    markdown.sort_by(|a, b| a.name.cmp(&b.name));
    let mut files = Vec::with_capacity(bundle.files.len() + bundle.attachments.len());
    let mut combined_markdown = String::new();
    for file in markdown {
        let path = dir.join(checked_name(&file.name)?);
        fs::write(&path, &file.content)?;
        if !combined_markdown.is_empty() {
            combined_markdown.push_str("\n\n");
        }
        combined_markdown.push_str(file.content.trim_end());
        files.push(path);
    }
    if !bundle.attachments.is_empty() {
        let attachments = dir.join("attachments");
        fs::create_dir_all(&attachments)?;
        for attachment in &bundle.attachments {
            let bytes = BASE64.decode(&attachment.data).map_err(|err| {
                RunnerError::Invalid(format!("attachment {:?} is not valid base64: {err}", attachment.name))
            })?;
            let path = attachments.join(checked_name(&attachment.name)?);
            fs::write(&path, bytes)?;
            files.push(path);
        }
    }
    Ok(ContextFiles { dir, files, combined_markdown })
}

#[cfg(test)]
mod tests {
    use super::*;
    use coffe_protocol::{ContextAttachment, ContextFile};

    #[test]
    fn branch_names_become_flat_directory_names() {
        assert_eq!(worktree_dir_name("coffe/SHOP-1"), "coffe--SHOP-1");
        assert_eq!(worktree_dir_name("feature/a b"), "feature--a-b");
    }

    #[test]
    fn context_names_cannot_escape_the_context_directory() {
        for name in ["../x.md", "a/b.md", "", ".hidden", "a\\b.md"] {
            assert!(checked_name(name).is_err(), "{name:?} must be rejected");
        }
        assert_eq!(checked_name("01-ticket.md").ok(), Some("01-ticket.md"));
    }

    #[test]
    fn writes_context_files_and_replaces_stale_ones() {
        let dir = tempfile::tempdir().unwrap();
        let stale = dir.path().join(COFFE_DIR).join("context").join("old.md");
        fs::create_dir_all(stale.parent().unwrap()).unwrap();
        fs::write(&stale, "old").unwrap();

        let bundle = ContextBundle {
            files: vec![
                ContextFile { name: "01-ticket.md".into(), content: "# Ticket\n".into() },
                ContextFile { name: "00-rules.md".into(), content: "# Rules\n".into() },
            ],
            attachments: vec![ContextAttachment {
                name: "shot.png".into(),
                mime: "image/png".into(),
                data: BASE64.encode([1u8, 2, 3]),
            }],
        };
        let context = write_context(dir.path(), &bundle).unwrap();

        assert!(!stale.exists());
        assert_eq!(context.combined_markdown, "# Rules\n\n# Ticket");
        assert_eq!(context.files.len(), 3);
        assert_eq!(fs::read(context.dir.join("attachments").join("shot.png")).unwrap(), vec![1, 2, 3]);
    }
}
