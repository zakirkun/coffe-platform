import { z } from 'zod';
import { IsoDate, Uuid } from './common.js';

/** One step of a workflow (architecture §11.3). */
export const WorkflowStep = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
  name: z.string().min(1).max(80),
  /** One persona, or several read-only personas running in parallel. */
  personaIds: z.array(Uuid).min(1).max(8),
  parallel: z.boolean().default(false),
  /** `stop` ends the workflow; `goto:<key>` loops back (e.g. reviewer → implementer). */
  onFail: z
    .union([z.literal('stop'), z.string().regex(/^goto:[a-z][a-z0-9_-]{0,39}$/)])
    .default('stop'),
  maxLoops: z.number().int().min(0).max(10).default(2),
});
export type WorkflowStep = z.infer<typeof WorkflowStep>;

export const Workflow = z.object({
  id: Uuid,
  workspaceId: z.string(),
  projectId: Uuid.nullable(),
  name: z.string(),
  steps: z.array(WorkflowStep),
  isDefault: z.boolean(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type Workflow = z.infer<typeof Workflow>;

/** `POST /workspaces/:ws/projects/:projectId/workflows` */
export const CreateWorkflowRequest = z.object({
  name: z.string().min(1).max(80),
  steps: z.array(WorkflowStep).min(1).max(12),
  isDefault: z.boolean().default(false),
});
export type CreateWorkflowRequest = z.infer<typeof CreateWorkflowRequest>;

/** `PATCH /workspaces/:ws/workflows/:workflowId` */
export const UpdateWorkflowRequest = CreateWorkflowRequest.partial();
export type UpdateWorkflowRequest = z.infer<typeof UpdateWorkflowRequest>;

export const STEP_STATUSES = ['pending', 'running', 'completed', 'failed', 'skipped'] as const;
export const WORKFLOW_INSTANCE_STATUSES = ['running', 'completed', 'failed', 'cancelled'] as const;

export const WorkflowStepState = z.object({
  key: z.string(),
  status: z.enum(STEP_STATUSES),
  runIds: z.array(Uuid),
  loops: z.number().int(),
  /** Reviewer verdict / tester summary that produced the handoff. */
  outcome: z.string().nullable(),
});
export type WorkflowStepState = z.infer<typeof WorkflowStepState>;

export const WorkflowInstance = z.object({
  id: Uuid,
  ticketId: Uuid,
  workflowId: Uuid.nullable(),
  workflowName: z.string(),
  status: z.enum(WORKFLOW_INSTANCE_STATUSES),
  currentStepKey: z.string().nullable(),
  steps: z.array(WorkflowStepState),
  startedAt: IsoDate,
  endedAt: IsoDate.nullable(),
});
export type WorkflowInstance = z.infer<typeof WorkflowInstance>;

/** `POST /workspaces/:ws/tickets/:ticketId/start` — moves the ticket to In Progress and runs its workflow. */
export const StartTicketRequest = z.object({
  workflowId: Uuid.optional(),
  /** Overrides the runner chosen by the scheduler. */
  runnerId: Uuid.optional(),
});
export type StartTicketRequest = z.infer<typeof StartTicketRequest>;
