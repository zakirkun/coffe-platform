import {
  CreateWorkflowRequest,
  StartTicketRequest,
  UpdateWorkflowRequest,
  Uuid,
  type Workflow,
  type WorkflowInstance,
} from '@coffe/contracts';
import { Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Audit } from '../audit/audit.interceptor.js';
import { CurrentUser, CurrentWorkspace, RequirePermission } from '../auth/decorators.js';
import type { AuthUser, WorkspaceContext } from '../auth/request-context.js';
import { WorkspaceGuard } from '../auth/workspace.guard.js';
import { OrchestratorService } from './orchestrator.service.js';
import { WorkflowsService } from './workflows.service.js';

@Controller('workspaces/:ws')
@UseGuards(WorkspaceGuard)
export class WorkflowsController {
  constructor(
    private readonly workflows: WorkflowsService,
    private readonly orchestrator: OrchestratorService,
  ) {}

  @Get('projects/:projectId/workflows')
  list(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('projectId', { schema: Uuid }) projectId: string,
  ): Promise<Workflow[]> {
    return this.workflows.list(workspace.id, projectId);
  }

  @Post('projects/:projectId/workflows')
  @RequirePermission({ project: ['update'] })
  @Audit('workflow.create', 'project', 'projectId')
  create(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('projectId', { schema: Uuid }) projectId: string,
    @Body({ schema: CreateWorkflowRequest }) body: CreateWorkflowRequest,
  ): Promise<Workflow> {
    return this.workflows.create(workspace.id, projectId, body);
  }

  @Patch('workflows/:workflowId')
  @RequirePermission({ project: ['update'] })
  @Audit('workflow.update', 'workflow', 'workflowId')
  update(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('workflowId', { schema: Uuid }) workflowId: string,
    @Body({ schema: UpdateWorkflowRequest }) body: UpdateWorkflowRequest,
  ): Promise<Workflow> {
    return this.workflows.update(workspace.id, workflowId, body);
  }

  /** Audited inside the orchestrator (`workflow.start`). */
  @Post('tickets/:ticketId/start')
  @HttpCode(201)
  @RequirePermission({ ticket: ['run'] })
  start(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentUser() user: AuthUser,
    @Param('ticketId', { schema: Uuid }) ticketId: string,
    @Body({ schema: StartTicketRequest }) body: StartTicketRequest,
  ): Promise<WorkflowInstance> {
    return this.orchestrator.start(workspace.id, user.id, ticketId, body);
  }

  @Get('tickets/:ticketId/workflow')
  current(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('ticketId', { schema: Uuid }) ticketId: string,
  ): Promise<WorkflowInstance> {
    return this.orchestrator.current(workspace.id, ticketId);
  }

  @Post('tickets/:ticketId/workflow/cancel')
  @HttpCode(200)
  @RequirePermission({ ticket: ['run'] })
  @Audit('workflow.cancel', 'ticket', 'ticketId')
  cancel(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentUser() user: AuthUser,
    @Param('ticketId', { schema: Uuid }) ticketId: string,
  ): Promise<WorkflowInstance> {
    return this.orchestrator.cancel(workspace.id, user.id, ticketId);
  }
}
