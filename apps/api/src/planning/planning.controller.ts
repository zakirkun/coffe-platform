import {
  ApproveRequirementRequest,
  CreateRequirementRequest,
  PlanRequirementRequest,
  type Requirement,
  type Ticket,
  type TicketDraft,
  UpdateDraftRequest,
  UpsertDraftRequest,
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
  UseGuards,
} from '@nestjs/common';
import { Audit } from '../audit/audit.interceptor.js';
import { CurrentUser, CurrentWorkspace, RequirePermission } from '../auth/decorators.js';
import type { AuthUser, WorkspaceContext } from '../auth/request-context.js';
import { WorkspaceGuard } from '../auth/workspace.guard.js';
import { PlanningService } from './planning.service.js';

@Controller('workspaces/:ws')
@UseGuards(WorkspaceGuard)
export class PlanningController {
  constructor(private readonly planning: PlanningService) {}

  @Get('projects/:projectId/requirements')
  list(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('projectId', { schema: Uuid }) projectId: string,
  ): Promise<Requirement[]> {
    return this.planning.list(workspace.id, projectId);
  }

  @Post('projects/:projectId/requirements')
  @RequirePermission({ ticket: ['create'] })
  @Audit('requirement.create', 'project', 'projectId')
  create(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentUser() user: AuthUser,
    @Param('projectId', { schema: Uuid }) projectId: string,
    @Body({ schema: CreateRequirementRequest }) body: CreateRequirementRequest,
  ): Promise<Requirement> {
    return this.planning.create(workspace.id, user.id, projectId, body);
  }

  @Get('requirements/:requirementId')
  get(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('requirementId', { schema: Uuid }) requirementId: string,
  ): Promise<Requirement> {
    return this.planning.get(workspace.id, requirementId);
  }

  @Post('requirements/:requirementId/plan')
  @HttpCode(200)
  @RequirePermission({ ticket: ['run'] })
  @Audit('requirement.plan', 'requirement', 'requirementId')
  plan(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentUser() user: AuthUser,
    @Param('requirementId', { schema: Uuid }) requirementId: string,
    @Body({ schema: PlanRequirementRequest }) body: PlanRequirementRequest,
  ): Promise<Requirement> {
    return this.planning.plan(workspace.id, user.id, requirementId, body);
  }

  @Post('requirements/:requirementId/drafts')
  @RequirePermission({ ticket: ['create'] })
  addDraft(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('requirementId', { schema: Uuid }) requirementId: string,
    @Body({ schema: UpsertDraftRequest }) body: UpsertDraftRequest,
  ): Promise<TicketDraft> {
    return this.planning.addDraft(workspace.id, requirementId, body);
  }

  @Patch('requirements/:requirementId/drafts/:draftId')
  @RequirePermission({ ticket: ['create'] })
  updateDraft(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('requirementId', { schema: Uuid }) requirementId: string,
    @Param('draftId', { schema: Uuid }) draftId: string,
    @Body({ schema: UpdateDraftRequest }) body: UpdateDraftRequest,
  ): Promise<TicketDraft> {
    return this.planning.updateDraft(workspace.id, requirementId, draftId, body);
  }

  @Delete('requirements/:requirementId/drafts/:draftId')
  @HttpCode(204)
  @RequirePermission({ ticket: ['create'] })
  async discardDraft(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('requirementId', { schema: Uuid }) requirementId: string,
    @Param('draftId', { schema: Uuid }) draftId: string,
  ): Promise<void> {
    await this.planning.discardDraft(workspace.id, requirementId, draftId);
  }

  /** Audited inside the service with the created ticket keys. */
  @Post('requirements/:requirementId/approve')
  @HttpCode(200)
  @RequirePermission({ ticket: ['create'] })
  approve(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentUser() user: AuthUser,
    @Param('requirementId', { schema: Uuid }) requirementId: string,
    @Body({ schema: ApproveRequirementRequest }) body: ApproveRequirementRequest,
  ): Promise<Ticket[]> {
    return this.planning.approve(workspace.id, user.id, requirementId, body);
  }
}
