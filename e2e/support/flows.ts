import type { ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { API_URL, FAKE_CLI_BIN, REPO_ROOT, RUNNER_BIN, TARGET_DIR } from './env.js';
import { run, startProcess } from './processes.js';

/** Signs a new user up and creates their workspace; returns the workspace id. */
export async function signUpWithWorkspace(page: Page, workspaceName: string): Promise<string> {
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E User');
  await page
    .getByLabel('Email')
    .fill(`e2e-${Date.now()}-${Math.round(Math.random() * 1e6)}@coffe.test`);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: /sign up|create account/i }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel(/workspace name/i).fill(workspaceName);
  await page.getByRole('button', { name: /create workspace/i }).click();
  await page.waitForURL(/\/w\/[^/]+/);
  const workspaceId = new URL(page.url()).pathname.split('/')[2];
  expect(workspaceId).toBeTruthy();
  return workspaceId ?? '';
}

/** A scratch git repository with one commit on `main`. */
export function scratchRepository(dir: string): string {
  mkdirSync(dir, { recursive: true });
  run('git', ['init', '-q', '-b', 'main'], dir);
  run('git', ['config', 'user.email', 'e2e@coffe.local'], dir);
  run('git', ['config', 'user.name', 'COFFE e2e'], dir);
  writeFileSync(join(dir, 'README.md'), '# Demo repository\n');
  run('git', ['add', '.'], dir);
  run('git', ['commit', '-q', '-m', 'initial commit'], dir);
  return dir;
}

export interface PairOptions {
  home: string;
  repoDir: string;
  repoName: string;
  runnerName: string;
}

/**
 * Pairs a real runner through the Runners page, registers `repoDir`, enables the fake CLI and
 * starts the daemon; resolves once the page shows it online. The caller kills the process.
 */
export async function pairRunner(
  page: Page,
  workspaceId: string,
  options: PairOptions,
): Promise<ChildProcess> {
  await page.goto(`/w/${workspaceId}/runners`);
  await page.getByRole('button', { name: /pair a runner/i }).click();
  const command = (await page.getByTestId('pairing-command').textContent()) ?? '';
  const token = /--token\s+(coffe_pt_[A-Za-z0-9_-]+)/.exec(command)?.[1];
  expect(token, `pairing command: ${command}`).toBeTruthy();

  run(
    RUNNER_BIN,
    [
      '--home',
      options.home,
      'pair',
      '--server',
      API_URL,
      '--token',
      token ?? '',
      '--name',
      options.runnerName,
    ],
    REPO_ROOT,
  );
  run(
    RUNNER_BIN,
    ['--home', options.home, 'repo', 'add', options.repoDir, '--name', options.repoName],
    REPO_ROOT,
  );
  const configPath = join(options.home, 'runner.toml');
  // `pair` writes the whole [policy] table; flip the flag inside it.
  const config = readFileSync(configPath, 'utf8');
  expect(config).toContain('enable_fake_cli = false');
  writeFileSync(configPath, config.replace('enable_fake_cli = false', 'enable_fake_cli = true'));
  const runner = startProcess(
    options.runnerName,
    RUNNER_BIN,
    ['--home', options.home, 'start', '--fake-cli-dir', TARGET_DIR],
    {
      cwd: REPO_ROOT,
      env: { COFFE_FAKE_CLI: FAKE_CLI_BIN, COFFE_FAKE_SCENARIO: 'edit', RUST_LOG: 'info' },
    },
  );

  await page.keyboard.press('Escape');
  await expect(page.getByText(options.runnerName)).toBeVisible();
  await expect(page.getByTestId('runner-status').first()).toHaveText(/online/i, {
    timeout: 60_000,
  });
  return runner;
}

/** Creates a project on the registered repository named `repoName`; ends on its board. */
export async function createProject(
  page: Page,
  workspaceId: string,
  name: string,
  key: string,
  repoName: string,
): Promise<string> {
  await page.goto(`/w/${workspaceId}/projects`);
  await page.getByRole('button', { name: /new project/i }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByLabel(/key/i).fill(key);
  await page.getByRole('combobox', { name: /repository/i }).click();
  await page.getByRole('option', { name: new RegExp(repoName) }).click();
  await page.getByRole('button', { name: /create project/i }).click();
  await page.waitForURL(/\/p\/[0-9a-f-]+$/);
  return new URL(page.url()).pathname.split('/')[4] ?? '';
}

/** Creates a ticket from the board. */
export async function createTicket(page: Page, title: string, description: string): Promise<void> {
  await page.getByRole('button', { name: /new ticket/i }).click();
  await page.getByLabel('Title').fill(title);
  await page.getByLabel(/description/i).fill(description);
  await page.getByRole('button', { name: /create ticket/i }).click();
  await expect(page.getByRole('link', { name: new RegExp(title) })).toBeVisible();
}
