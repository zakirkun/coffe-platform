import type { CreateTicketRequest, Ticket } from '@coffe/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from './keys';
import { upsertById } from './realtime-sync';

/** All tickets of a project; kept live by `ticket.updated` / `ticket.deleted` events. */
export function useProjectTickets(workspaceId: string, projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectTickets(workspaceId, projectId),
    queryFn: ({ signal }) => api.listTickets(workspaceId, projectId, signal),
  });
}

export function useTicket(workspaceId: string, ticketId: string) {
  return useQuery({
    queryKey: queryKeys.ticket(workspaceId, ticketId),
    queryFn: ({ signal }) => api.getTicket(workspaceId, ticketId, signal),
  });
}

export function useCreateTicket(workspaceId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTicketRequest) => api.createTicket(workspaceId, projectId, body),
    onSuccess: (ticket) => {
      queryClient.setQueryData<Ticket>(queryKeys.ticket(workspaceId, ticket.id), ticket);
      queryClient.setQueryData<Ticket[]>(
        queryKeys.projectTickets(workspaceId, projectId),
        (tickets) => upsertById(tickets, ticket),
      );
    },
  });
}
