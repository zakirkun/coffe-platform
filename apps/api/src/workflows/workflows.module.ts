import { Module } from '@nestjs/common';
import { RunsModule } from '../runs/runs.module.js';
import { TicketsModule } from '../tickets/tickets.module.js';
import { OrchestratorService } from './orchestrator.service.js';
import { WorkflowsController } from './workflows.controller.js';
import { WorkflowsService } from './workflows.service.js';

@Module({
  imports: [RunsModule, TicketsModule],
  controllers: [WorkflowsController],
  providers: [WorkflowsService, OrchestratorService],
})
export class WorkflowsModule {}
