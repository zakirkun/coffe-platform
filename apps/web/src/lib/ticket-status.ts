import type { TicketStatus } from '@coffe/contracts';
import type { BadgeVariant } from '@/components/ui/badge';

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
};

export const TICKET_STATUS_BADGES: Record<TicketStatus, BadgeVariant> = {
  backlog: 'secondary',
  ready: 'outline',
  in_progress: 'info',
  in_review: 'warning',
  done: 'success',
};
