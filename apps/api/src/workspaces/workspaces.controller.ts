import type { Member, MeResponse } from '@coffe/contracts';
import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { AuthSession } from '../auth/auth.js';
import { CurrentSession, CurrentWorkspace } from '../auth/decorators.js';
import { normalizeRole, type WorkspaceContext } from '../auth/request-context.js';
import { WorkspaceGuard } from '../auth/workspace.guard.js';
import type { Database } from '../db/client.js';
import { DB } from '../db/db.module.js';
import { member, organization, user } from '../db/schema/index.js';

@Controller()
export class WorkspacesController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Get('me')
  async me(@CurrentSession() session: AuthSession): Promise<MeResponse> {
    const rows = await this.db
      .select({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        role: member.role,
      })
      .from(member)
      .innerJoin(organization, eq(organization.id, member.organizationId))
      .where(eq(member.userId, session.user.id))
      .orderBy(asc(organization.name));
    const workspaces = rows.map((row) => ({ ...row, role: normalizeRole(row.role) }));
    const active = session.session.activeOrganizationId;
    return {
      user: session.user,
      workspaces,
      activeWorkspaceId: workspaces.some((workspace) => workspace.id === active) ? active : null,
    };
  }

  @Get('workspaces/:ws/members')
  @UseGuards(WorkspaceGuard)
  async members(@CurrentWorkspace() workspace: WorkspaceContext): Promise<Member[]> {
    const rows = await this.db
      .select({
        id: member.id,
        userId: member.userId,
        name: user.name,
        email: user.email,
        role: member.role,
        createdAt: member.createdAt,
      })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, workspace.id))
      .orderBy(asc(member.createdAt));
    return rows.map((row) => ({
      ...row,
      role: normalizeRole(row.role),
      createdAt: row.createdAt.toISOString(),
    }));
  }
}
