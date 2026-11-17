import {
  ApproveRequest,
  type ApproveResponse,
  type Diff,
  type FileContentResponse,
  FileQuery,
  RequestChangesRequest,
  type RequestChangesResponse,
  type ReviewState,
  Uuid,
} from '@coffe/contracts';
import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { Audit } from '../audit/audit.interceptor.js';
import { CurrentUser, CurrentWorkspace, RequirePermission } from '../auth/decorators.js';
import type { AuthUser, WorkspaceContext } from '../auth/request-context.js';
import { WorkspaceGuard } from '../auth/workspace.guard.js';
import { ReviewService } from './review.service.js';

@Controller('workspaces/:ws/tickets/:ticketId')
@UseGuards(WorkspaceGuard)
export class ReviewController {
  constructor(private readonly review: ReviewService) {}

  @Get('review')
  state(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('ticketId', { schema: Uuid }) ticketId: string,
  ): Promise<ReviewState> {
    return this.review.state(workspace.id, ticketId);
  }

  @Get('diff')
  diff(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('ticketId', { schema: Uuid }) ticketId: string,
  ): Promise<Diff> {
    return this.review.diff(workspace.id, ticketId);
  }

  @Post('diff/refresh')
  @HttpCode(200)
  @Audit('review.refresh_diff', 'ticket', 'ticketId')
  refreshDiff(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentUser() user: AuthUser,
    @Param('ticketId', { schema: Uuid }) ticketId: string,
  ): Promise<Diff> {
    return this.review.refreshDiff(workspace.id, user.id, ticketId);
  }

  @Get('file')
  file(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentUser() user: AuthUser,
    @Param('ticketId', { schema: Uuid }) ticketId: string,
    @Query({ schema: FileQuery }) query: z.output<typeof FileQuery>,
  ): Promise<FileContentResponse> {
    return this.review.file(workspace.id, user.id, ticketId, query.rev, query.path);
  }

  @Post('approve')
  @HttpCode(200)
  @RequirePermission({ review: ['decide'] })
  @Audit('review.approve', 'ticket', 'ticketId')
  approve(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentUser() user: AuthUser,
    @Param('ticketId', { schema: Uuid }) ticketId: string,
    @Body({ schema: ApproveRequest }) body: z.output<typeof ApproveRequest>,
  ): Promise<ApproveResponse> {
    return this.review.approve(workspace.id, user.id, ticketId, body.body);
  }

  @Post('request-changes')
  @HttpCode(200)
  @RequirePermission({ review: ['decide'] })
  @Audit('review.request_changes', 'ticket', 'ticketId')
  requestChanges(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentUser() user: AuthUser,
    @Param('ticketId', { schema: Uuid }) ticketId: string,
    @Body({ schema: RequestChangesRequest }) body: RequestChangesRequest,
  ): Promise<RequestChangesResponse> {
    return this.review.requestChanges(workspace.id, user.id, ticketId, body.body);
  }
}
