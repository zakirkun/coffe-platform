'use client';

import type { Persona, Workflow, WorkflowStep } from '@coffe/contracts';
import { ArrowDown, ArrowLeft, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useWorkspace } from '@/components/workspace/workspace-context';
import { errorMessage } from '@/lib/api';
import { can } from '@/lib/permissions';
import { personasForProject, ROLE_LABELS } from '@/lib/personas';
import { usePersonas, useSaveWorkflow, useWorkflows } from '@/lib/queries/orchestration';
import { useProject } from '@/lib/queries/projects';

const NEW_STEP: WorkflowStep = {
  key: '',
  name: '',
  personaIds: [],
  parallel: false,
  onFail: 'stop',
  maxLoops: 2,
};

/** `implement`, `review-2`: a lowercase key the step can be addressed by in `goto:`. */
function stepKey(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/^[^a-z]+/, '')
      .slice(0, 30) || 'step';
  let key = base;
  for (let suffix = 2; taken.includes(key); suffix++) key = `${base}-${suffix}`;
  return key;
}

function WorkflowDialog({
  projectId,
  workflow,
  personas,
  onClose,
}: {
  projectId: string;
  workflow?: Workflow;
  personas: Persona[];
  onClose: () => void;
}) {
  const { id: workspaceId } = useWorkspace();
  const save = useSaveWorkflow(workspaceId, projectId);
  const [name, setName] = useState(workflow?.name ?? '');
  const [isDefault, setIsDefault] = useState(workflow?.isDefault ?? false);
  const [steps, setSteps] = useState<WorkflowStep[]>(
    workflow?.steps ?? [{ ...NEW_STEP, key: 'implement', name: 'Implement' }],
  );

  const patchStep = (index: number, patch: Partial<WorkflowStep>) =>
    setSteps((current) => current.map((step, at) => (at === index ? { ...step, ...patch } : step)));
  // Saved steps keep their key (running workflows refer to it); new steps take theirs from the name.
  const savedKeys = new Set(workflow?.steps.map((step) => step.key));
  const renameStep = (index: number, name: string) =>
    setSteps((current) => {
      const renamed = current[index];
      if (!renamed) return current;
      const key = savedKeys.has(renamed.key)
        ? renamed.key
        : stepKey(
            name,
            current.filter((_, at) => at !== index).map((other) => other.key),
          );
      return current.map((step, at) => {
        if (at === index) return { ...step, name, key };
        return step.onFail === `goto:${renamed.key}` ? { ...step, onFail: `goto:${key}` } : step;
      });
    });
  const moveStep = (index: number, by: -1 | 1) =>
    setSteps((current) => {
      const next = [...current];
      const [step] = next.splice(index, 1);
      if (step) next.splice(index + by, 0, step);
      return next;
    });
  const togglePersona = (index: number, personaId: string, checked: boolean) => {
    const step = steps[index];
    if (!step) return;
    const personaIds = checked
      ? [...step.personaIds, personaId]
      : step.personaIds.filter((id) => id !== personaId);
    patchStep(index, { personaIds, parallel: personaIds.length > 1 });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body = { name: name.trim(), isDefault, steps };
    const callbacks = {
      onSuccess: () => {
        toast.success('Workflow saved');
        onClose();
      },
      onError: (error: Error) => toast.error(errorMessage(error)),
    };
    if (workflow) save.mutate({ id: workflow.id, body }, callbacks);
    else save.mutate({ body }, callbacks);
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{workflow ? `Edit ${workflow.name}` : 'New workflow'}</DialogTitle>
          <DialogDescription>
            Steps run in order in the ticket&apos;s worktree; each hands its summary to the next.
            Several read-only personas in one step run in parallel. A failed review or test can loop
            back to an earlier step.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex min-w-60 flex-1 flex-col gap-1.5">
              <Label htmlFor="workflow-name">Name</Label>
              <Input
                id="workflow-name"
                required
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input
                type="checkbox"
                checked={isDefault}
                onChange={(event) => setIsDefault(event.target.checked)}
              />
              Default for new tickets
            </label>
          </div>
          <ol className="flex flex-col gap-3">
            {steps.map((step, index) => {
              const earlier = steps.slice(0, index);
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: a new step's key follows its name while typing; the row position is its stable identity
                <li key={index} className="flex flex-col gap-3 rounded-lg border p-3">
                  <div className="flex flex-wrap items-end gap-3">
                    <span className="pb-2 font-mono text-xs text-muted-foreground">
                      {index + 1}.
                    </span>
                    <div className="flex min-w-48 flex-1 flex-col gap-1.5">
                      <Label htmlFor={`step-name-${index}`}>Step</Label>
                      <Input
                        id={`step-name-${index}`}
                        required
                        maxLength={80}
                        value={step.name}
                        onChange={(event) => renameStep(index, event.target.value)}
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`step-fail-${index}`}>When it fails</Label>
                      <select
                        id={`step-fail-${index}`}
                        className="h-9 rounded-md border bg-transparent px-2 text-sm"
                        value={step.onFail}
                        onChange={(event) => patchStep(index, { onFail: event.target.value })}
                      >
                        <option value="stop">Stop the workflow</option>
                        {earlier.map((target) => (
                          <option key={target.key} value={`goto:${target.key}`}>
                            Back to {target.name || target.key}
                          </option>
                        ))}
                      </select>
                    </div>
                    {step.onFail.startsWith('goto:') ? (
                      <div className="flex w-24 flex-col gap-1.5">
                        <Label htmlFor={`step-loops-${index}`}>Max loops</Label>
                        <Input
                          id={`step-loops-${index}`}
                          type="number"
                          min={0}
                          max={10}
                          value={step.maxLoops}
                          onChange={(event) =>
                            patchStep(index, { maxLoops: Number(event.target.value) || 0 })
                          }
                        />
                      </div>
                    ) : null}
                    <div className="flex gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Move up"
                        disabled={index === 0}
                        onClick={() => moveStep(index, -1)}
                      >
                        <ArrowUp />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Move down"
                        disabled={index === steps.length - 1}
                        onClick={() => moveStep(index, 1)}
                      >
                        <ArrowDown />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${step.name || 'step'}`}
                        disabled={steps.length === 1}
                        onClick={() =>
                          setSteps((current) => current.filter((_, at) => at !== index))
                        }
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                  <fieldset className="flex flex-wrap gap-x-4 gap-y-1.5">
                    <legend className="mb-1 text-xs text-muted-foreground">
                      Personas{' '}
                      {step.personaIds.length > 1 ? '(run in parallel; all must be read-only)' : ''}
                    </legend>
                    {personas.map((persona) => (
                      <label key={persona.id} className="flex items-center gap-1.5 text-sm">
                        <input
                          type="checkbox"
                          checked={step.personaIds.includes(persona.id)}
                          onChange={(event) =>
                            togglePersona(index, persona.id, event.target.checked)
                          }
                        />
                        {persona.name}
                        <span className="text-xs text-muted-foreground">
                          {ROLE_LABELS[persona.role]}
                        </span>
                      </label>
                    ))}
                  </fieldset>
                </li>
              );
            })}
          </ol>
          <Button
            type="button"
            variant="outline"
            className="self-start"
            disabled={steps.length >= 12}
            onClick={() =>
              setSteps((current) => [
                ...current,
                {
                  ...NEW_STEP,
                  key: stepKey(
                    'step',
                    current.map((step) => step.key),
                  ),
                },
              ])
            }
          >
            <Plus /> Add step
          </Button>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                save.isPending ||
                name.trim() === '' ||
                steps.some((step) => step.personaIds.length === 0 || step.name.trim() === '')
              }
            >
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The workflows of a project (F1): which personas work on a ticket, in which order. */
export function WorkflowsPage({ projectId }: { projectId: string }) {
  const { id: workspaceId, role } = useWorkspace();
  const project = useProject(workspaceId, projectId);
  const workflows = useWorkflows(workspaceId, projectId);
  const personas = usePersonas(workspaceId, projectId);
  const [editing, setEditing] = useState<{ workflow?: Workflow } | null>(null);
  const manage = can(role, 'project.manage');
  const available = personasForProject(personas.data ?? [], projectId);
  const personaName = (id: string) =>
    personas.data?.find((persona) => persona.id === id)?.name ?? 'archived persona';

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link
            href={`/w/${workspaceId}/p/${projectId}`}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:underline"
          >
            <ArrowLeft className="size-4" /> {project.data?.name ?? 'Board'}
          </Link>
          <h1 className="text-xl font-semibold tracking-tight">Workflows</h1>
          <p className="text-sm text-muted-foreground">
            Handoffs between personas when a ticket starts: implement, test, review, loop.
          </p>
        </div>
        {manage ? (
          <Button onClick={() => setEditing({})} disabled={available.length === 0}>
            <Plus /> New workflow
          </Button>
        ) : null}
      </div>
      {workflows.error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(workflows.error)}
        </p>
      ) : workflows.isPending ? (
        <Skeleton className="h-40" />
      ) : workflows.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No workflow yet; a ticket started without one runs its assignee alone.
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {workflows.data.map((workflow) => (
            <Card key={workflow.id}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {workflow.name}
                  {workflow.isDefault ? <Badge variant="secondary">Default</Badge> : null}
                  {workflow.projectId === null ? <Badge variant="outline">Workspace</Badge> : null}
                </CardTitle>
                {manage ? (
                  <CardAction>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Edit ${workflow.name}`}
                      onClick={() => setEditing({ workflow })}
                    >
                      <Pencil />
                    </Button>
                  </CardAction>
                ) : null}
              </CardHeader>
              <CardContent>
                <ol className="flex flex-col gap-2 text-sm">
                  {workflow.steps.map((step, index) => (
                    <li key={step.key} className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">{index + 1}.</span>
                      <span className="font-medium">{step.name}</span>
                      <span className="text-muted-foreground">
                        {step.personaIds.map(personaName).join(step.parallel ? ' ∥ ' : ', ')}
                      </span>
                      {step.onFail.startsWith('goto:') ? (
                        <Badge variant="outline">
                          fail →{' '}
                          {workflow.steps.find((target) => `goto:${target.key}` === step.onFail)
                            ?.name ?? step.onFail.slice(5)}{' '}
                          (max {step.maxLoops})
                        </Badge>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {editing ? (
        <WorkflowDialog
          projectId={projectId}
          workflow={editing.workflow}
          personas={available}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}
