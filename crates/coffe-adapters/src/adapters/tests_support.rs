//! A run spec for adapter unit tests.

use std::path::PathBuf;

use uuid::Uuid;

use crate::{ContextFiles, PermissionMode, PermissionPolicy, RunDriver, RunMode, RunSpec, TermSize};

pub(crate) fn spec(mode: RunMode) -> RunSpec {
    RunSpec {
        run_id: Uuid::new_v4(),
        program: PathBuf::from("/usr/local/bin/cli"),
        cwd: PathBuf::from("/work/repo"),
        mode,
        driver: RunDriver::Native,
        cli_version: None,
        prompt: "Fix the parser".to_owned(),
        context: ContextFiles::default(),
        model: None,
        permissions: PermissionPolicy {
            mode: PermissionMode::WorkspaceWrite,
            allow_tools: Vec::new(),
            deny_tools: Vec::new(),
            network: true,
            max_turns: None,
            max_budget_usd: None,
        },
        resume_session_id: None,
        output_schema: None,
        terminal: TermSize { cols: 100, rows: 30 },
        env: Vec::new(),
    }
}
