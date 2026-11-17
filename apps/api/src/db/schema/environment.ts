/**
 * Phase 3 work-environment tables (architecture §5.6): Docker environments/containers, previews,
 * SSH hosts with E2E-sealed credentials, user vaults. Database connections are deliberately
 * absent: they exist only on runners (§12.5).
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';
import { organization, user } from './auth.js';
import { bytea, projects, runners, tickets } from './core.js';

export interface PortMappingJson {
  container_port: number;
  host_port?: number | null;
  protocol: 'tcp' | 'udp';
}

export const dockerEnvironments = pgTable(
  'docker_environments',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    image: text('image'),
    build: jsonb('build').$type<{ context: string; dockerfile: string } | null>(),
    command: jsonb('command').$type<string[] | null>(),
    /** Non-secret variables only. */
    env: jsonb('env').$type<Record<string, string>>().notNull().default({}),
    ports: jsonb('ports').$type<PortMappingJson[]>().notNull().default([]),
    mountWorktree: boolean('mount_worktree').notNull().default(true),
    scope: text('scope', { enum: ['project', 'ticket'] })
      .notNull()
      .default('project'),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex('docker_environments_project_name_uq').on(t.projectId, t.name)],
);

/** Last known state of containers the runners created (refreshed from runner reports). */
export const containers = pgTable(
  'containers',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => dockerEnvironments.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),
    runnerId: uuid('runner_id')
      .notNull()
      .references(() => runners.id, { onDelete: 'cascade' }),
    containerId: text('container_id').notNull(),
    name: text('name').notNull(),
    image: text('image').notNull(),
    status: text('status').notNull(),
    statusDetail: text('status_detail'),
    ports: jsonb('ports').$type<PortMappingJson[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex('containers_runner_container_uq').on(t.runnerId, t.containerId)],
);

export const previews = pgTable(
  'previews',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),
    runnerId: uuid('runner_id')
      .notNull()
      .references(() => runners.id, { onDelete: 'cascade' }),
    /** 128-bit random, base32 lowercase; used as the subdomain label. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    port: integer('port').notNull(),
    containerId: text('container_id'),
    status: text('status', { enum: ['open', 'closed'] })
      .notNull()
      .default('open'),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('previews_slug_uq').on(t.slug), index('previews_project_idx').on(t.projectId)],
);

export const sshHosts = pgTable(
  'ssh_hosts',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    hostname: text('hostname').notNull(),
    port: integer('port').notNull().default(22),
    username: text('username').notNull(),
    /** Display only; each runner pins host keys itself. */
    hostKeyFingerprint: text('host_key_fingerprint'),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ssh_hosts_workspace_idx').on(t.workspaceId)],
);

/** Private key sealed to one runner's box key (`crypto_box_seal`); unreadable server-side. */
export const sshCredentials = pgTable(
  'ssh_credentials',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    sshHostId: uuid('ssh_host_id')
      .notNull()
      .references(() => sshHosts.id, { onDelete: 'cascade' }),
    runnerId: uuid('runner_id')
      .notNull()
      .references(() => runners.id, { onDelete: 'cascade' }),
    sealed: bytea('sealed').notNull(),
    publicKeyFingerprint: text('public_key_fingerprint'),
    authType: text('auth_type', { enum: ['key', 'password'] }).notNull(),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('ssh_credentials_host_runner_uq').on(t.sshHostId, t.runnerId)],
);

/** Per-user passphrase vault (Argon2id-derived key; the server stores only ciphertext). */
export const userVaults = pgTable('user_vaults', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  kdf: jsonb('kdf')
    .$type<{ alg: 'argon2id13'; salt: string; opslimit: number; memlimit: number }>()
    .notNull(),
  checkNonce: text('check_nonce').notNull(),
  checkBox: text('check_box').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const vaultItems = pgTable(
  'vault_items',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['ssh_key', 'db_credential'] }).notNull(),
    refId: uuid('ref_id').notNull(),
    nonce: text('nonce').notNull(),
    ciphertext: text('ciphertext').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('vault_items_user_kind_ref_uq').on(t.userId, t.kind, t.refId)],
);
