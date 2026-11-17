import type {
  PairingTokenResponse,
  Runner,
  RunnerRepo,
  UpdateRunnerRequest,
} from '@coffe/contracts';
import {
  type ActiveRun,
  type CliInfo,
  type Hello,
  isCompatible,
  PAIRING_TOKEN_PREFIX,
  type Pair,
  type Paired,
  PROTOCOL_VERSION,
  type RepoInfo,
  type ResumeCursor,
  RUNNER_TOKEN_PREFIX,
} from '@coffe/protocol';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, gt, inArray, isNull, lt, ne, notInArray, or, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { AuditService } from '../audit/audit.service.js';
import { ApiException } from '../common/api-error.js';
import { ACTIVE_RUN_STATUSES } from '../common/run-status.js';
import { generateToken, hashToken } from '../common/tokens.js';
import { AppConfig } from '../config/env.js';
import type { Database } from '../db/client.js';
import { DB, type DbExecutor } from '../db/db.module.js';
import {
  runnerClis,
  runnerPairingTokens,
  runnerRepos,
  runners,
  runs,
} from '../db/schema/index.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { runnerFingerprint } from './runner-keys.js';
import { isVersionAtLeast } from './semver.js';

export type RunnerRow = typeof runners.$inferSelect;
export type PairingTokenRow = typeof runnerPairingTokens.$inferSelect;
type RunnerRepoRow = typeof runnerRepos.$inferSelect;

/** Runners silent for longer than this are offline (architecture §8.6). */
const STALE_AFTER_MS = 60_000;
const PAIRING_TOKEN_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Architecture §13.1: pairing tokens are single use and live for 10 minutes. */
const PAIRING_TOKEN_TTL_MS = 10 * 60 * 1000;

export function toRunnerRepo(row: RunnerRepoRow): RunnerRepo {
  return {
    id: row.id,
    runnerId: row.runnerId,
    repoKey: row.repoKey,
    name: row.name,
    path: row.path,
    defaultBranch: row.defaultBranch,
    remoteUrl: row.remoteUrl,
    headCommit: row.headCommit,
    available: row.available,
  };
}

/** Persistent runner state: tokens, pairing, what a runner reported, online/offline. */
@Injectable()
export class RunnerRegistry {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly config: AppConfig,
    private readonly realtime: RealtimeService,
    private readonly audit: AuditService,
  ) {}

  /** A pairing token that can still be used: known, unexpired and not consumed. */
  async findPairingToken(token: string): Promise<PairingTokenRow | null> {
    const [row] = await this.db
      .select()
      .from(runnerPairingTokens)
      .where(
        and(
          eq(runnerPairingTokens.tokenHash, hashToken(token)),
          isNull(runnerPairingTokens.consumedAt),
          gt(runnerPairingTokens.expiresAt, new Date()),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** The runner owning a runner token, unless it was revoked. */
  async findRunnerByToken(token: string): Promise<RunnerRow | null> {
    const [row] = await this.db
      .select()
      .from(runners)
      .where(and(eq(runners.tokenHash, hashToken(token)), ne(runners.status, 'revoked')))
      .limit(1);
    return row ?? null;
  }

  /**
   * Consumes the pairing token and creates the runner in one transaction. Returns `null` when
   * the token was consumed or expired in the meantime (single use).
   */
  async pair(token: PairingTokenRow, pair: Pair, signPublicKey: Buffer): Promise<Paired | null> {
    const runnerId = uuidv7();
    const runnerToken = generateToken(RUNNER_TOKEN_PREFIX);
    const fingerprint = runnerFingerprint(signPublicKey);

    return this.db.transaction(async (tx) => {
      const now = new Date();
      const [claimed] = await tx
        .update(runnerPairingTokens)
        .set({ consumedAt: now, runnerId })
        .where(
          and(
            eq(runnerPairingTokens.id, token.id),
            isNull(runnerPairingTokens.consumedAt),
            gt(runnerPairingTokens.expiresAt, now),
          ),
        )
        .returning({ id: runnerPairingTokens.id });
      if (!claimed) return null;

      await tx.insert(runners).values({
        id: runnerId,
        workspaceId: token.workspaceId,
        name: pair.name.trim().slice(0, 100) || pair.hostname,
        hostname: pair.hostname,
        os: pair.os,
        arch: pair.arch,
        runnerVersion: pair.runner_version,
        tokenHash: hashToken(runnerToken),
        tokenPrefix: runnerToken.slice(0, 12),
        boxPublicKey: pair.keys.box_public_key,
        signPublicKey: pair.keys.sign_public_key,
        boxKeySignature: pair.keys.box_key_signature,
        fingerprint,
        status: 'offline',
        createdBy: token.createdBy,
      });
      await this.audit.record(
        {
          workspaceId: token.workspaceId,
          actorType: 'runner',
          actorUserId: token.createdBy,
          runnerId,
          action: 'runner.paired',
          targetType: 'runner',
          targetId: runnerId,
          details: {
            name: pair.name,
            hostname: pair.hostname,
            os: pair.os,
            arch: pair.arch,
            runnerVersion: pair.runner_version,
            fingerprint,
            pairingTokenId: token.id,
          },
        },
        tx,
      );
      return { runner_id: runnerId, workspace_id: token.workspaceId, runner_token: runnerToken, fingerprint };
    });
  }

  /** Remembers what a too-old runner reported, so the UI can show "needs update". */
  async recordVersions(runnerId: string, runnerVersion: string | null, protocol: string | null) {
    if (runnerVersion === null && protocol === null) return;
    await this.db
      .update(runners)
      .set({
        ...(runnerVersion !== null ? { runnerVersion } : {}),
        ...(protocol !== null ? { protocolVersion: protocol } : {}),
      })
      .where(eq(runners.id, runnerId));
  }

  /** Applies a `hello`: the runner is online with fresh metadata. False when it was revoked. */
  async applyHello(runnerId: string, hello: Hello): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(runners)
        .set({
          status: 'online',
          lastSeenAt: new Date(),
          runnerVersion: hello.runner_version,
          protocolVersion: hello.protocol,
          hostname: hello.hostname,
          os: hello.os,
          arch: hello.arch,
          capabilities: hello.capabilities,
          policy: { ...hello.policy },
          boxPublicKey: hello.keys.box_public_key,
          boxKeySignature: hello.keys.box_key_signature,
        })
        .where(and(eq(runners.id, runnerId), ne(runners.status, 'revoked')))
        .returning({ id: runners.id });
      if (!updated) return false;
      await this.replaceClis(runnerId, hello.clis, tx);
      await this.syncRepos(runnerId, hello.repos, tx);
      return true;
    });
  }

  /** Replaces the detection report of a runner (`hello.clis`, `clis.updated`). */
  async replaceClis(runnerId: string, clis: CliInfo[], executor: DbExecutor = this.db) {
    const detectedAt = new Date();
    const byId = new Map(clis.map((cli) => [cli.id, cli]));
    await executor.delete(runnerClis).where(eq(runnerClis.runnerId, runnerId));
    if (byId.size === 0) return;
    await executor.insert(runnerClis).values(
      [...byId.values()].map((cli) => ({
        runnerId,
        cliId: cli.id,
        name: cli.name,
        path: cli.path,
        version: cli.version ?? null,
        authStatus: cli.auth,
        capabilities: { ...cli.capabilities },
        detectedAt,
      })),
    );
  }

  /**
   * Upserts the reported repositories by `repo_key`; repositories the runner no longer reports
   * stay (bindings and tickets reference them) but become unavailable.
   */
  async syncRepos(runnerId: string, repos: RepoInfo[], executor: DbExecutor = this.db) {
    const reportedAt = new Date();
    const byKey = new Map(repos.map((repo) => [repo.repo_key, repo]));
    if (byKey.size > 0) {
      await executor
        .insert(runnerRepos)
        .values(
          [...byKey.values()].map((repo) => ({
            runnerId,
            repoKey: repo.repo_key,
            name: repo.name,
            path: repo.path,
            defaultBranch: repo.default_branch ?? null,
            remoteUrl: repo.remote_url ?? null,
            headCommit: repo.head_commit ?? null,
            available: repo.available,
            reportedAt,
          })),
        )
        .onConflictDoUpdate({
          target: [runnerRepos.runnerId, runnerRepos.repoKey],
          set: {
            name: sql`excluded.name`,
            path: sql`excluded.path`,
            defaultBranch: sql`excluded.default_branch`,
            remoteUrl: sql`excluded.remote_url`,
            headCommit: sql`excluded.head_commit`,
            available: sql`excluded.available`,
            reportedAt: sql`excluded.reported_at`,
          },
        });
    }
    await executor
      .update(runnerRepos)
      .set({ available: false })
      .where(
        and(
          eq(runnerRepos.runnerId, runnerId),
          byKey.size > 0 ? notInArray(runnerRepos.repoKey, [...byKey.keys()]) : undefined,
        ),
      );
  }

  /**
   * Cursors for `welcome` (architecture §8.3, §8.7): `resume` = highest persisted seq of every
   * run still open on this runner; `cancel` = reported runs the control plane has finalized or
   * does not know.
   */
  async welcomeCursors(
    runnerId: string,
    reported: ActiveRun[],
  ): Promise<{ resume: ResumeCursor[]; cancel: string[] }> {
    const reportedIds = reported.map((run) => run.run_id);
    const rows = await this.db
      .select({ id: runs.id, lastSeq: runs.lastSeq, endedAt: runs.endedAt })
      .from(runs)
      .where(
        and(
          eq(runs.runnerId, runnerId),
          or(
            inArray(runs.status, ACTIVE_RUN_STATUSES),
            reportedIds.length > 0 ? inArray(runs.id, reportedIds) : undefined,
          ),
        ),
      );
    const known = new Map(rows.map((row) => [row.id, row]));
    const resume = rows
      .filter((row) => row.endedAt === null)
      .map((row) => ({ run_id: row.id, ack_seq: row.lastSeq }));
    const cancel = reportedIds.filter((id) => {
      const row = known.get(id);
      return !row || row.endedAt !== null;
    });
    return { resume, cancel };
  }

  async touch(runnerId: string): Promise<void> {
    await this.db.update(runners).set({ lastSeenAt: new Date() }).where(eq(runners.id, runnerId));
  }

  /** online → offline (a revoked runner stays revoked). True when the status changed. */
  async markOffline(runnerId: string): Promise<boolean> {
    const changed = await this.db
      .update(runners)
      .set({ status: 'offline' })
      .where(and(eq(runners.id, runnerId), eq(runners.status, 'online')))
      .returning({ id: runners.id });
    return changed.length > 0;
  }

  /** Marks runners without traffic for 60 s offline and returns their ids. */
  async markStaleOffline(now: Date): Promise<string[]> {
    const cutoff = new Date(now.getTime() - STALE_AFTER_MS);
    const stale = await this.db
      .update(runners)
      .set({ status: 'offline' })
      .where(
        and(
          eq(runners.status, 'online'),
          or(isNull(runners.lastSeenAt), lt(runners.lastSeenAt, cutoff)),
        ),
      )
      .returning({ id: runners.id });
    return stale.map((row) => row.id);
  }

  async deleteOldPairingTokens(now: Date): Promise<void> {
    await this.db
      .delete(runnerPairingTokens)
      .where(
        lt(runnerPairingTokens.expiresAt, new Date(now.getTime() - PAIRING_TOKEN_RETENTION_MS)),
      );
  }

  /**
   * Issues a one-time pairing token. Only its SHA-256 is stored; the token itself is returned
   * once, together with the ready-to-paste pairing command.
   */
  async createPairingToken(
    workspaceId: string,
    userId: string,
    label: string | undefined,
  ): Promise<PairingTokenResponse> {
    const token = generateToken(PAIRING_TOKEN_PREFIX);
    const expiresAt = new Date(Date.now() + PAIRING_TOKEN_TTL_MS);
    await this.db.insert(runnerPairingTokens).values({
      workspaceId,
      tokenHash: hashToken(token),
      label: label?.trim() || null,
      createdBy: userId,
      expiresAt,
    });
    const serverUrl = this.config.runnerPublicUrl;
    return {
      token,
      expiresAt: expiresAt.toISOString(),
      command: `coffe-runner pair --server ${serverUrl} --token ${token}`,
      serverUrl,
    };
  }

  /** Renames a runner and/or changes how many runs it may execute at once. */
  async update(workspaceId: string, runnerId: string, patch: UpdateRunnerRequest): Promise<Runner> {
    const name = patch.name?.trim();
    if (name !== undefined && name.length === 0) {
      throw ApiException.badRequest('validation_failed', 'The runner name must not be blank');
    }
    const changes = {
      ...(name !== undefined ? { name } : {}),
      ...(patch.maxConcurrentRuns !== undefined
        ? { maxConcurrentRuns: patch.maxConcurrentRuns }
        : {}),
    };
    if (Object.keys(changes).length > 0) {
      await this.db
        .update(runners)
        .set(changes)
        .where(and(eq(runners.id, runnerId), eq(runners.workspaceId, workspaceId)));
    }
    return this.get(workspaceId, runnerId);
  }

  /**
   * Revokes the runner token for good (architecture §13.1). Idempotent; the caller closes the
   * live socket and publishes the new status.
   */
  async revoke(workspaceId: string, runnerId: string): Promise<Runner> {
    await this.db
      .update(runners)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(
        and(
          eq(runners.id, runnerId),
          eq(runners.workspaceId, workspaceId),
          ne(runners.status, 'revoked'),
        ),
      );
    return this.get(workspaceId, runnerId);
  }

  /** Pushes `runner.status` to the workspace channel. */
  async publishStatus(runnerId: string): Promise<void> {
    const [runner] = await this.db
      .select({ workspaceId: runners.workspaceId, status: runners.status })
      .from(runners)
      .where(eq(runners.id, runnerId))
      .limit(1);
    if (!runner) return;
    const running = await this.runningRuns([runnerId]);
    this.realtime.publish(`workspace:${runner.workspaceId}`, {
      ev: 'runner.status',
      runnerId,
      status: runner.status,
      runningRuns: running.get(runnerId) ?? 0,
    });
  }

  async list(workspaceId: string): Promise<Runner[]> {
    const rows = await this.db
      .select()
      .from(runners)
      .where(eq(runners.workspaceId, workspaceId))
      .orderBy(asc(runners.createdAt));
    return this.toRunners(rows);
  }

  async get(workspaceId: string, runnerId: string): Promise<Runner> {
    const [row] = await this.db
      .select()
      .from(runners)
      .where(and(eq(runners.id, runnerId), eq(runners.workspaceId, workspaceId)))
      .limit(1);
    const [runner] = row ? await this.toRunners([row]) : [];
    if (!runner) throw ApiException.notFound('Runner');
    return runner;
  }

  private async runningRuns(runnerIds: string[]): Promise<Map<string, number>> {
    if (runnerIds.length === 0) return new Map();
    const rows = await this.db
      .select({ runnerId: runs.runnerId, running: count() })
      .from(runs)
      .where(and(inArray(runs.runnerId, runnerIds), inArray(runs.status, ACTIVE_RUN_STATUSES)))
      .groupBy(runs.runnerId);
    const running = new Map<string, number>();
    for (const row of rows) {
      if (row.runnerId) running.set(row.runnerId, row.running);
    }
    return running;
  }

  private async toRunners(rows: RunnerRow[]): Promise<Runner[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const [clis, repos, running] = await Promise.all([
      this.db
        .select()
        .from(runnerClis)
        .where(inArray(runnerClis.runnerId, ids))
        .orderBy(asc(runnerClis.cliId)),
      this.db
        .select()
        .from(runnerRepos)
        .where(inArray(runnerRepos.runnerId, ids))
        .orderBy(asc(runnerRepos.name)),
      this.runningRuns(ids),
    ]);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      hostname: row.hostname,
      os: row.os,
      arch: row.arch,
      runnerVersion: row.runnerVersion,
      protocolVersion: row.protocolVersion,
      status: row.status,
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      fingerprint: row.fingerprint,
      maxConcurrentRuns: row.maxConcurrentRuns,
      runningRuns: running.get(row.id) ?? 0,
      capabilities: row.capabilities,
      policy: row.policy,
      clis: clis
        .filter((cli) => cli.runnerId === row.id)
        .map((cli) => ({
          cliId: cli.cliId,
          name: cli.name,
          path: cli.path,
          version: cli.version,
          authStatus: cli.authStatus,
          capabilities: cli.capabilities,
          detectedAt: cli.detectedAt.toISOString(),
        })),
      repos: repos.filter((repo) => repo.runnerId === row.id).map(toRunnerRepo),
      needsUpdate:
        !isVersionAtLeast(row.runnerVersion, this.config.runnerMinVersion) ||
        (row.protocolVersion !== null &&
          !isCompatible(row.protocolVersion, PROTOCOL_VERSION, this.config.protocolMinMinor)),
      createdAt: row.createdAt.toISOString(),
      revokedAt: row.revokedAt?.toISOString() ?? null,
    }));
  }
}
