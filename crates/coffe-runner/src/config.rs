//! `runner.toml`: server binding, local policy (§7.4) and the local-only repo registry.

use std::io;
use std::path::{Path, PathBuf};

use coffe_protocol::RunnerPolicy;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct RunnerConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runner_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default)]
    pub policy: Policy,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub repos: Vec<RepoEntry>,
}

/// Local policy; enforced by the runner, only reported to the control plane.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Policy {
    pub max_concurrent_runs: u32,
    /// Absent = every detected CLI is allowed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed_clis: Option<Vec<String>>,
    pub allow_full_auto: bool,
    pub allow_docker: bool,
    pub allow_db: bool,
    pub allow_db_writes: bool,
    pub allow_ssh: bool,
    pub allow_preview_ports: String,
    pub allow_push: bool,
    pub enable_fake_cli: bool,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            max_concurrent_runs: 4,
            allowed_clis: None,
            allow_full_auto: false,
            allow_docker: false,
            allow_db: false,
            allow_db_writes: false,
            allow_ssh: false,
            allow_preview_ports: "3000-9999".to_owned(),
            allow_push: false,
            enable_fake_cli: false,
        }
    }
}

impl Policy {
    pub fn to_wire(&self) -> RunnerPolicy {
        RunnerPolicy {
            max_concurrent_runs: self.max_concurrent_runs,
            allowed_clis: self.allowed_clis.clone(),
            allow_full_auto: self.allow_full_auto,
            allow_docker: self.allow_docker,
            allow_db: self.allow_db,
            allow_db_writes: self.allow_db_writes,
            allow_ssh: self.allow_ssh,
            allow_preview_ports: self.allow_preview_ports.clone(),
            allow_push: self.allow_push,
            enable_fake_cli: self.enable_fake_cli,
        }
    }

    pub fn cli_allowed(&self, cli_id: &str) -> bool {
        match &self.allowed_clis {
            Some(allowed) => allowed.iter().any(|id| id == cli_id),
            None => true,
        }
    }
}

/// One registered repository. `key` is the stable id the control plane uses; the path never
/// leaves this machine except for display.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoEntry {
    pub key: String,
    pub name: String,
    pub path: PathBuf,
}

/// Server binding written by `pair`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pairing {
    pub server_url: String,
    pub runner_id: Uuid,
}

impl RunnerConfig {
    /// Reads `runner.toml`; a missing file is an unpaired default configuration.
    pub fn load(path: &Path) -> io::Result<Self> {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(err) => return Err(err),
        };
        toml::from_str(&text).map_err(|err| {
            io::Error::new(io::ErrorKind::InvalidData, format!("{}: {err}", path.display()))
        })
    }

    /// Writes the file atomically (temp file + rename).
    pub fn save(&self, path: &Path) -> io::Result<()> {
        let text = toml::to_string_pretty(self)
            .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err.to_string()))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("toml.tmp");
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, path)
    }

    pub fn pairing(&self) -> Option<Pairing> {
        Some(Pairing { server_url: self.server_url.clone()?, runner_id: self.runner_id? })
    }

    pub fn repo_by_key(&self, key: &str) -> Option<&RepoEntry> {
        self.repos.iter().find(|repo| repo.key == key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_is_an_unpaired_default() {
        let dir = tempfile::tempdir().unwrap();
        let config = RunnerConfig::load(&dir.path().join("runner.toml")).unwrap();
        assert_eq!(config, RunnerConfig::default());
        assert!(config.pairing().is_none());
        assert_eq!(config.policy.max_concurrent_runs, 4);
        assert_eq!(config.policy.allow_preview_ports, "3000-9999");
        assert!(!config.policy.allow_push && !config.policy.enable_fake_cli);
    }

    #[test]
    fn round_trips_through_toml() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("runner.toml");
        let config = RunnerConfig {
            server_url: Some("https://coffe.example.com".into()),
            runner_id: Some(Uuid::from_u128(0x0193f7c2_0000_7000_8000_000000000001)),
            workspace_id: Some("ws_1".into()),
            name: Some("build-vm-1".into()),
            policy: Policy {
                max_concurrent_runs: 2,
                allowed_clis: Some(vec!["claude-code".into(), "fake".into()]),
                allow_push: true,
                enable_fake_cli: true,
                ..Policy::default()
            },
            repos: vec![
                RepoEntry { key: "k1".into(), name: "app".into(), path: PathBuf::from("/srv/app") },
                RepoEntry { key: "k2".into(), name: "lib".into(), path: PathBuf::from("/srv/lib") },
            ],
        };
        config.save(&path).unwrap();
        assert_eq!(RunnerConfig::load(&path).unwrap(), config);
        let pairing = config.pairing().unwrap();
        assert_eq!(pairing.server_url, "https://coffe.example.com");
    }

    #[test]
    fn partial_policy_tables_fall_back_to_defaults() {
        let config: RunnerConfig =
            toml::from_str("[policy]\nallow_full_auto = true\nallowed_clis = [\"fake\"]\n").unwrap();
        assert!(config.policy.allow_full_auto);
        assert_eq!(config.policy.max_concurrent_runs, 4);
        assert!(config.policy.cli_allowed("fake"));
        assert!(!config.policy.cli_allowed("claude-code"));
        assert!(Policy::default().cli_allowed("anything"));
    }

    #[test]
    fn invalid_toml_reports_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runner.toml");
        std::fs::write(&path, "policy = 3").unwrap();
        let err = RunnerConfig::load(&path).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert!(err.to_string().contains("runner.toml"));
    }
}
