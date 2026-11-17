//! Locations of the runner's local state (§7.2).

use std::io;
use std::path::{Path, PathBuf};

use uuid::Uuid;

/// Resolved state directories. With `--home <dir>` (or `COFFE_RUNNER_HOME`) everything lives
/// under that directory; otherwise the OS conventions from `directories` apply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerHome {
    config_dir: PathBuf,
    data_dir: PathBuf,
}

impl RunnerHome {
    pub fn resolve(home_override: Option<&Path>) -> io::Result<Self> {
        if let Some(dir) = home_override {
            return Ok(Self { config_dir: dir.to_path_buf(), data_dir: dir.to_path_buf() });
        }
        let dirs = directories::ProjectDirs::from("", "", "coffe").ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "cannot determine the home directory; pass --home <dir>",
            )
        })?;
        Ok(Self {
            config_dir: dirs.config_dir().to_path_buf(),
            data_dir: dirs.data_dir().to_path_buf(),
        })
    }

    pub fn config_file(&self) -> PathBuf {
        self.config_dir.join("runner.toml")
    }

    pub fn secrets_dir(&self) -> PathBuf {
        self.config_dir.join("secrets")
    }

    pub fn runs_dir(&self) -> PathBuf {
        self.data_dir.join("runs")
    }

    pub fn run_dir(&self, run_id: Uuid) -> PathBuf {
        self.runs_dir().join(run_id.to_string())
    }

    pub fn worktrees_dir(&self) -> PathBuf {
        self.data_dir.join("worktrees")
    }

    /// Runner-managed worktree root of one registered repo.
    pub fn repo_worktrees_dir(&self, repo_key: &str) -> PathBuf {
        self.worktrees_dir().join(repo_key)
    }
}

/// `fs::canonicalize` without the Windows verbatim prefix (`\\?\C:\…`), which git and many
/// CLIs do not accept as a working directory or argument.
pub fn canonical(path: &Path) -> io::Result<PathBuf> {
    let resolved = std::fs::canonicalize(path)?;
    Ok(strip_verbatim(resolved))
}

#[cfg(windows)]
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let Some(text) = path.to_str() else { return path };
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{unc}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(plain) if plain.as_bytes().get(1) == Some(&b':') => PathBuf::from(plain),
        _ => path,
    }
}

#[cfg(not(windows))]
fn strip_verbatim(path: PathBuf) -> PathBuf {
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_override_keeps_everything_under_one_directory() {
        let home = RunnerHome::resolve(Some(Path::new("state"))).unwrap();
        assert_eq!(home.config_file(), Path::new("state").join("runner.toml"));
        assert_eq!(home.secrets_dir(), Path::new("state").join("secrets"));
        assert_eq!(home.repo_worktrees_dir("k1"), Path::new("state").join("worktrees").join("k1"));
        let run_id = Uuid::nil();
        assert_eq!(home.run_dir(run_id), Path::new("state").join("runs").join(run_id.to_string()));
    }

    #[test]
    fn canonical_paths_have_no_verbatim_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let resolved = canonical(dir.path()).unwrap();
        assert!(resolved.is_absolute());
        assert!(!resolved.to_string_lossy().starts_with(r"\\?\"));
        assert!(resolved.is_dir());
    }
}
