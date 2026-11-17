import {
  AfterSeqQuery,
  type Run,
  type RunEventsResponse,
  RunInputRequest,
  type RunOutputResponse,
  RunSignalRequest,
  StartRunRequest,
  Uuid,
} from '@coffe/contracts';
import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { Audit } from '../audit/audit.interceptor.js';
import { CurrentUser, CurrentWorkspace, RequirePermission } from '../auth/decorators.js';
import type { AuthUser, WorkspaceContext } from '../auth/request-context.js';
import { WorkspaceGuard } from '../auth/workspace.guard.js';
import { RunsService } from './runs.service.js';

type AfterSeq = z.output<typeof AfterSeqQuery>;

@Controller('workspaces/:ws')
@UseGuards(WorkspaceGuard)
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Get('tickets/:ticketId/runs')
  list(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('ticketId', { schema: Uuid }) ticketId: string,
  ): Promise<Run[]> {
    return this.runs.list(workspace.id, ticketId);
  }

  @Post('tickets/:ticketId/runs')
  @RequirePermission({ ticket: ['run'] })
  @Audit('run.start', 'run')
  start(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentUser() user: AuthUser,
    @Param('ticketId', { schema: Uuid }) ticketId: string,
    @Body({ schema: StartRunRequest }) body: StartRunRequest,
  ): Promise<Run> {
    return this.runs.start(workspace.id, user.id, ticketId, body);
  }

  @Get('runs/:runId')
  get(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('runId', { schema: Uuid }) runId: string,
  ): Promise<Run> {
    return this.runs.get(workspace.id, runId);
  }

  @Get('runs/:runId/output')
  output(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('runId', { schema: Uuid }) runId: string,
    @Query({ schema: AfterSeqQuery }) query: AfterSeq,
  ): Promise<RunOutputResponse> {
    return this.runs.output(workspace.id, runId, query.afterSeq, query.limit);
  }

  @Get('runs/:runId/events')
  events(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('runId', { schema: Uuid }) runId: string,
    @Query({ schema: AfterSeqQuery }) query: AfterSeq,
  ): Promise<RunEventsResponse> {
    return this.runs.events(workspace.id, runId, query.afterSeq, query.limit);
  }

  /** Audited inside the service (`run.input` with the text). */
  @Post('runs/:runId/input')
  @HttpCode(202)
  @RequirePermission({ ticket: ['run'] })
  async input(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentUser() user: AuthUser,
    @Param('runId', { schema: Uuid }) runId: string,
    @Body({ schema: RunInputRequest }) body: RunInputRequest,
  ): Promise<void> {
    await this.runs.input(workspace.id, user.id, runId, body);
  }

  /** Audited inside the service (`run.signal`). */
  @Post('runs/:runId/signal')
  @HttpCode(202)
  @RequirePermission({ ticket: ['run'] })
  async signal(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentUser() user: AuthUser,
    @Param('runId', { schema: Uuid }) runId: string,
    @Body({ schema: RunSignalRequest }) body: RunSignalRequest,
  ): Promise<void> {
    await this.runs.signal(workspace.id, user.id, runId, body);
  }
}
