import { z } from 'zod';
import { RunnerStatus } from './runners.js';
import { Run, RunEvent, RunUsage } from './runs.js';
import { Ticket } from './tickets.js';

/**
 * Browser <-> control plane realtime protocol on `wss://DOMAIN/api/ws` (architecture §9).
 * Channels: `workspace:<id>`, `project:<id>`, `ticket:<id>`, `run:<id>`.
 */
export const Channel = z.string().regex(/^(workspace|project|ticket|run):[A-Za-z0-9-]{1,64}$/);
export type Channel = z.infer<typeof Channel>;

export const ClientMessage = z.discriminatedUnion('op', [
  z.object({ op: z.literal('sub'), ch: Channel }),
  z.object({ op: z.literal('unsub'), ch: Channel }),
  /** Raw keystrokes for a run's terminal (xterm.js `onData`). */
  z.object({ op: z.literal('run.input'), runId: z.uuid(), data: z.string().min(1).max(10_000) }),
  z.object({
    op: z.literal('run.resize'),
    runId: z.uuid(),
    cols: z.number().int().min(10).max(1_000),
    rows: z.number().int().min(5).max(500),
  }),
  z.object({ op: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const ServerEvent = z.discriminatedUnion('ev', [
  z.object({ ev: z.literal('subscribed'), ch: Channel }),
  z.object({
    ev: z.literal('error'),
    ch: Channel.optional(),
    code: z.string(),
    message: z.string(),
  }),
  z.object({ ev: z.literal('pong') }),
  /** Terminal bytes (base64). */
  z.object({
    ev: z.literal('run.output'),
    ch: Channel,
    runId: z.uuid(),
    seq: z.number().int(),
    data: z.string(),
  }),
  z.object({ ev: z.literal('run.event'), ch: Channel, runId: z.uuid(), event: RunEvent }),
  z.object({ ev: z.literal('run.updated'), ch: Channel, run: Run }),
  z.object({ ev: z.literal('run.usage'), ch: Channel, runId: z.uuid(), usage: RunUsage }),
  z.object({
    ev: z.literal('runner.status'),
    ch: Channel,
    runnerId: z.uuid(),
    status: RunnerStatus,
    runningRuns: z.number().int(),
  }),
  z.object({ ev: z.literal('ticket.updated'), ch: Channel, ticket: Ticket }),
  z.object({ ev: z.literal('ticket.deleted'), ch: Channel, ticketId: z.uuid() }),
  z.object({ ev: z.literal('review.updated'), ch: Channel, ticketId: z.uuid() }),
  /** The workflow instance of a ticket changed (step started, finished, looped, ended). */
  z.object({ ev: z.literal('workflow.updated'), ch: Channel, ticketId: z.uuid() }),
  /** A requirement or its drafts changed (planning run finished, drafts edited, approved). */
  z.object({ ev: z.literal('requirement.updated'), ch: Channel, requirementId: z.uuid() }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;
