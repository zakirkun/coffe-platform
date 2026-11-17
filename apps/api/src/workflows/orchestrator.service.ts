import type { PersonaRole, StartTicketRequest, WorkflowInstance } from '@coffe/contracts';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from '@nestjs/common';
import { and, desc, eq, inArray, isNull, max } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { ApiException } from '../common/api-error.js';
import { OPEN_RUN_STATUSES } from '../common/run-status.js';
import type { Database } from '../db/client.js';
import { DB, type DbExecutor } from '../db/db.module.js';
import {
  diffs,
  personas,
  projects,
  runs,
  testResults,
  tickets,
  type WorkflowStep,
  type WorkflowStepStateJson,
  workflowInstances,
} from '../db/schema/index.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { type RunRow, RunStore } from '../runs/run-store.js';
import { RunsService } from '../runs/runs.service.js';
import { TicketsService } from '../tickets/tickets.service.js';
import { parseReviewVerdict, parseTestReport } from './reports.js';
import { handoffNote, type StepRunSummary, stepPrompt } from './step-prompts.js';
import {
  toWorkflowInstance,
  type WorkflowInstanceRow,
  WorkflowsService,
} from './workflows.service.js';

/** What to do once every run of the current step attempt has ended. */
type Decision =
  | { kind: 'wait' }
  | { kind: 'next'; step: WorkflowStep; handoff: string; outcome: string }
  | { kind: 'loop'; step: WorkflowStep; handoff: string; outcome: string }
  | { kind: 'finish'; outcome: string }
  | { kind: 'fail'; outcome: string; review: boolean }
  | { kind: 'cancel'; outcome: string };

/**
 * Runs a ticket's workflow (architecture §11.3): one step after the other, parallel read-only
 * personas within a step, tester/reviewer verdicts looping back with a handoff note, and the
 * ticket moving to In Review when every step passed.
 */
@Injectable()
export class OrchestratorService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(OrchestratorService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly workflows: WorkflowsService,
    private readonly runs: RunsService,
    private readonly store: RunStore,
    private readonly tickets: TicketsService,
    private readonly realtime: RealtimeService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.store.onEnded((run) => this.onRunEnded(run));
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.reconcile();
    } catch (error) {
      this.logger.error(`resuming interrupted workflows failed: ${String(error)}`);
    }
  }

  /**
   * Resumes workflows a restart of the API interrupted between two steps: a running step whose
   * runs all ended is evaluated again; a workflow left without a running step starts its next
   * pending step (the handoff note of the lost transition is not recovered).
   */
  async reconcile(): Promise<void> {
    const open = await this.db
      .select({ instance: workflowInstances, workspaceId: projects.workspaceId })
      .from(workflowInstances)
      .innerJoin(tickets, eq(tickets.id, workflowInstances.ticketId))
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .where(eq(workflowInstances.status, 'running'));
    for (const { instance, workspaceId } of open) {
      const running = instance.stepStates.find((state) => state.status === 'running');
      if (running) {
        const [latest] = await this.db
          .select()
          .from(runs)
          .where(
            and(eq(runs.workflowInstanceId, instance.id), eq(runs.workflowStepKey, running.key)),
          )
          .orderBy(desc(runs.attempt), desc(runs.createdAt))
          .limit(1);
        if (latest?.endedAt) await this.onRunEnded(latest);
        continue;
      }
      const pending = new Set(
        instance.stepStates.filter((state) => state.status === 'pending').map((state) => state.key),
      );
      const next = instance.steps.find((step) => pending.has(step.key));
      if (next) {
        this.logger.warn(`resuming workflow ${instance.id} at step ${next.key}`);
        await this.startStep(workspaceId, instance, next, null);
      }
    }
  }

  /** `POST /tickets/:id/start`: moves the ticket to In Progress and runs its first step. */
  async start(
    workspaceId: string,
    userId: string,
    ticketId: string,
    body: StartTicketRequest,
  ): Promise<WorkflowInstance> {
    const ticket = await this.tickets.getRow(workspaceId, ticketId);
    const workflow = body.workflowId
      ? await this.workflows.getRow(workspaceId, body.workflowId)
      : await this.workflows.defaultFor(workspaceId, ticket.projectId);
    if (!workflow) {
      throw ApiException.conflict(
        'no_workflow',
        'This project has no workflow yet; create one or start a single run',
      );
    }
    const [first] = workflow.steps;
    if (!first) throw ApiException.conflict('empty_workflow', `${workflow.name} has no steps`);

    const [open] = await this.db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.ticketId, ticket.id), inArray(runs.status, OPEN_RUN_STATUSES)))
      .limit(1);
    if (open)
      throw ApiException.conflict('run_active', 'Another run of this ticket is still active');
    const [running] = await this.db
      .select({ id: workflowInstances.id })
      .from(workflowInstances)
      .where(
        and(eq(workflowInstances.ticketId, ticket.id), eq(workflowInstances.status, 'running')),
      )
      .limit(1);
    if (running)
      throw ApiException.conflict(
        'workflow_running',
        'The workflow of this ticket is already running',
      );
    const blockers = (await this.tickets.openDependencies([ticket.id])).get(ticket.id) ?? [];
    if (blockers.length > 0) {
      const keys = blockers.map((blocker) => blocker.key).join(', ');
      throw ApiException.conflict(
        'ticket_blocked',
        `Blocked by ${keys}: finish those tickets first`,
        { blockedBy: blockers },
      );
    }

    const [instance] = await this.db
      .insert(workflowInstances)
      .values({
        ticketId: ticket.id,
        workflowId: workflow.id,
        workflowName: workflow.name,
        steps: workflow.steps,
        stepStates: workflow.steps.map((step) => ({
          key: step.key,
          status: 'pending',
          run_ids: [],
          loops: 0,
          outcome: null,
        })),
        currentStepKey: first.key,
        createdBy: userId,
      })
      .returning();
    if (!instance) throw new Error('workflow instance insert returned no row');
    await this.audit.record({
      workspaceId,
      actorType: 'user',
      actorUserId: userId,
      action: 'workflow.start',
      targetType: 'ticket',
      targetId: ticket.id,
      details: { workflow: workflow.name, instanceId: instance.id },
    });
    const started = await this.startStep(workspaceId, instance, first, null, body.runnerId);
    return toWorkflowInstance(started);
  }

  async current(workspaceId: string, ticketId: string): Promise<WorkflowInstance> {
    const ticket = await this.tickets.getRow(workspaceId, ticketId);
    const [instance] = await this.db
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.ticketId, ticket.id))
      .orderBy(desc(workflowInstances.startedAt))
      .limit(1);
    if (!instance) throw ApiException.notFound('Workflow run');
    return toWorkflowInstance(instance);
  }

  /** Stops the open runs of the running workflow and ends it as cancelled. */
  async cancel(workspaceId: string, userId: string, ticketId: string): Promise<WorkflowInstance> {
    const ticket = await this.tickets.getRow(workspaceId, ticketId);
    const [instance] = await this.db
      .update(workflowInstances)
      .set({ status: 'cancelled', endedAt: new Date() })
      .where(
        and(eq(workflowInstances.ticketId, ticket.id), eq(workflowInstances.status, 'running')),
      )
      .returning();
    if (!instance)
      throw ApiException.conflict(
        'workflow_not_running',
        'The workflow of this ticket is not running',
      );
    const open = await this.db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(eq(runs.workflowInstanceId, instance.id), inArray(runs.status, OPEN_RUN_STATUSES)),
      );
    for (const run of open) {
      await this.runs
        .signal(workspaceId, userId, run.id, { signal: 'stop' })
        .catch((error: unknown) => {
          this.logger.warn(`stopping run ${run.id} failed: ${String(error)}`);
        });
    }
    this.publish(instance);
    return toWorkflowInstance(instance);
  }

  /** Creates the runs of one step and records them on the instance. */
  private async startStep(
    workspaceId: string,
    instance: WorkflowInstanceRow,
    step: WorkflowStep,
    handoff: string | null,
    runnerId?: string,
  ): Promise<WorkflowInstanceRow> {
    // Every (re)run of a step is a new attempt, so the join in `onRunEnded` only sees its own runs.
    const [previous] = await this.db
      .select({ attempt: max(runs.attempt) })
      .from(runs)
      .where(and(eq(runs.workflowInstanceId, instance.id), eq(runs.workflowStepKey, step.key)));
    const attempt = (previous?.attempt ?? 0) + 1;
    const runIds: string[] = [];
    try {
      const ticket = await this.tickets.getRow(workspaceId, instance.ticketId);
      for (const personaId of step.persona_ids) {
        const persona = await this.runs.persona(workspaceId, personaId);
        const run = await this.runs.createRun({
          workspaceId,
          userId: instance.createdBy,
          projectId: ticket.projectId,
          ticket: await this.tickets.getRow(workspaceId, instance.ticketId),
          kind: 'ticket',
          prompt: stepPrompt(ticket, persona.role, handoff !== null),
          persona,
          runnerId,
          workflow: { instanceId: instance.id, stepKey: step.key, attempt },
          handoff,
        });
        runIds.push(run.id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.end(
        workspaceId,
        instance,
        'failed',
        `${step.name} could not start: ${message}`,
        false,
      );
    }
    const [updated] = await this.db
      .update(workflowInstances)
      .set({
        currentStepKey: step.key,
        stepStates: instance.stepStates.map((candidate) =>
          candidate.key === step.key
            ? {
                ...candidate,
                status: 'running',
                run_ids: [...candidate.run_ids, ...runIds],
                outcome: null,
              }
            : candidate,
        ),
      })
      .where(eq(workflowInstances.id, instance.id))
      .returning();
    const row = updated ?? instance;
    this.publish(row);
    return row;
  }

  /** Advances the workflow once the last run of a step attempt ended. */
  async onRunEnded(run: RunRow): Promise<void> {
    if (!run.workflowInstanceId || !run.workflowStepKey) return;
    const instanceId = run.workflowInstanceId;
    const stepKey = run.workflowStepKey;

    const decided = await this.db.transaction(async (tx) => {
      // Serializes the runs of a parallel step finishing at the same time.
      const [instance] = await tx
        .select()
        .from(workflowInstances)
        .where(eq(workflowInstances.id, instanceId))
        .for('update');
      if (instance?.status !== 'running') return null;
      const stepIndex = instance.steps.findIndex((step) => step.key === stepKey);
      const step = instance.steps[stepIndex];
      const state = instance.stepStates.find((candidate) => candidate.key === stepKey);
      if (!step || !state || state.status !== 'running') return null;

      const attemptRuns = await tx
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.workflowInstanceId, instanceId),
            eq(runs.workflowStepKey, stepKey),
            eq(runs.attempt, run.attempt),
          ),
        );
      if (attemptRuns.some((candidate) => !candidate.endedAt))
        return { instance, decision: { kind: 'wait' } as Decision };

      const decision = await this.decide(tx, instance, step, stepIndex, state, attemptRuns);
      if (decision.kind === 'wait') return { instance, decision };
      const { outcome } = decision;
      const stepStatus: WorkflowStepStateJson['status'] =
        decision.kind === 'next' || decision.kind === 'finish' ? 'completed' : 'failed';
      let stepStates = instance.stepStates.map((candidate) =>
        candidate.key === stepKey ? { ...candidate, status: stepStatus, outcome } : candidate,
      );
      if (decision.kind === 'loop') {
        // Everything from the loop target onwards runs again; the failing step counts a loop.
        const targetIndex = instance.steps.findIndex(
          (candidate) => candidate.key === decision.step.key,
        );
        stepStates = stepStates.map((candidate, index) =>
          index >= targetIndex
            ? {
                ...candidate,
                status: 'pending',
                loops: candidate.key === stepKey ? candidate.loops + 1 : candidate.loops,
              }
            : candidate,
        );
      }
      const [updated] = await tx
        .update(workflowInstances)
        .set({ stepStates })
        .where(eq(workflowInstances.id, instanceId))
        .returning();
      return { instance: updated ?? instance, decision };
    });
    if (!decided || decided.decision.kind === 'wait') return;

    const { instance, decision } = decided;
    const workspaceId = run.workspaceId;
    switch (decision.kind) {
      case 'next':
      case 'loop':
        await this.startStep(workspaceId, instance, decision.step, decision.handoff);
        return;
      case 'finish':
        await this.end(workspaceId, instance, 'completed', decision.outcome, true);
        return;
      case 'fail':
        await this.end(workspaceId, instance, 'failed', decision.outcome, decision.review);
        return;
      case 'cancel':
        await this.end(workspaceId, instance, 'cancelled', decision.outcome, false);
        return;
    }
  }

  /** Evaluates a finished step attempt: run failures, agent test reports and review verdicts. */
  private async decide(
    tx: DbExecutor,
    instance: WorkflowInstanceRow,
    step: WorkflowStep,
    stepIndex: number,
    state: WorkflowStepStateJson,
    attemptRuns: RunRow[],
  ): Promise<Decision> {
    if (attemptRuns.some((candidate) => candidate.status === 'cancelled')) {
      return { kind: 'cancel', outcome: `${step.name} was stopped` };
    }
    const crashed = attemptRuns.find((candidate) => candidate.status !== 'completed');
    if (crashed) {
      return {
        kind: 'fail',
        outcome: `${step.name} failed: ${crashed.error ?? crashed.status}`,
        review: false,
      };
    }

    const personaRows = await tx
      .select({ id: personas.id, name: personas.name, role: personas.role })
      .from(personas)
      .where(
        inArray(
          personas.id,
          attemptRuns.flatMap((candidate) => (candidate.personaId ? [candidate.personaId] : [])),
        ),
      );
    const commandTests = await tx
      .select({ runId: testResults.runId, status: testResults.status })
      .from(testResults)
      .where(
        and(
          inArray(
            testResults.runId,
            attemptRuns.map((candidate) => candidate.id),
          ),
          eq(testResults.source, 'command'),
        ),
      );

    const summaries: StepRunSummary[] = [];
    let failed = false;
    for (const candidate of attemptRuns) {
      const persona = personaRows.find((row) => row.id === candidate.personaId);
      const role: PersonaRole = persona?.role ?? 'implementer';
      const testReport = role === 'tester' ? parseTestReport(candidate.resultSummary) : null;
      const verdict = role === 'reviewer' ? parseReviewVerdict(candidate.resultSummary) : null;
      if (testReport && candidate.ticketId) {
        await tx.insert(testResults).values({
          runId: candidate.id,
          ticketId: candidate.ticketId,
          source: 'agent',
          command: testReport.command ?? null,
          status: testReport.status,
          passed: testReport.passed,
          failed: testReport.failed,
          skipped: testReport.skipped,
          report: { failures: testReport.failures },
        });
      }
      if (testReport?.status === 'failed' || verdict?.verdict === 'request_changes') failed = true;
      if (commandTests.some((test) => test.runId === candidate.id && test.status !== 'passed'))
        failed = true;
      summaries.push({
        personaName: persona?.name ?? candidate.cliId,
        role,
        summary: candidate.resultSummary,
        testReport,
        verdict,
      });
    }

    const [latestDiff] = await tx
      .select({ additions: diffs.additions, deletions: diffs.deletions, files: diffs.files })
      .from(diffs)
      .where(eq(diffs.ticketId, instance.ticketId))
      .orderBy(desc(diffs.createdAt))
      .limit(1);
    const diffStat = latestDiff
      ? {
          additions: latestDiff.additions,
          deletions: latestDiff.deletions,
          files: latestDiff.files.map((file) => ({
            path: file.path,
            additions: file.additions ?? null,
            deletions: file.deletions ?? null,
          })),
        }
      : null;
    const outcome = failed ? 'changes needed' : 'passed';
    const handoff = handoffNote(step.name, outcome, summaries, diffStat);

    if (!failed) {
      const next = instance.steps[stepIndex + 1];
      if (next) return { kind: 'next', step: next, handoff, outcome };
      return latestDiff
        ? { kind: 'finish', outcome: 'every step passed' }
        : {
            kind: 'fail',
            outcome: 'the workflow finished without changing any file',
            review: false,
          };
    }
    if (step.on_fail === 'stop')
      return { kind: 'fail', outcome: `${step.name} did not pass`, review: true };
    if (state.loops >= step.max_loops) {
      return {
        kind: 'fail',
        outcome: `${step.name} still did not pass after ${state.loops} loop(s)`,
        review: true,
      };
    }
    const target = instance.steps.find((candidate) => `goto:${candidate.key}` === step.on_fail);
    if (!target)
      return { kind: 'fail', outcome: `${step.name} loops to an unknown step`, review: true };
    return { kind: 'loop', step: target, handoff, outcome };
  }

  /**
   * Ends the workflow. A completed workflow (or one that gave up after its loops, `review`) hands
   * the ticket to the human review gate; every other end flags the ticket as failed.
   */
  private async end(
    workspaceId: string,
    instance: WorkflowInstanceRow,
    status: 'completed' | 'failed' | 'cancelled',
    outcome: string,
    review: boolean,
  ): Promise<WorkflowInstanceRow> {
    const [ended] = await this.db
      .update(workflowInstances)
      .set({ status, endedAt: new Date(), currentStepKey: null })
      .where(and(eq(workflowInstances.id, instance.id), isNull(workflowInstances.endedAt)))
      .returning();
    const row = ended ?? instance;
    if (status === 'completed') {
      await this.tickets.setStatus(instance.ticketId, 'in_review', { failed: false });
    } else if (review) {
      await this.tickets.setStatus(instance.ticketId, 'in_review', { failed: true });
    } else {
      await this.tickets.apply(this.db, instance.ticketId, { flags: { failed: true } });
      await this.tickets.publishUpdated(instance.ticketId);
    }
    await this.audit.record({
      workspaceId,
      actorType: 'system',
      action: `workflow.${status}`,
      targetType: 'ticket',
      targetId: instance.ticketId,
      details: { instanceId: instance.id, outcome },
    });
    this.publish(row);
    this.realtime.publish(`ticket:${instance.ticketId}`, {
      ev: 'review.updated',
      ticketId: instance.ticketId,
    });
    return row;
  }

  private publish(instance: WorkflowInstanceRow): void {
    this.realtime.publish(`ticket:${instance.ticketId}`, {
      ev: 'workflow.updated',
      ticketId: instance.ticketId,
    });
  }
}
