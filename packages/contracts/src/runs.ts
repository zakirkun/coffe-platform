import { z } from 'zod';
import { IsoDate, Uuid } from './common.js';
import { RunMode } from './projects.js';

export const RUN_STATUSES = [
  'queued',
  'dispatched',
  'starting',
  'running',
  'paused',
  'waiting_input',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
] as const;
export const RunStatus = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatus>;
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'cancelled'];

export const RUN_KINDS = [
  'ticket',
  'planning',
  'wiki',
  'query_assist',
  'canvas',
  'conflict',
] as const;
export const RunKind = z.enum(RUN_KINDS);
export type RunKind = z.infer<typeof RunKind>;

export const COST_SOURCES = ['reported', 'estimated', 'unavailable'] as const;

export const RunUsage = z.object({
  available: z.boolean(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  reasoningTokens: z.number(),
  totalTokens: z.number(),
  costUsd: z.number().nullable(),
  costSource: z.enum(COST_SOURCES),
  credits: z.number().nullable(),
  durationMs: z.number().nullable(),
  numTurns: z.number().nullable(),
  model: z.string().nullable(),
});
export type RunUsage = z.infer<typeof RunUsage>;

export const Run = z.object({
  id: Uuid,
  projectId: Uuid,
  ticketId: Uuid.nullable(),
  kind: RunKind,
  personaId: Uuid.nullable(),
  workflowStepKey: z.string().nullable(),
  attempt: z.number().int(),
  parentRunId: Uuid.nullable(),
  runnerId: Uuid.nullable(),
  repoId: Uuid.nullable(),
  cliId: z.string(),
  model: z.string().nullable(),
  mode: RunMode,
  status: RunStatus,
  statusDetail: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  prompt: z.string(),
  cliSessionId: z.string().nullable(),
  branch: z.string().nullable(),
  baseBranch: z.string().nullable(),
  baseCommit: z.string().nullable(),
  headCommit: z.string().nullable(),
  resultSummary: z.string().nullable(),
  error: z.string().nullable(),
  lastSeq: z.number().int(),
  /** Input accepted right now (running / waiting_input and the CLI supports it). */
  acceptsInput: z.boolean(),
  usage: RunUsage.nullable(),
  requestedBy: z.string().nullable(),
  createdAt: IsoDate,
  startedAt: IsoDate.nullable(),
  endedAt: IsoDate.nullable(),
});
export type Run = z.infer<typeof Run>;

/** `POST /workspaces/:ws/tickets/:ticketId/runs` */
export const StartRunRequest = z.object({
  cliId: z.string().min(1).optional(),
  model: z.string().max(200).optional(),
  mode: RunMode.optional(),
  /** Extra instructions appended to the ticket-derived prompt. */
  prompt: z.string().max(50_000).optional(),
  personaId: Uuid.optional(),
  runnerId: Uuid.optional(),
  repoId: Uuid.optional(),
});
export type StartRunRequest = z.infer<typeof StartRunRequest>;

/** `GET /workspaces/:ws/runs/:runId/output?afterSeq=` */
export const RunOutputChunk = z.object({ seq: z.number().int(), data: z.string() });
export type RunOutputChunk = z.infer<typeof RunOutputChunk>;
export const RunOutputResponse = z.object({
  chunks: z.array(RunOutputChunk),
  lastSeq: z.number().int(),
});
export type RunOutputResponse = z.infer<typeof RunOutputResponse>;

/** Normalized agent event as stored (`data` = protocol `AgentEvent`). */
export const RunEvent = z.object({
  seq: z.number().int(),
  ts: IsoDate,
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
});
export type RunEvent = z.infer<typeof RunEvent>;
export const RunEventsResponse = z.object({ events: z.array(RunEvent), lastSeq: z.number().int() });
export type RunEventsResponse = z.infer<typeof RunEventsResponse>;

export const AfterSeqQuery = z.object({
  afterSeq: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(5_000).default(2_000),
});

/** `POST /workspaces/:ws/runs/:runId/input` */
export const RunInputRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(100_000) }),
  z.object({ kind: z.literal('keys'), data: z.string().min(1).max(10_000) }),
  z.object({
    kind: z.literal('permission'),
    requestId: z.string(),
    allow: z.boolean(),
    remember: z.boolean().optional(),
  }),
]);
export type RunInputRequest = z.infer<typeof RunInputRequest>;

export const RUN_SIGNALS = ['pause', 'resume', 'interrupt', 'stop', 'kill'] as const;
/** `POST /workspaces/:ws/runs/:runId/signal` */
export const RunSignalRequest = z.object({ signal: z.enum(RUN_SIGNALS) });
export type RunSignalRequest = z.infer<typeof RunSignalRequest>;
