import type { PermissionPolicy, TermSize } from '@coffe/protocol';
import type { PermissionPolicyJson } from '../db/schema/index.js';

/** The parts of a ticket an agent gets to see in its prompt. */
export interface TicketBrief {
  key: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
}

/** Runs without a persona may change the worktree but never publish it (architecture §13.2). */
export const TICKET_RUN_PERMISSIONS: PermissionPolicyJson = {
  mode: 'workspace_write',
  allow_tools: [],
  deny_tools: ['Bash(git push:*)'],
  network: true,
};
/** Planning reads the repository and answers with JSON; it never edits. */
export const PLANNING_RUN_PERMISSIONS: PermissionPolicyJson = {
  mode: 'read_only',
  allow_tools: [],
  deny_tools: [],
  network: true,
};
export const RUN_TIMEOUT_SECS = 3600;
export const RUN_TERMINAL: TermSize = { cols: 120, rows: 32 };

export function ticketBranch(ticketKey: string): string {
  return `coffe/${ticketKey}`;
}

/** The stored policy as the runner protocol carries it (the timeout travels separately). */
export function toProtocolPolicy(policy: PermissionPolicyJson): PermissionPolicy {
  return {
    mode: policy.mode,
    allow_tools: policy.allow_tools,
    deny_tools: policy.deny_tools,
    network: policy.network,
    max_turns: policy.max_turns ?? null,
    max_budget_usd: policy.max_budget_usd ?? null,
  };
}

/** Task prompt of an implementation run: the ticket plus optional extra instructions. */
export function ticketPrompt(ticket: TicketBrief, extra: string | undefined): string {
  const sections = [`Implement ticket ${ticket.key}: ${ticket.title}`];
  if (ticket.description.trim()) sections.push(ticket.description.trim());
  if (ticket.acceptanceCriteria.length > 0) {
    sections.push(`Acceptance criteria:\n${ticket.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}`);
  }
  if (extra?.trim()) sections.push(`Additional instructions:\n${extra.trim()}`);
  return sections.join('\n\n');
}

/** Task prompt of the run that follows a "request changes" review (architecture §11.7). */
export function changesRequestedPrompt(ticket: TicketBrief, feedback: string, previousSummary: string | null): string {
  const sections = [
    `A reviewer requested changes on ticket ${ticket.key}: ${ticket.title}. Continue in the same worktree and address the feedback.`,
    `Reviewer feedback:\n${feedback.trim()}`,
  ];
  if (previousSummary?.trim()) sections.push(`Summary of the previous run:\n${previousSummary.trim()}`);
  return sections.join('\n\n');
}
