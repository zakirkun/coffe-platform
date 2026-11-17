'use client';

import { useQueryClient } from '@tanstack/react-query';
import { BarChart3, Check, ChevronsUpDown, FolderKanban, LogOut, Plus, ScrollText, Server, UsersRound } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useMemo } from 'react';
import { FullPageSpinner } from '@/components/full-page-spinner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ApiRequestError } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import { cn } from '@/lib/utils';
import { queryKeys } from '@/lib/queries/keys';
import { useMe } from '@/lib/queries/session';
import { useRealtimeSync } from '@/lib/queries/realtime-sync';
import { useConnectionState } from '@/lib/realtime';
import { type CurrentWorkspace, WorkspaceContext } from './workspace-context';

const NAVIGATION = [
  { segment: 'projects', label: 'Projects', icon: FolderKanban },
  { segment: 'personas', label: 'Personas', icon: UsersRound },
  { segment: 'runners', label: 'Runners', icon: Server },
  { segment: 'usage', label: 'Usage', icon: BarChart3 },
  { segment: 'audit', label: 'Audit log', icon: ScrollText },
] as const;

const CONNECTION_LABELS = {
  idle: 'Offline',
  connecting: 'Connecting…',
  open: 'Live',
  reconnecting: 'Reconnecting…',
} as const;

function ConnectionIndicator() {
  const state = useConnectionState();
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground" title="Realtime connection">
      <span
        aria-hidden
        className={cn(
          'inline-block size-2 rounded-full',
          state === 'open' ? 'bg-success' : state === 'idle' ? 'bg-muted-foreground/40' : 'animate-pulse bg-warning',
        )}
      />
      {CONNECTION_LABELS[state]}
    </span>
  );
}

export function WorkspaceShell({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const me = useMe();
  const signedOut = me.error instanceof ApiRequestError && me.error.status === 401;

  useEffect(() => {
    if (signedOut) router.replace(`/sign-in?next=${encodeURIComponent(pathname)}`);
  }, [signedOut, pathname, router]);

  const summary = me.data?.workspaces.find((workspace) => workspace.id === workspaceId);
  const workspace = useMemo<CurrentWorkspace | null>(
    () => (summary ? { id: summary.id, name: summary.name, role: summary.role } : null),
    [summary],
  );
  // Workspace-wide events (runner status, …) keep the caches current on every page.
  useRealtimeSync(workspaceId, workspace ? `workspace:${workspaceId}` : null);

  if (!me.data || signedOut) return <FullPageSpinner error={signedOut ? null : me.error} />;
  if (!workspace) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-sm text-muted-foreground">You are not a member of this workspace.</p>
        <Button asChild variant="outline">
          <Link href="/">Go to my workspaces</Link>
        </Button>
      </main>
    );
  }

  const switchWorkspace = async (id: string) => {
    await authClient.organization.setActive({ organizationId: id });
    await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    router.push(`/w/${id}`);
  };
  const signOut = async () => {
    await authClient.signOut();
    queryClient.clear();
    router.replace('/sign-in');
  };

  return (
    <WorkspaceContext.Provider value={workspace}>
      <div className="flex min-h-dvh">
        <aside className="hidden w-56 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground md:flex">
          <div className="flex h-14 items-center gap-2 border-b px-4 font-semibold tracking-tight">
            <span aria-hidden className="inline-block size-5 rounded-md bg-primary" />
            COFFE
          </div>
          <nav aria-label="Workspace" className="flex flex-col gap-1 p-2">
            {NAVIGATION.map(({ segment, label, icon: Icon }) => {
              const href = `/w/${workspaceId}/${segment}`;
              const active =
                pathname.startsWith(href) ||
                (segment === 'projects' && (pathname.includes(`/w/${workspaceId}/p/`) || pathname.includes(`/w/${workspaceId}/t/`)));
              return (
                <Link
                  key={segment}
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                    active && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground',
                  )}
                >
                  <Icon className="size-4" />
                  {label}
                </Link>
              );
            })}
          </nav>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 items-center justify-between gap-4 border-b px-4">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="gap-2 px-2 font-medium">
                  {workspace.name}
                  <ChevronsUpDown className="size-4 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
                {me.data.workspaces.map((candidate) => (
                  <DropdownMenuItem key={candidate.id} onSelect={() => void switchWorkspace(candidate.id)}>
                    <span className="flex-1 truncate">{candidate.name}</span>
                    {candidate.id === workspaceId ? <Check className="size-4" /> : null}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => router.push('/onboarding')}>
                  <Plus className="size-4" />
                  New workspace
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="flex items-center gap-4">
              <ConnectionIndicator />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" aria-label="Account">
                    {me.data.user.name}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel className="font-normal">
                    <div className="text-sm font-medium">{me.data.user.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {me.data.user.email} · {workspace.role}
                    </div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => void signOut()}>
                    <LogOut className="size-4" />
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>
          <nav aria-label="Workspace" className="flex gap-1 border-b px-2 py-1 md:hidden">
            {NAVIGATION.map(({ segment, label }) => (
              <Link key={segment} href={`/w/${workspaceId}/${segment}`} className="rounded-md px-3 py-1.5 text-sm hover:bg-accent">
                {label}
              </Link>
            ))}
          </nav>
          <main className="min-w-0 flex-1">{children}</main>
        </div>
      </div>
    </WorkspaceContext.Provider>
  );
}
