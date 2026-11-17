'use client';

import { ProjectKey } from '@coffe/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { useWorkspace } from '@/components/workspace/workspace-context';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/lib/api';
import { suggestProjectKey } from '@/lib/project-key';
import { useCreateProject } from '@/lib/queries/projects';
import { useRunners } from '@/lib/queries/runners';

const ProjectValues = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(100),
  key: ProjectKey,
  description: z.string().max(10_000),
  runnerRepoId: z.string(),
});
type ProjectValues = z.infer<typeof ProjectValues>;

export function NewProjectDialog() {
  const { id: workspaceId } = useWorkspace();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const runners = useRunners(workspaceId);
  const createProject = useCreateProject(workspaceId);
  const form = useForm<ProjectValues>({
    resolver: zodResolver(ProjectValues),
    defaultValues: { name: '', key: '', description: '', runnerRepoId: '' },
  });
  const { errors, isSubmitting, dirtyFields } = form.formState;

  const repos = (runners.data ?? [])
    .filter((runner) => runner.status !== 'revoked')
    .flatMap((runner) => runner.repos.filter((repo) => repo.available).map((repo) => ({ repo, runner })));

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const project = await createProject.mutateAsync({
        name: values.name,
        key: values.key,
        description: values.description || undefined,
        runnerRepoId: values.runnerRepoId || undefined,
      });
      setOpen(false);
      form.reset();
      router.push(`/w/${workspaceId}/p/${project.id}`);
    } catch {
      // Rendered from `createProject.error`.
    }
  });

  const nameField = form.register('name');

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          form.reset();
          createProject.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>New project</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>A project groups tickets for one product, usually one repository.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
          {createProject.error ? (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(createProject.error)}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-col gap-2">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              placeholder="Customer Portal"
              aria-invalid={Boolean(errors.name)}
              {...nameField}
              onChange={(event) => {
                void nameField.onChange(event);
                // Suggest a key until the user types their own.
                if (!dirtyFields.key) form.setValue('key', suggestProjectKey(event.target.value));
              }}
            />
            {errors.name ? <p className="text-xs text-destructive">{errors.name.message}</p> : null}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="project-key">Key</Label>
            <Input
              id="project-key"
              placeholder="CP"
              className="font-mono uppercase"
              aria-describedby="project-key-hint"
              aria-invalid={Boolean(errors.key)}
              {...form.register('key', { setValueAs: (value: string) => value.toUpperCase() })}
            />
            <p id="project-key-hint" className={errors.key ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
              {errors.key ? '2–6 uppercase letters or digits, starting with a letter.' : 'Prefix of ticket keys, e.g. CP-12.'}
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="project-description">Description</Label>
            <Textarea id="project-description" rows={3} {...form.register('description')} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="project-repo">Repository</Label>
            <Controller
              control={form.control}
              name="runnerRepoId"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="project-repo" aria-label="Repository" className="w-full">
                    <SelectValue placeholder={repos.length ? 'Choose a repository' : 'No repository registered yet'} />
                  </SelectTrigger>
                  <SelectContent>
                    {repos.map(({ repo, runner }) => (
                      <SelectItem key={repo.id} value={repo.id}>
                        {repo.name} · {runner.name}
                        {runner.status === 'online' ? '' : ' (offline)'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            <p className="text-xs text-muted-foreground">
              Repositories are registered on a runner with <code className="font-mono">coffe-runner repo add</code>.
            </p>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Creating…' : 'Create project'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
