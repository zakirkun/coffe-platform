import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { TMP_DIR } from './env.js';

/** Starts a long-running process with output captured to `e2e/.tmp/<name>.log`. */
export function startProcess(
  name: string,
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string> },
): ChildProcess {
  const log = createWriteStream(join(TMP_DIR, `${name}.log`), { flags: 'a' });
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32' && !command.endsWith('.exe'),
    windowsHide: true,
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  return child;
}

/** Kills a process tree (Windows needs taskkill for children spawned through a shell). */
export function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}

/** Polls `url` until it answers with any HTTP status (the server is listening). */
export async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { redirect: 'manual' });
      return;
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  throw new Error(`timed out waiting for ${url}: ${String(lastError)}`);
}

/** Runs a short command and returns stdout; throws with stderr on failure. */
export function run(
  command: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): string {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}
