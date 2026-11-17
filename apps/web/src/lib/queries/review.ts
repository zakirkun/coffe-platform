import type { Run } from '@coffe/contracts';
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from './keys';
import { upsertById } from './realtime-sync';

/** Diff, tests, review rounds and merges; refreshed by `review.updated` / `ticket.updated`. */
export function useReview(workspaceId: string, ticketId: string) {
  return useQuery({
    queryKey: queryKeys.review(workspaceId, ticketId),
    queryFn: ({ signal }) => api.getReview(workspaceId, ticketId, signal),
  });
}

/** Asks the runner to recompute the diff of the ticket's worktree. */
export function useRefreshDiff(workspaceId: string, ticketId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.refreshDiff(workspaceId, ticketId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.review(workspaceId, ticketId) }),
  });
}

export function useApprove(workspaceId: string, ticketId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => api.approve(workspaceId, ticketId, { body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.review(workspaceId, ticketId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.ticket(workspaceId, ticketId) });
    },
  });
}

export function useRequestChanges(workspaceId: string, ticketId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => api.requestChanges(workspaceId, ticketId, { body }),
    onSuccess: ({ run }) => {
      queryClient.setQueryData<Run[]>(queryKeys.ticketRuns(workspaceId, ticketId), (runs) =>
        upsertById(runs, run),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.review(workspaceId, ticketId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.ticket(workspaceId, ticketId) });
    },
  });
}

/**
 * One file at one commit, relayed from the runner (never stored; 503 while it is offline).
 * `rev`/`path` are `null` for the side that does not exist (added or deleted files).
 */
export function useFileContent(
  workspaceId: string,
  ticketId: string,
  rev: string | null,
  path: string | null,
) {
  return useQuery({
    queryKey: queryKeys.file(workspaceId, ticketId, rev ?? '', path ?? ''),
    queryFn:
      rev && path ? ({ signal }) => api.getFile(workspaceId, ticketId, rev, path, signal) : skipToken,
    // Content at a commit never changes.
    staleTime: Number.POSITIVE_INFINITY,
  });
}
