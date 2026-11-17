'use client';

import {
  CLI_CATALOG,
  KNOWN_CLI_IDS,
  PERMISSION_MODES,
  PERSONA_ROLES,
  PermissionMode,
  type Persona,
  PersonaRole,
  RunDriver,
  RunMode,
  unenforceableLimits,
} from '@coffe/contracts';
import { AlertTriangle } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useWorkspace } from '@/components/workspace/workspace-context';
import { errorMessage } from '@/lib/api';
import {
  PERMISSION_MODE_LABELS,
  type PolicyForm,
  policyForm,
  policyFromForm,
  ROLE_LABELS,
} from '@/lib/personas';
import { useSavePersona } from '@/lib/queries/orchestration';
import { useRunners } from '@/lib/queries/runners';

interface PersonaForm {
  name: string;
  role: PersonaRole;
  cliId: string;
  model: string;
  mode: RunMode;
  driver: RunDriver;
  instructions: string;
  enabled: boolean;
  policy: PolicyForm;
}

const NEW_PERSONA: PersonaForm = {
  name: '',
  role: 'implementer',
  cliId: 'claude-code',
  model: '',
  mode: 'structured',
  driver: 'native',
  instructions: '',
  enabled: true,
  policy: policyForm({ mode: 'workspace_write', network: true, allowTools: [], denyTools: [] }),
};

function formOf(persona: Persona): PersonaForm {
  return {
    name: persona.name,
    role: persona.role,
    cliId: persona.cliId,
    model: persona.model ?? '',
    mode: persona.mode,
    driver: persona.driver,
    instructions: persona.instructions,
    enabled: persona.enabled,
    policy: policyForm(persona.permissions),
  };
}

/**
 * Creates (no `persona`) or edits a persona. Limits the chosen CLI cannot enforce are listed live,
 * the same list the API stores on the persona.
 */
export function PersonaDialog({
  persona,
  projectId,
  onClose,
}: {
  persona?: Persona;
  /** Scopes a new persona to one project; workspace-wide otherwise. */
  projectId?: string;
  onClose: () => void;
}) {
  const { id: workspaceId } = useWorkspace();
  const save = useSavePersona(workspaceId);
  const runners = useRunners(workspaceId);
  const [form, setForm] = useState<PersonaForm>(() => (persona ? formOf(persona) : NEW_PERSONA));
  const set = <K extends keyof PersonaForm>(key: K, value: PersonaForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const setPolicy = <K extends keyof PolicyForm>(key: K, value: PolicyForm[K]) =>
    setForm((current) => ({ ...current, policy: { ...current.policy, [key]: value } }));

  const detected = useMemo(() => {
    const where = new Map<string, string[]>();
    for (const runner of runners.data ?? []) {
      if (runner.status === 'revoked') continue;
      for (const cli of runner.clis)
        where.set(cli.cliId, [...(where.get(cli.cliId) ?? []), runner.name]);
    }
    return where;
  }, [runners.data]);
  const cliIds = KNOWN_CLI_IDS.filter(
    (id) => id !== 'fake' || detected.has(id) || form.cliId === id,
  );
  const policy = policyFromForm(form.policy);
  const warnings = unenforceableLimits(form.cliId, policy);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const fields = {
      name: form.name.trim(),
      role: form.role,
      cliId: form.cliId,
      model: form.model.trim() || null,
      mode: form.mode,
      driver: form.driver,
      instructions: form.instructions,
      enabled: form.enabled,
      permissions: policy,
    };
    const callbacks = {
      onSuccess: () => {
        toast.success(persona ? 'Persona saved' : `${fields.name} was created`);
        onClose();
      },
      onError: (error: Error) => toast.error(errorMessage(error)),
    };
    if (persona) save.mutate({ id: persona.id, body: fields }, callbacks);
    else save.mutate({ body: { ...fields, projectId: projectId ?? null, color: null } }, callbacks);
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{persona ? `Edit ${persona.name}` : 'New persona'}</DialogTitle>
          <DialogDescription>
            Who runs: the CLI and model, the instructions it always gets, and what it may do.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="persona-name">Name</Label>
              <Input
                id="persona-name"
                required
                maxLength={80}
                value={form.name}
                onChange={(event) => set('name', event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="persona-role">Role</Label>
              <Select
                value={form.role}
                onValueChange={(value) => set('role', PersonaRole.catch('custom').parse(value))}
              >
                <SelectTrigger id="persona-role" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PERSONA_ROLES.map((role) => (
                    <SelectItem key={role} value={role}>
                      {ROLE_LABELS[role]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="persona-cli">CLI</Label>
              <Select value={form.cliId} onValueChange={(value) => set('cliId', value)}>
                <SelectTrigger id="persona-cli" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {cliIds.map((id) => (
                    <SelectItem key={id} value={id}>
                      {CLI_CATALOG[id]?.name ?? id} ·{' '}
                      {detected.has(id) ? `on ${detected.get(id)?.join(', ')}` : 'not detected'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="persona-model">Model</Label>
              <Input
                id="persona-model"
                className="font-mono"
                placeholder="CLI default"
                value={form.model}
                onChange={(event) => set('model', event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="persona-mode">Mode</Label>
              <Select
                value={form.mode}
                onValueChange={(value) => set('mode', RunMode.catch('structured').parse(value))}
              >
                <SelectTrigger id="persona-mode" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="structured">Structured</SelectItem>
                  <SelectItem value="pty">Interactive terminal</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="persona-driver">Driver</Label>
              <Select
                value={form.driver}
                onValueChange={(value) => set('driver', RunDriver.catch('native').parse(value))}
              >
                <SelectTrigger id="persona-driver" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="native">Native stream</SelectItem>
                  <SelectItem value="acp">Agent Client Protocol</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="persona-instructions">Instructions</Label>
            <Textarea
              id="persona-instructions"
              rows={6}
              placeholder="You are the implementer. Keep changes small and covered by tests."
              value={form.instructions}
              onChange={(event) => set('instructions', event.target.value)}
            />
          </div>
          <fieldset className="flex flex-col gap-4 rounded-lg border p-4">
            <legend className="px-1 text-sm font-medium">Permission limits</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="persona-permission">Access</Label>
                <Select
                  value={form.policy.mode}
                  onValueChange={(value) =>
                    setPolicy('mode', PermissionMode.catch('workspace_write').parse(value))
                  }
                >
                  <SelectTrigger id="persona-permission" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PERMISSION_MODES.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {PERMISSION_MODE_LABELS[mode]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <label className="flex items-center gap-2 self-end pb-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.policy.network}
                  onChange={(event) => setPolicy('network', event.target.checked)}
                />
                Network access
              </label>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="persona-allow">Allowed tools (one per line)</Label>
                <Textarea
                  id="persona-allow"
                  rows={3}
                  className="font-mono text-xs"
                  placeholder="Bash(cargo test:*)"
                  value={form.policy.allowTools}
                  onChange={(event) => setPolicy('allowTools', event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="persona-deny">Denied tools (one per line)</Label>
                <Textarea
                  id="persona-deny"
                  rows={3}
                  className="font-mono text-xs"
                  placeholder="Bash(rm:*)"
                  value={form.policy.denyTools}
                  onChange={(event) => setPolicy('denyTools', event.target.value)}
                />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="persona-turns">Max turns</Label>
                <Input
                  id="persona-turns"
                  type="number"
                  min={1}
                  max={1000}
                  placeholder="No limit"
                  value={form.policy.maxTurns}
                  onChange={(event) => setPolicy('maxTurns', event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="persona-budget">Budget (USD)</Label>
                <Input
                  id="persona-budget"
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="No limit"
                  value={form.policy.maxBudgetUsd}
                  onChange={(event) => setPolicy('maxBudgetUsd', event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="persona-timeout">Timeout (minutes)</Label>
                <Input
                  id="persona-timeout"
                  type="number"
                  min={1}
                  max={1440}
                  placeholder="Runner default"
                  value={form.policy.timeoutMinutes}
                  onChange={(event) => setPolicy('timeoutMinutes', event.target.value)}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Every CLI runs in its own worktree; the runner always enforces the timeout and blocks{' '}
              <code>git push</code>.
            </p>
          </fieldset>
          {warnings.length > 0 ? (
            <Alert variant="warning">
              <AlertTriangle />
              <AlertTitle>
                {CLI_CATALOG[form.cliId]?.name ?? form.cliId} cannot enforce every limit
              </AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4">
                  {warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => set('enabled', event.target.checked)}
            />
            Enabled (can be assigned to tickets and workflow steps)
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending || form.name.trim() === ''}>
              {persona ? 'Save' : 'Create persona'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
