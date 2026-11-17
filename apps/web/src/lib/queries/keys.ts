/**
 * TanStack Query keys. Everything workspace-scoped starts with `['ws', workspaceId, <resource>]`
 * so realtime handlers can address one resource across all of its cached variants.
 */
export const queryKeys = {
  me: ['me'] as const,
  runners: (ws: string) => ['ws', ws, 'runners'] as const,
  projects: (ws: string) => ['ws', ws, 'projects'] as const,
  project: (ws: string, projectId: string) => ['ws', ws, 'project', projectId] as const,
  allProjectRepos: (ws: string) => ['ws', ws, 'project-repos'] as const,
  projectRepos: (ws: string, projectId: string) => ['ws', ws, 'project-repos', projectId] as const,
  allProjectTickets: (ws: string) => ['ws', ws, 'project-tickets'] as const,
  projectTickets: (ws: string, projectId: string) =>
    ['ws', ws, 'project-tickets', projectId] as const,
  ticket: (ws: string, ticketId: string) => ['ws', ws, 'ticket', ticketId] as const,
  allTicketRuns: (ws: string) => ['ws', ws, 'ticket-runs'] as const,
  ticketRuns: (ws: string, ticketId: string) => ['ws', ws, 'ticket-runs', ticketId] as const,
  runEvents: (ws: string, runId: string) => ['ws', ws, 'run-events', runId] as const,
  review: (ws: string, ticketId: string) => ['ws', ws, 'review', ticketId] as const,
  file: (ws: string, ticketId: string, rev: string, path: string) =>
    ['ws', ws, 'file', ticketId, rev, path] as const,
  audit: (ws: string) => ['ws', ws, 'audit'] as const,
  personas: (ws: string) => ['ws', ws, 'personas'] as const,
  allContextDocs: (ws: string) => ['ws', ws, 'context-docs'] as const,
  contextDocs: (ws: string, projectId: string) => ['ws', ws, 'context-docs', projectId] as const,
  allWorkflows: (ws: string) => ['ws', ws, 'workflows'] as const,
  workflows: (ws: string, projectId: string) => ['ws', ws, 'workflows', projectId] as const,
  allTicketWorkflows: (ws: string) => ['ws', ws, 'ticket-workflow'] as const,
  ticketWorkflow: (ws: string, ticketId: string) => ['ws', ws, 'ticket-workflow', ticketId] as const,
  allRequirements: (ws: string) => ['ws', ws, 'requirements'] as const,
  requirements: (ws: string, projectId: string) => ['ws', ws, 'requirements', projectId] as const,
  usage: (ws: string) => ['ws', ws, 'usage'] as const,
  pricing: (ws: string) => ['ws', ws, 'pricing'] as const,
};
