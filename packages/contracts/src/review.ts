import { z } from 'zod';
import { IsoDate, Uuid } from './common.js';
import { Run } from './runs.js';

export const DiffFile = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  status: z.string(),
  additions: z.number().int().nullable(),
  deletions: z.number().int().nullable(),
  binary: z.boolean(),
});
export type DiffFile = z.infer<typeof DiffFile>;

/** `GET /workspaces/:ws/tickets/:ticketId/diff` — latest stored diff (404 when none). */
export const Diff = z.object({
  id: Uuid,
  ticketId: Uuid,
  runId: Uuid.nullable(),
  baseCommit: z.string(),
  headCommit: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  files: z.array(DiffFile),
  /** Unified patch, ≤ 2 MiB. */
  patch: z.string(),
  truncated: z.boolean(),
  createdAt: IsoDate,
});
export type Diff = z.infer<typeof Diff>;

/**
 * `GET /workspaces/:ws/tickets/:ticketId/file?rev=<sha>&path=<repo-relative>` — relayed from the
 * runner, never stored. 503 when the runner is offline.
 */
export const FileQuery = z.object({
  rev: z.string().min(4).max(100),
  path: z.string().min(1).max(4096),
});
export const FileContentResponse = z.object({
  path: z.string(),
  rev: z.string(),
  /** UTF-8 text; null when binary, missing or too large. */
  content: z.string().nullable(),
  size: z.number().int(),
  binary: z.boolean(),
  tooLarge: z.boolean(),
  missing: z.boolean(),
});
export type FileContentResponse = z.infer<typeof FileContentResponse>;

export const TestResult = z.object({
  id: Uuid,
  runId: Uuid.nullable(),
  source: z.enum(['command', 'agent']),
  command: z.string().nullable(),
  status: z.enum(['passed', 'failed', 'error']),
  passed: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
  durationMs: z.number().nullable(),
  failures: z.array(z.object({ name: z.string(), message: z.string().nullable() })),
  outputTail: z.string().nullable(),
  createdAt: IsoDate,
});
export type TestResult = z.infer<typeof TestResult>;

export const REVIEW_DECISIONS = ['approved', 'changes_requested'] as const;
export const Review = z.object({
  id: Uuid,
  ticketId: Uuid,
  diffId: Uuid.nullable(),
  runId: Uuid.nullable(),
  round: z.number().int(),
  reviewerId: z.string().nullable(),
  reviewerName: z.string().nullable(),
  decision: z.enum(REVIEW_DECISIONS),
  body: z.string(),
  createdAt: IsoDate,
});
export type Review = z.infer<typeof Review>;

export const Merge = z.object({
  id: Uuid,
  ticketId: Uuid,
  reviewId: Uuid.nullable(),
  strategy: z.enum(['ff_only', 'merge', 'squash']),
  targetBranch: z.string(),
  mergeCommit: z.string().nullable(),
  pushed: z.boolean(),
  status: z.enum(['pending', 'merged', 'conflict', 'failed', 'nothing_to_merge']),
  conflicts: z.array(z.string()),
  error: z.string().nullable(),
  createdAt: IsoDate,
});
export type Merge = z.infer<typeof Merge>;

/** `GET /workspaces/:ws/tickets/:ticketId/review` — everything the review gate shows. */
export const ReviewState = z.object({
  diff: Diff.nullable(),
  tests: z.array(TestResult),
  reviews: z.array(Review),
  merges: z.array(Merge),
  latestRun: Run.nullable(),
  /** Approve is allowed: ticket in_review, latest run terminal, runner online. */
  canApprove: z.boolean(),
  blockers: z.array(z.string()),
});
export type ReviewState = z.infer<typeof ReviewState>;

/** `POST /workspaces/:ws/tickets/:ticketId/approve` */
export const ApproveRequest = z.object({ body: z.string().max(20_000).default('') });
export type ApproveRequest = z.infer<typeof ApproveRequest>;
export const ApproveResponse = z.object({ review: Review, merge: Merge });
export type ApproveResponse = z.infer<typeof ApproveResponse>;

/** `POST /workspaces/:ws/tickets/:ticketId/request-changes` — feedback goes back to the agent. */
export const RequestChangesRequest = z.object({ body: z.string().min(1).max(20_000) });
export type RequestChangesRequest = z.infer<typeof RequestChangesRequest>;
export const RequestChangesResponse = z.object({ review: Review, run: Run });
export type RequestChangesResponse = z.infer<typeof RequestChangesResponse>;
