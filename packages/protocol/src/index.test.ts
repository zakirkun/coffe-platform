import { describe, expect, it } from 'vitest';
import {
  isCompatible,
  PROTOCOL_VERSION,
  serverEnvelope,
  validateRunnerEnvelope,
  validateServerEnvelope,
} from './index.js';

const RUN_ID = '0193f7c2-0000-7000-8000-000000000001';

describe('validateRunnerEnvelope', () => {
  it('accepts a well-formed run.output frame', () => {
    const frame = {
      id: '0193f7c2-0000-7000-8000-000000000002',
      ts: '2026-11-16T10:00:00.000Z',
      type: 'run.output',
      payload: { run_id: RUN_ID, seq: 1, data: 'aGk=' },
    };
    expect(validateRunnerEnvelope(frame)).toEqual({ ok: true, value: frame });
  });

  it('accepts unknown extra fields for forward compatibility', () => {
    const frame = {
      id: '0193f7c2-0000-7000-8000-000000000002',
      ts: 't',
      type: 'heartbeat',
      payload: { running_runs: 0, from_a_newer_runner: true },
    };
    expect(validateRunnerEnvelope(frame).ok).toBe(true);
  });

  it('rejects a payload that does not match its type', () => {
    const result = validateRunnerEnvelope({
      id: '0193f7c2-0000-7000-8000-000000000002',
      ts: 't',
      type: 'run.output',
      payload: { run_id: RUN_ID, data: 'aGk=' },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects unknown message types and non-uuid ids', () => {
    expect(
      validateRunnerEnvelope({ id: 'x', ts: 't', type: 'heartbeat', payload: { running_runs: 1 } })
        .ok,
    ).toBe(false);
    expect(
      validateRunnerEnvelope({
        id: '0193f7c2-0000-7000-8000-000000000002',
        ts: 't',
        type: 'run.teleport',
        payload: {},
      }).ok,
    ).toBe(false);
  });
});

describe('serverEnvelope', () => {
  it('builds frames that pass the server schema', () => {
    const frame = serverEnvelope('run.signal', { run_id: RUN_ID, signal: 'pause' });
    expect(validateServerEnvelope(frame).ok).toBe(true);
    expect(frame.type).toBe('run.signal');
  });
});

describe('isCompatible', () => {
  it('requires the same major and a minimum minor', () => {
    expect(isCompatible(PROTOCOL_VERSION, PROTOCOL_VERSION, 0)).toBe(true);
    expect(isCompatible('1.4', '1.0', 2)).toBe(true);
    expect(isCompatible('1.1', '1.0', 2)).toBe(false);
    expect(isCompatible('2.0', '1.0', 0)).toBe(false);
    expect(isCompatible('nope', '1.0', 0)).toBe(false);
  });
});
