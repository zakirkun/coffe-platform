//! One child process behind a uniform handle, whatever its I/O mode (architecture §7.5).
//!
//! * [`IoMode::Pty`]: the child runs in a pseudo terminal (`portable-pty`); its merged output
//!   arrives as [`StreamKind::Pty`] chunks, input is typed into the terminal.
//! * [`IoMode::Pipes`]: stdin/stdout/stderr are pipes (`tokio::process`).
//!
//! On Unix the child leads its own process group, so signals reach the CLI and everything it
//! started. Windows has no such signals: only kill (and Ctrl+C typed into a PTY) work there.

use std::io::{Read, Write};
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use coffe_adapters::{IoMode, LaunchPlan, Sig, StreamKind};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use crate::error::RunnerError;

const READ_BUF_BYTES: usize = 8 * 1024;
/// Chunks buffered between the readers and the consumer; a full queue blocks the readers, which
/// in turn blocks a child that floods its output.
const OUTPUT_QUEUE_CHUNKS: usize = 256;
/// After the exit, silence of this length means no more output is coming.
const TRAILING_IDLE: Duration = Duration::from_millis(200);
/// Upper bound for collecting output after the exit (a surviving grandchild may keep writing).
const TRAILING_LIMIT: Duration = Duration::from_secs(2);
/// Variables that make CLIs believe they run unattended; an interactive terminal must not
/// inherit them from the runner's own environment.
const PTY_ENV_REMOVED: [&str; 2] = ["CI", "GITHUB_ACTIONS"];
/// The browser terminal is xterm.js.
const PTY_TERM: &str = "xterm-256color";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A chunk of child output and the stream it was read from.
pub type OutputChunk = (StreamKind, Vec<u8>);

/// What to start.
#[derive(Debug, Clone, Copy)]
pub struct Launch<'a> {
    pub program: &'a Path,
    pub args: &'a [String],
    /// Added to the inherited environment.
    pub env: &'a [(String, String)],
    pub cwd: &'a Path,
    pub io: IoMode,
}

impl<'a> From<&'a LaunchPlan> for Launch<'a> {
    fn from(plan: &'a LaunchPlan) -> Self {
        Self { program: &plan.program, args: &plan.args, env: &plan.env, cwd: &plan.cwd, io: plan.io }
    }
}

/// A running child: the control handle plus its output and exit notifications.
pub struct Spawned {
    pub child: ChildProcess,
    /// Output in arrival order; closed once every stream reached its end.
    pub output: mpsc::Receiver<OutputChunk>,
    /// Resolves with the exit code (`None` when a signal ended the process).
    pub exit: oneshot::Receiver<Option<i32>>,
    trailing_limit: Option<Instant>,
}

impl Spawned {
    /// Output that was still in flight when the process exited; call it until `None` after
    /// `exit` resolved. Closes the terminal of a PTY child, so afterwards only `signal` is
    /// meaningful.
    pub async fn next_trailing(&mut self) -> Option<OutputChunk> {
        let limit = *self.trailing_limit.get_or_insert_with(|| Instant::now() + TRAILING_LIMIT);
        loop {
            let idle_until = (Instant::now() + TRAILING_IDLE).min(limit);
            match tokio::time::timeout_at(idle_until, self.output.recv()).await {
                Ok(chunk) => return chunk,
                // A ConPTY reader only sees the end of the stream once the console is closed.
                Err(_) if Instant::now() < limit && self.child.close_pty() => {}
                Err(_) => return None,
            }
        }
    }
}

enum InputOp {
    Write(Vec<u8>),
    Close,
}

enum Backend {
    Pty {
        /// `None` once the terminal was closed.
        master: Option<Box<dyn MasterPty + Send>>,
        #[cfg_attr(unix, allow(dead_code))]
        killer: Box<dyn ChildKiller + Send + Sync>,
    },
    Pipes {
        /// Asks the task that owns the child to kill it; dropping the sender does the same.
        #[cfg_attr(unix, allow(dead_code))]
        kill: mpsc::UnboundedSender<()>,
    },
}

/// Control handle of a child process. Dropping it kills a child that is still running.
pub struct ChildProcess {
    pid: Option<u32>,
    exited: Arc<AtomicBool>,
    input: mpsc::UnboundedSender<InputOp>,
    stdin_open: bool,
    backend: Backend,
}

impl ChildProcess {
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    pub fn is_pty(&self) -> bool {
        matches!(self.backend, Backend::Pty { .. })
    }

    /// Queues bytes for the child's stdin (or terminal); never blocks.
    pub fn write(&mut self, bytes: Vec<u8>) -> Result<(), RunnerError> {
        if !self.stdin_open {
            return Err(RunnerError::Invalid("the input of the process is closed".to_owned()));
        }
        self.input
            .send(InputOp::Write(bytes))
            .map_err(|_| RunnerError::Invalid("the process no longer reads input".to_owned()))
    }

    /// Ends the child's input: closes the stdin pipe, or types end-of-file into a terminal
    /// (which stays usable, since a TUI may ignore it).
    pub fn close_stdin(&mut self) {
        let _ = self.input.send(InputOp::Close);
        if !self.is_pty() {
            self.stdin_open = false;
        }
    }

    /// Resizes the terminal of a PTY child.
    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), RunnerError> {
        match &self.backend {
            Backend::Pty { master: Some(master), .. } => master
                .resize(pty_size(cols, rows))
                .map_err(|err| RunnerError::Internal(format!("cannot resize the terminal: {err}"))),
            Backend::Pty { master: None, .. } => {
                Err(RunnerError::Invalid("the terminal is closed".to_owned()))
            }
            Backend::Pipes { .. } => {
                Err(RunnerError::Unsupported("the process has no terminal to resize".to_owned()))
            }
        }
    }

    /// Signals the child's process group. A process that already exited is left alone.
    pub fn signal(&mut self, sig: Sig) -> Result<(), RunnerError> {
        if self.exited.load(Ordering::Acquire) {
            return Ok(());
        }
        self.deliver(sig)
    }

    #[cfg(unix)]
    fn deliver(&mut self, sig: Sig) -> Result<(), RunnerError> {
        use nix::errno::Errno;
        use nix::sys::signal::{Signal, killpg};
        use nix::unistd::Pid;

        let pid = self
            .pid
            .and_then(|pid| i32::try_from(pid).ok())
            .ok_or_else(|| RunnerError::Internal("the process id is unknown".to_owned()))?;
        let signal = match sig {
            Sig::Interrupt => Signal::SIGINT,
            Sig::Terminate => Signal::SIGTERM,
            Sig::Kill => Signal::SIGKILL,
            Sig::Stop => Signal::SIGSTOP,
            Sig::Continue => Signal::SIGCONT,
        };
        match killpg(Pid::from_raw(pid), signal) {
            Ok(()) | Err(Errno::ESRCH) => Ok(()),
            Err(err) => {
                Err(RunnerError::Internal(format!("cannot signal the process group: {err}")))
            }
        }
    }

    #[cfg(not(unix))]
    fn deliver(&mut self, sig: Sig) -> Result<(), RunnerError> {
        match (sig, &mut self.backend) {
            (Sig::Kill, Backend::Pty { killer, .. }) => {
                // Fails only when the process is already gone.
                let _ = killer.kill();
                Ok(())
            }
            (Sig::Kill, Backend::Pipes { kill }) => {
                let _ = kill.send(());
                Ok(())
            }
            // Ctrl+C typed into the console.
            (Sig::Interrupt, Backend::Pty { .. }) => self
                .input
                .send(InputOp::Write(vec![0x03]))
                .map_err(|_| RunnerError::Invalid("the process no longer reads input".to_owned())),
            (Sig::Stop | Sig::Continue, _) => Err(RunnerError::Unsupported(
                "pause/resume needs Linux/macOS (WSL on Windows)".to_owned(),
            )),
            (Sig::Interrupt | Sig::Terminate, _) => Err(RunnerError::Unsupported(
                "interrupt/terminate signals need Linux/macOS (WSL on Windows)".to_owned(),
            )),
        }
    }

    /// Closes the terminal of a PTY child; true when it was still open.
    fn close_pty(&mut self) -> bool {
        match &mut self.backend {
            Backend::Pty { master, .. } => master.take().is_some(),
            Backend::Pipes { .. } => false,
        }
    }
}

impl Drop for ChildProcess {
    fn drop(&mut self) {
        let _ = self.signal(Sig::Kill);
    }
}

/// Starts the process described by `launch`. Must be called inside a tokio runtime.
pub fn spawn(launch: Launch<'_>) -> Result<Spawned, RunnerError> {
    match launch.io {
        IoMode::Pty { cols, rows } => spawn_pty(&launch, cols, rows),
        IoMode::Pipes => {
            let mut command = Command::new(launch.program);
            command
                .args(launch.args)
                .envs(launch.env.iter().map(|(key, value)| (key, value)))
                .current_dir(launch.cwd);
            spawn_piped(command, &launch.program.display().to_string())
        }
    }
}

/// Runs `command_line` through the platform shell (`sh -c` / `cmd /C`) with piped output and a
/// closed stdin.
pub fn spawn_shell(command_line: &str, cwd: &Path) -> Result<Spawned, RunnerError> {
    #[cfg(unix)]
    let mut command = {
        let mut command = Command::new("sh");
        command.arg("-c").arg(command_line);
        command
    };
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("cmd");
        // `/S` makes cmd strip exactly the outer quotes, so the line reaches it unchanged.
        command.args(["/D", "/S", "/C"]).raw_arg(format!("\"{command_line}\""));
        command
    };
    command.current_dir(cwd);
    let mut spawned = spawn_piped(command, command_line)?;
    spawned.child.close_stdin();
    Ok(spawned)
}

fn spawn_piped(mut command: Command, label: &str) -> Result<Spawned, RunnerError> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command
        .spawn()
        .map_err(|err| RunnerError::Internal(format!("cannot start {label}: {err}")))?;
    let pid = child.id();
    let (output_tx, output) = mpsc::channel(OUTPUT_QUEUE_CHUNKS);
    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(pump(stdout, StreamKind::Stdout, output_tx.clone()));
    }
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(pump(stderr, StreamKind::Stderr, output_tx));
    }
    let (input, input_rx) = mpsc::unbounded_channel();
    if let Some(stdin) = child.stdin.take() {
        tokio::spawn(feed_stdin(stdin, input_rx));
    }

    let exited = Arc::new(AtomicBool::new(false));
    let (kill, mut kill_rx) = mpsc::unbounded_channel::<()>();
    let (exit_tx, exit) = oneshot::channel();
    let exited_flag = Arc::clone(&exited);
    tokio::spawn(async move {
        let status = tokio::select! {
            status = child.wait() => status,
            _ = kill_rx.recv() => {
                let _ = child.start_kill();
                child.wait().await
            }
        };
        exited_flag.store(true, Ordering::Release);
        let _ = exit_tx.send(status.ok().and_then(|status| status.code()));
    });

    let child = ChildProcess { pid, exited, input, stdin_open: true, backend: Backend::Pipes { kill } };
    Ok(Spawned { child, output, exit, trailing_limit: None })
}

async fn pump<R>(mut reader: R, kind: StreamKind, output: mpsc::Sender<OutputChunk>)
where
    R: AsyncRead + Unpin,
{
    let mut buf = vec![0u8; READ_BUF_BYTES];
    loop {
        match reader.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                if output.send((kind, buf[..read].to_vec())).await.is_err() {
                    break;
                }
            }
        }
    }
}

async fn feed_stdin(stdin: ChildStdin, mut ops: mpsc::UnboundedReceiver<InputOp>) {
    let mut stdin = Some(stdin);
    while let Some(op) = ops.recv().await {
        match op {
            InputOp::Write(bytes) => {
                let Some(pipe) = stdin.as_mut() else { continue };
                if pipe.write_all(&bytes).await.is_err() || pipe.flush().await.is_err() {
                    // The child closed its end; nothing can be delivered any more.
                    stdin = None;
                }
            }
            InputOp::Close => stdin = None,
        }
    }
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }
}

fn spawn_pty(launch: &Launch<'_>, cols: u16, rows: u16) -> Result<Spawned, RunnerError> {
    let pty_error =
        |err: anyhow::Error| RunnerError::Internal(format!("cannot open a pseudo terminal: {err}"));
    let pair = native_pty_system().openpty(pty_size(cols, rows)).map_err(pty_error)?;
    let reader = pair.master.try_clone_reader().map_err(pty_error)?;
    let writer = pair.master.take_writer().map_err(pty_error)?;

    let mut command = CommandBuilder::new(launch.program);
    command.args(launch.args);
    command.cwd(launch.cwd);
    for key in PTY_ENV_REMOVED {
        command.env_remove(key);
    }
    command.env("TERM", PTY_TERM);
    for (key, value) in launch.env {
        command.env(key, value);
    }

    let mut process = pair.slave.spawn_command(command).map_err(|err| {
        RunnerError::Internal(format!("cannot start {}: {err}", launch.program.display()))
    })?;
    // Only the child keeps the slave side, so its exit ends the output stream.
    drop(pair.slave);

    let (input, input_rx) = mpsc::unbounded_channel();
    let exited = Arc::new(AtomicBool::new(false));
    // From here on an early return drops `child`, which kills the process.
    let child = ChildProcess {
        pid: process.process_id(),
        exited: Arc::clone(&exited),
        input: input.clone(),
        stdin_open: true,
        backend: Backend::Pty { master: Some(pair.master), killer: process.clone_killer() },
    };

    let (output_tx, output) = mpsc::channel(OUTPUT_QUEUE_CHUNKS);
    let (exit_tx, exit) = oneshot::channel();
    std::thread::Builder::new()
        .name("coffe-pty-read".to_owned())
        .spawn(move || pump_pty(reader, &output_tx, input))?;
    std::thread::Builder::new()
        .name("coffe-pty-write".to_owned())
        .spawn(move || feed_pty(writer, input_rx))?;
    std::thread::Builder::new().name("coffe-pty-wait".to_owned()).spawn(move || {
        let code = process.wait().ok().and_then(|status| {
            // Windows exit codes are unsigned; the bit pattern is what tools display.
            status.signal().is_none().then(|| status.exit_code() as i32)
        });
        exited.store(true, Ordering::Release);
        let _ = exit_tx.send(code);
    })?;

    Ok(Spawned { child, output, exit, trailing_limit: None })
}

/// Reader thread of a PTY child. `input` is only needed to answer the console's startup query
/// on Windows.
fn pump_pty(
    mut reader: Box<dyn Read + Send>,
    output: &mpsc::Sender<OutputChunk>,
    input: mpsc::UnboundedSender<InputOp>,
) {
    #[cfg(windows)]
    let mut cursor_query = CursorQuery::default();
    // Elsewhere the writer thread must not outlive the control handle because of this clone.
    #[cfg(not(windows))]
    drop(input);
    let mut buf = vec![0u8; READ_BUF_BYTES];
    loop {
        let read = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(read) => read,
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        #[allow(unused_mut)]
        let mut chunk = buf[..read].to_vec();
        #[cfg(windows)]
        if cursor_query.answer(&mut chunk) {
            let _ = input.send(InputOp::Write(CursorQuery::REPORT.to_vec()));
        }
        if !chunk.is_empty() && output.blocking_send((StreamKind::Pty, chunk)).is_err() {
            break;
        }
    }
}

/// Writer thread of a PTY child (terminal writes block while the child does not read).
fn feed_pty(mut writer: Box<dyn Write + Send>, mut ops: mpsc::UnboundedReceiver<InputOp>) {
    // End-of-file as typed at the start of a line.
    const END_OF_FILE: &[u8] = if cfg!(windows) { b"\x1a\r" } else { b"\x04" };
    while let Some(op) = ops.blocking_recv() {
        let bytes = match &op {
            InputOp::Write(bytes) => bytes.as_slice(),
            InputOp::Close => END_OF_FILE,
        };
        if writer.write_all(bytes).is_err() || writer.flush().is_err() {
            break;
        }
    }
}

/// ConPTY is created with "inherit cursor": before the child produces anything, the console
/// asks its terminal for the cursor position and stalls until the report arrives. The browser
/// terminal may not even be attached, so the runner answers (and hides) that first query.
#[cfg(windows)]
#[derive(Default)]
struct CursorQuery {
    /// Output bytes inspected so far.
    seen: usize,
    answered: bool,
}

#[cfg(windows)]
impl CursorQuery {
    const REQUEST: &'static [u8] = b"\x1b[6n";
    const REPORT: &'static [u8] = b"\x1b[1;1R";
    /// The query is the first thing the console writes; later ones belong to applications.
    const WINDOW_BYTES: usize = 256;

    /// Removes the startup query from `chunk`; true when it must be answered now.
    fn answer(&mut self, chunk: &mut Vec<u8>) -> bool {
        if self.answered || self.seen >= Self::WINDOW_BYTES {
            return false;
        }
        self.seen += chunk.len();
        let Some(start) = chunk.windows(Self::REQUEST.len()).position(|w| w == Self::REQUEST)
        else {
            return false;
        };
        chunk.drain(start..start + Self::REQUEST.len());
        self.answered = true;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell_line(text: &str) -> String {
        if cfg!(windows) { format!("echo {text}& exit /b 7") } else { format!("echo {text}; exit 7") }
    }

    async fn collect(mut spawned: Spawned) -> (Vec<u8>, Option<i32>) {
        let mut out = Vec::new();
        let code = loop {
            tokio::select! {
                chunk = spawned.output.recv() => match chunk {
                    Some((_, bytes)) => out.extend(bytes),
                    None => break (&mut spawned.exit).await.ok().flatten(),
                },
                code = &mut spawned.exit => break code.ok().flatten(),
            }
        };
        while let Some((_, bytes)) = spawned.next_trailing().await {
            out.extend(bytes);
        }
        (out, code)
    }

    #[tokio::test]
    async fn shell_commands_report_output_and_exit_code() {
        let dir = tempfile::tempdir().unwrap();
        let spawned = spawn_shell(&shell_line("from-shell"), dir.path()).unwrap();
        let (out, code) = collect(spawned).await;
        assert!(String::from_utf8_lossy(&out).contains("from-shell"));
        assert_eq!(code, Some(7));
    }

    #[tokio::test]
    async fn kill_ends_a_piped_process_and_dropping_the_handle_is_safe() {
        let dir = tempfile::tempdir().unwrap();
        let line = if cfg!(windows) { "ping -n 60 127.0.0.1 >NUL" } else { "sleep 60" };
        let mut spawned = spawn_shell(line, dir.path()).unwrap();
        assert!(spawned.child.pid().is_some());
        assert!(!spawned.child.is_pty());
        assert!(spawned.child.write(b"x".to_vec()).is_err(), "stdin of a shell command is closed");
        spawned.child.signal(Sig::Kill).unwrap();
        let code = tokio::time::timeout(Duration::from_secs(20), &mut spawned.exit)
            .await
            .expect("killed process exits")
            .unwrap();
        assert_ne!(code, Some(0));
        spawned.child.signal(Sig::Kill).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn only_the_startup_cursor_query_is_answered() {
        let mut query = CursorQuery::default();
        let mut chunk = b"\x1b[?25l\x1b[6nhello".to_vec();
        assert!(query.answer(&mut chunk));
        assert_eq!(chunk, b"\x1b[?25lhello");
        let mut later = b"\x1b[6n".to_vec();
        assert!(!query.answer(&mut later));
        assert_eq!(later, b"\x1b[6n");
    }
}
