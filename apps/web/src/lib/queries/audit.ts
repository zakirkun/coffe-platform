import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from './keys';

const PAGE_SIZE = 50;

/** Audit log, newest first, paged by the server's opaque cursor. */
export function useAuditLog(workspaceId: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.audit(workspaceId),
    queryFn: ({ pageParam, signal }) =>
      api.listAudit(workspaceId, { cursor: pageParam, limit: PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}
