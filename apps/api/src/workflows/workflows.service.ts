import type {
  CreateWorkflowRequest,
  UpdateWorkflowRequest,
  Workflow,
  WorkflowInstance,
  WorkflowStep,
} from '@coffe/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { ApiException } from '../common/api-error.js';
import type { Database } from '../db/client.js';
import { DB } from '../db/db.module.js';
import {
  personas,
  projects,
  type WorkflowStep as StoredStep,
  workflowInstances,
  workflows,
} from '../db/schema/index.js';

export type WorkflowRow = typeof workflows.$inferSelect;
export type WorkflowInstanceRow = typeof workflowInstances.$inferSelect;

export function toStoredStep(step: WorkflowStep): StoredStep {
  return {
    key: step.key,
    name: step.name,
    persona_ids: step.personaIds,
    parallel: step.parallel,
    on_fail: step.onFail === 'stop' ? 'stop' : (step.onFail as `goto:${string}`),
    max_loops: step.maxLoops,
  };
}

export function toStep(step: StoredStep): WorkflowStep {
  return {
    key: step.key,
    name: step.name,
    personaIds: step.persona_ids,
    parallel: step.parallel,
    onFail: step.on_fail,
    maxLoops: step.max_loops,
  };
}

export function toWorkflow(row: WorkflowRow): Workflow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    name: row.name,
    steps: row.steps.map(toStep),
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toWorkflowInstance(row: WorkflowInstanceRow): WorkflowInstance {
  return {
    id: row.id,
    ticketId: row.ticketId,
    workflowId: row.workflowId,
    workflowName: row.workflowName,
    status: row.status,
    currentStepKey: row.currentStepKey,
    steps: row.stepStates.map((state) => ({
      key: state.key,
      status: state.status,
      runIds: state.run_ids,
      loops: state.loops,
      outcome: state.outcome,
    })),
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}

/** Workflow definitions (architecture §11.3): ordered steps of personas with loop rules. */
@Injectable()
export class WorkflowsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Workspace-wide workflows plus the project's own. */
  async list(workspaceId: string, projectId: string): Promise<Workflow[]> {
    await this.assertProject(workspaceId, projectId);
    const rows = await this.db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.workspaceId, workspaceId),
          or(isNull(workflows.projectId), eq(workflows.projectId, projectId)),
        ),
      )
      .orderBy(asc(workflows.createdAt));
    return rows.map(toWorkflow);
  }

  async getRow(workspaceId: string, workflowId: string): Promise<WorkflowRow> {
    const [row] = await this.db
      .select()
      .from(workflows)
      .where(and(eq(workflows.id, workflowId), eq(workflows.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw ApiException.notFound('Workflow');
    return row;
  }

  /** The workflow a ticket of the project runs by default: the project's, else the workspace's. */
  async defaultFor(workspaceId: string, projectId: string): Promise<WorkflowRow | null> {
    const rows = await this.db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.workspaceId, workspaceId),
          eq(workflows.isDefault, true),
          or(isNull(workflows.projectId), eq(workflows.projectId, projectId)),
        ),
      );
    return rows.find((row) => row.projectId === projectId) ?? rows[0] ?? null;
  }

  async create(
    workspaceId: string,
    projectId: string,
    body: CreateWorkflowRequest,
  ): Promise<Workflow> {
    await this.assertProject(workspaceId, projectId);
    await this.validateSteps(workspaceId, body.steps);
    const row = await this.db.transaction(async (tx) => {
      if (body.isDefault) {
        await tx
          .update(workflows)
          .set({ isDefault: false })
          .where(and(eq(workflows.workspaceId, workspaceId), eq(workflows.projectId, projectId)));
      }
      const [created] = await tx
        .insert(workflows)
        .values({
          workspaceId,
          projectId,
          name: body.name.trim(),
          steps: body.steps.map(toStoredStep),
          isDefault: body.isDefault,
        })
        .returning();
      if (!created) throw new Error('workflow insert returned no row');
      return created;
    });
    return toWorkflow(row);
  }

  async update(
    workspaceId: string,
    workflowId: string,
    body: UpdateWorkflowRequest,
  ): Promise<Workflow> {
    const current = await this.getRow(workspaceId, workflowId);
    if (body.steps) await this.validateSteps(workspaceId, body.steps);
    const row = await this.db.transaction(async (tx) => {
      if (body.isDefault) {
        await tx
          .update(workflows)
          .set({ isDefault: false })
          .where(
            and(
              eq(workflows.workspaceId, workspaceId),
              current.projectId
                ? eq(workflows.projectId, current.projectId)
                : isNull(workflows.projectId),
              ne(workflows.id, workflowId),
            ),
          );
      }
      const [updated] = await tx
        .update(workflows)
        .set({
          ...(body.name !== undefined ? { name: body.name.trim() } : {}),
          ...(body.steps !== undefined ? { steps: body.steps.map(toStoredStep) } : {}),
          ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
          updatedAt: new Date(),
        })
        .where(eq(workflows.id, workflowId))
        .returning();
      if (!updated) throw ApiException.notFound('Workflow');
      return updated;
    });
    return toWorkflow(row);
  }

  /** Step keys are unique, loops point at existing steps, personas exist and parallel steps only read. */
  private async validateSteps(workspaceId: string, steps: WorkflowStep[]): Promise<void> {
    const keys = steps.map((step) => step.key);
    if (new Set(keys).size !== keys.length) {
      throw ApiException.badRequest('invalid_workflow', 'Step keys must be unique');
    }
    for (const step of steps) {
      if (step.onFail !== 'stop' && !keys.includes(step.onFail.slice('goto:'.length))) {
        throw ApiException.badRequest(
          'invalid_workflow',
          `Step ${step.key} loops to an unknown step (${step.onFail})`,
        );
      }
    }
    const personaIds = [...new Set(steps.flatMap((step) => step.personaIds))];
    const found = await this.db
      .select({ id: personas.id, mode: personas.permissions })
      .from(personas)
      .where(
        and(
          eq(personas.workspaceId, workspaceId),
          inArray(personas.id, personaIds),
          isNull(personas.archivedAt),
        ),
      );
    if (found.length !== personaIds.length) {
      throw ApiException.badRequest(
        'invalid_workflow',
        'A step uses a persona that does not exist',
      );
    }
    for (const step of steps) {
      const writers = step.personaIds.filter(
        (id) => found.find((persona) => persona.id === id)?.mode.mode !== 'read_only',
      );
      if (step.personaIds.length > 1 && writers.length > 0) {
        throw ApiException.badRequest(
          'invalid_workflow',
          `Step ${step.key} runs several personas in parallel; only read-only personas may share a worktree`,
        );
      }
    }
  }

  private async assertProject(workspaceId: string, projectId: string): Promise<void> {
    const [project] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
      .limit(1);
    if (!project) throw ApiException.notFound('Project');
  }
}
