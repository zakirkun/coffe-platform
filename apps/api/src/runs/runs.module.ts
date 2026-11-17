import { Module } from '@nestjs/common';
import { ContextModule } from '../context/context.module.js';
import { RunnersModule } from '../runners/runners.module.js';
import { TicketsModule } from '../tickets/tickets.module.js';
import { RunDispatcher } from './run-dispatcher.js';
import { RunIngest } from './run-ingest.js';
import { RunRecovery } from './run-recovery.js';
import { RunScheduler } from './run-scheduler.js';
import { RunStore } from './run-store.js';
import { RunsController } from './runs.controller.js';
import { RunsService } from './runs.service.js';

@Module({
  imports: [RunnersModule, TicketsModule, ContextModule],
  controllers: [RunsController],
  providers: [RunStore, RunDispatcher, RunRecovery, RunIngest, RunScheduler, RunsService],
  exports: [RunStore, RunDispatcher, RunsService],
})
export class RunsModule {}
