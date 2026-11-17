import { AuditPage, ReviewState, Run, RunEventsResponse, RunOutputResponse, Ticket } from '@coffe/contracts';
import type { DiffSummary, RunnerMessage } from '@coffe/protocol';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase, startTestApp, type TestApp } from './support/app.js';
import { BrowserSocket } from './support/browser-socket.js';
import { type TicketScenario, eventually, expectStatus, startRun, ticketScenario } from './support/scenario.js';
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

async function scenario(): Promise<TicketScenario> {
  const created = await ticketScenario(t, await signUpWithWorkspace(t));
  scenarios.push(created);
  return created;
}

const DIFF: DiffSummary = {
  base_commit: 'a'.repeat(40),
  head_commit: 'b'.repeat(40),
  additions: 3,
  deletions: 1,
  files: [{ path: 'src/cart.ts', status: 'modified', additions: 3, deletions: 1, binary: false }],
  patch: 'diff --git a/src/cart.ts b/src/cart.ts\n--- a/src/cart.ts\n+++ b/src/cart.ts\n@@ -1 +1,3 @@\n-old\n+new\n+badge\n+count\n',
  truncated: false,
};

function base64(text: string): string {
  return Buffer.from(text).toString('base64');
}

function getTicket(s: TicketScenario): Promise<Ticket> {
  return api(t, s.owner)
    .get(`/workspaces/${s.owner.workspaceId}/tickets/${s.ticket.id}`)
    .then((response) => Ticket.parse(expectStatus(response, 200)));
}

function getRun(s: TicketScenario, runId: string): Promise<Run> {
  return api(t, s.owner)
    .get(`/workspaces/${s.owner.workspaceId}/runs/${runId}`)
    .then((response) => Run.parse(expectStatus(response, 200)));
}

/** Reports a running run with its worktree, as the runner does right after `run.start`. */
function reportRunning(s: TicketScenario, runId: string): void {
  s.runner.send({
    type: 'run.state',
    payload: {
      run_id: runId,
      seq: 1,
      status: 'running',
      cli_session_id: 'session-1',
      worktree: { path: '/work/coffe/SHOP-1', branch: 'coffe/SHOP-1', base_branch: 'main', base_commit: DIFF.base_commit },
    },
  });
}

describe('starting runs', () => {
  it('dispatches the ticket to the runner holding its repository', async () => {
    const s = await scenario();
    const { run, start } = await startRun(t, s);

    expect(start).toMatchObject({
      run_id: run.id,
      kind: 'ticket',
      cli_id: 'fake',
      repo_key: 'repo-1',
      ticket_key: 'SHOP-1',
      auto_commit: true,
      worktree: { mode: 'branch', branch: 'coffe/SHOP-1', base_branch: 'main' },
    });
    expect(start.prompt).toContain('Add a cart badge');
    const names = start.context.files.map((file) => file.name);
    expect(names[0]).toBe('00-coffe-rules.md');
    expect(names).toContain('40-ticket.md');
    expect(start.context.files.find((file) => file.name === '40-ticket.md')?.content).toContain(
      'Badge shows the item count',
    );
    expect(start.permissions.deny_tools).toContain('Bash(git push:*)');
    expect(start.resume ?? null).toBeNull();

    expect((await getRun(s, run.id)).status).toBe('dispatched');
    const ticket = await getTicket(s);
    expect(ticket.status).toBe('in_progress');
    expect(ticket.latestRun?.id).toBe(run.id);
  });

  it('refuses a second run while the first one is active', async () => {
    const s = await scenario();
    await startRun(t, s);
    const second = await api(t, s.owner).post(`/workspaces/${s.owner.workspaceId}/tickets/${s.ticket.id}/runs`, {
      cliId: 'fake',
    });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: { code: 'run_active' } });
  });

  it('refuses CLIs the runner did not detect', async () => {
    const s = await scenario();
    const response = await api(t, s.owner).post(`/workspaces/${s.owner.workspaceId}/tickets/${s.ticket.id}/runs`, {
      cliId: 'codex',
    });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { code: 'cli_not_detected' } });
  });

  it('queues runs while the runner is offline and dispatches them when it reconnects', async () => {
    const s = await scenario();
    await s.runner.close();
    const queued = Run.parse(
      expectStatus(
        await api(t, s.owner).post(`/workspaces/${s.owner.workspaceId}/tickets/${s.ticket.id}/runs`, { cliId: 'fake' }),
        201,
      ),
    );
    expect(queued.status).toBe('queued');
    expect(queued.statusDetail).toBe('waiting for runner build-vm');

    expect((await s.runner.connect()).type).toBe('welcome');
    const start = await s.runner.next('run.start');
    expect(start.payload.run_id).toBe(queued.id);
    expect((await getRun(s, queued.id)).status).toBe('dispatched');
  });

  it('cancels a queued run without the runner', async () => {
    const s = await scenario();
    await s.runner.close();
    const queued = Run.parse(
      expectStatus(
        await api(t, s.owner).post(`/workspaces/${s.owner.workspaceId}/tickets/${s.ticket.id}/runs`, { cliId: 'fake' }),
        201,
      ),
    );
    expectStatus(
      await api(t, s.owner).post(`/workspaces/${s.owner.workspaceId}/runs/${queued.id}/signal`, { signal: 'stop' }),
      202,
    );
    const cancelled = await getRun(s, queued.id);
    expect(cancelled.status).toBe('cancelled');
    expect((await getTicket(s)).flags.failed).toBe(true);
  });
});

describe('run frames', () => {
  it('stores output, events, usage and the result, then moves the ticket to review', async () => {
    const s = await scenario();
    const { run } = await startRun(t, s);
    const browser = await BrowserSocket.connect(t, s.owner);
    await browser.subscribe(`run:${run.id}`);

    reportRunning(s, run.id);
    s.runner.send({ type: 'run.output', payload: { run_id: run.id, seq: 2, data: base64('hello from the agent\r\n') } });
    s.runner.send({
      type: 'run.event',
      payload: {
        run_id: run.id,
        seq: 3,
        event: { kind: 'tool_call', call_id: 'c1', name: 'Bash', tool_kind: 'execute', input: { command: 'pnpm test' } },
      },
    });
    s.runner.send({
      type: 'run.completed',
      payload: {
        run_id: run.id,
        seq: 4,
        status: 'completed',
        exit_code: 0,
        summary: 'Added the badge.',
        head_commit: DIFF.head_commit,
        diff: DIFF,
        tests: { source: 'command', command: 'pnpm test', status: 'passed', passed: 12, failed: 0, skipped: 1 },
        usage: {
          available: true,
          input_tokens: 1200,
          output_tokens: 300,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
          cost_usd: 0.042,
          model: 'fake-1',
        },
      },
    });

    const output = await browser.next('run.output');
    expect(Buffer.from(output.data, 'base64').toString()).toBe('hello from the agent\r\n');
    const ack = await eventually(
      () => s.runner.next('run.ack'),
      (frame) => frame.payload.seq === 4,
      'the cumulative ack of seq 4',
    );
    expect(ack.payload.run_id).toBe(run.id);

    const done = await getRun(s, run.id);
    expect(done).toMatchObject({
      status: 'completed',
      exitCode: 0,
      resultSummary: 'Added the badge.',
      cliSessionId: 'session-1',
      headCommit: DIFF.head_commit,
      lastSeq: 4,
    });
    expect(done.usage).toMatchObject({ inputTokens: 1200, outputTokens: 300, costUsd: 0.042, costSource: 'reported' });

    const chunks = RunOutputResponse.parse(
      expectStatus(await api(t, s.owner).get(`/workspaces/${s.owner.workspaceId}/runs/${run.id}/output`), 200),
    );
    expect(chunks.chunks.map((chunk) => chunk.seq)).toEqual([2]);
    const events = RunEventsResponse.parse(
      expectStatus(await api(t, s.owner).get(`/workspaces/${s.owner.workspaceId}/runs/${run.id}/events`), 200),
    );
    expect(events.events.map((event) => event.type)).toEqual(['tool_call']);

    const ticket = await getTicket(s);
    expect(ticket.status).toBe('in_review');
    const review = ReviewState.parse(
      expectStatus(await api(t, s.owner).get(`/workspaces/${s.owner.workspaceId}/tickets/${s.ticket.id}/review`), 200),
    );
    expect(review.diff?.files.map((file) => file.path)).toEqual(['src/cart.ts']);
    expect(review.tests[0]).toMatchObject({ status: 'passed', passed: 12, skipped: 1 });
    expect(review.canApprove).toBe(true);

    const audit = AuditPage.parse(
      expectStatus(await api(t, s.owner).get(`/workspaces/${s.owner.workspaceId}/audit?action=agent.execute`), 200),
    );
    expect(audit.items.map((entry) => entry.command)).toEqual(['pnpm test']);
    await browser.close();
  });

  it('keeps the first copy of a frame the runner replays', async () => {
    const s = await scenario();
    const { run } = await startRun(t, s);
    const frame = (data: string): RunnerMessage => ({
      type: 'run.output',
      payload: { run_id: run.id, seq: 2, data: base64(data) },
    });
    s.runner.send(frame('original'));
    s.runner.send(frame('replayed'));
    await eventually(
      () => s.runner.next('run.ack'),
      (ack) => ack.payload.seq === 2,
      'the ack of seq 2',
    );
    const output = RunOutputResponse.parse(
      expectStatus(await api(t, s.owner).get(`/workspaces/${s.owner.workspaceId}/runs/${run.id}/output`), 200),
    );
    expect(output.chunks.map((chunk) => Buffer.from(chunk.data, 'base64').toString())).toEqual(['original']);
  });

  it('flags the ticket as failed when the run fails', async () => {
    const s = await scenario();
    const { run } = await startRun(t, s);
    reportRunning(s, run.id);
    s.runner.send({
      type: 'run.completed',
      payload: { run_id: run.id, seq: 2, status: 'failed', exit_code: 1, error: 'the CLI crashed' },
    });
    const run2 = await eventually(
      () => getRun(s, run.id),
      (current) => current.status === 'failed',
      'the failed run',
    );
    expect(run2.error).toBe('the CLI crashed');
    const ticket = await getTicket(s);
    expect(ticket.status).toBe('in_progress');
    expect(ticket.flags.failed).toBe(true);
  });
});

describe('driving a run', () => {
  it('forwards follow-up messages and signals to the runner and audits them', async () => {
    const s = await scenario();
    const { run } = await startRun(t, s);
    reportRunning(s, run.id);
    await eventually(
      () => getRun(s, run.id),
      (current) => current.status === 'running',
      'the running run',
    );

    expectStatus(
      await api(t, s.owner).post(`/workspaces/${s.owner.workspaceId}/runs/${run.id}/input`, {
        kind: 'text',
        text: 'Also update the README',
      }),
      202,
    );
    const input = await s.runner.next('run.input');
    expect(input.payload).toEqual({ run_id: run.id, input: { kind: 'text', text: 'Also update the README' } });

    expectStatus(
      await api(t, s.owner).post(`/workspaces/${s.owner.workspaceId}/runs/${run.id}/signal`, { signal: 'interrupt' }),
      202,
    );
    expect((await s.runner.next('run.signal')).payload).toEqual({ run_id: run.id, signal: 'interrupt' });

    const audit = AuditPage.parse(
      expectStatus(await api(t, s.owner).get(`/workspaces/${s.owner.workspaceId}/audit?runId=${run.id}`), 200),
    );
    const actions = audit.items.map((entry) => entry.action);
    expect(actions).toContain('run.input');
    expect(actions).toContain('run.signal');
    expect(audit.items.find((entry) => entry.action === 'run.input')?.command).toBe('Also update the README');
  });

  it('relays terminal keystrokes from the browser and audits each entered line', async () => {
    const s = await scenario();
    const { run } = await startRun(t, s);
    reportRunning(s, run.id);
    await eventually(
      () => getRun(s, run.id),
      (current) => current.status === 'running',
      'the running run',
    );
    const browser = await BrowserSocket.connect(t, s.owner);
    browser.send({ op: 'run.input', runId: run.id, data: 'ls -la' });
    browser.send({ op: 'run.input', runId: run.id, data: '\r' });
    browser.send({ op: 'run.resize', runId: run.id, cols: 120, rows: 40 });

    expect((await s.runner.next('run.input')).payload.input).toEqual({ kind: 'keys', data: 'ls -la' });
    expect((await s.runner.next('run.input')).payload.input).toEqual({ kind: 'keys', data: '\r' });
    expect((await s.runner.next('run.resize')).payload).toEqual({ run_id: run.id, cols: 120, rows: 40 });

    const audit = await eventually(
      () =>
        api(t, s.owner)
          .get(`/workspaces/${s.owner.workspaceId}/audit?action=run.input`)
          .then((response) => AuditPage.parse(expectStatus(response, 200))),
      (page) => page.items.length > 0,
      'the keystroke audit entry',
    );
    expect(audit.items[0]?.command).toBe('ls -la');
    await browser.close();
  });

  it('rejects input for runs that are not running', async () => {
    const s = await scenario();
    const { run } = await startRun(t, s);
    const response = await api(t, s.owner).post(`/workspaces/${s.owner.workspaceId}/runs/${run.id}/input`, {
      kind: 'text',
      text: 'hello',
    });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { code: 'run_not_accepting_input' } });
  });
});
