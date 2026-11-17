import type { WorkspaceRole } from '@coffe/contracts';

/** UI-side mirror of the role table (architecture §6.3); the API enforces the real checks. */
export type Capability =
  | 'runner.manage'
  | 'runner.revoke'
  | 'project.manage'
  | 'ticket.manage'
  | 'run.control'
  | 'review.decide';

const MEMBER_CAPABILITIES: readonly Capability[] = [
  'runner.manage',
  'project.manage',
  'ticket.manage',
  'run.control',
  'review.decide',
];

const GRANTS: Record<WorkspaceRole, readonly Capability[]> = {
  owner: [...MEMBER_CAPABILITIES, 'runner.revoke'],
  member: MEMBER_CAPABILITIES,
  reviewer: ['review.decide'],
};

export function can(role: WorkspaceRole, capability: Capability): boolean {
  return GRANTS[role].includes(capability);
}
