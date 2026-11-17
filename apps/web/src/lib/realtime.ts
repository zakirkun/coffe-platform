import { type Channel, type ClientMessage, ServerEvent } from '@coffe/contracts';
import { useEffect, useRef, useSyncExternalStore } from 'react';

/** Events delivered to channel subscribers (control frames are handled by the client). */
export type ChannelEvent = Exclude<ServerEvent, { ev: 'subscribed' | 'error' | 'pong' }>;

export interface ChannelHandlers {
  onEvent: (event: ChannelEvent) => void;
  /**
   * The server confirmed the subscription — on the first subscribe and again after every
   * reconnect. Events published before this moment may have been missed: resync from REST here.
   */
  onSubscribed?: () => void;
}

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting';

/** The part of the browser `WebSocket` the client uses; tests inject a fake. */
export interface RealtimeSocket {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface RealtimeClientOptions {
  /** Resolved on every connection attempt. */
  url: () => string;
  createSocket?: (url: string) => RealtimeSocket;
  /** Reconnect delay: `min(maxDelayMs, baseDelayMs * 2^attempt)`, spread by `± jitter`. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Fraction of the delay that is randomized (0 = deterministic). */
  jitter?: number;
  /** A ping is sent at this interval; a connection that stays silent for one interval is dropped. */
  pingIntervalMs?: number;
  /** How long the socket outlives the last subscription (absorbs unmount/remount churn). */
  idleCloseMs?: number;
}

const SOCKET_OPEN = 1;

/**
 * Browser ↔ control plane realtime connection (architecture §9): one shared WebSocket,
 * ref-counted channel subscriptions, exponential-backoff reconnect with automatic re-subscribe.
 */
export class RealtimeClient {
  private readonly url: () => string;
  private readonly createSocket: (url: string) => RealtimeSocket;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitter: number;
  private readonly pingIntervalMs: number;
  private readonly idleCloseMs: number;

  private socket: RealtimeSocket | null = null;
  private state: ConnectionState = 'idle';
  private attempt = 0;
  private awaitingTraffic = false;
  /** The socket has been open since the client last went idle: the next open is a reconnect. */
  private hasOpened = false;
  private reconnectTimer: number | null = null;
  private idleTimer: number | null = null;
  private pingTimer: number | null = null;

  /** Channel → subscribers; the set size is the reference count. */
  private readonly subscriptions = new Map<string, Set<ChannelHandlers>>();
  /** Channels the server has confirmed on the current socket. */
  private readonly confirmed = new Set<string>();
  private readonly stateListeners = new Set<() => void>();
  private readonly reconnectListeners = new Set<() => void>();

  constructor(options: RealtimeClientOptions) {
    this.url = options.url;
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 15_000;
    this.jitter = options.jitter ?? 0.25;
    this.pingIntervalMs = options.pingIntervalMs ?? 25_000;
    this.idleCloseMs = options.idleCloseMs ?? 1_000;
  }

  getState = (): ConnectionState => this.state;

  onStateChange = (listener: () => void): (() => void) => {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  };

  /**
   * Fires when the connection is re-established after a drop. Channel events published in
   * between were missed; listeners should refetch what they derive from them.
   */
  onReconnect(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => {
      this.reconnectListeners.delete(listener);
    };
  }

  /**
   * Subscribes to a channel and connects if needed. The wire `sub` is sent for the first
   * subscriber only and `unsub` when the last one leaves. Returns the unsubscribe function.
   */
  subscribe(channel: Channel, handlers: ChannelHandlers): () => void {
    // A fresh object per call: the same handlers passed twice still count as two subscribers.
    const entry: ChannelHandlers = { ...handlers };
    let entries = this.subscriptions.get(channel);
    if (entries) {
      entries.add(entry);
      if (this.confirmed.has(channel) && entry.onSubscribed) {
        queueMicrotask(() => {
          if (this.confirmed.has(channel) && this.subscriptions.get(channel)?.has(entry)) {
            entry.onSubscribed?.();
          }
        });
      }
    } else {
      entries = new Set([entry]);
      this.subscriptions.set(channel, entries);
      this.send({ op: 'sub', ch: channel });
    }

    if (this.idleTimer !== null) {
      window.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (!this.socket && this.reconnectTimer === null) this.connect();

    return () => {
      const current = this.subscriptions.get(channel);
      if (!current?.delete(entry) || current.size > 0) return;
      this.subscriptions.delete(channel);
      this.confirmed.delete(channel);
      this.send({ op: 'unsub', ch: channel });
      if (this.subscriptions.size === 0) this.scheduleIdleClose();
    };
  }

  /** Sends a message if the socket is open; returns whether it was sent. */
  send(message: ClientMessage): boolean {
    if (this.socket?.readyState !== SOCKET_OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of [...this.stateListeners]) listener();
  }

  private connect(): void {
    this.setState(this.attempt === 0 && this.state === 'idle' ? 'connecting' : 'reconnecting');
    let socket: RealtimeSocket;
    try {
      socket = this.createSocket(this.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.awaitingTraffic = false;
      for (const channel of this.subscriptions.keys()) {
        socket.send(JSON.stringify({ op: 'sub', ch: channel } satisfies ClientMessage));
      }
      this.pingTimer = window.setInterval(() => this.checkLiveness(socket), this.pingIntervalMs);
      const reconnected = this.hasOpened;
      this.hasOpened = true;
      this.setState('open');
      if (reconnected) for (const listener of [...this.reconnectListeners]) listener();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.awaitingTraffic = false;
      this.handleMessage(event.data);
    };
    socket.onclose = () => {
      if (this.socket === socket) this.handleDisconnect();
    };
  }

  /** Detects half-open connections: every interval must see at least one frame (our pong). */
  private checkLiveness(socket: RealtimeSocket): void {
    if (this.socket !== socket) return;
    if (this.awaitingTraffic) {
      this.detach(socket);
      this.handleDisconnect();
      return;
    }
    this.awaitingTraffic = true;
    this.send({ op: 'ping' });
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = ServerEvent.safeParse(json);
    if (!parsed.success) {
      console.warn('[realtime] dropped an event that does not match the contract', json);
      return;
    }
    const event = parsed.data;
    if (event.ev === 'pong') return;
    if (event.ev === 'error') {
      console.warn(`[realtime] ${event.code}: ${event.message}`);
      return;
    }
    const entries = this.subscriptions.get(event.ch);
    if (!entries) return;
    // The server's ack can race with its first events: whichever arrives first confirms the
    // channel, so subscribers are always told to resync before they see a live event.
    if (!this.confirmed.has(event.ch)) {
      this.confirmed.add(event.ch);
      for (const entry of [...entries]) entry.onSubscribed?.();
    }
    if (event.ev === 'subscribed') return;
    for (const entry of [...entries]) entry.onEvent(event);
  }

  private handleDisconnect(): void {
    this.socket = null;
    this.confirmed.clear();
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.subscriptions.size === 0) {
      this.resetToIdle();
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.setState('reconnecting');
    const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** this.attempt);
    const delay = exponential * (1 + this.jitter * (Math.random() * 2 - 1));
    this.attempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.subscriptions.size > 0) this.connect();
      else this.resetToIdle();
    }, delay);
  }

  private scheduleIdleClose(): void {
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null;
      if (this.subscriptions.size > 0) return;
      if (this.reconnectTimer !== null) {
        window.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      if (this.socket) this.detach(this.socket);
      this.handleDisconnect();
    }, this.idleCloseMs);
  }

  private resetToIdle(): void {
    this.attempt = 0;
    this.hasOpened = false;
    this.setState('idle');
  }

  /** Closes a socket without letting its late events reach this client. */
  private detach(socket: RealtimeSocket): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.close();
  }
}

/** `NEXT_PUBLIC_WS_URL`, or the page origin with the `ws`/`wss` scheme. */
function realtimeUrl(): string {
  const configured = process.env.NEXT_PUBLIC_WS_URL;
  if (configured) return configured;
  const { protocol, host } = window.location;
  return `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}/api/ws`;
}

let sharedClient: RealtimeClient | null = null;

/** The app-wide connection (created lazily; it only connects once something subscribes). */
export function getRealtimeClient(): RealtimeClient {
  sharedClient ??= new RealtimeClient({ url: realtimeUrl });
  return sharedClient;
}

/**
 * Subscribes to a channel for the lifetime of the component. Handlers may change between
 * renders without re-subscribing; pass `null` to stay unsubscribed.
 */
export function useChannel(
  channel: Channel | null | undefined,
  onEvent: (event: ChannelEvent) => void,
  onSubscribed?: () => void,
): void {
  const handlers = useRef({ onEvent, onSubscribed });
  useEffect(() => {
    handlers.current = { onEvent, onSubscribed };
  });

  useEffect(() => {
    if (!channel) return;
    return getRealtimeClient().subscribe(channel, {
      onEvent: (event) => handlers.current.onEvent(event),
      onSubscribed: () => handlers.current.onSubscribed?.(),
    });
  }, [channel]);
}

function serverConnectionState(): ConnectionState {
  return 'idle';
}

/** Connection state of the shared client, for the "live / reconnecting" indicator. */
export function useConnectionState(): ConnectionState {
  const client = getRealtimeClient();
  return useSyncExternalStore(client.onStateChange, client.getState, serverConnectionState);
}
