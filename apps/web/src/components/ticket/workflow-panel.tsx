'use client';

import type { Ticket, WorkflowInstance, WorkflowStepState } from '@coffe/contracts';
import { Ban, Play } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useWorkspace } from '@/components/workspace/workspace-context';
import { errorMessage } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import { can } from '@/lib/permissions';
import { personasForProject, ROLE_LABELS } from '@/lib/personas';
import {
  useCancelWorkflow,
  usePersonas,
  useStartWorkflow,
  useTicketWorkflow,
  useUpdateTicket,
  useWorkflows,
} from '@/lib/queries/orchestration';

const INSTANCE_BADGES: Record<
  WorkflowInstance['status'],
  { label: string; variant: BadgeVariant }
> = {
  running: { label: 'Running', variant: 'info' },
  completed: { label: 'Completed', variant: 'success' },
  failed: { label: 'Failed', variant: 'destructive' },
  cancelled: { label: 'Cancelled', variant: 'secondary' },
};

const STEP_BADGES: Record<WorkflowStepState['status'], BadgeVariant> = {
  pending: 'outline',
  running: 'info',
  completed: 'success',
  failed: 'destructive',
  skipped: 'secondary',
};

/** Assignee persona, workflow start/cancel and the step timeline of a ticket (F1, F2). */
export function WorkflowPanel({ ticket }: { ticket: Ticket }) {
  const { id: workspaceId, role } = useWorkspace();
  const instance = useTicketWorkflow(workspaceId, ticket.id);
  const workflows = useWorkflows(workspaceId, ticket.projectId);
  const personas = usePersonas(workspaceId, ticket.projectId);
  const start = useStartWorkflow(workspaceId, ticket.id);
  const cancel = useCancelWorkflow(workspaceId, ticket.id);
  const update = useUpdateTicket(workspaceId, ticket.id);
  const [workflowId, setWorkflowId] = useState('');
  const onError = (error: Error) => toast.error(errorMessage(error));

  const current = instance.data;
  const running = current?.status === 'running';
  const definition = workflows.data?.find((workflow) => workflow.id === current?.workflowId);
  const stepName = (key: string) => definition?.steps.find((step) => step.key === key)?.name ?? key;
  const assignable = personasForProject(personas.data ?? [], ticket.projectId);
  const canRun = can(role, 'run.control');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          Agents
          {current ? (
            <Badge variant={INSTANCE_BADGES[current.status].variant}>
              {current.workflowName}: {INSTANCE_BADGES[current.status].label}
            </Badge>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2">
            Assignee
            <select
              aria-label="Assignee persona"
              className="h-8 rounded-md border bg-transparent px-2"
              value={ticket.assigneePersonaId ?? ''}
              disabled={!can(role, 'ticket.manage') || update.isPending}
              onChange={(event) =>
                update.mutate({ assigneePersonaId: event.target.value || null }, { onError })
              }
            >
              <option value="">Unassigned</option>
              {assignable.map((persona) => (
                <option key={persona.id} value={persona.id}>
                  {persona.name} ({ROLE_LABELS[persona.role]})
                </option>
              ))}
            </select>
          </label>
          {canRun ? (
            <span className="flex items-center gap-2">
              <select
                aria-label="Workflow"
                className="h-8 rounded-md border bg-transparent px-2"
                value={workflowId}
                onChange={(event) => setWorkflowId(event.target.value)}
              >
                <option value="">Default workflow</option>
                {(workflows.data ?? []).map((workflow) => (
                  <option key={workflow.id} value={workflow.id}>
                    {workflow.name}
                    {workflow.isDefault ? ' (default)' : ''}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                disabled={
                  running ||
                  start.isPending ||
                  ticket.status === 'done' ||
                  ticket.blockedBy.length > 0
                }
                title={
                  ticket.blockedBy.length > 0
                    ? `Waits for ${ticket.blockedBy.map((blocker) => blocker.key).join(', ')}`
                    : undefined
                }
                onClick={() =>
                  start.mutate(workflowId || undefined, {
                    onSuccess: (started) => toast.success(`${started.workflowName} started`),
                    onError,
                  })
                }
              >
                <Play /> Start workflow
              </Button>
              {running ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={cancel.isPending}
                  onClick={() => cancel.mutate(undefined, { onError })}
                >
                  <Ban /> Cancel
                </Button>
              ) : null}
            </span>
          ) : null}
        </div>
        {current ? (
          <ol className="flex flex-col gap-2" aria-label="Workflow steps">
            {current.steps.map((step) => (
              <li
                key={step.key}
                className={`flex flex-col gap-1 rounded-md border p-2 text-sm ${current.currentStepKey === step.key && running ? 'border-sky-500/60' : ''}`}
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{stepName(step.key)}</span>
                  <Badge variant={STEP_BADGES[step.status]}>{step.status}</Badge>
                  {step.loops > 0 ? (
                    <span className="text-xs text-muted-foreground">loop {step.loops + 1}</span>
                  ) : null}
                  {step.runIds.length > 0 ? (
                    <span className="text-xs text-muted-foreground">
                      {step.runIds.length} {step.runIds.length === 1 ? 'run' : 'runs'}
                    </span>
                  ) : null}
                </span>
                {step.outcome ? (
                  <span className="text-xs whitespace-pre-wrap text-muted-foreground">
                    {step.outcome}
                  </span>
                ) : null}
              </li>
            ))}
            <li className="text-xs text-muted-foreground">
              Started {formatRelativeTime(current.startedAt)}
              {current.endedAt ? ` · ended ${formatRelativeTime(current.endedAt)}` : ''}
            </li>
          </ol>
        ) : instance.isPending ? null : (
          <p className="text-sm text-muted-foreground">
            Start a workflow to hand this ticket from persona to persona (implement → test →
            review), or start a single run below.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
