import {
  type ContextDoc,
  type ContextPreview,
  ContextPreviewQuery,
  CreateContextDocRequest,
  UpdateContextDocRequest,
  Uuid,
} from '@coffe/contracts';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { z } from 'zod';
import { Audit } from '../audit/audit.interceptor.js';
import { CurrentUser, CurrentWorkspace, RequirePermission } from '../auth/decorators.js';
import type { AuthUser, WorkspaceContext } from '../auth/request-context.js';
import { WorkspaceGuard } from '../auth/workspace.guard.js';
import { ContextService } from './context.service.js';

@Controller('workspaces/:ws')
@UseGuards(WorkspaceGuard)
export class ContextController {
  constructor(private readonly context: ContextService) {}

  @Get('projects/:projectId/context')
  list(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('projectId', { schema: Uuid }) projectId: string,
  ): Promise<ContextDoc[]> {
    return this.context.list(workspace.id, projectId);
  }

  @Get('projects/:projectId/context/preview')
  preview(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('projectId', { schema: Uuid }) projectId: string,
    @Query({ schema: ContextPreviewQuery }) query: z.output<typeof ContextPreviewQuery>,
  ): Promise<ContextPreview> {
    return this.context.preview(workspace.id, projectId, query.ticketId, query.personaId);
  }

  @Post('projects/:projectId/context')
  @RequirePermission({ project: ['update'] })
  @Audit('context.create', 'project', 'projectId')
  create(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentUser() user: AuthUser,
    @Param('projectId', { schema: Uuid }) projectId: string,
    @Body({ schema: CreateContextDocRequest }) body: CreateContextDocRequest,
  ): Promise<ContextDoc> {
    return this.context.create(workspace.id, user.id, projectId, body);
  }

  @Patch('context/:docId')
  @RequirePermission({ project: ['update'] })
  @Audit('context.update', 'context_doc', 'docId')
  update(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentUser() user: AuthUser,
    @Param('docId', { schema: Uuid }) docId: string,
    @Body({ schema: UpdateContextDocRequest }) body: UpdateContextDocRequest,
  ): Promise<ContextDoc> {
    return this.context.update(workspace.id, user.id, docId, body);
  }

  @Delete('context/:docId')
  @HttpCode(204)
  @RequirePermission({ project: ['update'] })
  @Audit('context.delete', 'context_doc', 'docId')
  async remove(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('docId', { schema: Uuid }) docId: string,
  ): Promise<void> {
    await this.context.remove(workspace.id, docId);
  }
}
