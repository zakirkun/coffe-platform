'use client';

import type { PairingTokenResponse } from '@coffe/contracts';
import { Check, Copy, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { errorMessage } from '@/lib/api';
import { formatCountdown } from '@/lib/format';
import { useCreatePairingToken } from '@/lib/queries/runners';

function useCountdown(expiresAt: string | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  return expiresAt ? new Date(expiresAt).getTime() - now : null;
}

function PairingInstructions({ pairing }: { pairing: PairingTokenResponse }) {
  const [copied, setCopied] = useState(false);
  const remaining = useCountdown(pairing.expiresAt);
  const expired = remaining !== null && remaining <= 0;

  const copy = async () => {
    await navigator.clipboard.writeText(pairing.command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2_000);
  };

  return (
    <div className="flex flex-col gap-4 text-sm">
      <ol className="flex list-decimal flex-col gap-1 pl-5 text-muted-foreground">
        <li>Install <code className="font-mono">coffe-runner</code> on the machine that has your repositories and agent CLIs.</li>
        <li>Run this command there. The token works once.</li>
        <li>Register repositories with <code className="font-mono">coffe-runner repo add &lt;path&gt;</code>, then <code className="font-mono">coffe-runner start</code>.</li>
      </ol>
      <div className="relative">
        <pre
          data-testid="pairing-command"
          className="overflow-x-auto rounded-md border bg-muted p-3 pr-12 font-mono text-xs whitespace-pre-wrap break-all"
        >
          {pairing.command}
        </pre>
        <Button
          variant="ghost"
          size="icon-sm"
          className="absolute top-2 right-2"
          aria-label={copied ? 'Copied' : 'Copy the command'}
          onClick={() => void copy()}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
      <p className={expired ? 'text-destructive' : 'text-muted-foreground'}>
        {expired
          ? 'This token expired. Close the dialog and create a new one.'
          : `The token expires in ${remaining === null ? '…' : formatCountdown(remaining)}. The runner shows up below once it connects.`}
      </p>
    </div>
  );
}

export function PairRunnerDialog({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  const createToken = useCreatePairingToken(workspaceId);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) createToken.mutate({});
    else createToken.reset();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button>Pair a runner</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Pair a runner</DialogTitle>
          <DialogDescription>
            The runner connects out to COFFE over a WebSocket; no inbound ports are needed.
          </DialogDescription>
        </DialogHeader>
        {createToken.isPending ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Creating a pairing token…
          </div>
        ) : createToken.error ? (
          <Alert variant="destructive">
            <AlertDescription>{errorMessage(createToken.error)}</AlertDescription>
          </Alert>
        ) : createToken.data ? (
          <PairingInstructions pairing={createToken.data} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
