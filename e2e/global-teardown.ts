import { existsSync, readFileSync } from 'node:fs';
import { type E2eState, STATE_FILE } from './support/env.js';
import { killTree } from './support/processes.js';

export default async function globalTeardown(): Promise<void> {
  if (!existsSync(STATE_FILE)) return;
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as E2eState;
  for (const pid of state.pids) killTree(pid);
}
