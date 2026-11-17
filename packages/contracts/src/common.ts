import { z } from 'zod';

/** COFFE domain ids are UUIDs (v7). Better Auth ids (users, workspaces) are opaque strings. */
export const Uuid = z.uuid();
export const AuthId = z.string().min(1);

export const IsoDate = z.string();

/** Error body returned by every non-2xx API response. */
export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

export const CursorQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type CursorQuery = z.infer<typeof CursorQuery>;

export const Page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const WORKSPACE_ROLES = ['owner', 'member', 'reviewer'] as const;
export const WorkspaceRole = z.enum(WORKSPACE_ROLES);
export type WorkspaceRole = z.infer<typeof WorkspaceRole>;
