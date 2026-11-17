'use client';

import type { Project, ProjectRepoBinding, Run, RunMode, Runner, Ticket } from '@coffe/contracts';
import { Pause, Play, Send, Square, StopCircle } from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useWorkspace } from '@/components/workspace/workspace-context';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/lib/api';
import { formatCostUsd, formatDateTime, formatDuration, formatTokens } from '@/lib/format';
import { can } from '@/lib/permissions';
import { usePendingPermission, useRunInput, useRunSignal, useStartRun } from '@/lib/queries/runs';
import { cliOptionsForTicket } from '@/lib/run-options';
import { RUN_STATUS_LABELS, availableRunControls, isRunActive } from '@/lib/run-status';
import { cn } from '@/lib/utils';
import { RunTerminal } from './run-terminal';

const RUN_STATUS_BADGES: Record<Run['status'], BadgeVariant> = {
  queued: 'secondary',
  dispatched: 'secondary',
  starting: 'info',
  running: 'info',
  paused: 'warning',
  waiting_input: 'warning',
  completed: 'success',
  failed: 'destructive',
  cancelled: 'secondary',
  interrupted: 'warning',
};

const MODE_LABELS: Record<RunMode, string> = {
  structured: 'Structured (events + follow-ups)',
  pty: 'Interactive terminal (TUI)',
};

interface StartRunFormProps {
  ticket: Ticket;
  project: Project | undefined;
  bindings: readonly ProjectRepoBinding[];
  runners: readonly Runner[];
  busy: boolean;
  onStarted: (run: Run) => void;
}

function StartRunForm({ ticket, project, bindings, runners, busy, onStarted }: StartRunFormProps) {
  const { id: workspaceId } = useWorkspace();
  const startRun = useStartRun(workspaceId, ticket.id);
  const options = useMemo(() => cliOptionsForTicket(ticket, bindings, runners), [ticket, bindings, runners]);
  const preferred = project?.settings.defaultCliId ?? null;
  const [cliId, setCliId] = useState<string>('');
  const [mode, setMode] = useState<RunMode>('structured');
  const [prompt, setPrompt] = useState('');

  // Pick the project's default CLI (or the first one) once the options are known.
  useEffect(() => {
    if (cliId && options.some((option) => option.cliId === cliId)) return;
    const next = options.find((option) => option.cliId === preferred) ?? options[0];
    setCliId(next?.cliId ?? '');
  }, [options, preferred, cliId]);

  const cli = options.find((option) => option.cliId === cliId);
  useEffect(() => {
    if (cli && !cli.modes.includes(mode)) setMode(cli.modes[0] ?? 'structured');
  }, [cli, mode]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!cli) return;
    startRun.mutate(
      { cliId: cli.cliId, mode, prompt: prompt.trim() || undefined },
      {
        onSuccess: (run) => {
          setPrompt('');
          onStarted(run);
        },
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="run-cli">Agent CLI</Label>
          <Select value={cliId} onValueChange={setCliId} disabled={options.length === 0}>
            <SelectTrigger id="run-cli" aria-label="CLI" className="w-full">
              <SelectValue placeholder={options.length ? 'Choose a CLI' : 'No CLI detected on the runner'} />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.cliId} value={option.cliId}>
                  {option.name}
                  {option.version ? ` ${option.version}` : ''} · {option.runnerNames.join(', ')}
                  {option.authStatus === 'ok' ? '' : ` (auth: ${option.authStatus})`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="run-mode">Mode</Label>
          <Select value={mode} onValueChange={(value) => setMode(value === 'pty' ? 'pty' : 'structured')} disabled={!cli}>
            <SelectTrigger id="run-mode" aria-label="Mode" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(cli?.modes ?? ['structured']).map((candidate) => (
                <SelectItem key={candidate} value={candidate}>
                  {MODE_LABELS[candidate]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="run-prompt">Extra instructions (optional)</Label>
        <Textarea
          id="run-prompt"
          rows={2}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Added to the ticket, e.g. “Keep the public API unchanged.”"
        />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!cli || busy || startRun.isPending}>
          <Play /> Start run
        </Button>
        {busy ? <span className="text-sm text-muted-foreground">A run of this ticket is active.</span> : null}
      </div>
    </form>
  );
}

function RunUsage({ run }: { run: Run }) {
  const { usage } = run;
  if (!usage) return null;
  if (!usage.available) {
    return (
      <span className="text-xs text-muted-foreground">
        {usage.credits != null ? `${usage.credits} credits` : 'Usage not reported by this CLI'}
      </span>
    );
  }
  return (
    <span className="text-xs text-muted-foreground">
      {formatTokens(usage.inputTokens)} in · {formatTokens(usage.outputTokens)} out
      {usage.costUsd != null ? ` · ${formatCostUsd(usage.costUsd)}${usage.costSource === 'estimated' ? ' (est.)' : ''}` : ''}
    </span>
  );
}

function PermissionPrompt({ run }: { run: Run }) {
  const { id: workspaceId } = useWorkspace();
  const pending = usePendingPermission(workspaceId, run);
  const input = useRunInput(workspaceId);
  const request = pending.data;
  if (!request) return null;
  const answer = (allow: boolean) =>
    input.mutate(
      { runId: run.id, input: { kind: 'permission', requestId: request.request_id, allow } },
      { onError: (error) => toast.error(errorMessage(error)) },
    );
  return (
    <div role="alertdialog" aria-label="Permission request" className="flex flex-wrap items-center gap-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
      <span className="flex-1">
        <span className="font-medium">{request.tool}</span>: {request.description}
      </span>
      <Button size="sm" disabled={input.isPending} onClick={() => answer(true)}>
        Allow
      </Button>
      <Button size="sm" variant="outline" disabled={input.isPending} onClick={() => answer(false)}>
        Deny
      </Button>
    </div>
  );
}

function FollowUpInput({ run }: { run: Run }) {
  const { id: workspaceId } = useWorkspace();
  const input = useRunInput(workspaceId);
  const [text, setText] = useState('');
  const send = (event: FormEvent) => {
    event.preventDefault();
    const message = text.trim();
    if (!message) return;
    input.mutate(
      { runId: run.id, input: { kind: 'text', text: message } },
      { onSuccess: () => setText(''), onError: (error) => toast.error(errorMessage(error)) },
    );
  };
  return (
    <form onSubmit={send} className="flex gap-2">
      <Input
        aria-label="Message to the agent"
        placeholder="Send a follow-up message to the agent…"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <Button type="submit" variant="secondary" disabled={!text.trim() || input.isPending}>
        <Send /> Send
      </Button>
    </form>
  );
}

function RunView({ run }: { run: Run }) {
  const { id: workspaceId, role } = useWorkspace();
  const signal = useRunSignal(workspaceId);
  const mayControl = can(role, 'run.control');
  const controls = availableRunControls(run.status);
  const active = isRunActive(run.status);
  const live = run.status === 'running' || run.status === 'waiting_input';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);

  const send = (kind: 'pause' | 'resume' | 'interrupt' | 'stop') =>
    signal.mutate({ runId: run.id, signal: kind }, { onError: (error) => toast.error(errorMessage(error)) });
  const elapsed = run.startedAt
    ? (run.endedAt ? new Date(run.endedAt).getTime() : now) - new Date(run.startedAt).getTime()
    : null;

  return (
    <Card>
      <CardHeader className="gap-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Badge data-testid="run-status" variant={RUN_STATUS_BADGES[run.status]}>
            {RUN_STATUS_LABELS[run.status]}
          </Badge>
          <span className="font-mono text-sm">{run.cliId}</span>
          <span className="text-sm font-normal text-muted-foreground">{run.mode === 'pty' ? 'terminal' : 'structured'}</span>
          {elapsed !== null ? <span className="text-sm font-normal text-muted-foreground">{formatDuration(elapsed)}</span> : null}
          <RunUsage run={run} />
        </CardTitle>
        <CardDescription className="flex flex-col gap-0.5">
          {run.statusDetail ? <span>{run.statusDetail}</span> : null}
          {run.error ? <span className="text-destructive">{run.error}</span> : null}
          {run.resultSummary ? <span>{run.resultSummary}</span> : null}
        </CardDescription>
        {mayControl && active ? (
          <div className="flex flex-wrap gap-2">
            {controls.pause ? (
              <Button size="sm" variant="outline" onClick={() => send('pause')}>
                <Pause /> Pause
              </Button>
            ) : null}
            {controls.resume ? (
              <Button size="sm" variant="outline" onClick={() => send('resume')}>
                <Play /> Resume
              </Button>
            ) : null}
            {controls.interrupt ? (
              <Button size="sm" variant="outline" onClick={() => send('interrupt')}>
                <StopCircle /> Interrupt
              </Button>
            ) : null}
            {controls.stop ? (
              <Button size="sm" variant="destructive" onClick={() => send('stop')}>
                <Square /> Stop
              </Button>
            ) : null}
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {run.status === 'waiting_input' && mayControl ? <PermissionPrompt run={run} /> : null}
        <RunTerminal workspaceId={workspaceId} runId={run.id} interactive={mayControl && live && run.mode === 'pty'} />
        {mayControl && live && run.mode === 'structured' ? <FollowUpInput run={run} /> : null}
        {mayControl && live && run.mode === 'pty' ? (
          <p className="text-xs text-muted-foreground">Click the terminal and type: keystrokes go straight to the CLI.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

interface RunPanelProps {
  ticket: Ticket;
  project: Project | undefined;
  runs: readonly Run[];
  bindings: readonly ProjectRepoBinding[];
  runners: readonly Runner[];
}

export function RunPanel({ ticket, project, runs, bindings, runners }: RunPanelProps) {
  const { role } = useWorkspace();
  const ordered = useMemo(
    () => runs.toSorted((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [runs],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = ordered.find((run) => run.id === selectedId) ?? ordered[0];
  const busy = ordered.some((run) => isRunActive(run.status));

  return (
    <div className="flex flex-col gap-4">
      {can(role, 'run.control') ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Run an agent on this ticket</CardTitle>
            <CardDescription>
              The runner works in the ticket&apos;s own worktree and branch; nothing touches your checkout.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <StartRunForm
              ticket={ticket}
              project={project}
              bindings={bindings}
              runners={runners}
              busy={busy}
              onStarted={(run) => setSelectedId(run.id)}
            />
          </CardContent>
        </Card>
      ) : null}
      {selected ? <RunView key={selected.id} run={selected} /> : null}
      {ordered.length > 1 ? (
        <section aria-label="Run history" className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">Runs</h3>
          <ul className="flex flex-col divide-y rounded-md border text-sm">
            {ordered.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(run.id)}
                  aria-current={run.id === selected?.id ? 'true' : undefined}
                  className={cn('flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent/50', run.id === selected?.id && 'bg-accent/60')}
                >
                  <Badge variant={RUN_STATUS_BADGES[run.status]}>{RUN_STATUS_LABELS[run.status]}</Badge>
                  <span className="font-mono">{run.cliId}</span>
                  {run.parentRunId ? <span className="text-xs text-muted-foreground">follow-up</span> : null}
                  <span className="ml-auto text-xs text-muted-foreground">{formatDateTime(run.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
