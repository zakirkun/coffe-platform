'use client';

import { CLI_CATALOG, type Persona } from '@coffe/contracts';
import { AlertTriangle, Archive, Pencil, Plus, UserRound } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useWorkspace } from '@/components/workspace/workspace-context';
import { errorMessage } from '@/lib/api';
import { can } from '@/lib/permissions';
import { describePolicy, ROLE_LABELS } from '@/lib/personas';
import { useArchivePersona, usePersonas } from '@/lib/queries/orchestration';
import { useProjects } from '@/lib/queries/projects';
import { PersonaDialog } from './persona-dialog';

type Editing = { kind: 'new' } | { kind: 'edit'; persona: Persona } | null;

function PersonaCard({
  persona,
  scope,
  onEdit,
}: {
  persona: Persona;
  scope: string;
  onEdit?: () => void;
}) {
  const { id: workspaceId } = useWorkspace();
  const archive = useArchivePersona(workspaceId);
  return (
    <Card className={persona.enabled ? undefined : 'opacity-60'}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserRound className="size-4 text-muted-foreground" />
          {persona.name}
          <Badge variant="outline">{ROLE_LABELS[persona.role]}</Badge>
          {persona.enabled ? null : <Badge variant="secondary">Disabled</Badge>}
        </CardTitle>
        <CardDescription>
          {CLI_CATALOG[persona.cliId]?.name ?? persona.cliId}
          {persona.model ? <span className="font-mono"> · {persona.model}</span> : null} ·{' '}
          {persona.mode === 'pty' ? 'terminal' : 'structured'}
          {persona.driver === 'acp' ? ' · ACP' : null} · {scope}
        </CardDescription>
        {onEdit ? (
          <CardAction className="flex gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Edit ${persona.name}`}
              onClick={onEdit}
            >
              <Pencil />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Archive ${persona.name}`}
              disabled={archive.isPending}
              onClick={() =>
                archive.mutate(persona.id, {
                  onSuccess: () => toast.success(`${persona.name} was archived`),
                  onError: (error) => toast.error(errorMessage(error)),
                })
              }
            >
              <Archive />
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        <p className="text-muted-foreground">{describePolicy(persona.permissions)}</p>
        {persona.instructions ? (
          <p className="line-clamp-3 whitespace-pre-wrap">{persona.instructions}</p>
        ) : null}
        {persona.unenforceable.length > 0 ? (
          <ul
            className="flex flex-col gap-1 text-xs text-warning"
            aria-label="Limits the CLI cannot enforce"
          >
            {persona.unenforceable.map((warning) => (
              <li key={warning} className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                {warning}
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Agent personas of the workspace (F2): who plans, implements, tests and reviews. */
export function PersonasPage() {
  const { id: workspaceId, role } = useWorkspace();
  const personas = usePersonas(workspaceId);
  const projects = useProjects(workspaceId);
  const [editing, setEditing] = useState<Editing>(null);
  const manage = can(role, 'project.manage');
  const projectNames = new Map((projects.data ?? []).map((project) => [project.id, project.name]));

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Personas</h1>
          <p className="text-sm text-muted-foreground">
            Agents with a role, a CLI and model, standing instructions and permission limits.
            Workflows chain them per ticket.
          </p>
        </div>
        {manage ? (
          <Button onClick={() => setEditing({ kind: 'new' })}>
            <Plus /> New persona
          </Button>
        ) : null}
      </div>
      {personas.error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(personas.error)}
        </p>
      ) : personas.isPending ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
        </div>
      ) : personas.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No personas yet. The default Planner, Implementer, Tester and Reviewer are created with
          the first project.
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {personas.data.map((persona) => (
            <PersonaCard
              key={persona.id}
              persona={persona}
              scope={
                persona.projectId
                  ? (projectNames.get(persona.projectId) ?? 'one project')
                  : 'all projects'
              }
              onEdit={manage ? () => setEditing({ kind: 'edit', persona }) : undefined}
            />
          ))}
        </div>
      )}
      {editing ? (
        <PersonaDialog
          persona={editing.kind === 'edit' ? editing.persona : undefined}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}
