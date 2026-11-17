import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import {
  ADMIN_DATABASE_URL,
  API_PORT,
  API_URL,
  DATABASE_URL,
  E2E_DATABASE,
  type E2eState,
  FAKE_CLI_BIN,
  REPO_ROOT,
  RUNNER_BIN,
  requireBuilt,
  STATE_FILE,
  TMP_DIR,
  WEB_PORT,
  WEB_URL,
} from './support/env.js';
import { run, startProcess, waitForHttp } from './support/processes.js';

/**
 * Boots a fresh stack for the end-to-end suite: empty database, built API on API_PORT, Next dev
 * server on WEB_PORT (its dev rewrites proxy /api to the API), and a scratch git repository the
 * runner will register. Binaries must be built beforehand (see package.json `test:e2e`).
 */
export default async function globalSetup(): Promise<void> {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
  requireBuilt(RUNNER_BIN, 'cargo build -p coffe-runner -p coffe-fake-cli');
  requireBuilt(FAKE_CLI_BIN, 'cargo build -p coffe-runner -p coffe-fake-cli');
  requireBuilt(join(REPO_ROOT, 'apps/api/dist/main.js'), 'pnpm --filter "@coffe/api..." build');

  const admin = new pg.Client({ connectionString: ADMIN_DATABASE_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${E2E_DATABASE} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${E2E_DATABASE}`);
  await admin.end();

  const api = startProcess('api', process.execPath, ['dist/main.js'], {
    cwd: join(REPO_ROOT, 'apps/api'),
    env: {
      NODE_ENV: 'test',
      PORT: String(API_PORT),
      DATABASE_URL,
      PUBLIC_URL: WEB_URL,
      RUNNER_PUBLIC_URL: API_URL,
      TRUSTED_ORIGINS: WEB_URL,
      AUTH_SECRET: 'e2e-secret-e2e-secret-e2e-secret-e2e-secret',
      RUN_MIGRATIONS: 'true',
      LOG_LEVEL: 'info',
    },
  });
  const web = startProcess('web', 'pnpm', ['exec', 'next', 'dev', '--port', String(WEB_PORT)], {
    cwd: join(REPO_ROOT, 'apps/web'),
    env: {
      API_URL,
      NEXT_PUBLIC_WS_URL: `ws://localhost:${API_PORT}/api/ws`,
      NEXT_TELEMETRY_DISABLED: '1',
    },
  });
  await waitForHttp(`${API_URL}/api/v1/me`, 60_000);
  await waitForHttp(WEB_URL, 120_000);

  const repoDir = join(TMP_DIR, 'demo-repo');
  mkdirSync(repoDir, { recursive: true });
  run('git', ['init', '-q', '-b', 'main'], repoDir);
  run('git', ['config', 'user.email', 'e2e@coffe.local'], repoDir);
  run('git', ['config', 'user.name', 'COFFE e2e'], repoDir);
  writeFileSync(join(repoDir, 'README.md'), '# Demo repository\n');
  run('git', ['add', '.'], repoDir);
  run('git', ['commit', '-q', '-m', 'initial commit'], repoDir);

  const state: E2eState = {
    pids: [api.pid, web.pid].filter((pid): pid is number => typeof pid === 'number'),
    repoDir,
    runnerHome: join(TMP_DIR, 'runner-home'),
  };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
