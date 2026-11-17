import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ChannelEvent, RealtimeClient, type RealtimeSocket } from './realtime';

const RUN_ID = '0b9f6a52-8a43-4c4f-9d6c-1f2e3d4c5b6a';

class FakeSocket implements RealtimeSocket {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly sent: unknown[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  receive(message: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close'));
  }
}

describe('RealtimeClient', () => {
  let sockets: FakeSocket[];
  let client: RealtimeClient;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    client = new RealtimeClient({
      url: () => 'ws://test/api/ws',
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      baseDelayMs: 100,
      jitter: 0,
      idleCloseMs: 50,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('subscribes once per channel and delivers events to every subscriber', () => {
    const first: ChannelEvent[] = [];
    const second: ChannelEvent[] = [];
    client.subscribe(`run:${RUN_ID}`, { onEvent: (event) => first.push(event) });
    client.subscribe(`run:${RUN_ID}`, { onEvent: (event) => second.push(event) });
    const [socket] = sockets;
    if (!socket) throw new Error('no socket was opened');
    socket.open();

    expect(socket.sent).toEqual([{ op: 'sub', ch: `run:${RUN_ID}` }]);
    socket.receive({ ev: 'run.output', ch: `run:${RUN_ID}`, runId: RUN_ID, seq: 1, data: 'aGk=' });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  it('confirms the subscription before the first live event and again after a reconnect', () => {
    const calls: string[] = [];
    client.subscribe(`run:${RUN_ID}`, {
      onEvent: (event) => calls.push(event.ev),
      onSubscribed: () => calls.push('subscribed'),
    });
    const [first] = sockets;
    if (!first) throw new Error('no socket was opened');
    first.open();
    // The first event arrives before the server's `subscribed` ack.
    first.receive({ ev: 'run.output', ch: `run:${RUN_ID}`, runId: RUN_ID, seq: 1, data: 'aGk=' });
    first.receive({ ev: 'subscribed', ch: `run:${RUN_ID}` });
    expect(calls).toEqual(['subscribed', 'run.output']);

    first.drop();
    expect(client.getState()).toBe('reconnecting');
    vi.advanceTimersByTime(100);
    const second = sockets[1];
    if (!second) throw new Error('the client did not reconnect');
    second.open();
    expect(second.sent).toEqual([{ op: 'sub', ch: `run:${RUN_ID}` }]);
    second.receive({ ev: 'subscribed', ch: `run:${RUN_ID}` });
    expect(calls).toEqual(['subscribed', 'run.output', 'subscribed']);
    expect(client.getState()).toBe('open');
  });

  it('unsubscribes with the last subscriber and closes the idle socket', () => {
    const leaveFirst = client.subscribe('workspace:ws1', { onEvent: () => {} });
    const leaveSecond = client.subscribe('workspace:ws1', { onEvent: () => {} });
    const [socket] = sockets;
    if (!socket) throw new Error('no socket was opened');
    socket.open();

    leaveFirst();
    expect(socket.sent).toEqual([{ op: 'sub', ch: 'workspace:ws1' }]);
    leaveSecond();
    expect(socket.sent).toEqual([
      { op: 'sub', ch: 'workspace:ws1' },
      { op: 'unsub', ch: 'workspace:ws1' },
    ]);
    vi.advanceTimersByTime(50);
    expect(socket.readyState).toBe(3);
    expect(client.getState()).toBe('idle');
  });

  it('only sends client operations over an open socket', () => {
    client.subscribe(`run:${RUN_ID}`, { onEvent: () => {} });
    expect(client.send({ op: 'run.input', runId: RUN_ID, data: 'ls\r' })).toBe(false);
    sockets[0]?.open();
    expect(client.send({ op: 'run.input', runId: RUN_ID, data: 'ls\r' })).toBe(true);
    expect(sockets[0]?.sent.at(-1)).toEqual({ op: 'run.input', runId: RUN_ID, data: 'ls\r' });
  });

  it('drops events that do not match the contract', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const events: ChannelEvent[] = [];
    client.subscribe(`run:${RUN_ID}`, { onEvent: (event) => events.push(event) });
    sockets[0]?.open();
    sockets[0]?.receive({ ev: 'run.output', ch: `run:${RUN_ID}`, runId: RUN_ID, seq: 'one' });
    expect(events).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});
