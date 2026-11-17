'use client';

import { type ModelPrice, USAGE_GROUPS, UsageGroup, type UsageTotals } from '@coffe/contracts';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useWorkspace } from '@/components/workspace/workspace-context';
import { errorMessage } from '@/lib/api';
import { formatCostUsd, formatDuration, formatTokens } from '@/lib/format';
import { can } from '@/lib/permissions';
import { usePricing, useSavePricing, useUsage } from '@/lib/queries/orchestration';
import { useProjects } from '@/lib/queries/projects';

const GROUP_LABELS: Record<UsageGroup, string> = {
  day: 'Day',
  project: 'Project',
  ticket: 'Ticket',
  persona: 'Persona',
  cli: 'CLI',
  model: 'Model',
  member: 'Member',
  run: 'Run',
};

const RANGES = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
] as const;

const DAY_MS = 86_400_000;

function Totals({ totals }: { totals: UsageTotals }) {
  const tiles = [
    {
      label: 'Runs',
      value: totals.runs.toLocaleString(),
      hint: totals.runsWithoutUsage > 0 ? `${totals.runsWithoutUsage} without usage data` : null,
    },
    {
      label: 'Tokens',
      value: formatTokens(totals.totalTokens),
      hint: `${formatTokens(totals.inputTokens)} in · ${formatTokens(totals.outputTokens)} out · ${formatTokens(totals.cacheReadTokens)} cached`,
    },
    {
      label: 'Reported cost',
      value: formatCostUsd(totals.reportedCostUsd),
      hint: 'as reported by the CLIs',
    },
    {
      label: 'Estimated cost',
      value: formatCostUsd(totals.estimatedCostUsd),
      hint: 'price table, for CLIs without cost',
    },
    {
      label: 'Credits',
      value: totals.credits > 0 ? totals.credits.toFixed(2) : '–',
      hint: 'Kiro and other credit-billed CLIs',
    },
    { label: 'Agent time', value: formatDuration(totals.durationMs), hint: null },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
      {tiles.map((tile) => (
        <Card key={tile.label} className="gap-1 py-4">
          <CardHeader className="px-4">
            <CardDescription>{tile.label}</CardDescription>
            <CardTitle className="text-xl tabular-nums">{tile.value}</CardTitle>
          </CardHeader>
          {tile.hint ? (
            <CardContent className="px-4 text-xs text-muted-foreground">{tile.hint}</CardContent>
          ) : null}
        </Card>
      ))}
    </div>
  );
}

function PricingEditor() {
  const { id: workspaceId } = useWorkspace();
  const pricing = usePricing(workspaceId);
  const save = useSavePricing(workspaceId);
  const [rows, setRows] = useState<ModelPrice[] | null>(null);
  const prices = rows ?? pricing.data?.prices ?? [];
  const update = (index: number, change: (price: ModelPrice) => ModelPrice) =>
    setRows(prices.map((price, at) => (at === index ? change(price) : price)));
  const numberCell = (index: number, key: Exclude<keyof ModelPrice, 'model'>, label: string) => (
    <Input
      aria-label={label}
      type="number"
      min={0}
      step="0.01"
      className="h-8 w-24 tabular-nums"
      value={prices[index]?.[key] ?? 0}
      onChange={(event) => {
        const value = Math.max(0, Number(event.target.value) || 0);
        update(index, (price) => ({ ...price, [key]: value }));
      }}
    />
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Price table</CardTitle>
        <CardDescription>
          USD per million tokens. Used only for runs whose CLI reports tokens but no cost.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {pricing.error ? (
          <p className="text-sm text-destructive">{errorMessage(pricing.error)}</p>
        ) : null}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead>Input</TableHead>
              <TableHead>Output</TableHead>
              <TableHead>Cache read</TableHead>
              <TableHead>Cache write</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {prices.map((price, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the model name is being edited; the row position is its stable identity
              <TableRow key={index}>
                <TableCell>
                  <Input
                    aria-label="Model"
                    className="h-8 font-mono"
                    value={price.model}
                    onChange={(event) => {
                      const model = event.target.value;
                      update(index, (current) => ({ ...current, model }));
                    }}
                  />
                </TableCell>
                <TableCell>
                  {numberCell(index, 'inputPerMTok', `${price.model} input price`)}
                </TableCell>
                <TableCell>
                  {numberCell(index, 'outputPerMTok', `${price.model} output price`)}
                </TableCell>
                <TableCell>
                  {numberCell(index, 'cacheReadPerMTok', `${price.model} cache read price`)}
                </TableCell>
                <TableCell>
                  {numberCell(index, 'cacheWritePerMTok', `${price.model} cache write price`)}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${price.model || 'row'}`}
                    onClick={() => setRows(prices.filter((_, at) => at !== index))}
                  >
                    <Trash2 />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() =>
              setRows([
                ...prices,
                {
                  model: '',
                  inputPerMTok: 0,
                  outputPerMTok: 0,
                  cacheReadPerMTok: 0,
                  cacheWritePerMTok: 0,
                },
              ])
            }
          >
            <Plus /> Add model
          </Button>
          <Button
            disabled={
              rows === null || save.isPending || prices.some((price) => price.model.trim() === '')
            }
            onClick={() =>
              save.mutate(
                { prices: prices.map((price) => ({ ...price, model: price.model.trim() })) },
                {
                  onSuccess: () => {
                    setRows(null);
                    toast.success('Prices saved; estimates updated');
                  },
                  onError: (error) => toast.error(errorMessage(error)),
                },
              )
            }
          >
            Save prices
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Token, cost and credit usage per run, persona, ticket, project, CLI, model or member (F10). */
export function UsagePage() {
  const { id: workspaceId, role } = useWorkspace();
  const projects = useProjects(workspaceId);
  const [groupBy, setGroupBy] = useState<UsageGroup>('day');
  const [range, setRange] = useState<(typeof RANGES)[number]['value']>('30');
  const [projectId, setProjectId] = useState('');
  // Day granularity keeps the query key stable across renders.
  const [today] = useState(() => Math.floor(Date.now() / DAY_MS) * DAY_MS);
  const usage = useUsage(workspaceId, {
    groupBy,
    from:
      range === 'all' ? undefined : new Date(today - (Number(range) - 1) * DAY_MS).toISOString(),
    projectId: projectId || undefined,
  });

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Usage</h1>
          <p className="text-sm text-muted-foreground">
            What the agents consumed. CLIs that report no tokens are counted as runs without usage.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-sm">
          <select
            aria-label="Group by"
            className="h-9 rounded-md border bg-transparent px-2"
            value={groupBy}
            onChange={(event) => setGroupBy(UsageGroup.catch('day').parse(event.target.value))}
          >
            {USAGE_GROUPS.map((group) => (
              <option key={group} value={group}>
                By {GROUP_LABELS[group].toLowerCase()}
              </option>
            ))}
          </select>
          <select
            aria-label="Period"
            className="h-9 rounded-md border bg-transparent px-2"
            value={range}
            onChange={(event) =>
              setRange(RANGES.find((option) => option.value === event.target.value)?.value ?? '30')
            }
          >
            {RANGES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            aria-label="Project"
            className="h-9 rounded-md border bg-transparent px-2"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">All projects</option>
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {usage.error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(usage.error)}
        </p>
      ) : !usage.data ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          <Totals totals={usage.data.totals} />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{GROUP_LABELS[usage.data.groupBy]}</TableHead>
                <TableHead className="text-right">Runs</TableHead>
                <TableHead className="text-right">Input</TableHead>
                <TableHead className="text-right">Output</TableHead>
                <TableHead className="text-right">Cached</TableHead>
                <TableHead className="text-right">Reported</TableHead>
                <TableHead className="text-right">Estimated</TableHead>
                <TableHead className="text-right">Credits</TableHead>
                <TableHead className="text-right">Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usage.data.rows.map((row) => (
                <TableRow key={row.key}>
                  <TableCell className="max-w-72 truncate font-medium" title={row.label}>
                    {row.label}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.runs}
                    {row.runsWithoutUsage > 0 ? (
                      <span className="text-muted-foreground"> ({row.runsWithoutUsage} n/a)</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatTokens(row.inputTokens)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatTokens(row.outputTokens)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatTokens(row.cacheReadTokens)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCostUsd(row.reportedCostUsd)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCostUsd(row.estimatedCostUsd)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.credits > 0 ? row.credits.toFixed(2) : '–'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDuration(row.durationMs)}
                  </TableCell>
                </TableRow>
              ))}
              {usage.data.rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground">
                    No runs in this period.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </>
      )}
      {can(role, 'project.manage') ? <PricingEditor /> : null}
    </div>
  );
}
