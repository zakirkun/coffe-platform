import type { WorkspaceRole } from '@coffe/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { DB } from '../db/db.module.js';
import { member } from '../db/schema/index.js';
import { normalizeRole } from './request-context.js';

@Injectable()
export class MembershipService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** The user's role in the workspace, or `null` when they are not a member. */
  async roleOf(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
    const [row] = await this.db
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, workspaceId), eq(member.userId, userId)))
      .limit(1);
    return row ? normalizeRole(row.role) : null;
  }
}
