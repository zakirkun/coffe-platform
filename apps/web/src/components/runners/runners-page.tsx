'use client';

import type { Runner, RunnerStatus } from '@coffe/contracts';
import { FolderGit2, RefreshCw, Server, ShieldOff, TerminalSquare } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useWorkspace } from '@/components/workspace/workspace-context';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import { can } from '@/lib/permissions';
import { useDetectClis, useRevokeRunner, useRunners } from '@/lib/queries/runners';
import { PairRunnerDialog } from './pair-runner-dialog';

const STATUS_BADGES: Record<RunnerStatus, { label: string; variant: BadgeVariant }> = {
  online: { label: 'Online', variant: 'success' },
  offline: { label: 'Offline', variant: 'secondary' },
  revoked: { label: 'Revoked', variant: 'destructive' },
};

function RevokeDialog({ runner, onClose }: { runner: Runner; onClose: () => void }) {
  const { id: workspaceId } = useWorkspace();
  const revoke = useRevokeRunner(workspaceId);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke {runner.name}?</DialogTitle>
          <DialogDescription>
            The runner is disconnected at once and its token stops working. Running agents on it are
            interrupted. To use the machine again, pair it anew.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={revoke.isPending}
            onClick={() =>
              revoke.mutate(runner.id, {
                onSuccess: () => {
                  toast.success(`${runner.name} was revoked`);
                  onClose();
                },
                onError: (error) => toast.error(errorMessage(error)),
              })
            }
          >
            Revoke runner
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RunnerCard({ runner }: { runner: Runner }) {
  const { id: workspaceId, role } = useWorkspace();
  const detect = useDetectClis(workspaceId);
  const [revoking, setRevoking] = useState(false);
  const badge = STATUS_BADGES[runner.status];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Server className="size-4 text-muted-foreground" />
          {runner.name}
          <Badge data-testid="runner-status" variant={badge.variant}>
            {badge.label}
          </Badge>
          {runner.needsUpdate ? <Badge variant="warning">Update required</Badge> : null}
        </CardTitle>
        <CardDescription>
          {runner.hostname} · {runner.os}/{runner.arch} · v{runner.runnerVersion}
          {runner.lastSeenAt ? ` · seen ${formatRelativeTime(runner.lastSeenAt)}` : ''}
          {runner.status === 'online' ? ` · ${runner.runningRuns}/${runner.maxConcurrentRuns} runs` : ''}
        </CardDescription>
        {runner.status !== 'revoked' ? (
          <CardAction className="flex gap-2">
            {can(role, 'runner.manage') ? (
              <Button
                variant="outline"
                size="sm"
                disabled={runner.status !== 'online' || detect.isPending}
                onClick={() =>
                  detect.mutate(runner.id, {
                    onSuccess: () => toast.info('Detection started; results arrive in a few seconds.'),
                    onError: (error) => toast.error(errorMessage(error)),
                  })
                }
              >
                <RefreshCw /> Detect CLIs
              </Button>
            ) : null}
            {can(role, 'runner.revoke') ? (
              <Button variant="outline" size="sm" onClick={() => setRevoking(true)}>
                <ShieldOff /> Revoke
              </Button>
            ) : null}
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="grid gap-6 text-sm md:grid-cols-2">
        <section aria-label={`Agent CLIs on ${runner.name}`}>
          <h3 className="mb-2 flex items-center gap-1.5 font-medium">
            <TerminalSquare className="size-4 text-muted-foreground" /> Agent CLIs
          </h3>
          {runner.clis.length === 0 ? (
            <p className="text-muted-foreground">No supported CLI detected.</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {runner.clis.map((cli) => (
                <li key={cli.cliId}>
                  <Badge variant={cli.authStatus === 'ok' ? 'outline' : 'warning'} title={`${cli.path} · auth ${cli.authStatus}`}>
                    {cli.name}
                    {cli.version ? ` ${cli.version}` : ''}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-label={`Repositories on ${runner.name}`}>
          <h3 className="mb-2 flex items-center gap-1.5 font-medium">
            <FolderGit2 className="size-4 text-muted-foreground" /> Repositories
          </h3>
          {runner.repos.length === 0 ? (
            <p className="text-muted-foreground">
              None registered. Run <code className="font-mono">coffe-runner repo add &lt;path&gt;</code> on the machine.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {runner.repos.map((repo) => (
                <li key={repo.id} className="flex items-baseline gap-2">
                  <span className={repo.available ? 'font-medium' : 'font-medium text-muted-foreground line-through'}>{repo.name}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground" title={repo.path}>
                    {repo.path}
                  </span>
                  {repo.defaultBranch ? <Badge variant="secondary">{repo.defaultBranch}</Badge> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
        <p className="font-mono text-xs text-muted-foreground md:col-span-2" title="Compare with `coffe-runner status` on the machine">
          Fingerprint {runner.fingerprint}
        </p>
      </CardContent>
      {revoking ? <RevokeDialog runner={runner} onClose={() => setRevoking(false)} /> : null}
    </Card>
  );
}

export function RunnersPage() {
  const { id: workspaceId, role } = useWorkspace();
  const runners = useRunners(workspaceId);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Runners</h1>
          <p className="text-sm text-muted-foreground">
            Machines that run agent CLIs on your repositories. Code and secrets never leave them.
          </p>
        </div>
        {can(role, 'runner.manage') ? <PairRunnerDialog workspaceId={workspaceId} /> : null}
      </div>
      {runners.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : runners.error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(runners.error)}
        </p>
      ) : runners.data.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No runner yet. Pair one to start running agents.
          </CardContent>
        </Card>
      ) : (
        runners.data
          .toSorted((a, b) => Number(a.status === 'revoked') - Number(b.status === 'revoked') || a.name.localeCompare(b.name))
          .map((runner) => <RunnerCard key={runner.id} runner={runner} />)
      )}
    </div>
  );
}
