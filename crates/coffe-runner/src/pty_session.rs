//! Interactive shells in a repository or ticket worktree (`pty.*` messages, architecture §8.4).
//! Each session is a task that owns its process; input, resizes and close requests reach it
//! through a channel. Output is not spooled: a shell is a live view only.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use coffe_adapters::{IoMode, Sig};
use coffe_protocol::{PtyClose, PtyExit, PtyInput, PtyOpen, PtyOutput, PtyResize, RunnerMessage};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::error::RunnerError;
use crate::process::{self, Launch, Spawned};

/// Shell sessions one runner keeps open at the same time.
const MAX_SESSIONS: usize = 16;
/// Shell names the control plane may ask for (anything else needs an absolute path that exists).
const KNOWN_SHELLS: [&str; 8] = ["bash", "zsh", "sh", "fish", "nu", "pwsh", "powershell", "cmd"];

enum PtyCommand {
    Input(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Close,
}

type SessionMap = Arc<Mutex<HashMap<Uuid, mpsc::UnboundedSender<PtyCommand>>>>;

pub struct PtySessions {
    outbound: mpsc::UnboundedSender<RunnerMessage>,
    sessions: SessionMap,
}

impl PtySessions {
    /// `outbound` receives `pty.output` and `pty.exit` frames.
    pub fn new(outbound: mpsc::UnboundedSender<RunnerMessage>) -> Self {
        Self { outbound, sessions: Arc::default() }
    }

    /// Starts a shell in `cwd`. Must be called inside a tokio runtime.
    pub fn open(&self, open: PtyOpen, cwd: PathBuf) -> Result<(), RunnerError> {
        let mut sessions = lock(&self.sessions);
        if sessions.contains_key(&open.session_id) {
            return Err(RunnerError::Invalid(format!("shell session {} is already open", open.session_id)));
        }
        if sessions.len() >= MAX_SESSIONS {
            return Err(RunnerError::Busy(format!("at most {MAX_SESSIONS} shell sessions can be open")));
        }
        let shell = match open.shell.as_deref() {
            Some(requested) => checked_shell(requested)?,
            None => default_shell(),
        };
        let env = [("COFFE_PTY_SESSION".to_owned(), open.session_id.to_string())];
        let spawned = process::spawn(Launch {
            program: &shell,
            args: &[],
            env: &env,
            cwd: &cwd,
            io: IoMode::Pty { cols: open.cols, rows: open.rows },
        })?;
        let (commands_tx, commands_rx) = mpsc::unbounded_channel();
        sessions.insert(open.session_id, commands_tx);
        drop(sessions);
        tokio::spawn(pump(open.session_id, spawned, commands_rx, self.outbound.clone(), self.sessions.clone()));
        Ok(())
    }

    pub fn input(&self, input: PtyInput) -> Result<(), RunnerError> {
        self.command(input.session_id, PtyCommand::Input(input.data.into_bytes()))
    }

    pub fn resize(&self, resize: PtyResize) -> Result<(), RunnerError> {
        self.command(resize.session_id, PtyCommand::Resize { cols: resize.cols, rows: resize.rows })
    }

    /// Ends the shell; `pty.exit` follows once the process is gone. Unknown sessions are ignored.
    pub fn close(&self, close: PtyClose) {
        let _ = self.command(close.session_id, PtyCommand::Close);
    }

    fn command(&self, session_id: Uuid, command: PtyCommand) -> Result<(), RunnerError> {
        lock(&self.sessions)
            .get(&session_id)
            .ok_or_else(|| RunnerError::NotFound(format!("shell session {session_id} is not open")))?
            .send(command)
            .map_err(|_| RunnerError::NotFound(format!("shell session {session_id} has ended")))
    }
}

impl Drop for PtySessions {
    fn drop(&mut self) {
        for commands in lock(&self.sessions).values() {
            let _ = commands.send(PtyCommand::Close);
        }
    }
}

fn lock(sessions: &SessionMap) -> MutexGuard<'_, HashMap<Uuid, mpsc::UnboundedSender<PtyCommand>>> {
    sessions.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

async fn pump(
    session_id: Uuid,
    mut spawned: Spawned,
    mut commands: mpsc::UnboundedReceiver<PtyCommand>,
    outbound: mpsc::UnboundedSender<RunnerMessage>,
    sessions: SessionMap,
) {
    let mut seq = 0u64;
    let mut forward = |bytes: Vec<u8>| {
        seq += 1;
        let _ = outbound.send(RunnerMessage::PtyOutput(PtyOutput { session_id, seq, data: BASE64.encode(bytes) }));
    };
    let mut commands_open = true;
    let exit_code = loop {
        tokio::select! {
            chunk = spawned.output.recv() => match chunk {
                Some((_, bytes)) => forward(bytes),
                None => break (&mut spawned.exit).await.ok().flatten(),
            },
            code = &mut spawned.exit => break code.ok().flatten(),
            command = commands.recv(), if commands_open => match command {
                Some(PtyCommand::Input(bytes)) => {
                    let _ = spawned.child.write(bytes);
                }
                Some(PtyCommand::Resize { cols, rows }) => {
                    let _ = spawned.child.resize(cols, rows);
                }
                Some(PtyCommand::Close) | None => {
                    commands_open = false;
                    let _ = spawned.child.signal(Sig::Kill);
                }
            },
        }
    };
    while let Some((_, bytes)) = spawned.next_trailing().await {
        forward(bytes);
    }
    lock(&sessions).remove(&session_id);
    let _ = outbound.send(RunnerMessage::PtyExit(PtyExit { session_id, exit_code }));
}

/// A shell the control plane asked for: a known shell name or an existing absolute path.
fn checked_shell(requested: &str) -> Result<PathBuf, RunnerError> {
    let path = Path::new(requested);
    if path.is_absolute() {
        return if path.is_file() {
            Ok(path.to_path_buf())
        } else {
            Err(RunnerError::NotFound(format!("shell {requested} does not exist")))
        };
    }
    let name = requested.strip_suffix(".exe").unwrap_or(requested);
    if !KNOWN_SHELLS.contains(&name) {
        return Err(RunnerError::Policy(format!("{requested} is not a known shell")));
    }
    which::which(requested).map_err(|_| RunnerError::NotFound(format!("shell {requested} is not installed")))
}

/// `$SHELL` (falling back to `/bin/sh`) on Unix; PowerShell 7, Windows PowerShell or `cmd` on
/// Windows.
fn default_shell() -> PathBuf {
    if cfg!(windows) {
        ["pwsh", "powershell"]
            .iter()
            .find_map(|name| which::which(name).ok())
            .or_else(|| std::env::var_os("COMSPEC").map(PathBuf::from))
            .unwrap_or_else(|| PathBuf::from("cmd.exe"))
    } else {
        std::env::var_os("SHELL")
            .map(PathBuf::from)
            .filter(|shell| shell.is_file())
            .unwrap_or_else(|| PathBuf::from("/bin/sh"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn refuses_unknown_shell_names() {
        assert!(matches!(checked_shell("python"), Err(RunnerError::Policy(_))));
        assert!(matches!(checked_shell("rm"), Err(RunnerError::Policy(_))));
    }

    #[tokio::test]
    async fn a_shell_echoes_input_and_reports_its_exit() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sessions = PtySessions::new(tx);
        let session_id = Uuid::new_v4();
        let shell = if cfg!(windows) { "cmd" } else { "sh" };
        sessions
            .open(
                PtyOpen { session_id, target: coffe_protocol::PtyTarget::Repo { repo_key: "r".into() }, shell: Some(shell.into()), cols: 80, rows: 24 },
                dir.path().to_path_buf(),
            )
            .unwrap();
        sessions.input(PtyInput { session_id, data: "echo coffe-pty-ok\r".into() }).unwrap();

        let mut seen = String::new();
        let found = tokio::time::timeout(Duration::from_secs(20), async {
            while let Some(message) = rx.recv().await {
                if let RunnerMessage::PtyOutput(output) = message {
                    seen.push_str(&String::from_utf8_lossy(&BASE64.decode(output.data).unwrap()));
                    // The echo of the typed command plus the command's own output.
                    if seen.matches("coffe-pty-ok").count() >= 2 {
                        return true;
                    }
                }
            }
            false
        })
        .await;
        assert_eq!(found, Ok(true), "shell output: {seen:?}");

        sessions.close(PtyClose { session_id });
        let exit = tokio::time::timeout(Duration::from_secs(20), async {
            while let Some(message) = rx.recv().await {
                if let RunnerMessage::PtyExit(exit) = message {
                    return Some(exit);
                }
            }
            None
        })
        .await
        .unwrap();
        assert_eq!(exit.map(|exit| exit.session_id), Some(session_id));
        assert!(sessions.input(PtyInput { session_id, data: "x".into() }).is_err());
    }
}
