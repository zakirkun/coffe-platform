import { Module } from '@nestjs/common';
import { RunnersModule } from '../runners/runners.module.js';
import { RunsModule } from '../runs/runs.module.js';
import { TicketsModule } from '../tickets/tickets.module.js';
import { ReviewController } from './review.controller.js';
import { ReviewService } from './review.service.js';

@Module({
  imports: [RunnersModule, RunsModule, TicketsModule],
  controllers: [ReviewController],
  providers: [ReviewService],
})
export class ReviewModule {}
