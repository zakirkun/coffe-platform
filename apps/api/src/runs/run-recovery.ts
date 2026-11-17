import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { validate as isUuid } from 'uuid';
import { ACTIVE_RUN_STATUSES } from '../common/run-status.js';
import type { Database } from '../db/client.js';
import { DB } from '../db/db.module.js';
import { runs } from '../db/schema/index.js';
import { RunnerHub, type RunnerOnlineEvent } from '../runners/runner-hub.js';
import { TicketsService } from '../tickets/tickets.service.js';
import { RunDispatcher } from './run-dispatcher.js';
import { RunStore } from './run-store.js';

/**
 * Architecture §8.7: a run the control plane believes active but a reconnected runner did not
 * report becomes `interrupted` once the runner had this long to replay what it spooled.
 */
export const LOST_RUN_GRACE_MS = 120_000;

/** A run that may be lost, with the seq it had when its runner reconnected. */
export interface UnreportedRun {
  id: string;
  lastSeq: number;
}

/** What happens when a runner (re)connects: lost runs are detected, queued runs start. */
@Injectable()
export class RunRecovery implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RunRecovery.name);
  private readonly graceTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly hub: RunnerHub,
    private readonly store: RunStore,
    private readonly tickets: TicketsService,
    private readonly dispatcher: RunDispatcher,
  ) {}

  onModuleInit(): void {
    this.hub.onRunnerOnline((event) => this.onRunnerOnline(event));
  }

  onModuleDestroy(): void {
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
  }

  /**
   * Marks the given runs `interrupted` unless they ended or the runner reported on them (their
   * seq advanced) in the meantime, then hands the freed slots to queued runs.
   */
  async interruptLost(runnerId: string, unreported: UnreportedRun[]): Promise<void> {
    let freed = false;
    for (const { id, lastSeq } of unreported) {
      const [row] = await this.db
        .update(runs)
        .set({ status: 'interrupted', statusDetail: 'the runner no longer has this run' })
        .where(
          and(
            eq(runs.id, id),
            eq(runs.runnerId, runnerId),
            eq(runs.lastSeq, lastSeq),
            inArray(runs.status, ACTIVE_RUN_STATUSES),
          ),
        )
        .returning();
      if (!row) continue;
      freed = true;
      await this.store.publish(row);
      if (row.ticketId) await this.tickets.publishUpdated(row.ticketId);
    }
    if (freed) await this.dispatcher.dispatch(runnerId);
  }

  private async onRunnerOnline({ runnerId, activeRunIds }: RunnerOnlineEvent): Promise<void> {
    // A newer connection supersedes the check scheduled for the previous one.
    clearTimeout(this.graceTimers.get(runnerId));
    this.graceTimers.delete(runnerId);

    const reported = activeRunIds.filter((id) => isUuid(id));
    const unreported: UnreportedRun[] = await this.db
      .select({ id: runs.id, lastSeq: runs.lastSeq })
      .from(runs)
      .where(
        and(
          eq(runs.runnerId, runnerId),
          inArray(runs.status, ACTIVE_RUN_STATUSES),
          reported.length > 0 ? notInArray(runs.id, reported) : undefined,
        ),
      );
    if (unreported.length > 0) {
      const timer = setTimeout(() => {
        this.graceTimers.delete(runnerId);
        this.interruptLost(runnerId, unreported).catch((error: unknown) => {
          this.logger.error(
            `interrupting lost runs of runner ${runnerId} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
          );
        });
      }, LOST_RUN_GRACE_MS);
      timer.unref();
      this.graceTimers.set(runnerId, timer);
    }
    await this.dispatcher.dispatch(runnerId);
  }
}
