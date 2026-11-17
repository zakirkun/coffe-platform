'use client';

import Link from 'next/link';
import { useWorkspace } from '@/components/workspace/workspace-context';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage } from '@/lib/api';
import { can } from '@/lib/permissions';
import { useProjects } from '@/lib/queries/projects';
import { NewProjectDialog } from './new-project-dialog';

export function ProjectsPage() {
  const { id: workspaceId, role } = useWorkspace();
  const projects = useProjects(workspaceId);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Projects</h1>
          <p className="text-sm text-muted-foreground">Each project has its own board, context and repositories.</p>
        </div>
        {can(role, 'project.manage') ? <NewProjectDialog /> : null}
      </div>
      {projects.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : projects.error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(projects.error)}
        </p>
      ) : projects.data.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No project yet. Pair a runner, register a repository and create the first project.
          </CardContent>
        </Card>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {projects.data.map((project) => (
            <li key={project.id}>
              <Link href={`/w/${workspaceId}/p/${project.id}`} className="block rounded-xl focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
                <Card className="h-full transition-colors hover:bg-accent/40">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      {project.name}
                      <Badge variant="outline" className="font-mono">
                        {project.key}
                      </Badge>
                    </CardTitle>
                    {project.description ? (
                      <CardDescription className="line-clamp-2">{project.description}</CardDescription>
                    ) : null}
                  </CardHeader>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
