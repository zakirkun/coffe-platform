/**
 * COFFE domain schema (docs/architecture.md §5). Better Auth tables live in ./auth.ts.
 *
 * Conventions: snake_case columns, uuid ids generated in the app (UUIDv7), `workspace_id` is the
 * Better Auth organization id (text), every timestamp is timestamptz.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';
import { organization, user } from './auth.js';

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const id = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const workspaceId = () =>
  text('workspace_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' });

// ---------------------------------------------------------------------------
// Enumerations (text columns with TS-level enums; no DB enum types)
// ---------------------------------------------------------------------------

export const RUNNER_STATUSES = ['online', 'offline', 'revoked'] as const;
export const TICKET_STATUSES = ['backlog', 'ready', 'in_progress', 'in_review', 'done'] as const;
export const RUN_STATUSES = [
  'queued',
  'dispatched',
  'starting',
  'running',
  'paused',
  'waiting_input',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
] as const;
export const RUN_KINDS = [
  'ticket',
  'planning',
  'wiki',
  'query_assist',
  'canvas',
  'conflict',
] as const;
export const RUN_MODES = ['structured', 'pty'] as const;
export const RUN_DRIVERS = ['native', 'acp'] as const;
export const PERSONA_ROLES = [
  'planner',
  'implementer',
  'tester',
  'reviewer',
  'designer',
  'custom',
] as const;
export const COST_SOURCES = ['reported', 'estimated', 'unavailable'] as const;
export const REVIEW_DECISIONS = ['approved', 'changes_requested'] as const;
export const MERGE_STRATEGIES = ['ff_only', 'merge', 'squash'] as const;
export const AUDIT_ACTOR_TYPES = ['user', 'runner', 'agent', 'system'] as const;

// ---------------------------------------------------------------------------
// Shared JSON shapes
// ---------------------------------------------------------------------------

export interface ProjectSettings {
  test_command?: string | null;
  merge_strategy?: (typeof MERGE_STRATEGIES)[number];
  push_on_approve?: boolean;
  remote?: string | null;
  auto_advance?: boolean;
  default_cli_id?: string | null;
  default_mode?: (typeof RUN_MODES)[number];
}

export interface PermissionPolicyJson {
  mode: 'read_only' | 'workspace_write' | 'full_auto';
  allow_tools: string[];
  deny_tools: string[];
  network: boolean;
  max_turns?: number | null;
  max_budget_usd?: number | null;
  timeout_secs?: number | null;
}

export interface TicketFlags {
  failed?: boolean;
  blocked?: boolean;
  merge_conflict?: boolean;
}

export interface WorkflowStep {
  key: string;
  name: string;
  persona_ids: string[];
  parallel: boolean;
  on_fail: 'stop' | `goto:${string}`;
  max_loops: number;
}

export interface WorkflowStepStateJson {
  key: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  run_ids: string[];
  loops: number;
  outcome: string | null;
}

export interface ModelPriceJson {
  model: string;
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok: number;
  cache_write_per_mtok: number;
}

export interface DiffFileJson {
  path: string;
  old_path?: string | null;
  status: string;
  additions?: number | null;
  deletions?: number | null;
  binary: boolean;
}

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

export const runnerPairingTokens = pgTable(
  'runner_pairing_tokens',
  {
    id: id(),
    workspaceId: workspaceId(),
    tokenHash: text('token_hash').notNull(),
    label: text('label'),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    runnerId: uuid('runner_id'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('runner_pairing_tokens_hash_uq').on(t.tokenHash)],
);

export const runners = pgTable(
  'runners',
  {
    id: id(),
    workspaceId: workspaceId(),
    name: text('name').notNull(),
    hostname: text('hostname').notNull(),
    os: text('os').notNull(),
    arch: text('arch').notNull(),
    runnerVersion: text('runner_version').notNull(),
    protocolVersion: text('protocol_version'),
    tokenHash: text('token_hash').notNull(),
    tokenPrefix: text('token_prefix').notNull(),
    boxPublicKey: text('box_public_key').notNull(),
    signPublicKey: text('sign_public_key').notNull(),
    boxKeySignature: text('box_key_signature').notNull(),
    fingerprint: text('fingerprint').notNull(),
    status: text('status', { enum: RUNNER_STATUSES }).notNull().default('offline'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    maxConcurrentRuns: integer('max_concurrent_runs').notNull().default(4),
    capabilities: jsonb('capabilities').$type<string[]>().notNull().default([]),
    policy: jsonb('policy').$type<Record<string, unknown>>().notNull().default({}),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('runners_token_hash_uq').on(t.tokenHash),
    index('runners_workspace_idx').on(t.workspaceId),
  ],
);

export const runnerClis = pgTable(
  'runner_clis',
  {
    runnerId: uuid('runner_id')
      .notNull()
      .references(() => runners.id, { onDelete: 'cascade' }),
    cliId: text('cli_id').notNull(),
    name: text('name').notNull(),
    path: text('path').notNull(),
    version: text('version'),
    authStatus: text('auth_status').notNull(),
    capabilities: jsonb('capabilities').$type<Record<string, unknown>>().notNull().default({}),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.runnerId, t.cliId] })],
);

export const runnerRepos = pgTable(
  'runner_repos',
  {
    id: id(),
    runnerId: uuid('runner_id')
      .notNull()
      .references(() => runners.id, { onDelete: 'cascade' }),
    repoKey: text('repo_key').notNull(),
    name: text('name').notNull(),
    path: text('path').notNull(),
    defaultBranch: text('default_branch'),
    remoteUrl: text('remote_url'),
    headCommit: text('head_commit'),
    available: boolean('available').notNull().default(true),
    reportedAt: timestamp('reported_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('runner_repos_runner_key_uq').on(t.runnerId, t.repoKey)],
);

// ---------------------------------------------------------------------------
// Projects, personas, workflows, context
// ---------------------------------------------------------------------------

export const projects = pgTable(
  'projects',
  {
    id: id(),
    workspaceId: workspaceId(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    key: text('key').notNull(),
    description: text('description').notNull().default(''),
    ticketSeq: integer('ticket_seq').notNull().default(0),
    defaultWorkflowId: uuid('default_workflow_id'),
    settings: jsonb('settings').$type<ProjectSettings>().notNull().default({}),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('projects_workspace_slug_uq').on(t.workspaceId, t.slug),
    uniqueIndex('projects_workspace_key_uq').on(t.workspaceId, t.key),
  ],
);

export const projectRepos = pgTable(
  'project_repos',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    runnerId: uuid('runner_id')
      .notNull()
      .references(() => runners.id, { onDelete: 'cascade' }),
    runnerRepoId: uuid('runner_repo_id')
      .notNull()
      .references(() => runnerRepos.id, { onDelete: 'cascade' }),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('project_repos_project_repo_uq').on(t.projectId, t.runnerRepoId)],
);

export const personas = pgTable(
  'personas',
  {
    id: id(),
    workspaceId: workspaceId(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    role: text('role', { enum: PERSONA_ROLES }).notNull(),
    instructions: text('instructions').notNull().default(''),
    cliId: text('cli_id').notNull(),
    model: text('model'),
    mode: text('mode', { enum: RUN_MODES }).notNull().default('structured'),
    driver: text('driver', { enum: RUN_DRIVERS }).notNull().default('native'),
    permissions: jsonb('permissions').$type<PermissionPolicyJson>().notNull(),
    color: text('color'),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [index('personas_workspace_idx').on(t.workspaceId)],
);

export const workflows = pgTable('workflows', {
  id: id(),
  workspaceId: workspaceId(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  steps: jsonb('steps').$type<WorkflowStep[]>().notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** A workflow running on one ticket (architecture §11.3); steps are snapshotted at start. */
export const workflowInstances = pgTable(
  'workflow_instances',
  {
    id: id(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    workflowId: uuid('workflow_id').references(() => workflows.id, { onDelete: 'set null' }),
    workflowName: text('workflow_name').notNull(),
    steps: jsonb('steps').$type<WorkflowStep[]>().notNull(),
    stepStates: jsonb('step_states').$type<WorkflowStepStateJson[]>().notNull().default([]),
    status: text('status', { enum: ['running', 'completed', 'failed', 'cancelled'] })
      .notNull()
      .default('running'),
    currentStepKey: text('current_step_key'),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [index('workflow_instances_ticket_idx').on(t.ticketId)],
);

/** Per-workspace settings: model price table for cost estimates, feature toggles. */
export const workspaceSettings = pgTable('workspace_settings', {
  workspaceId: text('workspace_id')
    .primaryKey()
    .references(() => organization.id, { onDelete: 'cascade' }),
  pricing: jsonb('pricing').$type<ModelPriceJson[]>().notNull().default([]),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: updatedAt(),
});

export const contextDocs = pgTable(
  'context_docs',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['rule', 'knowledge'] }).notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    enabled: boolean('enabled').notNull().default(true),
    position: integer('position').notNull().default(0),
    updatedBy: text('updated_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('context_docs_project_idx').on(t.projectId)],
);

// ---------------------------------------------------------------------------
// Planning and tickets
// ---------------------------------------------------------------------------

export const requirements = pgTable('requirements', {
  id: id(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  status: text('status', { enum: ['draft', 'planning', 'review', 'approved', 'failed'] })
    .notNull()
    .default('draft'),
  plannerPersonaId: uuid('planner_persona_id').references(() => personas.id, {
    onDelete: 'set null',
  }),
  planningRunId: uuid('planning_run_id'),
  error: text('error'),
  createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const ticketDrafts = pgTable('ticket_drafts', {
  id: id(),
  requirementId: uuid('requirement_id')
    .notNull()
    .references(() => requirements.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  acceptanceCriteria: jsonb('acceptance_criteria').$type<string[]>().notNull().default([]),
  suggestedRole: text('suggested_role'),
  estimate: text('estimate'),
  dependsOn: jsonb('depends_on').$type<number[]>().notNull().default([]),
  status: text('status', { enum: ['pending', 'approved', 'discarded'] })
    .notNull()
    .default('pending'),
  ticketId: uuid('ticket_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const tickets = pgTable(
  'tickets',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    key: text('key').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    acceptanceCriteria: jsonb('acceptance_criteria').$type<string[]>().notNull().default([]),
    status: text('status', { enum: TICKET_STATUSES }).notNull().default('backlog'),
    position: text('position').notNull(),
    priority: integer('priority').notNull().default(2),
    labels: jsonb('labels').$type<string[]>().notNull().default([]),
    assigneePersonaId: uuid('assignee_persona_id').references(() => personas.id, {
      onDelete: 'set null',
    }),
    workflowId: uuid('workflow_id').references(() => workflows.id, { onDelete: 'set null' }),
    requirementId: uuid('requirement_id').references(() => requirements.id, {
      onDelete: 'set null',
    }),
    branch: text('branch'),
    baseBranch: text('base_branch'),
    worktreeRunnerId: uuid('worktree_runner_id').references(() => runners.id, {
      onDelete: 'set null',
    }),
    repoId: uuid('repo_id').references(() => runnerRepos.id, { onDelete: 'set null' }),
    flags: jsonb('flags').$type<TicketFlags>().notNull().default({}),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('tickets_project_number_uq').on(t.projectId, t.number),
    index('tickets_project_status_idx').on(t.projectId, t.status),
  ],
);

export const ticketDependencies = pgTable(
  'ticket_dependencies',
  {
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    dependsOnId: uuid('depends_on_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.ticketId, t.dependsOnId] })],
);

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export const runs = pgTable(
  'runs',
  {
    id: id(),
    workspaceId: workspaceId(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: RUN_KINDS }).notNull(),
    personaId: uuid('persona_id').references(() => personas.id, { onDelete: 'set null' }),
    workflowStepKey: text('workflow_step_key'),
    workflowInstanceId: uuid('workflow_instance_id').references(() => workflowInstances.id, {
      onDelete: 'set null',
    }),
    attempt: integer('attempt').notNull().default(1),
    parentRunId: uuid('parent_run_id'),
    runnerId: uuid('runner_id').references(() => runners.id, { onDelete: 'set null' }),
    repoId: uuid('repo_id').references(() => runnerRepos.id, { onDelete: 'set null' }),
    cliId: text('cli_id').notNull(),
    model: text('model'),
    mode: text('mode', { enum: RUN_MODES }).notNull(),
    driver: text('driver', { enum: RUN_DRIVERS }).notNull().default('native'),
    /** Permission policy the run was started with (persona limits); null = ticket default. */
    permissions: jsonb('permissions').$type<PermissionPolicyJson>(),
    /** What the previous workflow step handed over (written to `50-handoff.md`). */
    handoff: text('handoff'),
    /** Requirement a planning run plans. */
    requirementId: uuid('requirement_id').references(() => requirements.id, { onDelete: 'set null' }),
    status: text('status', { enum: RUN_STATUSES }).notNull().default('queued'),
    statusDetail: text('status_detail'),
    exitCode: integer('exit_code'),
    prompt: text('prompt').notNull(),
    cliSessionId: text('cli_session_id'),
    worktreePath: text('worktree_path'),
    branch: text('branch'),
    baseBranch: text('base_branch'),
    baseCommit: text('base_commit'),
    headCommit: text('head_commit'),
    resultSummary: text('result_summary'),
    error: text('error'),
    lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
    requestedBy: text('requested_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [
    index('runs_ticket_idx').on(t.ticketId),
    index('runs_runner_status_idx').on(t.runnerId, t.status),
    index('runs_project_created_idx').on(t.projectId, t.createdAt),
  ],
);

export const runEvents = pgTable(
  'run_events',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    type: text('type').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] })],
);

export const runOutput = pgTable(
  'run_output',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    data: bytea('data').notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] })],
);

export const runUsage = pgTable('run_usage', {
  runId: uuid('run_id')
    .primaryKey()
    .references(() => runs.id, { onDelete: 'cascade' }),
  available: boolean('available').notNull().default(false),
  inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
  outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
  cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull().default(0),
  cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).notNull().default(0),
  reasoningTokens: bigint('reasoning_tokens', { mode: 'number' }).notNull().default(0),
  totalTokens: bigint('total_tokens', { mode: 'number' }).notNull().default(0),
  costUsd: numeric('cost_usd', { precision: 14, scale: 6, mode: 'number' }),
  costSource: text('cost_source', { enum: COST_SOURCES }).notNull().default('unavailable'),
  credits: doublePrecision('credits'),
  durationMs: bigint('duration_ms', { mode: 'number' }),
  numTurns: integer('num_turns'),
  model: text('model'),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export const diffs = pgTable(
  'diffs',
  {
    id: id(),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    baseCommit: text('base_commit').notNull(),
    headCommit: text('head_commit').notNull(),
    additions: integer('additions').notNull().default(0),
    deletions: integer('deletions').notNull().default(0),
    files: jsonb('files').$type<DiffFileJson[]>().notNull().default([]),
    patch: text('patch').notNull().default(''),
    truncated: boolean('truncated').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('diffs_ticket_idx').on(t.ticketId, t.createdAt)],
);

export const testResults = pgTable('test_results', {
  id: id(),
  runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
  ticketId: uuid('ticket_id')
    .notNull()
    .references(() => tickets.id, { onDelete: 'cascade' }),
  source: text('source', { enum: ['command', 'agent'] }).notNull(),
  command: text('command'),
  status: text('status', { enum: ['passed', 'failed', 'error'] }).notNull(),
  passed: integer('passed').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  skipped: integer('skipped').notNull().default(0),
  durationMs: bigint('duration_ms', { mode: 'number' }),
  report: jsonb('report').$type<Record<string, unknown>>().notNull().default({}),
  outputTail: text('output_tail'),
  createdAt: createdAt(),
});

export const reviews = pgTable('reviews', {
  id: id(),
  ticketId: uuid('ticket_id')
    .notNull()
    .references(() => tickets.id, { onDelete: 'cascade' }),
  diffId: uuid('diff_id').references(() => diffs.id, { onDelete: 'set null' }),
  runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
  round: integer('round').notNull().default(1),
  reviewerId: text('reviewer_id').references(() => user.id, { onDelete: 'set null' }),
  decision: text('decision', { enum: REVIEW_DECISIONS }).notNull(),
  body: text('body').notNull().default(''),
  createdAt: createdAt(),
});

export const merges = pgTable('merges', {
  id: id(),
  ticketId: uuid('ticket_id')
    .notNull()
    .references(() => tickets.id, { onDelete: 'cascade' }),
  reviewId: uuid('review_id').references(() => reviews.id, { onDelete: 'set null' }),
  strategy: text('strategy', { enum: MERGE_STRATEGIES }).notNull(),
  targetBranch: text('target_branch').notNull(),
  mergeCommit: text('merge_commit'),
  pushed: boolean('pushed').notNull().default(false),
  status: text('status', { enum: ['pending', 'merged', 'conflict', 'failed', 'nothing_to_merge'] })
    .notNull()
    .default('pending'),
  conflicts: jsonb('conflicts').$type<string[]>().notNull().default([]),
  error: text('error'),
  createdAt: createdAt(),
});

export const comments = pgTable(
  'comments',
  {
    id: id(),
    workspaceId: workspaceId(),
    targetType: text('target_type', { enum: ['ticket', 'diff'] }).notNull(),
    targetId: uuid('target_id').notNull(),
    filePath: text('file_path'),
    line: integer('line'),
    side: text('side', { enum: ['old', 'new'] }),
    body: text('body').notNull(),
    authorId: text('author_id').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [index('comments_target_idx').on(t.targetType, t.targetId)],
);

export const attachments = pgTable('attachments', {
  id: id(),
  workspaceId: workspaceId(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),
  kind: text('kind', {
    enum: ['screenshot', 'canvas_export', 'image', 'console_log', 'file'],
  }).notNull(),
  name: text('name').notNull(),
  mime: text('mime').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  data: bytea('data').notNull(),
  createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Audit (append-only)
// ---------------------------------------------------------------------------

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    workspaceId: text('workspace_id'),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    actorType: text('actor_type', { enum: AUDIT_ACTOR_TYPES }).notNull(),
    actorUserId: text('actor_user_id'),
    runnerId: uuid('runner_id'),
    personaId: uuid('persona_id'),
    runId: uuid('run_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    command: text('command'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [
    index('audit_logs_workspace_ts_idx').on(t.workspaceId, t.ts),
    index('audit_logs_run_idx').on(t.runId).where(sql`${t.runId} is not null`),
  ],
);
