import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { ClientMessage, type ServerEvent } from '@coffe/contracts';
import { CLOSE_CODES } from '@coffe/protocol';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';
import type { CoffeAuth } from '../auth/auth.js';
import { AUTH } from '../auth/auth.tokens.js';
import type { AuthUser } from '../auth/request-context.js';
import { ApiException } from '../common/api-error.js';
import { AppConfig } from '../config/env.js';
import { ChannelAuthorizer } from './channel-authorizer.js';
import { type RealtimeClient, RealtimeService } from './realtime.service.js';
import { rejectUpgrade, UpgradeRouter } from './upgrade-router.js';
import { closeSockets, frameText } from './ws-util.js';

export const BROWSER_SOCKET_PATH = '/api/ws';
const PING_INTERVAL_MS = 25_000;
const MAX_FRAME_BYTES = 64 * 1024;
/** Unprocessed messages per socket before reading from it is paused. */
const MAX_PENDING_MESSAGES = 256;

/** Client operations relayed to a runner; their handlers are registered by the owning module. */
export type RelayedOp = 'run.input' | 'run.resize';
export type RelayedOpHandler<O extends RelayedOp> = (
  user: AuthUser,
  message: Extract<ClientMessage, { op: O }>,
) => Promise<void>;

interface BrowserClient extends RealtimeClient {
  alive: boolean;
  pending: number;
  queue: Promise<void>;
}

/**
 * Browser realtime endpoint `/api/ws` (architecture §9): the session cookie and the Origin are
 * checked before the upgrade completes; afterwards the socket speaks contracts `ClientMessage` /
 * `ServerEvent`.
 */
@Injectable()
export class BrowserGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BrowserGateway.name);
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  private readonly clients = new Set<BrowserClient>();
  private readonly ops: { [O in RelayedOp]?: RelayedOpHandler<O> } = {};
  private pingTimer: NodeJS.Timeout | undefined;
  private closing = false;

  constructor(
    @Inject(AUTH) private readonly auth: CoffeAuth,
    private readonly config: AppConfig,
    private readonly router: UpgradeRouter,
    private readonly realtime: RealtimeService,
    private readonly authorizer: ChannelAuthorizer,
  ) {}

  onModuleInit(): void {
    this.router.register(BROWSER_SOCKET_PATH, (request, socket, head) =>
      this.handleUpgrade(request, socket, head),
    );
    this.pingTimer = setInterval(() => this.pingAll(), PING_INTERVAL_MS);
    this.pingTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    clearInterval(this.pingTimer);
    await closeSockets(
      [...this.clients].map((client) => client.ws),
      CLOSE_CODES.GOING_AWAY,
      'server shutting down',
    );
  }

  registerOp<O extends RelayedOp>(op: O, handler: RelayedOpHandler<O>): void {
    Object.assign(this.ops, { [op]: handler });
  }

  private async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (this.closing) {
      rejectUpgrade(socket, 503);
      return;
    }
    // Browsers always send Origin on WebSocket handshakes; a foreign page must not ride the cookie.
    const { origin } = request.headers;
    if (origin !== undefined && !this.config.trustedOrigins.includes(origin)) {
      rejectUpgrade(socket, 403, 'Origin not allowed');
      return;
    }
    const session = await this.auth.getSession(fromNodeHeaders(request.headers));
    if (!session) {
      rejectUpgrade(socket, 401);
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => this.accept(ws, session.user));
  }

  private accept(ws: WebSocket, user: AuthUser): void {
    const client: BrowserClient = {
      ws,
      user,
      channels: new Set(),
      alive: true,
      pending: 0,
      queue: Promise.resolve(),
    };
    this.clients.add(client);
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('error', (error) => this.logger.debug(`browser socket error: ${error.message}`));
    ws.on('close', () => {
      this.clients.delete(client);
      this.realtime.drop(client);
    });
    ws.on('message', (data, isBinary) => this.enqueue(client, data, isBinary));
  }

  /** Messages of one socket are handled strictly in order (keystrokes must not be reordered). */
  private enqueue(client: BrowserClient, data: RawData, isBinary: boolean): void {
    client.pending += 1;
    if (client.pending >= MAX_PENDING_MESSAGES) client.ws.pause();
    client.queue = client.queue
      .then(() => this.handleMessage(client, data, isBinary))
      .catch((error: unknown) => {
        this.logger.error(
          `browser message failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
        this.send(client, { ev: 'error', code: 'internal_error', message: 'Internal server error' });
      })
      .finally(() => {
        client.pending -= 1;
        if (client.pending < MAX_PENDING_MESSAGES / 2 && client.ws.isPaused) client.ws.resume();
      });
  }

  private async handleMessage(client: BrowserClient, data: RawData, isBinary: boolean): Promise<void> {
    if (isBinary) {
      this.send(client, { ev: 'error', code: 'invalid_message', message: 'Text frames only' });
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(frameText(data));
    } catch {
      this.send(client, { ev: 'error', code: 'invalid_message', message: 'Invalid JSON' });
      return;
    }
    const parsed = ClientMessage.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      this.send(client, {
        ev: 'error',
        code: 'invalid_message',
        message: issue ? `${issue.path.join('.') || 'message'}: ${issue.message}` : 'Invalid message',
      });
      return;
    }
    const message = parsed.data;
    switch (message.op) {
      case 'ping':
        this.send(client, { ev: 'pong' });
        return;
      case 'sub':
        if (!(await this.authorizer.canSubscribe(client.user.id, message.ch))) {
          this.send(client, {
            ev: 'error',
            ch: message.ch,
            code: 'forbidden',
            message: 'You cannot subscribe to this channel',
          });
          return;
        }
        this.realtime.subscribe(client, message.ch);
        this.send(client, { ev: 'subscribed', ch: message.ch });
        return;
      case 'unsub':
        this.realtime.unsubscribe(client, message.ch);
        return;
      case 'run.input':
        await this.relay(client, this.ops['run.input'], message);
        return;
      case 'run.resize':
        await this.relay(client, this.ops['run.resize'], message);
        return;
    }
  }

  private async relay<O extends RelayedOp>(
    client: BrowserClient,
    handler: RelayedOpHandler<O> | undefined,
    message: Extract<ClientMessage, { op: O }>,
  ): Promise<void> {
    if (!handler) {
      this.send(client, { ev: 'error', code: 'unsupported', message: 'Operation is not available' });
      return;
    }
    try {
      await handler(client.user, message);
    } catch (error) {
      if (!(error instanceof ApiException)) throw error;
      this.send(client, { ev: 'error', code: error.code, message: error.message });
    }
  }

  private send(client: BrowserClient, event: ServerEvent): void {
    this.realtime.deliver(client, JSON.stringify(event));
  }

  private pingAll(): void {
    for (const client of this.clients) {
      if (!client.alive) {
        client.ws.terminate();
        continue;
      }
      client.alive = false;
      client.ws.ping();
    }
  }
}
