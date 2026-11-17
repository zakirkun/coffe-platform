import { type ClientMessage, ServerEvent } from '@coffe/contracts';
import { WebSocket } from 'ws';
import { frameText } from '../../src/realtime/ws-util.js';
import type { TestApp } from './app.js';
import { Inbox } from './inbox.js';
import type { TestUser } from './session.js';

const BROWSER_SOCKET_PATH = '/api/ws';
const DEFAULT_TIMEOUT_MS = 5_000;

type ServerEventName = ServerEvent['ev'];

function isEvent<E extends ServerEventName>(
  event: ServerEvent,
  ev: E,
): event is Extract<ServerEvent, { ev: E }> {
  return event.ev === ev;
}

/**
 * The realtime socket as a signed-in browser tab uses it (session cookie + Origin). Every event
 * must match the contracts `ServerEvent` schema.
 */
export class BrowserSocket {
  private readonly inbox = new Inbox<ServerEvent>();
  private readonly closed = Promise.withResolvers<number>();

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const text = frameText(data);
      const event = ServerEvent.safeParse(JSON.parse(text));
      if (event.success) this.inbox.push(event.data);
      else this.inbox.fail(new Error(`the control plane sent an invalid event: ${text}`));
    });
    ws.once('close', (code) => {
      this.closed.resolve(code);
      this.inbox.fail(new Error(`the browser socket closed with ${code}`));
    });
  }

  /**
   * Rejects when the upgrade is refused; the message carries the HTTP status (401 without a
   * session, 403 for a foreign origin).
   */
  static async connect(
    t: TestApp,
    user: TestUser | null,
    origin: string = t.baseUrl,
  ): Promise<BrowserSocket> {
    const ws = new WebSocket(`${t.wsBase}${BROWSER_SOCKET_PATH}`, {
      headers: { origin, ...(user ? { cookie: user.cookie } : {}) },
    });
    const socket = new BrowserSocket(ws);
    const opened = Promise.withResolvers<void>();
    ws.once('open', () => opened.resolve());
    ws.once('error', (error) => {
      opened.reject(error);
      socket.inbox.fail(error);
    });
    await opened.promise;
    return socket;
  }

  /** Subscribes to a channel and waits for the confirmation; rejects when it is refused. */
  async subscribe(channel: string): Promise<void> {
    this.ws.send(JSON.stringify({ op: 'sub', ch: channel }));
    const answer = await this.inbox.take(
      (event) => (event.ev === 'subscribed' || event.ev === 'error') && event.ch === channel,
      DEFAULT_TIMEOUT_MS,
      `answer to the subscription to ${channel}`,
    );
    if (answer.ev === 'error') {
      throw new Error(`subscribing to ${channel} failed: ${answer.code} (${answer.message})`);
    }
  }

  /** The next `ev` event, in arrival order; other events stay buffered for later calls. */
  async next<E extends ServerEventName>(
    ev: E,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<Extract<ServerEvent, { ev: E }>> {
    const event = await this.inbox.take(
      (candidate) => candidate.ev === ev,
      timeoutMs,
      `${ev} event from the control plane`,
    );
    if (!isEvent(event, ev)) throw new Error(`expected ${ev}, got ${event.ev}`);
    return event;
  }

  /** Sends a client operation such as terminal keystrokes (`run.input`) or `run.resize`. */
  send(message: ClientMessage): void {
    this.ws.send(JSON.stringify(message));
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, 'tab closed');
    else if (this.ws.readyState === WebSocket.CONNECTING) this.ws.terminate();
    await this.closed.promise;
  }
}
