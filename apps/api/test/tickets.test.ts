import { MeResponse, Project, ProjectRepoBinding, Ticket } from '@coffe/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { resetDatabase, startTestApp, type TestApp } from './support/app.js';
import { BrowserSocket } from './support/browser-socket.js';
import { type TicketScenario, expectStatus, ticketScenario } from './support/scenario.js';
import { addMember, api, signUpWithWorkspace, type TestUser } from './support/session.js';

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

async function scenario(owner?: TestUser): Promise<TicketScenario> {
  const created = await ticketScenario(t, owner ?? (await signUpWithWorkspace(t)));
  scenarios.push(created);
  return created;
}

async function createTicket(s: TicketScenario, title: string, user: TestUser = s.owner): Promise<Ticket> {
  return Ticket.parse(
    expectStatus(
      await api(t, user).post(`/workspaces/${s.owner.workspaceId}/projects/${s.project.id}/tickets`, { title }),
      201,
    ),
  );
}

async function column(s: TicketScenario, status: string): Promise<string[]> {
  const tickets = z
    .array(Ticket)
    .parse(expectStatus(await api(t, s.owner).get(`/workspaces/${s.owner.workspaceId}/projects/${s.project.id}/tickets`), 200));
  return tickets.filter((ticket) => ticket.status === status).map((ticket) => ticket.title);
}

describe('session and workspace access', () => {
  it('requires a session', async () => {
    expect((await api(t, null).get('/me')).status).toBe(401);
  });

  it('returns the signed-in user with their workspaces and roles', async () => {
    const owner = await signUpWithWorkspace(t);
    const me = MeResponse.parse(expectStatus(await api(t, owner).get('/me'), 200));
    expect(me.user.email).toBe(owner.email);
    expect(me.workspaces).toEqual([expect.objectContaining({ id: owner.workspaceId, role: 'owner' })]);
  });

  it('keeps workspaces apart', async () => {
    const s = await scenario();
    const stranger = await signUpWithWorkspace(t, 'Sam Stranger');
    const foreign = await api(t, stranger).get(`/workspaces/${s.owner.workspaceId}/tickets/${s.ticket.id}`);
    expect(foreign.status).toBe(403);
    const browser = await BrowserSocket.connect(t, stranger);
    await expect(browser.subscribe(`ticket:${s.ticket.id}`)).rejects.toThrow(/forbidden/);
    await browser.close();
  });
});

describe('projects', () => {
  it('rejects a duplicate project key in the same workspace', async () => {
    const s = await scenario();
    const duplicate = await api(t, s.owner).post(`/workspaces/${s.owner.workspaceId}/projects`, {
      name: 'Shop again',
      key: 'SHOP',
    });
    expect(duplicate.status).toBe(409);
  });

  it('binds the repository chosen at creation as the primary one', async () => {
    const s = await scenario();
    const repos = z
      .array(ProjectRepoBinding)
      .parse(
        expectStatus(await api(t, s.owner).get(`/workspaces/${s.owner.workspaceId}/projects/${s.project.id}/repos`), 200),
      );
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({ isPrimary: true, runnerName: 'build-vm', repo: { repoKey: 'repo-1' } });
  });

  it('lets members create projects but not reviewers', async () => {
    const owner = await signUpWithWorkspace(t);
    const reviewer = await addMember(t, owner, 'reviewer');
    const member = await addMember(t, owner, 'member');
    const asReviewer = await api(t, reviewer).post(`/workspaces/${owner.workspaceId}/projects`, { name: 'A', key: 'AAA' });
    expect(asReviewer.status).toBe(403);
    Project.parse(
      expectStatus(await api(t, member).post(`/workspaces/${owner.workspaceId}/projects`, { name: 'B', key: 'BBB' }), 201),
    );
  });
});

describe('tickets', () => {
  it('numbers tickets per project and derives their keys', async () => {
    const s = await scenario();
    const second = await createTicket(s, 'Second');
    expect(s.ticket).toMatchObject({ number: 1, key: 'SHOP-1', status: 'backlog' });
    expect(second).toMatchObject({ number: 2, key: 'SHOP-2' });
  });

  it('moves tickets between columns at the requested position', async () => {
    const s = await scenario();
    const second = await createTicket(s, 'Second');
    const third = await createTicket(s, 'Third');
    const move = (ticket: Ticket, body: Record<string, unknown>) =>
      api(t, s.owner).post(`/workspaces/${s.owner.workspaceId}/tickets/${ticket.id}/move`, body);

    expectStatus(await move(s.ticket, { status: 'ready' }), 200);
    expectStatus(await move(third, { status: 'ready', beforeId: s.ticket.id }), 200);
    expectStatus(await move(second, { status: 'ready', afterId: third.id }), 200);
    expect(await column(s, 'ready')).toEqual(['Third', 'Second', 'Add a cart badge']);
    expect(await column(s, 'backlog')).toEqual([]);
  });

  it('pushes ticket changes to subscribed browsers', async () => {
    const s = await scenario();
    const browser = await BrowserSocket.connect(t, s.owner);
    await browser.subscribe(`project:${s.project.id}`);
    expectStatus(
      await api(t, s.owner).patch(`/workspaces/${s.owner.workspaceId}/tickets/${s.ticket.id}`, { title: 'Cart badge v2' }),
      200,
    );
    const event = await browser.next('ticket.updated');
    expect(event.ticket).toMatchObject({ id: s.ticket.id, title: 'Cart badge v2' });
    await browser.close();
  });
});
