import type { CreatePairingTokenRequest, Runner } from '@coffe/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from './keys';
import { upsertById } from './realtime-sync';

/** Runners with their CLIs and repositories; kept live by `runner.status` events. */
export function useRunners(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.runners(workspaceId),
    queryFn: ({ signal }) => api.listRunners(workspaceId, signal),
  });
}

export function useCreatePairingToken(workspaceId: string) {
  return useMutation({
    mutationFn: (body: CreatePairingTokenRequest) => api.createPairingToken(workspaceId, body),
  });
}

export function useRevokeRunner(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (runnerId: string) => api.revokeRunner(workspaceId, runnerId),
    onSuccess: (runner) => {
      queryClient.setQueryData<Runner[]>(queryKeys.runners(workspaceId), (runners) =>
        upsertById(runners, runner),
      );
    },
  });
}

/** How long a runner may take to re-run detection and report its catalog back. */
const DETECTION_REFETCH_DELAYS_MS = [1_500, 5_000];

export function useDetectClis(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (runnerId: string) => api.detectClis(workspaceId, runnerId),
    onSuccess: () => {
      // The request is only accepted (202); the runner answers asynchronously.
      for (const delay of DETECTION_REFETCH_DELAYS_MS) {
        window.setTimeout(() => {
          void queryClient.invalidateQueries({ queryKey: queryKeys.runners(workspaceId) });
        }, delay);
      }
    },
  });
}
