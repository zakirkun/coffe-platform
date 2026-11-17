import { type AuditPage, AuditQuery } from '@coffe/contracts';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentWorkspace } from '../auth/decorators.js';
import type { WorkspaceContext } from '../auth/request-context.js';
import { WorkspaceGuard } from '../auth/workspace.guard.js';
import { AuditService } from './audit.service.js';

@Controller('workspaces/:ws/audit')
@UseGuards(WorkspaceGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Query({ schema: AuditQuery }) query: AuditQuery,
  ): Promise<AuditPage> {
    return this.audit.list(workspace.id, query);
  }
}
