//! CLI auto-detection (architecture §10, F8): resolves every adapter's binary and reads its
//! version without consuming tokens.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use coffe_adapters::{AdapterRegistry, Probe, ProbeOutput, SharedAdapter};
use coffe_protocol::CliInfo;

/// One detected CLI: what is reported to the control plane plus what the supervisor needs.
#[derive(Debug, Clone)]
pub struct DetectedEntry {
    pub info: CliInfo,
    pub path: PathBuf,
    pub version: Option<String>,
}

/// `Probe` backed by the real system: `PATH` plus well-known per-user install directories.
#[derive(Debug, Clone)]
pub struct SystemProbe {
    extra_dirs: Vec<PathBuf>,
}

impl Default for SystemProbe {
    fn default() -> Self {
        Self::new()
    }
}

impl SystemProbe {
    pub fn new() -> Self {
        let mut extra_dirs = Vec::new();
        if let Some(base) = directories::BaseDirs::new() {
            let home = base.home_dir();
            for rel in [
                ".local/bin",
                ".npm-global/bin",
                ".bun/bin",
                ".cargo/bin",
                ".volta/bin",
                ".pi/agent/bin",
                ".opencode/bin",
                ".claude/local",
            ] {
                extra_dirs.push(home.join(rel));
            }
        }
        if cfg!(windows) {
            for var in ["APPDATA", "LOCALAPPDATA"] {
                if let Ok(dir) = std::env::var(var) {
                    extra_dirs.push(Path::new(&dir).join("npm"));
                }
            }
            if let Ok(dir) = std::env::var("LOCALAPPDATA") {
                extra_dirs.push(Path::new(&dir).join("Programs").join("OpenAI").join("Codex").join("bin"));
            }
        } else {
            extra_dirs.push(PathBuf::from("/usr/local/bin"));
            extra_dirs.push(PathBuf::from("/opt/homebrew/bin"));
        }
        Self { extra_dirs }
    }
}

impl Probe for SystemProbe {
    fn which(&self, binary: &str) -> Option<PathBuf> {
        if let Ok(path) = which::which(binary) {
            return Some(path);
        }
        let cwd = std::env::current_dir().ok()?;
        let joined = std::env::join_paths(self.extra_dirs.iter().filter(|d| d.is_dir())).ok()?;
        which::which_in(binary, Some(joined), cwd).ok()
    }

    fn run(&self, program: &Path, args: &[&str], timeout: Duration) -> Option<ProbeOutput> {
        run_with_timeout(program, args, timeout)
    }

    fn env(&self, key: &str) -> Option<String> {
        std::env::var(key).ok()
    }

    fn home_dir(&self) -> Option<PathBuf> {
        directories::BaseDirs::new().map(|base| base.home_dir().to_path_buf())
    }
}

/// Runs a short command, killing it when it exceeds `timeout`.
///
/// Output is collected incrementally: when a wrapper script is killed, a grandchild may keep the
/// pipes open, so the reader threads are never joined after a timeout (they finish on their own).
pub fn run_with_timeout(program: &Path, args: &[&str], timeout: Duration) -> Option<ProbeOutput> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("NO_COLOR", "1")
        .spawn()
        .ok()?;
    let stdout = collect(child.stdout.take()?);
    let stderr = collect(child.stderr.take()?);
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    // After a normal exit the pipes reach EOF almost immediately; give the readers a moment.
    let drain_deadline = Instant::now() + Duration::from_millis(if status.is_some() { 2_000 } else { 100 });
    while Instant::now() < drain_deadline && !(stdout.done() && stderr.done()) {
        std::thread::sleep(Duration::from_millis(10));
    }
    Some(ProbeOutput {
        status: status.and_then(|s| s.code()),
        stdout: stdout.text(),
        stderr: stderr.text(),
    })
}

/// Bytes read so far from a pipe by a background thread.
struct Collected {
    buffer: Arc<Mutex<Vec<u8>>>,
    done: Arc<AtomicBool>,
}

impl Collected {
    fn done(&self) -> bool {
        self.done.load(Ordering::Acquire)
    }

    fn text(&self) -> String {
        self.buffer.lock().map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default()
    }
}

fn collect(mut pipe: impl Read + Send + 'static) -> Collected {
    let buffer = Arc::new(Mutex::new(Vec::new()));
    let done = Arc::new(AtomicBool::new(false));
    let (thread_buffer, thread_done) = (buffer.clone(), done.clone());
    std::thread::spawn(move || {
        let mut chunk = [0u8; 4096];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(mut b) = thread_buffer.lock() {
                        b.extend_from_slice(&chunk[..n]);
                    }
                }
            }
        }
        thread_done.store(true, Ordering::Release);
    });
    Collected { buffer, done }
}

/// Detects every adapter of `registry` in parallel (each probe may take a few seconds).
pub fn detect_all(registry: &AdapterRegistry, probe: &dyn Probe, allowed: impl Fn(&str) -> bool) -> Vec<DetectedEntry> {
    let adapters: Vec<SharedAdapter> = registry.all().filter(|a| allowed(a.info().id)).cloned().collect();
    let mut found: Vec<DetectedEntry> = std::thread::scope(|scope| {
        let handles: Vec<_> = adapters
            .iter()
            .map(|adapter| {
                scope.spawn(move || {
                    let detected = adapter.detect(probe)?;
                    let info = adapter.info();
                    Some(DetectedEntry {
                        info: CliInfo {
                            id: info.id.to_owned(),
                            name: info.name.to_owned(),
                            path: detected.path.display().to_string(),
                            version: detected.version.clone(),
                            auth: detected.auth,
                            capabilities: info.capabilities.clone(),
                        },
                        path: detected.path,
                        version: detected.version,
                    })
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok().flatten()).collect()
    });
    found.sort_by(|a, b| a.info.id.cmp(&b.info.id));
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_with_timeout_captures_output_and_kills_slow_commands() {
        let (program, fast, slow): (&str, Vec<&str>, Vec<&str>) = if cfg!(windows) {
            ("cmd", vec!["/C", "echo hello"], vec!["/C", "ping -n 30 127.0.0.1 >NUL"])
        } else {
            ("sh", vec!["-c", "echo hello"], vec!["-c", "sleep 30"])
        };
        let probe = SystemProbe::new();
        let program = probe.which(program).expect("shell on PATH");
        let out = run_with_timeout(&program, &fast, Duration::from_secs(10)).unwrap();
        assert_eq!(out.status, Some(0));
        assert!(out.stdout.contains("hello"));

        let started = Instant::now();
        let out = run_with_timeout(&program, &slow, Duration::from_millis(300)).unwrap();
        assert_eq!(out.status, None);
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}
