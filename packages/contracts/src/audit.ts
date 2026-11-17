import { z } from 'zod';
import { IsoDate } from './common.js';

export const AUDIT_ACTOR_TYPES = ['user', 'runner', 'agent', 'system'] as const;

export const AuditLogEntry = z.object({
  id: z.number().int(),
  ts: IsoDate,
  actorType: z.enum(AUDIT_ACTOR_TYPES),
  actorUserId: z.string().nullable(),
  actorName: z.string().nullable(),
  runnerId: z.string().nullable(),
  personaId: z.string().nullable(),
  runId: z.string().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  command: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
});
export type AuditLogEntry = z.infer<typeof AuditLogEntry>;

/** `GET /workspaces/:ws/audit?cursor=&limit=&runId=&action=` (newest first). */
export const AuditQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  runId: z.string().optional(),
  action: z.string().optional(),
});
export type AuditQuery = z.infer<typeof AuditQuery>;

export const AuditPage = z.object({
  items: z.array(AuditLogEntry),
  nextCursor: z.string().nullable(),
});
export type AuditPage = z.infer<typeof AuditPage>;
