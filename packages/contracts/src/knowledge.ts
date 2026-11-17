import { z } from 'zod';
import { IsoDate, Uuid, WorkspaceRole } from './common.js';

// ---------------------------------------------------------------------------
// Canvas (architecture §12.7) — content syncs over Yjs (`/api/yjs`, doc `canvas:<id>`)
// ---------------------------------------------------------------------------

export const Canvas = z.object({
  id: Uuid,
  projectId: Uuid,
  title: z.string(),
  docName: z.string(),
  thumbnailUrl: z.string().nullable(),
  /** User holding the agent-edit lease (agents may write only through this user's runs). */
  leaseUserId: z.string().nullable(),
  leaseExpiresAt: IsoDate.nullable(),
  ticketIds: z.array(Uuid),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type Canvas = z.infer<typeof Canvas>;

/** `POST /workspaces/:ws/projects/:projectId/canvases` */
export const CreateCanvasRequest = z.object({ title: z.string().min(1).max(120) });
/** `PATCH /workspaces/:ws/canvases/:canvasId` */
export const UpdateCanvasRequest = z.object({ title: z.string().min(1).max(120) });

/** `POST /workspaces/:ws/canvases/:canvasId/attach` — PNG export attached to a ticket as run context. */
export const AttachCanvasRequest = z.object({
  ticketId: Uuid,
  pngBase64: z.string().min(1).max(14_000_000),
});

/**
 * `POST /workspaces/:ws/canvases/:canvasId/agent` — ask an agent to iterate on the design.
 * The run returns Excalidraw element skeletons (JSON) that the client inserts in a new frame.
 */
export const CanvasAgentRequest = z.object({
  instruction: z.string().min(1).max(20_000),
  pngBase64: z.string().max(14_000_000).optional(),
  sceneJson: z.string().max(5_000_000).optional(),
  personaId: Uuid.optional(),
});
export type CanvasAgentRequest = z.infer<typeof CanvasAgentRequest>;

/** Shape the canvas run must output (validated server-side; inserted client-side). */
export const CanvasAgentOutput = z.strictObject({
  summary: z.string(),
  elements: z
    .array(
      z.object({
        type: z.enum(['rectangle', 'ellipse', 'diamond', 'arrow', 'line', 'text', 'frame']),
        x: z.number(),
        y: z.number(),
        width: z.number().nullable(),
        height: z.number().nullable(),
        text: z.string().nullable(),
        strokeColor: z.string().nullable(),
        backgroundColor: z.string().nullable(),
      }),
    )
    .max(500),
});
export type CanvasAgentOutput = z.infer<typeof CanvasAgentOutput>;
export const CANVAS_AGENT_OUTPUT_JSON_SCHEMA = z.toJSONSchema(CanvasAgentOutput);

/** `POST /workspaces/:ws/canvases/:canvasId/lease` (acquire/renew) and `DELETE` (release). */
export const CanvasLease = z.object({ leaseUserId: z.string().nullable(), leaseExpiresAt: IsoDate.nullable() });

// ---------------------------------------------------------------------------
// Wiki Engine (architecture §12.8)
// ---------------------------------------------------------------------------

export const Citation = z.object({
  id: z.string(),
  path: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  commit: z.string(),
});
export type Citation = z.infer<typeof Citation>;

export const WikiPageSummary = z.object({
  id: Uuid,
  slug: z.string(),
  title: z.string(),
  position: z.number().int(),
  status: z.enum(['fresh', 'stale', 'generating', 'failed']),
  sourceCommit: z.string().nullable(),
  updatedAt: IsoDate,
});
export type WikiPageSummary = z.infer<typeof WikiPageSummary>;

export const WikiPage = WikiPageSummary.extend({
  bodyMd: z.string(),
  citations: z.array(Citation),
  error: z.string().nullable(),
  generatedByRunId: Uuid.nullable(),
});
export type WikiPage = z.infer<typeof WikiPage>;

export const WikiStatus = z.object({
  pages: z.array(WikiPageSummary),
  graphCommit: z.string().nullable(),
  headCommit: z.string().nullable(),
  /** Files changed since the pages were generated ("Codebase has moved on"). */
  changedFiles: z.array(z.string()),
  stalePages: z.number().int(),
  generating: z.boolean(),
});
export type WikiStatus = z.infer<typeof WikiStatus>;

/** `POST /workspaces/:ws/projects/:projectId/wiki/generate` — full or stale-only refresh. */
export const GenerateWikiRequest = z.object({
  mode: z.enum(['full', 'stale']).default('stale'),
  personaId: Uuid.optional(),
});

/** Output each wiki run must produce. */
export const WikiRunOutput = z.strictObject({
  pages: z
    .array(
      z.strictObject({
        slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
        title: z.string().min(1).max(200),
        body_md: z.string().max(200_000),
        citations: z.array(
          z.strictObject({
            id: z.string().min(1).max(40),
            path: z.string().min(1),
            start_line: z.number().int().min(1),
            end_line: z.number().int().min(1),
          }),
        ),
      }),
    )
    .min(1)
    .max(60),
});
export type WikiRunOutput = z.infer<typeof WikiRunOutput>;
export const WIKI_RUN_OUTPUT_JSON_SCHEMA = z.toJSONSchema(WikiRunOutput);

/** `GET /workspaces/:ws/projects/:projectId/wiki/snippet?path=&start=&end=&commit=` (relayed). */
export const SnippetQuery = z.object({
  path: z.string().min(1).max(4_096),
  start: z.coerce.number().int().min(1),
  end: z.coerce.number().int().min(1),
  commit: z.string().min(4).max(100),
});
export const Snippet = z.object({
  path: z.string(),
  commit: z.string(),
  startLine: z.number().int(),
  lines: z.array(z.string()),
  missing: z.boolean(),
});
export type Snippet = z.infer<typeof Snippet>;

export const GraphNode = z.object({
  id: z.string(),
  kind: z.enum(['file', 'module', 'symbol']),
  label: z.string(),
  path: z.string(),
  language: z.string().nullable(),
  symbolKind: z.string().nullable(),
  startLine: z.number().int().nullable(),
  endLine: z.number().int().nullable(),
  community: z.number().int().nullable(),
});
export type GraphNode = z.infer<typeof GraphNode>;

export const GraphEdge = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.enum(['imports', 'defines', 'references', 'contains']),
  verified: z.boolean(),
});
export type GraphEdge = z.infer<typeof GraphEdge>;

/** `GET /workspaces/:ws/projects/:projectId/graph` — latest code graph (404 before first index). */
export const CodeGraph = z.object({
  commit: z.string(),
  nodes: z.array(GraphNode),
  edges: z.array(GraphEdge),
  stats: z.object({
    files: z.number().int(),
    symbols: z.number().int(),
    edges: z.number().int(),
    skippedFiles: z.number().int(),
    languages: z.array(z.string()),
    elapsedMs: z.number(),
  }),
  truncated: z.boolean(),
  createdAt: IsoDate,
});
export type CodeGraph = z.infer<typeof CodeGraph>;

// ---------------------------------------------------------------------------
// Collaboration (architecture §12.9)
// ---------------------------------------------------------------------------

export const Comment = z.object({
  id: Uuid,
  targetType: z.enum(['ticket', 'diff']),
  targetId: Uuid,
  filePath: z.string().nullable(),
  line: z.number().int().nullable(),
  side: z.enum(['old', 'new']).nullable(),
  body: z.string(),
  authorId: z.string().nullable(),
  authorName: z.string().nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
  resolvedAt: IsoDate.nullable(),
});
export type Comment = z.infer<typeof Comment>;

/** `GET|POST /workspaces/:ws/comments?targetType=&targetId=` */
export const CommentQuery = z.object({ targetType: z.enum(['ticket', 'diff']), targetId: Uuid });
export const CreateCommentRequest = z.object({
  targetType: z.enum(['ticket', 'diff']),
  targetId: Uuid,
  filePath: z.string().max(4_096).optional(),
  line: z.number().int().min(1).optional(),
  side: z.enum(['old', 'new']).optional(),
  body: z.string().min(1).max(20_000),
});
export type CreateCommentRequest = z.infer<typeof CreateCommentRequest>;
/** `PATCH /workspaces/:ws/comments/:commentId` */
export const UpdateCommentRequest = z.object({
  body: z.string().min(1).max(20_000).optional(),
  resolved: z.boolean().optional(),
});

export const Invitation = z.object({
  id: z.string(),
  email: z.string(),
  role: WorkspaceRole,
  status: z.enum(['pending', 'accepted', 'rejected', 'canceled']),
  expiresAt: IsoDate,
  inviterEmail: z.string().nullable(),
  /** Copyable accept link (`/invite/<id>`). */
  url: z.string(),
});
export type Invitation = z.infer<typeof Invitation>;

// ---------------------------------------------------------------------------
// Phase 5: memory, skills, leaderboard, publishing
// ---------------------------------------------------------------------------

export const MEMORY_KINDS = ['decision', 'preference', 'gotcha', 'fact'] as const;
export const Memory = z.object({
  id: Uuid,
  projectId: Uuid,
  kind: z.enum(MEMORY_KINDS),
  title: z.string(),
  body: z.string(),
  source: z.enum(['human', 'agent']),
  status: z.enum(['proposed', 'active', 'archived']),
  sourceRunId: Uuid.nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type Memory = z.infer<typeof Memory>;

/** `GET /workspaces/:ws/projects/:projectId/memories?q=&status=` */
export const MemoryQuery = z.object({
  q: z.string().max(500).optional(),
  status: z.enum(['proposed', 'active', 'archived']).optional(),
});
export const UpsertMemoryRequest = z.object({
  kind: z.enum(MEMORY_KINDS),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),
});
/** `POST /workspaces/:ws/memories/:memoryId/review` — approve or reject an agent proposal. */
export const ReviewMemoryRequest = z.object({ approve: z.boolean() });

export const Skill = z.object({
  id: Uuid,
  projectId: Uuid.nullable(),
  name: z.string(),
  description: z.string(),
  sourceUrl: z.string().nullable(),
  sourceRef: z.string().nullable(),
  files: z.array(z.string()),
  enabled: z.boolean(),
  createdAt: IsoDate,
});
export type Skill = z.infer<typeof Skill>;

/** `POST /workspaces/:ws/skills/import` — public Git repository containing a SKILL.md. */
export const ImportSkillRequest = z.object({
  gitUrl: z.url(),
  ref: z.string().max(200).optional(),
  path: z.string().max(500).optional(),
  projectId: Uuid.optional(),
});

export const LeaderboardEntry = z.object({
  userId: z.string(),
  name: z.string(),
  runs: z.number().int(),
  totalTokens: z.number(),
  costUsd: z.number(),
  activeDays: z.number().int(),
  currentStreak: z.number().int(),
  longestStreak: z.number().int(),
  topCli: z.string().nullable(),
  topPersona: z.string().nullable(),
});
export type LeaderboardEntry = z.infer<typeof LeaderboardEntry>;

/** `GET /workspaces/:ws/leaderboard?range=7d|30d|all` */
export const LeaderboardQuery = z.object({ range: z.enum(['7d', '30d', 'all']).default('30d') });
export const Leaderboard = z.object({ entries: z.array(LeaderboardEntry), optedOut: z.number().int() });

/** `POST /workspaces/:ws/canvases/:canvasId/publish` */
export const PublishCanvasRequest = z.object({
  kind: z.enum(['image', 'html']),
  contentBase64: z.string().min(1).max(14_000_000),
});
export const Publication = z.object({
  id: Uuid,
  canvasId: Uuid,
  kind: z.enum(['image', 'html']),
  url: z.string(),
  createdAt: IsoDate,
  revokedAt: IsoDate.nullable(),
});
export type Publication = z.infer<typeof Publication>;
