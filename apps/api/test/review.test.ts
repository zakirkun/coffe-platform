import {
  ApproveResponse,
  AuditPage,
  FileContentResponse,
  RequestChangesResponse,
  ReviewState,
  Ticket,
} from '@coffe/contracts';
import type { DiffSummary, TestReport } from '@coffe/protocol';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase, startTestApp, type TestApp } from './support/app.js';
import { type TicketScenario, eventually, expectStatus, startRun, ticketScenario } from './support/scenario.js';
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

const DIFF: DiffSummary = {
  base_commit: 'a'.repeat(40),
  head_commit: 'b'.repeat(40),
  additions: 1,
  deletions: 0,
  files: [{ path: 'src/cart.ts', status: 'added', additions: 1, deletions: 0, binary: false }],
  patch: 'diff --git a/src/cart.ts b/src/cart.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/cart.ts\n@@ -0,0 +1 @@\n+export const badge = true;\n',
  truncated: false,
};

function getTicket(s: TicketScenario): Promise<Ticket> {
  return api(t, s.owner)
    .get(`/workspaces/${s.owner.workspaceId}/tickets/${s.ticket.id}`)
    .then((response) => Ticket.parse(expectStatus(response, 200)));
}

/** A ticket whose run completed with a diff: In Review, ready for a decision. */
async function inReview(
  options: { settings?: Record<string, unknown>; tests?: TestReport } = {},
): Promise<TicketScenario & { runId: string }> {
  const s = await ticketScenario(t, await signUpWithWorkspace(t), options.settings ? { settings: options.settings } : {});
  scenarios.push(s);
  const { run } = await startRun(t, s);
  s.runner.send({
    type: 'run.state',
    payload: {
      run_id: run.id,
      seq: 1,
      status: 'running',
      cli_session_id: 'session-1',
      worktree: { path: '/work/coffe/SHOP-1', branch: 'coffe/SHOP-1', base_branch: 'main', base_commit: DIFF.base_commit },
    },
  });
  s.runner.send({
    type: 'run.completed',
    payload: {
      run_id: run.id,
      seq: 2,
      status: 'completed',
      exit_code: 0,
      summary: 'Added the badge.',
      diff: DIFF,
      ...(options.tests ? { tests: options.tests } : {}),
    },
  });
  await eventually(
    () => getTicket(s),
    (ticket) => ticket.status === 'in_review',
    'the ticket in review',
  );
  return { ...s, runId: run.id };
}

describe('approve', () => {
  it('merges the ticket branch on the runner and closes the ticket', async () => {
    const s = await inReview();
    const approval = api(t, s.owner).post(`/workspaces/${s.owner.workspaceId}/tickets/${s.ticket.id}/approve`, {
      body: 'Looks good',
    });
    const merge = await s.runner.next('git.merge');
    expect(merge.payload).toEqual({
      repo_key: 'repo-1',
      branch: 'coffe/SHOP-1',
      into: 'main',
      strategy: 'merge',
      message: 'Merge SHOP-1: Add a cart badge',
      push: false,
      remote: null,
      remove_worktree: true,
    });
    s.runner.send(
      { type: 'git.merge.result', payload: { status: 'merged', merge_commit: 'c'.repeat(40), pushed: false, conflicts: [] } },
      merge.id,
    );

    const result = ApproveResponse.parse(expectStatus(await approval, 200));
    expect(result.review).toMatchObject({ decision: 'approved', body: 'Looks good', round: 1 });
    expect(result.merge).toMatchObject({ status: 'merged', mergeCommit: 'c'.repeat(40), targetBranch: 'main' });
    expect((await getTicket(s)).status).toBe('done');

    const audit = AuditPage.parse(
      expectStatus(await api(t, s.owner).get(`/workspaces/${s.owner.workspaceId}/audit`), 200),
    );
    const actions = audit.items.map((entry) => entry.action);
    expect(actions).toContain('review.approve');
    expect(actions).toContain('git.merge');
  });

  it('keeps the ticket in review and flags it when the merge conflicts', async () => {
    const s = await inReview();
    const approval = api(t, s.owner).post(`/workspaces/${s.owner.workspaceId}/tickets/${s.ticket.id}/approve`, {});
    const merge = await s.runner.next('git.merge');
    s.runner.send(
      { type: 'git.merge.result', payload: { status: 'conflict', pushed: false, conflicts: ['src/cart.ts'] } },
      merge.id,
    );
    const result = ApproveResponse.parse(expectStatus(await approval, 200));
    expect(result.merge).toMatchObject({ status: 'conflict', conflicts: ['src/cart.ts'] });
    const ticket = await getTicket(s);
    expect(ticket.status).toBe('in_review');
    expect(ticket.flags.mergeConflict).toBe(true);
  });

  it('is refused while the runner holding the worktree is offline', async () => {
    const s = await inReview();
    await s.runner.close();
    const state = ReviewState.parse(
      expectStatus(await api(t, s.owner).get(`/workspaces/${s.owner.workspaceId}/tickets/${s.ticket.id}/review`), 200),
    );
    expect(state.canApprove).toBe(false);
    expect(state.blockers).toContain('The runner holding the worktree is offline');

    const response = await api(t, s.owner).post(`/workspaces/${s.owner.workspaceId}/tickets/${s.ticket.id}/approve`, {});
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { code: 'cannot_approve' } });
  });

  it('is refused while the latest tests fail when the project requires passing tests', async () => {
    const s = await inReview({
      settings: { requirePassingTests: true },
      tests: {
        source: 'command',
        command: 'pnpm test',
        status: 'failed',
        passed: 3,
        failed: 1,
        skipped: 0,
        failures: [{ name: 'cart badge shows the count', message: 'expected 1, got 0' }],
      },
    });
    const client = api(t, s.owner);
    const reviewPath = `/workspaces/${s.owner.workspaceId}/tickets/${s.ticket.id}/review`;
    const gated = ReviewState.parse(expectStatus(await client.get(reviewPath), 200));
    expect(gated.tests[0]).toMatchObject({ source: 'command', status: 'failed', failed: 1 });
    expect(gated.canApprove).toBe(false);
    expect(gated.blockers).toEqual(['The latest test command did not pass']);

    expectStatus(
      await client.patch(`/workspaces/${s.owner.workspaceId}/projects/${s.project.id}`, { settings: { requirePassingTests: false } }),
      200,
    );
    const open = ReviewState.parse(expectStatus(await client.get(reviewPath), 200));
    expect(open.canApprove).toBe(true);
  });
});

describe('request changes', () => {
  it('sends the feedback to the agent in the same CLI session and worktree', async () => {
    const s = await inReview();
    const response = RequestChangesResponse.parse(
      expectStatus(
        await api(t, s.owner).post(`/workspaces/${s.owner.workspaceId}/tickets/${s.ticket.id}/request-changes`, {
          body: 'Make the badge red',
        }),
        200,
      ),
    );
    expect(response.review).toMatchObject({ decision: 'changes_requested', round: 1 });
    expect(response.run.parentRunId).toBe(s.runId);

    const start = await s.runner.next('run.start');
    expect(start.payload.run_id).toBe(response.run.id);
    expect(start.payload.resume).toEqual({ cli_session_id: 'session-1' });
    expect(start.payload.prompt).toContain('Make the badge red');
    expect(start.payload.worktree).toMatchObject({ branch: 'coffe/SHOP-1', base_branch: 'main' });
    expect((await getTicket(s)).status).toBe('in_progress');
  });

  it('lets reviewers decide but not start runs themselves', async () => {
    const s = await inReview();
    const reviewer = await addMember(t, s.owner, 'reviewer');
    const start = await api(t, reviewer).post(`/workspaces/${s.owner.workspaceId}/tickets/${s.ticket.id}/runs`, {
      cliId: 'fake',
    });
    expect(start.status).toBe(403);

    const decision = await api(t, reviewer).post(
      `/workspaces/${s.owner.workspaceId}/tickets/${s.ticket.id}/request-changes`,
      { body: 'Add a test' },
    );
    expect(decision.status).toBe(200);
  });
});

describe('file relay', () => {
  it('reads files of the ticket branch through the runner without storing them', async () => {
    const s = await inReview();
    const path = `/workspaces/${s.owner.workspaceId}/tickets/${s.ticket.id}/file?rev=${DIFF.head_commit}&path=src%2Fcart.ts`;
    const pending = api(t, s.owner).get(path);
    const request = await s.runner.next('git.file');
    expect(request.payload).toMatchObject({ repo_key: 'repo-1', rev: DIFF.head_commit, path: 'src/cart.ts' });
    s.runner.send(
      {
        type: 'git.file.result',
        payload: {
          path: 'src/cart.ts',
          rev: DIFF.head_commit,
          content: Buffer.from('export const badge = true;\n').toString('base64'),
          size: 27,
          binary: false,
          too_large: false,
          missing: false,
        },
      },
      request.id,
    );
    const file = FileContentResponse.parse(expectStatus(await pending, 200));
    expect(file.content).toBe('export const badge = true;\n');
  });
});
