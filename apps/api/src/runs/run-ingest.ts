import type { RunEvent } from '@coffe/contracts';
import type { AgentEvent, DiffSummary, TestReport, Usage } from '@coffe/protocol';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import type { Database } from '../db/client.js';
import type { DbExecutor } from '../db/db.module.js';
import { DB } from '../db/db.module.js';
import { diffs, runEvents, runOutput, runUsage, runs, testResults } from '../db/schema/index.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { type RunFrame, RunnerHub, type RunnerConnection } from '../runners/runner-hub.js';
import { TicketsService } from '../tickets/tickets.service.js';
import { RunDispatcher } from './run-dispatcher.js';
import { type RunRow, RunStore, toDiffRow, toRunUsage } from './run-store.js';

/** Architecture §8.5: acks are sent after the DB write, at most every 250 ms or 256 messages. */
const ACK_INTERVAL_MS = 250;
const ACK_BATCH = 256;

interface RunScope {
  id: string;
  workspaceId: string;
  ticketId: string | null;
  runnerId: string;
}

interface PendingAck {
  runnerId: string;
  seq: number;
}

/** Statuses after which state frames (late replays) no longer change a run. */
const ENDED: Record<string, true> = { completed: true, failed: true, cancelled: true };

/**
 * Consumes `run.*` frames from runners (architecture §8.5): idempotent writes keyed by
 * `(run_id, seq)`, realtime fan-out, ticket transitions on completion (§11.2) and cumulative
 * `run.ack`s once frames are persisted.
 */
@Injectable()
export class RunIngest implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RunIngest.name);
  private readonly scopes = new Map<string, RunScope>();
  private readonly pendingAcks = new Map<string, PendingAck>();
  private framesSinceFlush = 0;
  private flushTimer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly hub: RunnerHub,
    private readonly realtime: RealtimeService,
    private readonly store: RunStore,
    private readonly tickets: TicketsService,
    private readonly dispatcher: RunDispatcher,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.hub.setRunFrameHandler((connection, frame) => this.ingest(connection, frame));
  }

  async onModuleDestroy(): Promise<void> {
    clearTimeout(this.flushTimer);
    await this.flushAcks();
  }

  async ingest(connection: RunnerConnection, frame: RunFrame): Promise<void> {
    const runId = frame.payload.run_id;
    const scope = await this.scope(runId, connection.runnerId);
    if (scope) {
      switch (frame.type) {
        case 'run.output':
          await this.output(scope, frame.payload.seq, frame.payload.data);
          break;
        case 'run.event':
          await this.event(scope, frame.payload.seq, frame.payload.event);
          break;
        case 'run.usage':
          await this.usage(scope, frame.payload.usage);
          break;
        case 'run.state':
          await this.state(scope, frame.payload);
          break;
        case 'run.completed':
          await this.completed(scope, frame.payload);
          break;
      }
    }
    // Unknown runs are acknowledged too, so the runner can drop them from its spool.
    this.queueAck(connection.runnerId, runId, frame.payload.seq);
  }

  private async scope(runId: string, runnerId: string): Promise<RunScope | null> {
    const cached = this.scopes.get(runId);
    if (cached) return cached.runnerId === runnerId ? cached : null;
    const [row] = await this.db
      .select({ id: runs.id, workspaceId: runs.workspaceId, ticketId: runs.ticketId, runnerId: runs.runnerId })
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.runnerId, runnerId)))
      .limit(1);
    if (!row?.runnerId) return null;
    const scope: RunScope = { ...row, runnerId: row.runnerId };
    this.scopes.set(runId, scope);
    return scope;
  }

  private async output(scope: RunScope, seq: number, data: string): Promise<void> {
    const inserted = await this.db
      .insert(runOutput)
      .values({ runId: scope.id, seq, data: Buffer.from(data, 'base64') })
      .onConflictDoNothing()
      .returning({ seq: runOutput.seq });
    if (inserted.length === 0) return;
    this.realtime.publish(`run:${scope.id}`, { ev: 'run.output', runId: scope.id, seq, data });
  }

  private async event(scope: RunScope, seq: number, event: AgentEvent): Promise<void> {
    const [inserted] = await this.db
      .insert(runEvents)
      .values({ runId: scope.id, seq, type: event.kind, data: event as unknown as Record<string, unknown> })
      .onConflictDoNothing()
      .returning();
    if (!inserted) return;
    const payload: RunEvent = { seq, ts: inserted.ts.toISOString(), type: inserted.type, data: inserted.data };
    this.realtime.publish(`run:${scope.id}`, { ev: 'run.event', runId: scope.id, event: payload });

    if (event.kind === 'tool_call' && event.tool_kind === 'execute') {
      const input = event.input;
      const command =
        typeof input === 'object' && input !== null && 'command' in input && typeof input.command === 'string'
          ? input.command
          : (event.title ?? event.name);
      const [run] = await this.db.select({ personaId: runs.personaId }).from(runs).where(eq(runs.id, scope.id)).limit(1);
      await this.audit.record({
        workspaceId: scope.workspaceId,
        actorType: 'agent',
        runnerId: scope.runnerId,
        personaId: run?.personaId ?? null,
        runId: scope.id,
        action: 'agent.execute',
        targetType: 'run',
        targetId: scope.id,
        command,
        details: { tool: event.name, callId: event.call_id },
      });
    }
  }

  private async usage(scope: RunScope, usage: Usage): Promise<void> {
    await this.upsertUsage(this.db, scope.id, usage);
    const [row] = await this.db.select().from(runUsage).where(eq(runUsage.runId, scope.id)).limit(1);
    if (row) this.realtime.publish(`run:${scope.id}`, { ev: 'run.usage', runId: scope.id, usage: toRunUsage(row) });
  }

  private async state(
    scope: RunScope,
    state: Extract<RunFrame, { type: 'run.state' }>['payload'],
  ): Promise<void> {
    const [current] = await this.db.select().from(runs).where(eq(runs.id, scope.id)).limit(1);
    if (!current || ENDED[current.status]) return;
    const [row] = await this.db
      .update(runs)
      .set({
        status: state.status,
        statusDetail: state.detail ?? null,
        ...(state.exit_code != null ? { exitCode: state.exit_code } : {}),
        ...(state.cli_session_id ? { cliSessionId: state.cli_session_id } : {}),
        ...(state.worktree
          ? {
              worktreePath: state.worktree.path,
              baseCommit: state.worktree.base_commit,
              ...(state.worktree.branch ? { branch: state.worktree.branch } : {}),
            }
          : {}),
        ...(state.status === 'running' && !current.startedAt ? { startedAt: new Date() } : {}),
      })
      .where(and(eq(runs.id, scope.id), isNull(runs.endedAt)))
      .returning();
    if (!row) return;
    await this.store.publish(row);
    if (row.ticketId && state.status !== current.status) await this.tickets.publishUpdated(row.ticketId);
  }

  private async completed(
    scope: RunScope,
    done: Extract<RunFrame, { type: 'run.completed' }>['payload'],
  ): Promise<void> {
    const ended = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(runs)
        .set({
          status: done.status,
          statusDetail: null,
          exitCode: done.exit_code ?? null,
          resultSummary: done.summary ?? null,
          error: done.error ?? null,
          ...(done.cli_session_id ? { cliSessionId: done.cli_session_id } : {}),
          ...(done.head_commit ? { headCommit: done.head_commit } : {}),
          endedAt: new Date(),
        })
        .where(and(eq(runs.id, scope.id), isNull(runs.endedAt)))
        .returning();
      if (!row) return null;
      if (done.usage) await this.upsertUsage(tx, row.id, done.usage);
      // A completed run changed something when its diff touches at least one file.
      const changedFiles = done.diff && done.diff.files.length > 0 ? done.diff : null;
      if (changedFiles) await this.insertDiff(tx, row, changedFiles);
      if (done.tests && row.ticketId) await this.insertTests(tx, row, done.tests);
      // Workflow steps and planning runs move their ticket through the orchestrator instead.
      if (row.ticketId && row.kind === 'ticket' && !row.workflowInstanceId) {
        if (done.status === 'completed' && changedFiles) {
          await this.tickets.apply(tx, row.ticketId, { status: 'in_review', flags: { failed: false } });
        } else if (done.status !== 'completed') {
          await this.tickets.apply(tx, row.ticketId, { flags: { failed: true } });
        }
      }
      return row;
    });
    this.scopes.delete(scope.id);
    if (!ended) return;
    await this.store.publish(ended);
    if (ended.ticketId) {
      await this.tickets.publishUpdated(ended.ticketId);
      this.realtime.publish(`ticket:${ended.ticketId}`, { ev: 'review.updated', ticketId: ended.ticketId });
    }
    const [usage] = await this.db.select().from(runUsage).where(eq(runUsage.runId, ended.id)).limit(1);
    if (usage) this.realtime.publish(`run:${ended.id}`, { ev: 'run.usage', runId: ended.id, usage: toRunUsage(usage) });
    await this.dispatcher.dispatch(scope.runnerId);
    await this.store.ended(ended);
  }

  private async insertDiff(executor: DbExecutor, row: RunRow, diff: DiffSummary): Promise<void> {
    if (!row.ticketId) return;
    await executor.insert(diffs).values({ ...toDiffRow(diff), runId: row.id, ticketId: row.ticketId });
  }

  private async insertTests(executor: DbExecutor, row: RunRow, tests: TestReport): Promise<void> {
    if (!row.ticketId) return;
    await executor.insert(testResults).values({
      runId: row.id,
      ticketId: row.ticketId,
      source: tests.source,
      command: tests.command ?? null,
      status: tests.status,
      passed: tests.passed,
      failed: tests.failed,
      skipped: tests.skipped,
      durationMs: tests.duration_ms ?? null,
      report: { failures: tests.failures ?? [] },
      outputTail: tests.output_tail ?? null,
    });
  }

  private async upsertUsage(executor: DbExecutor, runId: string, usage: Usage): Promise<void> {
    const values = {
      available: usage.available,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_tokens,
      cacheWriteTokens: usage.cache_write_tokens,
      reasoningTokens: usage.reasoning_tokens,
      totalTokens: usage.input_tokens + usage.output_tokens + usage.cache_read_tokens + usage.cache_write_tokens,
      costUsd: usage.cost_usd ?? null,
      costSource: usage.cost_usd != null ? ('reported' as const) : ('unavailable' as const),
      credits: usage.credits ?? null,
      durationMs: usage.duration_ms ?? null,
      numTurns: usage.num_turns ?? null,
      model: usage.model ?? null,
    };
    await executor
      .insert(runUsage)
      .values({ runId, ...values })
      .onConflictDoUpdate({ target: runUsage.runId, set: values });
  }

  private queueAck(runnerId: string, runId: string, seq: number): void {
    const pending = this.pendingAcks.get(runId);
    if (!pending || seq > pending.seq) this.pendingAcks.set(runId, { runnerId, seq });
    this.framesSinceFlush += 1;
    if (this.framesSinceFlush >= ACK_BATCH) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
      void this.flushAcks();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        void this.flushAcks();
      }, ACK_INTERVAL_MS);
      this.flushTimer.unref();
    }
  }

  /** Persists the highest seq per run, then acknowledges it to the runner. */
  private async flushAcks(): Promise<void> {
    this.framesSinceFlush = 0;
    const batch = [...this.pendingAcks.entries()];
    this.pendingAcks.clear();
    for (const [runId, { runnerId, seq }] of batch) {
      try {
        await this.db
          .update(runs)
          .set({ lastSeq: sql`greatest(${runs.lastSeq}, ${seq})` })
          .where(eq(runs.id, runId));
      } catch (error) {
        this.logger.warn(`recording seq ${seq} of run ${runId} failed: ${String(error)}`);
      }
      this.hub.relay(runnerId, { type: 'run.ack', payload: { run_id: runId, seq } });
    }
  }
}
