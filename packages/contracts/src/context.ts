import { z } from 'zod';
import { IsoDate, Uuid } from './common.js';

export const CONTEXT_KINDS = ['rule', 'knowledge'] as const;
export const ContextKind = z.enum(CONTEXT_KINDS);

/** Project knowledge base entry or rule, sent with every run (architecture §11.4). */
export const ContextDoc = z.object({
  id: Uuid,
  projectId: Uuid,
  kind: ContextKind,
  title: z.string(),
  body: z.string(),
  enabled: z.boolean(),
  position: z.number().int(),
  updatedBy: z.string().nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type ContextDoc = z.infer<typeof ContextDoc>;

/** `POST /workspaces/:ws/projects/:projectId/context` */
export const CreateContextDocRequest = z.object({
  kind: ContextKind,
  title: z.string().min(1).max(200),
  body: z.string().max(200_000).default(''),
  enabled: z.boolean().default(true),
});
export type CreateContextDocRequest = z.infer<typeof CreateContextDocRequest>;

/** `PATCH /workspaces/:ws/context/:docId` */
export const UpdateContextDocRequest = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().max(200_000).optional(),
  enabled: z.boolean().optional(),
  position: z.number().int().min(0).optional(),
});
export type UpdateContextDocRequest = z.infer<typeof UpdateContextDocRequest>;

/** One file of the context bundle written to `<worktree>/.coffe/context/`. */
export const ContextFilePreview = z.object({ name: z.string(), content: z.string() });

/**
 * `GET /workspaces/:ws/projects/:projectId/context/preview?ticketId=&personaId=` — the exact
 * bundle a run would receive, for transparency in the UI.
 */
export const ContextPreviewQuery = z.object({
  ticketId: Uuid.optional(),
  personaId: Uuid.optional(),
});
export const ContextPreview = z.object({
  files: z.array(ContextFilePreview),
  totalBytes: z.number().int(),
});
export type ContextPreview = z.infer<typeof ContextPreview>;
