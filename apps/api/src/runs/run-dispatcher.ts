import { PLAN_OUTPUT_JSON_SCHEMA } from '@coffe/contracts';
import type { RunStart } from '@coffe/protocol';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, count, eq, inArray, isNull } from 'drizzle-orm';
import { ApiException } from '../common/api-error.js';
import { ACTIVE_RUN_STATUSES } from '../common/run-status.js';
import { ContextService } from '../context/context.service.js';
import type { Database } from '../db/client.js';
import { DB } from '../db/db.module.js';
import { personas, projects, runnerRepos, runners, runs, tickets } from '../db/schema/index.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { RunnerHub } from '../runners/runner-hub.js';
import { TicketsService } from '../tickets/tickets.service.js';
import {
  PLANNING_RUN_PERMISSIONS,
  RUN_TERMINAL,
  RUN_TIMEOUT_SECS,
  TICKET_RUN_PERMISSIONS,
  toProtocolPolicy,
} from './run-context.js';
import { type RunRow, RunStore } from './run-store.js';

type StartOutcome = 'started' | 'skipped' | 'offline';

/**
 * Moves runs from `queued` to `dispatched` (architecture §11.1, §11.5): a run starts when its
 * runner is online and runs fewer than `max_concurrent_runs` runs; until then it waits with a
 * visible reason.
 */
@Injectable()
export class RunDispatcher {
  private readonly logger = new Logger(RunDispatcher.name);
  /** Tail of the dispatch work per runner, so two passes over one runner never overlap. */
  private readonly passes = new Map<string, Promise<void>>();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly hub: RunnerHub,
    private readonly realtime: RealtimeService,
    private readonly store: RunStore,
    private readonly tickets: TicketsService,
    private readonly context: ContextService,
  ) {}

  /**
   * Starts the queued runs of a runner, oldest first, while it is online and has a free slot.
   * Call it whenever that may have changed (run created or ended, runner connected). Never
   * rejects: a failing pass is logged and the runs stay queued for the next one.
   */
  dispatch(runnerId: string): Promise<void> {
    const pass: Promise<void> = (this.passes.get(runnerId) ?? Promise.resolve())
      .then(() => this.drain(runnerId))
      .catch((error: unknown) => {
        this.logger.error(
          `dispatch for runner ${runnerId} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
      })
      .finally(() => {
        if (this.passes.get(runnerId) === pass) this.passes.delete(runnerId);
      });
    this.passes.set(runnerId, pass);
    return pass;
  }

  /**
   * Ends a run the runner will not report on: cancelled before it reached the runner (or while
   * the runner is gone), or impossible to start. Returns `null` when the run had already ended.
   */
  async abort(runId: string, status: 'failed' | 'cancelled', reason: string): Promise<RunRow | null> {
    const row = await this.db.transaction(async (tx) => {
      const [ended] = await tx
        .update(runs)
        .set({
          status,
          statusDetail: reason,
          error: status === 'failed' ? reason : null,
          endedAt: new Date(),
        })
        .where(and(eq(runs.id, runId), isNull(runs.endedAt)))
        .returning();
      if (ended?.ticketId) await this.tickets.apply(tx, ended.ticketId, { flags: { failed: true } });
      return ended ?? null;
    });
    if (!row) return null;
    await this.store.publish(row);
    if (row.ticketId) {
      await this.tickets.publishUpdated(row.ticketId);
      this.realtime.publish(`ticket:${row.ticketId}`, { ev: 'review.updated', ticketId: row.ticketId });
    }
    await this.store.ended(row);
    return row;
  }

  private async drain(runnerId: string): Promise<void> {
    const queued = await this.db
      .select()
      .from(runs)
      .where(and(eq(runs.runnerId, runnerId), eq(runs.status, 'queued')))
      .orderBy(asc(runs.createdAt), asc(runs.id));
    if (queued.length === 0) return;
    const [runner] = await this.db
      .select({ name: runners.name, maxConcurrentRuns: runners.maxConcurrentRuns })
      .from(runners)
      .where(eq(runners.id, runnerId))
      .limit(1);
    if (!runner) return;

    const offline = `waiting for runner ${runner.name}`;
    if (!this.hub.isOnline(runnerId)) {
      await this.explain(queued, offline);
      return;
    }
    const [occupied] = await this.db
      .select({ slots: count() })
      .from(runs)
      .where(and(eq(runs.runnerId, runnerId), inArray(runs.status, ACTIVE_RUN_STATUSES)));
    let free = runner.maxConcurrentRuns - (occupied?.slots ?? 0);

    for (const [index, run] of queued.entries()) {
      if (free <= 0) {
        await this.explain(queued.slice(index), 'runner at capacity');
        return;
      }
      const outcome = await this.start(runnerId, run);
      if (outcome === 'offline') {
        await this.explain(queued.slice(index), offline);
        return;
      }
      if (outcome === 'started') free -= 1;
    }
  }

  /** Records why runs are still queued and pushes the ones whose reason changed. */
  private async explain(waiting: RunRow[], detail: string): Promise<void> {
    const changed = waiting.filter((run) => run.statusDetail !== detail).map((run) => run.id);
    if (changed.length === 0) return;
    const rows = await this.db
      .update(runs)
      .set({ statusDetail: detail })
      .where(and(inArray(runs.id, changed), eq(runs.status, 'queued')))
      .returning();
    for (const row of rows) await this.store.publish(row);
  }

  private async start(runnerId: string, run: RunRow): Promise<StartOutcome> {
    const command = await this.startCommand(run);
    if (!command) {
      await this.abort(run.id, 'failed', 'the ticket or repository of this run no longer exists');
      return 'skipped';
    }
    // Claimed before the command leaves, so the runner's first `run.state` finds a dispatched run.
    const [claimed] = await this.db
      .update(runs)
      .set({ status: 'dispatched', statusDetail: null })
      .where(and(eq(runs.id, run.id), eq(runs.status, 'queued')))
      .returning();
    if (!claimed) return 'skipped';
    try {
      await this.hub.send(
        runnerId,
        { type: 'run.start', payload: command },
        { actorUserId: run.requestedBy, runId: run.id },
      );
    } catch (error) {
      await this.db
        .update(runs)
        .set({ status: 'queued' })
        .where(and(eq(runs.id, run.id), eq(runs.status, 'dispatched')));
      if (error instanceof ApiException && error.code === 'runner_offline') return 'offline';
      throw error;
    }
    await this.store.publish(claimed);
    if (claimed.ticketId) await this.tickets.publishUpdated(claimed.ticketId);
    return 'started';
  }

  /** `run.start` for a queued run, or `null` when what it needs was deleted in the meantime. */
  private async startCommand(run: RunRow): Promise<RunStart | null> {
    if (!run.repoId || !run.baseBranch) return null;
    const [source] = await this.db
      .select({ settings: projects.settings, repoKey: runnerRepos.repoKey })
      .from(projects)
      .innerJoin(runnerRepos, eq(runnerRepos.id, run.repoId))
      .where(eq(projects.id, run.projectId))
      .limit(1);
    if (!source) return null;
    const planning = run.kind === 'planning';
    const [ticket] = run.ticketId ? await this.db.select().from(tickets).where(eq(tickets.id, run.ticketId)).limit(1) : [];
    if (!planning && (!ticket || !run.branch)) return null;
    const [persona] = run.personaId
      ? await this.db
          .select({ id: personas.id, name: personas.name, role: personas.role })
          .from(personas)
          .where(eq(personas.id, run.personaId))
          .limit(1)
      : [];

    // A follow-up run continues the CLI session of the run it follows, when that CLI kept one.
    let cliSessionId: string | null = null;
    if (run.parentRunId) {
      const [parent] = await this.db
        .select({ cliId: runs.cliId, cliSessionId: runs.cliSessionId })
        .from(runs)
        .where(eq(runs.id, run.parentRunId))
        .limit(1);
      if (parent?.cliId === run.cliId) cliSessionId = parent.cliSessionId;
    }

    const policy = run.permissions ?? (planning ? PLANNING_RUN_PERMISSIONS : TICKET_RUN_PERMISSIONS);
    const writes = !planning && policy.mode !== 'read_only';
    // Tests gate the review of code changes; reviewers and planners change nothing.
    const runsTests = writes && (!persona || persona.role === 'implementer' || persona.role === 'tester');
    return {
      run_id: run.id,
      project_id: run.projectId,
      // The runner treats a conflict-resolution run like any other run on the ticket's branch.
      kind: run.kind === 'conflict' ? 'ticket' : run.kind,
      cli_id: run.cliId,
      mode: run.mode,
      driver: run.driver,
      model: run.model,
      prompt: run.prompt,
      repo_key: source.repoKey,
      ticket_key: ticket?.key ?? null,
      worktree:
        planning || !run.branch
          ? { mode: 'detached', base_branch: run.baseBranch }
          : { mode: 'branch', branch: run.branch, base_branch: run.baseBranch },
      context: await this.context.build({
        projectId: run.projectId,
        kind: planning ? 'planning' : 'ticket',
        ticketId: run.ticketId,
        personaId: run.personaId,
        requirementId: run.requirementId,
        handoff: run.handoff,
      }),
      permissions: toProtocolPolicy(policy),
      persona: persona ? { id: persona.id, name: persona.name, role: persona.role } : null,
      resume: cliSessionId ? { cli_session_id: cliSessionId } : null,
      timeout_secs: policy.timeout_secs ?? RUN_TIMEOUT_SECS,
      terminal: RUN_TERMINAL,
      ...(planning ? { output_schema: PLAN_OUTPUT_JSON_SCHEMA } : {}),
      auto_commit: writes,
      commit_message: ticket ? `${ticket.key}: ${ticket.title}` : null,
      test_command: runsTests ? (source.settings.test_command ?? null) : null,
    };
  }
}
