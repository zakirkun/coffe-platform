import {
  CreateTicketRequest,
  MoveTicketRequest,
  type Ticket,
  UpdateTicketRequest,
  Uuid,
} from '@coffe/contracts';
import { Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Audit } from '../audit/audit.interceptor.js';
import { CurrentUser, CurrentWorkspace, RequirePermission } from '../auth/decorators.js';
import type { AuthUser, WorkspaceContext } from '../auth/request-context.js';
import { WorkspaceGuard } from '../auth/workspace.guard.js';
import { TicketsService } from './tickets.service.js';

@Controller('workspaces/:ws')
@UseGuards(WorkspaceGuard)
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get('projects/:projectId/tickets')
  list(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('projectId', { schema: Uuid }) projectId: string,
  ): Promise<Ticket[]> {
    return this.tickets.list(workspace.id, projectId);
  }

  @Post('projects/:projectId/tickets')
  @RequirePermission({ ticket: ['create'] })
  @Audit('ticket.create', 'ticket')
  create(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentUser() user: AuthUser,
    @Param('projectId', { schema: Uuid }) projectId: string,
    @Body({ schema: CreateTicketRequest }) body: CreateTicketRequest,
  ): Promise<Ticket> {
    return this.tickets.create(workspace.id, projectId, user.id, body);
  }

  @Get('tickets/:ticketId')
  get(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('ticketId', { schema: Uuid }) ticketId: string,
  ): Promise<Ticket> {
    return this.tickets.get(workspace.id, ticketId);
  }

  @Patch('tickets/:ticketId')
  @RequirePermission({ ticket: ['update'] })
  @Audit('ticket.update', 'ticket', 'ticketId')
  update(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('ticketId', { schema: Uuid }) ticketId: string,
    @Body({ schema: UpdateTicketRequest }) body: UpdateTicketRequest,
  ): Promise<Ticket> {
    return this.tickets.update(workspace.id, ticketId, body);
  }

  @Post('tickets/:ticketId/move')
  @HttpCode(200)
  @RequirePermission({ ticket: ['update'] })
  @Audit('ticket.move', 'ticket', 'ticketId')
  move(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('ticketId', { schema: Uuid }) ticketId: string,
    @Body({ schema: MoveTicketRequest }) body: MoveTicketRequest,
  ): Promise<Ticket> {
    return this.tickets.move(workspace.id, ticketId, body);
  }
}
