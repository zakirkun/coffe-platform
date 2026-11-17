import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { type E2eState, STATE_FILE } from '../support/env.js';
import { createProject, createTicket, pairRunner, signUpWithWorkspace } from '../support/flows.js';
import { killTree, run } from '../support/processes.js';

/**
 * Phase 1 demo end to end: sign up → workspace → pair a real runner → register a repository →
 * project → ticket → run the fake CLI in a worktree → live terminal → follow-up input → review the
 * diff → approve → branch merged into main on the runner.
 */
test('pair a runner, run a ticket, review and approve the diff', async ({ page }) => {
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as E2eState;
  const workspaceId = await signUpWithWorkspace(page, 'E2E Workspace');
  const runner = await pairRunner(page, workspaceId, {
    home: state.runnerHome,
    repoDir: state.repoDir,
    repoName: 'demo',
    runnerName: 'e2e-runner',
  });

  try {
    // --- project and ticket ----------------------------------------------------------------
    await createProject(page, workspaceId, 'Demo', 'DEMO', 'demo');
    await createTicket(page, 'Add a changes file', 'Create FAKE_CHANGES.md describing the change.');
    await page.getByRole('link', { name: /DEMO-1/ }).click();
    await page.waitForURL(/\/t\/[0-9a-f-]+/);

    // --- run with the fake CLI and watch the terminal ---------------------------------------
    await startFakeRun(page);
    const terminal = page.getByTestId('run-terminal');
    // xterm.js pauses rendering while the terminal is outside the viewport.
    await terminal.scrollIntoViewIfNeeded();
    await expect(terminal).toContainText('turn complete', { timeout: 90_000 });
    await expect(page.getByTestId('run-status')).toHaveText(/completed/i, { timeout: 90_000 });

    // --- review and approve --------------------------------------------------------------------
    await page.getByRole('tab', { name: /review/i }).click();
    await expect(
      page.getByRole('list', { name: 'Changed files' }).getByText('FAKE_CHANGES.md'),
    ).toBeVisible({
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
