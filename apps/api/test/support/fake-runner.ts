import { generateKeyPairSync, type KeyObject, randomUUID, sign } from 'node:crypto';
import { PairingTokenResponse } from '@coffe/contracts';
import {
  type ActiveRun,
  type CliInfo,
  type Hello,
  type Pair,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  type RepoInfo,
  type RunnerMessage,
  type RunnerPublicKeys,
  type ServerEnvelope,
  type ServerMessageType,
  validateServerEnvelope,
} from '@coffe/protocol';
import { type RawData, WebSocket } from 'ws';
import { frameText } from '../../src/realtime/ws-util.js';
import type { TestApp } from './app.js';
import { Inbox } from './inbox.js';
import { api, type TestUser } from './session.js';

const RUNNER_SOCKET_PATH = '/api/runner';
const DEFAULT_TIMEOUT_MS = 5_000;
const HANDSHAKE_FRAMES: readonly ServerMessageType[] = ['welcome', 'upgrade_required', 'error'];

export const FAKE_RUNNER_VERSION = '0.1.0';

export const DEFAULT_CLI: CliInfo = {
  id: 'fake',
  name: 'Fake CLI',
  path: '/usr/local/bin/coffe-fake-cli',
  version: '0.1.0',
  auth: 'ok',
  capabilities: {
    headless: true,
    model_select: false,
    modes: ['structured', 'pty'],
    permission_callbacks: false,
    resume: true,
    schema_output: false,
    streaming_input: true,
    structured_output: true,
    tool_filters: false,
    usage_cost: true,
    usage_tokens: true,
  },
};

export const DEFAULT_REPO: RepoInfo = {
  repo_key: 'repo-1',
  name: 'demo',
  path: '/tmp/demo',
  default_branch: 'main',
  available: true,
};

/** The raw 32-byte key: the tail of the SPKI DER encoding of an Ed25519 / X25519 public key. */
function rawPublicKey(key: KeyObject): Buffer {
  return key.export({ format: 'der', type: 'spki' }).subarray(-32);
}

/**
 * Fresh runner key material as a real runner produces it: `box_key_signature` is the Ed25519
 * signature by the identity key over the raw X25519 public key.
 */
export function generateRunnerKeys(): RunnerPublicKeys {
  const identity = generateKeyPairSync('ed25519');
  const box = generateKeyPairSync('x25519');
  const boxPublicKey = rawPublicKey(box.publicKey);
  return {
    sign_public_key: rawPublicKey(identity.publicKey).toString('base64'),
    box_public_key: boxPublicKey.toString('base64'),
    box_key_signature: sign(null, boxPublicKey, identity.privateKey).toString('base64'),
  };
}

export function pairPayload(name: string, keys: RunnerPublicKeys): Pair {
  return {
    name,
    hostname: 'fake-host',
    os: 'linux',
    arch: 'x86_64',
    runner_version: FAKE_RUNNER_VERSION,
    keys,
  };
}

function runnerFrame(message: RunnerMessage, re?: string): string {
  return JSON.stringify({
    id: randomUUID(),
    ts: new Date().toISOString(),
    ...(re ? { re } : {}),
    ...message,
  });
}

/** Parses a frame from the control plane; it must be valid according to the protocol schema. */
function parseServerFrame(data: RawData): ServerEnvelope {
  const text = frameText(data);
  const frame = validateServerEnvelope(JSON.parse(text));
  if (!frame.ok) throw new Error(`the control plane sent an invalid frame (${frame.error}): ${text}`);
  return frame.value;
}

function isFrameOfType<T extends ServerMessageType>(
  frame: ServerEnvelope,
  type: T,
): frame is Extract<ServerEnvelope, { type: T }> {
  return frame.type === type;
}

function openRunnerSocket(t: TestApp, token: string, protocol: string): WebSocket {
  return new WebSocket(`${t.wsBase}${RUNNER_SOCKET_PATH}`, {
    headers: { authorization: `Bearer ${token}`, [PROTOCOL_HEADER]: protocol },
  });
}

export interface PairingExchange {
  /** Every frame the control plane sent before it closed the socket. */
  frames: ServerEnvelope[];
  closeCode: number;
}

/**
 * One pairing connection: connects with the pairing token, sends `pair` and collects what the
 * control plane answers until it closes the socket. Rejects when the upgrade is refused (the
 * error message carries the HTTP status, e.g. `Unexpected server response: 401`).
 */
export function pairWithToken(t: TestApp, pairingToken: string, pair: Pair): Promise<PairingExchange> {
  const { promise, resolve, reject } = Promise.withResolvers<PairingExchange>();
  const frames: ServerEnvelope[] = [];
  const ws = openRunnerSocket(t, pairingToken, PROTOCOL_VERSION);
  ws.once('open', () => ws.send(runnerFrame({ type: 'pair', payload: pair })));
  ws.on('message', (data) => {
    try {
      frames.push(parseServerFrame(data));
    } catch (error) {
      reject(error);
    }
  });
  ws.once('error', reject);
  ws.once('close', (code) => resolve({ frames, closeCode: code }));
  return promise;
}

export interface ConnectOptions {
  protocol?: string;
  runnerVersion?: string;
  clis?: CliInfo[];
  repos?: RepoInfo[];
  activeRuns?: ActiveRun[];
}

/**
 * A paired runner speaking the real protocol over a real socket, without a machine behind it:
 * tests script what it reports (`send`) and assert what the control plane tells it (`next`).
 */
export class FakeRunner {
  private ws: WebSocket | null = null;
  private closeCode: Promise<number> | null = null;
  /** Frames received but not yet consumed by `next`. */
  private readonly inbox = new Inbox<ServerEnvelope>();

  private constructor(
    private readonly t: TestApp,
    private readonly keys: RunnerPublicKeys,
    readonly runnerId: string,
    readonly token: string,
  ) {}

  /** Creates a pairing token over REST as `user` and pairs a new runner with it. */
  static async pair(t: TestApp, user: TestUser, opts: { name?: string } = {}): Promise<FakeRunner> {
    const created = await api(t, user).post(
      `/workspaces/${user.workspaceId}/runner-pairing-tokens`,
      { label: opts.name ?? 'fake runner' },
    );
    if (created.status !== 201) {
      throw new Error(
        `creating a pairing token failed with ${created.status}: ${JSON.stringify(created.body)}`,
      );
    }
    const { token } = PairingTokenResponse.parse(created.body);
    const keys = generateRunnerKeys();
    const exchange = await pairWithToken(t, token, pairPayload(opts.name ?? 'fake-runner', keys));
    const [paired] = exchange.frames;
    if (!paired || !isFrameOfType(paired, 'paired')) {
      throw new Error(`pairing failed: ${JSON.stringify(exchange)}`);
    }
    return new FakeRunner(t, keys, paired.payload.runner_id, paired.payload.runner_token);
  }

  /**
   * Connects with the runner token and sends `hello`. Resolves with the control plane's answer:
   * `welcome`, `upgrade_required` or `error`. Rejects when the upgrade is refused (revoked or
   * unknown token: `Unexpected server response: 401`).
   */
  async connect(opts: ConnectOptions = {}): Promise<ServerEnvelope> {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      throw new Error('the fake runner is already connected; close() it first');
    }
    const protocol = opts.protocol ?? PROTOCOL_VERSION;
    const hello: Hello = {
      runner_id: this.runnerId,
      protocol,
      runner_version: opts.runnerVersion ?? FAKE_RUNNER_VERSION,
      hostname: 'fake-host',
      os: 'linux',
      arch: 'x86_64',
      capabilities: ['pty', 'git'],
      policy: {
        allow_db: false,
        allow_db_writes: false,
        allow_docker: false,
        allow_full_auto: false,
        allow_preview_ports: '3000-9999',
        allow_push: false,
        allow_ssh: false,
        allowed_clis: null,
        enable_fake_cli: true,
        max_concurrent_runs: 4,
      },
      keys: this.keys,
      clis: opts.clis ?? [DEFAULT_CLI],
      repos: opts.repos ?? [DEFAULT_REPO],
      active_runs: opts.activeRuns ?? [],
    };

    const ws = openRunnerSocket(this.t, this.token, protocol);
    const opened = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<number>();
    this.ws = ws;
    this.closeCode = closed.promise;
    this.inbox.reset();

    ws.once('open', () => {
      ws.send(runnerFrame({ type: 'hello', payload: hello }));
      opened.resolve();
    });
    ws.once('error', (error) => {
      opened.reject(error);
      this.inbox.fail(error);
    });
    ws.on('message', (data) => this.receive(data));
    ws.once('close', (code) => {
      closed.resolve(code);
      this.inbox.fail(new Error(`the runner socket closed with ${code}`));
    });

    await opened.promise;
    return this.inbox.take(
      (frame) => HANDSHAKE_FRAMES.includes(frame.type),
      DEFAULT_TIMEOUT_MS,
      'handshake frame from the control plane',
    );
  }

  /** Sends a frame; `re` marks it as the answer to the control-plane frame with that id. */
  send(message: RunnerMessage, re?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('the fake runner is not connected');
    }
    this.ws.send(runnerFrame(message, re));
  }

  /**
   * The next frame of `type`, in arrival order; frames of other types stay buffered for later
   * calls. Rejects after `timeoutMs`, or when the socket closes before such a frame arrives.
   */
  async next<T extends ServerMessageType>(
    type: T,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<Extract<ServerEnvelope, { type: T }>> {
    const frame = await this.inbox.take(
      (candidate) => candidate.type === type,
      timeoutMs,
      `${type} frame from the control plane`,
    );
    if (!isFrameOfType(frame, type)) throw new Error(`expected ${type}, got ${frame.type}`);
    return frame;
  }

  /** The close code of the current connection, once it is closed. */
  closed(): Promise<number> {
    if (!this.closeCode) throw new Error('the fake runner never connected');
    return this.closeCode;
  }

  /** Closes the connection like a runner shutting down; a no-op when it is not connected. */
  async close(): Promise<void> {
    if (!this.ws || !this.closeCode) return;
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, 'runner stopped');
    else if (this.ws.readyState === WebSocket.CONNECTING) this.ws.terminate();
    await this.closeCode;
  }

  private receive(data: RawData): void {
    try {
      this.inbox.push(parseServerFrame(data));
    } catch (error) {
      this.inbox.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
