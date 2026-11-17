import type { RunStatus } from '@coffe/contracts';

/** Statuses of a run that occupies a runner slot (architecture §11.1). */
export const ACTIVE_RUN_STATUSES = [
  'dispatched',
  'starting',
  'running',
  'paused',
  'waiting_input',
] as const satisfies readonly RunStatus[];

/** Statuses of a run that still blocks its ticket: waiting for a runner or occupying one. */
export const OPEN_RUN_STATUSES = ['queued', ...ACTIVE_RUN_STATUSES] as const;

export function isActiveRunStatus(status: RunStatus): boolean {
  return (ACTIVE_RUN_STATUSES as readonly RunStatus[]).includes(status);
}
