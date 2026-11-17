import type {
  Run,
  RunDriver,
  RunEventsResponse,
  RunInputRequest,
  RunOutputResponse,
  RunSignalRequest,
  StartRunRequest,
} from '@coffe/contracts';
import type { AgentInput } from '@coffe/protocol';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { roleAllows } from '../auth/access.js';
import { MembershipService } from '../auth/membership.service.js';
import type { AuthUser } from '../auth/request-context.js';
import { ApiException } from '../common/api-error.js';
import { OPEN_RUN_STATUSES } from '../common/run-status.js';
import type { Database } from '../db/client.js';
import type { DbExecutor } from '../db/db.module.js';
import { DB } from '../db/db.module.js';
import { personas, projects, runEvents, runOutput, runs } from '../db/schema/index.js';
import { BrowserGateway } from '../realtime/browser.gateway.js';
import { RunnerHub } from '../runners/runner-hub.js';
import { type TicketRow, TicketsService } from '../tickets/tickets.service.js';
import { changesRequestedPrompt, ticketBranch, ticketPrompt } from './run-context.js';
import { RunDispatcher } from './run-dispatcher.js';
import { RunScheduler } from './run-scheduler.js';
import { type RunRow, RunStore } from './run-store.js';

/** Preferred CLI when neither the request nor the project names one. */
const DEFAULT_CLI_ID = 'claude-code';
/** Longest terminal line buffered for the keystroke audit. */
const MAX_AUDIT_LINE = 4_096;

type PersonaRow = typeof personas.$inferSelect;

export interface NewRunOptions {
  workspaceId: string;
  /** `null` for runs started by the orchestrator. */
  userId: string | null;
  projectId: string;
  /** The ticket of a ticket run; planning runs have none. */
  ticket: TicketRow | null;
  kind: 'ticket' | 'planning';
  prompt: string;
  /** Supplies CLI, model, mode, driver and permission limits; explicit options win. */
  persona?: PersonaRow | null;
  cliId?: string;
  model?: string | null;
  mode?: Run['mode'];
  driver?: RunDriver;
  repoId?: string;
  runnerId?: string;
  parentRunId?: string | null;
  workflow?: { instanceId: string; stepKey: string; attempt: number } | null;
  handoff?: string | null;
  requirementId?: string | null;
}

/** Runs of tickets: creation, terminal I/O, signals and paged output (architecture §11). */
@Injectable()
export class RunsService implements OnModuleInit {
  /** Terminal input typed so far per `run:user`, audited line by line. */
  private readonly typed = new Map<string, string>();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly hub: RunnerHub,
    private readonly store: RunStore,
    private readonly dispatcher: RunDispatcher,
    private readonly scheduler: RunScheduler,
    private readonly tickets: TicketsService,
    private readonly audit: AuditService,
    private readonly memberships: MembershipService,
    private readonly browser: BrowserGateway,
  ) {}

  onModuleInit(): void {
    this.browser.registerOp('run.input', (user, message) => this.relayKeys(user, message.runId, message.data));
    this.browser.registerOp('run.resize', (user, message) =>
      this.relayResize(user, message.runId, message.cols, message.rows),
    );
  }

  async list(workspaceId: string, ticketId: string): Promise<Run[]> {
    const ticket = await this.tickets.getRow(workspaceId, ticketId);
    const rows = await this.db
      .select()
      .from(runs)
      .where(eq(runs.ticketId, ticket.id))
      .orderBy(desc(runs.createdAt), desc(runs.id));
    return this.store.toDtos(rows);
  }

  async get(workspaceId: string, runId: string): Promise<Run> {
    return this.store.toDto(await this.store.get(workspaceId, runId));
  }

  /** `POST /tickets/:id/runs`: a new implementation run of the ticket. */
  async start(workspaceId: string, userId: string, ticketId: string, body: StartRunRequest): Promise<Run> {
    const ticket = await this.tickets.getRow(workspaceId, ticketId);
    const persona = body.personaId
      ? await this.persona(workspaceId, body.personaId)
      : ticket.assigneePersonaId
        ? await this.persona(workspaceId, ticket.assigneePersonaId).catch(() => null)
        : null;
    return this.createRun({
      workspaceId,
      userId,
      projectId: ticket.projectId,
      ticket,
      kind: 'ticket',
      prompt: ticketPrompt(ticket, body.prompt),
      persona,
      cliId: body.cliId,
      model: body.model,
      mode: body.mode,
      repoId: body.repoId,
      runnerId: body.runnerId,
    });
  }

  /** Follow-up run after "request changes": same worktree, same CLI, the reviewer's feedback. */
  async startChangesRequested(
    workspaceId: string,
    userId: string,
    ticket: TicketRow,
    previous: RunRow | null,
    feedback: string,
  ): Promise<Run> {
    const persona = previous?.personaId ? await this.persona(workspaceId, previous.personaId).catch(() => null) : null;
    return this.createRun({
      workspaceId,
      userId,
      projectId: ticket.projectId,
      ticket,
      kind: 'ticket',
      prompt: changesRequestedPrompt(ticket, feedback, previous?.resultSummary ?? null),
      persona,
      cliId: previous?.cliId,
      model: previous?.model,
      mode: previous?.mode,
      driver: previous?.driver,
      parentRunId: previous?.id ?? null,
    });
  }

  /**
   * Inserts a queued run on the runner the scheduler picks (sticky to the ticket's worktree),
   * moves a ticket to In Progress and hands the run to the dispatcher.
   */
  async createRun(options: NewRunOptions): Promise<Run> {
    const { ticket, persona } = options;
    const [project] = await this.db.select().from(projects).where(eq(projects.id, options.projectId)).limit(1);
    if (!project) throw ApiException.notFound('Project');

    const requested = options.cliId ?? persona?.cliId ?? project.settings.default_cli_id ?? undefined;
    const placement = await this.scheduler.place({
      workspaceId: options.workspaceId,
      projectId: project.id,
      cliId: requested,
      sticky: ticket?.worktreeRunnerId ? { runnerId: ticket.worktreeRunnerId, repoId: ticket.repoId } : undefined,
      repoId: options.repoId ?? ticket?.repoId ?? undefined,
      runnerId: options.runnerId,
    });
    const cliId =
      requested ?? (placement.clis.includes(DEFAULT_CLI_ID) ? DEFAULT_CLI_ID : placement.clis.toSorted()[0]);
    if (!cliId) throw ApiException.conflict('no_cli', `No agent CLI was detected on runner ${placement.runnerName}`);

    const row = await this.db.transaction(async (tx) => {
      // Orchestrated steps manage concurrency themselves (parallel read-only reviewers).
      if (ticket && !options.workflow) await this.assertNoOpenRun(tx, ticket.id);
      const [inserted] = await tx
        .insert(runs)
        .values({
          workspaceId: options.workspaceId,
          projectId: project.id,
          ticketId: ticket?.id ?? null,
          kind: options.kind,
          personaId: persona?.id ?? null,
          workflowInstanceId: options.workflow?.instanceId ?? null,
          workflowStepKey: options.workflow?.stepKey ?? null,
          attempt: options.workflow?.attempt ?? 1,
          runnerId: placement.runnerId,
          repoId: placement.repoId,
          cliId,
          model: options.model ?? persona?.model ?? null,
          mode: options.mode ?? persona?.mode ?? project.settings.default_mode ?? 'structured',
          driver: options.driver ?? persona?.driver ?? 'native',
          permissions: persona?.permissions ?? null,
          handoff: options.handoff ?? null,
          requirementId: options.requirementId ?? null,
          prompt: options.prompt,
          branch: ticket ? (ticket.branch ?? ticketBranch(ticket.key)) : null,
          baseBranch: ticket?.baseBranch ?? placement.defaultBranch ?? 'main',
          parentRunId: options.parentRunId ?? null,
          requestedBy: options.userId,
        })
        .returning();
      if (!inserted) throw new Error('run insert returned no row');
      if (ticket) {
        await this.tickets.apply(tx, ticket.id, {
          status: 'in_progress',
          flags: { failed: false, mergeConflict: false },
          worktree: {
            branch: inserted.branch,
            baseBranch: inserted.baseBranch,
            worktreeRunnerId: placement.runnerId,
            repoId: placement.repoId,
          },
        });
      }
      return inserted;
    });

    await this.store.publish(row);
    if (ticket) await this.tickets.publishUpdated(ticket.id);
    await this.dispatcher.dispatch(placement.runnerId);
    const [current] = await this.db.select().from(runs).where(eq(runs.id, row.id)).limit(1);
    return this.store.toDto(current ?? row);
  }

  /** An enabled persona of the workspace. */
  async persona(workspaceId: string, personaId: string): Promise<PersonaRow> {
    const [persona] = await this.db
      .select()
      .from(personas)
      .where(and(eq(personas.id, personaId), eq(personas.workspaceId, workspaceId)))
      .limit(1);
    if (!persona || persona.archivedAt) throw ApiException.notFound('Persona');
    if (!persona.enabled) throw ApiException.conflict('persona_disabled', `${persona.name} is disabled`);
    return persona;
  }

  async output(workspaceId: string, runId: string, afterSeq: number, limit: number): Promise<RunOutputResponse> {
    const run = await this.store.get(workspaceId, runId);
    const rows = await this.db
      .select({ seq: runOutput.seq, data: runOutput.data })
      .from(runOutput)
      .where(and(eq(runOutput.runId, run.id), gt(runOutput.seq, afterSeq)))
      .orderBy(asc(runOutput.seq))
      .limit(limit);
    return {
      chunks: rows.map((row) => ({ seq: row.seq, data: row.data.toString('base64') })),
      lastSeq: run.lastSeq,
    };
  }

  async events(workspaceId: string, runId: string, afterSeq: number, limit: number): Promise<RunEventsResponse> {
    const run = await this.store.get(workspaceId, runId);
    const rows = await this.db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, run.id), gt(runEvents.seq, afterSeq)))
      .orderBy(asc(runEvents.seq))
      .limit(limit);
    return {
      events: rows.map((row) => ({ seq: row.seq, ts: row.ts.toISOString(), type: row.type, data: row.data })),
      lastSeq: run.lastSeq,
    };
  }

  /** `POST /runs/:id/input`: a follow-up message, raw keys or a permission answer. */
  async input(workspaceId: string, userId: string, runId: string, body: RunInputRequest): Promise<void> {
    const run = await this.store.get(workspaceId, runId);
    if (run.status !== 'running' && run.status !== 'waiting_input') {
      throw ApiException.conflict('run_not_accepting_input', `The run is ${run.status}`);
    }
    if (!run.runnerId) throw ApiException.runnerOffline();
    const input: AgentInput =
      body.kind === 'text'
        ? { kind: 'text', text: body.text }
        : body.kind === 'keys'
          ? { kind: 'keys', data: body.data }
          : { kind: 'permission', request_id: body.requestId, allow: body.allow, remember: body.remember ?? false };
    await this.hub.send(
      run.runnerId,
      { type: 'run.input', payload: { run_id: run.id, input } },
      { actorUserId: userId, runId: run.id },
    );
    await this.audit.record({
      workspaceId,
      actorType: 'user',
      actorUserId: userId,
      runnerId: run.runnerId,
      runId: run.id,
      action: 'run.input',
      targetType: 'run',
      targetId: run.id,
      command: body.kind === 'text' ? body.text : body.kind === 'keys' ? body.data : null,
      details:
        body.kind === 'permission'
          ? { kind: body.kind, requestId: body.requestId, allow: body.allow }
          : { kind: body.kind },
    });
  }

  /** `POST /runs/:id/signal`: pause/resume/interrupt/stop/kill; queued runs are cancelled here. */
  async signal(workspaceId: string, userId: string, runId: string, body: RunSignalRequest): Promise<void> {
    const run = await this.store.get(workspaceId, runId);
    if (run.endedAt) throw ApiException.conflict('run_ended', `The run already ${run.status}`);
    const record = (command: string) =>
      this.audit.record({
        workspaceId,
        actorType: 'user',
        actorUserId: userId,
        runnerId: run.runnerId,
        runId: run.id,
        action: 'run.signal',
        targetType: 'run',
        targetId: run.id,
        command,
      });
    if (run.status === 'queued' || run.status === 'interrupted') {
      if (body.signal !== 'stop' && body.signal !== 'kill') {
        throw ApiException.conflict('run_not_running', `The run is ${run.status}`);
      }
      await this.dispatcher.abort(run.id, 'cancelled', 'cancelled by a user');
      await record(body.signal);
      return;
    }
    if (!run.runnerId) throw ApiException.runnerOffline();
    await this.hub.send(
      run.runnerId,
      { type: 'run.signal', payload: { run_id: run.id, signal: body.signal } },
      { actorUserId: userId, runId: run.id },
    );
    await record(body.signal);
  }

  /** Raw terminal keystrokes from the browser (`run.input` op); audited line by line. */
  private async relayKeys(user: AuthUser, runId: string, data: string): Promise<void> {
    const run = await this.authorizedRun(user, runId);
    if (!run.runnerId) return;
    this.hub.relay(run.runnerId, { type: 'run.input', payload: { run_id: run.id, input: { kind: 'keys', data } } });

    const key = `${run.id}:${user.id}`;
    let line = this.typed.get(key) ?? '';
    for (const char of data) {
      if (char === '\r' || char === '\n') {
        if (line.length > 0) {
          await this.audit.record({
            workspaceId: run.workspaceId,
            actorType: 'user',
            actorUserId: user.id,
            runnerId: run.runnerId,
            runId: run.id,
            action: 'run.input',
            targetType: 'run',
            targetId: run.id,
            command: line,
            details: { kind: 'keys' },
          });
        }
        line = '';
      } else if (char === '\x7f' || char === '\b') {
        line = line.slice(0, -1);
      } else if (char >= ' ' && line.length < MAX_AUDIT_LINE) {
        line += char;
      }
    }
    if (line.length > 0) this.typed.set(key, line);
    else this.typed.delete(key);
  }

  private async relayResize(user: AuthUser, runId: string, cols: number, rows: number): Promise<void> {
    const run = await this.authorizedRun(user, runId);
    if (!run.runnerId) return;
    this.hub.relay(run.runnerId, { type: 'run.resize', payload: { run_id: run.id, cols, rows } });
  }

  /** The run, when the user may drive runs of its workspace. */
  private async authorizedRun(user: AuthUser, runId: string): Promise<RunRow> {
    const [run] = await this.db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    if (!run) throw ApiException.notFound('Run');
    const role = await this.memberships.roleOf(user.id, run.workspaceId);
    if (!role || !roleAllows(role, { ticket: ['run'] })) throw ApiException.forbidden();
    return run;
  }

  /** One writing run per ticket at a time (architecture §11.3). */
  private async assertNoOpenRun(executor: DbExecutor, ticketId: string): Promise<void> {
    const [open] = await executor
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.ticketId, ticketId), inArray(runs.status, OPEN_RUN_STATUSES)))
      .limit(1);
    if (open) throw ApiException.conflict('run_active', 'Another run of this ticket is still active');
  }
}
