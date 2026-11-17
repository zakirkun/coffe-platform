import type { Ticket, TicketStatus } from '@coffe/contracts';
import { describe, expect, it } from 'vitest';
import { groupTicketIds, neighboursOf } from './ticket-status';

const NOW = '2026-01-01T00:00:00.000Z';

function ticket(id: string, status: TicketStatus, position: string): Ticket {
  return {
    id,
    projectId: 'p',
    number: 1,
    key: `COF-${id}`,
    title: id,
    description: '',
    acceptanceCriteria: [],
    status,
    position,
    priority: 0,
    labels: [],
    assigneePersonaId: null,
    branch: null,
    baseBranch: null,
    worktreeRunnerId: null,
    repoId: null,
    flags: {},
    blockedBy: [],
    latestRun: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('groupTicketIds', () => {
  it('puts every ticket in its column in fractional-index order', () => {
    const columns = groupTicketIds([
      ticket('c', 'ready', 'a1'),
      ticket('a', 'ready', 'a0'),
      ticket('b', 'ready', 'a0V'),
      ticket('d', 'done', 'Zz'),
    ]);
    expect(columns.ready).toEqual(['a', 'b', 'c']);
    expect(columns.done).toEqual(['d']);
    expect(columns.backlog).toEqual([]);
  });
});

describe('neighboursOf', () => {
  const columns = {
    backlog: [],
    ready: ['a', 'b', 'c'],
    in_progress: ['x'],
    in_review: [],
    done: [],
  };

  it('names the tickets around the dropped one', () => {
    expect(neighboursOf(columns, 'b')).toEqual({ status: 'ready', afterId: 'a', beforeId: 'c' });
    expect(neighboursOf(columns, 'a')).toEqual({ status: 'ready', afterId: null, beforeId: 'b' });
    expect(neighboursOf(columns, 'x')).toEqual({
      status: 'in_progress',
      afterId: null,
      beforeId: null,
    });
  });

  it('returns null for a ticket that is not on the board', () => {
    expect(neighboursOf(columns, 'gone')).toBeNull();
  });
});
