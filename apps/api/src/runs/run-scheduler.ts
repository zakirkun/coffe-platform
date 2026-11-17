import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, inArray, ne } from 'drizzle-orm';
import { ApiException } from '../common/api-error.js';
import { ACTIVE_RUN_STATUSES } from '../common/run-status.js';
import type { Database } from '../db/client.js';
import { DB } from '../db/db.module.js';
import { projectRepos, runnerClis, runnerRepos, runners, runs } from '../db/schema/index.js';
import { RunnerHub } from '../runners/runner-hub.js';

/** Where a run executes: a runner and its checkout of the project's repository. */
export interface Placement {
  runnerId: string;
  runnerName: string;
  repoId: string;
  defaultBranch: string | null;
  /** CLIs detected on that runner. */
  clis: string[];
}

export interface PlacementRequest {
  workspaceId: string;
  projectId: string;
  /** Required CLI; `undefined` = any (the caller picks one of `Placement.clis`). */
  cliId?: string;
  /** The runner and repository that already hold the ticket's worktree. */
  sticky?: { runnerId: string | null; repoId: string | null };
  repoId?: string;
  runnerId?: string;
}

interface Candidate extends Placement {
  online: boolean;
  primary: boolean;
  freeSlots: number;
}

/**
 * Runner selection (architecture §11.5): sticky to the worktree once a ticket ran; otherwise the
 * project's bound repositories whose runner has the CLI, preferring online runners with free
 * slots, then the primary binding. Runs on an offline or busy runner queue until it has room.
 */
@Injectable()
export class RunScheduler {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly hub: RunnerHub,
  ) {}

  async place(request: PlacementRequest): Promise<Placement> {
    const repoFilter = request.sticky?.repoId ?? request.repoId;
    const runnerFilter = request.sticky?.runnerId ?? request.runnerId;
    const rows = await this.db
      .select({
        runnerId: runners.id,
        runnerName: runners.name,
        maxConcurrentRuns: runners.maxConcurrentRuns,
        repoId: runnerRepos.id,
        defaultBranch: runnerRepos.defaultBranch,
        primary: projectRepos.isPrimary,
      })
      .from(projectRepos)
      .innerJoin(runnerRepos, eq(runnerRepos.id, projectRepos.runnerRepoId))
      .innerJoin(runners, eq(runners.id, runnerRepos.runnerId))
      .where(
        and(
          eq(projectRepos.projectId, request.projectId),
          eq(runners.workspaceId, request.workspaceId),
          ne(runners.status, 'revoked'),
        ),
      );
    // A worktree outlives its binding: a sticky ticket keeps its repository even if it was unbound.
    if (repoFilter && !rows.some((row) => row.repoId === repoFilter)) {
      const [bound] = await this.db
        .select({
          runnerId: runners.id,
          runnerName: runners.name,
          maxConcurrentRuns: runners.maxConcurrentRuns,
          repoId: runnerRepos.id,
          defaultBranch: runnerRepos.defaultBranch,
        })
        .from(runnerRepos)
        .innerJoin(runners, eq(runners.id, runnerRepos.runnerId))
        .where(and(eq(runnerRepos.id, repoFilter), eq(runners.workspaceId, request.workspaceId), ne(runners.status, 'revoked')))
        .limit(1);
      if (bound) rows.push({ ...bound, primary: false });
    }
    const eligible = rows.filter(
      (row) => (!repoFilter || row.repoId === repoFilter) && (!runnerFilter || row.runnerId === runnerFilter),
    );
    if (eligible.length === 0) {
      throw repoFilter || runnerFilter
        ? ApiException.conflict('runner_unavailable', 'The runner holding this ticket is revoked or no longer has the repository')
        : ApiException.conflict('no_repo', 'Bind a repository to the project before starting a run');
    }

    const runnerIds = [...new Set(eligible.map((row) => row.runnerId))];
    const clis = await this.db
      .select({ runnerId: runnerClis.runnerId, cliId: runnerClis.cliId })
      .from(runnerClis)
      .where(inArray(runnerClis.runnerId, runnerIds));
    const busy = await this.db
      .select({ runnerId: runs.runnerId, active: count() })
      .from(runs)
      .where(and(inArray(runs.runnerId, runnerIds), inArray(runs.status, ACTIVE_RUN_STATUSES)))
      .groupBy(runs.runnerId);

    const candidates: Candidate[] = eligible.map((row) => ({
      runnerId: row.runnerId,
      runnerName: row.runnerName,
      repoId: row.repoId,
      defaultBranch: row.defaultBranch,
      clis: clis.filter((cli) => cli.runnerId === row.runnerId).map((cli) => cli.cliId),
      online: this.hub.isOnline(row.runnerId),
      primary: row.primary,
      freeSlots: row.maxConcurrentRuns - (busy.find((entry) => entry.runnerId === row.runnerId)?.active ?? 0),
    }));
    const capable = request.cliId
      ? candidates.filter((candidate) => request.cliId && candidate.clis.includes(request.cliId))
      : candidates.filter((candidate) => candidate.clis.length > 0);
    if (capable.length === 0) {
      const names = [...new Set(candidates.map((candidate) => candidate.runnerName))].join(', ');
      throw request.cliId
        ? ApiException.conflict('cli_not_detected', `${request.cliId} is not installed on runner ${names}`)
        : ApiException.conflict('no_cli', `No agent CLI was detected on runner ${names}`);
    }
    const [best] = capable.toSorted(
      (a, b) =>
        Number(b.online) - Number(a.online) ||
        Number(b.freeSlots > 0) - Number(a.freeSlots > 0) ||
        Number(b.primary) - Number(a.primary) ||
        b.freeSlots - a.freeSlots,
    );
    if (!best) throw new Error('no capable runner after filtering');
    return { runnerId: best.runnerId, runnerName: best.runnerName, repoId: best.repoId, defaultBranch: best.defaultBranch, clis: best.clis };
  }
}
