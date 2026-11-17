import { z } from 'zod';
import { IsoDate, Uuid } from './common.js';

export const RUNNER_STATUSES = ['online', 'offline', 'revoked'] as const;
export const RunnerStatus = z.enum(RUNNER_STATUSES);
export type RunnerStatus = z.infer<typeof RunnerStatus>;

/** `POST /workspaces/:ws/runner-pairing-tokens` */
export const CreatePairingTokenRequest = z.object({
  label: z.string().max(100).optional(),
});
export type CreatePairingTokenRequest = z.infer<typeof CreatePairingTokenRequest>;

export const PairingTokenResponse = z.object({
  /** One-time token `coffe_pt_…`; shown once. */
  token: z.string(),
  expiresAt: IsoDate,
  /** Ready-to-paste command, e.g. `coffe-runner pair --server https://… --token coffe_pt_…`. */
  command: z.string(),
  serverUrl: z.string(),
});
export type PairingTokenResponse = z.infer<typeof PairingTokenResponse>;

export const RunnerCli = z.object({
  cliId: z.string(),
  name: z.string(),
  path: z.string(),
  version: z.string().nullable(),
  authStatus: z.string(),
  capabilities: z.record(z.string(), z.unknown()),
  detectedAt: IsoDate,
});
export type RunnerCli = z.infer<typeof RunnerCli>;

export const RunnerRepo = z.object({
  id: Uuid,
  runnerId: Uuid,
  repoKey: z.string(),
  name: z.string(),
  path: z.string(),
  defaultBranch: z.string().nullable(),
  remoteUrl: z.string().nullable(),
  headCommit: z.string().nullable(),
  available: z.boolean(),
});
export type RunnerRepo = z.infer<typeof RunnerRepo>;

export const Runner = z.object({
  id: Uuid,
  name: z.string(),
  hostname: z.string(),
  os: z.string(),
  arch: z.string(),
  runnerVersion: z.string(),
  protocolVersion: z.string().nullable(),
  status: RunnerStatus,
  lastSeenAt: IsoDate.nullable(),
  fingerprint: z.string(),
  maxConcurrentRuns: z.number().int(),
  runningRuns: z.number().int(),
  capabilities: z.array(z.string()),
  policy: z.record(z.string(), z.unknown()),
  clis: z.array(RunnerCli),
  repos: z.array(RunnerRepo),
  /** True when the runner's protocol/version is below the server minimum. */
  needsUpdate: z.boolean(),
  createdAt: IsoDate,
  revokedAt: IsoDate.nullable(),
});
export type Runner = z.infer<typeof Runner>;

/** `PATCH /workspaces/:ws/runners/:runnerId` */
export const UpdateRunnerRequest = z.object({
  name: z.string().min(1).max(100).optional(),
  maxConcurrentRuns: z.number().int().min(1).max(64).optional(),
});
export type UpdateRunnerRequest = z.infer<typeof UpdateRunnerRequest>;
