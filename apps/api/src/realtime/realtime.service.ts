import type { ServerEvent } from '@coffe/contracts';
import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';
import type { AuthUser } from '../auth/request-context.js';

/** Architecture §8.5: a browser socket buffering more than this is dropped and resyncs via REST. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

type WithoutChannel<E> = E extends unknown ? Omit<E, 'ch'> : never;
/** An event addressed to a channel; `publish` adds the `ch` field. */
export type ChannelEvent = WithoutChannel<
  Exclude<ServerEvent, { ev: 'subscribed' | 'error' | 'pong' }>
>;

/** One authenticated browser socket. */
export interface RealtimeClient {
  readonly ws: WebSocket;
  readonly user: AuthUser;
  readonly channels: Set<string>;
}

/** Channel subscriptions and fan-out to browser sockets (architecture §9). */
@Injectable()
export class RealtimeService {
  private readonly subscribers = new Map<string, Set<RealtimeClient>>();

  subscribe(client: RealtimeClient, channel: string): void {
    client.channels.add(channel);
    let clients = this.subscribers.get(channel);
    if (!clients) {
      clients = new Set();
      this.subscribers.set(channel, clients);
    }
    clients.add(client);
  }

  unsubscribe(client: RealtimeClient, channel: string): void {
    client.channels.delete(channel);
    const clients = this.subscribers.get(channel);
    if (!clients) return;
    clients.delete(client);
    if (clients.size === 0) this.subscribers.delete(channel);
  }

  /** Removes a closed socket from every channel. */
  drop(client: RealtimeClient): void {
    for (const channel of [...client.channels]) this.unsubscribe(client, channel);
  }

  publish(channel: string, event: ChannelEvent): void {
    const clients = this.subscribers.get(channel);
    if (!clients || clients.size === 0) return;
    const frame = JSON.stringify({ ...event, ch: channel });
    for (const client of clients) this.deliver(client, frame);
  }

  /** Sends one serialized event; a socket that cannot keep up is terminated instead. */
  deliver(client: RealtimeClient, frame: string): void {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    if (client.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      client.ws.terminate();
      return;
    }
    client.ws.send(frame);
  }
}
