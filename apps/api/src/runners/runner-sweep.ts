import { CLOSE_CODES } from '@coffe/protocol';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { JobsService, RUNNER_SWEEP_QUEUE } from '../jobs/jobs.service.js';
import { RunnerHub } from './runner-hub.js';
import { RunnerRegistry } from './runner-registry.js';

const EVERY_MINUTE = '* * * * *';

/**
 * `runner.sweep` (architecture §6.4, §8.6): once a minute, runners without traffic for 60 s go
 * offline and pairing tokens past their retention are deleted.
 */
@Injectable()
export class RunnerSweep implements OnModuleInit {
  constructor(
    private readonly jobs: JobsService,
    private readonly registry: RunnerRegistry,
    private readonly hub: RunnerHub,
  ) {}

  async onModuleInit(): Promise<void> {
    // A missed sweep is simply caught up by the next one, so jobs are neither retried nor kept.
    await this.jobs.work(
      RUNNER_SWEEP_QUEUE,
      { retryLimit: 0, expireInSeconds: 60, retentionSeconds: 120, deleteAfterSeconds: 3600 },
      () => this.sweep(new Date()),
    );
    await this.jobs.schedule(RUNNER_SWEEP_QUEUE, EVERY_MINUTE);
  }

  async sweep(now: Date): Promise<void> {
    for (const runnerId of await this.registry.markStaleOffline(now)) {
      // A socket that is still open but silent is dead weight; the runner reconnects if alive.
      this.hub.disconnect(runnerId, CLOSE_CODES.GOING_AWAY, 'no traffic for 60 s');
      await this.registry.publishStatus(runnerId);
    }
    await this.registry.deleteOldPairingTokens(now);
  }
}
