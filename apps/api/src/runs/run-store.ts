import type { Run, RunUsage } from '@coffe/contracts';
import type { DiffSummary } from '@coffe/protocol';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { ApiException } from '../common/api-error.js';
import type { Database } from '../db/client.js';
import { DB } from '../db/db.module.js';
import { diffs, runs, runUsage } from '../db/schema/index.js';
import { RealtimeService } from '../realtime/realtime.service.js';

export type RunRow = typeof runs.$inferSelect;
export type RunUsageRow = typeof runUsage.$inferSelect;

/** Columns of a `diffs` row for a diff computed by a runner (run completion or refresh). */
export function toDiffRow(diff: DiffSummary): Omit<typeof diffs.$inferInsert, 'ticketId' | 'runId'> {
  return {
    baseCommit: diff.base_commit,
    headCommit: diff.head_commit,
    additions: diff.additions,
    deletions: diff.deletions,
    files: diff.files.map((file) => ({
      path: file.path,
      old_path: file.old_path ?? null,
      status: file.status,
      additions: file.additions ?? null,
      deletions: file.deletions ?? null,
      binary: file.binary,
    })),
    patch: diff.patch,
    truncated: diff.truncated,
  };
}

export function toRunUsage(row: RunUsageRow): RunUsage {
  return {
    available: row.available,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    reasoningTokens: row.reasoningTokens,
    totalTokens: row.totalTokens,
    costUsd: row.costUsd,
    costSource: row.costSource,
    credits: row.credits,
    durationMs: row.durationMs,
    numTurns: row.numTurns,
    model: row.model,
  };
}

function toRun(row: RunRow, usage: RunUsageRow | undefined): Run {
  return {
    id: row.id,
    projectId: row.projectId,
    ticketId: row.ticketId,
    kind: row.kind,
    personaId: row.personaId,
    workflowStepKey: row.workflowStepKey,
    attempt: row.attempt,
    parentRunId: row.parentRunId,
    runnerId: row.runnerId,
    repoId: row.repoId,
    cliId: row.cliId,
    model: row.model,
    mode: row.mode,
    status: row.status,
    statusDetail: row.statusDetail,
    exitCode: row.exitCode,
    prompt: row.prompt,
    cliSessionId: row.cliSessionId,
    branch: row.branch,
    baseBranch: row.baseBranch,
    baseCommit: row.baseCommit,
    headCommit: row.headCommit,
    resultSummary: row.resultSummary,
    error: row.error,
    lastSeq: row.lastSeq,
    acceptsInput: row.status === 'running' || row.status === 'waiting_input',
    usage: usage ? toRunUsage(usage) : null,
    requestedBy: row.requestedBy,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}

/** Called once a run reached `completed`, `failed` or `cancelled`. */
export type RunEndedListener = (run: RunRow) => Promise<void>;

/** Run rows as contracts `Run` objects, their `run.updated` pushes and run-ended listeners. */
@Injectable()
export class RunStore {
  private readonly logger = new Logger(RunStore.name);
  private readonly endedListeners: RunEndedListener[] = [];

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly realtime: RealtimeService,
  ) {}

  /** Workflow orchestration and planning react to finished runs through this hook. */
  onEnded(listener: RunEndedListener): void {
    this.endedListeners.push(listener);
  }

  /** Notifies every listener that `run` ended; a failing listener is logged, not propagated. */
  async ended(run: RunRow): Promise<void> {
    for (const listener of this.endedListeners) {
      try {
        await listener(run);
      } catch (error) {
        this.logger.error(
          `handling the end of run ${run.id} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
      }
    }
  }

  /** The run when it belongs to the workspace; 404 otherwise. */
  async get(workspaceId: string, runId: string): Promise<RunRow> {
    const [row] = await this.db
      .select()
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw ApiException.notFound('Run');
    return row;
  }

  async toDtos(rows: RunRow[]): Promise<Run[]> {
    if (rows.length === 0) return [];
    const usage = await this.db
      .select()
      .from(runUsage)
      .where(
        inArray(
          runUsage.runId,
          rows.map((row) => row.id),
        ),
      );
    const usageByRun = new Map(usage.map((row) => [row.runId, row]));
    return rows.map((row) => toRun(row, usageByRun.get(row.id)));
  }

  async toDto(row: RunRow): Promise<Run> {
    const [usage] = await this.db
      .select()
      .from(runUsage)
      .where(eq(runUsage.runId, row.id))
      .limit(1);
    return toRun(row, usage);
  }

  /** Pushes `run.updated` to the run channel and to the channel of its ticket. */
  async publish(row: RunRow): Promise<Run> {
    const run = await this.toDto(row);
    this.realtime.publish(`run:${run.id}`, { ev: 'run.updated', run });
    if (run.ticketId) this.realtime.publish(`ticket:${run.ticketId}`, { ev: 'run.updated', run });
    return run;
  }
}
