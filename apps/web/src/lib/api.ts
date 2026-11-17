import {
  ApiError,
  type ApproveRequest,
  ApproveResponse,
  AuditPage,
  type BindRepoRequest,
  type CreatePairingTokenRequest,
  type CreateProjectRequest,
  type CreateTicketRequest,
  Diff,
  FileContentResponse,
  MeResponse,
  PairingTokenResponse,
  Project,
  ProjectRepoBinding,
  type RequestChangesRequest,
  RequestChangesResponse,
  ReviewState,
  Run,
  RunEventsResponse,
  type RunInputRequest,
  RunOutputResponse,
  type RunSignalRequest,
  Runner,
  type StartRunRequest,
  Ticket,
  type UpdateProjectRequest,
} from '@coffe/contracts';
import { z } from 'zod';

/** Same-origin: production serves web and API behind one origin, `next dev` rewrites `/api/*`. */
const API_BASE = '/api/v1';

/** A failed API call: the server's `{ error: { code, message } }` body, or a transport failure. */
export class ApiRequestError extends Error {
  /** HTTP status; `0` when the request never produced a response. */
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Builds the error for a non-2xx response; tolerates empty and non-JSON bodies (proxies). */
export async function parseErrorResponse(response: Response): Promise<ApiRequestError> {
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    body = undefined;
  }
  const parsed = ApiError.safeParse(body);
  if (parsed.success) {
    const { code, message, details } = parsed.data.error;
    return new ApiRequestError(response.status, code, message, details);
  }
  return new ApiRequestError(
    response.status,
    `http_${response.status}`,
    response.statusText || `Request failed with status ${response.status}`,
  );
}

/** Message suitable for a toast or inline alert. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong.';
}

type QueryParams = Record<string, string | number | undefined>;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: QueryParams;
  signal?: AbortSignal;
}

function buildUrl(path: string, query: QueryParams | undefined): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) params.set(key, String(value));
  }
  const search = params.toString();
  return `${API_BASE}${path}${search ? `?${search}` : ''}`;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method: options.method ?? 'GET',
      credentials: 'include',
      headers,
      body,
      signal: options.signal,
    });
  } catch (cause) {
    if (options.signal?.aborted) throw cause;
    throw new ApiRequestError(0, 'network_error', 'Could not reach the server.');
  }
  if (!response.ok) throw await parseErrorResponse(response);
  return response;
}

/** Sends a request and validates the JSON response against a contracts schema. */
export async function requestJson<S extends z.ZodType>(
  schema: S,
  path: string,
  options: RequestOptions = {},
): Promise<z.output<S>> {
  const response = await send(path, options);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = undefined;
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiRequestError(
      response.status,
      'invalid_response',
      `The server returned an unexpected response for ${path}.`,
      { issues: parsed.error.issues },
    );
  }
  return parsed.data;
}

function workspacePath(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}`;
}

/** One function per Phase 1 route (see the route table in `@coffe/contracts`). */
export const api = {
  me: (signal?: AbortSignal) => requestJson(MeResponse, '/me', { signal }),

  // Runners
  createPairingToken: (ws: string, body: CreatePairingTokenRequest) =>
    requestJson(PairingTokenResponse, `${workspacePath(ws)}/runner-pairing-tokens`, {
      method: 'POST',
      body,
    }),
  listRunners: (ws: string, signal?: AbortSignal) =>
    requestJson(z.array(Runner), `${workspacePath(ws)}/runners`, { signal }),
  revokeRunner: (ws: string, runnerId: string) =>
    requestJson(Runner, `${workspacePath(ws)}/runners/${runnerId}/revoke`, { method: 'POST' }),
  detectClis: async (ws: string, runnerId: string): Promise<void> => {
    await send(`${workspacePath(ws)}/runners/${runnerId}/detect-clis`, { method: 'POST' });
  },

  // Projects
  listProjects: (ws: string, signal?: AbortSignal) =>
    requestJson(z.array(Project), `${workspacePath(ws)}/projects`, { signal }),
  createProject: (ws: string, body: CreateProjectRequest) =>
    requestJson(Project, `${workspacePath(ws)}/projects`, { method: 'POST', body }),
  getProject: (ws: string, projectId: string, signal?: AbortSignal) =>
    requestJson(Project, `${workspacePath(ws)}/projects/${projectId}`, { signal }),
  updateProject: (ws: string, projectId: string, body: UpdateProjectRequest) =>
    requestJson(Project, `${workspacePath(ws)}/projects/${projectId}`, { method: 'PATCH', body }),
  listProjectRepos: (ws: string, projectId: string, signal?: AbortSignal) =>
    requestJson(z.array(ProjectRepoBinding), `${workspacePath(ws)}/projects/${projectId}/repos`, {
      signal,
    }),
  bindRepo: (ws: string, projectId: string, body: BindRepoRequest) =>
    requestJson(ProjectRepoBinding, `${workspacePath(ws)}/projects/${projectId}/repos`, {
      method: 'POST',
      body,
    }),
  unbindRepo: async (ws: string, projectId: string, bindingId: string): Promise<void> => {
    await send(`${workspacePath(ws)}/projects/${projectId}/repos/${bindingId}`, {
      method: 'DELETE',
    });
  },

  // Tickets
  listTickets: (ws: string, projectId: string, signal?: AbortSignal) =>
    requestJson(z.array(Ticket), `${workspacePath(ws)}/projects/${projectId}/tickets`, { signal }),
  createTicket: (ws: string, projectId: string, body: CreateTicketRequest) =>
    requestJson(Ticket, `${workspacePath(ws)}/projects/${projectId}/tickets`, {
      method: 'POST',
      body,
    }),
  getTicket: (ws: string, ticketId: string, signal?: AbortSignal) =>
    requestJson(Ticket, `${workspacePath(ws)}/tickets/${ticketId}`, { signal }),

  // Runs
  listTicketRuns: (ws: string, ticketId: string, signal?: AbortSignal) =>
    requestJson(z.array(Run), `${workspacePath(ws)}/tickets/${ticketId}/runs`, { signal }),
  startRun: (ws: string, ticketId: string, body: StartRunRequest) =>
    requestJson(Run, `${workspacePath(ws)}/tickets/${ticketId}/runs`, { method: 'POST', body }),
  getRunOutput: (ws: string, runId: string, afterSeq: number, limit: number, signal?: AbortSignal) =>
    requestJson(RunOutputResponse, `${workspacePath(ws)}/runs/${runId}/output`, {
      query: { afterSeq, limit },
      signal,
    }),
  getRunEvents: (ws: string, runId: string, afterSeq: number, limit: number, signal?: AbortSignal) =>
    requestJson(RunEventsResponse, `${workspacePath(ws)}/runs/${runId}/events`, {
      query: { afterSeq, limit },
      signal,
    }),
  sendRunInput: async (ws: string, runId: string, body: RunInputRequest): Promise<void> => {
    await send(`${workspacePath(ws)}/runs/${runId}/input`, { method: 'POST', body });
  },
  sendRunSignal: async (ws: string, runId: string, body: RunSignalRequest): Promise<void> => {
    await send(`${workspacePath(ws)}/runs/${runId}/signal`, { method: 'POST', body });
  },

  // Review
  getReview: (ws: string, ticketId: string, signal?: AbortSignal) =>
    requestJson(ReviewState, `${workspacePath(ws)}/tickets/${ticketId}/review`, { signal }),
  refreshDiff: (ws: string, ticketId: string) =>
    requestJson(Diff, `${workspacePath(ws)}/tickets/${ticketId}/diff/refresh`, { method: 'POST' }),
  getFile: (ws: string, ticketId: string, rev: string, path: string, signal?: AbortSignal) =>
    requestJson(FileContentResponse, `${workspacePath(ws)}/tickets/${ticketId}/file`, {
      query: { rev, path },
      signal,
    }),
  approve: (ws: string, ticketId: string, body: ApproveRequest) =>
    requestJson(ApproveResponse, `${workspacePath(ws)}/tickets/${ticketId}/approve`, {
      method: 'POST',
      body,
    }),
  requestChanges: (ws: string, ticketId: string, body: RequestChangesRequest) =>
    requestJson(RequestChangesResponse, `${workspacePath(ws)}/tickets/${ticketId}/request-changes`, {
      method: 'POST',
      body,
    }),

  // Audit
  listAudit: (ws: string, query: { cursor?: string; limit: number }, signal?: AbortSignal) =>
    requestJson(AuditPage, `${workspacePath(ws)}/audit`, { query, signal }),
};
