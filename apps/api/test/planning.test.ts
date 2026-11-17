import { Requirement, Ticket } from '@coffe/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { resetDatabase, startTestApp, type TestApp } from './support/app.js';
import { finishRun } from './support/runner-script.js';
import {
  eventually,
  expectStatus,
  type TicketScenario,
  ticketScenario,
} from './support/scenario.js';
import { api, signUpWithWorkspace } from './support/session.js';

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

const PLAN = {
  tickets: [
    {
      title: 'Add the badge component',
      description: 'A small counter next to the cart icon.',
      acceptance_criteria: ['Shows the number of items'],
      depends_on: [],
      suggested_role: 'implementer',
      estimate: 'S',
    },
    {
      title: 'Wire the badge to the cart store',
      description: 'Subscribe to cart changes.',
      acceptance_criteria: ['Updates when items are added'],
      depends_on: [0],
      suggested_role: null,
      estimate: null,
    },
  ],
};

async function requirementScenario() {
  const s = await ticketScenario(t, await signUpWithWorkspace(t), {
    settings: { defaultCliId: 'fake' },
  });
  scenarios.push(s);
  const requirement = Requirement.parse(
    expectStatus(
      await api(t, s.owner).post(
        `/workspaces/${s.owner.workspaceId}/projects/${s.project.id}/requirements`,
        {
          title: 'Cart badge',
          body: 'Customers should see how many items are in their cart.',
        },
      ),
      201,
    ),
  );
  return { s, requirement };
}

function getRequirement(s: TicketScenario, id: string) {
  return api(t, s.owner)
    .get(`/workspaces/${s.owner.workspaceId}/requirements/${id}`)
    .then((response) => Requirement.parse(expectStatus(response, 200)));
}

describe('planning', () => {
  it('runs a read-only planner and turns its JSON answer into ordered drafts', async () => {
    const { s, requirement } = await requirementScenario();
    const planning = Requirement.parse(
      expectStatus(
        await api(t, s.owner).post(
          `/workspaces/${s.owner.workspaceId}/requirements/${requirement.id}/plan`,
          {},
        ),
        200,
      ),
    );
    expect(planning.status).toBe('planning');

    const start = (await s.runner.next('run.start')).payload;
    expect(start).toMatchObject({
      kind: 'planning',
      worktree: { mode: 'detached' },
      auto_commit: false,
      test_command: null,
    });
    expect(start.permissions.mode).toBe('read_only');
    expect(start.persona?.role).toBe('planner');
    expect(start.output_schema).toBeDefined();
    expect(start.context.files.map((file) => file.name)).toContain('40-requirement.md');

    finishRun(s.runner, start, {
      summary: `Here is the plan:\n\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\``,
    });
    const planned = await eventually(
      () => getRequirement(s, requirement.id),
      (current) => current.status !== 'planning',
      'the planned requirement',
    );
    expect(planned.status).toBe('review');
    expect(planned.drafts.map((draft) => [draft.position, draft.title, draft.dependsOn])).toEqual([
      [0, 'Add the badge component', []],
      [1, 'Wire the badge to the cart store', [0]],
    ]);
  });

  it('records an unusable answer as a failed plan', async () => {
    const { s, requirement } = await requirementScenario();
    await api(t, s.owner).post(
      `/workspaces/${s.owner.workspaceId}/requirements/${requirement.id}/plan`,
      {},
    );
    finishRun(s.runner, (await s.runner.next('run.start')).payload, {
      summary: 'I think you should add a badge.',
    });
    const failed = await eventually(
      () => getRequirement(s, requirement.id),
      (current) => current.status !== 'planning',
      'the failed plan',
    );
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/plan schema/);
    expect(failed.drafts).toEqual([]);
  });

  it('creates Backlog tickets with dependencies from the approved drafts', async () => {
    const { s, requirement } = await requirementScenario();
    await api(t, s.owner).post(
      `/workspaces/${s.owner.workspaceId}/requirements/${requirement.id}/plan`,
      {},
    );
    finishRun(s.runner, (await s.runner.next('run.start')).payload, {
      summary: JSON.stringify(PLAN),
    });
    const planned = await eventually(
      () => getRequirement(s, requirement.id),
      (current) => current.status === 'review',
      'the planned requirement',
    );
    // A human adjusts the first draft before approving.
    const [first] = planned.drafts;
    expectStatus(
      await api(t, s.owner).patch(
        `/workspaces/${s.owner.workspaceId}/requirements/${requirement.id}/drafts/${first?.id}`,
        {
          title: 'Add the CartBadge component',
        },
      ),
      200,
    );

    const tickets = z
      .array(Ticket)
      .parse(
        expectStatus(
          await api(t, s.owner).post(
            `/workspaces/${s.owner.workspaceId}/requirements/${requirement.id}/approve`,
            {},
          ),
          200,
        ),
      );
    expect(tickets.map((ticket) => [ticket.key, ticket.title, ticket.status])).toEqual([
      ['SHOP-2', 'Add the CartBadge component', 'backlog'],
      ['SHOP-3', 'Wire the badge to the cart store', 'backlog'],
    ]);
    const dependencies = await t.db.execute<{ ticket_id: string; depends_on_id: string }>(
      sql`select ticket_id, depends_on_id from ticket_dependencies`,
    );
    expect(dependencies.rows).toEqual([
      { ticket_id: tickets[1]?.id, depends_on_id: tickets[0]?.id },
    ]);
    expect((await getRequirement(s, requirement.id)).status).toBe('approved');

    // The dependent ticket waits for the first one: shown on the ticket, enforced on start.
    const [badge, wiring] = tickets;
    expect(badge?.blockedBy).toEqual([]);
    expect(wiring?.blockedBy).toEqual([{ id: badge?.id, key: 'SHOP-2', status: 'backlog' }]);
    expect(wiring?.flags.blocked).toBe(true);
    const blocked = await api(t, s.owner).post(
      `/workspaces/${s.owner.workspaceId}/tickets/${wiring?.id}/start`,
      {},
    );
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({
      error: { code: 'ticket_blocked', message: 'Blocked by SHOP-2: finish those tickets first' },
    });

    expectStatus(
      await api(t, s.owner).post(`/workspaces/${s.owner.workspaceId}/tickets/${badge?.id}/move`, {
        status: 'done',
      }),
      200,
    );
    const unblocked = Ticket.parse(
      expectStatus(
        await api(t, s.owner).get(`/workspaces/${s.owner.workspaceId}/tickets/${wiring?.id}`),
        200,
      ),
    );
    expect(unblocked.blockedBy).toEqual([]);
    expect(unblocked.flags.blocked).toBe(false);
  });
});
