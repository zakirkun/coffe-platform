/**
 * REST + realtime contracts shared by apps/api and apps/web (zod 4 schemas + inferred types).
 * JSON is camelCase. All routes are prefixed with `/api/v1`; `:ws` is the workspace
 * (Better Auth organization) id. The runner protocol lives in `@coffe/protocol`, not here.
 *
 * Phase 1 routes
 * | Method | Path | Body / query | Response |
 * |---|---|---|---|
 * | GET | /me | – | MeResponse |
 * | GET | /workspaces/:ws/members | – | Member[] |
 * | POST | /workspaces/:ws/runner-pairing-tokens | CreatePairingTokenRequest | PairingTokenResponse |
 * | GET | /workspaces/:ws/runners | – | Runner[] |
 * | GET | /workspaces/:ws/runners/:runnerId | – | Runner |
 * | PATCH | /workspaces/:ws/runners/:runnerId | UpdateRunnerRequest | Runner |
 * | POST | /workspaces/:ws/runners/:runnerId/revoke | – | Runner |
 * | POST | /workspaces/:ws/runners/:runnerId/detect-clis | – | 202 |
 * | GET | /workspaces/:ws/projects | – | Project[] |
 * | POST | /workspaces/:ws/projects | CreateProjectRequest | Project |
 * | GET | /workspaces/:ws/projects/:projectId | – | Project |
 * | PATCH | /workspaces/:ws/projects/:projectId | UpdateProjectRequest | Project |
 * | GET | /workspaces/:ws/projects/:projectId/repos | – | ProjectRepoBinding[] |
 * | POST | /workspaces/:ws/projects/:projectId/repos | BindRepoRequest | ProjectRepoBinding |
 * | DELETE | /workspaces/:ws/projects/:projectId/repos/:bindingId | – | 204 |
 * | GET | /workspaces/:ws/projects/:projectId/tickets | – | Ticket[] |
 * | POST | /workspaces/:ws/projects/:projectId/tickets | CreateTicketRequest | Ticket |
 * | GET | /workspaces/:ws/tickets/:ticketId | – | Ticket |
 * | PATCH | /workspaces/:ws/tickets/:ticketId | UpdateTicketRequest | Ticket |
 * | POST | /workspaces/:ws/tickets/:ticketId/move | MoveTicketRequest | Ticket |
 * | GET | /workspaces/:ws/tickets/:ticketId/runs | – | Run[] |
 * | POST | /workspaces/:ws/tickets/:ticketId/runs | StartRunRequest | Run |
 * | GET | /workspaces/:ws/runs/:runId | – | Run |
 * | GET | /workspaces/:ws/runs/:runId/output | AfterSeqQuery | RunOutputResponse |
 * | GET | /workspaces/:ws/runs/:runId/events | AfterSeqQuery | RunEventsResponse |
 * | POST | /workspaces/:ws/runs/:runId/input | RunInputRequest | 202 |
 * | POST | /workspaces/:ws/runs/:runId/signal | RunSignalRequest | 202 |
 * | GET | /workspaces/:ws/tickets/:ticketId/review | – | ReviewState |
 * | GET | /workspaces/:ws/tickets/:ticketId/diff | – | Diff (404 if none) |
 * | POST | /workspaces/:ws/tickets/:ticketId/diff/refresh | – | Diff |
 * | GET | /workspaces/:ws/tickets/:ticketId/file | FileQuery | FileContentResponse |
 * | POST | /workspaces/:ws/tickets/:ticketId/approve | ApproveRequest | ApproveResponse |
 * | POST | /workspaces/:ws/tickets/:ticketId/request-changes | RequestChangesRequest | RequestChangesResponse |
 * | GET | /workspaces/:ws/audit | AuditQuery | AuditPage |
 *
 * Phase 2 routes
 * | Method | Path | Body / query | Response |
 * |---|---|---|---|
 * | GET | /workspaces/:ws/personas | PersonaQuery | Persona[] |
 * | POST | /workspaces/:ws/personas | CreatePersonaRequest | Persona |
 * | PATCH | /workspaces/:ws/personas/:personaId | UpdatePersonaRequest | Persona |
 * | DELETE | /workspaces/:ws/personas/:personaId | – | 204 (archives) |
 * | GET | /workspaces/:ws/projects/:projectId/context | – | ContextDoc[] |
 * | POST | /workspaces/:ws/projects/:projectId/context | CreateContextDocRequest | ContextDoc |
 * | PATCH | /workspaces/:ws/context/:docId | UpdateContextDocRequest | ContextDoc |
 * | DELETE | /workspaces/:ws/context/:docId | – | 204 |
 * | GET | /workspaces/:ws/projects/:projectId/context/preview | ContextPreviewQuery | ContextPreview |
 * | GET | /workspaces/:ws/projects/:projectId/workflows | – | Workflow[] |
 * | POST | /workspaces/:ws/projects/:projectId/workflows | CreateWorkflowRequest | Workflow |
 * | PATCH | /workspaces/:ws/workflows/:workflowId | UpdateWorkflowRequest | Workflow |
 * | POST | /workspaces/:ws/tickets/:ticketId/start | StartTicketRequest | WorkflowInstance |
 * | GET | /workspaces/:ws/tickets/:ticketId/workflow | – | WorkflowInstance (404 if none) |
 * | POST | /workspaces/:ws/tickets/:ticketId/workflow/cancel | – | WorkflowInstance |
 * | GET | /workspaces/:ws/projects/:projectId/requirements | – | Requirement[] |
 * | POST | /workspaces/:ws/projects/:projectId/requirements | CreateRequirementRequest | Requirement |
 * | GET | /workspaces/:ws/requirements/:requirementId | – | Requirement |
 * | POST | /workspaces/:ws/requirements/:requirementId/plan | PlanRequirementRequest | Requirement |
 * | POST | /workspaces/:ws/requirements/:requirementId/drafts | UpsertDraftRequest | TicketDraft |
 * | PATCH | /workspaces/:ws/requirements/:requirementId/drafts/:draftId | UpsertDraftRequest (partial) | TicketDraft |
 * | DELETE | /workspaces/:ws/requirements/:requirementId/drafts/:draftId | – | 204 (discards) |
 * | POST | /workspaces/:ws/requirements/:requirementId/approve | ApproveRequirementRequest | Ticket[] |
 * | GET | /workspaces/:ws/usage | UsageQuery | UsageReport |
 * | GET | /workspaces/:ws/pricing | – | PricingTable |
 * | PUT | /workspaces/:ws/pricing | PricingTable | PricingTable |
 *
 * Phase 3 routes (work environment)
 * | Method | Path | Body / query | Response |
 * |---|---|---|---|
 * | POST | /workspaces/:ws/terminals | OpenTerminalRequest | TerminalSession (+ realtime `pty:<sessionId>`) |
 * | GET | /workspaces/:ws/projects/:projectId/environments | – | DockerEnvironment[] |
 * | POST | /workspaces/:ws/projects/:projectId/environments | CreateDockerEnvironmentRequest | DockerEnvironment |
 * | DELETE | /workspaces/:ws/environments/:envId | – | 204 |
 * | GET | /workspaces/:ws/projects/:projectId/containers | – | Container[] |
 * | POST | /workspaces/:ws/environments/:envId/containers | CreateContainerRequest | Container |
 * | POST | /workspaces/:ws/containers/:containerRowId/:action | action ∈ start/stop/restart/remove | Container |
 * | GET | /workspaces/:ws/containers/:containerRowId/stats | – | ContainerStats |
 * | POST | /workspaces/:ws/containers/:containerRowId/logs | – | `{ streamId }` (+ realtime `logs:<streamId>`) |
 * | GET | /workspaces/:ws/projects/:projectId/previews | – | Preview[] |
 * | POST | /workspaces/:ws/projects/:projectId/previews | CreatePreviewRequest | Preview |
 * | POST | /workspaces/:ws/previews/:previewId/grant | – | PreviewGrant |
 * | DELETE | /workspaces/:ws/previews/:previewId | – | 204 |
 * | POST | /workspaces/:ws/projects/:projectId/attachments | CreateAttachmentRequest | Attachment |
 * | GET | /workspaces/:ws/attachments/:attachmentId/content | – | binary |
 * | POST | /workspaces/:ws/runs/:runId/attachments | SendAttachmentsRequest | 202 |
 * | GET | /workspaces/:ws/runners/:runnerId/db/connections | – | DbConnectionsResponse |
 * | POST | /workspaces/:ws/runners/:runnerId/db/connections | SaveDbConnectionRequest | DbConnection |
 * | DELETE | /workspaces/:ws/runners/:runnerId/db/connections/:connectionId | – | 204 |
 * | POST | /workspaces/:ws/runners/:runnerId/db/connections/:connectionId/test | – | protocol DbTestResult |
 * | GET | /workspaces/:ws/runners/:runnerId/db/connections/:connectionId/schema | DbSchemaQuery | protocol DbSchemaResult |
 * | POST | /workspaces/:ws/runners/:runnerId/db/connections/:connectionId/query | DbQueryRequest | protocol DbQueryResult |
 * | POST | /workspaces/:ws/runners/:runnerId/db/connections/:connectionId/assist | DbAssistRequest | Run |
 * | GET | /workspaces/:ws/ssh/hosts | – | SshHost[] |
 * | POST | /workspaces/:ws/ssh/hosts | CreateSshHostRequest | SshHost |
 * | DELETE | /workspaces/:ws/ssh/hosts/:hostId | – | 204 |
 * | PUT | /workspaces/:ws/ssh/hosts/:hostId/credentials/:runnerId | PutSshCredentialRequest | SshHost |
 * | POST | /workspaces/:ws/ssh/hosts/:hostId/sessions | OpenSshSessionRequest | SshSession (+ realtime `ssh:<sessionId>`) |
 * | GET/PUT | /me/vault | Vault | Vault |
 * | GET/PUT | /me/vault/items | VaultItem[] | VaultItem[] |
 *
 * Phase 4 routes (design, knowledge, collaboration)
 * | Method | Path | Body / query | Response |
 * |---|---|---|---|
 * | GET | /workspaces/:ws/projects/:projectId/canvases | – | Canvas[] |
 * | POST | /workspaces/:ws/projects/:projectId/canvases | CreateCanvasRequest | Canvas |
 * | PATCH | /workspaces/:ws/canvases/:canvasId | UpdateCanvasRequest | Canvas |
 * | POST | /workspaces/:ws/canvases/:canvasId/attach | AttachCanvasRequest | Canvas |
 * | POST | /workspaces/:ws/canvases/:canvasId/agent | CanvasAgentRequest | Run |
 * | POST, DELETE | /workspaces/:ws/canvases/:canvasId/lease | – | CanvasLease |
 * | GET | /workspaces/:ws/projects/:projectId/wiki | – | WikiStatus |
 * | GET | /workspaces/:ws/projects/:projectId/wiki/pages/:slug | – | WikiPage |
 * | POST | /workspaces/:ws/projects/:projectId/wiki/generate | GenerateWikiRequest | WikiStatus |
 * | GET | /workspaces/:ws/projects/:projectId/wiki/snippet | SnippetQuery | Snippet |
 * | GET | /workspaces/:ws/projects/:projectId/graph | – | CodeGraph |
 * | POST | /workspaces/:ws/projects/:projectId/graph/refresh | – | 202 |
 * | GET | /workspaces/:ws/comments | CommentQuery | Comment[] |
 * | POST | /workspaces/:ws/comments | CreateCommentRequest | Comment |
 * | PATCH, DELETE | /workspaces/:ws/comments/:commentId | UpdateCommentRequest | Comment / 204 |
 * | GET | /workspaces/:ws/invitations | – | Invitation[] |
 * Invitations are created/accepted through Better Auth organization endpoints; `url` is copyable.
 * Yjs (canvas content, presence): `wss://DOMAIN/api/yjs`, documents `canvas:<id>`,
 * `presence:project:<id>`, `presence:ticket:<id>`.
 *
 * Phase 5 routes (Sokudo extras)
 * | Method | Path | Body / query | Response |
 * |---|---|---|---|
 * | GET | /workspaces/:ws/projects/:projectId/memories | MemoryQuery | Memory[] |
 * | POST | /workspaces/:ws/projects/:projectId/memories | UpsertMemoryRequest | Memory |
 * | PATCH, DELETE | /workspaces/:ws/memories/:memoryId | UpsertMemoryRequest | Memory / 204 |
 * | POST | /workspaces/:ws/memories/:memoryId/review | ReviewMemoryRequest | Memory |
 * | GET | /workspaces/:ws/skills | – | Skill[] |
 * | POST | /workspaces/:ws/skills/import | ImportSkillRequest | Skill |
 * | PATCH, DELETE | /workspaces/:ws/skills/:skillId | `{ enabled }` | Skill / 204 |
 * | GET | /workspaces/:ws/leaderboard | LeaderboardQuery | Leaderboard |
 * | PUT | /workspaces/:ws/me/preferences | `{ leaderboardOptOut }` | 204 |
 * | POST | /workspaces/:ws/canvases/:canvasId/publish | PublishCanvasRequest | Publication |
 * | DELETE | /workspaces/:ws/publications/:publicationId | – | 204 |
 * | GET | /p/:slug (public, no auth) | – | published content |
 *
 * Authentication: Better Auth at `/api/auth/*` (email + password, organization plugin with
 * roles owner / member / reviewer). Session cookie prefix `coffe`.
 */
export * from './audit.js';
export * from './common.js';
export * from './context.js';
export * from './environment.js';
export * from './knowledge.js';
export * from './personas.js';
export * from './planning.js';
export * from './projects.js';
export * from './realtime.js';
export * from './review.js';
export * from './runners.js';
export * from './runs.js';
export * from './tickets.js';
export * from './usage.js';
export * from './workflows.js';
export * from './workspaces.js';
