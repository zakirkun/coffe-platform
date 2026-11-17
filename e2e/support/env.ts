import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const TMP_DIR = join(REPO_ROOT, 'e2e', '.tmp');
export const STATE_FILE = join(TMP_DIR, 'state.json');

export const API_PORT = Number(process.env.E2E_API_PORT ?? 4100);
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3100);
export const API_URL = `http://localhost:${API_PORT}`;
export const WEB_URL = `http://localhost:${WEB_PORT}`;

export const ADMIN_DATABASE_URL =
  process.env.E2E_ADMIN_DATABASE_URL ?? 'postgres://coffe:coffe@localhost:55432/coffe';
export const E2E_DATABASE = 'coffe_e2e';
export const DATABASE_URL = ADMIN_DATABASE_URL.replace(/\/[^/]+$/, `/${E2E_DATABASE}`);

const exe = process.platform === 'win32' ? '.exe' : '';
export const TARGET_DIR = join(REPO_ROOT, 'target', 'debug');
export const RUNNER_BIN = join(TARGET_DIR, `coffe-runner${exe}`);
export const FAKE_CLI_BIN = join(TARGET_DIR, `coffe-fake-cli${exe}`);

export interface E2eState {
  pids: number[];
  repoDir: string;
  runnerHome: string;
}

export function requireBuilt(path: string, hint: string): string {
  if (!existsSync(path)) throw new Error(`${path} is missing — run \`${hint}\` first`);
  return path;
}
