import { z } from 'zod';
import { IsoDate, Uuid } from './common.js';
import { RunnerRepo } from './runners.js';

export const MERGE_STRATEGIES = ['ff_only', 'merge', 'squash'] as const;
export const MergeStrategy = z.enum(MERGE_STRATEGIES);
export type MergeStrategy = z.infer<typeof MergeStrategy>;
export const RUN_MODES = ['structured', 'pty'] as const;
export const RunMode = z.enum(RUN_MODES);
export type RunMode = z.infer<typeof RunMode>;
/** Structured protocol of a run: the CLI's own JSON stream or the Agent Client Protocol. */
export const RUN_DRIVERS = ['native', 'acp'] as const;
export const RunDriver = z.enum(RUN_DRIVERS);
export type RunDriver = z.infer<typeof RunDriver>;

export const ProjectSettings = z.object({
  testCommand: z.string().nullable().optional(),
  mergeStrategy: MergeStrategy.optional(),
  pushOnApprove: z.boolean().optional(),
  remote: z.string().nullable().optional(),
  autoAdvance: z.boolean().optional(),
  defaultCliId: z.string().nullable().optional(),
  defaultMode: RunMode.optional(),
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;

export const Project = z.object({
  id: Uuid,
  workspaceId: z.string(),
  name: z.string(),
  slug: z.string(),
  key: z.string(),
  description: z.string(),
  settings: ProjectSettings,
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type Project = z.infer<typeof Project>;

/** Ticket key prefix: 2–6 uppercase letters/digits starting with a letter, e.g. `COF`. */
export const ProjectKey = z.string().regex(/^[A-Z][A-Z0-9]{1,5}$/);

/** `POST /workspaces/:ws/projects` */
export const CreateProjectRequest = z.object({
  name: z.string().min(1).max(100),
  key: ProjectKey,
  description: z.string().max(10_000).optional(),
  /** Optional first repository binding (a repo reported by a runner). */
  runnerRepoId: Uuid.optional(),
  settings: ProjectSettings.optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

/** `PATCH /workspaces/:ws/projects/:projectId` */
export const UpdateProjectRequest = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(10_000).optional(),
  settings: ProjectSettings.optional(),
});
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;

export const ProjectRepoBinding = z.object({
  id: Uuid,
  projectId: Uuid,
  runnerId: Uuid,
  runnerName: z.string(),
  runnerStatus: z.string(),
  isPrimary: z.boolean(),
  repo: RunnerRepo,
});
export type ProjectRepoBinding = z.infer<typeof ProjectRepoBinding>;

/** `POST /workspaces/:ws/projects/:projectId/repos` */
export const BindRepoRequest = z.object({
  runnerRepoId: Uuid,
  isPrimary: z.boolean().optional(),
});
export type BindRepoRequest = z.infer<typeof BindRepoRequest>;
