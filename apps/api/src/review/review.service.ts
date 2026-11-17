import type {
  ApproveResponse,
  Diff,
  FileContentResponse,
  Merge,
  RequestChangesResponse,
  Review,
  ReviewState,
  TestResult,
} from '@coffe/contracts';
import type { DiffSummary, GitFileResult, GitMergeResult } from '@coffe/protocol';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, max } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { ApiException } from '../common/api-error.js';
import type { Database } from '../db/client.js';
import { DB } from '../db/db.module.js';
import { diffs, merges, projects, reviews, runnerRepos, runs, testResults, user } from '../db/schema/index.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { RunnerHub, assertReply, runnerRequestFailure } from '../runners/runner-hub.js';
import { type RunRow, RunStore, toDiffRow } from '../runs/run-store.js';
import { RunsService } from '../runs/runs.service.js';
import { type TicketRow, TicketsService } from '../tickets/tickets.service.js';

const DIFF_TIMEOUT_MS = 60_000;
const FILE_TIMEOUT_MS = 30_000;
const MERGE_TIMEOUT_MS = 120_000;
/** Largest file relayed to the diff viewer. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

type DiffRow = typeof diffs.$inferSelect;
type MergeRow = typeof merges.$inferSelect;
type TestRow = typeof testResults.$inferSelect;

function toDiff(row: DiffRow): Diff {
  return {
    id: row.id,
    ticketId: row.ticketId,
    runId: row.runId,
    baseCommit: row.baseCommit,
    headCommit: row.headCommit,
    additions: row.additions,
    deletions: row.deletions,
    files: row.files.map((file) => ({
      path: file.path,
      oldPath: file.old_path ?? null,
      status: file.status,
      additions: file.additions ?? null,
      deletions: file.deletions ?? null,
      binary: file.binary,
    })),
    patch: row.patch,
    truncated: row.truncated,
    createdAt: row.createdAt.toISOString(),
  };
}

function toMerge(row: MergeRow): Merge {
  return {
    id: row.id,
    ticketId: row.ticketId,
    reviewId: row.reviewId,
    strategy: row.strategy,
    targetBranch: row.targetBranch,
    mergeCommit: row.mergeCommit,
    pushed: row.pushed,
    status: row.status,
    conflicts: row.conflicts,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

function toTestResult(row: TestRow): TestResult {
  const failures = Array.isArray(row.report.failures) ? row.report.failures : [];
  return {
    id: row.id,
    runId: row.runId,
    source: row.source,
    command: row.command,
    status: row.status,
    passed: row.passed,
    failed: row.failed,
    skipped: row.skipped,
    durationMs: row.durationMs,
    failures: failures.flatMap((failure: unknown) =>
      typeof failure === 'object' && failure !== null && 'name' in failure && typeof failure.name === 'string'
        ? [{ name: failure.name, message: 'message' in failure && typeof failure.message === 'string' ? failure.message : null }]
        : [],
    ),
    outputTail: row.outputTail,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Review gate of a ticket (architecture §11.7): diff, tests, decisions and the merge. */
@Injectable()
export class ReviewService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly hub: RunnerHub,
    private readonly tickets: TicketsService,
    private readonly runStore: RunStore,
    private readonly runs: RunsService,
    private readonly realtime: RealtimeService,
    private readonly audit: AuditService,
  ) {}

  async state(workspaceId: string, ticketId: string): Promise<ReviewState> {
    const ticket = await this.tickets.getRow(workspaceId, ticketId);
    const [diff] = await this.db
      .select()
      .from(diffs)
      .where(eq(diffs.ticketId, ticket.id))
      .orderBy(desc(diffs.createdAt))
      .limit(1);
    const tests = await this.db
      .select()
      .from(testResults)
      .where(eq(testResults.ticketId, ticket.id))
      .orderBy(desc(testResults.createdAt))
      .limit(20);
    const latestRun = await this.latestRun(ticket.id);
    const blockers: string[] = [];
    if (ticket.status !== 'in_review') blockers.push('The ticket is not in review');
    if (!diff) blockers.push('There is no diff to review yet');
    if (latestRun && !latestRun.endedAt) blockers.push('A run of this ticket is still active');
    if (!ticket.worktreeRunnerId || !this.hub.isOnline(ticket.worktreeRunnerId)) {
      blockers.push('The runner holding the worktree is offline');
    }
    return {
      diff: diff ? toDiff(diff) : null,
      tests: tests.map(toTestResult),
      reviews: await this.reviews(ticket.id),
      merges: (
        await this.db.select().from(merges).where(eq(merges.ticketId, ticket.id)).orderBy(desc(merges.createdAt))
      ).map(toMerge),
      latestRun: latestRun ? await this.runStore.toDto(latestRun) : null,
      canApprove: blockers.length === 0,
      blockers,
    };
  }

  async diff(workspaceId: string, ticketId: string): Promise<Diff> {
    const ticket = await this.tickets.getRow(workspaceId, ticketId);
    const [diff] = await this.db
      .select()
      .from(diffs)
      .where(eq(diffs.ticketId, ticket.id))
      .orderBy(desc(diffs.createdAt))
      .limit(1);
    if (!diff) throw ApiException.notFound('Diff');
    return toDiff(diff);
  }

  /** Recomputes the diff of the ticket branch on the runner. */
  async refreshDiff(workspaceId: string, userId: string, ticketId: string): Promise<Diff> {
    const ticket = await this.tickets.getRow(workspaceId, ticketId);
    const { runnerId, repoKey, branch } = await this.worktree(ticket);
    let diff: DiffSummary;
    try {
      const reply = await this.hub.request(
        runnerId,
        { type: 'git.diff', payload: { repo_key: repoKey, branch, base: ticket.baseBranch, include_patch: true } },
        DIFF_TIMEOUT_MS,
        { actorUserId: userId },
      );
      assertReply(reply, 'git.diff.result');
      diff = reply.payload.diff;
    } catch (error) {
      throw runnerRequestFailure(error);
    }
    const latest = await this.latestRun(ticket.id);
    const [row] = await this.db
      .insert(diffs)
      .values({ ...toDiffRow(diff), runId: latest?.id ?? null, ticketId: ticket.id })
      .returning();
    if (!row) throw new Error('diff insert returned no row');
    this.realtime.publish(`ticket:${ticket.id}`, { ev: 'review.updated', ticketId: ticket.id });
    return toDiff(row);
  }

  /** A file of the ticket's repository at a commit, relayed from the runner and never stored. */
  async file(workspaceId: string, userId: string, ticketId: string, rev: string, path: string): Promise<FileContentResponse> {
    const ticket = await this.tickets.getRow(workspaceId, ticketId);
    const { runnerId, repoKey } = await this.worktree(ticket);
    let file: GitFileResult;
    try {
      const reply = await this.hub.request(
        runnerId,
        { type: 'git.file', payload: { repo_key: repoKey, rev, path, max_bytes: MAX_FILE_BYTES } },
        FILE_TIMEOUT_MS,
        { actorUserId: userId },
      );
      assertReply(reply, 'git.file.result');
      file = reply.payload;
    } catch (error) {
      throw runnerRequestFailure(error);
    }
    return {
      path: file.path,
      rev: file.rev,
      content: file.content != null && !file.binary ? Buffer.from(file.content, 'base64').toString('utf8') : null,
      size: file.size,
      binary: file.binary,
      tooLarge: file.too_large,
      missing: file.missing,
    };
  }

  /** Approve: records the decision, merges the branch on the runner, moves the ticket to Done. */
  async approve(workspaceId: string, userId: string, ticketId: string, body: string): Promise<ApproveResponse> {
    const ticket = await this.tickets.getRow(workspaceId, ticketId);
    const state = await this.state(workspaceId, ticketId);
    if (!state.canApprove) {
      throw ApiException.conflict('cannot_approve', state.blockers.join('; '), { blockers: state.blockers });
    }
    const { runnerId, repoKey, branch } = await this.worktree(ticket);
    const [project] = await this.db.select().from(projects).where(eq(projects.id, ticket.projectId)).limit(1);
    if (!project) throw ApiException.notFound('Project');
    const strategy = project.settings.merge_strategy ?? 'merge';
    const into = ticket.baseBranch ?? 'main';

    const { review, merge } = await this.db.transaction(async (tx) => {
      const [review] = await tx
        .insert(reviews)
        .values({
          ticketId: ticket.id,
          diffId: state.diff?.id ?? null,
          runId: state.latestRun?.id ?? null,
          round: (await this.lastRound(ticket.id)) + 1,
          reviewerId: userId,
          decision: 'approved',
          body,
        })
        .returning();
      if (!review) throw new Error('review insert returned no row');
      const [merge] = await tx
        .insert(merges)
        .values({ ticketId: ticket.id, reviewId: review.id, strategy, targetBranch: into })
        .returning();
      if (!merge) throw new Error('merge insert returned no row');
      return { review, merge };
    });

    let result: GitMergeResult;
    try {
      const reply = await this.hub.request(
        runnerId,
        {
          type: 'git.merge',
          payload: {
            repo_key: repoKey,
            branch,
            into,
            strategy,
            message: `Merge ${ticket.key}: ${ticket.title}`,
            push: project.settings.push_on_approve === true,
            remote: project.settings.remote ?? null,
            remove_worktree: true,
          },
        },
        MERGE_TIMEOUT_MS,
        { actorUserId: userId },
      );
      assertReply(reply, 'git.merge.result');
      result = reply.payload;
    } catch (error) {
      const failure = runnerRequestFailure(error);
      await this.db.update(merges).set({ status: 'failed', error: failure.message }).where(eq(merges.id, merge.id));
      this.realtime.publish(`ticket:${ticket.id}`, { ev: 'review.updated', ticketId: ticket.id });
      throw failure;
    }

    const [mergeRow] = await this.db
      .update(merges)
      .set({
        status: result.status,
        mergeCommit: result.merge_commit ?? null,
        pushed: result.pushed,
        conflicts: result.conflicts ?? [],
        error: result.status === 'failed' ? (result.message ?? 'merge failed') : null,
      })
      .where(eq(merges.id, merge.id))
      .returning();
    if (result.status === 'merged' || result.status === 'nothing_to_merge') {
      await this.tickets.setStatus(ticket.id, 'done', { failed: false, mergeConflict: false });
    } else if (result.status === 'conflict') {
      await this.tickets.setStatus(ticket.id, 'in_review', { mergeConflict: true });
    }
    await this.audit.record({
      workspaceId,
      actorType: 'user',
      actorUserId: userId,
      runnerId,
      action: 'git.merge',
      targetType: 'ticket',
      targetId: ticket.id,
      command: `merge ${branch} into ${into} (${strategy})`,
      details: { status: result.status, mergeCommit: result.merge_commit ?? null, pushed: result.pushed },
    });
    this.realtime.publish(`ticket:${ticket.id}`, { ev: 'review.updated', ticketId: ticket.id });
    if (result.status === 'failed') {
      throw new ApiException(HttpStatus.BAD_GATEWAY, 'merge_failed', result.message ?? 'The merge failed on the runner');
    }
    const [reviewDto] = await this.reviews(ticket.id, review.id);
    if (!reviewDto || !mergeRow) throw new Error('review or merge vanished');
    return { review: reviewDto, merge: toMerge(mergeRow) };
  }

  /** Request changes: records the decision and sends the feedback back to the agent. */
  async requestChanges(workspaceId: string, userId: string, ticketId: string, body: string): Promise<RequestChangesResponse> {
    const ticket = await this.tickets.getRow(workspaceId, ticketId);
    if (ticket.status !== 'in_review') {
      throw ApiException.conflict('not_in_review', 'Only tickets in review can get change requests');
    }
    const latest = await this.latestRun(ticket.id);
    if (latest && !latest.endedAt) {
      throw ApiException.conflict('run_active', 'A run of this ticket is still active');
    }
    const [diff] = await this.db
      .select({ id: diffs.id })
      .from(diffs)
      .where(eq(diffs.ticketId, ticket.id))
      .orderBy(desc(diffs.createdAt))
      .limit(1);
    const [review] = await this.db
      .insert(reviews)
      .values({
        ticketId: ticket.id,
        diffId: diff?.id ?? null,
        runId: latest?.id ?? null,
        round: (await this.lastRound(ticket.id)) + 1,
        reviewerId: userId,
        decision: 'changes_requested',
        body,
      })
      .returning();
    if (!review) throw new Error('review insert returned no row');
    const run = await this.runs.startChangesRequested(workspaceId, userId, ticket, latest, body);
    this.realtime.publish(`ticket:${ticket.id}`, { ev: 'review.updated', ticketId: ticket.id });
    const [reviewDto] = await this.reviews(ticket.id, review.id);
    if (!reviewDto) throw new Error('review vanished');
    return { review: reviewDto, run };
  }

  private async reviews(ticketId: string, onlyId?: string): Promise<Review[]> {
    const rows = await this.db
      .select({ review: reviews, reviewerName: user.name })
      .from(reviews)
      .leftJoin(user, eq(user.id, reviews.reviewerId))
      .where(onlyId ? and(eq(reviews.ticketId, ticketId), eq(reviews.id, onlyId)) : eq(reviews.ticketId, ticketId))
      .orderBy(desc(reviews.round), desc(reviews.createdAt));
    return rows.map(({ review, reviewerName }) => ({
      id: review.id,
      ticketId: review.ticketId,
      diffId: review.diffId,
      runId: review.runId,
      round: review.round,
      reviewerId: review.reviewerId,
      reviewerName: reviewerName ?? null,
      decision: review.decision,
      body: review.body,
      createdAt: review.createdAt.toISOString(),
    }));
  }

  private async lastRound(ticketId: string): Promise<number> {
    const [row] = await this.db.select({ round: max(reviews.round) }).from(reviews).where(eq(reviews.ticketId, ticketId));
    return row?.round ?? 0;
  }

  private async latestRun(ticketId: string): Promise<RunRow | null> {
    const [row] = await this.db
      .select()
      .from(runs)
      .where(eq(runs.ticketId, ticketId))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(1);
    return row ?? null;
  }

  /** Runner, repository key and branch of the ticket's worktree. */
  private async worktree(ticket: TicketRow): Promise<{ runnerId: string; repoKey: string; branch: string }> {
    if (!ticket.worktreeRunnerId || !ticket.repoId || !ticket.branch) {
      throw ApiException.conflict('no_worktree', 'The ticket has not run yet');
    }
    const [repo] = await this.db
      .select({ repoKey: runnerRepos.repoKey })
      .from(runnerRepos)
      .where(eq(runnerRepos.id, ticket.repoId))
      .limit(1);
    if (!repo) throw ApiException.notFound('Repository');
    return { runnerId: ticket.worktreeRunnerId, repoKey: repo.repoKey, branch: ticket.branch };
  }
}
