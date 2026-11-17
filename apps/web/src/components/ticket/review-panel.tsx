'use client';

import type { Diff, DiffFile, Merge, ReviewState, TestResult, Ticket } from '@coffe/contracts';
import { CheckCircle2, GitMerge, MessageSquareWarning, RefreshCw, XCircle } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useWorkspace } from '@/components/workspace/workspace-context';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/lib/api';
import { formatDateTime, formatDuration, shortSha } from '@/lib/format';
import { splitPatchByFile } from '@/lib/patch';
import { can } from '@/lib/permissions';
import { useApprove, useFileContent, useRefreshDiff, useRequestChanges, useReview } from '@/lib/queries/review';
import { cn } from '@/lib/utils';
import { PatchView } from './patch-view';

const MonacoDiff = dynamic(() => import('./monaco-diff'), {
  ssr: false,
  loading: () => <Skeleton className="h-[32rem] w-full" />,
});

/** `git diff --name-status` letters; anything unexpected is shown as `?`. */
const FILE_STATUS: Partial<Record<string, { letter: string; className: string }>> = {
  added: { letter: 'A', className: 'text-emerald-600' },
  modified: { letter: 'M', className: 'text-amber-600' },
  deleted: { letter: 'D', className: 'text-red-600' },
  renamed: { letter: 'R', className: 'text-sky-600' },
  copied: { letter: 'C', className: 'text-sky-600' },
  type_changed: { letter: 'T', className: 'text-muted-foreground' },
};

const TEST_BADGES: Record<TestResult['status'], BadgeVariant> = {
  passed: 'success',
  failed: 'destructive',
  error: 'warning',
};

const MERGE_LABELS: Record<Merge['status'], string> = {
  pending: 'Merging…',
  merged: 'Merged',
  conflict: 'Merge conflict',
  failed: 'Merge failed',
  nothing_to_merge: 'Nothing to merge',
};

function FileDiff({ ticketId, diff, file }: { ticketId: string; diff: Diff; file: DiffFile }) {
  const { id: workspaceId } = useWorkspace();
  const [sideBySide, setSideBySide] = useState(true);
  const [monacoFailed, setMonacoFailed] = useState(false);
  const onUnavailable = useCallback(() => setMonacoFailed(true), []);
  const hasOriginal = file.status !== 'added';
  const hasModified = file.status !== 'deleted';
  const original = useFileContent(
    workspaceId,
    ticketId,
    hasOriginal && !file.binary ? diff.baseCommit : null,
    hasOriginal && !file.binary ? (file.oldPath ?? file.path) : null,
  );
  const modified = useFileContent(
    workspaceId,
    ticketId,
    hasModified && !file.binary ? diff.headCommit : null,
    hasModified && !file.binary ? file.path : null,
  );
  const section = useMemo(() => splitPatchByFile(diff.patch).get(file.path), [diff.patch, file.path]);

  if (file.binary) return <p className="p-4 text-sm text-muted-foreground">Binary file; no text diff.</p>;

  const originalText = hasOriginal ? original.data?.content : '';
  const modifiedText = hasModified ? modified.data?.content : '';
  const contentFailed = Boolean(original.error || modified.error);
  const contentUnusable = [original.data, modified.data].some((content) => content && (content.binary || content.tooLarge));
  const loading = (hasOriginal && original.isPending) || (hasModified && modified.isPending);

  if (monacoFailed || contentFailed || contentUnusable) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">
          {contentFailed
            ? 'Showing the stored patch: the runner holding the worktree is unreachable right now.'
            : 'Showing the stored patch.'}
        </p>
        {section ? <PatchView section={section} /> : <p className="text-sm text-muted-foreground">No patch stored for this file (diff truncated).</p>}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={() => setSideBySide((value) => !value)}>
          {sideBySide ? 'Inline view' : 'Side-by-side view'}
        </Button>
      </div>
      {loading || originalText === undefined || modifiedText === undefined ? (
        <Skeleton className="h-[32rem] w-full" />
      ) : (
        <MonacoDiff
          original={originalText ?? ''}
          modified={modifiedText ?? ''}
          path={file.path}
          sideBySide={sideBySide}
          onUnavailable={onUnavailable}
        />
      )}
    </div>
  );
}

const TEST_SOURCE_TITLES: Record<TestResult['source'], string> = {
  command: 'Test command',
  agent: 'Tester report',
};

function TestCard({ result }: { result: TestResult }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {TEST_SOURCE_TITLES[result.source]}
          <Badge variant={TEST_BADGES[result.status]}>{result.status}</Badge>
        </CardTitle>
        <CardDescription>
          {result.passed} passed · {result.failed} failed · {result.skipped} skipped
          {result.durationMs != null ? ` · ${formatDuration(result.durationMs)}` : ''}
          {result.command ? (
            <>
              {' · '}
              <code className="font-mono">{result.command}</code>
            </>
          ) : null}
        </CardDescription>
      </CardHeader>
      {result.failures.length > 0 || result.outputTail ? (
        <CardContent className="flex flex-col gap-2">
          {result.failures.length > 0 ? (
            <ul className="list-disc pl-5 text-sm">
              {result.failures.map((failure) => (
                <li key={failure.name}>
                  <span className="font-medium">{failure.name}</span>
                  {failure.message ? `: ${failure.message}` : ''}
                </li>
              ))}
            </ul>
          ) : null}
          {result.outputTail ? (
            <details>
              <summary className="cursor-pointer text-sm text-muted-foreground">Output</summary>
              <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
                {result.outputTail}
              </pre>
            </details>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}

/** The latest result of the project's test command and of the tester persona (newest first). */
function TestSummary({ tests }: { tests: TestResult[] }) {
  const latest = (['command', 'agent'] as const).flatMap((source) => tests.find((test) => test.source === source) ?? []);
  return latest.map((result) => <TestCard key={result.id} result={result} />);
}

function DecisionBar({ ticket, review }: { ticket: Ticket; review: ReviewState }) {
  const { id: workspaceId, role } = useWorkspace();
  const approve = useApprove(workspaceId, ticket.id);
  const requestChanges = useRequestChanges(workspaceId, ticket.id);
  const [approveOpen, setApproveOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [feedback, setFeedback] = useState('');

  if (!can(role, 'review.decide') || ticket.status !== 'in_review') return null;

  const doApprove = () =>
    approve.mutate(comment.trim(), {
      onSuccess: ({ merge }) => {
        setApproveOpen(false);
        setComment('');
        if (merge.status === 'merged') toast.success(`Merged into ${merge.targetBranch}`);
        else if (merge.status === 'conflict') toast.warning('The merge has conflicts; the ticket stays in review.');
        else toast.info(MERGE_LABELS[merge.status]);
      },
      onError: (error) => toast.error(errorMessage(error)),
    });
  const doRequestChanges = () =>
    requestChanges.mutate(feedback.trim(), {
      onSuccess: () => {
        setChangesOpen(false);
        setFeedback('');
        toast.success('Feedback sent; the agent is working on it.');
      },
      onError: (error) => toast.error(errorMessage(error)),
    });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Dialog open={approveOpen} onOpenChange={setApproveOpen}>
        <DialogTrigger asChild>
          <Button disabled={!review.canApprove}>
            <CheckCircle2 /> Approve
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve and merge</DialogTitle>
            <DialogDescription>
              {ticket.branch ?? 'The ticket branch'} is merged into {ticket.baseBranch ?? 'the base branch'} on the
              runner and the worktree is removed.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label="Review comment"
            placeholder="Optional comment"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproveOpen(false)}>
              Cancel
            </Button>
            <Button onClick={doApprove} disabled={approve.isPending}>
              <GitMerge /> {approve.isPending ? 'Merging…' : 'Approve and merge'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={changesOpen} onOpenChange={setChangesOpen}>
        <DialogTrigger asChild>
          <Button variant="outline">
            <MessageSquareWarning /> Request changes
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request changes</DialogTitle>
            <DialogDescription>The agent continues in the same worktree with your feedback.</DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label="Feedback for the agent"
            placeholder="What should change?"
            rows={5}
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setChangesOpen(false)}>
              Cancel
            </Button>
            <Button onClick={doRequestChanges} disabled={!feedback.trim() || requestChanges.isPending}>
              Send to agent
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {!review.canApprove && review.blockers.length > 0 ? (
        <span className="text-sm text-muted-foreground">{review.blockers.join(' · ')}</span>
      ) : null}
    </div>
  );
}

export function ReviewPanel({ ticket }: { ticket: Ticket }) {
  const { id: workspaceId, role } = useWorkspace();
  const review = useReview(workspaceId, ticket.id);
  const refresh = useRefreshDiff(workspaceId, ticket.id);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  if (review.isPending) return <Skeleton className="h-64 w-full" />;
  if (review.error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {errorMessage(review.error)}
      </p>
    );
  }
  const state = review.data;
  const { diff } = state;
  const file = diff?.files.find((candidate) => candidate.path === selectedPath) ?? diff?.files[0];
  const [lastMerge] = state.merges;

  return (
    <div className="flex flex-col gap-4">
      {lastMerge && lastMerge.status !== 'merged' ? (
        <Alert variant={lastMerge.status === 'conflict' || lastMerge.status === 'failed' ? 'destructive' : 'default'}>
          <AlertTitle>{MERGE_LABELS[lastMerge.status]}</AlertTitle>
          <AlertDescription>
            {lastMerge.status === 'conflict'
              ? `Conflicting files: ${lastMerge.conflicts.join(', ')}. Resolve them in the worktree or request changes.`
              : (lastMerge.error ?? '')}
          </AlertDescription>
        </Alert>
      ) : null}
      {lastMerge?.status === 'merged' ? (
        <Alert>
          <GitMerge />
          <AlertTitle>Merged into {lastMerge.targetBranch}</AlertTitle>
          <AlertDescription>
            {lastMerge.mergeCommit ? `Commit ${shortSha(lastMerge.mergeCommit)}` : ''} · {formatDateTime(lastMerge.createdAt)}
          </AlertDescription>
        </Alert>
      ) : null}
      <DecisionBar ticket={ticket} review={state} />
      <TestSummary tests={state.tests} />
      {diff ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              Changes
              <span className="text-sm font-normal text-emerald-600">+{diff.additions}</span>
              <span className="text-sm font-normal text-red-600">−{diff.deletions}</span>
              <span className="font-mono text-xs font-normal text-muted-foreground">
                {shortSha(diff.baseCommit)}…{shortSha(diff.headCommit)}
              </span>
              {diff.truncated ? <Badge variant="warning">Patch truncated</Badge> : null}
            </CardTitle>
            {can(role, 'run.control') ? (
              <div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={refresh.isPending}
                  onClick={() => refresh.mutate(undefined, { onError: (error) => toast.error(errorMessage(error)) })}
                >
                  <RefreshCw className={cn(refresh.isPending && 'animate-spin')} /> Refresh diff
                </Button>
              </div>
            ) : null}
          </CardHeader>
          <CardContent className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
            <ul aria-label="Changed files" className="flex flex-col gap-0.5 text-sm">
              {diff.files.map((candidate) => (
                <li key={candidate.path}>
                  <button
                    type="button"
                    onClick={() => setSelectedPath(candidate.path)}
                    aria-current={candidate.path === file?.path ? 'true' : undefined}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-accent/60',
                      candidate.path === file?.path && 'bg-accent',
                    )}
                    title={candidate.oldPath ? `${candidate.oldPath} → ${candidate.path}` : candidate.path}
                  >
                    <span className={cn('w-3 font-mono text-xs font-semibold', FILE_STATUS[candidate.status]?.className)}>
                      {FILE_STATUS[candidate.status]?.letter ?? '?'}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{candidate.path}</span>
                    {candidate.binary ? null : (
                      <span className="text-xs text-muted-foreground">
                        +{candidate.additions ?? 0} −{candidate.deletions ?? 0}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            <div className="min-w-0">
              {file ? <FileDiff key={`${diff.id}:${file.path}`} ticketId={ticket.id} diff={diff} file={file} /> : null}
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No changes to review yet. Start a run; its diff appears here when it completes.
          </CardContent>
        </Card>
      )}
      {state.reviews.length > 0 ? (
        <section aria-label="Review history" className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Review history</h3>
          <ul className="flex flex-col gap-2 text-sm">
            {state.reviews.map((entry) => (
              <li key={entry.id} className="flex gap-2 rounded-md border p-3">
                {entry.decision === 'approved' ? (
                  <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />
                ) : (
                  <XCircle className="size-4 shrink-0 text-amber-600" />
                )}
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">
                    Round {entry.round} · {entry.reviewerName ?? 'Someone'} ·{' '}
                    {entry.decision === 'approved' ? 'approved' : 'requested changes'} · {formatDateTime(entry.createdAt)}
                  </span>
                  {entry.body ? <p className="whitespace-pre-wrap">{entry.body}</p> : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
