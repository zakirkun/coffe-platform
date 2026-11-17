/**
 * Workspace roles (architecture §6.3), expressed with Better Auth's access control so the
 * organization plugin and COFFE guards share one definition.
 */
import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements, memberAc, ownerAc } from 'better-auth/plugins/organization/access';

export const statements = {
  ...defaultStatements,
  project: ['create', 'update', 'delete'],
  runner: ['pair', 'update', 'revoke'],
  ticket: ['create', 'update', 'run'],
  review: ['decide'],
  environment: ['use'],
} as const;

export const ac = createAccessControl(statements);

export const roles = {
  owner: ac.newRole({
    ...ownerAc.statements,
    project: ['create', 'update', 'delete'],
    runner: ['pair', 'update', 'revoke'],
    ticket: ['create', 'update', 'run'],
    review: ['decide'],
    environment: ['use'],
  }),
  member: ac.newRole({
    ...memberAc.statements,
    project: ['create', 'update'],
    runner: ['pair', 'update'],
    ticket: ['create', 'update', 'run'],
    review: ['decide'],
    environment: ['use'],
  }),
  reviewer: ac.newRole({
    ...memberAc.statements,
    review: ['decide'],
  }),
};

export type WorkspaceRoleName = keyof typeof roles;
export type Permission = {
  [K in keyof typeof statements]?: (typeof statements)[K][number][];
};

/** True when `role` grants every action in `permission`. */
export function roleAllows(role: string, permission: Permission): boolean {
  const granted = roles[role as WorkspaceRoleName];
  if (!granted) return false;
  return granted.authorize(permission).success;
}
