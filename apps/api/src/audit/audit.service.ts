import type { AuditLogEntry, AuditPage, AuditQuery } from '@coffe/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lt, type SQL } from 'drizzle-orm';
import { validate as isUuid } from 'uuid';
import type { Database } from '../db/client.js';
import { DB, type DbExecutor } from '../db/db.module.js';
import { type AUDIT_ACTOR_TYPES, auditLogs, user } from '../db/schema/index.js';

export interface AuditEntry {
  workspaceId: string | null;
  actorType: (typeof AUDIT_ACTOR_TYPES)[number];
  action: string;
  actorUserId?: string | null;
  runnerId?: string | null;
  personaId?: string | null;
  runId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  /** Command sent to a runner or executed by an agent. */
  command?: string | null;
  details?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

/** Append-only audit log (architecture §6.5). */
@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Pass `executor` to write inside an open transaction. */
  async record(entry: AuditEntry, executor: DbExecutor = this.db): Promise<void> {
    await executor.insert(auditLogs).values({
      workspaceId: entry.workspaceId,
      actorType: entry.actorType,
      actorUserId: entry.actorUserId ?? null,
      runnerId: entry.runnerId ?? null,
      personaId: entry.personaId ?? null,
      runId: entry.runId ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      command: entry.command ?? null,
      details: entry.details ?? {},
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
    });
  }

  /** Newest first; the cursor is the id of the last row of the previous page. */
  async list(workspaceId: string, query: AuditQuery): Promise<AuditPage> {
    const cursor = query.cursor === undefined ? null : Number(query.cursor);
    const filters: SQL[] = [eq(auditLogs.workspaceId, workspaceId)];
    if (cursor !== null) {
      if (!Number.isSafeInteger(cursor) || cursor < 1) return { items: [], nextCursor: null };
      filters.push(lt(auditLogs.id, cursor));
    }
    if (query.runId !== undefined) {
      if (!isUuid(query.runId)) return { items: [], nextCursor: null };
      filters.push(eq(auditLogs.runId, query.runId));
    }
    if (query.action !== undefined) filters.push(eq(auditLogs.action, query.action));

    const rows = await this.db
      .select({ log: auditLogs, actorName: user.name })
      .from(auditLogs)
      .leftJoin(user, eq(user.id, auditLogs.actorUserId))
      .where(and(...filters))
      .orderBy(desc(auditLogs.id))
      .limit(query.limit + 1);

    const page = rows.slice(0, query.limit);
    const items = page.map(
      ({ log, actorName }): AuditLogEntry => ({
        id: log.id,
        ts: log.ts.toISOString(),
        actorType: log.actorType,
        actorUserId: log.actorUserId,
        actorName,
        runnerId: log.runnerId,
        personaId: log.personaId,
        runId: log.runId,
        action: log.action,
        targetType: log.targetType,
        targetId: log.targetId,
        command: log.command,
        details: log.details,
      }),
    );
    const last = page.at(-1);
    return { items, nextCursor: rows.length > query.limit && last ? String(last.log.id) : null };
  }
}
