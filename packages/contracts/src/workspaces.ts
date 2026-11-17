import { z } from 'zod';
import { AuthId, IsoDate, WorkspaceRole } from './common.js';

export const UserSummary = z.object({
  id: AuthId,
  name: z.string(),
  email: z.string(),
  image: z.string().nullable(),
});
export type UserSummary = z.infer<typeof UserSummary>;

export const WorkspaceSummary = z.object({
  id: AuthId,
  name: z.string(),
  slug: z.string().nullable(),
  role: WorkspaceRole,
});
export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;

/** `GET /api/v1/me` */
export const MeResponse = z.object({
  user: UserSummary,
  workspaces: z.array(WorkspaceSummary),
  activeWorkspaceId: AuthId.nullable(),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const Member = z.object({
  id: AuthId,
  userId: AuthId,
  name: z.string(),
  email: z.string(),
  role: WorkspaceRole,
  createdAt: IsoDate,
});
export type Member = z.infer<typeof Member>;
