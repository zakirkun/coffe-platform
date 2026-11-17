'use client';

import {
  PERSONA_ROLES,
  PersonaRole,
  type Requirement,
  type TicketDraft,
  type UpdateDraftRequest,
} from '@coffe/contracts';
import { ArrowLeft, Check, Loader2, Plus, Sparkles, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useWorkspace } from '@/components/workspace/workspace-context';
import { errorMessage } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import { can } from '@/lib/permissions';
import { personasForProject, ROLE_LABELS } from '@/lib/personas';
import {
  type PlanningActions,
  usePersonas,
  usePlanningActions,
  useRequirements,
} from '@/lib/queries/orchestration';
import { useProject } from '@/lib/queries/projects';
import { useRealtimeSync } from '@/lib/queries/realtime-sync';

const STATUS_BADGES: Record<Requirement['status'], { label: string; variant: BadgeVariant }> = {
  draft: { label: 'Draft', variant: 'secondary' },
  planning: { label: 'Planning…', variant: 'info' },
  review: { label: 'Review drafts', variant: 'warning' },
  approved: { label: 'Approved', variant: 'success' },
  failed: { label: 'Planning failed', variant: 'destructive' },
};

function NewRequirementForm({
  actions,
  onCreated,
}: {
  actions: PlanningActions;
  onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    actions.create.mutate(
      { title: title.trim(), body },
      {
        onSuccess: (requirement) => {
          setTitle('');
          setBody('');
          onCreated(requirement.id);
        },
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-lg border p-3">
      <Label htmlFor="requirement-title">New requirement</Label>
      <Input
        id="requirement-title"
        placeholder="Title"
        required
        maxLength={200}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <Textarea
        aria-label="Requirement"
        rows={5}
        required
        placeholder="What should be built, for whom, and how we know it works."
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      <Button
        type="submit"
        size="sm"
        className="self-end"
        disabled={actions.create.isPending || !title.trim() || !body.trim()}
      >
        <Plus /> Add
      </Button>
    </form>
  );
}

function DraftEditor({
  requirement,
  draft,
  index,
  editable,
  actions,
}: {
  requirement: Requirement;
  draft: TicketDraft;
  index: number;
  editable: boolean;
  actions: PlanningActions;
}) {
  const { id: workspaceId } = useWorkspace();
  const [title, setTitle] = useState(draft.title);
  const [description, setDescription] = useState(draft.description);
  const [criteria, setCriteria] = useState(draft.acceptanceCriteria.join('\n'));
  const onError = (error: Error) => toast.error(errorMessage(error));
  const update = (body: UpdateDraftRequest) =>
    actions.updateDraft.mutate({ id: requirement.id, draftId: draft.id, body }, { onError });

  const criteriaList = criteria
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const dependsOn = draft.dependsOn
    .map((position) => requirement.drafts.findIndex((other) => other.position === position))
    .filter((at) => at >= 0)
    .map((at) => `#${at + 1}`);

  if (draft.status !== 'pending') {
    return (
      <li className="flex items-center gap-2 rounded-lg border p-3 text-sm opacity-80">
        <span className="font-mono text-xs text-muted-foreground">#{index + 1}</span>
        <span className="flex-1">{draft.title}</span>
        {draft.status === 'approved' && draft.ticketId ? (
          <Link href={`/w/${workspaceId}/t/${draft.ticketId}`} className="text-xs underline">
            Open ticket
          </Link>
        ) : (
          <Badge variant="secondary">Discarded</Badge>
        )}
      </li>
    );
  }

  return (
    <li className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">#{index + 1}</span>
        <Input
          aria-label={`Draft ${index + 1} title`}
          value={title}
          disabled={!editable}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() =>
            title.trim() && title !== draft.title ? update({ title: title.trim() }) : undefined
          }
        />
        {editable ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Discard draft ${index + 1}`}
            onClick={() =>
              actions.discardDraft.mutate({ id: requirement.id, draftId: draft.id }, { onError })
            }
          >
            <Trash2 />
          </Button>
        ) : null}
      </div>
      <Textarea
        aria-label={`Draft ${index + 1} description`}
        rows={3}
        value={description}
        disabled={!editable}
        onChange={(event) => setDescription(event.target.value)}
        onBlur={() => (description !== draft.description ? update({ description }) : undefined)}
      />
      <Textarea
        aria-label={`Draft ${index + 1} acceptance criteria`}
        rows={3}
        className="font-mono text-xs"
        placeholder="One acceptance criterion per line"
        value={criteria}
        disabled={!editable}
        onChange={(event) => setCriteria(event.target.value)}
        onBlur={() =>
          criteriaList.join('\n') !== draft.acceptanceCriteria.join('\n')
            ? update({ acceptanceCriteria: criteriaList })
            : undefined
        }
      />
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <label className="flex items-center gap-1.5">
          Role
          <select
            className="h-7 rounded-md border bg-transparent px-1.5"
            value={draft.suggestedRole ?? ''}
            disabled={!editable}
            onChange={(event) =>
              update({
                suggestedRole: event.target.value
                  ? PersonaRole.catch('custom').parse(event.target.value)
                  : null,
              })
            }
          >
            <option value="">Any</option>
            {PERSONA_ROLES.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
              </option>
            ))}
          </select>
        </label>
        {draft.estimate ? <span>Estimate: {draft.estimate}</span> : null}
        {dependsOn.length > 0 ? <span>After {dependsOn.join(', ')}</span> : null}
      </div>
    </li>
  );
}

function RequirementDetail({
  requirement,
  projectId,
  editable,
  canPlan,
}: {
  requirement: Requirement;
  projectId: string;
  editable: boolean;
  canPlan: boolean;
}) {
  const { id: workspaceId } = useWorkspace();
  const actions = usePlanningActions(workspaceId, projectId);
  const personas = usePersonas(workspaceId, projectId);
  const planners = personasForProject(personas.data ?? [], projectId).filter(
    (persona) => persona.role === 'planner',
  );
  const [plannerId, setPlannerId] = useState('');
  const pending = requirement.drafts.filter((draft) => draft.status === 'pending');
  const onError = (error: Error) => toast.error(errorMessage(error));
  const status = STATUS_BADGES[requirement.status];

  return (
    <section className="flex min-w-0 flex-1 flex-col gap-4">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{requirement.title}</h2>
        <Badge variant={status.variant}>{status.label}</Badge>
        <span className="text-xs text-muted-foreground">
          updated {formatRelativeTime(requirement.updatedAt)}
        </span>
      </header>
      <p className="rounded-lg bg-muted/50 p-3 text-sm whitespace-pre-wrap">{requirement.body}</p>
      {requirement.status === 'failed' && requirement.error ? (
        <Alert variant="destructive">
          <AlertTitle>The planner did not return a usable plan</AlertTitle>
          <AlertDescription>{requirement.error}</AlertDescription>
        </Alert>
      ) : null}
      {canPlan && requirement.status !== 'approved' ? (
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Planner persona"
            className="h-9 rounded-md border bg-transparent px-2 text-sm"
            value={plannerId}
            onChange={(event) => setPlannerId(event.target.value)}
          >
            <option value="">Default planner</option>
            {planners.map((persona) => (
              <option key={persona.id} value={persona.id}>
                {persona.name}
              </option>
            ))}
          </select>
          <Button
            variant={requirement.drafts.length > 0 ? 'outline' : 'default'}
            disabled={requirement.status === 'planning' || actions.plan.isPending}
            onClick={() =>
              actions.plan.mutate(
                { id: requirement.id, plannerPersonaId: plannerId || undefined },
                { onSuccess: () => toast.success('Planning started (read-only run)'), onError },
              )
            }
          >
            {requirement.status === 'planning' ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Sparkles />
            )}
            {requirement.drafts.length > 0 ? 'Plan again' : 'Plan tickets'}
          </Button>
        </div>
      ) : null}
      {requirement.drafts.length > 0 ? (
        <>
          <ol className="flex flex-col gap-3">
            {requirement.drafts.map((draft, index) => (
              <DraftEditor
                key={draft.id}
                requirement={requirement}
                draft={draft}
                index={index}
                editable={editable && requirement.status === 'review'}
                actions={actions}
              />
            ))}
          </ol>
          {editable && requirement.status === 'review' ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() =>
                  actions.addDraft.mutate(
                    {
                      id: requirement.id,
                      body: {
                        title: 'New ticket',
                        description: '',
                        acceptanceCriteria: [],
                        dependsOn: [],
                      },
                    },
                    { onError },
                  )
                }
              >
                <Plus /> Add draft
              </Button>
              <Button
                disabled={pending.length === 0 || actions.approve.isPending}
                onClick={() =>
                  actions.approve.mutate(
                    { id: requirement.id, body: {} },
                    {
                      onSuccess: (tickets) =>
                        toast.success(`${tickets.length} tickets added to the backlog`),
                      onError,
                    },
                  )
                }
              >
                <Check /> Approve {pending.length} {pending.length === 1 ? 'ticket' : 'tickets'}
              </Button>
            </div>
          ) : null}
        </>
      ) : requirement.status === 'planning' ? (
        <Skeleton className="h-32" />
      ) : null}
    </section>
  );
}

/** Requirements → planner run → draft tickets → human approval (F4). */
export function PlanningPage({ projectId }: { projectId: string }) {
  const { id: workspaceId, role } = useWorkspace();
  const project = useProject(workspaceId, projectId);
  const requirements = useRequirements(workspaceId, projectId);
  const actions = usePlanningActions(workspaceId, projectId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useRealtimeSync(workspaceId, `project:${projectId}`);
  const editable = can(role, 'ticket.manage');
  const selected =
    requirements.data?.find((requirement) => requirement.id === selectedId) ??
    requirements.data?.[0];

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <Link
          href={`/w/${workspaceId}/p/${projectId}`}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:underline"
        >
          <ArrowLeft className="size-4" /> {project.data?.name ?? 'Board'}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">Planning</h1>
        <p className="text-sm text-muted-foreground">
          A planner persona reads the repository and splits a requirement into draft tickets.
          Nothing reaches the board until you approve.
        </p>
      </div>
      {requirements.error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(requirements.error)}
        </p>
      ) : (
        <div className="flex flex-col gap-6 lg:flex-row">
          <aside className="flex w-full flex-col gap-3 lg:w-80">
            {editable ? <NewRequirementForm actions={actions} onCreated={setSelectedId} /> : null}
            {requirements.isPending ? <Skeleton className="h-24" /> : null}
            <ul className="flex flex-col gap-1">
              {(requirements.data ?? []).map((requirement) => (
                <li key={requirement.id}>
                  <button
                    type="button"
                    aria-current={requirement.id === selected?.id ? 'true' : undefined}
                    className={`flex w-full flex-col items-start gap-1 rounded-md px-3 py-2 text-left text-sm hover:bg-accent ${
                      requirement.id === selected?.id ? 'bg-accent' : ''
                    }`}
                    onClick={() => setSelectedId(requirement.id)}
                  >
                    <span className="font-medium">{requirement.title}</span>
                    <Badge variant={STATUS_BADGES[requirement.status].variant}>
                      {STATUS_BADGES[requirement.status].label}
                    </Badge>
                  </button>
                </li>
              ))}
            </ul>
          </aside>
          {selected ? (
            <RequirementDetail
              key={selected.id}
              requirement={selected}
              projectId={projectId}
              editable={editable}
              canPlan={can(role, 'run.control')}
            />
          ) : requirements.data ? (
            <p className="text-sm text-muted-foreground">Write a requirement to start planning.</p>
          ) : null}
        </div>
      )}
    </div>
  );
}
