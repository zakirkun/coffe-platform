import { z } from 'zod';
import { IsoDate, Uuid } from './common.js';
import { RunStatus } from './runs.js';

export const TICKET_STATUSES = ['backlog', 'ready', 'in_progress', 'in_review', 'done'] as const;
export const TicketStatus = z.enum(TICKET_STATUSES);
export type TicketStatus = z.infer<typeof TicketStatus>;

export const TicketFlags = z.object({
  failed: z.boolean().optional(),
  /** At least one ticket this one depends on is not Done yet (see `blockedBy`). */
  blocked: z.boolean().optional(),
  mergeConflict: z.boolean().optional(),
});
export type TicketFlags = z.infer<typeof TicketFlags>;

export const Ticket = z.object({
  id: Uuid,
  projectId: Uuid,
  number: z.number().int(),
  /** e.g. `COF-12` */
  key: z.string(),
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  status: TicketStatus,
  /** Fractional index for ordering within a column. */
  position: z.string(),
  /** 0 = urgent … 3 = low */
  priority: z.number().int().min(0).max(3),
  labels: z.array(z.string()),
  assigneePersonaId: Uuid.nullable(),
  branch: z.string().nullable(),
  baseBranch: z.string().nullable(),
  worktreeRunnerId: Uuid.nullable(),
  repoId: Uuid.nullable(),
  flags: TicketFlags,
  /** Dependencies (from planning) that are not Done yet; workflows refuse to start until empty. */
  blockedBy: z.array(z.object({ id: Uuid, key: z.string(), status: TicketStatus })),
  /** Latest run summary for board badges. */
  latestRun: z
    .object({ id: Uuid, status: RunStatus, cliId: z.string(), personaId: Uuid.nullable() })
    .nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type Ticket = z.infer<typeof Ticket>;

/** `POST /workspaces/:ws/projects/:projectId/tickets` */
export const CreateTicketRequest = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(50_000).default(''),
  acceptanceCriteria: z.array(z.string().min(1).max(2_000)).max(50).default([]),
  priority: z.number().int().min(0).max(3).optional(),
  labels: z.array(z.string().max(40)).max(20).optional(),
  status: TicketStatus.optional(),
  assigneePersonaId: Uuid.nullable().optional(),
  repoId: Uuid.optional(),
});
export type CreateTicketRequest = z.infer<typeof CreateTicketRequest>;

/** `PATCH /workspaces/:ws/tickets/:ticketId` */
export const UpdateTicketRequest = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(50_000).optional(),
  acceptanceCriteria: z.array(z.string().min(1).max(2_000)).max(50).optional(),
  priority: z.number().int().min(0).max(3).optional(),
  labels: z.array(z.string().max(40)).max(20).optional(),
  assigneePersonaId: Uuid.nullable().optional(),
  repoId: Uuid.nullable().optional(),
});
export type UpdateTicketRequest = z.infer<typeof UpdateTicketRequest>;

/**
 * `POST /workspaces/:ws/tickets/:ticketId/move` — change column and/or order.
 * The server computes the fractional position between `afterId` and `beforeId`.
 */
export const MoveTicketRequest = z.object({
  status: TicketStatus,
  afterId: Uuid.nullable().optional(),
  beforeId: Uuid.nullable().optional(),
});
export type MoveTicketRequest = z.infer<typeof MoveTicketRequest>;
