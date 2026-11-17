import { PricingTable, UsageQuery, type UsageReport } from '@coffe/contracts';
import { Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { Audit } from '../audit/audit.interceptor.js';
import { CurrentWorkspace, RequirePermission } from '../auth/decorators.js';
import type { WorkspaceContext } from '../auth/request-context.js';
import { WorkspaceGuard } from '../auth/workspace.guard.js';
import { UsageService } from './usage.service.js';

@Controller('workspaces/:ws')
@UseGuards(WorkspaceGuard)
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get('usage')
  report(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Query({ schema: UsageQuery }) query: z.output<typeof UsageQuery>,
  ): Promise<UsageReport> {
    return this.usage.report(workspace.id, query);
  }

  @Get('pricing')
  pricing(@CurrentWorkspace() workspace: WorkspaceContext): Promise<PricingTable> {
    return this.usage.pricing(workspace.id);
  }

  @Put('pricing')
  @RequirePermission({ project: ['update'] })
  @Audit('pricing.update', 'workspace')
  setPricing(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Body({ schema: PricingTable }) body: z.output<typeof PricingTable>,
  ): Promise<PricingTable> {
    return this.usage.setPricing(workspace.id, body);
  }
}
