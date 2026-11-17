import {
  type RunnerEnvelope,
  type RunnerMessage,
  type RunnerMessageType,
  type ServerEnvelope,
  type ServerMessage,
  serverEnvelope,
} from '@coffe/protocol';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { WebSocket } from 'ws';
import { AuditService } from '../audit/audit.service.js';
import { ApiException } from '../common/api-error.js';

/** A runner socket that completed the `hello` / `welcome` handshake. */
export interface RunnerConnection {
  readonly runnerId: string;
  readonly workspaceId: string;
  readonly ws: WebSocket;
}

/** Who caused a command, for the audit row. */
export interface CommandContext {
  actorUserId?: string | null;
  runId?: string | null;
}

/** Run-scoped frames; they carry `run_id` + `seq` and are acknowledged with `run.ack`. */
export type RunFrame = Extract<
  RunnerMessage,
  { type: 'run.state' | 'run.output' | 'run.event' | 'run.usage' | 'run.completed' }
>;
export type RunFrameHandler = (connection: RunnerConnection, frame: RunFrame) => Promise<void>;

export interface RunnerOnlineEvent {
  runnerId: string;
  workspaceId: string;
  /** Runs the runner reported as alive in `hello.active_runs`. */
  activeRunIds: string[];
}
export type RunnerOnlineListener = (event: RunnerOnlineEvent) => Promise<void>;

/** A request to a runner failed: `code` is the runner's error code, `timeout` or `runner_offline`. */
export class RunnerRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RunnerRequestError';
  }
}

/** Maps a failed runner request to the REST error the caller should see. */
export function runnerRequestFailure(error: unknown): ApiException {
  if (error instanceof ApiException) return error;
  if (!(error instanceof RunnerRequestError)) throw error;
  if (error.code === 'runner_offline') return ApiException.runnerOffline();
  if (error.code === 'timeout') {
    return new ApiException(HttpStatus.GATEWAY_TIMEOUT, 'runner_timeout', error.message);
  }
  if (error.code === 'not_found') {
    return new ApiException(HttpStatus.NOT_FOUND, 'not_found', error.message);
  }
  if (error.code === 'scope_violation' || error.code === 'policy_denied') {
    return new ApiException(HttpStatus.FORBIDDEN, error.code, error.message);
  }
  return new ApiException(HttpStatus.BAD_GATEWAY, 'runner_error', error.message, {
    runnerCode: error.code,
  });
}

/** Throws unless the reply has the expected type; afterwards `reply.payload` is typed. */
export function assertReply<T extends RunnerMessageType>(
  reply: RunnerEnvelope,
  type: T,
): asserts reply is Extract<RunnerEnvelope, { type: T }> {
  if (reply.type !== type) {
    throw new RunnerRequestError('unexpected_reply', `expected ${type}, the runner sent ${reply.type}`);
  }
}

interface PendingRequest {
  connection: RunnerConnection;
  resolve: (reply: RunnerEnvelope) => void;
  reject: (error: RunnerRequestError) => void;
  timer: NodeJS.Timeout;
}

/** What goes into `audit_logs.details` for a command (never prompts, context files or input). */
function commandDetails(message: ServerMessage): Record<string, unknown> {
  switch (message.type) {
    case 'run.start': {
      const p = message.payload;
      return {
        run_id: p.run_id,
        kind: p.kind,
        cli_id: p.cli_id,
        mode: p.mode,
        model: p.model ?? null,
        repo_key: p.repo_key,
        worktree: p.worktree,
        ticket_key: p.ticket_key ?? null,
        permissions: p.permissions,
        resume: p.resume ?? null,
        timeout_secs: p.timeout_secs,
        test_command: p.test_command ?? null,
      };
    }
    case 'run.input':
      return { run_id: message.payload.run_id, kind: message.payload.input.kind };
    case 'pty.input':
      return { session_id: message.payload.session_id };
    default:
      return { ...message.payload };
  }
}

/**
 * Live runner connections (architecture §6.1): audited commands, request/response correlation
 * by envelope id, and the hooks other modules use to receive runner traffic.
 */
@Injectable()
export class RunnerHub {
  private readonly logger = new Logger(RunnerHub.name);
  private readonly connections = new Map<string, RunnerConnection>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly onlineListeners: RunnerOnlineListener[] = [];
  private runFrameHandler: RunFrameHandler | null = null;

  constructor(private readonly audit: AuditService) {}

  isOnline(runnerId: string): boolean {
    return this.connections.get(runnerId)?.ws.readyState === WebSocket.OPEN;
  }

  connectionOf(runnerId: string): RunnerConnection | undefined {
    return this.connections.get(runnerId);
  }

  /** Makes `connection` the live connection of its runner. */
  attach(connection: RunnerConnection): void {
    this.connections.set(connection.runnerId, connection);
  }

  /**
   * Forgets a closed connection and fails its pending requests. Returns false when a newer
   * connection of the same runner already replaced it.
   */
  detach(connection: RunnerConnection): boolean {
    for (const [id, request] of this.pending) {
      if (request.connection !== connection) continue;
      clearTimeout(request.timer);
      this.pending.delete(id);
      request.reject(new RunnerRequestError('runner_offline', 'the runner disconnected'));
    }
    if (this.connections.get(connection.runnerId) !== connection) return false;
    this.connections.delete(connection.runnerId);
    return true;
  }

  /** Closes the live socket of a runner, if any (revocation, replacement, stale sweep). */
  disconnect(runnerId: string, code: number, reason: string): void {
    this.connections.get(runnerId)?.ws.close(code, reason);
  }

  /**
   * Sends a command to a runner. Every command is audited (`runner.command`) before it leaves;
   * throws `503 runner_offline` when the runner has no live connection. Returns the envelope id.
   */
  async send(runnerId: string, message: ServerMessage, context: CommandContext = {}): Promise<string> {
    const connection = this.requireConnection(runnerId);
    const envelope = serverEnvelope(message.type, message.payload);
    await this.auditCommand(connection, message, context);
    this.write(connection, envelope);
    return envelope.id;
  }

  /**
   * Sends an audited command and resolves with the frame whose `re` is the request id. Rejects
   * with `RunnerRequestError` when the runner answers `error`, disconnects or stays silent for
   * `timeoutMs`.
   */
  async request(
    runnerId: string,
    message: ServerMessage,
    timeoutMs: number,
    context: CommandContext = {},
  ): Promise<RunnerEnvelope> {
    const connection = this.connections.get(runnerId);
    if (!connection) throw new RunnerRequestError('runner_offline', 'the runner is offline');
    const envelope = serverEnvelope(message.type, message.payload);
    await this.auditCommand(connection, message, context);

    const { promise, resolve, reject } = Promise.withResolvers<RunnerEnvelope>();
    const timer = setTimeout(() => {
      this.pending.delete(envelope.id);
      reject(
        new RunnerRequestError(
          'timeout',
          `the runner did not answer ${message.type} within ${timeoutMs} ms`,
        ),
      );
    }, timeoutMs);
    this.pending.set(envelope.id, { connection, resolve, reject, timer });
    try {
      this.write(connection, envelope);
    } catch {
      clearTimeout(timer);
      this.pending.delete(envelope.id);
      throw new RunnerRequestError('runner_offline', 'the runner is offline');
    }
    return promise;
  }

  /**
   * Unaudited relay for protocol bookkeeping and terminal I/O (`run.ack`, raw keystrokes,
   * resizes); keystrokes are audited line by line by the caller. Returns false when offline.
   */
  relay(runnerId: string, message: ServerMessage): boolean {
    const connection = this.connections.get(runnerId);
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) return false;
    connection.ws.send(JSON.stringify(serverEnvelope(message.type, message.payload)));
    return true;
  }

  /** Settles the pending request `envelope.re` answers; false when there is none. */
  resolveReply(connection: RunnerConnection, envelope: RunnerEnvelope): boolean {
    if (!envelope.re) return false;
    const request = this.pending.get(envelope.re);
    if (!request || request.connection !== connection) return false;
    clearTimeout(request.timer);
    this.pending.delete(envelope.re);
    if (envelope.type === 'error') {
      request.reject(new RunnerRequestError(envelope.payload.code, envelope.payload.message));
    } else {
      request.resolve(envelope);
    }
    return true;
  }

  /** The runs module consumes `run.*` frames. */
  setRunFrameHandler(handler: RunFrameHandler): void {
    this.runFrameHandler = handler;
  }

  /** Returns false when nothing consumes run frames. */
  async handleRunFrame(connection: RunnerConnection, frame: RunFrame): Promise<boolean> {
    if (!this.runFrameHandler) return false;
    await this.runFrameHandler(connection, frame);
    return true;
  }

  onRunnerOnline(listener: RunnerOnlineListener): void {
    this.onlineListeners.push(listener);
  }

  /** Called by the gateway after `welcome`; a failing listener never breaks the connection. */
  async emitRunnerOnline(event: RunnerOnlineEvent): Promise<void> {
    for (const listener of this.onlineListeners) {
      try {
        await listener(event);
      } catch (error) {
        this.logger.error(
          `runner online listener failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
      }
    }
  }

  private requireConnection(runnerId: string): RunnerConnection {
    const connection = this.connections.get(runnerId);
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
      throw ApiException.runnerOffline();
    }
    return connection;
  }

  private write(connection: RunnerConnection, envelope: ServerEnvelope): void {
    if (connection.ws.readyState !== WebSocket.OPEN) throw ApiException.runnerOffline();
    connection.ws.send(JSON.stringify(envelope));
  }

  private async auditCommand(
    connection: RunnerConnection,
    message: ServerMessage,
    context: CommandContext,
  ): Promise<void> {
    await this.audit.record({
      workspaceId: connection.workspaceId,
      actorType: context.actorUserId ? 'user' : 'system',
      actorUserId: context.actorUserId ?? null,
      runnerId: connection.runnerId,
      runId: context.runId ?? null,
      action: 'runner.command',
      targetType: 'runner',
      targetId: connection.runnerId,
      command: message.type,
      details: commandDetails(message),
    });
  }
}
