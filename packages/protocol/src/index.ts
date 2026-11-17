import { randomUUID } from 'node:crypto';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import type {
  RunnerEnvelope,
  RunnerEnvelope1,
  ServerEnvelope,
  ServerEnvelope1,
} from './generated.js';
import { protocolSchema } from './schema.js';

export * from './generated.js';
export { protocolSchema } from './schema.js';

/** Union of runner -> control plane messages (`{ type, payload }`). */
export type RunnerMessage = RunnerEnvelope1;
/** Union of control plane -> runner messages (`{ type, payload }`). */
export type ServerMessage = ServerEnvelope1;
export type RunnerMessageType = RunnerMessage['type'];
export type ServerMessageType = ServerMessage['type'];
export type RunnerPayload<T extends RunnerMessageType> = Extract<
  RunnerMessage,
  { type: T }
>['payload'];
export type ServerPayload<T extends ServerMessageType> = Extract<
  ServerMessage,
  { type: T }
>['payload'];

/** WebSocket close codes used on the runner socket (architecture §8.6). */
export const CLOSE_CODES = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_VIOLATION: 4000,
  UNAUTHORIZED: 4001,
  REPLACED: 4002,
  UPGRADE_REQUIRED: 4010,
} as const;

export const PAIRING_TOKEN_PREFIX = 'coffe_pt_';
export const RUNNER_TOKEN_PREFIX = 'coffe_rt_';

/** Parses `"MAJOR.MINOR"`; `null` when malformed. */
export function parseProtocolVersion(version: string): { major: number; minor: number } | null {
  const match = /^(\d+)\.(\d+)$/.exec(version);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/** Same rule as the Rust side: equal major, peer minor >= `minMinor`. */
export function isCompatible(peer: string, ownVersion: string, minMinor: number): boolean {
  const theirs = parseProtocolVersion(peer);
  const ours = parseProtocolVersion(ownVersion);
  return !!theirs && !!ours && theirs.major === ours.major && theirs.minor >= minMinor;
}

const ajv = new Ajv2020({ allErrors: false, strict: false });
ajv.addFormat('uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
for (const numeric of [
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'int32',
  'int64',
  'float',
  'double',
]) {
  ajv.addFormat(numeric, true);
}
ajv.addSchema(protocolSchema, 'coffe');

const runnerValidator: ValidateFunction<RunnerEnvelope> = ajv.compile({
  $ref: 'coffe#/$defs/RunnerEnvelope',
});
const serverValidator: ValidateFunction<ServerEnvelope> = ajv.compile({
  $ref: 'coffe#/$defs/ServerEnvelope',
});

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function toResult<T>(validator: ValidateFunction<T>, value: unknown): ValidationResult<T> {
  if (validator(value)) return { ok: true, value };
  const first = validator.errors?.[0];
  return {
    ok: false,
    error: first
      ? `${first.instancePath || '/'} ${first.message ?? 'is invalid'}`
      : 'invalid frame',
  };
}

/** Validates an untrusted frame received from a runner. */
export function validateRunnerEnvelope(value: unknown): ValidationResult<RunnerEnvelope> {
  return toResult(runnerValidator, value);
}

/** Validates a frame received from the control plane (used by tests and tooling). */
export function validateServerEnvelope(value: unknown): ValidationResult<ServerEnvelope> {
  return toResult(serverValidator, value);
}

/** Builds a control plane -> runner envelope. */
export function serverEnvelope<T extends ServerMessageType>(
  type: T,
  payload: ServerPayload<T>,
  re?: string,
): ServerEnvelope {
  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    ...(re ? { re } : {}),
    type,
    payload,
  } as ServerEnvelope;
}
