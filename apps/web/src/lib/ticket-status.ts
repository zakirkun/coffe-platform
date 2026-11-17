import { type MoveTicketRequest, TICKET_STATUSES, type Ticket, type TicketStatus } from '@coffe/contracts';
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

/** Ticket ids per board column, in board order. */
export type TicketColumns = Record<TicketStatus, string[]>;

function byPosition(a: Ticket, b: Ticket): number {
  if (a.position === b.position) return 0;
  return a.position < b.position ? -1 : 1;
}

export function groupTicketIds(tickets: readonly Ticket[]): TicketColumns {
  const columns: TicketColumns = { backlog: [], ready: [], in_progress: [], in_review: [], done: [] };
  for (const ticket of tickets.toSorted(byPosition)) columns[ticket.status].push(ticket.id);
  return columns;
}

/** Where a ticket sits in `columns`, as the move request that puts it there; `null` when absent. */
export function neighboursOf(columns: TicketColumns, ticketId: string): Required<MoveTicketRequest> | null {
  for (const status of TICKET_STATUSES) {
    const ids = columns[status];
    const index = ids.indexOf(ticketId);
    if (index === -1) continue;
    return { status, afterId: ids[index - 1] ?? null, beforeId: ids[index + 1] ?? null };
  }
  return null;
}
