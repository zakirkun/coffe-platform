'use client';

import { TICKET_STATUSES, type Ticket, type TicketStatus } from '@coffe/contracts';
import { move } from '@dnd-kit/helpers';
import { DragDropProvider, useDroppable } from '@dnd-kit/react';
import { useSortable } from '@dnd-kit/react/sortable';
import { AlertTriangle, BookText, GitMerge, ListChecks, Lock, Play, Workflow } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useWorkspace } from '@/components/workspace/workspace-context';
import { errorMessage } from '@/lib/api';
import { can } from '@/lib/permissions';
import { useMoveTicket, usePersonas, useStartWorkflow } from '@/lib/queries/orchestration';
import { useProject, useProjectRepos } from '@/lib/queries/projects';
import { useRealtimeSync } from '@/lib/queries/realtime-sync';
import { useProjectTickets } from '@/lib/queries/tickets';
import { isRunActive, RUN_STATUS_LABELS } from '@/lib/run-status';
import {
  groupTicketIds,
  neighboursOf,
  TICKET_STATUS_LABELS,
  type TicketColumns,
} from '@/lib/ticket-status';
import { NewTicketDialog } from './new-ticket-dialog';
import { ProjectReposDialog } from './project-repos-dialog';
import { ProjectSettingsDialog } from './project-settings-dialog';

/** `CollisionPriority.Low` of `@dnd-kit/abstract`: cards win over the column they sit in. */
const COLUMN_COLLISION_PRIORITY = 1;

function TicketCard({
  ticket,
  column,
  index,
  assignee,
  canMove,
  canRun,
}: {
  ticket: Ticket;
  column: TicketStatus;
  index: number;
  assignee: string | undefined;
  canMove: boolean;
  canRun: boolean;
}) {
  const { id: workspaceId } = useWorkspace();
  const { ref, isDragging } = useSortable({
    id: ticket.id,
    index,
    group: column,
    type: 'ticket',
    accept: 'ticket',
    disabled: !canMove,
  });
  const start = useStartWorkflow(workspaceId, ticket.id);
  const run = ticket.latestRun;
  const running = run !== null && isRunActive(run.status);
  const blocked = ticket.blockedBy.length > 0;
  const startable = canRun && !running && !blocked && (column === 'backlog' || column === 'ready');

  return (
    <div
      ref={ref}
      data-testid="ticket-card"
      className={`flex flex-col gap-2 rounded-lg border bg-card p-3 text-sm shadow-xs ${isDragging ? 'opacity-60' : ''}`}
    >
      <Link
        href={`/w/${workspaceId}/t/${ticket.id}`}
        className="flex flex-col gap-1 rounded-sm hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <span className="font-mono text-xs text-muted-foreground">{ticket.key}</span>
        <span className="font-medium">{ticket.title}</span>
      </Link>
      <span className="flex flex-wrap items-center gap-1.5">
        {assignee ? <Badge variant="outline">{assignee}</Badge> : null}
        {blocked ? (
          <Badge
            variant="warning"
            title={ticket.blockedBy
              .map((blocker) => `${blocker.key} (${blocker.status})`)
              .join(', ')}
          >
            <Lock /> After {ticket.blockedBy.map((blocker) => blocker.key).join(', ')}
          </Badge>
        ) : null}
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
        {running ? <Badge variant="info">{RUN_STATUS_LABELS[run.status]}</Badge> : null}
        {startable ? (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-7"
            disabled={start.isPending}
            onClick={() =>
              start.mutate(undefined, {
                onSuccess: (instance) =>
                  toast.success(`${ticket.key}: ${instance.workflowName} started`),
                onError: (error) => toast.error(errorMessage(error)),
              })
            }
          >
            <Play /> Start
          </Button>
        ) : null}
      </span>
    </div>
  );
}

function BoardColumn({
  status,
  count,
  loading,
  children,
}: {
  status: TicketStatus;
  count: number;
  loading: boolean;
  children: ReactNode;
}) {
  const { ref, isDropTarget } = useDroppable({
    id: status,
    type: 'column',
    accept: 'ticket',
    collisionPriority: COLUMN_COLLISION_PRIORITY,
  });
  return (
    <section
      ref={ref}
      aria-label={TICKET_STATUS_LABELS[status]}
      className={`flex min-h-40 flex-col gap-2 rounded-xl p-2 ${isDropTarget ? 'bg-accent' : 'bg-muted/50'}`}
    >
      <h2 className="flex items-center justify-between px-1 text-sm font-medium">
        {TICKET_STATUS_LABELS[status]}
        <span className="text-xs text-muted-foreground">{count}</span>
      </h2>
      {loading ? <Skeleton className="h-16 w-full" /> : null}
      {children}
    </section>
  );
}

export function ProjectBoard({ projectId }: { projectId: string }) {
  const { id: workspaceId, role } = useWorkspace();
  const project = useProject(workspaceId, projectId);
  const repos = useProjectRepos(workspaceId, projectId);
  const tickets = useProjectTickets(workspaceId, projectId);
  const personas = usePersonas(workspaceId, projectId);
  const moveTicket = useMoveTicket(workspaceId, projectId);
  useRealtimeSync(workspaceId, `project:${projectId}`);

  const serverColumns = useMemo(() => groupTicketIds(tickets.data ?? []), [tickets.data]);
  // While a card is dragged (and until the server confirms the drop) the local order wins.
  const [dragColumns, setDragColumns] = useState<TicketColumns | null>(null);
  const columns = dragColumns ?? serverColumns;
  const ticketsById = useMemo(
    () => new Map((tickets.data ?? []).map((ticket) => [ticket.id, ticket])),
    [tickets.data],
  );
  const personaNames = useMemo(
    () => new Map((personas.data ?? []).map((persona) => [persona.id, persona.name])),
    [personas.data],
  );
  const canMove = can(role, 'ticket.manage');
  const canRun = can(role, 'run.control');

  if (project.error) {
    return (
      <p role="alert" className="p-6 text-sm text-destructive">
        {errorMessage(project.error)}
      </p>
    );
  }

  const primary = repos.data?.find((binding) => binding.isPrimary) ?? repos.data?.[0];
  const runnerCount = new Set((repos.data ?? []).map((binding) => binding.runnerId)).size;
  const base = `/w/${workspaceId}/p/${projectId}`;

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
              ? `${primary.repo.name} on ${primary.runnerName} (${primary.runnerStatus})${runnerCount > 1 ? ` + ${runnerCount - 1} more runner${runnerCount > 2 ? 's' : ''}` : ''}`
              : repos.isPending
                ? '\u00a0'
                : 'No repository bound: runs cannot start until one is added.'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <Link href={`${base}/plan`}>
              <ListChecks /> Plan
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href={`${base}/context`}>
              <BookText /> Context
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href={`${base}/workflows`}>
              <Workflow /> Workflows
            </Link>
          </Button>
          {project.data && can(role, 'project.manage') ? (
            <ProjectReposDialog projectId={projectId} />
          ) : null}
          {project.data && can(role, 'project.manage') ? (
            <ProjectSettingsDialog project={project.data} />
          ) : null}
          {can(role, 'ticket.manage') ? <NewTicketDialog projectId={projectId} /> : null}
        </div>
      </div>
      {tickets.error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(tickets.error)}
        </p>
      ) : (
        <DragDropProvider
          onDragStart={() => setDragColumns(serverColumns)}
          onDragOver={(event) => setDragColumns((current) => move(current ?? serverColumns, event))}
          onDragEnd={(event) => {
            const ticketId = event.operation.source?.id;
            if (event.canceled || typeof ticketId !== 'string' || !dragColumns) {
              setDragColumns(null);
              return;
            }
            const target = neighboursOf(dragColumns, ticketId);
            const ticket = ticketsById.get(ticketId);
            const before = ticket ? neighboursOf(serverColumns, ticketId) : null;
            if (
              !target ||
              !ticket ||
              (before && before.status === target.status && before.afterId === target.afterId)
            ) {
              setDragColumns(null);
              return;
            }
            moveTicket.mutate(
              { ticketId, body: target },
              {
                onError: (error) => toast.error(errorMessage(error)),
                onSettled: () => setDragColumns(null),
              },
            );
          }}
        >
          <div className="grid min-h-0 flex-1 auto-cols-[minmax(16rem,1fr)] grid-flow-col gap-4 overflow-x-auto pb-2">
            {TICKET_STATUSES.map((status) => (
              <BoardColumn
                key={status}
                status={status}
                count={columns[status].length}
                loading={tickets.isPending}
              >
                {columns[status].map((ticketId, index) => {
                  const ticket = ticketsById.get(ticketId);
                  if (!ticket) return null;
                  return (
                    <TicketCard
                      key={ticketId}
                      ticket={ticket}
                      column={status}
                      index={index}
                      assignee={
                        ticket.assigneePersonaId
                          ? personaNames.get(ticket.assigneePersonaId)
                          : undefined
                      }
                      canMove={canMove}
                      canRun={canRun}
                    />
                  );
                })}
              </BoardColumn>
            ))}
          </div>
        </DragDropProvider>
      )}
    </div>
  );
}
