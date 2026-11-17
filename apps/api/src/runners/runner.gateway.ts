import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  CLOSE_CODES,
  isCompatible,
  PAIRING_TOKEN_PREFIX,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  parseProtocolVersion,
  type RunnerMessageType,
  RUNNER_TOKEN_PREFIX,
  type ServerMessageType,
  type ServerPayload,
  serverEnvelope,
  validateRunnerEnvelope,
} from '@coffe/protocol';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { AppConfig } from '../config/env.js';
import { rejectUpgrade, UpgradeRouter } from '../realtime/upgrade-router.js';
import { closeSockets, frameText } from '../realtime/ws-util.js';
import { SERVER_VERSION } from '../version.js';
import { type RunnerConnection, RunnerHub } from './runner-hub.js';
import { checkRunnerKeys } from './runner-keys.js';
import { type PairingTokenRow, RunnerRegistry, type RunnerRow } from './runner-registry.js';
import { isVersionAtLeast } from './semver.js';

export const RUNNER_SOCKET_PATH = '/api/runner';
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** Architecture §8.6: WS ping every 20 s, runner heartbeat every 30 s. */
const PING_INTERVAL_MS = 20_000;
const HEARTBEAT_SECS = 30;
const MAX_INVALID_FRAMES = 5;
/** `run.completed` carries a patch of up to 2 MiB, `git.file.result` a base64 file. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** `last_seen_at` is written at most this often per connection. */
const TOUCH_INTERVAL_MS = 15_000;
/** Unprocessed frames per connection before reading from the socket is paused. */
const MAX_PENDING_FRAMES = 512;

const KNOWN_RUNNER_TYPES: Record<RunnerMessageType, true> = {
  pair: true,
  hello: true,
  heartbeat: true,
  ack: true,
  error: true,
  'run.state': true,
  'run.output': true,
  'run.event': true,
  'run.usage': true,
  'run.completed': true,
  'clis.updated': true,
  'repos.updated': true,
  'git.diff.result': true,
  'git.file.result': true,
  'git.merge.result': true,
  'pty.output': true,
  'pty.exit': true,
};

interface RunnerSession extends RunnerConnection {
  readonly runner: RunnerRow;
  /** `hello` was accepted and `welcome` sent. */
  ready: boolean;
  alive: boolean;
  invalidFrames: number;
  pending: number;
  queue: Promise<void>;
  lastTouch: number;
  helloTimer: NodeJS.Timeout | undefined;
}

/**
 * The few fields read from a frame that failed (or has not yet passed) schema validation; a
 * field of the wrong type reads as absent.
 */
const FramePeek = z.object({
  id: z.uuid().optional().catch(undefined),
  re: z.string().optional().catch(undefined),
  type: z.string().optional().catch(undefined),
  payload: z
    .object({
      protocol: z.string().optional().catch(undefined),
      runner_version: z.string().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});
type FramePeek = z.infer<typeof FramePeek>;
const EMPTY_PEEK: FramePeek = FramePeek.parse({});

function peekFrame(json: unknown): FramePeek {
  const peek = FramePeek.safeParse(json);
  return peek.success ? peek.data : EMPTY_PEEK;
}

function bearerToken(request: IncomingMessage): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '');
  return match?.[1] ?? null;
}

/**
 * Runner endpoint `/api/runner` (architecture §8): authenticates the bearer token before the
 * upgrade, then runs either the one-shot pairing exchange (`coffe_pt_…`) or a runner session
 * (`coffe_rt_…`: `hello` → `welcome`, validated frames, heartbeats).
 */
@Injectable()
export class RunnerGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RunnerGateway.name);
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  private readonly sockets = new Set<WebSocket>();
  private readonly sessions = new Set<RunnerSession>();
  private pingTimer: NodeJS.Timeout | undefined;
  private closing = false;

  constructor(
    private readonly config: AppConfig,
    private readonly router: UpgradeRouter,
    private readonly registry: RunnerRegistry,
    private readonly hub: RunnerHub,
  ) {}

  onModuleInit(): void {
    this.router.register(RUNNER_SOCKET_PATH, (request, socket, head) =>
      this.handleUpgrade(request, socket, head),
    );
    this.pingTimer = setInterval(() => this.pingAll(), PING_INTERVAL_MS);
    this.pingTimer.unref();
  }

  /** Server restart: runners get 1001 and reconnect; their rows are offline until they do. */
  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    clearInterval(this.pingTimer);
    await closeSockets(this.sockets, CLOSE_CODES.GOING_AWAY, 'server shutting down');
    await Promise.all([...this.sessions].map((session) => session.queue));
  }

  private async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (this.closing) {
      rejectUpgrade(socket, 503);
      return;
    }
    const token = bearerToken(request);
    const header = request.headers[PROTOCOL_HEADER.toLowerCase()];
    const protocol = typeof header === 'string' ? header : null;

    if (token?.startsWith(PAIRING_TOKEN_PREFIX)) {
      const pairingToken = await this.registry.findPairingToken(token);
      if (!pairingToken) {
        rejectUpgrade(socket, 401, 'Pairing token is unknown, expired or already used');
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) =>
        this.acceptPairing(ws, pairingToken, protocol),
      );
      return;
    }
    if (token?.startsWith(RUNNER_TOKEN_PREFIX)) {
      const runner = await this.registry.findRunnerByToken(token);
      if (!runner) {
        rejectUpgrade(socket, 401, 'Runner token is unknown or revoked');
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) =>
        this.acceptSession(ws, runner, protocol),
      );
      return;
    }
    rejectUpgrade(socket, 401, 'A runner or pairing token is required');
  }

  // --- pairing connection ---------------------------------------------------------------------

  private acceptPairing(ws: WebSocket, token: PairingTokenRow, protocol: string | null): void {
    this.track(ws);
    if (protocol !== null && !this.isProtocolCompatible(protocol)) {
      this.requireUpgrade(ws);
      return;
    }
    const timer = setTimeout(
      () => this.fail(ws, CLOSE_CODES.PROTOCOL_VIOLATION, 'handshake_timeout', 'no pair frame within 10 s'),
      HANDSHAKE_TIMEOUT_MS,
    );
    ws.once('close', () => clearTimeout(timer));
    ws.once('message', (data, isBinary) => {
      clearTimeout(timer);
      this.pair(ws, token, data, isBinary).catch((error: unknown) => {
        this.logError('pairing failed', error);
        this.fail(ws, 1011, 'internal', 'pairing failed');
      });
    });
  }

  private async pair(
    ws: WebSocket,
    token: PairingTokenRow,
    data: RawData,
    isBinary: boolean,
  ): Promise<void> {
    let json: unknown;
    try {
      json = isBinary ? undefined : JSON.parse(frameText(data));
    } catch {
      json = undefined;
    }
    const frame = validateRunnerEnvelope(json);
    if (!frame.ok || frame.value.type !== 'pair') {
      this.fail(
        ws,
        CLOSE_CODES.PROTOCOL_VIOLATION,
        'invalid_payload',
        frame.ok ? 'expected a pair frame' : frame.error,
        peekFrame(json).id,
      );
      return;
    }
    const pair = frame.value.payload;
    const keys = checkRunnerKeys(pair.keys);
    if (!keys.ok) {
      this.fail(ws, CLOSE_CODES.PROTOCOL_VIOLATION, 'invalid_signature', keys.reason, frame.value.id);
      return;
    }
    const paired = await this.registry.pair(token, pair, keys.signPublicKey);
    if (!paired) {
      this.fail(
        ws,
        CLOSE_CODES.UNAUTHORIZED,
        'token_consumed',
        'the pairing token was already used or has expired',
        frame.value.id,
      );
      return;
    }
    this.sendFrame(ws, 'paired', paired, frame.value.id);
    ws.close(CLOSE_CODES.NORMAL, 'paired');
  }

  // --- runner session -------------------------------------------------------------------------

  private acceptSession(ws: WebSocket, runner: RunnerRow, protocol: string | null): void {
    this.track(ws);
    if (protocol !== null && !this.isProtocolCompatible(protocol)) {
      this.requireUpgrade(ws);
      return;
    }
    const session: RunnerSession = {
      runnerId: runner.id,
      workspaceId: runner.workspaceId,
      ws,
      runner,
      ready: false,
      alive: true,
      invalidFrames: 0,
      pending: 0,
      queue: Promise.resolve(),
      lastTouch: 0,
      helloTimer: setTimeout(
        () => this.fail(ws, CLOSE_CODES.PROTOCOL_VIOLATION, 'handshake_timeout', 'no hello within 10 s'),
        HANDSHAKE_TIMEOUT_MS,
      ),
    };
    this.sessions.add(session);
    ws.on('pong', () => {
      session.alive = true;
    });
    ws.on('message', (data, isBinary) => this.onMessage(session, data, isBinary));
    ws.on('close', () => {
      clearTimeout(session.helloTimer);
      // After the frames already received, so the final state of the session is consistent.
      session.queue = session.queue.then(() => this.onClosed(session));
    });
  }

  private onMessage(session: RunnerSession, data: RawData, isBinary: boolean): void {
    session.alive = true;
    let json: unknown;
    try {
      if (isBinary) throw new SyntaxError('binary frame');
      json = JSON.parse(frameText(data));
    } catch {
      this.rejectFrame(session, undefined, 'invalid_payload', 'frames must be JSON text');
      return;
    }
    // Replies settle their request immediately instead of waiting behind queued run frames.
    if (session.ready && peekFrame(json).re !== undefined) {
      const reply = validateRunnerEnvelope(json);
      if (reply.ok && this.hub.resolveReply(session, reply.value)) return;
    }
    session.pending += 1;
    if (session.pending >= MAX_PENDING_FRAMES) session.ws.pause();
    session.queue = session.queue
      .then(() => (session.ready ? this.handleFrame(session, json) : this.handleHello(session, json)))
      .catch((error: unknown) => {
        this.logError(`frame from runner ${session.runnerId} failed`, error);
        this.sendFrame(
          session.ws,
          'error',
          { code: 'internal', message: 'the control plane failed to process the frame' },
          peekFrame(json).id,
        );
      })
      .finally(() => {
        session.pending -= 1;
        if (session.pending < MAX_PENDING_FRAMES / 2 && session.ws.isPaused) session.ws.resume();
      });
  }

  private async handleHello(session: RunnerSession, json: unknown): Promise<void> {
    const { ws } = session;
    const peek = peekFrame(json);
    const helloProtocol = peek.type === 'hello' ? peek.payload?.protocol : undefined;
    if (helloProtocol !== undefined && !this.isProtocolCompatible(helloProtocol)) {
      await this.registry.recordVersions(
        session.runnerId,
        peek.payload?.runner_version ?? null,
        helloProtocol,
      );
      this.requireUpgrade(ws);
      return;
    }
    const frame = validateRunnerEnvelope(json);
    if (!frame.ok || frame.value.type !== 'hello') {
      this.fail(
        ws,
        CLOSE_CODES.PROTOCOL_VIOLATION,
        'invalid_payload',
        frame.ok ? 'expected a hello frame' : frame.error,
        peekFrame(json).id,
      );
      return;
    }
    const hello = frame.value.payload;
    if (!isVersionAtLeast(hello.runner_version, this.config.runnerMinVersion)) {
      await this.registry.recordVersions(session.runnerId, hello.runner_version, hello.protocol);
      this.requireUpgrade(ws);
      return;
    }
    const keys = checkRunnerKeys(hello.keys);
    const pairedKey = Buffer.from(session.runner.signPublicKey, 'base64');
    if (
      hello.runner_id !== session.runnerId ||
      !keys.ok ||
      !keys.signPublicKey.equals(pairedKey)
    ) {
      this.fail(
        ws,
        CLOSE_CODES.UNAUTHORIZED,
        'unauthorized',
        'runner id or keys do not match the paired runner; pair again',
        frame.value.id,
      );
      return;
    }
    if (!(await this.registry.applyHello(session.runnerId, hello))) {
      this.fail(ws, CLOSE_CODES.UNAUTHORIZED, 'unauthorized', 'the runner was revoked', frame.value.id);
      return;
    }
    const cursors = await this.registry.welcomeCursors(session.runnerId, hello.active_runs);

    clearTimeout(session.helloTimer);
    this.hub
      .connectionOf(session.runnerId)
      ?.ws.close(CLOSE_CODES.REPLACED, 'replaced by a newer connection');
    session.ready = true;
    session.lastTouch = Date.now();
    this.hub.attach(session);
    this.sendFrame(
      ws,
      'welcome',
      {
        protocol: PROTOCOL_VERSION,
        server_time: new Date().toISOString(),
        server_version: SERVER_VERSION,
        heartbeat_secs: HEARTBEAT_SECS,
        resume: cursors.resume,
        cancel: cursors.cancel,
      },
      frame.value.id,
    );
    await this.registry.publishStatus(session.runnerId);
    await this.hub.emitRunnerOnline({
      runnerId: session.runnerId,
      workspaceId: session.workspaceId,
      activeRunIds: hello.active_runs.map((run) => run.run_id),
    });
  }

  private async handleFrame(session: RunnerSession, json: unknown): Promise<void> {
    const frame = validateRunnerEnvelope(json);
    if (!frame.ok) {
      const { id, type } = peekFrame(json);
      const unsupported = type !== undefined && !Object.hasOwn(KNOWN_RUNNER_TYPES, type);
      this.rejectFrame(session, id, unsupported ? 'unsupported_type' : 'invalid_payload', frame.error);
      return;
    }
    const envelope = frame.value;
    await this.touch(session);

    switch (envelope.type) {
      case 'heartbeat':
      case 'ack':
        return;
      case 'error':
        this.logger.warn(
          `runner ${session.runnerId} reported ${envelope.payload.code}: ${envelope.payload.message}`,
        );
        return;
      case 'run.state':
      case 'run.output':
      case 'run.event':
      case 'run.usage':
      case 'run.completed':
        if (!(await this.hub.handleRunFrame(session, envelope))) {
          this.replyUnsupported(session, envelope.id, envelope.type);
        }
        return;
      case 'clis.updated':
        await this.registry.replaceClis(session.runnerId, envelope.payload.clis);
        await this.registry.publishStatus(session.runnerId);
        return;
      case 'repos.updated':
        await this.registry.syncRepos(session.runnerId, envelope.payload.repos);
        await this.registry.publishStatus(session.runnerId);
        return;
      case 'git.diff.result':
      case 'git.file.result':
      case 'git.merge.result':
        // The request already timed out or was never ours; nothing waits for this result.
        return;
      case 'pair':
      case 'hello':
        this.rejectFrame(session, envelope.id, 'invalid_payload', `unexpected ${envelope.type} frame`);
        return;
      case 'pty.output':
      case 'pty.exit':
        this.replyUnsupported(session, envelope.id, envelope.type);
        return;
    }
  }

  private async onClosed(session: RunnerSession): Promise<void> {
    this.sessions.delete(session);
    if (!session.ready || !this.hub.detach(session)) return;
    try {
      if (await this.registry.markOffline(session.runnerId)) {
        await this.registry.publishStatus(session.runnerId);
      }
    } catch (error) {
      this.logError(`marking runner ${session.runnerId} offline failed`, error);
    }
  }

  // --- helpers --------------------------------------------------------------------------------

  private track(ws: WebSocket): void {
    this.sockets.add(ws);
    ws.on('close', () => this.sockets.delete(ws));
    ws.on('error', (error) => this.logger.debug(`runner socket error: ${error.message}`));
  }

  private isProtocolCompatible(protocol: string): boolean {
    return isCompatible(protocol, PROTOCOL_VERSION, this.config.protocolMinMinor);
  }

  private async touch(session: RunnerSession): Promise<void> {
    const now = Date.now();
    if (now - session.lastTouch < TOUCH_INTERVAL_MS) return;
    session.lastTouch = now;
    await this.registry.touch(session.runnerId);
  }

  private sendFrame<T extends ServerMessageType>(
    ws: WebSocket,
    type: T,
    payload: ServerPayload<T>,
    re?: string,
  ): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(serverEnvelope(type, payload, re)));
  }

  /** `error` frame followed by a close with `closeCode`. */
  private fail(ws: WebSocket, closeCode: number, code: string, message: string, re?: string): void {
    this.sendFrame(ws, 'error', { code, message }, re);
    ws.close(closeCode, code);
  }

  /** An invalid frame: `error` reply; the fifth one ends the connection (protocol violation). */
  private rejectFrame(session: RunnerSession, re: string | undefined, code: string, message: string): void {
    session.invalidFrames += 1;
    if (session.invalidFrames >= MAX_INVALID_FRAMES) {
      this.fail(session.ws, CLOSE_CODES.PROTOCOL_VIOLATION, code, message, re);
      return;
    }
    this.sendFrame(session.ws, 'error', { code, message }, re);
  }

  private replyUnsupported(session: RunnerSession, re: string, type: string): void {
    this.sendFrame(
      session.ws,
      'error',
      { code: 'unsupported_type', message: `${type} is not handled by this control plane` },
      re,
    );
  }

  private requireUpgrade(ws: WebSocket): void {
    const own = parseProtocolVersion(PROTOCOL_VERSION);
    this.sendFrame(ws, 'upgrade_required', {
      min_protocol: `${own?.major ?? 1}.${this.config.protocolMinMinor}`,
      min_runner_version: this.config.runnerMinVersion,
      message: 'This coffe-runner is too old for the control plane. Update it and start it again.',
      download_url: null,
    });
    ws.close(CLOSE_CODES.UPGRADE_REQUIRED, 'upgrade required');
  }

  private pingAll(): void {
    for (const session of this.sessions) {
      if (!session.ready) continue;
      if (!session.alive) {
        session.ws.terminate();
        continue;
      }
      session.alive = false;
      session.ws.ping();
    }
  }

  private logError(context: string, error: unknown): void {
    this.logger.error(
      `${context}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
}
