import {
  type ApproveRequirementRequest,
  type CreateRequirementRequest,
  PlanOutput,
  type PlanRequirementRequest,
  type Requirement,
  type Ticket,
  type TicketDraft,
  type UpdateDraftRequest,
  type UpsertDraftRequest,
} from '@coffe/contracts';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNotNull, isNull, max, ne, or } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { ApiException } from '../common/api-error.js';
import type { Database } from '../db/client.js';
import { DB } from '../db/db.module.js';
import {
  personas,
  projects,
  requirements,
  runs,
  ticketDependencies,
  ticketDrafts,
} from '../db/schema/index.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { type RunRow, RunStore } from '../runs/run-store.js';
import { RunsService } from '../runs/runs.service.js';
import { TicketsService } from '../tickets/tickets.service.js';
import { extractJson } from '../workflows/reports.js';

type RequirementRow = typeof requirements.$inferSelect;
type DraftRow = typeof ticketDrafts.$inferSelect;

function toDraft(row: DraftRow): TicketDraft {
  return {
    id: row.id,
    requirementId: row.requirementId,
    position: row.position,
    title: row.title,
    description: row.description,
    acceptanceCriteria: row.acceptanceCriteria,
    suggestedRole: row.suggestedRole,
    estimate: row.estimate,
    dependsOn: row.dependsOn,
    status: row.status,
    ticketId: row.ticketId,
  };
}

function planningPrompt(requirement: RequirementRow): string {
  return [
    `Plan the work for this requirement: ${requirement.title}`,
    '',
    requirement.body.trim(),
    '',
    'Explore the repository to ground the plan in the real code, then split the work into small, independently reviewable tickets.',
    'Answer with the JSON object described in .coffe/context/00-coffe-rules.md and nothing else.',
  ].join('\n');
}

/** Requirements → planning run → draft tickets → approved Backlog tickets (architecture §12.2). */
@Injectable()
export class PlanningService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(PlanningService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly runs: RunsService,
    private readonly store: RunStore,
    private readonly tickets: TicketsService,
    private readonly realtime: RealtimeService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.store.onEnded((run) => this.onRunEnded(run));
  }

  async list(workspaceId: string, projectId: string): Promise<Requirement[]> {
    await this.assertProject(workspaceId, projectId);
    const rows = await this.db
      .select()
      .from(requirements)
      .where(eq(requirements.projectId, projectId))
      .orderBy(desc(requirements.createdAt));
    return this.toDtos(rows);
  }

  async get(workspaceId: string, requirementId: string): Promise<Requirement> {
    const [dto] = await this.toDtos([await this.getRow(workspaceId, requirementId)]);
    if (!dto) throw ApiException.notFound('Requirement');
    return dto;
  }

  async create(
    workspaceId: string,
    userId: string,
    projectId: string,
    body: CreateRequirementRequest,
  ): Promise<Requirement> {
    await this.assertProject(workspaceId, projectId);
    const [row] = await this.db
      .insert(requirements)
      .values({ projectId, title: body.title.trim(), body: body.body, createdBy: userId })
      .returning();
    if (!row) throw new Error('requirement insert returned no row');
    return this.get(workspaceId, row.id);
  }

  /** Starts a read-only planning run with the planner persona. */
  async plan(
    workspaceId: string,
    userId: string,
    requirementId: string,
    body: PlanRequirementRequest,
  ): Promise<Requirement> {
    const requirement = await this.getRow(workspaceId, requirementId);
    if (requirement.status === 'planning')
      throw ApiException.conflict(
        'planning',
        'A planning run is already working on this requirement',
      );
    if (requirement.status === 'approved')
      throw ApiException.conflict('approved', 'This requirement was already turned into tickets');
    const persona = body.plannerPersonaId
      ? await this.runs.persona(workspaceId, body.plannerPersonaId)
      : await this.defaultPlanner(workspaceId, requirement.projectId);
    const run = await this.runs.createRun({
      workspaceId,
      userId,
      projectId: requirement.projectId,
      ticket: null,
      kind: 'planning',
      prompt: planningPrompt(requirement),
      persona,
      requirementId: requirement.id,
    });
    await this.db
      .update(requirements)
      .set({
        status: 'planning',
        planningRunId: run.id,
        plannerPersonaId: persona?.id ?? null,
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(requirements.id, requirement.id));
    this.publish(requirement);
    return this.get(workspaceId, requirement.id);
  }

  async addDraft(
    workspaceId: string,
    requirementId: string,
    body: UpsertDraftRequest,
  ): Promise<TicketDraft> {
    const requirement = await this.getRow(workspaceId, requirementId);
    const [last] = await this.db
      .select({ position: max(ticketDrafts.position) })
      .from(ticketDrafts)
      .where(eq(ticketDrafts.requirementId, requirement.id));
    const [row] = await this.db
      .insert(ticketDrafts)
      .values({
        requirementId: requirement.id,
        position: body.position ?? (last?.position ?? -1) + 1,
        title: body.title.trim(),
        description: body.description,
        acceptanceCriteria: body.acceptanceCriteria,
        suggestedRole: body.suggestedRole ?? null,
        estimate: body.estimate ?? null,
        dependsOn: body.dependsOn,
      })
      .returning();
    if (!row) throw new Error('draft insert returned no row');
    this.publish(requirement);
    return toDraft(row);
  }

  async updateDraft(
    workspaceId: string,
    requirementId: string,
    draftId: string,
    body: UpdateDraftRequest,
  ): Promise<TicketDraft> {
    const requirement = await this.getRow(workspaceId, requirementId);
    const [row] = await this.db
      .update(ticketDrafts)
      .set({
        ...(body.title !== undefined ? { title: body.title.trim() } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.acceptanceCriteria !== undefined
          ? { acceptanceCriteria: body.acceptanceCriteria }
          : {}),
        ...(body.suggestedRole !== undefined ? { suggestedRole: body.suggestedRole } : {}),
        ...(body.estimate !== undefined ? { estimate: body.estimate } : {}),
        ...(body.dependsOn !== undefined ? { dependsOn: body.dependsOn } : {}),
        ...(body.position !== undefined ? { position: body.position } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(ticketDrafts.id, draftId),
          eq(ticketDrafts.requirementId, requirement.id),
          eq(ticketDrafts.status, 'pending'),
        ),
      )
      .returning();
    if (!row) throw ApiException.notFound('Draft');
    this.publish(requirement);
    return toDraft(row);
  }

  async discardDraft(workspaceId: string, requirementId: string, draftId: string): Promise<void> {
    const requirement = await this.getRow(workspaceId, requirementId);
    const [row] = await this.db
      .update(ticketDrafts)
      .set({ status: 'discarded', updatedAt: new Date() })
      .where(
        and(
          eq(ticketDrafts.id, draftId),
          eq(ticketDrafts.requirementId, requirement.id),
          eq(ticketDrafts.status, 'pending'),
        ),
      )
      .returning();
    if (!row) throw ApiException.notFound('Draft');
    this.publish(requirement);
  }

  /** Turns the chosen pending drafts into Backlog tickets, keeping their order and dependencies. */
  async approve(
    workspaceId: string,
    userId: string,
    requirementId: string,
    body: ApproveRequirementRequest,
  ): Promise<Ticket[]> {
    const requirement = await this.getRow(workspaceId, requirementId);
    const pending = await this.db
      .select()
      .from(ticketDrafts)
      .where(
        and(
          eq(ticketDrafts.requirementId, requirement.id),
          eq(ticketDrafts.status, 'pending'),
          body.draftIds ? inArray(ticketDrafts.id, body.draftIds) : undefined,
        ),
      )
      .orderBy(asc(ticketDrafts.position));
    if (pending.length === 0)
      throw ApiException.conflict('nothing_to_approve', 'There is no pending draft to approve');

    // Dependencies may also point at drafts approved earlier.
    const approvedBefore = await this.db
      .select({ position: ticketDrafts.position, ticketId: ticketDrafts.ticketId })
      .from(ticketDrafts)
      .where(
        and(eq(ticketDrafts.requirementId, requirement.id), eq(ticketDrafts.status, 'approved')),
      );
    const ticketByPosition = new Map<number, string>();
    for (const draft of approvedBefore)
      if (draft.ticketId) ticketByPosition.set(draft.position, draft.ticketId);

    const created: Ticket[] = [];
    for (const draft of pending) {
      const ticket = await this.tickets.create(workspaceId, requirement.projectId, userId, {
        title: draft.title,
        description: draft.description,
        acceptanceCriteria: draft.acceptanceCriteria,
        status: 'backlog',
      });
      ticketByPosition.set(draft.position, ticket.id);
      await this.db
        .update(ticketDrafts)
        .set({ status: 'approved', ticketId: ticket.id, updatedAt: new Date() })
        .where(eq(ticketDrafts.id, draft.id));
      created.push(ticket);
    }
    const dependencies = pending.flatMap((draft) => {
      const ticketId = ticketByPosition.get(draft.position);
      return draft.dependsOn.flatMap((position) => {
        const dependsOnId = ticketByPosition.get(position);
        return ticketId && dependsOnId && dependsOnId !== ticketId
          ? [{ ticketId, dependsOnId }]
          : [];
      });
    });
    // The tickets were published before their dependencies existed; push them again with blockers.
    const refreshed = new Map<string, Ticket>();
    if (dependencies.length > 0) {
      await this.db.insert(ticketDependencies).values(dependencies).onConflictDoNothing();
      for (const ticketId of new Set(dependencies.map((dependency) => dependency.ticketId))) {
        const ticket = await this.tickets.publishUpdated(ticketId);
        if (ticket) refreshed.set(ticketId, ticket);
      }
    }

    const [remaining] = await this.db
      .select({ id: ticketDrafts.id })
      .from(ticketDrafts)
      .where(
        and(eq(ticketDrafts.requirementId, requirement.id), eq(ticketDrafts.status, 'pending')),
      )
      .limit(1);
    if (!remaining) {
      await this.db
        .update(requirements)
        .set({ status: 'approved', updatedAt: new Date() })
        .where(eq(requirements.id, requirement.id));
    }
    await this.audit.record({
      workspaceId,
      actorType: 'user',
      actorUserId: userId,
      action: 'requirement.approve',
      targetType: 'requirement',
      targetId: requirement.id,
      details: { tickets: created.map((ticket) => ticket.key) },
    });
    this.publish(requirement);
    return created.map((ticket) => refreshed.get(ticket.id) ?? ticket);
  }

  /** Planning runs that ended while the API was down are turned into drafts on start. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const waiting = await this.db
        .select({ run: runs })
        .from(requirements)
        .innerJoin(runs, eq(runs.id, requirements.planningRunId))
        .where(and(eq(requirements.status, 'planning'), isNotNull(runs.endedAt)));
      for (const { run } of waiting) await this.onRunEnded(run);
    } catch (error) {
      this.logger.error(`resuming interrupted planning runs failed: ${String(error)}`);
    }
  }

  /** Turns the planner's answer into drafts, or records why it could not (once per planning run). */
  async onRunEnded(run: RunRow): Promise<void> {
    if (run.kind !== 'planning' || !run.requirementId) return;
    const [requirement] = await this.db
      .select()
      .from(requirements)
      .where(eq(requirements.id, run.requirementId))
      .limit(1);
    if (!requirement || requirement.planningRunId !== run.id || requirement.status !== 'planning')
      return;

    let error: string | null = null;
    let plan: PlanOutput | null = null;
    if (run.status !== 'completed') {
      error = `The planning run ${run.status}${run.error ? `: ${run.error}` : ''}`;
    } else {
      const parsed = PlanOutput.safeParse(extractJson(run.resultSummary));
      if (parsed.success) plan = parsed.data;
      else
        error = `The planner's answer does not match the plan schema: ${parsed.error.issues[0]?.message ?? 'invalid JSON'}`;
    }

    await this.db.transaction(async (tx) => {
      if (plan) {
        // A new plan replaces the drafts nobody approved yet.
        await tx
          .delete(ticketDrafts)
          .where(
            and(
              eq(ticketDrafts.requirementId, requirement.id),
              ne(ticketDrafts.status, 'approved'),
            ),
          );
        const [last] = await tx
          .select({ position: max(ticketDrafts.position) })
          .from(ticketDrafts)
          .where(eq(ticketDrafts.requirementId, requirement.id));
        const offset = (last?.position ?? -1) + 1;
        await tx.insert(ticketDrafts).values(
          plan.tickets.map((ticket, index) => ({
            requirementId: requirement.id,
            position: offset + index,
            title: ticket.title,
            description: ticket.description,
            acceptanceCriteria: ticket.acceptance_criteria,
            suggestedRole: ticket.suggested_role,
            estimate: ticket.estimate,
            dependsOn: ticket.depends_on
              .filter((dependency) => dependency !== index)
              .map((dependency) => offset + dependency),
          })),
        );
      }
      await tx
        .update(requirements)
        .set({ status: plan ? 'review' : 'failed', error, updatedAt: new Date() })
        .where(eq(requirements.id, requirement.id));
    });
    if (error) this.logger.warn(`planning requirement ${requirement.id} failed: ${error}`);
    this.publish(requirement);
  }

  /** The workspace's (or project's) first enabled planner, if any. */
  private async defaultPlanner(workspaceId: string, projectId: string) {
    const [planner] = await this.db
      .select({ id: personas.id })
      .from(personas)
      .where(
        and(
          eq(personas.workspaceId, workspaceId),
          eq(personas.role, 'planner'),
          eq(personas.enabled, true),
          isNull(personas.archivedAt),
          or(isNull(personas.projectId), eq(personas.projectId, projectId)),
        ),
      )
      .orderBy(asc(personas.createdAt))
      .limit(1);
    return planner ? this.runs.persona(workspaceId, planner.id) : null;
  }

  private async toDtos(rows: RequirementRow[]): Promise<Requirement[]> {
    if (rows.length === 0) return [];
    const drafts = await this.db
      .select()
      .from(ticketDrafts)
      .where(
        and(
          inArray(
            ticketDrafts.requirementId,
            rows.map((row) => row.id),
          ),
          ne(ticketDrafts.status, 'discarded'),
        ),
      )
      .orderBy(asc(ticketDrafts.position));
    return rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      title: row.title,
      body: row.body,
      status: row.status,
      plannerPersonaId: row.plannerPersonaId,
      planningRunId: row.planningRunId,
      error: row.error,
      drafts: drafts.filter((draft) => draft.requirementId === row.id).map(toDraft),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  private async getRow(workspaceId: string, requirementId: string): Promise<RequirementRow> {
    const [row] = await this.db
      .select({ requirement: requirements, workspaceId: projects.workspaceId })
      .from(requirements)
      .innerJoin(projects, eq(projects.id, requirements.projectId))
      .where(eq(requirements.id, requirementId))
      .limit(1);
    if (!row || row.workspaceId !== workspaceId) throw ApiException.notFound('Requirement');
    return row.requirement;
  }

  private async assertProject(workspaceId: string, projectId: string): Promise<void> {
    const [project] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
      .limit(1);
    if (!project) throw ApiException.notFound('Project');
  }

  private publish(requirement: RequirementRow): void {
    this.realtime.publish(`project:${requirement.projectId}`, {
      ev: 'requirement.updated',
      requirementId: requirement.id,
    });
  }
}
