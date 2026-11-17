import type {
  ApproveRequirementRequest,
  ContextDoc,
  CreateContextDocRequest,
  CreatePersonaRequest,
  CreateRequirementRequest,
  CreateWorkflowRequest,
  MoveTicketRequest,
  Persona,
  PricingTable,
  Requirement,
  Ticket,
  TicketDraft,
  UpdateContextDocRequest,
  UpdateDraftRequest,
  UpdatePersonaRequest,
  UpdateTicketRequest,
  UpdateWorkflowRequest,
  UpsertDraftRequest,
  UsageQuery,
} from '@coffe/contracts';
import {
  keepPreviousData,
  skipToken,
  type UseMutationResult,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { ApiRequestError, api } from '@/lib/api';
import { queryKeys } from './keys';
import { upsertById } from './realtime-sync';

// --- Personas ----------------------------------------------------------------------------------

export function usePersonas(workspaceId: string, projectId?: string) {
  return useQuery({
    queryKey: [...queryKeys.personas(workspaceId), projectId ?? null],
    queryFn: ({ signal }) => api.listPersonas(workspaceId, projectId, signal),
  });
}

/** Creating needs the full request; updating takes a partial one for an existing id. */
export type SaveInput<C, U> = { id?: undefined; body: C } | { id: string; body: U };

export function useSavePersona(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveInput<CreatePersonaRequest, UpdatePersonaRequest>) =>
      input.id === undefined
        ? api.createPersona(workspaceId, input.body)
        : api.updatePersona(workspaceId, input.id, input.body),
    onSuccess: (persona: Persona) => {
      queryClient.setQueriesData<Persona[]>(
        { queryKey: queryKeys.personas(workspaceId) },
        (personas) => upsertById(personas, persona),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.personas(workspaceId) });
    },
  });
}

export function useArchivePersona(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (personaId: string) => api.archivePersona(workspaceId, personaId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.personas(workspaceId) }),
  });
}

// --- Project context ---------------------------------------------------------------------------

export function useContextDocs(workspaceId: string, projectId: string) {
  return useQuery({
    queryKey: queryKeys.contextDocs(workspaceId, projectId),
    queryFn: ({ signal }) => api.listContext(workspaceId, projectId, signal),
  });
}

export function useContextPreview(workspaceId: string, projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...queryKeys.contextDocs(workspaceId, projectId), 'preview'],
    queryFn: enabled
      ? ({ signal }) => api.previewContext(workspaceId, projectId, {}, signal)
      : skipToken,
  });
}

export function useSaveContextDoc(workspaceId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveInput<CreateContextDocRequest, UpdateContextDocRequest>) =>
      input.id === undefined
        ? api.createContextDoc(workspaceId, projectId, input.body)
        : api.updateContextDoc(workspaceId, input.id, input.body),
    onSuccess: (doc: ContextDoc) => {
      queryClient.setQueryData<ContextDoc[]>(
        queryKeys.contextDocs(workspaceId, projectId),
        (docs) => upsertById(docs, doc),
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.contextDocs(workspaceId, projectId),
      });
    },
  });
}

export function useDeleteContextDoc(workspaceId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (docId: string) => api.deleteContextDoc(workspaceId, docId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.contextDocs(workspaceId, projectId) }),
  });
}

// --- Workflows ---------------------------------------------------------------------------------

export function useWorkflows(workspaceId: string, projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.workflows(workspaceId, projectId ?? ''),
    queryFn: projectId
      ? ({ signal }) => api.listWorkflows(workspaceId, projectId, signal)
      : skipToken,
  });
}

export function useSaveWorkflow(workspaceId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveInput<CreateWorkflowRequest, UpdateWorkflowRequest>) =>
      input.id === undefined
        ? api.createWorkflow(workspaceId, projectId, input.body)
        : api.updateWorkflow(workspaceId, input.id, input.body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.workflows(workspaceId, projectId) }),
  });
}

/** The latest workflow run of a ticket; `null` when it never ran one. */
export function useTicketWorkflow(workspaceId: string, ticketId: string) {
  return useQuery({
    queryKey: queryKeys.ticketWorkflow(workspaceId, ticketId),
    queryFn: async ({ signal }) => {
      try {
        return await api.getTicketWorkflow(workspaceId, ticketId, signal);
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 404) return null;
        throw error;
      }
    },
  });
}

export function useStartWorkflow(workspaceId: string, ticketId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workflowId: string | undefined) =>
      api.startTicket(workspaceId, ticketId, { workflowId }),
    onSuccess: (instance) => {
      queryClient.setQueryData(queryKeys.ticketWorkflow(workspaceId, ticketId), instance);
      void queryClient.invalidateQueries({ queryKey: queryKeys.ticket(workspaceId, ticketId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.ticketRuns(workspaceId, ticketId) });
    },
  });
}

export function useCancelWorkflow(workspaceId: string, ticketId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.cancelTicketWorkflow(workspaceId, ticketId),
    onSuccess: (instance) =>
      queryClient.setQueryData(queryKeys.ticketWorkflow(workspaceId, ticketId), instance),
  });
}

// --- Tickets on the board ------------------------------------------------------------------------

/** Moves a ticket; the board keeps its local drag order until this settles. */
export function useMoveTicket(workspaceId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, body }: { ticketId: string; body: MoveTicketRequest }) =>
      api.moveTicket(workspaceId, ticketId, body),
    onSuccess: (ticket) => {
      queryClient.setQueryData<Ticket[]>(
        queryKeys.projectTickets(workspaceId, projectId),
        (tickets) => upsertById(tickets, ticket),
      );
      queryClient.setQueryData(queryKeys.ticket(workspaceId, ticket.id), ticket);
    },
  });
}

export function useUpdateTicket(workspaceId: string, ticketId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateTicketRequest) => api.updateTicket(workspaceId, ticketId, body),
    onSuccess: (ticket) =>
      queryClient.setQueryData(queryKeys.ticket(workspaceId, ticketId), ticket),
  });
}

// --- Planning ----------------------------------------------------------------------------------

export function useRequirements(workspaceId: string, projectId: string) {
  return useQuery({
    queryKey: queryKeys.requirements(workspaceId, projectId),
    queryFn: ({ signal }) => api.listRequirements(workspaceId, projectId, signal),
  });
}

function usePlanningMutation<I, O>(
  workspaceId: string,
  projectId: string,
  run: (input: I) => Promise<O>,
): UseMutationResult<O, Error, I> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.requirements(workspaceId, projectId) }),
  });
}

/** Every planning mutation of one project; each refreshes the requirement list when it succeeds. */
export interface PlanningActions {
  create: UseMutationResult<Requirement, Error, CreateRequirementRequest>;
  plan: UseMutationResult<Requirement, Error, { id: string; plannerPersonaId?: string }>;
  addDraft: UseMutationResult<TicketDraft, Error, { id: string; body: UpsertDraftRequest }>;
  updateDraft: UseMutationResult<
    TicketDraft,
    Error,
    { id: string; draftId: string; body: UpdateDraftRequest }
  >;
  discardDraft: UseMutationResult<void, Error, { id: string; draftId: string }>;
  approve: UseMutationResult<Ticket[], Error, { id: string; body: ApproveRequirementRequest }>;
}

export function usePlanningActions(workspaceId: string, projectId: string): PlanningActions {
  return {
    create: usePlanningMutation(workspaceId, projectId, (body: CreateRequirementRequest) =>
      api.createRequirement(workspaceId, projectId, body),
    ),
    plan: usePlanningMutation(
      workspaceId,
      projectId,
      ({ id, plannerPersonaId }: { id: string; plannerPersonaId?: string }) =>
        api.planRequirement(workspaceId, id, { plannerPersonaId }),
    ),
    addDraft: usePlanningMutation(
      workspaceId,
      projectId,
      ({ id, body }: { id: string; body: UpsertDraftRequest }) =>
        api.addDraft(workspaceId, id, body),
    ),
    updateDraft: usePlanningMutation(
      workspaceId,
      projectId,
      ({ id, draftId, body }: { id: string; draftId: string; body: UpdateDraftRequest }) =>
        api.updateDraft(workspaceId, id, draftId, body),
    ),
    discardDraft: usePlanningMutation(
      workspaceId,
      projectId,
      ({ id, draftId }: { id: string; draftId: string }) =>
        api.discardDraft(workspaceId, id, draftId),
    ),
    approve: usePlanningMutation(
      workspaceId,
      projectId,
      ({ id, body }: { id: string; body: ApproveRequirementRequest }) =>
        api.approveRequirement(workspaceId, id, body),
    ),
  };
}

// --- Usage -------------------------------------------------------------------------------------

export function useUsage(workspaceId: string, query: Partial<UsageQuery>) {
  return useQuery({
    queryKey: [...queryKeys.usage(workspaceId), query],
    queryFn: ({ signal }) => api.usage(workspaceId, query, signal),
    placeholderData: keepPreviousData,
  });
}

export function usePricing(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.pricing(workspaceId),
    queryFn: ({ signal }) => api.pricing(workspaceId, signal),
  });
}

export function useSavePricing(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (table: PricingTable) => api.setPricing(workspaceId, table),
    onSuccess: (table) => {
      queryClient.setQueryData(queryKeys.pricing(workspaceId), table);
      void queryClient.invalidateQueries({ queryKey: queryKeys.usage(workspaceId) });
    },
  });
}
