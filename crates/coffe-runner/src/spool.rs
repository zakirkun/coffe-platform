//! Per-run outbound stream (architecture §8.5, §8.7): `seq` assignment, output coalescing,
//! an on-disk spool of every unacknowledged frame, cumulative acks, replay after reconnect, and a
//! small journal used to report runs as `interrupted` after a runner restart.
//!
//! Files per run (`<data>/runs/<run_id>/`):
//! - `spool.jsonl`: one `{"seq":N,"msg":<RunnerMessage>}` per line, appended before sending.
//! - `journal.json`: last status, CLI session id, completion flag, highest acked seq.

use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use coffe_protocol::{
    AgentEvent, RunCompleted, RunEventMsg, RunOutput, RunState, RunStatus, RunUsage, RunnerMessage,
};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::envelope;
use crate::run_api::{RunCompletion, RunEmit, RunStateUpdate};

const SPOOL_FILE: &str = "spool.jsonl";
const JOURNAL_FILE: &str = "journal.json";
/// Unacked bytes kept per run before old terminal output is dropped (§8.5).
pub const SPOOL_CAP_BYTES: u64 = 64 * 1024 * 1024;
/// Output is flushed after this delay or when the buffer reaches [`OUTPUT_FLUSH_BYTES`].
pub const OUTPUT_FLUSH_DELAY: Duration = Duration::from_millis(16);
pub const OUTPUT_FLUSH_BYTES: usize = 32 * 1024;

/// Persistent per-run facts that survive a runner restart.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Journal {
    pub status: Option<RunStatus>,
    pub cli_session_id: Option<String>,
    pub completed: bool,
    /// Highest seq the control plane acknowledged.
    pub acked_seq: u64,
}

#[derive(Serialize, Deserialize)]
struct SpoolLine {
    seq: u64,
    msg: RunnerMessage,
}

#[derive(Debug, Clone)]
struct Entry {
    seq: u64,
    /// The serialized `SpoolLine` (without newline).
    line: String,
    is_output: bool,
}

/// On-disk spool + journal of one run.
#[derive(Debug)]
pub struct RunSpool {
    dir: PathBuf,
    run_id: Uuid,
    entries: VecDeque<Entry>,
    bytes: u64,
    cap_bytes: u64,
    journal: Journal,
    last_seq: u64,
}

impl RunSpool {
    /// Opens (or creates) the spool of `run_id` under `runs_dir`.
    pub fn open(runs_dir: &Path, run_id: Uuid) -> io::Result<Self> {
        Self::open_with_cap(runs_dir, run_id, SPOOL_CAP_BYTES)
    }

    pub fn open_with_cap(runs_dir: &Path, run_id: Uuid, cap_bytes: u64) -> io::Result<Self> {
        let dir = runs_dir.join(run_id.to_string());
        fs::create_dir_all(&dir)?;
        let journal = match fs::read_to_string(dir.join(JOURNAL_FILE)) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Journal::default(),
            Err(err) => return Err(err),
        };
        let mut entries = VecDeque::new();
        let mut bytes = 0;
        match File::open(dir.join(SPOOL_FILE)) {
            Ok(file) => {
                for line in BufReader::new(file).lines() {
                    let line = line?;
                    // A torn last line (crash mid-write) is skipped.
                    let Ok(parsed) = serde_json::from_str::<SpoolLine>(&line) else { continue };
                    if parsed.seq <= journal.acked_seq {
                        continue;
                    }
                    bytes += line.len() as u64 + 1;
                    entries.push_back(Entry {
                        seq: parsed.seq,
                        is_output: matches!(parsed.msg, RunnerMessage::RunOutput(_)),
                        line,
                    });
                }
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => return Err(err),
        }
        let last_seq = entries.iter().map(|e| e.seq).max().unwrap_or(0).max(journal.acked_seq);
        Ok(Self { dir, run_id, entries, bytes, cap_bytes, journal, last_seq })
    }

    pub fn run_id(&self) -> Uuid {
        self.run_id
    }

    pub fn journal(&self) -> &Journal {
        &self.journal
    }

    pub fn last_seq(&self) -> u64 {
        self.last_seq
    }

    /// Reserves the next sequence number.
    pub fn next_seq(&mut self) -> u64 {
        self.last_seq += 1;
        self.last_seq
    }

    /// Unacknowledged frames remain.
    pub fn has_pending(&self) -> bool {
        !self.entries.is_empty()
    }

    /// The run ended (completed, or reported interrupted) and everything was acknowledged.
    pub fn is_settled(&self) -> bool {
        self.entries.is_empty()
            && (self.journal.completed || self.journal.status == Some(RunStatus::Interrupted))
    }

    /// Appends a frame (its `seq` must come from [`RunSpool::next_seq`]). Returns the number of
    /// output bytes dropped to respect the cap (the caller reports them as a `gap` event).
    pub fn append(&mut self, seq: u64, msg: &RunnerMessage) -> io::Result<u64> {
        self.track_journal(msg)?;
        let line = serde_json::to_string(&SpoolLine { seq, msg: msg.clone() })
            .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
        let mut file = OpenOptions::new().create(true).append(true).open(self.dir.join(SPOOL_FILE))?;
        file.write_all(line.as_bytes())?;
        file.write_all(b"\n")?;
        self.bytes += line.len() as u64 + 1;
        self.entries.push_back(Entry { seq, is_output: matches!(msg, RunnerMessage::RunOutput(_)), line });
        self.enforce_cap()
    }

    /// Drops every entry with `seq <= acked` (cumulative ack).
    pub fn ack(&mut self, acked: u64) -> io::Result<()> {
        if acked <= self.journal.acked_seq {
            return Ok(());
        }
        let before = self.entries.len();
        while self.entries.front().is_some_and(|e| e.seq <= acked) {
            if let Some(entry) = self.entries.pop_front() {
                self.bytes -= entry.line.len() as u64 + 1;
            }
        }
        self.journal.acked_seq = acked;
        self.last_seq = self.last_seq.max(acked);
        self.write_journal()?;
        if self.entries.len() != before {
            self.rewrite()?;
        }
        Ok(())
    }

    /// Frames with `seq > after`, in order.
    pub fn replay(&self, after: u64) -> Vec<RunnerMessage> {
        self.entries
            .iter()
            .filter(|e| e.seq > after)
            .filter_map(|e| serde_json::from_str::<SpoolLine>(&e.line).ok().map(|l| l.msg))
            .collect()
    }

    /// Records a status in the journal without a frame (e.g. `interrupted` on restart before the
    /// frame is built).
    pub fn set_status(&mut self, status: RunStatus) -> io::Result<()> {
        self.journal.status = Some(status);
        self.write_journal()
    }

    /// Deletes the run directory (only call when [`RunSpool::is_settled`]).
    pub fn remove(self) -> io::Result<()> {
        fs::remove_dir_all(&self.dir)
    }

    fn track_journal(&mut self, msg: &RunnerMessage) -> io::Result<()> {
        let changed = match msg {
            RunnerMessage::RunState(state) => {
                self.journal.status = Some(state.status);
                if state.cli_session_id.is_some() {
                    self.journal.cli_session_id.clone_from(&state.cli_session_id);
                }
                true
            }
            RunnerMessage::RunCompleted(done) => {
                self.journal.status = Some(done.status);
                self.journal.completed = true;
                if done.cli_session_id.is_some() {
                    self.journal.cli_session_id.clone_from(&done.cli_session_id);
                }
                true
            }
            _ => false,
        };
        if changed { self.write_journal() } else { Ok(()) }
    }

    fn enforce_cap(&mut self) -> io::Result<u64> {
        if self.bytes <= self.cap_bytes {
            return Ok(0);
        }
        let mut dropped = 0u64;
        let mut kept = VecDeque::with_capacity(self.entries.len());
        let mut bytes = self.bytes;
        // Oldest output first; state, events, usage and completion are never dropped.
        for entry in self.entries.drain(..) {
            if bytes > self.cap_bytes && entry.is_output {
                let size = entry.line.len() as u64 + 1;
                bytes -= size;
                if let Ok(SpoolLine { msg: RunnerMessage::RunOutput(out), .. }) =
                    serde_json::from_str::<SpoolLine>(&entry.line)
                {
                    dropped += BASE64.decode(out.data.as_bytes()).map_or(0, |b| b.len() as u64);
                }
                continue;
            }
            kept.push_back(entry);
        }
        self.entries = kept;
        self.bytes = bytes;
        self.rewrite()?;
        Ok(dropped)
    }

    fn rewrite(&self) -> io::Result<()> {
        let tmp = self.dir.join(format!("{SPOOL_FILE}.tmp"));
        {
            let mut file = File::create(&tmp)?;
            for entry in &self.entries {
                file.write_all(entry.line.as_bytes())?;
                file.write_all(b"\n")?;
            }
            file.flush()?;
        }
        fs::rename(tmp, self.dir.join(SPOOL_FILE))
    }

    fn write_journal(&self) -> io::Result<()> {
        let text = serde_json::to_string(&self.journal)
            .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
        let tmp = self.dir.join(format!("{JOURNAL_FILE}.tmp"));
        fs::write(&tmp, text)?;
        fs::rename(tmp, self.dir.join(JOURNAL_FILE))
    }
}

/// Run ids with a directory under `runs_dir`.
pub fn list_runs(runs_dir: &Path) -> io::Result<Vec<Uuid>> {
    let entries = match fs::read_dir(runs_dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };
    let mut ids = Vec::new();
    for entry in entries {
        let entry = entry?;
        if let Some(id) = entry.file_name().to_str().and_then(|name| Uuid::parse_str(name).ok()) {
            ids.push(id);
        }
    }
    Ok(ids)
}

/// Where encoded frames go while a connection is up; frames sent while disconnected are only
/// spooled and replayed after the next `welcome`.
#[derive(Clone, Default)]
pub struct Outbound(Arc<Mutex<Option<mpsc::UnboundedSender<String>>>>);

impl Outbound {
    pub fn set(&self, sender: Option<mpsc::UnboundedSender<String>>) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = sender;
        }
    }

    /// Returns false when no connection is up (the frame stays in the spool).
    pub fn send(&self, msg: RunnerMessage) -> bool {
        let Ok(slot) = self.0.lock() else { return false };
        match slot.as_ref() {
            Some(sender) => sender.send(envelope::encode(msg, None)).is_ok(),
            None => false,
        }
    }
}

/// Shared handle to a run's spool (the stream task appends, the daemon acks and replays).
pub type SharedSpool = Arc<Mutex<RunSpool>>;

/// Builds frames from [`RunEmit`]s: assigns seq, coalesces output, spools, sends.
pub struct RunStream {
    run_id: Uuid,
    spool: SharedSpool,
    outbound: Outbound,
    status: RunStatus,
    pending_output: Vec<u8>,
}

impl RunStream {
    pub fn new(spool: SharedSpool, outbound: Outbound) -> Self {
        let (run_id, status) = match spool.lock() {
            Ok(s) => (s.run_id(), s.journal().status.unwrap_or(RunStatus::Starting)),
            Err(_) => (Uuid::nil(), RunStatus::Starting),
        };
        Self { run_id, spool, outbound, status, pending_output: Vec::new() }
    }

    /// Consumes emits until the channel closes (after `Completed`), flushing output on time.
    pub async fn run(mut self, mut emits: mpsc::UnboundedReceiver<RunEmit>) {
        loop {
            let next = if self.pending_output.is_empty() {
                emits.recv().await
            } else {
                match tokio::time::timeout(OUTPUT_FLUSH_DELAY, emits.recv()).await {
                    Ok(item) => item,
                    Err(_) => {
                        self.flush_output();
                        continue;
                    }
                }
            };
            let Some(emit) = next else { break };
            self.handle(emit);
        }
        self.flush_output();
    }

    /// Processes one emit (also used for synthetic frames such as `interrupted`).
    pub fn handle(&mut self, emit: RunEmit) {
        match emit {
            RunEmit::Output(bytes) => {
                self.pending_output.extend_from_slice(&bytes);
                if self.pending_output.len() >= OUTPUT_FLUSH_BYTES {
                    self.flush_output();
                }
            }
            RunEmit::State(update) => {
                self.flush_output();
                self.emit_state(update);
            }
            RunEmit::Event(event) => {
                self.flush_output();
                self.push(|run_id, seq| RunnerMessage::RunEvent(RunEventMsg { run_id, seq, event }));
            }
            RunEmit::Usage(usage) => {
                self.push(|run_id, seq| RunnerMessage::RunUsage(RunUsage { run_id, seq, usage }));
            }
            RunEmit::Completed(done) => {
                self.flush_output();
                self.emit_completed(done);
            }
        }
    }

    fn emit_state(&mut self, update: RunStateUpdate) {
        if let Some(status) = update.status {
            self.status = status;
        }
        let status = self.status;
        self.push(|run_id, seq| {
            RunnerMessage::RunState(RunState {
                run_id,
                seq,
                status,
                detail: update.detail,
                exit_code: update.exit_code,
                cli_session_id: update.cli_session_id,
                worktree: update.worktree,
                resumable: update.resumable,
            })
        });
    }

    fn emit_completed(&mut self, done: RunCompletion) {
        self.status = done.status;
        self.push(|run_id, seq| {
            RunnerMessage::RunCompleted(RunCompleted {
                run_id,
                seq,
                status: done.status,
                exit_code: done.exit_code,
                summary: done.summary,
                error: done.error,
                cli_session_id: done.cli_session_id,
                head_commit: done.head_commit,
                diff: done.diff,
                tests: done.tests,
                usage: done.usage,
            })
        });
    }

    fn flush_output(&mut self) {
        if self.pending_output.is_empty() {
            return;
        }
        let data = BASE64.encode(std::mem::take(&mut self.pending_output));
        self.push(|run_id, seq| RunnerMessage::RunOutput(RunOutput { run_id, seq, data }));
    }

    fn push(&mut self, build: impl FnOnce(Uuid, u64) -> RunnerMessage) {
        let dropped = self.append_and_send(build);
        if dropped > 0 {
            let event = AgentEvent::Gap { dropped_bytes: dropped };
            // The gap event is not output, so it can never cause further drops.
            self.append_and_send(|run_id, seq| {
                RunnerMessage::RunEvent(RunEventMsg { run_id, seq, event })
            });
        }
    }

    /// Spools then sends one frame; returns the output bytes the spool cap dropped.
    fn append_and_send(&mut self, build: impl FnOnce(Uuid, u64) -> RunnerMessage) -> u64 {
        let (msg, dropped) = {
            let Ok(mut spool) = self.spool.lock() else { return 0 };
            let seq = spool.next_seq();
            let msg = build(self.run_id, seq);
            let dropped = match spool.append(seq, &msg) {
                Ok(dropped) => dropped,
                Err(err) => {
                    tracing::warn!(run_id = %self.run_id, "spool write failed: {err}");
                    0
                }
            };
            (msg, dropped)
        };
        self.outbound.send(msg);
        dropped
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use coffe_protocol::Usage;

    fn output(run_id: Uuid, seq: u64, bytes: &[u8]) -> RunnerMessage {
        RunnerMessage::RunOutput(RunOutput { run_id, seq, data: BASE64.encode(bytes) })
    }

    fn seqs(messages: &[RunnerMessage]) -> Vec<u64> {
        messages
            .iter()
            .map(|m| match m {
                RunnerMessage::RunOutput(o) => o.seq,
                RunnerMessage::RunState(s) => s.seq,
                RunnerMessage::RunEvent(e) => e.seq,
                RunnerMessage::RunUsage(u) => u.seq,
                RunnerMessage::RunCompleted(c) => c.seq,
                _ => 0,
            })
            .collect()
    }

    #[test]
    fn seq_continues_and_acks_trim_across_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let run_id = Uuid::now_v7();
        {
            let mut spool = RunSpool::open(dir.path(), run_id).unwrap();
            for _ in 0..5 {
                let seq = spool.next_seq();
                spool.append(seq, &output(run_id, seq, b"x")).unwrap();
            }
            spool.ack(2).unwrap();
            assert_eq!(seqs(&spool.replay(0)), vec![3, 4, 5]);
        }
        let mut spool = RunSpool::open(dir.path(), run_id).unwrap();
        assert_eq!(spool.last_seq(), 5);
        assert_eq!(seqs(&spool.replay(3)), vec![4, 5]);
        assert_eq!(spool.next_seq(), 6);
        spool.ack(5).unwrap();
        assert!(!spool.has_pending());

        // Everything acked: the next seq still continues after a reopen.
        let mut spool = RunSpool::open(dir.path(), run_id).unwrap();
        assert_eq!(spool.next_seq(), 6);
    }

    #[test]
    fn journal_tracks_status_session_and_completion() {
        let dir = tempfile::tempdir().unwrap();
        let run_id = Uuid::now_v7();
        let mut spool = RunSpool::open(dir.path(), run_id).unwrap();
        let seq = spool.next_seq();
        let state = RunnerMessage::RunState(RunState {
            run_id,
            seq,
            status: RunStatus::Running,
            detail: None,
            exit_code: None,
            cli_session_id: Some("sess-1".into()),
            worktree: None,
            resumable: None,
        });
        spool.append(seq, &state).unwrap();
        let reopened = RunSpool::open(dir.path(), run_id).unwrap();
        assert_eq!(reopened.journal().status, Some(RunStatus::Running));
        assert_eq!(reopened.journal().cli_session_id.as_deref(), Some("sess-1"));
        assert!(!reopened.journal().completed);
        assert!(!reopened.is_settled());
    }

    #[test]
    fn cap_drops_oldest_output_but_keeps_other_frames() {
        let dir = tempfile::tempdir().unwrap();
        let run_id = Uuid::now_v7();
        let mut spool = RunSpool::open_with_cap(dir.path(), run_id, 600).unwrap();
        let seq = spool.next_seq();
        let usage = RunnerMessage::RunUsage(RunUsage { run_id, seq, usage: Usage::default() });
        spool.append(seq, &usage).unwrap();
        let mut dropped_total = 0;
        for _ in 0..10 {
            let seq = spool.next_seq();
            dropped_total += spool.append(seq, &output(run_id, seq, &[b'a'; 64])).unwrap();
        }
        assert!(dropped_total > 0);
        let remaining = spool.replay(0);
        assert!(matches!(remaining[0], RunnerMessage::RunUsage(_)), "usage is never dropped");
        let reopened = RunSpool::open_with_cap(dir.path(), run_id, 600).unwrap();
        assert_eq!(seqs(&reopened.replay(0)), seqs(&remaining));
    }

    #[tokio::test]
    async fn stream_coalesces_output_and_orders_frames() {
        let dir = tempfile::tempdir().unwrap();
        let run_id = Uuid::now_v7();
        let spool: SharedSpool = Arc::new(Mutex::new(RunSpool::open(dir.path(), run_id).unwrap()));
        let outbound = Outbound::default();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        outbound.set(Some(tx));

        let (emit_tx, emit_rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(RunStream::new(spool.clone(), outbound).run(emit_rx));
        emit_tx.send(RunEmit::State(RunStateUpdate { status: Some(RunStatus::Running), ..Default::default() })).unwrap();
        emit_tx.send(RunEmit::Output(b"hel".to_vec())).unwrap();
        emit_tx.send(RunEmit::Output(b"lo".to_vec())).unwrap();
        emit_tx
            .send(RunEmit::Completed(RunCompletion {
                status: RunStatus::Completed,
                exit_code: Some(0),
                summary: Some("done".into()),
                error: None,
                cli_session_id: None,
                head_commit: None,
                diff: None,
                tests: None,
                usage: None,
            }))
            .unwrap();
        drop(emit_tx);
        task.await.unwrap();

        let mut types = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            let value: serde_json::Value = serde_json::from_str(&frame).unwrap();
            types.push((value["type"].as_str().unwrap().to_owned(), value["payload"]["seq"].as_u64().unwrap()));
            if value["type"] == "run.output" {
                assert_eq!(BASE64.decode(value["payload"]["data"].as_str().unwrap()).unwrap(), b"hello");
            }
        }
        assert_eq!(
            types,
            vec![("run.state".into(), 1), ("run.output".into(), 2), ("run.completed".into(), 3)]
        );
        assert!(spool.lock().unwrap().journal().completed);
    }

    #[test]
    fn list_runs_ignores_foreign_entries() {
        let dir = tempfile::tempdir().unwrap();
        let run_id = Uuid::now_v7();
        RunSpool::open(dir.path(), run_id).unwrap();
        fs::create_dir_all(dir.path().join("not-a-run")).unwrap();
        assert_eq!(list_runs(dir.path()).unwrap(), vec![run_id]);
        assert!(list_runs(&dir.path().join("missing")).unwrap().is_empty());
    }
}
