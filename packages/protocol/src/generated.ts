/* Generated from crates/coffe-protocol by packages/protocol/scripts/gen.mjs. Do not edit; run `pnpm protocol:gen`. */

/**
 * Frame sent by the runner.
 *
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "RunnerEnvelope".
 */
export type RunnerEnvelope = {
  /**
   * Unique message id (UUID v4 or v7).
   */
  id: string;
  /**
   * Id of the control-plane request this message answers.
   */
  re?: string | null;
  /**
   * RFC 3339 UTC timestamp of creation.
   */
  ts: string;
} & RunnerEnvelope1;
export type RunnerEnvelope1 =
  | {
      payload: Pair;
      type: 'pair';
    }
  | {
      payload: Hello;
      type: 'hello';
    }
  | {
      payload: Heartbeat;
      type: 'heartbeat';
    }
  | {
      payload: Ack;
      type: 'ack';
    }
  | {
      payload: ErrorPayload;
      type: 'error';
    }
  | {
      payload: RunState;
      type: 'run.state';
    }
  | {
      payload: RunOutput;
      type: 'run.output';
    }
  | {
      payload: RunEventMsg;
      type: 'run.event';
    }
  | {
      payload: RunUsage;
      type: 'run.usage';
    }
  | {
      payload: RunCompleted;
      type: 'run.completed';
    }
  | {
      payload: ClisUpdated;
      type: 'clis.updated';
    }
  | {
      payload: ReposUpdated;
      type: 'repos.updated';
    }
  | {
      payload: GitDiffResult;
      type: 'git.diff.result';
    }
  | {
      payload: GitFileResult;
      type: 'git.file.result';
    }
  | {
      payload: GitMergeResult;
      type: 'git.merge.result';
    }
  | {
      payload: PtyOutput;
      type: 'pty.output';
    }
  | {
      payload: PtyExit;
      type: 'pty.exit';
    };
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "RunStatus".
 */
export type RunStatus =
  | 'queued'
  | 'dispatched'
  | 'starting'
  | 'running'
  | 'paused'
  | 'waiting_input'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "CliAuthStatus".
 */
export type CliAuthStatus = 'ok' | 'unauthenticated' | 'unknown';
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "RunMode".
 */
export type RunMode = 'structured' | 'pty';
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "AgentEvent".
 */
export type AgentEvent =
  | {
      cwd?: string | null;
      kind: 'session_started';
      model?: string | null;
      session_id?: string | null;
      tools?: string[];
    }
  | {
      kind: 'message';
      role: MessageRole;
      text: string;
    }
  | {
      kind: 'message_delta';
      text: string;
    }
  | {
      kind: 'thinking';
      text: string;
    }
  | {
      call_id: string;
      /**
       * Tool input as reported by the CLI.
       */
      input: {
        [k: string]: unknown | undefined;
      };
      kind: 'tool_call';
      name: string;
      title?: string | null;
      tool_kind: ToolKind;
    }
  | {
      call_id: string;
      kind: 'tool_result';
      ok: boolean;
      /**
       * Truncated to 16 KiB by the runner.
       */
      output: string;
    }
  | {
      change: string;
      kind: 'file_change';
      path: string;
    }
  | {
      items: PlanItem[];
      kind: 'plan';
    }
  | {
      description: string;
      kind: 'permission_request';
      options: string[];
      request_id: string;
      tool: string;
    }
  | {
      kind: 'usage';
      usage: Usage;
    }
  | {
      duration_ms?: number | null;
      is_error: boolean;
      kind: 'turn_completed';
      num_turns?: number | null;
      result?: string | null;
    }
  | {
      kind: 'error';
      message: string;
    }
  | {
      kind: 'raw';
      text: string;
    }
  | {
      dropped_bytes: number;
      kind: 'gap';
    };
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "MessageRole".
 */
export type MessageRole = 'assistant' | 'user' | 'system';
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "ToolKind".
 */
export type ToolKind = 'read' | 'edit' | 'execute' | 'search' | 'fetch' | 'other';
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "FileStatus".
 */
export type FileStatus =
  'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type_changed' | 'unmerged' | 'unknown';
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "TestSource".
 */
export type TestSource = 'command' | 'agent';
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "TestStatus".
 */
export type TestStatus = 'passed' | 'failed' | 'error';
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "MergeStatus".
 */
export type MergeStatus = 'merged' | 'conflict' | 'failed' | 'nothing_to_merge';
/**
 * Frame sent by the control plane.
 *
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "ServerEnvelope".
 */
export type ServerEnvelope = {
  id: string;
  re?: string | null;
  ts: string;
} & ServerEnvelope1;
export type ServerEnvelope1 =
  | {
      payload: Paired;
      type: 'paired';
    }
  | {
      payload: Welcome;
      type: 'welcome';
    }
  | {
      payload: UpgradeRequired;
      type: 'upgrade_required';
    }
  | {
      payload: Ack;
      type: 'ack';
    }
  | {
      payload: ErrorPayload;
      type: 'error';
    }
  | {
      payload: RunAck;
      type: 'run.ack';
    }
  | {
      payload: RunStart;
      type: 'run.start';
    }
  | {
      payload: RunInput;
      type: 'run.input';
    }
  | {
      payload: RunResize;
      type: 'run.resize';
    }
  | {
      payload: RunSignal;
      type: 'run.signal';
    }
  | {
      payload: GitDiff;
      type: 'git.diff';
    }
  | {
      payload: GitFile;
      type: 'git.file';
    }
  | {
      payload: GitMerge;
      type: 'git.merge';
    }
  | {
      payload: WorktreeRemove;
      type: 'worktree.remove';
    }
  | {
      payload: ClisDetect;
      type: 'clis.detect';
    }
  | {
      payload: PtyOpen;
      type: 'pty.open';
    }
  | {
      payload: PtyInput;
      type: 'pty.input';
    }
  | {
      payload: PtyResize;
      type: 'pty.resize';
    }
  | {
      payload: PtyClose;
      type: 'pty.close';
    };
/**
 * Which structured protocol to use with the CLI (only meaningful for `RunMode::Structured`).
 *
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "RunDriver".
 */
export type RunDriver = 'native' | 'acp';
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "RunKind".
 */
export type RunKind = 'ticket' | 'planning' | 'wiki' | 'query_assist' | 'canvas';
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "PermissionMode".
 */
export type PermissionMode = 'read_only' | 'workspace_write' | 'full_auto';
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "WorktreeMode".
 */
export type WorktreeMode = 'branch' | 'detached';
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "AgentInput".
 */
export type AgentInput =
  | {
      kind: 'text';
      text: string;
    }
  | {
      data: string;
      kind: 'keys';
    }
  | {
      allow: boolean;
      kind: 'permission';
      remember?: boolean;
      request_id: string;
    }
  | {
      kind: 'interrupt';
    };
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "RunSignalKind".
 */
export type RunSignalKind = 'pause' | 'resume' | 'interrupt' | 'stop' | 'kill';
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "MergeStrategy".
 */
export type MergeStrategy = 'ff_only' | 'merge' | 'squash';
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "PtyTarget".
 */
export type PtyTarget =
  | {
      branch: string;
      kind: 'worktree';
      repo_key: string;
    }
  | {
      kind: 'repo';
      repo_key: string;
    };

/**
 * Root type used only to emit one schema containing both directions.
 */
export interface CoffeProtocol {
  runner_to_server: RunnerEnvelope;
  server_to_runner: ServerEnvelope;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "Pair".
 */
export interface Pair {
  arch: string;
  hostname: string;
  keys: RunnerPublicKeys;
  /**
   * Display name chosen by the user (`--name`), defaults to the hostname.
   */
  name: string;
  os: string;
  runner_version: string;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "RunnerPublicKeys".
 */
export interface RunnerPublicKeys {
  /**
   * Ed25519 signature (base64) over the raw 32 bytes of `box_public_key`.
   */
  box_key_signature: string;
  /**
   * X25519 public key (base64), recipient of sealed secrets.
   */
  box_public_key: string;
  /**
   * Ed25519 public key (base64), runner identity.
   */
  sign_public_key: string;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "Hello".
 */
export interface Hello {
  /**
   * Runs still alive (or with unacked spool) on this runner.
   */
  active_runs: ActiveRun[];
  /**
   * `x86_64` | `aarch64` | ...
   */
  arch: string;
  /**
   * Feature flags: `pty`, `git`, `docker`, `db`, `ssh`, `preview`, `index`.
   */
  capabilities: string[];
  clis: CliInfo[];
  hostname: string;
  keys: RunnerPublicKeys;
  /**
   * `linux` | `macos` | `windows`.
   */
  os: string;
  policy: RunnerPolicy;
  /**
   * `"MAJOR.MINOR"`.
   */
  protocol: string;
  repos: RepoInfo[];
  runner_id: string;
  /**
   * Semver of the runner binary.
   */
  runner_version: string;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "ActiveRun".
 */
export interface ActiveRun {
  /**
   * Highest seq the runner has emitted for this run.
   */
  last_seq: number;
  run_id: string;
  status: RunStatus;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "CliInfo".
 */
export interface CliInfo {
  auth: CliAuthStatus;
  capabilities: CliCapabilities;
  /**
   * Adapter id: `claude-code`, `codex`, `gemini`, `opencode`, `antigravity`, `grok`,
   * `muse`, `pi`, `kiro`, `fake`.
   */
  id: string;
  name: string;
  path: string;
  version?: string | null;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "CliCapabilities".
 */
export interface CliCapabilities {
  headless: boolean;
  model_select: boolean;
  /**
   * Modes this adapter supports, in preference order.
   */
  modes: RunMode[];
  permission_callbacks: boolean;
  resume: boolean;
  schema_output: boolean;
  streaming_input: boolean;
  structured_output: boolean;
  tool_filters: boolean;
  usage_cost: boolean;
  usage_tokens: boolean;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "RunnerPolicy".
 */
export interface RunnerPolicy {
  allow_db: boolean;
  allow_db_writes: boolean;
  allow_docker: boolean;
  allow_full_auto: boolean;
  /**
   * Inclusive port range string, e.g. `"3000-9999"`.
   */
  allow_preview_ports: string;
  allow_push: boolean;
  allow_ssh: boolean;
  /**
   * `None` = every detected CLI is allowed.
   */
  allowed_clis?: string[] | null;
  enable_fake_cli: boolean;
  max_concurrent_runs: number;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "RepoInfo".
 */
export interface RepoInfo {
  /**
   * False when the registered path no longer exists or is not a git repo.
   */
  available: boolean;
  default_branch?: string | null;
  head_commit?: string | null;
  name: string;
  /**
   * Absolute path on the runner machine (display only; never used as input by the server).
   */
  path: string;
  /**
   * Remote URL with any credentials stripped.
   */
  remote_url?: string | null;
  /**
   * Stable runner-generated id (never a path).
   */
  repo_key: string;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "Heartbeat".
 */
export interface Heartbeat {
  load_avg?: number | null;
  running_runs: number;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "Ack".
 */
export interface Ack {}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "ErrorPayload".
 */
export interface ErrorPayload {
  /**
   * Stable machine code, e.g. `unsupported_type`, `invalid_payload`, `not_found`,
   * `scope_violation`, `policy_denied`, `busy`, `internal`.
   */
  code: string;
  message: string;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "RunState".
 */
export interface RunState {
  cli_session_id?: string | null;
  detail?: string | null;
  exit_code?: number | null;
  /**
   * Set with `interrupted`: whether the CLI session can be resumed.
   */
  resumable?: boolean | null;
  run_id: string;
  seq: number;
  status: RunStatus;
  worktree?: WorktreeInfo | null;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "WorktreeInfo".
 */
export interface WorktreeInfo {
  base_branch: string;
  base_commit: string;
  branch?: string | null;
  path: string;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "RunOutput".
 */
export interface RunOutput {
  /**
   * Base64 terminal bytes (raw PTY output or rendered transcript).
   */
  data: string;
  run_id: string;
  seq: number;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "RunEventMsg".
 */
export interface RunEventMsg {
  event: AgentEvent;
  run_id: string;
  seq: number;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "PlanItem".
 */
export interface PlanItem {
  /**
   * `pending` | `in_progress` | `completed`.
   */
  status: string;
  text: string;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "Usage".
 */
export interface Usage {
  /**
   * False when the CLI exposes no usage data at all (counts are then zero and meaningless).
   */
  available: boolean;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /**
   * Only when the CLI itself reports cost; estimates are computed by the control plane.
   */
  cost_usd?: number | null;
  /**
   * Vendor credits consumed (CLIs that meter in credits instead of tokens, e.g. Kiro).
   */
  credits?: number | null;
  /**
   * CLI-reported duration (API or wall time), when available.
   */
  duration_ms?: number | null;
  input_tokens: number;
  model?: string | null;
  num_turns?: number | null;
  output_tokens: number;
  reasoning_tokens: number;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "RunUsage".
 */
export interface RunUsage {
  run_id: string;
  seq: number;
  usage: Usage1;
}
/**
 * Cumulative usage for the run so far.
 */
export interface Usage1 {
  /**
   * False when the CLI exposes no usage data at all (counts are then zero and meaningless).
   */
  available: boolean;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /**
   * Only when the CLI itself reports cost; estimates are computed by the control plane.
   */
  cost_usd?: number | null;
  /**
   * Vendor credits consumed (CLIs that meter in credits instead of tokens, e.g. Kiro).
   */
  credits?: number | null;
  /**
   * CLI-reported duration (API or wall time), when available.
   */
  duration_ms?: number | null;
  input_tokens: number;
  model?: string | null;
  num_turns?: number | null;
  output_tokens: number;
  reasoning_tokens: number;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "RunCompleted".
 */
export interface RunCompleted {
  cli_session_id?: string | null;
  diff?: DiffSummary | null;
  error?: string | null;
  exit_code?: number | null;
  head_commit?: string | null;
  run_id: string;
  seq: number;
  /**
   * `completed` | `failed` | `cancelled`.
   */
  status:
    | 'queued'
    | 'dispatched'
    | 'starting'
    | 'running'
    | 'paused'
    | 'waiting_input'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted';
  /**
   * Final assistant result / summary text.
   */
  summary?: string | null;
  tests?: TestReport | null;
  usage?: Usage | null;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "DiffSummary".
 */
export interface DiffSummary {
  additions: number;
  base_commit: string;
  deletions: number;
  files: DiffFile[];
  head_commit: string;
  /**
   * Unified patch (`git diff base...head`), capped at 2 MiB.
   */
  patch: string;
  truncated: boolean;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "DiffFile".
 */
export interface DiffFile {
  /**
   * `None` for binary files.
   */
  additions?: number | null;
  binary: boolean;
  deletions?: number | null;
  old_path?: string | null;
  path: string;
  status: FileStatus;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "TestReport".
 */
export interface TestReport {
  command?: string | null;
  duration_ms?: number | null;
  failed: number;
  failures?: TestFailure[];
  /**
   * Last ~8 KiB of the test command output.
   */
  output_tail?: string | null;
  passed: number;
  skipped: number;
  source: TestSource;
  status: TestStatus;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "TestFailure".
 */
export interface TestFailure {
  message?: string | null;
  name: string;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "ClisUpdated".
 */
export interface ClisUpdated {
  clis: CliInfo[];
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "ReposUpdated".
 */
export interface ReposUpdated {
  repos: RepoInfo[];
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "GitDiffResult".
 */
export interface GitDiffResult {
  diff: DiffSummary;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "GitFileResult".
 */
export interface GitFileResult {
  binary: boolean;
  /**
   * Base64 content; `None` when missing, binary or too large.
   */
  content?: string | null;
  missing: boolean;
  path: string;
  rev: string;
  size: number;
  too_large: boolean;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "GitMergeResult".
 */
export interface GitMergeResult {
  conflicts?: string[];
  merge_commit?: string | null;
  message?: string | null;
  pushed: boolean;
  status: MergeStatus;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "PtyOutput".
 */
export interface PtyOutput {
  /**
   * Base64 bytes.
   */
  data: string;
  seq: number;
  session_id: string;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "PtyExit".
 */
export interface PtyExit {
  exit_code?: number | null;
  session_id: string;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "Paired".
 */
export interface Paired {
  /**
   * Human-readable fingerprint of `keys.sign_public_key` (§14.2).
   */
  fingerprint: string;
  runner_id: string;
  /**
   * `coffe_rt_…`; sent exactly once, only its SHA-256 hash is stored server-side.
   */
  runner_token: string;
  workspace_id: string;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "Welcome".
 */
export interface Welcome {
  /**
   * Runs the control plane considers finished/cancelled; the runner must stop them.
   */
  cancel: string[];
  heartbeat_secs: number;
  protocol: string;
  /**
   * Highest persisted seq per run; the runner replays everything above it.
   */
  resume: ResumeCursor[];
  server_time: string;
  server_version: string;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "ResumeCursor".
 */
export interface ResumeCursor {
  ack_seq: number;
  run_id: string;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "UpgradeRequired".
 */
export interface UpgradeRequired {
  download_url?: string | null;
  message: string;
  min_protocol: string;
  min_runner_version: string;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "RunAck".
 */
export interface RunAck {
  run_id: string;
  /**
   * Cumulative: every message with `seq <= ack` is persisted.
   */
  seq: number;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "RunStart".
 */
export interface RunStart {
  /**
   * Commit all changes after the run (ticket runs).
   */
  auto_commit: boolean;
  cli_id: string;
  commit_message?: string | null;
  context: ContextBundle;
  /**
   * Structured protocol; absent = `native`.
   */
  driver?: RunDriver | null;
  kind: RunKind;
  mode: RunMode;
  model?: string | null;
  /**
   * JSON Schema the final answer must satisfy (planning runs).
   */
  output_schema?: {
    [k: string]: unknown | undefined;
  };
  permissions: PermissionPolicy;
  persona?: PersonaRef | null;
  project_id: string;
  /**
   * The task prompt (context is delivered separately in `context`).
   */
  prompt: string;
  repo_key: string;
  resume?: ResumeSpec | null;
  run_id: string;
  terminal: TermSize;
  /**
   * Shell command run in the worktree after a successful run (review gate test results).
   */
  test_command?: string | null;
  ticket_key?: string | null;
  timeout_secs: number;
  worktree: WorktreeSpec;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "ContextBundle".
 */
export interface ContextBundle {
  attachments?: ContextAttachment[];
  files: ContextFile[];
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "ContextAttachment".
 */
export interface ContextAttachment {
  /**
   * Base64 content.
   */
  data: string;
  mime: string;
  /**
   * File name inside `<worktree>/.coffe/context/attachments/`.
   */
  name: string;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "ContextFile".
 */
export interface ContextFile {
  /**
   * UTF-8 markdown/text content.
   */
  content: string;
  /**
   * File name inside `<worktree>/.coffe/context/`, e.g. `01-rules.md`.
   */
  name: string;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "PermissionPolicy".
 */
export interface PermissionPolicy {
  allow_tools?: string[];
  deny_tools?: string[];
  max_budget_usd?: number | null;
  max_turns?: number | null;
  mode: PermissionMode;
  network: boolean;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "PersonaRef".
 */
export interface PersonaRef {
  id: string;
  name: string;
  role: string;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "ResumeSpec".
 */
export interface ResumeSpec {
  cli_session_id: string;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "TermSize".
 */
export interface TermSize {
  cols: number;
  rows: number;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "WorktreeSpec".
 */
export interface WorktreeSpec {
  base_branch: string;
  /**
   * Required for `branch` mode, e.g. `coffe/COF-12`.
   */
  branch?: string | null;
  mode: WorktreeMode;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "RunInput".
 */
export interface RunInput {
  input: AgentInput;
  run_id: string;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "RunResize".
 */
export interface RunResize {
  cols: number;
  rows: number;
  run_id: string;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "RunSignal".
 */
export interface RunSignal {
  run_id: string;
  signal: RunSignalKind;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "GitDiff".
 */
export interface GitDiff {
  /**
   * Defaults to the branch's recorded base.
   */
  base?: string | null;
  branch: string;
  include_patch: boolean;
  repo_key: string;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "GitFile".
 */
export interface GitFile {
  max_bytes: number;
  /**
   * Repo-relative path.
   */
  path: string;
  repo_key: string;
  /**
   * Commit SHA or ref.
   */
  rev: string;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "GitMerge".
 */
export interface GitMerge {
  branch: string;
  into: string;
  message: string;
  push: boolean;
  remote?: string | null;
  remove_worktree: boolean;
  repo_key: string;
  strategy: MergeStrategy;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "WorktreeRemove".
 */
export interface WorktreeRemove {
  branch: string;
  delete_branch: boolean;
  repo_key: string;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "ClisDetect".
 */
export interface ClisDetect {}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "PtyOpen".
 */
export interface PtyOpen {
  cols: number;
  rows: number;
  session_id: string;
  shell?: string | null;
  target: PtyTarget;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "PtyInput".
 */
export interface PtyInput {
  /**
   * UTF-8 keystrokes.
   */
  data: string;
  session_id: string;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "PtyResize".
 */
export interface PtyResize {
  cols: number;
  rows: number;
  session_id: string;
}
/**
 * This interface was referenced by `CoffeProtocol`'s JSON-Schema
 * via the `definition` "PtyClose".
 */
export interface PtyClose {
  session_id: string;
}

export const PROTOCOL_VERSION = "1.0";
export const PROTOCOL_HEADER = "X-Coffe-Protocol";
