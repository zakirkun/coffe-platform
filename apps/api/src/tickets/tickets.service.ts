import type {
  CreateTicketRequest,
  MoveTicketRequest,
  Ticket,
  TicketFlags,
  TicketStatus,
  UpdateTicketRequest,
} from '@coffe/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { generateKeyBetween } from 'fractional-indexing';
import { ApiException } from '../common/api-error.js';
import type { Database } from '../db/client.js';
import { DB, type DbExecutor } from '../db/db.module.js';
import {
  personas,
  projectRepos,
  projects,
  runs,
  type TicketFlags as StoredTicketFlags,
  ticketDependencies,
  tickets,
} from '../db/schema/index.js';
import { RealtimeService } from '../realtime/realtime.service.js';

export type TicketRow = typeof tickets.$inferSelect;
type LatestRun = NonNullable<Ticket['latestRun']>;
type Blocker = Ticket['blockedBy'][number];

export interface TicketChange {
  status?: TicketStatus;
  /** Merged into the stored flags. */
  flags?: TicketFlags;
  /** Where the ticket's branch lives, set when its first run is created. */
  worktree?: Pick<TicketRow, 'branch' | 'baseBranch' | 'worktreeRunnerId' | 'repoId'>;
}

/**
 * Fractional-index keys order by character code; the database collation would order them
 * differently, so every comparison of positions in SQL uses the "C" collation.
 */
const POSITION_ORDER = sql`${tickets.position} collate "C"`;

function toStoredFlags(flags: TicketFlags): StoredTicketFlags {
  const stored: StoredTicketFlags = {};
  if (flags.failed !== undefined) stored.failed = flags.failed;
  if (flags.mergeConflict !== undefined) stored.merge_conflict = flags.mergeConflict;
  return stored;
}

/** Tickets of a project: CRUD, board ordering and the automated status transitions (§11.2). */
@Injectable()
export class TicketsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly realtime: RealtimeService,
  ) {}

  async list(workspaceId: string, projectId: string): Promise<Ticket[]> {
    const [project] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
      .limit(1);
    if (!project) throw ApiException.notFound('Project');
    const rows = await this.db
      .select()
      .from(tickets)
      .where(eq(tickets.projectId, projectId))
      .orderBy(POSITION_ORDER, asc(tickets.number));
    return this.toDtos(rows);
  }

  async get(workspaceId: string, ticketId: string): Promise<Ticket> {
    return this.toDto(await this.getRow(workspaceId, ticketId));
  }

  /** The ticket when it belongs to the workspace; 404 otherwise. */
  async getRow(
    workspaceId: string,
    ticketId: string,
    executor: DbExecutor = this.db,
  ): Promise<TicketRow> {
    const [row] = await executor
      .select({ ticket: tickets })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .where(and(eq(tickets.id, ticketId), eq(projects.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw ApiException.notFound('Ticket');
    return row.ticket;
  }

  async create(
    workspaceId: string,
    projectId: string,
    userId: string,
    body: CreateTicketRequest,
  ): Promise<Ticket> {
    const row = await this.db.transaction(async (tx) => {
      // The row lock taken here also serializes position assignment within the project.
      const [project] = await tx
        .update(projects)
        .set({ ticketSeq: sql`${projects.ticketSeq} + 1` })
        .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
        .returning({ key: projects.key, number: projects.ticketSeq });
      if (!project) throw ApiException.notFound('Project');
      if (body.repoId !== undefined) await this.assertRepoBound(tx, projectId, body.repoId);
      if (body.assigneePersonaId) {
        await this.assertPersona(tx, workspaceId, projectId, body.assigneePersonaId);
      }

      const status = body.status ?? 'backlog';
      const column = await this.column(tx, projectId, status);
      const [created] = await tx
        .insert(tickets)
        .values({
          projectId,
          number: project.number,
          key: `${project.key}-${project.number}`,
          title: body.title,
          description: body.description,
          acceptanceCriteria: body.acceptanceCriteria,
          status,
          position: generateKeyBetween(column.at(-1)?.position ?? null, null),
          priority: body.priority ?? 2,
          labels: body.labels ?? [],
          assigneePersonaId: body.assigneePersonaId ?? null,
          repoId: body.repoId ?? null,
          createdBy: userId,
        })
        .returning();
      if (!created) throw new Error('ticket insert returned no row');
      return created;
    });
    return this.publish(row);
  }

  async update(workspaceId: string, ticketId: string, body: UpdateTicketRequest): Promise<Ticket> {
    const current = await this.getRow(workspaceId, ticketId);
    if (body.repoId) await this.assertRepoBound(this.db, current.projectId, body.repoId);
    if (body.assigneePersonaId) {
      await this.assertPersona(this.db, workspaceId, current.projectId, body.assigneePersonaId);
    }
    const patch: Partial<typeof tickets.$inferInsert> = {};
    if (body.title !== undefined) patch.title = body.title;
    if (body.description !== undefined) patch.description = body.description;
    if (body.acceptanceCriteria !== undefined) patch.acceptanceCriteria = body.acceptanceCriteria;
    if (body.priority !== undefined) patch.priority = body.priority;
    if (body.labels !== undefined) patch.labels = body.labels;
    if (body.assigneePersonaId !== undefined) patch.assigneePersonaId = body.assigneePersonaId;
    if (body.repoId !== undefined) patch.repoId = body.repoId;
    if (Object.keys(patch).length === 0) return this.toDto(current);

    const [updated] = await this.db
      .update(tickets)
      .set(patch)
      .where(eq(tickets.id, ticketId))
      .returning();
    if (!updated) throw ApiException.notFound('Ticket');
    return this.publish(updated);
  }

  /**
   * Changes column and/or order. The ticket lands directly below `afterId`, else directly above
   * `beforeId`, else at the end of the target column.
   */
  async move(workspaceId: string, ticketId: string, body: MoveTicketRequest): Promise<Ticket> {
    const row = await this.db.transaction(async (tx) => {
      const current = await this.getRow(workspaceId, ticketId, tx);
      // Serializes position assignment within the project (see `create`).
      await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, current.projectId))
        .for('update');
      const column = (await this.column(tx, current.projectId, body.status)).filter(
        (ticket) => ticket.id !== ticketId,
      );
      const indexOf = (neighbourId: string): number => {
        const index = column.findIndex((ticket) => ticket.id === neighbourId);
        if (index < 0) {
          throw ApiException.conflict(
            'stale_position',
            'A neighbouring ticket is no longer in that column; reload the board',
          );
        }
        return index;
      };
      let above = column.length - 1;
      if (body.afterId) above = indexOf(body.afterId);
      else if (body.beforeId) above = indexOf(body.beforeId) - 1;

      const [moved] = await tx
        .update(tickets)
        .set({
          status: body.status,
          position: generateKeyBetween(
            column[above]?.position ?? null,
            column[above + 1]?.position ?? null,
          ),
        })
        .where(eq(tickets.id, ticketId))
        .returning();
      if (!moved) throw ApiException.notFound('Ticket');
      return moved;
    });
    return this.publish(row);
  }

  /**
   * Automated transition (architecture §11.2): sets the status, merges `flagsPatch` into the
   * stored flags and pushes `ticket.updated` to the project and ticket channels.
   */
  async setStatus(
    ticketId: string,
    status: TicketStatus,
    flagsPatch: TicketFlags = {},
  ): Promise<Ticket> {
    await this.apply(this.db, ticketId, { status, flags: flagsPatch });
    const ticket = await this.publishUpdated(ticketId);
    if (!ticket) throw ApiException.notFound('Ticket');
    return ticket;
  }

  /**
   * Changes a ticket without the push, for callers that work inside their own transaction; they
   * call `publishUpdated` after the commit.
   */
  async apply(executor: DbExecutor, ticketId: string, change: TicketChange): Promise<void> {
    await executor
      .update(tickets)
      .set({
        ...change.worktree,
        ...(change.status ? { status: change.status } : {}),
        flags: sql`${tickets.flags} || ${JSON.stringify(toStoredFlags(change.flags ?? {}))}::jsonb`,
      })
      .where(eq(tickets.id, ticketId));
  }

  /** Pushes the current state of a ticket (also after its latest run changed). */
  async publishUpdated(ticketId: string): Promise<Ticket | null> {
    const [row] = await this.db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1);
    return row ? this.publish(row) : null;
  }

  async toDto(row: TicketRow): Promise<Ticket> {
    const [ticket] = await this.toDtos([row]);
    if (!ticket) throw new Error('ticket mapping returned no row');
    return ticket;
  }

  /** The dependencies of each ticket that are not Done yet, by ticket id. */
  async openDependencies(ticketIds: string[]): Promise<Map<string, Blocker[]>> {
    const byTicket = new Map<string, Blocker[]>();
    if (ticketIds.length === 0) return byTicket;
    const rows = await this.db
      .select({ ticketId: ticketDependencies.ticketId, id: tickets.id, key: tickets.key, status: tickets.status })
      .from(ticketDependencies)
      .innerJoin(tickets, eq(tickets.id, ticketDependencies.dependsOnId))
      .where(and(inArray(ticketDependencies.ticketId, ticketIds), ne(tickets.status, 'done')))
      .orderBy(asc(tickets.number));
    for (const { ticketId, ...blocker } of rows) byTicket.set(ticketId, [...(byTicket.get(ticketId) ?? []), blocker]);
    return byTicket;
  }

  /**
   * Pushes `ticket.updated` for the ticket and for the tickets depending on it (their `blockedBy`
   * shows this ticket's status).
   */
  private async publish(row: TicketRow): Promise<Ticket> {
    const ticket = await this.toDto(row);
    this.push(ticket);
    const dependents = await this.db
      .select()
      .from(tickets)
      .innerJoin(ticketDependencies, eq(ticketDependencies.ticketId, tickets.id))
      .where(eq(ticketDependencies.dependsOnId, row.id));
    for (const dependent of await this.toDtos(dependents.map((joined) => joined.tickets))) this.push(dependent);
    return ticket;
  }

  private push(ticket: Ticket): void {
    this.realtime.publish(`project:${ticket.projectId}`, { ev: 'ticket.updated', ticket });
    this.realtime.publish(`ticket:${ticket.id}`, { ev: 'ticket.updated', ticket });
  }

  private async toDtos(rows: TicketRow[]): Promise<Ticket[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const latestRuns = await this.db
      .selectDistinctOn([runs.ticketId], {
        ticketId: runs.ticketId,
        id: runs.id,
        status: runs.status,
        cliId: runs.cliId,
        personaId: runs.personaId,
      })
      .from(runs)
      .where(inArray(runs.ticketId, ids))
      .orderBy(runs.ticketId, desc(runs.createdAt), desc(runs.id));
    const latestByTicket = new Map<string, LatestRun>();
    for (const { ticketId, ...run } of latestRuns) {
      if (ticketId) latestByTicket.set(ticketId, run);
    }
    const blockers = await this.openDependencies(ids);

    return rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      number: row.number,
      key: row.key,
      title: row.title,
      description: row.description,
      acceptanceCriteria: row.acceptanceCriteria,
      status: row.status,
      position: row.position,
      priority: row.priority,
      labels: row.labels,
      assigneePersonaId: row.assigneePersonaId,
      branch: row.branch,
      baseBranch: row.baseBranch,
      worktreeRunnerId: row.worktreeRunnerId,
      repoId: row.repoId,
      flags: {
        failed: row.flags.failed === true,
        blocked: blockers.has(row.id),
        mergeConflict: row.flags.merge_conflict === true,
      },
      blockedBy: blockers.get(row.id) ?? [],
      latestRun: latestByTicket.get(row.id) ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  /** Tickets of one board column, top to bottom. */
  private column(
    executor: DbExecutor,
    projectId: string,
    status: TicketStatus,
  ): Promise<{ id: string; position: string }[]> {
    return executor
      .select({ id: tickets.id, position: tickets.position })
      .from(tickets)
      .where(and(eq(tickets.projectId, projectId), eq(tickets.status, status)))
      .orderBy(POSITION_ORDER, asc(tickets.number));
  }

  private async assertRepoBound(
    executor: DbExecutor,
    projectId: string,
    repoId: string,
  ): Promise<void> {
    const [binding] = await executor
      .select({ id: projectRepos.id })
      .from(projectRepos)
      .where(and(eq(projectRepos.projectId, projectId), eq(projectRepos.runnerRepoId, repoId)))
      .limit(1);
    if (!binding) {
      throw ApiException.badRequest('invalid_repo', 'The repository is not bound to this project');
    }
  }

  private async assertPersona(
    executor: DbExecutor,
    workspaceId: string,
    projectId: string,
    personaId: string,
  ): Promise<void> {
    const [persona] = await executor
      .select({ id: personas.id })
      .from(personas)
      .where(
        and(
          eq(personas.id, personaId),
          eq(personas.workspaceId, workspaceId),
          or(isNull(personas.projectId), eq(personas.projectId, projectId)),
        ),
      )
      .limit(1);
    if (!persona) {
      throw ApiException.badRequest('invalid_persona', 'The persona does not belong to this project');
    }
  }
}
