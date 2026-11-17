'use client';

import { AlertTriangle, ArrowLeft, GitBranch, GitMerge, Lock } from 'lucide-react';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useWorkspace } from '@/components/workspace/workspace-context';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorMessage } from '@/lib/api';
import { useProject, useProjectRepos } from '@/lib/queries/projects';
import { useRealtimeSync } from '@/lib/queries/realtime-sync';
import { useRunners } from '@/lib/queries/runners';
import { useTicketRuns } from '@/lib/queries/runs';
import { useTicket } from '@/lib/queries/tickets';
import { TICKET_STATUS_BADGES, TICKET_STATUS_LABELS } from '@/lib/ticket-status';
import { ReviewPanel } from './review-panel';
import { RunPanel } from './run-panel';
import { WorkflowPanel } from './workflow-panel';

export function TicketPage({ ticketId }: { ticketId: string }) {
  const { id: workspaceId } = useWorkspace();
  const ticket = useTicket(workspaceId, ticketId);
  const project = useProject(workspaceId, ticket.data?.projectId);
  const bindings = useProjectRepos(workspaceId, ticket.data?.projectId);
  const runners = useRunners(workspaceId);
  const runs = useTicketRuns(workspaceId, ticketId);
  useRealtimeSync(workspaceId, `ticket:${ticketId}`);

  if (ticket.error) {
    return (
      <p role="alert" className="p-6 text-sm text-destructive">
        {errorMessage(ticket.error)}
      </p>
    );
  }
  if (!ticket.data) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  const current = ticket.data;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-6">
      <div className="flex flex-col gap-2">
        <Link
          href={`/w/${workspaceId}/p/${current.projectId}`}
          className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> {project.data?.name ?? 'Board'}
        </Link>
        <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
          <span className="font-mono text-muted-foreground">{current.key}</span>
          {current.title}
        </h1>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge data-testid="ticket-status" variant={TICKET_STATUS_BADGES[current.status]}>
            {TICKET_STATUS_LABELS[current.status]}
          </Badge>
          {current.flags.failed ? (
            <Badge variant="destructive">
              <AlertTriangle /> Last run failed
            </Badge>
          ) : null}
          {current.flags.mergeConflict ? (
            <Badge variant="warning">
              <GitMerge /> Merge conflict
            </Badge>
          ) : null}
          {current.blockedBy.length > 0 ? (
            <Badge variant="warning">
              <Lock /> Blocked by{' '}
              {current.blockedBy.map((blocker, index) => (
                <Link key={blocker.id} href={`/w/${workspaceId}/t/${blocker.id}`} className="underline">
                  {blocker.key}
                  {index < current.blockedBy.length - 1 ? ',' : ''}
                </Link>
              ))}
            </Badge>
          ) : null}
          {current.branch ? (
            <span className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
              <GitBranch className="size-3.5" />
              {current.branch} → {current.baseBranch ?? 'main'}
            </span>
          ) : null}
        </div>
      </div>
      <WorkflowPanel ticket={current} />
      <Tabs defaultValue={current.status === 'in_review' ? 'review' : 'run'}>
        <TabsList>
          <TabsTrigger value="run">Run</TabsTrigger>
          <TabsTrigger value="review">Review</TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
        </TabsList>
        <TabsContent value="run" className="mt-4">
          <RunPanel
            ticket={current}
            project={project.data}
            runs={runs.data ?? []}
            bindings={bindings.data ?? []}
            runners={runners.data ?? []}
          />
        </TabsContent>
        <TabsContent value="review" className="mt-4">
          <ReviewPanel ticket={current} />
        </TabsContent>
        <TabsContent value="details" className="mt-4">
          <Card>
            <CardContent className="flex flex-col gap-6 pt-6">
              <section
                aria-label="Description"
                className="text-sm leading-6 [&_a]:underline [&_code]:font-mono [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_ul]:list-disc [&_ul]:pl-5"
              >
                {current.description ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{current.description}</ReactMarkdown>
                ) : (
                  <p className="text-sm text-muted-foreground">No description.</p>
                )}
              </section>
              {current.acceptanceCriteria.length > 0 ? (
                <section aria-label="Acceptance criteria" className="flex flex-col gap-2">
                  <h2 className="text-sm font-medium">Acceptance criteria</h2>
                  <ul className="list-disc pl-5 text-sm">
                    {current.acceptanceCriteria.map((criterion) => (
                      <li key={criterion}>{criterion}</li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
