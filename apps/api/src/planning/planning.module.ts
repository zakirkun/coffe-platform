import { Module } from '@nestjs/common';
import { RunsModule } from '../runs/runs.module.js';
import { TicketsModule } from '../tickets/tickets.module.js';
import { PlanningController } from './planning.controller.js';
import { PlanningService } from './planning.service.js';

@Module({
  imports: [RunsModule, TicketsModule],
  controllers: [PlanningController],
  providers: [PlanningService],
})
export class PlanningModule {}
