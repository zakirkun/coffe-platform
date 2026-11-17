import type { ProjectRepoBinding, Runner, RunnerCli } from '@coffe/contracts';
import { describe, expect, it } from 'vitest';
import { cliOptionsForTicket } from './run-options';

const NOW = '2026-01-01T00:00:00.000Z';

function cli(cliId: string, modes?: string[]): RunnerCli {
  return {
    cliId,
    name: cliId,
    path: `/usr/bin/${cliId}`,
    version: '1.0.0',
    authStatus: 'ok',
    capabilities: modes ? { modes } : {},
    detectedAt: NOW,
  };
}

function runner(id: string, name: string, clis: RunnerCli[], status: Runner['status'] = 'online'): Runner {
  return {
    id,
    name,
    hostname: name,
    os: 'linux',
    arch: 'x86_64',
    runnerVersion: '0.1.0',
    protocolVersion: '1.0',
    status,
    lastSeenAt: NOW,
    fingerprint: 'AAAA',
    maxConcurrentRuns: 4,
    runningRuns: 0,
    capabilities: [],
    policy: {},
    clis,
    repos: [],
    needsUpdate: false,
    createdAt: NOW,
    revokedAt: null,
  };
}

function binding(runnerId: string, repoId: string): ProjectRepoBinding {
  return {
    id: `b-${repoId}`,
    projectId: 'p',
    runnerId,
    runnerName: runnerId,
    runnerStatus: 'online',
    isPrimary: true,
    repo: {
      id: repoId,
      runnerId,
      repoKey: repoId,
      name: repoId,
      path: `/src/${repoId}`,
      defaultBranch: 'main',
      remoteUrl: null,
      headCommit: null,
      available: true,
    },
  };
}

const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';
const runners = [
  runner(R1, 'laptop', [cli('claude-code', ['structured', 'pty']), cli('fake', ['structured'])]),
  runner(R2, 'build-vm', [cli('claude-code', ['pty']), cli('codex')]),
  runner('33333333-3333-4333-8333-333333333333', 'old', [cli('gemini')], 'revoked'),
];
const bindings = [binding(R1, 'repo-a'), binding(R2, 'repo-b')];

describe('cliOptionsForTicket', () => {
  it('only offers CLIs of the runner that already holds the ticket worktree', () => {
    const options = cliOptionsForTicket({ worktreeRunnerId: R2, repoId: 'repo-a' }, bindings, runners);
    expect(options.map((option) => option.cliId)).toEqual(['claude-code', 'codex']);
    expect(options[0]?.runnerNames).toEqual(['build-vm']);
  });

  it('uses the runner of the ticket repository before the first run', () => {
    const options = cliOptionsForTicket({ worktreeRunnerId: null, repoId: 'repo-a' }, bindings, runners);
    expect(options.map((option) => option.cliId)).toEqual(['claude-code', 'fake']);
  });

  it('merges CLIs across all bound runners and never offers revoked ones', () => {
    const options = cliOptionsForTicket({ worktreeRunnerId: null, repoId: null }, bindings, runners);
    const claude = options.find((option) => option.cliId === 'claude-code');
    expect(claude?.runnerNames).toEqual(['laptop', 'build-vm']);
    expect(claude?.modes).toEqual(['structured', 'pty']);
    // No reported modes: both are offered.
    expect(options.find((option) => option.cliId === 'codex')?.modes).toEqual(['structured', 'pty']);
    expect(options.some((option) => option.cliId === 'gemini')).toBe(false);
  });
});
