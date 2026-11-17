'use client';

import type { AuditLogEntry } from '@coffe/contracts';
import { useWorkspace } from '@/components/workspace/workspace-context';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useAuditLog } from '@/lib/queries/audit';

const ACTOR_BADGES: Record<AuditLogEntry['actorType'], BadgeVariant> = {
  user: 'outline',
  runner: 'secondary',
  agent: 'info',
  system: 'secondary',
};

function actorLabel(entry: AuditLogEntry): string {
  if (entry.actorType === 'user') return entry.actorName ?? 'user';
  if (entry.actorType === 'agent') return entry.personaId ? 'agent (persona)' : 'agent';
  return entry.actorType;
}

export function AuditPage() {
  const { id: workspaceId } = useWorkspace();
  const audit = useAuditLog(workspaceId);
  const entries = audit.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Audit log</h1>
        <p className="text-sm text-muted-foreground">
          Every action by people, runners and agents in this workspace, newest first. Entries cannot be edited.
        </p>
      </div>
      {audit.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : audit.error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(audit.error)}
        </p>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-44">Time</TableHead>
                  <TableHead className="w-40">Actor</TableHead>
                  <TableHead className="w-48">Action</TableHead>
                  <TableHead>Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                      Nothing recorded yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  entries.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="text-xs whitespace-nowrap text-muted-foreground">{formatDateTime(entry.ts)}</TableCell>
                      <TableCell>
                        <Badge variant={ACTOR_BADGES[entry.actorType]}>{actorLabel(entry)}</Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{entry.action}</TableCell>
                      <TableCell className="max-w-0 text-xs">
                        {entry.command ? (
                          <code className="block truncate font-mono" title={entry.command}>
                            {entry.command}
                          </code>
                        ) : null}
                        {entry.targetType ? (
                          <span className="text-muted-foreground">
                            {entry.targetType}
                            {entry.targetId ? ` ${entry.targetId.slice(0, 8)}` : ''}
                          </span>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      {audit.hasNextPage ? (
        <Button variant="outline" className="self-center" disabled={audit.isFetchingNextPage} onClick={() => void audit.fetchNextPage()}>
          {audit.isFetchingNextPage ? 'Loading…' : 'Load older entries'}
        </Button>
      ) : null}
    </div>
  );
}
