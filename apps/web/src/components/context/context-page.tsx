'use client';

import type { ContextDoc } from '@coffe/contracts';
import { ArrowLeft, FileText, Pencil, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useWorkspace } from '@/components/workspace/workspace-context';
import { errorMessage } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import { can } from '@/lib/permissions';
import {
  useContextDocs,
  useContextPreview,
  useDeleteContextDoc,
  useSaveContextDoc,
} from '@/lib/queries/orchestration';
import { useProject } from '@/lib/queries/projects';

type Kind = ContextDoc['kind'];

const KIND_COPY: Record<Kind, { title: string; empty: string; add: string; placeholder: string }> =
  {
    rule: {
      title: 'Rules',
      empty:
        'No project rules yet. Rules are instructions every agent must follow (style, tests, forbidden paths).',
      add: 'Add rule',
      placeholder: 'Run `pnpm lint` before finishing. Never edit files under `generated/`.',
    },
    knowledge: {
      title: 'Knowledge base',
      empty:
        'No knowledge yet. Add architecture notes, domain terms or how-tos the agents should know.',
      add: 'Add knowledge',
      placeholder: '## Payments\nInvoices are immutable once issued; corrections are credit notes.',
    },
  };

type Editing = { kind: Kind; doc?: ContextDoc } | null;

function DocDialog({
  projectId,
  editing,
  onClose,
}: {
  projectId: string;
  editing: NonNullable<Editing>;
  onClose: () => void;
}) {
  const { id: workspaceId } = useWorkspace();
  const save = useSaveContextDoc(workspaceId, projectId);
  const [title, setTitle] = useState(editing.doc?.title ?? '');
  const [body, setBody] = useState(editing.doc?.body ?? '');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const callbacks = {
      onSuccess: () => {
        toast.success('Saved; the next run receives it');
        onClose();
      },
      onError: (error: Error) => toast.error(errorMessage(error)),
    };
    if (editing.doc)
      save.mutate({ id: editing.doc.id, body: { title: title.trim(), body } }, callbacks);
    else
      save.mutate(
        { body: { kind: editing.kind, title: title.trim(), body, enabled: true } },
        callbacks,
      );
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {editing.doc ? `Edit ${editing.doc.title}` : KIND_COPY[editing.kind].add}
          </DialogTitle>
          <DialogDescription>
            Markdown. Sent to every run of this project as part of its context bundle.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="context-title">Title</Label>
            <Input
              id="context-title"
              required
              maxLength={200}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="context-body">Content</Label>
            <Textarea
              id="context-body"
              rows={14}
              className="font-mono text-xs"
              placeholder={KIND_COPY[editing.kind].placeholder}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending || title.trim() === ''}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DocList({
  projectId,
  kind,
  docs,
  manage,
  onEdit,
}: {
  projectId: string;
  kind: Kind;
  docs: ContextDoc[];
  manage: boolean;
  onEdit: (editing: NonNullable<Editing>) => void;
}) {
  const { id: workspaceId } = useWorkspace();
  const save = useSaveContextDoc(workspaceId, projectId);
  const remove = useDeleteContextDoc(workspaceId, projectId);
  const onError = (error: Error) => toast.error(errorMessage(error));

  return (
    <div className="flex flex-col gap-3">
      {manage ? (
        <Button variant="outline" className="self-start" onClick={() => onEdit({ kind })}>
          <Plus /> {KIND_COPY[kind].add}
        </Button>
      ) : null}
      {docs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{KIND_COPY[kind].empty}</p>
      ) : null}
      {docs.map((doc) => (
        <article
          key={doc.id}
          className={`flex flex-col gap-2 rounded-lg border p-4 ${doc.enabled ? '' : 'opacity-60'}`}
        >
          <header className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium">{doc.title}</h3>
            {doc.enabled ? null : <Badge variant="secondary">Disabled</Badge>}
            <span className="text-xs text-muted-foreground">
              updated {formatRelativeTime(doc.updatedAt)}
            </span>
            {manage ? (
              <span className="ml-auto flex items-center gap-1">
                <label className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={doc.enabled}
                    onChange={(event) =>
                      save.mutate(
                        { id: doc.id, body: { enabled: event.target.checked } },
                        { onError },
                      )
                    }
                  />
                  Enabled
                </label>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Edit ${doc.title}`}
                  onClick={() => onEdit({ kind, doc })}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${doc.title}`}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(doc.id, { onError })}
                >
                  <Trash2 />
                </Button>
              </span>
            ) : null}
          </header>
          <pre className="max-h-48 overflow-auto rounded-md bg-muted/50 p-3 font-mono text-xs whitespace-pre-wrap">
            {doc.body || '(empty)'}
          </pre>
        </article>
      ))}
    </div>
  );
}

function BundlePreview({ projectId, active }: { projectId: string; active: boolean }) {
  const { id: workspaceId } = useWorkspace();
  const preview = useContextPreview(workspaceId, projectId, active);
  if (preview.error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {errorMessage(preview.error)}
      </p>
    );
  }
  if (!preview.data) return <Skeleton className="h-48" />;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        What a run receives in <code className="font-mono">.coffe/context/</code> before the ticket
        and persona files are added ({(preview.data.totalBytes / 1024).toFixed(1)} KiB).
      </p>
      {preview.data.files.map((file) => (
        <details key={file.name} className="rounded-lg border" open={file.name.startsWith('10-')}>
          <summary className="flex cursor-pointer items-center gap-2 p-3 font-mono text-sm">
            <FileText className="size-4 text-muted-foreground" />
            {file.name}
            <span className="ml-auto text-xs text-muted-foreground">
              {file.content.length.toLocaleString()} chars
            </span>
          </summary>
          <pre className="max-h-96 overflow-auto border-t p-3 font-mono text-xs whitespace-pre-wrap">
            {file.content}
          </pre>
        </details>
      ))}
    </div>
  );
}

/** Project rules and knowledge base (F3), plus the exact bundle runs receive. */
export function ContextPage({ projectId }: { projectId: string }) {
  const { id: workspaceId, role } = useWorkspace();
  const project = useProject(workspaceId, projectId);
  const docs = useContextDocs(workspaceId, projectId);
  const [tab, setTab] = useState('rule');
  const [editing, setEditing] = useState<Editing>(null);
  const manage = can(role, 'project.manage');

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <Link
          href={`/w/${workspaceId}/p/${projectId}`}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:underline"
        >
          <ArrowLeft className="size-4" /> {project.data?.name ?? 'Board'}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">Project context</h1>
        <p className="text-sm text-muted-foreground">
          Rules and knowledge every agent of this project receives with its run.
        </p>
      </div>
      {docs.error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(docs.error)}
        </p>
      ) : (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="rule">Rules</TabsTrigger>
            <TabsTrigger value="knowledge">Knowledge</TabsTrigger>
            <TabsTrigger value="preview">Bundle preview</TabsTrigger>
          </TabsList>
          {(['rule', 'knowledge'] as const).map((kind) => (
            <TabsContent key={kind} value={kind} className="pt-4">
              {docs.isPending ? (
                <Skeleton className="h-32" />
              ) : (
                <DocList
                  projectId={projectId}
                  kind={kind}
                  docs={docs.data.filter((doc) => doc.kind === kind)}
                  manage={manage}
                  onEdit={setEditing}
                />
              )}
            </TabsContent>
          ))}
          <TabsContent value="preview" className="pt-4">
            <BundlePreview projectId={projectId} active={tab === 'preview'} />
          </TabsContent>
        </Tabs>
      )}
      {editing ? (
        <DocDialog projectId={projectId} editing={editing} onClose={() => setEditing(null)} />
      ) : null}
    </div>
  );
}
