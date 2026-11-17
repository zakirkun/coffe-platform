import type { DiffSummary, RunStart, Usage } from '@coffe/protocol';
import type { FakeRunner } from './fake-runner.js';

export const BASE_COMMIT = 'a'.repeat(40);

export function diffOf(path: string, head = 'b'.repeat(40)): DiffSummary {
  return {
    base_commit: BASE_COMMIT,
    head_commit: head,
    additions: 1,
    deletions: 0,
    files: [{ path, status: 'modified', additions: 1, deletions: 0, binary: false }],
    patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1 @@\n+change\n`,
    truncated: false,
  };
}

export interface Completion {
  status?: 'completed' | 'failed' | 'cancelled';
  summary?: string;
  diff?: DiffSummary | null;
  usage?: Usage | null;
  error?: string;
}

/** Plays a whole run on the fake runner: running state, then `run.completed`. */
export function finishRun(runner: FakeRunner, start: RunStart, completion: Completion = {}): void {
  runner.send({
    type: 'run.state',
    payload: {
      run_id: start.run_id,
      seq: 1,
      status: 'running',
      cli_session_id: `session-${start.run_id.slice(0, 8)}`,
    },
  });
  runner.send({
    type: 'run.completed',
    payload: {
      run_id: start.run_id,
      seq: 2,
      status: completion.status ?? 'completed',
      exit_code: completion.status && completion.status !== 'completed' ? 1 : 0,
      summary: completion.summary ?? 'Done.',
      error: completion.error ?? null,
      diff: completion.diff ?? null,
      usage: completion.usage ?? null,
    },
  });
}
