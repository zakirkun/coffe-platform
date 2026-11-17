import type {
  ModelPrice,
  PricingTable,
  UsageGroup,
  UsageQuery,
  UsageReport,
  UsageRow,
  UsageTotals,
} from '@coffe/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { eq, type SQL, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { DB } from '../db/db.module.js';
import { type ModelPriceJson, workspaceSettings } from '../db/schema/index.js';

/** Group key and label of each `groupBy` (SQL over `runs r`, `run_usage u` and the joins below). */
const GROUPS: Record<UsageGroup, { key: SQL; label: SQL }> = {
  day: {
    key: sql`to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD')`,
    label: sql`to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD')`,
  },
  project: { key: sql`r.project_id::text`, label: sql`coalesce(p.name, 'Deleted project')` },
  ticket: {
    key: sql`coalesce(r.ticket_id::text, 'none')`,
    label: sql`coalesce(t.key || ': ' || t.title, 'No ticket')`,
  },
  persona: {
    key: sql`coalesce(r.persona_id::text, 'none')`,
    label: sql`coalesce(pe.name, 'No persona')`,
  },
  cli: { key: sql`r.cli_id`, label: sql`r.cli_id` },
  model: {
    key: sql`coalesce(u.model, r.model, 'unknown')`,
    label: sql`coalesce(u.model, r.model, 'unknown')`,
  },
  member: {
    key: sql`coalesce(r.requested_by, 'automation')`,
    label: sql`coalesce(us.name, 'Automation')`,
  },
  run: {
    key: sql`r.id::text`,
    label: sql`r.cli_id || ' · ' || to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI')`,
  },
};

interface Bucket extends Record<string, unknown> {
  key: string;
  label: string;
  model: string;
  runs: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
  total: number;
  reported: number;
  est_input: number;
  est_output: number;
  est_cache_read: number;
  est_cache_write: number;
  without_usage: number;
  credits: number;
  duration: number;
}

const EMPTY_TOTALS: UsageTotals = {
  runs: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  reportedCostUsd: 0,
  estimatedCostUsd: 0,
  runsWithoutUsage: 0,
  credits: 0,
  durationMs: 0,
};

function toPrice(row: ModelPriceJson): ModelPrice {
  return {
    model: row.model,
    inputPerMTok: row.input_per_mtok,
    outputPerMTok: row.output_per_mtok,
    cacheReadPerMTok: row.cache_read_per_mtok,
    cacheWritePerMTok: row.cache_write_per_mtok,
  };
}

/** The price of `model`: exact match first, else the longest priced name it starts with. */
export function priceFor(prices: readonly ModelPrice[], model: string): ModelPrice | undefined {
  const exact = prices.find((price) => price.model === model);
  if (exact) return exact;
  return prices
    .filter((price) => model.startsWith(price.model))
    .toSorted((a, b) => b.model.length - a.model.length)[0];
}

function addBucket(
  target: UsageTotals,
  bucket: Bucket,
  prices: readonly ModelPrice[],
): UsageTotals {
  const price = priceFor(prices, bucket.model);
  const estimated = price
    ? (bucket.est_input * price.inputPerMTok +
        bucket.est_output * price.outputPerMTok +
        bucket.est_cache_read * price.cacheReadPerMTok +
        bucket.est_cache_write * price.cacheWritePerMTok) /
      1_000_000
    : 0;
  return {
    runs: target.runs + bucket.runs,
    inputTokens: target.inputTokens + bucket.input,
    outputTokens: target.outputTokens + bucket.output,
    cacheReadTokens: target.cacheReadTokens + bucket.cache_read,
    cacheWriteTokens: target.cacheWriteTokens + bucket.cache_write,
    reasoningTokens: target.reasoningTokens + bucket.reasoning,
    totalTokens: target.totalTokens + bucket.total,
    reportedCostUsd: target.reportedCostUsd + bucket.reported,
    estimatedCostUsd: target.estimatedCostUsd + estimated,
    runsWithoutUsage: target.runsWithoutUsage + bucket.without_usage,
    credits: target.credits + bucket.credits,
    durationMs: target.durationMs + bucket.duration,
  };
}

/** Usage monitor (architecture §12.6): tokens, reported and estimated cost, credits. */
@Injectable()
export class UsageService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async report(workspaceId: string, query: UsageQuery): Promise<UsageReport> {
    const group = GROUPS[query.groupBy];
    const filters = [sql`r.workspace_id = ${workspaceId}`];
    if (query.from) filters.push(sql`r.created_at >= ${query.from}`);
    if (query.to) filters.push(sql`r.created_at < ${query.to}`);
    if (query.projectId) filters.push(sql`r.project_id = ${query.projectId}`);
    if (query.ticketId) filters.push(sql`r.ticket_id = ${query.ticketId}`);

    const result = await this.db.execute<Bucket>(sql`
      select ${group.key} as key, ${group.label} as label, coalesce(u.model, r.model, 'unknown') as model,
        count(*)::int as runs,
        coalesce(sum(u.input_tokens), 0)::float8 as input,
        coalesce(sum(u.output_tokens), 0)::float8 as output,
        coalesce(sum(u.cache_read_tokens), 0)::float8 as cache_read,
        coalesce(sum(u.cache_write_tokens), 0)::float8 as cache_write,
        coalesce(sum(u.reasoning_tokens), 0)::float8 as reasoning,
        coalesce(sum(u.total_tokens), 0)::float8 as total,
        coalesce(sum(u.cost_usd), 0)::float8 as reported,
        coalesce(sum(u.input_tokens) filter (where u.cost_usd is null and u.available), 0)::float8 as est_input,
        coalesce(sum(u.output_tokens) filter (where u.cost_usd is null and u.available), 0)::float8 as est_output,
        coalesce(sum(u.cache_read_tokens) filter (where u.cost_usd is null and u.available), 0)::float8 as est_cache_read,
        coalesce(sum(u.cache_write_tokens) filter (where u.cost_usd is null and u.available), 0)::float8 as est_cache_write,
        (count(*) filter (where u.run_id is null or not u.available))::int as without_usage,
        coalesce(sum(u.credits), 0)::float8 as credits,
        coalesce(sum(u.duration_ms), 0)::float8 as duration
      from runs r
      left join run_usage u on u.run_id = r.id
      left join projects p on p.id = r.project_id
      left join tickets t on t.id = r.ticket_id
      left join personas pe on pe.id = r.persona_id
      left join "user" us on us.id = r.requested_by
      where ${sql.join(filters, sql` and `)}
      group by 1, 2, 3
    `);

    const prices = await this.prices(workspaceId);
    const rows = new Map<string, UsageRow>();
    let totals = EMPTY_TOTALS;
    for (const bucket of result.rows) {
      totals = addBucket(totals, bucket, prices);
      const current = rows.get(bucket.key) ?? {
        ...EMPTY_TOTALS,
        key: bucket.key,
        label: bucket.label,
      };
      rows.set(bucket.key, {
        ...addBucket(current, bucket, prices),
        key: bucket.key,
        label: bucket.label,
      });
    }
    const ordered = [...rows.values()].toSorted((a, b) =>
      query.groupBy === 'day'
        ? a.key.localeCompare(b.key)
        : b.reportedCostUsd + b.estimatedCostUsd - (a.reportedCostUsd + a.estimatedCostUsd) ||
          b.totalTokens - a.totalTokens,
    );
    return {
      groupBy: query.groupBy,
      from: query.from ?? null,
      to: query.to ?? null,
      totals,
      rows: ordered,
    };
  }

  async pricing(workspaceId: string): Promise<PricingTable> {
    return { prices: await this.prices(workspaceId) };
  }

  async setPricing(workspaceId: string, table: PricingTable): Promise<PricingTable> {
    const pricing: ModelPriceJson[] = table.prices.map((price) => ({
      model: price.model.trim(),
      input_per_mtok: price.inputPerMTok,
      output_per_mtok: price.outputPerMTok,
      cache_read_per_mtok: price.cacheReadPerMTok,
      cache_write_per_mtok: price.cacheWritePerMTok,
    }));
    await this.db
      .insert(workspaceSettings)
      .values({ workspaceId, pricing })
      .onConflictDoUpdate({
        target: workspaceSettings.workspaceId,
        set: { pricing, updatedAt: new Date() },
      });
    return { prices: pricing.map(toPrice) };
  }

  private async prices(workspaceId: string): Promise<ModelPrice[]> {
    const [settings] = await this.db
      .select({ pricing: workspaceSettings.pricing })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, workspaceId))
      .limit(1);
    return (settings?.pricing ?? []).map(toPrice);
  }
}
