import { z } from 'zod';
import { IsoDate, Uuid } from './common.js';
import { RunDriver, RunMode } from './projects.js';

export const PERSONA_ROLES = [
  'planner',
  'implementer',
  'tester',
  'reviewer',
  'designer',
  'custom',
] as const;
export const PersonaRole = z.enum(PERSONA_ROLES);
export type PersonaRole = z.infer<typeof PersonaRole>;

export const PERMISSION_MODES = ['read_only', 'workspace_write', 'full_auto'] as const;
export const PermissionMode = z.enum(PERMISSION_MODES);
export type PermissionMode = z.infer<typeof PermissionMode>;

/** Persona permission limits (architecture §10.5); mapped to each CLI's native flags. */
export const PermissionPolicy = z.object({
  mode: PermissionMode,
  allowTools: z.array(z.string().max(200)).max(100).default([]),
  denyTools: z.array(z.string().max(200)).max(100).default([]),
  network: z.boolean().default(true),
  maxTurns: z.number().int().min(1).max(1_000).nullable().optional(),
  maxBudgetUsd: z.number().min(0).max(10_000).nullable().optional(),
  timeoutSecs: z.number().int().min(60).max(86_400).nullable().optional(),
});
export type PermissionPolicy = z.infer<typeof PermissionPolicy>;

export const Persona = z.object({
  id: Uuid,
  workspaceId: z.string(),
  /** null = available in every project of the workspace. */
  projectId: Uuid.nullable(),
  name: z.string(),
  role: PersonaRole,
  instructions: z.string(),
  cliId: z.string(),
  model: z.string().nullable(),
  mode: RunMode,
  driver: RunDriver,
  permissions: PermissionPolicy,
  color: z.string().nullable(),
  enabled: z.boolean(),
  /** Limits the selected CLI cannot enforce (e.g. "max_budget_usd: Codex reports no cost"). */
  unenforceable: z.array(z.string()),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type Persona = z.infer<typeof Persona>;

/** `POST /workspaces/:ws/personas` */
export const CreatePersonaRequest = z.object({
  projectId: Uuid.nullable().optional(),
  name: z.string().min(1).max(80),
  role: PersonaRole,
  instructions: z.string().max(50_000).default(''),
  cliId: z.string().min(1).max(40),
  model: z.string().max(200).nullable().optional(),
  mode: RunMode.default('structured'),
  driver: RunDriver.default('native'),
  permissions: PermissionPolicy,
  color: z.string().max(20).nullable().optional(),
  enabled: z.boolean().default(true),
});
export type CreatePersonaRequest = z.infer<typeof CreatePersonaRequest>;

/**
 * `PATCH /workspaces/:ws/personas/:personaId`. Spelled out instead of `.partial()`: Zod applies
 * `.default()` inside optional fields, which would reset absent fields.
 */
export const UpdatePersonaRequest = z.object({
  name: z.string().min(1).max(80).optional(),
  role: PersonaRole.optional(),
  instructions: z.string().max(50_000).optional(),
  cliId: z.string().min(1).max(40).optional(),
  model: z.string().max(200).nullable().optional(),
  mode: RunMode.optional(),
  driver: RunDriver.optional(),
  permissions: PermissionPolicy.optional(),
  color: z.string().max(20).nullable().optional(),
  enabled: z.boolean().optional(),
});
export type UpdatePersonaRequest = z.infer<typeof UpdatePersonaRequest>;

/** `GET /workspaces/:ws/personas?projectId=` (workspace-wide + that project's personas). */
export const PersonaQuery = z.object({ projectId: Uuid.optional() });
