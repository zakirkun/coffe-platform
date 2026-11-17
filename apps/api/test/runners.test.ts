import { AuditPage, PairingTokenResponse, Runner } from '@coffe/contracts';
import { CLOSE_CODES, PROTOCOL_VERSION } from '@coffe/protocol';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { resetDatabase, startTestApp, type TestApp } from './support/app.js';
import { BrowserSocket } from './support/browser-socket.js';
import { FakeRunner, generateRunnerKeys, pairPayload, pairWithToken } from './support/fake-runner.js';
import { expectStatus } from './support/scenario.js';
import { addMember, api, signUpWithWorkspace } from './support/session.js';

let t: TestApp;
const connected: FakeRunner[] = [];

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
  for (const runner of connected.splice(0)) await runner.close();
});

async function online(runner: FakeRunner, ...args: Parameters<FakeRunner['connect']>) {
  connected.push(runner);
  return runner.connect(...args);
}

describe('runner pairing', () => {
  it('pairs once with a pairing token and then connects with the runner token', async () => {
    const owner = await signUpWithWorkspace(t);
    const created = PairingTokenResponse.parse(
      expectStatus(
        await api(t, owner).post(`/workspaces/${owner.workspaceId}/runner-pairing-tokens`, { label: 'laptop' }),
        201,
      ),
    );
    expect(created.command).toContain(created.token);
    expect(created.command).toContain(created.serverUrl);

    const first = await pairWithToken(t, created.token, pairPayload('laptop', generateRunnerKeys()));
    expect(first.frames.map((frame) => frame.type)).toEqual(['paired']);
    expect(first.closeCode).toBe(CLOSE_CODES.NORMAL);

    await expect(pairWithToken(t, created.token, pairPayload('again', generateRunnerKeys()))).rejects.toThrow(/401/);

    const audit = AuditPage.parse(
      expectStatus(await api(t, owner).get(`/workspaces/${owner.workspaceId}/audit?action=runner.paired`), 200),
    );
    expect(audit.items).toHaveLength(1);
  });

  it('rejects a pairing whose encryption key is not signed by the identity key', async () => {
    const owner = await signUpWithWorkspace(t);
    const { token } = PairingTokenResponse.parse(
      expectStatus(await api(t, owner).post(`/workspaces/${owner.workspaceId}/runner-pairing-tokens`, {}), 201),
    );
    const keys = generateRunnerKeys();
    const forged = { ...keys, box_public_key: generateRunnerKeys().box_public_key };
    const exchange = await pairWithToken(t, token, pairPayload('forged', forged));
    expect(exchange.closeCode).toBe(CLOSE_CODES.PROTOCOL_VIOLATION);
    expect(exchange.frames.find((frame) => frame.type === 'error')).toBeDefined();
  });

  it('does not let reviewers create pairing tokens', async () => {
    const owner = await signUpWithWorkspace(t);
    const reviewer = await addMember(t, owner, 'reviewer');
    const response = await api(t, reviewer).post(`/workspaces/${owner.workspaceId}/runner-pairing-tokens`, {});
    expect(response.status).toBe(403);
  });
});

describe('runner connection', () => {
  it('reports the runner online with its CLIs and repositories, and offline after it leaves', async () => {
    const owner = await signUpWithWorkspace(t);
    const browser = await BrowserSocket.connect(t, owner);
    await browser.subscribe(`workspace:${owner.workspaceId}`);
    const runner = await FakeRunner.pair(t, owner, { name: 'build-vm' });

    const welcome = await online(runner);
    expect(welcome.type).toBe('welcome');
    const status = await browser.next('runner.status');
    expect(status).toMatchObject({ runnerId: runner.runnerId, status: 'online' });

    const detail = Runner.parse(
      expectStatus(await api(t, owner).get(`/workspaces/${owner.workspaceId}/runners/${runner.runnerId}`), 200),
    );
    expect(detail.status).toBe('online');
    expect(detail.clis.map((cli) => cli.cliId)).toEqual(['fake']);
    expect(detail.repos.map((repo) => repo.repoKey)).toEqual(['repo-1']);

    await runner.close();
    expect(await browser.next('runner.status')).toMatchObject({ runnerId: runner.runnerId, status: 'offline' });
    await browser.close();
  });

  it('asks outdated runners to upgrade', async () => {
    const owner = await signUpWithWorkspace(t);
    const runner = await FakeRunner.pair(t, owner);
    const answer = await online(runner, { runnerVersion: '0.0.1' });
    expect(answer.type).toBe('upgrade_required');
    expect(await runner.closed()).toBe(CLOSE_CODES.UPGRADE_REQUIRED);
  });

  it('asks runners speaking another protocol major version to upgrade', async () => {
    const owner = await signUpWithWorkspace(t);
    const runner = await FakeRunner.pair(t, owner);
    const [major] = PROTOCOL_VERSION.split('.');
    const answer = await online(runner, { protocol: `${Number(major) + 1}.0` });
    expect(answer.type).toBe('upgrade_required');
  });

  it('disconnects a revoked runner and refuses its token afterwards', async () => {
    const owner = await signUpWithWorkspace(t);
    const runner = await FakeRunner.pair(t, owner);
    await online(runner);

    const revoked = Runner.parse(
      expectStatus(
        await api(t, owner).post(`/workspaces/${owner.workspaceId}/runners/${runner.runnerId}/revoke`),
        200,
      ),
    );
    expect(revoked.status).toBe('revoked');
    expect(await runner.closed()).toBe(CLOSE_CODES.UNAUTHORIZED);
    await expect(runner.connect()).rejects.toThrow(/401/);
  });

  it('hides runners of other workspaces', async () => {
    const owner = await signUpWithWorkspace(t);
    const stranger = await signUpWithWorkspace(t, 'Sam Stranger');
    const runner = await FakeRunner.pair(t, owner);

    const list = z
      .array(Runner)
      .parse(expectStatus(await api(t, stranger).get(`/workspaces/${stranger.workspaceId}/runners`), 200));
    expect(list).toEqual([]);
    const foreign = await api(t, stranger).get(`/workspaces/${owner.workspaceId}/runners/${runner.runnerId}`);
    expect(foreign.status).toBe(403);
  });
});
