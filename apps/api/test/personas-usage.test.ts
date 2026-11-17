import { ContextPreview, Persona, PricingTable, Run, UsageReport } from '@coffe/contracts';
import type { Usage } from '@coffe/protocol';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildContextFiles, MAX_BUNDLE_BYTES } from '../src/context/context-bundle.js';
import { resetDatabase, startTestApp, type TestApp } from './support/app.js';
import { finishRun } from './support/runner-script.js';
import {
  eventually,
  expectStatus,
  startRun,
  type TicketScenario,
  ticketScenario,
} from './support/scenario.js';
import { addMember, api, signUpWithWorkspace } from './support/session.js';

let t: TestApp;
const scenarios: TicketScenario[] = [];

beforeAll(async () => {
  t = await startTestApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetDatabase(t.db);
});
afterEach(async () => {
  for (const scenario of scenarios.splice(0)) await scenario.runner.close();
});

async function scenario(): Promise<TicketScenario> {
  const created = await ticketScenario(t, await signUpWithWorkspace(t), {
    settings: { defaultCliId: 'fake' },
  });
  scenarios.push(created);
  return created;
}

describe('personas', () => {
  it('lists limits the chosen CLI cannot enforce', async () => {
    const s = await scenario();
    const created = Persona.parse(
      expectStatus(
        await api(t, s.owner).post(`/workspaces/${s.owner.workspaceId}/personas`, {
          name: 'Sandboxed implementer',
          role: 'implementer',
          cliId: 'codex',
          permissions: {
            mode: 'workspace_write',
            denyTools: ['Bash(rm:*)'],
            network: false,
            maxBudgetUsd: 2,
          },
        }),
        201,
      ),
    );
    expect(created.unenforceable).toEqual([
      'tool allow/deny rules: Codex has no per-tool rules',
      'budget: Codex reports no cost to cap',
    ]);

    const switched = Persona.parse(
      expectStatus(
        await api(t, s.owner).patch(`/workspaces/${s.owner.workspaceId}/personas/${created.id}`, {
          cliId: 'claude-code',
        }),
        200,
      ),
    );
    expect(switched.unenforceable).toEqual([]);
    expect(switched.permissions.denyTools).toEqual(['Bash(rm:*)']);
  });

  it('archives personas and keeps reviewers from editing them', async () => {
    const s = await scenario();
    const reviewer = await addMember(t, s.owner, 'reviewer');
    const personas = z
      .array(Persona)
      .parse(
        expectStatus(await api(t, s.owner).get(`/workspaces/${s.owner.workspaceId}/personas`), 200),
      );
    const [planner] = personas;
    expect(
      (await api(t, reviewer).del(`/workspaces/${s.owner.workspaceId}/personas/${planner?.id}`))
        .status,
    ).toBe(403);
    expect(
      (await api(t, s.owner).del(`/workspaces/${s.owner.workspaceId}/personas/${planner?.id}`))
        .status,
    ).toBe(204);
    const remaining = z
      .array(Persona)
      .parse(
        expectStatus(await api(t, s.owner).get(`/workspaces/${s.owner.workspaceId}/personas`), 200),
      );
    expect(remaining.map((persona) => persona.id)).not.toContain(planner?.id);
  });

  it('runs a ticket with the persona assigned to it', async () => {
    const s = await scenario();
    const personas = z
      .array(Persona)
      .parse(
        expectStatus(await api(t, s.owner).get(`/workspaces/${s.owner.workspaceId}/personas`), 200),
      );
    const tester = personas.find((persona) => persona.role === 'tester');
    const { start } = await startRun(t, s, { personaId: tester?.id });
    expect(start.persona).toEqual({ id: tester?.id, name: 'Tester', role: 'tester' });
    expect(start.context.files.find((file) => file.name === '20-persona.md')?.content).toContain(
      'Your role: Tester',
    );
  });
});

describe('project context', () => {
  it('sends enabled rules and knowledge with every run, in order', async () => {
    const s = await scenario();
    const client = api(t, s.owner);
    const base = `/workspaces/${s.owner.workspaceId}/projects/${s.project.id}/context`;
    expectStatus(await client.post(base, { kind: 'rule', title: 'Style', body: 'Use tabs.' }), 201);
    expectStatus(
      await client.post(base, { kind: 'knowledge', title: 'Architecture', body: 'Hexagonal.' }),
      201,
    );
    expectStatus(
      await client.post(base, {
        kind: 'rule',
        title: 'Old rule',
        body: 'Ignore me.',
        enabled: false,
      }),
      201,
    );

    const preview = ContextPreview.parse(
      expectStatus(await client.get(`${base}/preview?ticketId=${s.ticket.id}`), 200),
    );
    expect(preview.files.map((file) => file.name)).toEqual([
      '00-coffe-rules.md',
      '10-project-rules.md',
      '30-knowledge.md',
      '40-ticket.md',
    ]);
    const rules = preview.files.find((file) => file.name === '10-project-rules.md')?.content ?? '';
    expect(rules).toContain('Use tabs.');
    expect(rules).not.toContain('Ignore me.');

    const { start } = await startRun(t, s);
    expect(start.context.files.map((file) => file.name)).toEqual(
      preview.files.map((file) => file.name),
    );
  });

  it('refuses previews of tickets and personas from another workspace', async () => {
    const s = await scenario();
    const other = await scenario();
    const preview = `/workspaces/${s.owner.workspaceId}/projects/${s.project.id}/context/preview`;
    expect((await api(t, s.owner).get(`${preview}?ticketId=${other.ticket.id}`)).status).toBe(404);
    const foreign = z
      .array(Persona)
      .parse(
        expectStatus(
          await api(t, other.owner).get(`/workspaces/${other.owner.workspaceId}/personas`),
          200,
        ),
      );
    expect((await api(t, s.owner).get(`${preview}?personaId=${foreign[0]?.id}`)).status).toBe(404);
  });

  it('drops knowledge before rules to stay under the bundle cap', () => {
    const big = 'x'.repeat(300 * 1024);
    const files = buildContextFiles({
      kind: 'ticket',
      ticket: { key: 'T-1', title: 'T', description: '', acceptanceCriteria: [] },
      requirement: null,
      persona: null,
      rules: [{ title: 'Rule', body: big }],
      knowledge: [
        { title: 'First', body: big },
        { title: 'Second', body: big },
      ],
      handoff: 'Previous step notes',
    });
    const total = files.reduce(
      (sum, file) => sum + Buffer.byteLength(file.name) + Buffer.byteLength(file.content),
      0,
    );
    expect(total).toBeLessThanOrEqual(MAX_BUNDLE_BYTES);
    const knowledge = files.find((file) => file.name === '30-knowledge.md')?.content ?? '';
    expect(knowledge).not.toContain('## Second');
    expect(files.find((file) => file.name === '10-project-rules.md')?.content).toContain(big);
    expect(files.map((file) => file.name)).toContain('50-handoff.md');
  });
});

describe('usage', () => {
  it('sums reported cost and estimates the rest from the price table', async () => {
    const s = await scenario();
    const client = api(t, s.owner);
    expectStatus(
      await client.put(`/workspaces/${s.owner.workspaceId}/pricing`, {
        prices: [{ model: 'fake-model', inputPerMTok: 1, outputPerMTok: 2 }],
      }),
      200,
    );
    const tokens = { cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0 };
    const usages: (Usage | null)[] = [
      {
        available: true,
        input_tokens: 1000,
        output_tokens: 200,
        ...tokens,
        cost_usd: 0.04,
        model: 'claude-x',
      },
      // No reported cost: estimated as (1000 × 1 + 500 × 2) / 1e6 = 0.002.
      {
        available: true,
        input_tokens: 1000,
        output_tokens: 500,
        ...tokens,
        model: 'fake-model-2026',
      },
      null,
    ];
    for (const usage of usages) {
      const { start, run } = await startRun(t, s);
      finishRun(s.runner, start, { usage });
      await eventually(
        () =>
          client
            .get(`/workspaces/${s.owner.workspaceId}/runs/${run.id}`)
            .then((response) => Run.parse(expectStatus(response, 200))),
        (current) => current.endedAt !== null,
        'the finished run',
      );
    }

    const report = UsageReport.parse(
      expectStatus(await client.get(`/workspaces/${s.owner.workspaceId}/usage?groupBy=model`), 200),
    );
    expect(report.totals.runs).toBe(3);
    expect(report.totals.inputTokens).toBe(2000);
    expect(report.totals.reportedCostUsd).toBeCloseTo(0.04, 6);
    expect(report.totals.estimatedCostUsd).toBeCloseTo(0.002, 6);
    expect(report.totals.runsWithoutUsage).toBe(1);
    expect(report.rows.map((row) => row.key)).toEqual(['claude-x', 'fake-model-2026', 'unknown']);
    expect(
      PricingTable.parse(
        expectStatus(await client.get(`/workspaces/${s.owner.workspaceId}/pricing`), 200),
      ).prices,
    ).toHaveLength(1);
  });
});
