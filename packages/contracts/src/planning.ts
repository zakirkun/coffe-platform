import { z } from 'zod';
import { IsoDate, Uuid } from './common.js';
import { PersonaRole } from './personas.js';

export const REQUIREMENT_STATUSES = ['draft', 'planning', 'review', 'approved', 'failed'] as const;

export const TicketDraft = z.object({
  id: Uuid,
  requirementId: Uuid,
  position: z.number().int(),
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  suggestedRole: z.string().nullable(),
  estimate: z.string().nullable(),
  /** Positions of drafts this one depends on. */
  dependsOn: z.array(z.number().int()),
  status: z.enum(['pending', 'approved', 'discarded']),
  ticketId: Uuid.nullable(),
});
export type TicketDraft = z.infer<typeof TicketDraft>;

export const Requirement = z.object({
  id: Uuid,
  projectId: Uuid,
  title: z.string(),
  body: z.string(),
  status: z.enum(REQUIREMENT_STATUSES),
  plannerPersonaId: Uuid.nullable(),
  planningRunId: Uuid.nullable(),
  error: z.string().nullable(),
  drafts: z.array(TicketDraft),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type Requirement = z.infer<typeof Requirement>;

/** `POST /workspaces/:ws/projects/:projectId/requirements` */
export const CreateRequirementRequest = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(100_000),
});
export type CreateRequirementRequest = z.infer<typeof CreateRequirementRequest>;

/** `POST /workspaces/:ws/requirements/:requirementId/plan` — starts a read-only planning run. */
export const PlanRequirementRequest = z.object({ plannerPersonaId: Uuid.optional() });
export type PlanRequirementRequest = z.infer<typeof PlanRequirementRequest>;

/** `POST /workspaces/:ws/requirements/:requirementId/drafts` and `PATCH …/drafts/:draftId` */
export const UpsertDraftRequest = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(50_000).default(''),
  acceptanceCriteria: z.array(z.string().min(1).max(2_000)).max(50).default([]),
  suggestedRole: PersonaRole.nullable().optional(),
  estimate: z.string().max(40).nullable().optional(),
  dependsOn: z.array(z.number().int().min(0)).max(50).default([]),
  position: z.number().int().min(0).optional(),
});
export type UpsertDraftRequest = z.infer<typeof UpsertDraftRequest>;

/** `POST /workspaces/:ws/requirements/:requirementId/approve` — creates Backlog tickets. */
export const ApproveRequirementRequest = z.object({
  /** Defaults to every pending draft. */
  draftIds: z.array(Uuid).optional(),
});
export type ApproveRequirementRequest = z.infer<typeof ApproveRequirementRequest>;

/**
 * Shape the planner CLI must return (validated by the API; also sent as the run's
 * `output_schema` for CLIs with schema-constrained output). Every key is required (nullable
 * where optional) because strict structured-output modes reject optional properties.
 */
export const PlanOutput = z.strictObject({
  tickets: z
    .array(
      z.strictObject({
        title: z.string().min(1).max(300),
        description: z.string().max(50_000),
        acceptance_criteria: z.array(z.string().min(1)).min(1).max(50),
        /** Zero-based indexes of tickets in this list that must be done first. */
        depends_on: z.array(z.number().int().min(0)),
        suggested_role: PersonaRole.nullable(),
        estimate: z.string().max(40).nullable(),
      }),
    )
    .min(1)
    .max(50),
});
export type PlanOutput = z.infer<typeof PlanOutput>;

/** JSON Schema (draft 2020-12) generated from PlanOutput. */
export const PLAN_OUTPUT_JSON_SCHEMA = z.toJSONSchema(PlanOutput);
