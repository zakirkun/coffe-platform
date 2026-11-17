/**
 * Phase 4/5 tables (architecture §5.7, §12.11): canvases + Yjs documents, wiki pages with
 * citations, code graphs, memories, skills, published canvases, member preferences.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';
import { organization, user } from './auth.js';
import { attachments, bytea, projects, runnerRepos, runs, tickets } from './core.js';

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

export interface CitationJson {
  id: string;
  path: string;
  start_line: number;
  end_line: number;
  commit: string;
}

export const canvases = pgTable(
  'canvases',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    /** Yjs document name (`canvas:<id>`). */
    docName: text('doc_name').notNull(),
    thumbnailAttachmentId: uuid('thumbnail_attachment_id').references(() => attachments.id, {
      onDelete: 'set null',
    }),
    /** User currently allowed to let agents write (edit lease), with expiry. */
    leaseUserId: text('lease_user_id').references(() => user.id, { onDelete: 'set null' }),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('canvases_doc_name_uq').on(t.docName), index('canvases_project_idx').on(t.projectId)],
);

export const ticketCanvases = pgTable(
  'ticket_canvases',
  {
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    canvasId: uuid('canvas_id')
      .notNull()
      .references(() => canvases.id, { onDelete: 'cascade' }),
    /** PNG export attached as run context. */
    exportAttachmentId: uuid('export_attachment_id').references(() => attachments.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.ticketId, t.canvasId] })],
);

/** Persisted Yjs document state (Hocuspocus database extension). */
export const yjsDocuments = pgTable('yjs_documents', {
  name: text('name').primaryKey(),
  state: bytea('state').notNull(),
  updatedAt: updatedAt(),
});

export const codeGraphs = pgTable(
  'code_graphs',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    runnerRepoId: uuid('runner_repo_id')
      .notNull()
      .references(() => runnerRepos.id, { onDelete: 'cascade' }),
    commit: text('commit').notNull(),
    nodes: jsonb('nodes').$type<Record<string, unknown>[]>().notNull(),
    edges: jsonb('edges').$type<Record<string, unknown>[]>().notNull(),
    stats: jsonb('stats').$type<Record<string, unknown>>().notNull(),
    truncated: boolean('truncated').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('code_graphs_project_created_idx').on(t.projectId, t.createdAt)],
);

export const wikiPages = pgTable(
  'wiki_pages',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    position: integer('position').notNull().default(0),
    /** Markdown with `[[cite:<citation id>]]` markers. */
    bodyMd: text('body_md').notNull().default(''),
    citations: jsonb('citations').$type<CitationJson[]>().notNull().default([]),
    /** Files this page cites; used to mark it stale when they change. */
    citedPaths: jsonb('cited_paths').$type<string[]>().notNull().default([]),
    sourceCommit: text('source_commit'),
    status: text('status', { enum: ['fresh', 'stale', 'generating', 'failed'] })
      .notNull()
      .default('generating'),
    error: text('error'),
    generatedByRunId: uuid('generated_by_run_id').references(() => runs.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('wiki_pages_project_slug_uq').on(t.projectId, t.slug)],
);

/** Project memory: durable decisions, preferences and gotchas (Phase 5). */
export const memories = pgTable(
  'memories',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['decision', 'preference', 'gotcha', 'fact'] }).notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    source: text('source', { enum: ['human', 'agent'] }).notNull(),
    status: text('status', { enum: ['proposed', 'active', 'archived'] })
      .notNull()
      .default('active'),
    sourceRunId: uuid('source_run_id').references(() => runs.id, { onDelete: 'set null' }),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    reviewedBy: text('reviewed_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('memories_project_status_idx').on(t.projectId, t.status),
    index('memories_fts_idx').using(
      'gin',
      sql`to_tsvector('simple', ${t.title} || ' ' || ${t.body})`,
    ),
  ],
);

/** SKILL.md packages imported from Git URLs or uploaded (Phase 5). */
export const skills = pgTable(
  'skills',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    sourceUrl: text('source_url'),
    sourceRef: text('source_ref'),
    /** Files of the skill package (path → UTF-8 content); size-capped. */
    files: jsonb('files').$type<Record<string, string>>().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('skills_workspace_idx').on(t.workspaceId)],
);

/** Public, read-only canvas publications (Phase 5). */
export const publishedCanvases = pgTable(
  'published_canvases',
  {
    id: id(),
    canvasId: uuid('canvas_id')
      .notNull()
      .references(() => canvases.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    kind: text('kind', { enum: ['image', 'html'] }).notNull(),
    mime: text('mime').notNull(),
    content: bytea('content').notNull(),
    publishedBy: text('published_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('published_canvases_slug_uq').on(t.slug)],
);

/** Per-member preferences inside a workspace (leaderboard opt-out, …). */
export const memberPreferences = pgTable(
  'member_preferences',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    leaderboardOptOut: boolean('leaderboard_opt_out').notNull().default(false),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);
