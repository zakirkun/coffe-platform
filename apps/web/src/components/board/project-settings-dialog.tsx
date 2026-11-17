'use client';

import { MergeStrategy, type Project, type RunMode } from '@coffe/contracts';
import { Settings } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { useWorkspace } from '@/components/workspace/workspace-context';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { errorMessage } from '@/lib/api';
import { useUpdateProject } from '@/lib/queries/projects';

const MERGE_LABELS: Record<MergeStrategy, string> = {
  merge: 'Merge commit (--no-ff)',
  squash: 'Squash into one commit',
  ff_only: 'Fast-forward only',
};

/** Run defaults and the review gate of one project. */
export function ProjectSettingsDialog({ project }: { project: Project }) {
  const { id: workspaceId } = useWorkspace();
  const update = useUpdateProject(workspaceId, project.id);
  const [open, setOpen] = useState(false);
  const [testCommand, setTestCommand] = useState('');
  const [defaultCliId, setDefaultCliId] = useState('');
  const [defaultMode, setDefaultMode] = useState<RunMode>('structured');
  const [mergeStrategy, setMergeStrategy] = useState<MergeStrategy>('merge');
  const [pushOnApprove, setPushOnApprove] = useState(false);
  const [remote, setRemote] = useState('');
  const [requirePassingTests, setRequirePassingTests] = useState(false);

  const onOpenChange = (next: boolean) => {
    if (next) {
      const { settings } = project;
      setTestCommand(settings.testCommand ?? '');
      setDefaultCliId(settings.defaultCliId ?? '');
      setDefaultMode(settings.defaultMode ?? 'structured');
      setMergeStrategy(settings.mergeStrategy ?? 'merge');
      setPushOnApprove(settings.pushOnApprove ?? false);
      setRemote(settings.remote ?? '');
      setRequirePassingTests(settings.requirePassingTests ?? false);
    }
    setOpen(next);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate(
      {
        settings: {
          testCommand: testCommand.trim() || null,
          defaultCliId: defaultCliId.trim() || null,
          defaultMode,
          mergeStrategy,
          pushOnApprove,
          remote: remote.trim() || null,
          requirePassingTests,
        },
      },
      {
        onSuccess: () => {
          toast.success('Project settings saved');
          setOpen(false);
        },
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Settings /> Settings
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Project settings</DialogTitle>
          <DialogDescription>Defaults for new runs and what happens when a diff is approved.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="settings-test-command">Test command</Label>
            <Input
              id="settings-test-command"
              className="font-mono"
              placeholder="pnpm test"
              value={testCommand}
              onChange={(event) => setTestCommand(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">Runs in the worktree after every successful run; results gate the review.</p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={requirePassingTests} onChange={(event) => setRequirePassingTests(event.target.checked)} />
            Block approval until the latest test command and tester report pass
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="settings-default-cli">Default CLI id</Label>
              <Input
                id="settings-default-cli"
                className="font-mono"
                placeholder="claude-code"
                value={defaultCliId}
                onChange={(event) => setDefaultCliId(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="settings-default-mode">Default mode</Label>
              <Select value={defaultMode} onValueChange={(value) => setDefaultMode(value === 'pty' ? 'pty' : 'structured')}>
                <SelectTrigger id="settings-default-mode" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="structured">Structured</SelectItem>
                  <SelectItem value="pty">Interactive terminal</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="settings-merge">On approve</Label>
            <Select
              value={mergeStrategy}
              onValueChange={(value) => setMergeStrategy(MergeStrategy.catch('merge').parse(value))}
            >
              <SelectTrigger id="settings-merge" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(MERGE_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={pushOnApprove} onChange={(event) => setPushOnApprove(event.target.checked)} />
            Push the base branch after merging (needs <code className="font-mono">allow_push</code> in the runner policy)
          </label>
          {pushOnApprove ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="settings-remote">Remote</Label>
              <Input id="settings-remote" placeholder="origin" value={remote} onChange={(event) => setRemote(event.target.value)} />
            </div>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={update.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
