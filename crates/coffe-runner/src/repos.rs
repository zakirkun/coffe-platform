//! Local-only repository registry (architecture §7.1, §7.3).

use std::path::{Path, PathBuf};

use coffe_protocol::RepoInfo;
use uuid::Uuid;

use crate::config::{RepoEntry, RunnerConfig};
use crate::error::RunnerError;
use crate::git;
use crate::paths::canonical;

/// Registers the git work tree containing `path`. Returns the new entry.
pub fn add(config: &mut RunnerConfig, path: &Path, name: Option<&str>) -> Result<RepoEntry, RunnerError> {
    let root = git::toplevel(path)?;
    let root = canonical(&root)?;
    if let Some(existing) = config.repos.iter().find(|r| r.path == root) {
        return Err(RunnerError::Invalid(format!(
            "{} is already registered as {:?}",
            root.display(),
            existing.name
        )));
    }
    let name = match name {
        Some(name) => name.to_owned(),
        None => root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "repo".to_owned()),
    };
    if config.repos.iter().any(|r| r.name == name) {
        return Err(RunnerError::Invalid(format!("a repository named {name:?} is already registered; pass --name")));
    }
    let entry = RepoEntry { key: Uuid::new_v4().to_string(), name, path: root };
    config.repos.push(entry.clone());
    Ok(entry)
}

/// Unregisters by name or key. Returns the removed entry.
pub fn remove(config: &mut RunnerConfig, name_or_key: &str) -> Result<RepoEntry, RunnerError> {
    let index = config
        .repos
        .iter()
        .position(|r| r.name == name_or_key || r.key == name_or_key)
        .ok_or_else(|| RunnerError::NotFound(format!("no registered repository {name_or_key:?}")))?;
    Ok(config.repos.remove(index))
}

/// What `hello` / `repos.updated` report for one repository (blocking: runs git).
pub fn describe(entry: &RepoEntry) -> RepoInfo {
    let available = entry.path.is_dir() && git::toplevel(&entry.path).is_ok();
    RepoInfo {
        repo_key: entry.key.clone(),
        name: entry.name.clone(),
        path: entry.path.display().to_string(),
        default_branch: available.then(|| git::default_branch(&entry.path).ok()).flatten(),
        remote_url: available
            .then(|| git::remote_url(&entry.path).ok().flatten())
            .flatten()
            .map(|url| git::strip_credentials(&url)),
        head_commit: available.then(|| git::head_commit(&entry.path).ok().flatten()).flatten(),
        available,
    }
}

/// Resolves a repo key to its registered root (scope check, §7.3).
pub fn resolve(config: &RunnerConfig, repo_key: &str) -> Result<PathBuf, RunnerError> {
    let entry = config
        .repo_by_key(repo_key)
        .ok_or_else(|| RunnerError::Scope(format!("repository {repo_key:?} is not registered on this runner")))?;
    if !entry.path.is_dir() {
        return Err(RunnerError::NotFound(format!("{} no longer exists", entry.path.display())));
    }
    Ok(entry.path.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init_repo(dir: &Path) {
        git::run_checked(dir, ["init", "-q", "-b", "main"]).unwrap();
    }

    #[test]
    fn add_list_remove_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("demo");
        std::fs::create_dir_all(repo.join("nested")).unwrap();
        init_repo(&repo);
        let mut config = RunnerConfig::default();

        let entry = add(&mut config, &repo.join("nested"), None).unwrap();
        assert_eq!(entry.name, "demo");
        assert_eq!(entry.path, canonical(&repo).unwrap());
        assert!(add(&mut config, &repo, Some("again")).is_err(), "same path twice");

        assert_eq!(resolve(&config, &entry.key).unwrap(), entry.path);
        assert!(matches!(resolve(&config, "unknown"), Err(RunnerError::Scope(_))));

        let removed = remove(&mut config, "demo").unwrap();
        assert_eq!(removed.key, entry.key);
        assert!(config.repos.is_empty());
    }

    #[test]
    fn add_rejects_directories_outside_git() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = RunnerConfig::default();
        assert!(add(&mut config, dir.path(), None).is_err());
    }
}
