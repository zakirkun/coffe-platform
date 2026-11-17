import { type RunStatus, TERMINAL_RUN_STATUSES } from '@coffe/contracts';

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  queued: 'Queued',
  dispatched: 'Dispatched',
  starting: 'Starting',
  running: 'Running',
  paused: 'Paused',
  waiting_input: 'Waiting for input',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

/** The run occupies its ticket: queued, starting or executing (architecture §11.1). */
export function isRunActive(status: RunStatus): boolean {
  return !TERMINAL_RUN_STATUSES.includes(status) && status !== 'interrupted';
}

export interface RunControls {
  pause: boolean;
  resume: boolean;
  interrupt: boolean;
  stop: boolean;
}

/** Which signals make sense in a given state; the server remains the authority. */
export function availableRunControls(status: RunStatus): RunControls {
  return {
    pause: status === 'running',
    resume: status === 'paused',
    interrupt: status === 'running' || status === 'waiting_input',
    stop: isRunActive(status),
  };
}
