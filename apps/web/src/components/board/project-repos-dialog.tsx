'use client';

import { FolderGit2, Star, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useWorkspace } from '@/components/workspace/workspace-context';
import { errorMessage } from '@/lib/api';
import { useBindRepo, useProjectRepos, useUnbindRepo } from '@/lib/queries/projects';
import { useRunners } from '@/lib/queries/runners';

/**
 * The repositories of a project on every runner (F18b). The same repository cloned on several
 * runners lets the scheduler spread tickets over them; the primary binding is preferred.
 */
export function ProjectReposDialog({ projectId }: { projectId: string }) {
  const { id: workspaceId } = useWorkspace();
  const bindings = useProjectRepos(workspaceId, projectId);
  const runners = useRunners(workspaceId);
  const bind = useBindRepo(workspaceId, projectId);
  const unbind = useUnbindRepo(workspaceId, projectId);
  const [runnerRepoId, setRunnerRepoId] = useState('');

  const bound = new Set((bindings.data ?? []).map((binding) => binding.repo.id));
  const available = (runners.data ?? [])
    .filter((runner) => runner.status !== 'revoked')
    .flatMap((runner) => runner.repos.map((repo) => ({ repo, runnerName: runner.name })))
    .filter(({ repo }) => !bound.has(repo.id));

  const add = () =>
    bind.mutate(
      { runnerRepoId },
      {
        onSuccess: (binding) => {
          toast.success(`${binding.repo.name} on ${binding.runnerName} was added`);
          setRunnerRepoId('');
        },
        onError: (error) => toast.error(errorMessage(error)),
      },
    );

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">
          <FolderGit2 /> Repositories
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Repositories and runners</DialogTitle>
          <DialogDescription>
            Runs are scheduled on an online runner that has the repository and the persona&apos;s
            CLI. A ticket stays on the runner that holds its worktree.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col divide-y rounded-lg border">
          {(bindings.data ?? []).map((binding) => (
            <li key={binding.id} className="flex items-center gap-3 p-3 text-sm">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2 font-medium">
                  {binding.repo.name}
                  {binding.isPrimary ? <Badge variant="secondary">Primary</Badge> : null}
                </span>
                <span
                  className="truncate font-mono text-xs text-muted-foreground"
                  title={binding.repo.path}
                >
                  {binding.runnerName} · {binding.repo.path}
                </span>
              </div>
              <Badge variant={binding.runnerStatus === 'online' ? 'success' : 'secondary'}>
                {binding.runnerStatus}
              </Badge>
              {binding.isPrimary ? null : (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Make ${binding.repo.name} on ${binding.runnerName} primary`}
                  disabled={bind.isPending}
                  onClick={() =>
                    bind.mutate(
                      { runnerRepoId: binding.repo.id, isPrimary: true },
                      { onError: (error) => toast.error(errorMessage(error)) },
                    )
                  }
                >
                  <Star />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${binding.repo.name} on ${binding.runnerName}`}
                disabled={unbind.isPending}
                onClick={() =>
                  unbind.mutate(binding.id, {
                    onError: (error) => toast.error(errorMessage(error)),
                  })
                }
              >
                <Trash2 />
              </Button>
            </li>
          ))}
          {bindings.data?.length === 0 ? (
            <li className="p-3 text-sm text-muted-foreground">No repository bound yet.</li>
          ) : null}
        </ul>
        <div className="flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor="project-add-repo">Add a repository</Label>
            <Select
              value={runnerRepoId}
              onValueChange={setRunnerRepoId}
              disabled={available.length === 0}
            >
              <SelectTrigger id="project-add-repo" className="w-full">
                <SelectValue
                  placeholder={
                    available.length === 0
                      ? 'Every registered repository is bound'
                      : 'Choose a repository'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {available.map(({ repo, runnerName }) => (
                  <SelectItem key={repo.id} value={repo.id}>
                    {repo.name} · {runnerName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button disabled={runnerRepoId === '' || bind.isPending} onClick={add}>
            Add
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
