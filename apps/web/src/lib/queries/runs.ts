import type { Run, RunInputRequest, RunSignalRequest, StartRunRequest } from '@coffe/contracts';
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '@/lib/api';
import { queryKeys } from './keys';
import { upsertById } from './realtime-sync';

/** Runs of a ticket; kept live by `run.updated` / `run.usage` events. */
export function useTicketRuns(workspaceId: string, ticketId: string) {
  return useQuery({
    queryKey: queryKeys.ticketRuns(workspaceId, ticketId),
    queryFn: ({ signal }) => api.listTicketRuns(workspaceId, ticketId, signal),
  });
}

export function useStartRun(workspaceId: string, ticketId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: StartRunRequest) => api.startRun(workspaceId, ticketId, body),
    onSuccess: (run) => {
      queryClient.setQueryData<Run[]>(queryKeys.ticketRuns(workspaceId, ticketId), (runs) =>
        upsertById(runs, run),
      );
      // Starting a run moves the ticket to "In progress".
      void queryClient.invalidateQueries({ queryKey: queryKeys.ticket(workspaceId, ticketId) });
    },
  });
}

export interface RunSignalInput {
  runId: string;
  signal: RunSignalRequest['signal'];
}

/** Pause / resume / interrupt / stop. Accepted asynchronously; the new state arrives as an event. */
export function useRunSignal(workspaceId: string) {
  return useMutation({
    mutationFn: ({ runId, signal }: RunSignalInput) =>
      api.sendRunSignal(workspaceId, runId, { signal }),
  });
}

export interface RunInput {
  runId: string;
  input: RunInputRequest;
}

/** Follow-up message or permission answer for a structured run. */
export function useRunInput(workspaceId: string) {
  return useMutation({
    mutationFn: ({ runId, input }: RunInput) => api.sendRunInput(workspaceId, runId, input),
  });
}

const PermissionRequest = z.object({
  kind: z.literal('permission_request'),
  request_id: z.string(),
  tool: z.string(),
  description: z.string(),
  options: z.array(z.string()),
});
export type PermissionRequest = z.infer<typeof PermissionRequest>;

/** Events fetched to find the open permission request of a run waiting for input. */
const PERMISSION_LOOKBACK = 500;

/** The permission request a structured run is waiting on, if any. */
export function usePendingPermission(workspaceId: string, run: Run | undefined) {
  const waiting = run?.status === 'waiting_input';
  return useQuery({
    queryKey: [...queryKeys.runEvents(workspaceId, run?.id ?? ''), 'permission', run?.lastSeq ?? 0],
    queryFn:
      run && waiting
        ? async ({ signal }) => {
            const page = await api.getRunEvents(
              workspaceId,
              run.id,
              Math.max(0, run.lastSeq - PERMISSION_LOOKBACK),
              PERMISSION_LOOKBACK * 2,
              signal,
            );
            for (const event of page.events.toReversed()) {
              const request = PermissionRequest.safeParse(event.data);
              if (request.success) return request.data;
            }
            return null;
          }
        : skipToken,
  });
}
