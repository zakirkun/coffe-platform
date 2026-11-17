import { WORKSPACE_ROLES, type WorkspaceRole } from '@coffe/contracts';
import type { Request } from 'express';
import type { AuthSession } from './auth.js';

export type AuthUser = AuthSession['user'];

/** Workspace resolved from the `:ws` route parameter plus the caller's role in it. */
export interface WorkspaceContext {
  id: string;
  role: WorkspaceRole;
}

/** Express request after `SessionGuard` / `WorkspaceGuard` ran. */
export interface AppRequest extends Request {
  auth?: AuthSession;
  workspace?: WorkspaceContext;
}

/**
 * Better Auth stores one role or a comma-separated list. COFFE uses the most privileged known
 * role; anything unknown gets the least privileged one.
 */
export function normalizeRole(raw: string): WorkspaceRole {
  const names = raw.split(',').map((name) => name.trim());
  return WORKSPACE_ROLES.find((role) => names.includes(role)) ?? 'reviewer';
}
