import { describe, expect, it, vi } from 'vitest';
import { SeqAssembler, SeqStream } from './terminal-output';

interface Chunk {
  seq: number;
  data: string;
}

function chunk(seq: number): Chunk {
  return { seq, data: `#${seq}` };
}

describe('SeqAssembler', () => {
  it('emits history before held live items, each seq once, in order', () => {
    const emitted: number[] = [];
    const assembler = new SeqAssembler<Chunk>((item) => emitted.push(item.seq));
    assembler.beginReplay();
    assembler.pushLive(chunk(4));
    assembler.pushLive(chunk(5));
    assembler.applyReplayPage([chunk(3), chunk(1), chunk(2), chunk(4)]);
    expect(emitted).toEqual([1, 2, 3, 4]);
    expect(assembler.replayReachedLive).toBe(true);
    assembler.endReplay();
    assembler.pushLive(chunk(5));
    assembler.pushLive(chunk(6));
    expect(emitted).toEqual([1, 2, 3, 4, 5, 6]);
    expect(assembler.cursor).toBe(6);
  });
});

describe('SeqStream', () => {
  it('pages through history from the cursor and then passes live items straight through', async () => {
    const emitted: number[] = [];
    const stored = [1, 2, 3, 4, 5].map(chunk);
    const fetchPage = vi.fn(async (afterSeq: number) => stored.filter((item) => item.seq > afterSeq).slice(0, 2));
    const synced = Promise.withResolvers<void>();
    const stream = new SeqStream<Chunk>({
      emit: (item) => emitted.push(item.seq),
      fetchPage,
      onError: () => false,
      onSynced: () => synced.resolve(),
    });

    stream.resync();
    // Published while the replay runs: held back, then de-duplicated against history.
    stream.pushLive(chunk(5));
    stream.pushLive(chunk(6));
    await synced.promise;
    stream.pushLive(chunk(7));

    expect(emitted).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(fetchPage.mock.calls.map(([afterSeq]) => afterSeq)).toEqual([0, 2, 4]);
  });

  it('retries a failed replay with backoff when the error is retryable', async () => {
    vi.useFakeTimers();
    try {
      const emitted: number[] = [];
      let calls = 0;
      const synced = Promise.withResolvers<void>();
      const stream = new SeqStream<Chunk>({
        emit: (item) => emitted.push(item.seq),
        fetchPage: async (afterSeq) => {
          calls += 1;
          if (calls === 1) throw new Error('offline');
          return afterSeq === 0 ? [chunk(1)] : [];
        },
        onError: () => true,
        onSynced: () => synced.resolve(),
      });
      stream.resync();
      await vi.advanceTimersByTimeAsync(1_000);
      await synced.promise;
      expect(emitted).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops emitting once disposed', async () => {
    const emitted: number[] = [];
    const stream = new SeqStream<Chunk>({
      emit: (item) => emitted.push(item.seq),
      fetchPage: async () => [],
      onError: () => false,
    });
    stream.dispose();
    stream.pushLive(chunk(1));
    stream.resync();
    await Promise.resolve();
    expect(emitted).toEqual([]);
  });
});
