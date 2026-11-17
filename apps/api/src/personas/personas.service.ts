import {
  type CreatePersonaRequest,
  KNOWN_CLI_IDS,
  PERSONA_ROLES,
  type PermissionPolicy,
  type Persona,
  type UpdatePersonaRequest,
  unenforceableLimits,
} from '@coffe/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { ApiException } from '../common/api-error.js';
import type { Database } from '../db/client.js';
import { DB } from '../db/db.module.js';
import { type PermissionPolicyJson, personas, projects } from '../db/schema/index.js';

export type PersonaRow = typeof personas.$inferSelect;

export function toPolicyJson(policy: PermissionPolicy): PermissionPolicyJson {
  return {
    mode: policy.mode,
    allow_tools: policy.allowTools,
    deny_tools: policy.denyTools,
    network: policy.network,
    max_turns: policy.maxTurns ?? null,
    max_budget_usd: policy.maxBudgetUsd ?? null,
    timeout_secs: policy.timeoutSecs ?? null,
  };
}

export function toPolicy(policy: PermissionPolicyJson): PermissionPolicy {
  return {
    mode: policy.mode,
    allowTools: policy.allow_tools,
    denyTools: policy.deny_tools,
    network: policy.network,
    maxTurns: policy.max_turns ?? null,
    maxBudgetUsd: policy.max_budget_usd ?? null,
    timeoutSecs: policy.timeout_secs ?? null,
  };
}

export function toPersona(row: PersonaRow): Persona {
  const permissions = toPolicy(row.permissions);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    name: row.name,
    role: row.role,
    instructions: row.instructions,
    cliId: row.cliId,
    model: row.model,
    mode: row.mode,
    driver: row.driver,
    permissions,
    color: row.color,
    enabled: row.enabled,
    unenforceable: unenforceableLimits(row.cliId, permissions),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Agent personas (architecture §10.5): who runs, with which CLI, model and limits. */
@Injectable()
export class PersonasService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async list(workspaceId: string, projectId?: string): Promise<Persona[]> {
    const rows = await this.db
      .select()
      .from(personas)
      .where(
        and(
          eq(personas.workspaceId, workspaceId),
          isNull(personas.archivedAt),
          projectId ? or(isNull(personas.projectId), eq(personas.projectId, projectId)) : undefined,
        ),
      )
      .orderBy(asc(personas.createdAt), asc(personas.name));
    // Workflow order (planner → implementer → tester → reviewer …), then oldest first.
    return rows
      .toSorted((a, b) => PERSONA_ROLES.indexOf(a.role) - PERSONA_ROLES.indexOf(b.role))
      .map(toPersona);
  }

  /** An active persona of the workspace; 404 for archived or foreign ones. */
  async getRow(workspaceId: string, personaId: string): Promise<PersonaRow> {
    const [row] = await this.db
      .select()
      .from(personas)
      .where(
        and(
          eq(personas.id, personaId),
          eq(personas.workspaceId, workspaceId),
          isNull(personas.archivedAt),
        ),
      )
      .limit(1);
    if (!row) throw ApiException.notFound('Persona');
    return row;
  }

  async create(workspaceId: string, userId: string, body: CreatePersonaRequest): Promise<Persona> {
    this.assertKnownCli(body.cliId);
    if (body.projectId) await this.assertProject(workspaceId, body.projectId);
    const [row] = await this.db
      .insert(personas)
      .values({
        workspaceId,
        projectId: body.projectId ?? null,
        name: body.name.trim(),
        role: body.role,
        instructions: body.instructions,
        cliId: body.cliId,
        model: body.model?.trim() || null,
        mode: body.mode,
        driver: body.driver,
        permissions: toPolicyJson(body.permissions),
        color: body.color ?? null,
        enabled: body.enabled,
        createdBy: userId,
      })
      .returning();
    if (!row) throw new Error('persona insert returned no row');
    return toPersona(row);
  }

  async update(
    workspaceId: string,
    personaId: string,
    body: UpdatePersonaRequest,
  ): Promise<Persona> {
    await this.getRow(workspaceId, personaId);
    if (body.cliId !== undefined) this.assertKnownCli(body.cliId);
    const [row] = await this.db
      .update(personas)
      .set({
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.instructions !== undefined ? { instructions: body.instructions } : {}),
        ...(body.cliId !== undefined ? { cliId: body.cliId } : {}),
        ...(body.model !== undefined ? { model: body.model?.trim() || null } : {}),
        ...(body.mode !== undefined ? { mode: body.mode } : {}),
        ...(body.driver !== undefined ? { driver: body.driver } : {}),
        ...(body.permissions !== undefined ? { permissions: toPolicyJson(body.permissions) } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        updatedAt: new Date(),
      })
      .where(eq(personas.id, personaId))
      .returning();
    if (!row) throw ApiException.notFound('Persona');
    return toPersona(row);
  }

  /** Archived, not deleted: past runs keep pointing at the persona that made them. */
  async archive(workspaceId: string, personaId: string): Promise<void> {
    await this.getRow(workspaceId, personaId);
    await this.db
      .update(personas)
      .set({ archivedAt: new Date(), enabled: false })
      .where(eq(personas.id, personaId));
  }

  private assertKnownCli(cliId: string): void {
    if (!KNOWN_CLI_IDS.includes(cliId)) {
      throw ApiException.badRequest(
        'unknown_cli',
        `Unknown CLI ${cliId}; expected one of ${KNOWN_CLI_IDS.join(', ')}`,
      );
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
