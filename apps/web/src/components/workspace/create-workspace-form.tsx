'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authClient } from '@/lib/auth-client';
import { queryKeys } from '@/lib/queries/keys';

const WorkspaceValues = z.object({ name: z.string().trim().min(2, 'Use at least 2 characters').max(80) });
type WorkspaceValues = z.infer<typeof WorkspaceValues>;

/** URL-safe slug with a random suffix, so two teams can pick the same display name. */
function workspaceSlug(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'workspace'}-${crypto.randomUUID().slice(0, 6)}`;
}

export function CreateWorkspaceForm() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  const form = useForm<WorkspaceValues>({ resolver: zodResolver(WorkspaceValues), defaultValues: { name: '' } });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async ({ name }) => {
    setFailure(null);
    const created = await authClient.organization.create({ name, slug: workspaceSlug(name) });
    if (created.error || !created.data) {
      setFailure(created.error?.message ?? 'Creating the workspace failed.');
      return;
    }
    const workspaceId = created.data.id;
    const activated = await authClient.organization.setActive({ organizationId: workspaceId });
    if (activated.error) {
      setFailure(activated.error.message ?? 'Switching to the new workspace failed.');
      return;
    }
    await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    router.replace(`/w/${workspaceId}`);
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create a workspace</CardTitle>
        <CardDescription>
          A workspace holds your runners, projects and tickets. You can invite your team afterwards.
        </CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit} noValidate>
        <CardContent className="flex flex-col gap-4">
          {failure ? (
            <Alert variant="destructive">
              <AlertDescription>{failure}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-col gap-2">
            <Label htmlFor="workspace-name">Workspace name</Label>
            <Input
              id="workspace-name"
              placeholder="Acme Engineering"
              aria-invalid={Boolean(errors.name)}
              aria-describedby="workspace-name-error"
              {...form.register('name')}
            />
            {errors.name ? (
              <p id="workspace-name-error" className="text-xs text-destructive">
                {errors.name.message}
              </p>
            ) : null}
          </div>
        </CardContent>
        <CardFooter className="mt-6">
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? 'Creating…' : 'Create workspace'}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
