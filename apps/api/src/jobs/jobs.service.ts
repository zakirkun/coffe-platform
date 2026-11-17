import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import type pg from 'pg';
import { PgBoss, type QueueOptions, type SendOptions } from 'pg-boss';
import { PG_POOL } from '../db/db.module.js';

/** Queue names (architecture §6.4). */
export const RUN_DISPATCH_QUEUE = 'run.dispatch';
export const RUNNER_SWEEP_QUEUE = 'runner.sweep';

/** pg-boss instance sharing the application's node-postgres pool. */
@Injectable()
export class JobsService implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger(JobsService.name);
  private readonly boss: PgBoss;
  private starting: Promise<void> | null = null;

  constructor(@Inject(PG_POOL) pool: pg.Pool) {
    this.boss = new PgBoss({
      db: { executeSql: (text, values) => pool.query(text, values) },
    });
    this.boss.on('error', (error) => this.logger.error(error.stack ?? error.message));
  }

  async onModuleInit(): Promise<void> {
    await this.start();
  }

  /** Before the pool closes: stop polling and give running handlers a moment to finish. */
  async beforeApplicationShutdown(): Promise<void> {
    if (!this.starting) return;
    await this.starting.catch(() => undefined);
    await this.boss.stop({ close: false, graceful: true, timeout: 5_000 });
  }

  /** Creates the queue when missing and starts a worker; a thrown error fails (retries) the job. */
  async work<T extends object>(
    queue: string,
    options: QueueOptions,
    handler: (data: T) => Promise<void>,
  ): Promise<void> {
    await this.start();
    await this.boss.createQueue(queue, options);
    await this.boss.work<T>(queue, async (jobs) => {
      for (const job of jobs) await handler(job.data);
    });
  }

  /** Recurring job; the queue must have been registered with `work()` first. */
  async schedule(queue: string, cron: string): Promise<void> {
    await this.start();
    await this.boss.schedule(queue, cron);
  }

  async send(queue: string, data: object, options?: SendOptions): Promise<void> {
    await this.start();
    await this.boss.send(queue, data, options);
  }

  /** Idempotent, so consumers can register queues from their own init hooks in any order. */
  private start(): Promise<void> {
    this.starting ??= this.boss.start().then(() => undefined);
    return this.starting;
  }
}
