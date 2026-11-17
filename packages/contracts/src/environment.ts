import { z } from 'zod';
import { IsoDate, Uuid } from './common.js';

// ---------------------------------------------------------------------------
// Terminals (worktree / container shells through the runner)
// ---------------------------------------------------------------------------

export const TerminalTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('worktree'), ticketId: Uuid }),
  z.object({ kind: z.literal('repo'), runnerRepoId: Uuid }),
  z.object({ kind: z.literal('container'), containerRowId: Uuid }),
]);
export type TerminalTarget = z.infer<typeof TerminalTarget>;

/** `POST /workspaces/:ws/terminals` → realtime channel `pty:<sessionId>`. */
export const OpenTerminalRequest = z.object({
  target: TerminalTarget,
  cols: z.number().int().min(10).max(1_000),
  rows: z.number().int().min(5).max(500),
});
export type OpenTerminalRequest = z.infer<typeof OpenTerminalRequest>;
export const TerminalSession = z.object({ sessionId: Uuid, runnerId: Uuid });
export type TerminalSession = z.infer<typeof TerminalSession>;

// ---------------------------------------------------------------------------
// Docker (architecture §12.3)
// ---------------------------------------------------------------------------

export const PortMapping = z.object({
  containerPort: z.number().int().min(1).max(65_535),
  hostPort: z.number().int().min(1).max(65_535).nullable().optional(),
  protocol: z.enum(['tcp', 'udp']).default('tcp'),
});
export type PortMapping = z.infer<typeof PortMapping>;

export const DockerEnvironment = z.object({
  id: Uuid,
  projectId: Uuid,
  name: z.string(),
  image: z.string().nullable(),
  build: z.object({ context: z.string(), dockerfile: z.string() }).nullable(),
  command: z.array(z.string()).nullable(),
  env: z.record(z.string(), z.string()),
  ports: z.array(PortMapping),
  mountWorktree: z.boolean(),
  scope: z.enum(['project', 'ticket']),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type DockerEnvironment = z.infer<typeof DockerEnvironment>;

/** `POST /workspaces/:ws/projects/:projectId/environments` (image XOR build). */
export const CreateDockerEnvironmentRequest = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/),
    image: z.string().min(1).max(300).nullable().optional(),
    build: z
      .object({ context: z.string().min(1).max(500), dockerfile: z.string().min(1).max(500) })
      .nullable()
      .optional(),
    command: z.array(z.string().max(1_000)).max(50).nullable().optional(),
    /** Non-secret variables only; secrets belong in the runner environment. */
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4_000)).default({}),
    ports: z.array(PortMapping).max(20).default([]),
    mountWorktree: z.boolean().default(true),
    scope: z.enum(['project', 'ticket']).default('project'),
  })
  .refine((v) => Boolean(v.image) !== Boolean(v.build), { message: 'set exactly one of image or build' });
export type CreateDockerEnvironmentRequest = z.infer<typeof CreateDockerEnvironmentRequest>;

export const Container = z.object({
  id: Uuid,
  environmentId: Uuid,
  environmentName: z.string(),
  ticketId: Uuid.nullable(),
  runnerId: Uuid,
  containerId: z.string(),
  name: z.string(),
  image: z.string(),
  status: z.string(),
  statusDetail: z.string().nullable(),
  ports: z.array(PortMapping),
  updatedAt: IsoDate,
});
export type Container = z.infer<typeof Container>;

/** `POST /workspaces/:ws/environments/:envId/containers` */
export const CreateContainerRequest = z.object({
  ticketId: Uuid.optional(),
  runnerId: Uuid.optional(),
  start: z.boolean().default(true),
});
export type CreateContainerRequest = z.infer<typeof CreateContainerRequest>;

export const ContainerAction = z.enum(['start', 'stop', 'restart', 'remove']);

export const ContainerStats = z.object({
  cpuPercent: z.number(),
  memoryBytes: z.number(),
  memoryLimitBytes: z.number(),
});
export type ContainerStats = z.infer<typeof ContainerStats>;

export const DockerEngineStatus = z.object({
  runnerId: Uuid,
  available: z.boolean(),
  version: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// In-app browser previews (architecture §12.4, §13.4)
// ---------------------------------------------------------------------------

export const Preview = z.object({
  id: Uuid,
  projectId: Uuid,
  ticketId: Uuid.nullable(),
  runnerId: Uuid,
  name: z.string(),
  port: z.number().int(),
  containerId: z.string().nullable(),
  status: z.enum(['open', 'closed']),
  /** `https://<slug>.preview.DOMAIN` (requires a grant before loading). */
  origin: z.string(),
  createdAt: IsoDate,
});
export type Preview = z.infer<typeof Preview>;

/** `POST /workspaces/:ws/projects/:projectId/previews` */
export const CreatePreviewRequest = z.object({
  name: z.string().min(1).max(80),
  port: z.number().int().min(1).max(65_535),
  runnerId: Uuid.optional(),
  ticketId: Uuid.optional(),
  containerRowId: Uuid.optional(),
});
export type CreatePreviewRequest = z.infer<typeof CreatePreviewRequest>;

/** `POST /workspaces/:ws/previews/:previewId/grant` — one-time URL that sets the preview cookie. */
export const PreviewGrant = z.object({ url: z.string(), expiresAt: IsoDate });
export type PreviewGrant = z.infer<typeof PreviewGrant>;

export const Attachment = z.object({
  id: Uuid,
  projectId: Uuid.nullable(),
  ticketId: Uuid.nullable(),
  kind: z.enum(['screenshot', 'canvas_export', 'image', 'console_log', 'file']),
  name: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int(),
  createdAt: IsoDate,
});
export type Attachment = z.infer<typeof Attachment>;

/** `POST /workspaces/:ws/projects/:projectId/attachments` (≤ 10 MiB). */
export const CreateAttachmentRequest = z.object({
  kind: z.enum(['screenshot', 'canvas_export', 'image', 'console_log', 'file']),
  name: z.string().min(1).max(200),
  mime: z.string().min(1).max(100),
  dataBase64: z.string().max(14_000_000),
  ticketId: Uuid.optional(),
});
export type CreateAttachmentRequest = z.infer<typeof CreateAttachmentRequest>;

/**
 * `POST /workspaces/:ws/runs/:runId/attachments` — copies attachments into the run's worktree
 * (`.coffe/context/attachments/`) and sends the agent a follow-up message pointing at them.
 */
export const SendAttachmentsRequest = z.object({
  attachmentIds: z.array(Uuid).min(1).max(10),
  message: z.string().max(10_000).default('See the attached file(s).'),
});
export type SendAttachmentsRequest = z.infer<typeof SendAttachmentsRequest>;

// ---------------------------------------------------------------------------
// Database manager (relayed to the runner; nothing persisted server-side)
// ---------------------------------------------------------------------------

export const DB_ENGINES = ['postgres', 'mysql', 'sqlite', 'mongodb', 'redis', 'clickhouse'] as const;

export const DbConnection = z.object({
  connectionId: Uuid,
  name: z.string(),
  engine: z.string(),
  display: z.string(),
  capabilities: z.array(z.enum(['connect', 'browse', 'understand', 'operate', 'broker'])),
  readOnly: z.boolean(),
});
export type DbConnection = z.infer<typeof DbConnection>;

/** `GET /workspaces/:ws/runners/:runnerId/db/connections` */
export const DbConnectionsResponse = z.object({
  connections: z.array(DbConnection),
  engines: z.array(z.string()),
});
export type DbConnectionsResponse = z.infer<typeof DbConnectionsResponse>;

/**
 * `POST /workspaces/:ws/runners/:runnerId/db/connections` — `sealed` is the base64
 * `crypto_box_seal` of the credential JSON for this runner (see architecture §14.3).
 */
export const SaveDbConnectionRequest = z.object({
  connectionId: Uuid,
  name: z.string().min(1).max(80),
  engine: z.string().min(1).max(40),
  sealed: z.string().min(1).max(100_000),
  readOnly: z.boolean().default(true),
});
export type SaveDbConnectionRequest = z.infer<typeof SaveDbConnectionRequest>;

export const DbSchemaQuery = z.object({ namespace: z.string().max(200).optional() });

/** `POST /workspaces/:ws/runners/:runnerId/db/connections/:connectionId/query` */
export const DbQueryRequest = z.object({
  query: z.string().min(1).max(200_000),
  namespace: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(10_000).default(500),
  confirmToken: z.string().max(200).optional(),
});
export type DbQueryRequest = z.infer<typeof DbQueryRequest>;

/** `POST …/connections/:connectionId/assist` — starts a read-only `query_assist` run. */
export const DbAssistRequest = z.object({
  request: z.string().min(1).max(10_000),
  namespace: z.string().max(200).optional(),
  projectId: Uuid,
  personaId: Uuid.optional(),
});
export type DbAssistRequest = z.infer<typeof DbAssistRequest>;

// ---------------------------------------------------------------------------
// SSH manager (architecture §12.6, §14)
// ---------------------------------------------------------------------------

export const SshCredential = z.object({
  runnerId: Uuid,
  authType: z.enum(['key', 'password']),
  publicKeyFingerprint: z.string().nullable(),
  createdAt: IsoDate,
});

export const SshHost = z.object({
  id: Uuid,
  name: z.string(),
  hostname: z.string(),
  port: z.number().int(),
  username: z.string(),
  hostKeyFingerprint: z.string().nullable(),
  credentials: z.array(SshCredential),
  createdAt: IsoDate,
});
export type SshHost = z.infer<typeof SshHost>;

/** `POST /workspaces/:ws/ssh/hosts` */
export const CreateSshHostRequest = z.object({
  name: z.string().min(1).max(80),
  hostname: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65_535).default(22),
  username: z.string().min(1).max(64),
});
export type CreateSshHostRequest = z.infer<typeof CreateSshHostRequest>;

/** `PUT /workspaces/:ws/ssh/hosts/:hostId/credentials/:runnerId` — ciphertext only. */
export const PutSshCredentialRequest = z.object({
  sealed: z.string().min(1).max(100_000),
  authType: z.enum(['key', 'password']),
  publicKeyFingerprint: z.string().max(200).nullable().optional(),
});
export type PutSshCredentialRequest = z.infer<typeof PutSshCredentialRequest>;

/** `POST /workspaces/:ws/ssh/hosts/:hostId/sessions` → realtime channel `ssh:<sessionId>`. */
export const OpenSshSessionRequest = z.object({
  runnerId: Uuid,
  clientPublicKey: z.string().min(1).max(200),
  headerC2s: z.string().min(1).max(200),
  cols: z.number().int().min(10).max(1_000),
  rows: z.number().int().min(5).max(500),
});
export type OpenSshSessionRequest = z.infer<typeof OpenSshSessionRequest>;
export const SshSession = z.object({ sessionId: Uuid });

/** `GET|PUT /me/vault` — passphrase-derived key never leaves the browser. */
export const Vault = z.object({
  kdf: z.object({
    alg: z.literal('argon2id13'),
    salt: z.string(),
    opslimit: z.number().int(),
    memlimit: z.number().int(),
  }),
  checkNonce: z.string(),
  checkBox: z.string(),
});
export type Vault = z.infer<typeof Vault>;

export const VaultItem = z.object({
  kind: z.enum(['ssh_key', 'db_credential']),
  refId: Uuid,
  nonce: z.string(),
  ciphertext: z.string().max(200_000),
});
export type VaultItem = z.infer<typeof VaultItem>;
