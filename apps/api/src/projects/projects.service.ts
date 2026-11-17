import type {
  BindRepoRequest,
  CreateProjectRequest,
  Project,
  ProjectRepoBinding,
  ProjectSettings,
  UpdateProjectRequest,
} from '@coffe/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNull, like, or, sql } from 'drizzle-orm';
import { ApiException } from '../common/api-error.js';
import type { Database } from '../db/client.js';
import { DB, type DbExecutor } from '../db/db.module.js';
import {
  type ProjectSettings as StoredProjectSettings,
  projectRepos,
  projects,
  runnerRepos,
  runners,
} from '../db/schema/index.js';
import { DEFAULT_PERSONA_CLI, seedWorkspaceDefaults } from '../personas/defaults.js';
import { toRunnerRepo } from '../runners/runner-registry.js';

export type ProjectRow = typeof projects.$inferSelect;
type RunnerRepoRow = typeof runnerRepos.$inferSelect;

const KEY_CONSTRAINT = 'projects_workspace_key_uq';
const SLUG_CONSTRAINT = 'projects_workspace_slug_uq';
const UNIQUE_VIOLATION = '23505';
const MAX_SLUG_LENGTH = 48;
/** Concurrent creations with the same name race for a slug; each retry picks the next free one. */
const MAX_SLUG_ATTEMPTS = 5;

/** Contracts (camelCase) → `projects.settings` (snake_case); only the keys that are present. */
export function toStoredSettings(settings: ProjectSettings): StoredProjectSettings {
  return {
    ...(settings.testCommand !== undefined ? { test_command: settings.testCommand } : {}),
    ...(settings.mergeStrategy !== undefined ? { merge_strategy: settings.mergeStrategy } : {}),
    ...(settings.pushOnApprove !== undefined ? { push_on_approve: settings.pushOnApprove } : {}),
    ...(settings.remote !== undefined ? { remote: settings.remote } : {}),
    ...(settings.autoAdvance !== undefined ? { auto_advance: settings.autoAdvance } : {}),
    ...(settings.requirePassingTests !== undefined ? { require_passing_tests: settings.requirePassingTests } : {}),
    ...(settings.defaultCliId !== undefined ? { default_cli_id: settings.defaultCliId } : {}),
    ...(settings.defaultMode !== undefined ? { default_mode: settings.defaultMode } : {}),
  };
}

/** `projects.settings` (snake_case) → contracts (camelCase). */
export function toProjectSettings(settings: StoredProjectSettings): ProjectSettings {
  return {
    ...(settings.test_command !== undefined ? { testCommand: settings.test_command } : {}),
    ...(settings.merge_strategy !== undefined ? { mergeStrategy: settings.merge_strategy } : {}),
    ...(settings.push_on_approve !== undefined ? { pushOnApprove: settings.push_on_approve } : {}),
    ...(settings.remote !== undefined ? { remote: settings.remote } : {}),
    ...(settings.auto_advance !== undefined ? { autoAdvance: settings.auto_advance } : {}),
    ...(settings.require_passing_tests !== undefined ? { requirePassingTests: settings.require_passing_tests } : {}),
    ...(settings.default_cli_id !== undefined ? { defaultCliId: settings.default_cli_id } : {}),
    ...(settings.default_mode !== undefined ? { defaultMode: settings.default_mode } : {}),
  };
}

export function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    slug: row.slug,
    key: row.key,
    description: row.description,
    settings: toProjectSettings(row.settings),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** URL-safe slug of a project name: lowercase ASCII letters and digits joined by single dashes. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
  return slug || 'project';
}

/** Name of the violated unique constraint when `error` is (or wraps) a Postgres 23505. */
function violatedUniqueConstraint(error: unknown): string | null {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ('code' in current && current.code === UNIQUE_VIOLATION) {
      return 'constraint' in current && typeof current.constraint === 'string'
        ? current.constraint
        : '';
    }
  }
  return null;
}

/** Projects of a workspace and the runner repositories bound to them (architecture §5). */
@Injectable()
export class ProjectsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async list(workspaceId: string): Promise<Project[]> {
    const rows = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), isNull(projects.archivedAt)))
      .orderBy(asc(projects.name), asc(projects.createdAt));
    return rows.map(toProject);
  }

  /** The project row, or 404 when it does not exist in this workspace. */
  async getRow(
    workspaceId: string,
    projectId: string,
    executor: DbExecutor = this.db,
  ): Promise<ProjectRow> {
    const [row] = await executor
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw ApiException.notFound('Project');
    return row;
  }

  async get(workspaceId: string, projectId: string): Promise<Project> {
    return toProject(await this.getRow(workspaceId, projectId));
  }

  async create(workspaceId: string, userId: string, body: CreateProjectRequest): Promise<Project> {
    const name = body.name.trim();
    if (name.length === 0) {
      throw ApiException.badRequest('validation_failed', 'The project name must not be blank');
    }
    const repo =
      body.runnerRepoId === undefined
        ? null
        : await this.requireRunnerRepo(workspaceId, body.runnerRepoId);
    const settings = toStoredSettings(body.settings ?? {});

    for (let attempt = 1; ; attempt++) {
      const slug = await this.freeSlug(workspaceId, name);
      try {
        const row = await this.db.transaction(async (tx) => {
          const [project] = await tx
            .insert(projects)
            .values({
              workspaceId,
              name,
              slug,
              key: body.key,
              description: body.description ?? '',
              settings,
              createdBy: userId,
            })
            .returning();
          if (!project) throw new Error('inserting the project returned no row');
          if (repo) {
            await tx.insert(projectRepos).values({
              projectId: project.id,
              runnerId: repo.runnerId,
              runnerRepoId: repo.id,
              isPrimary: true,
            });
          }
          // The first project of a workspace brings the starter personas and workflow.
          await seedWorkspaceDefaults(tx, workspaceId, userId, settings.default_cli_id ?? DEFAULT_PERSONA_CLI);
          return project;
        });
        return toProject(row);
      } catch (error) {
        const constraint = violatedUniqueConstraint(error);
        if (constraint === KEY_CONSTRAINT) {
          throw ApiException.conflict(
            'project_key_taken',
            `The key ${body.key} is already used by another project in this workspace`,
            { key: body.key },
          );
        }
        if (constraint !== SLUG_CONSTRAINT || attempt >= MAX_SLUG_ATTEMPTS) throw error;
      }
    }
  }

  /** Settings are merged key by key; keys absent from the request keep their value. */
  async update(workspaceId: string, projectId: string, body: UpdateProjectRequest): Promise<Project> {
    const name = body.name?.trim();
    if (name !== undefined && name.length === 0) {
      throw ApiException.badRequest('validation_failed', 'The project name must not be blank');
    }
    const settings = body.settings ? toStoredSettings(body.settings) : {};
    const changes = {
      ...(name !== undefined ? { name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(Object.keys(settings).length > 0
        ? { settings: sql`${projects.settings} || ${JSON.stringify(settings)}::jsonb` }
        : {}),
    };
    if (Object.keys(changes).length === 0) return this.get(workspaceId, projectId);

    const [row] = await this.db
      .update(projects)
      .set(changes)
      .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
      .returning();
    if (!row) throw ApiException.notFound('Project');
    return toProject(row);
  }

  /** Primary binding first, then in the order the repositories were bound. */
  async listRepos(workspaceId: string, projectId: string): Promise<ProjectRepoBinding[]> {
    await this.getRow(workspaceId, projectId);
    return this.bindings(projectId, this.db);
  }

  /**
   * Binds a repository reported by a runner of the same workspace. The first binding of a project
   * is its primary; `isPrimary: true` makes this one the primary instead of the current one.
   * Binding an already bound repository only applies `isPrimary`.
   */
  async bindRepo(
    workspaceId: string,
    projectId: string,
    body: BindRepoRequest,
  ): Promise<ProjectRepoBinding> {
    const repo = await this.requireRunnerRepo(workspaceId, body.runnerRepoId);
    return this.db.transaction(async (tx) => {
      await this.lockProject(workspaceId, projectId, tx);
      const existing = await tx
        .select({
          id: projectRepos.id,
          runnerRepoId: projectRepos.runnerRepoId,
          isPrimary: projectRepos.isPrimary,
        })
        .from(projectRepos)
        .where(eq(projectRepos.projectId, projectId));
      const bound = existing.find((binding) => binding.runnerRepoId === repo.id);
      const primary = body.isPrimary === true || existing.length === 0 || bound?.isPrimary === true;

      if (primary && bound?.isPrimary !== true) {
        await tx
          .update(projectRepos)
          .set({ isPrimary: false })
          .where(and(eq(projectRepos.projectId, projectId), eq(projectRepos.isPrimary, true)));
      }
      let bindingId = bound?.id;
      if (bindingId === undefined) {
        const [inserted] = await tx
          .insert(projectRepos)
          .values({ projectId, runnerId: repo.runnerId, runnerRepoId: repo.id, isPrimary: primary })
          .returning({ id: projectRepos.id });
        if (!inserted) throw new Error('inserting the repository binding returned no row');
        bindingId = inserted.id;
      } else if (primary && bound?.isPrimary !== true) {
        await tx.update(projectRepos).set({ isPrimary: true }).where(eq(projectRepos.id, bindingId));
      }
      const [binding] = await this.bindings(projectId, tx, bindingId);
      if (!binding) throw new Error('the repository binding disappeared while it was created');
      return binding;
    });
  }

  /** Removes a binding; when it was the primary, the oldest remaining binding takes over. */
  async unbindRepo(workspaceId: string, projectId: string, bindingId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.lockProject(workspaceId, projectId, tx);
      const [removed] = await tx
        .delete(projectRepos)
        .where(and(eq(projectRepos.id, bindingId), eq(projectRepos.projectId, projectId)))
        .returning({ isPrimary: projectRepos.isPrimary });
      if (!removed) throw ApiException.notFound('Repository binding');
      if (!removed.isPrimary) return;

      const [successor] = await tx
        .select({ id: projectRepos.id })
        .from(projectRepos)
        .where(eq(projectRepos.projectId, projectId))
        .orderBy(asc(projectRepos.createdAt), asc(projectRepos.id))
        .limit(1);
      if (successor) {
        await tx
          .update(projectRepos)
          .set({ isPrimary: true })
          .where(eq(projectRepos.id, successor.id));
      }
    });
  }

  /** Serializes binding changes of one project, so it always has exactly one primary. */
  private async lockProject(workspaceId: string, projectId: string, tx: DbExecutor): Promise<void> {
    const [locked] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
      .for('update');
    if (!locked) throw ApiException.notFound('Project');
  }

  /** A repository reported by a runner of this workspace; 404 for any other id. */
  private async requireRunnerRepo(workspaceId: string, runnerRepoId: string): Promise<RunnerRepoRow> {
    const [row] = await this.db
      .select({ repo: runnerRepos })
      .from(runnerRepos)
      .innerJoin(runners, eq(runners.id, runnerRepos.runnerId))
      .where(and(eq(runnerRepos.id, runnerRepoId), eq(runners.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw ApiException.notFound('Repository');
    return row.repo;
  }

  /** `base`, or `base-2`, `base-3`, … when taken (slugs are unique per workspace). */
  private async freeSlug(workspaceId: string, name: string): Promise<string> {
    const base = slugify(name);
    const rows = await this.db
      .select({ slug: projects.slug })
      .from(projects)
      .where(
        and(
          eq(projects.workspaceId, workspaceId),
          or(eq(projects.slug, base), like(projects.slug, `${base}-%`)),
        ),
      );
    const taken = new Set(rows.map((row) => row.slug));
    if (!taken.has(base)) return base;
    let suffix = 2;
    while (taken.has(`${base}-${suffix}`)) suffix += 1;
    return `${base}-${suffix}`;
  }

  private async bindings(
    projectId: string,
    executor: DbExecutor,
    bindingId?: string,
  ): Promise<ProjectRepoBinding[]> {
    const rows = await executor
      .select({
        binding: projectRepos,
        repo: runnerRepos,
        runnerName: runners.name,
        runnerStatus: runners.status,
      })
      .from(projectRepos)
      .innerJoin(runnerRepos, eq(runnerRepos.id, projectRepos.runnerRepoId))
      .innerJoin(runners, eq(runners.id, projectRepos.runnerId))
      .where(
        and(
          eq(projectRepos.projectId, projectId),
          bindingId === undefined ? undefined : eq(projectRepos.id, bindingId),
        ),
      )
      .orderBy(desc(projectRepos.isPrimary), asc(projectRepos.createdAt), asc(projectRepos.id));
    return rows.map(({ binding, repo, runnerName, runnerStatus }) => ({
      id: binding.id,
      projectId: binding.projectId,
      runnerId: binding.runnerId,
      runnerName,
      runnerStatus,
      isPrimary: binding.isPrimary,
      repo: toRunnerRepo(repo),
    }));
  }
}
