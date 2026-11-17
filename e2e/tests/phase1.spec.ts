import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
  API_URL,
  type E2eState,
  FAKE_CLI_BIN,
  REPO_ROOT,
  RUNNER_BIN,
  STATE_FILE,
  TARGET_DIR,
} from '../support/env.js';
import { killTree, run, startProcess } from '../support/processes.js';

/**
 * Phase 1 demo end to end: sign up → workspace → pair a real runner → register a repository →
 * project → ticket → run the fake CLI in a worktree → live terminal → follow-up input → review the
 * diff → approve → branch merged into main on the runner.
 */
test('pair a runner, run a ticket, review and approve the diff', async ({ page }) => {
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as E2eState;
  const email = `e2e-${Date.now()}@coffe.test`;

  // --- account and workspace ---------------------------------------------------------------
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: /sign up|create account/i }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel(/workspace name/i).fill('E2E Workspace');
  await page.getByRole('button', { name: /create workspace/i }).click();
  await page.waitForURL(/\/w\/[^/]+/);
  const workspaceUrl = new URL(page.url());
  const workspaceId = workspaceUrl.pathname.split('/')[2];
  expect(workspaceId).toBeTruthy();

  // --- pair the runner ---------------------------------------------------------------------
  await page.goto(`/w/${workspaceId}/runners`);
  await page.getByRole('button', { name: /pair a runner/i }).click();
  const command = await page.getByTestId('pairing-command').innerText();
  const token = /--token\s+(coffe_pt_[A-Za-z0-9_-]+)/.exec(command)?.[1];
  expect(token, `pairing command: ${command}`).toBeTruthy();

  const home = state.runnerHome;
  run(RUNNER_BIN, ['--home', home, 'pair', '--server', API_URL, '--token', token ?? '', '--name', 'e2e-runner'], REPO_ROOT);
  run(RUNNER_BIN, ['--home', home, 'repo', 'add', state.repoDir, '--name', 'demo'], REPO_ROOT);
  const configPath = join(home, 'runner.toml');
  // `pair` writes the whole [policy] table; flip the flag inside it.
  const config = readFileSync(configPath, 'utf8');
  expect(config).toContain('enable_fake_cli = false');
  writeFileSync(configPath, config.replace('enable_fake_cli = false', 'enable_fake_cli = true'));
  const runner = startProcess('runner', RUNNER_BIN, ['--home', home, 'start', '--fake-cli-dir', TARGET_DIR], {
    cwd: REPO_ROOT,
    env: { COFFE_FAKE_CLI: FAKE_CLI_BIN, COFFE_FAKE_SCENARIO: 'edit', RUST_LOG: 'info' },
  });

  try {
    await page.keyboard.press('Escape');
    await expect(page.getByText('e2e-runner')).toBeVisible();
    await expect(page.getByTestId('runner-status').first()).toHaveText(/online/i, { timeout: 60_000 });

    // --- project and ticket ----------------------------------------------------------------
    await page.goto(`/w/${workspaceId}/projects`);
    await page.getByRole('button', { name: /new project/i }).click();
    await page.getByLabel('Name').fill('Demo');
    await page.getByLabel(/key/i).fill('DEMO');
    await page.getByRole('combobox', { name: /repository/i }).click();
    await page.getByRole('option', { name: /demo/ }).click();
    await page.getByRole('button', { name: /create project/i }).click();
    await page.waitForURL(/\/p\/[0-9a-f-]+/);

    await page.getByRole('button', { name: /new ticket/i }).click();
    await page.getByLabel('Title').fill('Add a changes file');
    await page.getByLabel(/description/i).fill('Create FAKE_CHANGES.md describing the change.');
    await page.getByRole('button', { name: /create ticket/i }).click();
    await page.getByRole('link', { name: /DEMO-1/ }).click();
    await page.waitForURL(/\/t\/[0-9a-f-]+/);

    // --- run with the fake CLI and watch the terminal ---------------------------------------
    await startFakeRun(page);
    const terminal = page.getByTestId('run-terminal');
    await expect(terminal).toContainText('turn complete', { timeout: 90_000 });
    await expect(page.getByTestId('run-status')).toHaveText(/completed/i, { timeout: 90_000 });

    // --- review and approve --------------------------------------------------------------------
    await page.getByRole('tab', { name: /review/i }).click();
    await expect(page.getByRole('list', { name: 'Changed files' }).getByText('FAKE_CHANGES.md')).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole('button', { name: /^approve/i }).click();
    const dialog = page.getByRole('dialog');
    if (await dialog.isVisible()) await dialog.getByRole('button', { name: /approve/i }).click();
    await expect(page.getByTestId('ticket-status')).toHaveText(/done/i, { timeout: 60_000 });

    // The ticket branch was merged into main on the runner machine.
    const log = run('git', ['log', '--oneline', 'main'], state.repoDir);
    expect(log).toMatch(/Merge DEMO-1/);
    expect(readFileSync(join(state.repoDir, 'FAKE_CHANGES.md'), 'utf8')).toContain('FAKE_CHANGES');

    // --- audit trail -------------------------------------------------------------------------
    await page.goto(`/w/${workspaceId}/audit`);
    await expect(page.getByText('runner.paired')).toBeVisible();
    await expect(page.getByText('review.approve')).toBeVisible();
  } finally {
    if (runner.pid) killTree(runner.pid);
  }
});

async function startFakeRun(page: Page): Promise<void> {
  await page.getByRole('combobox', { name: /cli/i }).click();
  await page.getByRole('option', { name: /fake/i }).click();
  await page.getByRole('button', { name: /start run/i }).click();
}
