import { setTimeout as sleep } from 'node:timers/promises';
import { Project, Run, RunnerRepo, Ticket } from '@coffe/contracts';
import type { CliInfo, RepoInfo, RunStart, ServerEnvelope } from '@coffe/protocol';
import { z } from 'zod';
import type { TestApp } from './app.js';
import { DEFAULT_CLI, DEFAULT_REPO, FakeRunner } from './fake-runner.js';
import { api, type TestUser } from './session.js';

/** An owner with an online runner, a project bound to the runner's repository and a ticket. */
export interface TicketScenario {
  owner: TestUser;
  runner: FakeRunner;
  project: Project;
  ticket: Ticket;
}

export interface ScenarioOptions {
  clis?: CliInfo[];
  repos?: RepoInfo[];
  projectKey?: string;
  settings?: Record<string, unknown>;
  acceptanceCriteria?: string[];
}

export function expectStatus(response: { status: number; body: unknown }, status: number): unknown {
  if (response.status !== status) {
    throw new Error(`expected HTTP ${status}, got ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

export async function ticketScenario(t: TestApp, owner: TestUser, options: ScenarioOptions = {}): Promise<TicketScenario> {
  const runner = await FakeRunner.pair(t, owner, { name: 'build-vm' });
  const welcome = await runner.connect({ clis: options.clis ?? [DEFAULT_CLI], repos: options.repos ?? [DEFAULT_REPO] });
  if (welcome.type !== 'welcome') throw new Error(`expected welcome, got ${welcome.type}`);
  const client = api(t, owner);

  const runnerDto = z
    .object({ repos: z.array(RunnerRepo) })
    .parse(expectStatus(await client.get(`/workspaces/${owner.workspaceId}/runners/${runner.runnerId}`), 200));
  const repo = runnerDto.repos[0];
  if (!repo) throw new Error('the runner reported no repository');

  const project = Project.parse(
    expectStatus(
      await client.post(`/workspaces/${owner.workspaceId}/projects`, {
        name: 'Shop',
        key: options.projectKey ?? 'SHOP',
        runnerRepoId: repo.id,
        ...(options.settings ? { settings: options.settings } : {}),
      }),
      201,
    ),
  );
  const ticket = Ticket.parse(
    expectStatus(
      await client.post(`/workspaces/${owner.workspaceId}/projects/${project.id}/tickets`, {
        title: 'Add a cart badge',
        description: 'Show the number of items next to the cart icon.',
        acceptanceCriteria: options.acceptanceCriteria ?? ['Badge shows the item count'],
      }),
      201,
    ),
  );
  return { owner, runner, project, ticket };
}

/** Starts a run over REST and returns it with the `run.start` the runner received. */
export async function startRun(
  t: TestApp,
  scenario: TicketScenario,
  body: Record<string, unknown> = { cliId: 'fake' },
): Promise<{ run: Run; start: RunStart; frame: Extract<ServerEnvelope, { type: 'run.start' }> }> {
  const run = Run.parse(
    expectStatus(
      await api(t, scenario.owner).post(`/workspaces/${scenario.owner.workspaceId}/tickets/${scenario.ticket.id}/runs`, body),
      201,
    ),
  );
  const frame = await scenario.runner.next('run.start');
  return { run, start: frame.payload, frame };
}

/** Polls a GET until `accept` passes (realtime-independent assertions on eventual state). */
export async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  what: string,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}; last value: ${JSON.stringify(last)}`);
}
