import { type IncomingMessage, type Server, STATUS_CODES } from 'node:http';
import type { Duplex } from 'node:stream';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';

/** Handles one WebSocket upgrade; it must authenticate before completing the handshake. */
export type UpgradeHandler = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => Promise<void>;

/** Answers a not-yet-upgraded socket with a plain HTTP error and closes it. */
export function rejectUpgrade(socket: Duplex, status: number, message?: string): void {
  if (socket.destroyed || !socket.writable) {
    socket.destroy();
    return;
  }
  const reason = STATUS_CODES[status] ?? 'Error';
  const body = message ?? reason;
  socket.once('finish', () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

/**
 * The single `upgrade` listener of the HTTP server (architecture §9, §19 D2). Socket endpoints
 * (`/api/runner`, `/api/ws`) register a handler per pathname; unknown paths get a 404.
 */
@Injectable()
export class UpgradeRouter implements OnModuleDestroy {
  private readonly logger = new Logger(UpgradeRouter.name);
  private readonly handlers = new Map<string, UpgradeHandler>();
  private server: Server | null = null;

  private readonly onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // Without a listener a socket error during the handshake would crash the process.
    socket.on('error', () => socket.destroy());
    const { pathname } = new URL(request.url ?? '/', 'http://upgrade.invalid');
    const handler = this.handlers.get(pathname);
    if (!handler) {
      rejectUpgrade(socket, 404);
      return;
    }
    handler(request, socket, head).catch((error: unknown) => {
      this.logger.error(
        `upgrade on ${pathname} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      rejectUpgrade(socket, 500);
    });
  };

  register(pathname: string, handler: UpgradeHandler): void {
    if (this.handlers.has(pathname)) {
      throw new Error(`an upgrade handler is already registered for ${pathname}`);
    }
    this.handlers.set(pathname, handler);
  }

  /** Called once at bootstrap with `app.getHttpServer()`. */
  attach(server: Server): void {
    if (this.server) throw new Error('the upgrade router is already attached to a server');
    this.server = server;
    server.on('upgrade', this.onUpgrade);
  }

  onModuleDestroy(): void {
    this.server?.off('upgrade', this.onUpgrade);
    this.server = null;
  }
}
