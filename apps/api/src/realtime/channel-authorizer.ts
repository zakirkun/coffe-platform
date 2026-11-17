import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { validate as isUuid } from 'uuid';
import { MembershipService } from '../auth/membership.service.js';
import type { Database } from '../db/client.js';
import { DB } from '../db/db.module.js';
import { projects, runs, tickets } from '../db/schema/index.js';

/** Channel authorization: the subscriber must be a member of the channel's workspace. */
@Injectable()
export class ChannelAuthorizer {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly memberships: MembershipService,
  ) {}

  async canSubscribe(userId: string, channel: string): Promise<boolean> {
    const workspaceId = await this.workspaceOf(channel);
    if (workspaceId === null) return false;
    return (await this.memberships.roleOf(userId, workspaceId)) !== null;
  }

  private async workspaceOf(channel: string): Promise<string | null> {
    const separator = channel.indexOf(':');
    const kind = channel.slice(0, separator);
    const id = channel.slice(separator + 1);
    if (kind === 'workspace') return id;
    if (!isUuid(id)) return null;

    if (kind === 'project') {
      const [row] = await this.db
        .select({ workspaceId: projects.workspaceId })
        .from(projects)
        .where(eq(projects.id, id))
        .limit(1);
      return row?.workspaceId ?? null;
    }
    if (kind === 'ticket') {
      const [row] = await this.db
        .select({ workspaceId: projects.workspaceId })
        .from(tickets)
        .innerJoin(projects, eq(projects.id, tickets.projectId))
        .where(eq(tickets.id, id))
        .limit(1);
      return row?.workspaceId ?? null;
    }
    if (kind === 'run') {
      const [row] = await this.db
        .select({ workspaceId: runs.workspaceId })
        .from(runs)
        .where(eq(runs.id, id))
        .limit(1);
      return row?.workspaceId ?? null;
    }
    return null;
  }
}
