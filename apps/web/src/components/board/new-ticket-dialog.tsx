'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { useWorkspace } from '@/components/workspace/workspace-context';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/lib/api';
import { useCreateTicket } from '@/lib/queries/tickets';

const TicketValues = z.object({
  title: z.string().trim().min(1, 'Enter a title').max(300),
  description: z.string().max(50_000),
  /** One criterion per line. */
  criteria: z.string().max(50_000),
});
type TicketValues = z.infer<typeof TicketValues>;

export function NewTicketDialog({ projectId }: { projectId: string }) {
  const { id: workspaceId } = useWorkspace();
  const [open, setOpen] = useState(false);
  const createTicket = useCreateTicket(workspaceId, projectId);
  const form = useForm<TicketValues>({
    resolver: zodResolver(TicketValues),
    defaultValues: { title: '', description: '', criteria: '' },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const ticket = await createTicket.mutateAsync({
        title: values.title,
        description: values.description,
        acceptanceCriteria: values.criteria
          .split('\n')
          .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
          .filter((line) => line.length > 0),
      });
      toast.success(`${ticket.key} created`);
      setOpen(false);
      form.reset();
    } catch {
      // Rendered from `createTicket.error`.
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) createTicket.reset();
      }}
    >
      <DialogTrigger asChild>
        <Button>New ticket</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New ticket</DialogTitle>
          <DialogDescription>Describe the outcome; the agent gets the ticket as its task.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
          {createTicket.error ? (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(createTicket.error)}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-col gap-2">
            <Label htmlFor="ticket-title">Title</Label>
            <Input id="ticket-title" aria-invalid={Boolean(errors.title)} {...form.register('title')} />
            {errors.title ? <p className="text-xs text-destructive">{errors.title.message}</p> : null}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="ticket-description">Description</Label>
            <Textarea id="ticket-description" rows={5} placeholder="Markdown is supported." {...form.register('description')} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="ticket-criteria">Acceptance criteria</Label>
            <Textarea id="ticket-criteria" rows={3} placeholder="One per line" {...form.register('criteria')} />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Creating…' : 'Create ticket'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
