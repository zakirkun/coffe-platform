import { Module } from '@nestjs/common';
import { RunnerGateway } from './runner.gateway.js';
import { RunnerHub } from './runner-hub.js';
import { RunnerRegistry } from './runner-registry.js';
import { RunnerSweep } from './runner-sweep.js';
import { RunnersController } from './runners.controller.js';

@Module({
  controllers: [RunnersController],
  providers: [RunnerRegistry, RunnerHub, RunnerGateway, RunnerSweep],
  exports: [RunnerRegistry, RunnerHub],
})
export class RunnersModule {}
