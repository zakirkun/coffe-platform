'use client';

import { TICKET_STATUSES, type Ticket } from '@coffe/contracts';
import { AlertTriangle, GitMerge } from 'lucide-react';
import Link from 'next/link';
import { useWorkspace } from '@/components/workspace/workspace-context';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage } from '@/lib/api';
import { can } from '@/lib/permissions';
import { useProject, useProjectRepos } from '@/lib/queries/projects';
import { useRealtimeSync } from '@/lib/queries/realtime-sync';
import { useProjectTickets } from '@/lib/queries/tickets';
import { RUN_STATUS_LABELS, isRunActive } from '@/lib/run-status';
import { TICKET_STATUS_LABELS } from '@/lib/ticket-status';
import { NewTicketDialog } from './new-ticket-dialog';
import { ProjectSettingsDialog } from './project-settings-dialog';

function TicketCard({ ticket }: { ticket: Ticket }) {
  const { id: workspaceId } = useWorkspace();
  const run = ticket.latestRun;
  return (
    <Link
      href={`/w/${workspaceId}/t/${ticket.id}`}
      className="flex flex-col gap-2 rounded-lg border bg-card p-3 text-sm shadow-xs transition-colors hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <span className="font-mono text-xs text-muted-foreground">{ticket.key}</span>
      <span className="font-medium">{ticket.title}</span>
      <span className="flex flex-wrap gap-1.5">
        {ticket.flags.failed ? (
          <Badge variant="destructive">
            <AlertTriangle /> Failed
          </Badge>
        ) : null}
        {ticket.flags.mergeConflict ? (
          <Badge variant="warning">
            <GitMerge /> Conflict
          </Badge>
        ) : null}
        {run && isRunActive(run.status) ? <Badge variant="info">{RUN_STATUS_LABELS[run.status]}</Badge> : null}
      </span>
    </Link>
  );
}

export function ProjectBoard({ projectId }: { projectId: string }) {
  const { id: workspaceId, role } = useWorkspace();
  const project = useProject(workspaceId, projectId);
  const repos = useProjectRepos(workspaceId, projectId);
  const tickets = useProjectTickets(workspaceId, projectId);
  useRealtimeSync(workspaceId, `project:${projectId}`);

  if (project.error) {
    return (
      <p role="alert" className="p-6 text-sm text-destructive">
        {errorMessage(project.error)}
      </p>
    );
  }

  const primary = repos.data?.find((binding) => binding.isPrimary) ?? repos.data?.[0];

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          {project.data ? (
            <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
              {project.data.name}
              <Badge variant="outline" className="font-mono">
                {project.data.key}
              </Badge>
            </h1>
          ) : (
            <Skeleton className="h-7 w-48" />
          )}
          <p className="text-sm text-muted-foreground">
            {primary
              ? `${primary.repo.name} on ${primary.runnerName} (${primary.runnerStatus})`
              : repos.isPending
                ? '\u00a0'
                : 'No repository bound: runs cannot start until one is added.'}
          </p>
        </div>
        <div className="flex gap-2">
          {project.data && can(role, 'project.manage') ? <ProjectSettingsDialog project={project.data} /> : null}
          {can(role, 'ticket.manage') ? <NewTicketDialog projectId={projectId} /> : null}
        </div>
      </div>
      {tickets.error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(tickets.error)}
        </p>
      ) : (
        <div className="grid min-h-0 flex-1 auto-cols-[minmax(16rem,1fr)] grid-flow-col gap-4 overflow-x-auto pb-2">
          {TICKET_STATUSES.map((status) => {
            const column = (tickets.data ?? [])
              .filter((ticket) => ticket.status === status)
              .toSorted((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
            return (
              <section key={status} aria-label={TICKET_STATUS_LABELS[status]} className="flex min-h-40 flex-col gap-2 rounded-xl bg-muted/50 p-2">
                <h2 className="flex items-center justify-between px-1 text-sm font-medium">
                  {TICKET_STATUS_LABELS[status]}
                  <span className="text-xs text-muted-foreground">{column.length}</span>
                </h2>
                {tickets.isPending ? <Skeleton className="h-16 w-full" /> : null}
                {column.map((ticket) => (
                  <TicketCard key={ticket.id} ticket={ticket} />
                ))}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
