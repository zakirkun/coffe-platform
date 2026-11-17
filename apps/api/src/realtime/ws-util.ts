import { type RawData, WebSocket } from 'ws';

/** Text of a WebSocket message regardless of how `ws` chunked it. */
export function frameText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

/**
 * Closes every socket with `code` and resolves once all of them are gone; sockets that do not
 * finish the closing handshake within `graceMs` are terminated.
 */
export async function closeSockets(
  sockets: Iterable<WebSocket>,
  code: number,
  reason: string,
  graceMs = 1_000,
): Promise<void> {
  const closed: Promise<void>[] = [];
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.CLOSED) continue;
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(() => ws.terminate(), graceMs);
    ws.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    if (ws.readyState === WebSocket.OPEN) ws.close(code, reason);
    else if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
    closed.push(promise);
  }
  await Promise.all(closed);
}
