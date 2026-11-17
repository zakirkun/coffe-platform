import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { TMP_DIR } from '../support/env.js';
import {
  createProject,
  createTicket,
  pairRunner,
  scratchRepository,
  signUpWithWorkspace,
} from '../support/flows.js';
import { killTree } from '../support/processes.js';

const SEEDED_PERSONAS = ['Planner', 'Implementer', 'Tester', 'Reviewer'];

/**
 * Phase 2 end to end with a real runner and the fake CLI: the seeded personas are switched to the
 * fake CLI in the persona editor → a card is dragged across the board → the default workflow runs
 * implementer, tester and reviewer on a ticket until it is In Review → a requirement is planned
 * into drafts and approved into Backlog tickets → the usage page attributes runs to personas.
 */
test('personas, board drag and drop, a workflow, planning and usage', async ({ page }) => {
  test.setTimeout(420_000);
  const repoDir = scratchRepository(join(TMP_DIR, 'flow-repo'));
  const workspaceId = await signUpWithWorkspace(page, 'Flow Workspace');
  const runner = await pairRunner(page, workspaceId, {
    home: join(TMP_DIR, 'runner-home-flow'),
    repoDir,
    repoName: 'flow',
    runnerName: 'flow-runner',
  });

  try {
    const projectId = await createProject(page, workspaceId, 'Flow', 'FLOW', 'flow');

    // --- personas: the seeded team, switched to the fake CLI in the editor -------------------
    await page.goto(`/w/${workspaceId}/personas`);
    for (const name of SEEDED_PERSONAS) {
      await page.getByRole('button', { name: `Edit ${name}` }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('combobox', { name: 'CLI' }).click();
      await page.getByRole('option', { name: /Fake CLI/ }).click();
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog).toBeHidden();
    }
    await expect(page.getByText(/^Fake CLI/)).toHaveCount(SEEDED_PERSONAS.length);

    // --- board: two tickets, the second dragged from Backlog to Ready ---------------------------
    await page.goto(`/w/${workspaceId}/p/${projectId}`);
    await createTicket(page, 'Add a changes file', 'Create FAKE_CHANGES.md describing the change.');
    await createTicket(page, 'Polish the readme', 'Tidy up README.md.');
    const ready = page.getByRole('region', { name: 'Ready' });
    await drag(page, page.getByTestId('ticket-card').filter({ hasText: 'FLOW-2' }), ready);
    // The link role skips the inert placeholder dnd-kit shows during the drop animation.
    await expect(ready.getByRole('link', { name: /FLOW-2/ })).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole('region', { name: 'Ready' }).getByRole('link', { name: /FLOW-2/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Backlog' }).getByRole('link', { name: /FLOW-1/ }),
    ).toBeVisible();

    // --- workflow: implement → test → review ---------------------------------------------------
    await page.getByRole('link', { name: /FLOW-1/ }).click();
    await page.waitForURL(/\/t\/[0-9a-f-]+/);
    await page.getByRole('button', { name: /start workflow/i }).click();
    await expect(page.getByText('Implement → Test → Review: Completed')).toBeVisible({
      timeout: 180_000,
    });
    const steps = page.getByRole('list', { name: 'Workflow steps' });
    for (const step of ['Implement', 'Test', 'Review']) {
      await expect(
        steps.getByRole('listitem').filter({ hasText: step }).getByText('completed'),
      ).toBeVisible();
    }
    await expect(page.getByTestId('ticket-status')).toHaveText(/in review/i);

    // --- planning: requirement → fake planner → drafts → approved backlog tickets -------------
    await page.goto(`/w/${workspaceId}/p/${projectId}/plan`);
    await page.getByLabel('New requirement').fill('Cart badge');
    await page
      .getByRole('textbox', { name: 'Requirement', exact: true })
      .fill('Show the item count on the cart icon. [[fake:plan]]');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('button', { name: /plan tickets/i }).click();
    await expect(page.getByRole('textbox', { name: 'Draft 1 title' })).toHaveValue(
      'Add the badge component',
      { timeout: 120_000 },
    );
    await expect(page.getByRole('textbox', { name: 'Draft 2 title' })).toHaveValue(
      'Show the badge on the cart icon',
    );
    await expect(page.getByText('After #1')).toBeVisible();
    await page.getByRole('button', { name: /approve 2 tickets/i }).click();
    await expect(page.getByRole('link', { name: 'Open ticket' })).toHaveCount(2);
    await page.goto(`/w/${workspaceId}/p/${projectId}`);
    await expect(
      page.getByRole('region', { name: 'Backlog' }).getByText('Show the badge on the cart icon'),
    ).toBeVisible();
    // The second planned ticket waits for the first (FLOW-3 → FLOW-4).
    await expect(
      page.getByTestId('ticket-card').filter({ hasText: 'FLOW-4' }).getByText('After FLOW-3'),
    ).toBeVisible();

    // --- usage per persona ----------------------------------------------------------------------
    await page.goto(`/w/${workspaceId}/usage`);
    await page.getByRole('combobox', { name: 'Group by' }).selectOption('persona');
    for (const name of SEEDED_PERSONAS) {
      await expect(page.getByRole('cell', { name, exact: true })).toBeVisible();
    }
  } finally {
    if (runner.pid) killTree(runner.pid);
  }
});

/** Drags with real pointer events (dnd-kit activates after a few pixels of movement). */
async function drag(page: Page, source: Locator, target: Locator): Promise<void> {
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('the card or the column is not on screen');
  // Grab the card by its padding, away from the ticket link.
  const start = { x: from.x + 4, y: from.y + 4 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 12, start.y + 12, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + Math.min(80, to.height / 2), { steps: 25 });
  await page.mouse.up();
}
