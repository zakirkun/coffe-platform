import type { PermissionMode, PermissionPolicy, Persona, PersonaRole } from '@coffe/contracts';

export const ROLE_LABELS: Record<PersonaRole, string> = {
  planner: 'Planner',
  implementer: 'Implementer',
  tester: 'Tester',
  reviewer: 'Reviewer',
  designer: 'Designer',
  custom: 'Custom',
};

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  read_only: 'Read only',
  workspace_write: 'Edit the worktree',
  full_auto: 'Full auto (no approvals)',
};

/** The editable text of a permission policy; numbers stay strings until saved. */
export interface PolicyForm {
  mode: PermissionMode;
  network: boolean;
  allowTools: string;
  denyTools: string;
  maxTurns: string;
  maxBudgetUsd: string;
  timeoutMinutes: string;
}

export function policyForm(policy: PermissionPolicy): PolicyForm {
  return {
    mode: policy.mode,
    network: policy.network,
    allowTools: policy.allowTools.join('\n'),
    denyTools: policy.denyTools.join('\n'),
    maxTurns: policy.maxTurns == null ? '' : String(policy.maxTurns),
    maxBudgetUsd: policy.maxBudgetUsd == null ? '' : String(policy.maxBudgetUsd),
    timeoutMinutes: policy.timeoutSecs == null ? '' : String(Math.round(policy.timeoutSecs / 60)),
  };
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Empty or unparsable input means "no limit". */
function optionalNumber(text: string): number | null {
  const value = Number(text.trim());
  return text.trim() === '' || !Number.isFinite(value) ? null : value;
}

export function policyFromForm(form: PolicyForm): PermissionPolicy {
  const timeoutMinutes = optionalNumber(form.timeoutMinutes);
  return {
    mode: form.mode,
    network: form.network,
    allowTools: lines(form.allowTools),
    denyTools: lines(form.denyTools),
    maxTurns: optionalNumber(form.maxTurns),
    maxBudgetUsd: optionalNumber(form.maxBudgetUsd),
    timeoutSecs: timeoutMinutes == null ? null : Math.round(timeoutMinutes * 60),
  };
}

/** One-line summary of what a persona may do, e.g. "Edit the worktree · no network · 20 turns". */
export function describePolicy(policy: PermissionPolicy): string {
  const parts = [PERMISSION_MODE_LABELS[policy.mode]];
  if (!policy.network) parts.push('no network');
  if (policy.maxTurns != null) parts.push(`${policy.maxTurns} turns`);
  if (policy.maxBudgetUsd != null) parts.push(`$${policy.maxBudgetUsd} budget`);
  if (policy.timeoutSecs != null) parts.push(`${Math.round(policy.timeoutSecs / 60)} min timeout`);
  if (policy.denyTools.length > 0) parts.push(`${policy.denyTools.length} denied tools`);
  return parts.join(' · ');
}

/** Personas a ticket or workflow step can use: enabled, workspace-wide or of this project. */
export function personasForProject(personas: readonly Persona[], projectId: string): Persona[] {
  return personas.filter(
    (persona) => persona.enabled && (persona.projectId === null || persona.projectId === projectId),
  );
}
