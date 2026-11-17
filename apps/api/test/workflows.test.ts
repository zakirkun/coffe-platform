import { Persona, ReviewState, Ticket, Workflow, WorkflowInstance } from '@coffe/contracts';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runs } from '../src/db/schema/index.js';
import { OrchestratorService } from '../src/workflows/orchestrator.service.js';
import { resetDatabase, startTestApp, type TestApp } from './support/app.js';
import { diffOf, finishRun } from './support/runner-script.js';
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

/** A ticket in a project whose seeded personas use the fake CLI. */
async function scenario(): Promise<TicketScenario> {
  const created = await ticketScenario(t, await signUpWithWorkspace(t), {
    settings: { defaultCliId: 'fake' },
  });
  scenarios.push(created);
  return created;
}

const TEST_PASSED =
  '\nAll good.\n```coffe-test-report\n{"status":"passed","passed":3,"failed":0,"skipped":0,"command":"pnpm test"}\n```\n';
const TEST_FAILED =
  '```coffe-test-report\n{"status":"failed","passed":2,"failed":1,"failures":[{"name":"badge renders","message":"expected 3"}]}\n```';
const APPROVE = 'Looks right.\n```coffe-review\n{"verdict":"approve","comments":[]}\n```';
const CHANGES =
  '```coffe-review\n{"verdict":"request_changes","comments":["Rename the badge component"]}\n```';

function workflowOf(s: TicketScenario) {
  return api(t, s.owner)
    .get(`/workspaces/${s.owner.workspaceId}/tickets/${s.ticket.id}/workflow`)
    .then((response) => WorkflowInstance.parse(expectStatus(response, 200)));
}

function ticketOf(s: TicketScenario) {
  return api(t, s.owner)
    .get(`/workspaces/${s.owner.workspaceId}/tickets/${s.ticket.id}`)
    .then((response) => Ticket.parse(expectStatus(response, 200)));
}

async function start(s: TicketScenario): Promise<WorkflowInstance> {
  return WorkflowInstance.parse(
    expectStatus(
      await api(t, s.owner).post(
        `/workspaces/${s.owner.workspaceId}/tickets/${s.ticket.id}/start`,
        {},
      ),
      201,
    ),
  );
}

describe('default workflow', () => {
  it('seeds the starter personas and workflow with the first project', async () => {
    const s = await scenario();
    const personas = z
      .array(Persona)
      .parse(
        expectStatus(await api(t, s.owner).get(`/workspaces/${s.owner.workspaceId}/personas`), 200),
      );
    expect(personas.map((persona) => [persona.role, persona.cliId])).toEqual([
      ['planner', 'fake'],
      ['implementer', 'fake'],
      ['tester', 'fake'],
      ['reviewer', 'fake'],
    ]);
    const workflows = z
      .array(Workflow)
      .parse(
        expectStatus(
          await api(t, s.owner).get(
            `/workspaces/${s.owner.workspaceId}/projects/${s.project.id}/workflows`,
          ),
          200,
        ),
      );
    expect(workflows).toHaveLength(1);
    expect(workflows[0]?.steps.map((step) => [step.key, step.onFail])).toEqual([
      ['implement', 'stop'],
      ['test', 'goto:implement'],
      ['review', 'goto:implement'],
    ]);
  });

  it('runs implementer, tester and reviewer, loops on requested changes, then hands over to review', async () => {
    const s = await scenario();
    const instance = await start(s);
    expect(instance).toMatchObject({
      status: 'running',
      currentStepKey: 'implement',
      workflowName: 'Implement → Test → Review',
    });
    expect((await ticketOf(s)).status).toBe('in_progress');

    const implement = (await s.runner.next('run.start')).payload;
    expect(implement.persona?.role).toBe('implementer');
    expect(implement.context.files.map((file) => file.name)).toContain('20-persona.md');
    expect(implement.context.files.some((file) => file.name === '50-handoff.md')).toBe(false);
    finishRun(s.runner, implement, { summary: 'Added the badge.', diff: diffOf('src/badge.ts') });

    const test = (await s.runner.next('run.start')).payload;
    expect(test.persona?.role).toBe('tester');
    expect(test.context.files.find((file) => file.name === '50-handoff.md')?.content).toContain(
      'Added the badge.',
    );
    expect(test.context.files.find((file) => file.name === '00-coffe-rules.md')?.content).toContain(
      'coffe-test-report',
    );
    finishRun(s.runner, test, { summary: TEST_PASSED });

    const review = (await s.runner.next('run.start')).payload;
    expect(review.persona?.role).toBe('reviewer');
    expect(review.permissions.mode).toBe('read_only');
    expect(review.auto_commit).toBe(false);
    finishRun(s.runner, review, { summary: CHANGES });

    // The reviewer's comments go back to the implementer.
    const again = (await s.runner.next('run.start')).payload;
    expect(again.persona?.role).toBe('implementer');
    expect(again.context.files.find((file) => file.name === '50-handoff.md')?.content).toContain(
      'Rename the badge component',
    );
    expect(again.prompt).toContain('50-handoff.md');
    finishRun(s.runner, again, {
      summary: 'Renamed it.',
      diff: diffOf('src/badge.ts', 'c'.repeat(40)),
    });
    finishRun(s.runner, (await s.runner.next('run.start')).payload, { summary: TEST_PASSED });
    finishRun(s.runner, (await s.runner.next('run.start')).payload, { summary: APPROVE });

    const done = await eventually(
      () => workflowOf(s),
      (current) => current.status !== 'running',
      'the finished workflow',
    );
    expect(done.status).toBe('completed');
    expect(done.steps.map((step) => [step.key, step.status, step.loops])).toEqual([
      ['implement', 'completed', 0],
      ['test', 'completed', 0],
      ['review', 'completed', 1],
    ]);
    const ticket = await ticketOf(s);
    expect(ticket.status).toBe('in_review');
    expect(ticket.flags.failed).toBe(false);

    const reviewState = ReviewState.parse(
      expectStatus(
        await api(t, s.owner).get(
          `/workspaces/${s.owner.workspaceId}/tickets/${s.ticket.id}/review`,
        ),
        200,
      ),
    );
    expect(
      reviewState.tests.filter((test) => test.source === 'agent').map((test) => test.status),
    ).toEqual(['passed', 'passed']);
  });

  it('gives up after the loop limit and leaves the decision to a human reviewer', async () => {
    const s = await scenario();
    await start(s);
    finishRun(s.runner, (await s.runner.next('run.start')).payload, {
      diff: diffOf('src/badge.ts'),
    });
    // Tests keep failing: implement → test twice more (max_loops 2), then the workflow stops.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const test = (await s.runner.next('run.start')).payload;
      expect(test.persona?.role).toBe('tester');
      finishRun(s.runner, test, { summary: TEST_FAILED });
      if (attempt < 2) {
        const implement = (await s.runner.next('run.start')).payload;
        expect(
          implement.context.files.find((file) => file.name === '50-handoff.md')?.content,
        ).toContain('badge renders');
        finishRun(s.runner, implement, { diff: diffOf('src/badge.ts') });
      }
    }
    const done = await eventually(
      () => workflowOf(s),
      (current) => current.status !== 'running',
      'the failed workflow',
    );
    expect(done.status).toBe('failed');
    expect(done.steps.find((step) => step.key === 'test')).toMatchObject({
      status: 'failed',
      loops: 2,
    });
    const ticket = await ticketOf(s);
    expect(ticket.status).toBe('in_review');
    expect(ticket.flags.failed).toBe(true);
  });

  it('fails the workflow when a step run crashes and lets the user cancel', async () => {
    const s = await scenario();
    await start(s);
    finishRun(s.runner, (await s.runner.next('run.start')).payload, {
      status: 'failed',
      error: 'CLI crashed',
    });
    const failed = await eventually(
      () => workflowOf(s),
      (current) => current.status !== 'running',
      'the failed workflow',
    );
    expect(failed.status).toBe('failed');
    expect(failed.steps[0]?.outcome).toContain('CLI crashed');
    expect((await ticketOf(s)).flags.failed).toBe(true);

    // A second attempt can be cancelled while its run is active.
    await start(s);
    const run = (await s.runner.next('run.start')).payload;
    const cancelled = WorkflowInstance.parse(
      expectStatus(
        await api(t, s.owner).post(
          `/workspaces/${s.owner.workspaceId}/tickets/${s.ticket.id}/workflow/cancel`,
        ),
        200,
      ),
    );
    expect(cancelled.status).toBe('cancelled');
    expect((await s.runner.next('run.signal')).payload).toEqual({
      run_id: run.run_id,
      signal: 'stop',
    });
  });

  it('resumes a workflow whose step ended while the API was down', async () => {
    const s = await scenario();
    await start(s);
    const implement = (await s.runner.next('run.start')).payload;
    // The run's completion reached the database, but the API stopped before advancing the workflow.
    await t.db
      .update(runs)
      .set({ status: 'completed', endedAt: new Date(), resultSummary: 'Added the badge.' })
      .where(eq(runs.id, implement.run_id));

    await t.app.get(OrchestratorService).reconcile();
    const test = (await s.runner.next('run.start')).payload;
    expect(test.persona?.role).toBe('tester');
    expect(test.context.files.find((file) => file.name === '50-handoff.md')?.content).toContain(
      'Added the badge.',
    );
    expect((await workflowOf(s)).steps.map((step) => step.status)).toEqual([
      'completed',
      'running',
      'pending',
    ]);
  });
});

describe('custom workflows', () => {
  it('runs read-only reviewers of one step in parallel and joins them', async () => {
    const s = await scenario();
    const client = api(t, s.owner);
    const personas = z
      .array(Persona)
      .parse(expectStatus(await client.get(`/workspaces/${s.owner.workspaceId}/personas`), 200));
    const byRole = (role: string) => personas.find((persona) => persona.role === role)?.id ?? '';
    const security = Persona.parse(
      expectStatus(
        await client.post(`/workspaces/${s.owner.workspaceId}/personas`, {
          name: 'Security reviewer',
          role: 'reviewer',
          cliId: 'fake',
          permissions: { mode: 'read_only' },
        }),
        201,
      ),
    );
    const workflow = Workflow.parse(
      expectStatus(
        await client.post(`/workspaces/${s.owner.workspaceId}/projects/${s.project.id}/workflows`, {
          name: 'Build then double review',
          isDefault: true,
          steps: [
            { key: 'build', name: 'Build', personaIds: [byRole('implementer')] },
            {
              key: 'review',
              name: 'Review',
              personaIds: [byRole('reviewer'), security.id],
              parallel: true,
              onFail: 'goto:build',
            },
          ],
        }),
        201,
      ),
    );
    await client.post(`/workspaces/${s.owner.workspaceId}/tickets/${s.ticket.id}/start`, {
      workflowId: workflow.id,
    });
    finishRun(s.runner, (await s.runner.next('run.start')).payload, { diff: diffOf('src/a.ts') });

    const first = (await s.runner.next('run.start')).payload;
    const second = (await s.runner.next('run.start')).payload;
    expect(new Set([first.persona?.name, second.persona?.name])).toEqual(
      new Set(['Reviewer', 'Security reviewer']),
    );
    finishRun(s.runner, first, { summary: APPROVE });
    // The step waits for the second reviewer.
    expect((await workflowOf(s)).status).toBe('running');
    finishRun(s.runner, second, { summary: APPROVE });

    const done = await eventually(
      () => workflowOf(s),
      (current) => current.status !== 'running',
      'the joined workflow',
    );
    expect(done.status).toBe('completed');
  });

  it('rejects parallel steps with personas that write', async () => {
    const s = await scenario();
    const client = api(t, s.owner);
    const personas = z
      .array(Persona)
      .parse(expectStatus(await client.get(`/workspaces/${s.owner.workspaceId}/personas`), 200));
    const writers = personas
      .filter((persona) => persona.permissions.mode !== 'read_only')
      .map((persona) => persona.id);
    const response = await client.post(
      `/workspaces/${s.owner.workspaceId}/projects/${s.project.id}/workflows`,
      {
        name: 'Two implementers',
        steps: [{ key: 'build', name: 'Build', personaIds: writers, parallel: true }],
      },
    );
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: 'invalid_workflow' } });
  });
});
