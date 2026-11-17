import { defineConfig, devices } from '@playwright/test';
import { WEB_URL } from './support/env.js';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../playwright-report' }]],
  outputDir: '../test-results',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      // `E2E_BROWSER_CHANNEL=msedge` (or `chrome`) uses an installed browser instead of the
      // downloaded Playwright build.
      use: { ...devices['Desktop Chrome'], channel: process.env.E2E_BROWSER_CHANNEL || undefined },
    },
  ],
});
