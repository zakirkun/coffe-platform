// Dev loop for the control plane: `tsc --watch` rebuilds `dist/`, `node --watch` restarts the
// server on every rebuild. Plain child processes (no shell), so it behaves the same on Windows,
// macOS and Linux. `pnpm dev` builds once before starting this script.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');

const commands = [
  ['tsc', [tsc, '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput']],
  ['api', ['--watch', '--env-file-if-exists=.env', 'dist/main.js']],
];

let stopping = false;
const children = commands.map(([name, args]) => {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', shell: false });
  child.on('error', (error) => {
    console.error(`[dev] failed to start ${name}: ${error.message}`);
    stop(1);
  });
  child.on('exit', (code, signal) => {
    if (!stopping) console.error(`[dev] ${name} exited (${signal ?? code ?? 'unknown'})`);
    stop(code ?? 1);
  });
  return child;
});

/** Stops both processes; the first exit code wins. */
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stop(0));
}
