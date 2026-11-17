import { z } from 'zod';
import { IsoDate, Uuid } from './common.js';

export const USAGE_GROUPS = [
  'day',
  'project',
  'ticket',
  'persona',
  'cli',
  'model',
  'member',
  'run',
] as const;
export const UsageGroup = z.enum(USAGE_GROUPS);
export type UsageGroup = z.infer<typeof UsageGroup>;

/** `GET /workspaces/:ws/usage?groupBy=&from=&to=&projectId=&ticketId=` */
export const UsageQuery = z.object({
  groupBy: UsageGroup.default('day'),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  projectId: Uuid.optional(),
  ticketId: Uuid.optional(),
});
export type UsageQuery = z.infer<typeof UsageQuery>;

export const UsageTotals = z.object({
  runs: z.number().int(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  reasoningTokens: z.number(),
  totalTokens: z.number(),
  /** Sum of CLI-reported costs. */
  reportedCostUsd: z.number(),
  /** Sum of price-table estimates for runs without a reported cost. */
  estimatedCostUsd: z.number(),
  /** Runs whose CLI exposed no usage at all. */
  runsWithoutUsage: z.number().int(),
  credits: z.number(),
  durationMs: z.number(),
});
export type UsageTotals = z.infer<typeof UsageTotals>;

export const UsageRow = UsageTotals.extend({ key: z.string(), label: z.string() });
export type UsageRow = z.infer<typeof UsageRow>;

export const UsageReport = z.object({
  groupBy: UsageGroup,
  from: IsoDate.nullable(),
  to: IsoDate.nullable(),
  totals: UsageTotals,
  rows: z.array(UsageRow),
});
export type UsageReport = z.infer<typeof UsageReport>;

/** USD per million tokens; used only for runs whose CLI reports no cost. */
export const ModelPrice = z.object({
  model: z.string().min(1).max(200),
  inputPerMTok: z.number().min(0),
  outputPerMTok: z.number().min(0),
  cacheReadPerMTok: z.number().min(0).default(0),
  cacheWritePerMTok: z.number().min(0).default(0),
});
export type ModelPrice = z.infer<typeof ModelPrice>;

/** `GET|PUT /workspaces/:ws/pricing` */
export const PricingTable = z.object({ prices: z.array(ModelPrice).max(500) });
export type PricingTable = z.infer<typeof PricingTable>;
