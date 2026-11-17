import {
  type ProjectRepoBinding,
  RUN_MODES,
  RunMode,
  type Runner,
  type RunnerCli,
  type Ticket,
} from '@coffe/contracts';
import { z } from 'zod';

export interface CliOption {
  cliId: string;
  name: string;
  version: string | null;
  authStatus: string;
  /** Modes the adapter supports, in the adapter's preference order. */
  modes: RunMode[];
  /** Runners (by name) on which this CLI was detected. */
  runnerNames: string[];
}

const ModeList = z.array(RunMode).min(1);

/** Modes reported in the CLI's capabilities; both when the runner did not report any. */
function supportedModes(cli: RunnerCli): RunMode[] {
  const parsed = ModeList.safeParse(cli.capabilities.modes);
  return parsed.success ? parsed.data : [...RUN_MODES];
}

/**
 * CLIs a run of this ticket can use. Scheduling is sticky (architecture §11.5): once a ticket
 * has a worktree only that runner counts; before that, the runner of the ticket's repository,
 * or any runner bound to the project.
 */
export function cliOptionsForTicket(
  ticket: Pick<Ticket, 'worktreeRunnerId' | 'repoId'>,
  bindings: readonly ProjectRepoBinding[],
  runners: readonly Runner[],
): CliOption[] {
  const repoBinding = bindings.find((binding) => binding.repo.id === ticket.repoId);
  const runnerIds = ticket.worktreeRunnerId
    ? [ticket.worktreeRunnerId]
    : repoBinding
      ? [repoBinding.runnerId]
      : bindings.map((binding) => binding.runnerId);

  const options = new Map<string, CliOption>();
  for (const runner of runners) {
    if (runner.status === 'revoked' || !runnerIds.includes(runner.id)) continue;
    for (const cli of runner.clis) {
      const modes = supportedModes(cli);
      const existing = options.get(cli.cliId);
      if (!existing) {
        options.set(cli.cliId, {
          cliId: cli.cliId,
          name: cli.name,
          version: cli.version,
          authStatus: cli.authStatus,
          modes,
          runnerNames: [runner.name],
        });
        continue;
      }
      existing.runnerNames.push(runner.name);
      for (const mode of modes) {
        if (!existing.modes.includes(mode)) existing.modes.push(mode);
      }
    }
  }
  return [...options.values()];
}
