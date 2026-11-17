import type { Channel, Run, Runner, Ticket } from '@coffe/contracts';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { type ChannelEvent, useChannel } from '@/lib/realtime';
import { queryKeys } from './keys';

/** Replaces the item with the same id, or appends it; `undefined` (nothing cached) stays as is. */
export function upsertById<T extends { id: string }>(
  items: readonly T[] | undefined,
  item: T,
): T[] | undefined {
  if (!items) return undefined;
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

/**
 * Applies one realtime event to the query cache. Events that carry the full entity are written
 * directly; the rest invalidate the queries they make stale. Terminal bytes and agent events
 * (`run.output`, `run.event`) are consumed by their own streams, not by the cache.
 */
export function applyRealtimeEvent(
  queryClient: QueryClient,
  workspaceId: string,
  event: ChannelEvent,
): void {
  switch (event.ev) {
    case 'runner.status': {
      queryClient.setQueryData<Runner[]>(queryKeys.runners(workspaceId), (runners) =>
        runners?.map((runner) =>
          runner.id === event.runnerId
            ? { ...runner, status: event.status, runningRuns: event.runningRuns }
            : runner,
        ),
      );
      // A (re)connecting runner may report new CLIs, repositories or a new version, and a
      // freshly paired runner is not in the list yet.
      void queryClient.invalidateQueries({ queryKey: queryKeys.runners(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.allProjectRepos(workspaceId) });
      return;
    }
    case 'ticket.updated': {
      const { ticket } = event;
      queryClient.setQueryData<Ticket>(queryKeys.ticket(workspaceId, ticket.id), ticket);
      queryClient.setQueryData<Ticket[]>(
        queryKeys.projectTickets(workspaceId, ticket.projectId),
        (tickets) => upsertById(tickets, ticket),
      );
      // Status and latest-run changes come with new runs and a new review state.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.ticketRuns(workspaceId, ticket.id),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.review(workspaceId, ticket.id) });
      return;
    }
    case 'ticket.deleted': {
      queryClient.setQueriesData<Ticket[]>(
        { queryKey: queryKeys.allProjectTickets(workspaceId) },
        (tickets) => tickets?.filter((ticket) => ticket.id !== event.ticketId),
      );
      queryClient.removeQueries({ queryKey: queryKeys.ticket(workspaceId, event.ticketId) });
      return;
    }
    case 'run.updated': {
      const { run } = event;
      if (!run.ticketId) return;
      queryClient.setQueryData<Run[]>(queryKeys.ticketRuns(workspaceId, run.ticketId), (runs) =>
        upsertById(runs, run),
      );
      // `canApprove` depends on the latest run being finished.
      void queryClient.invalidateQueries({ queryKey: queryKeys.review(workspaceId, run.ticketId) });
      return;
    }
    case 'run.usage': {
      queryClient.setQueriesData<Run[]>(
        { queryKey: queryKeys.allTicketRuns(workspaceId) },
        (runs) =>
          runs?.map((run) => (run.id === event.runId ? { ...run, usage: event.usage } : run)),
      );
      return;
    }
    case 'review.updated': {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.review(workspaceId, event.ticketId),
      });
      return;
    }
    case 'run.output':
    case 'run.event':
      return;
  }
}

/** Keeps the query cache current with the events of one channel (`null` = not subscribed). */
export function useRealtimeSync(workspaceId: string, channel: Channel | null | undefined): void {
  const queryClient = useQueryClient();
  useChannel(channel, (event) => applyRealtimeEvent(queryClient, workspaceId, event));
}
