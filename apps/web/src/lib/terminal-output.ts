/**
 * Run output and run events are per-run logs ordered by `seq` (architecture §8.5). The browser
 * reads them twice: stored history over REST (`?afterSeq=`) and new entries over the realtime
 * channel. These helpers merge both into one gap-free, duplicate-free, ordered stream.
 */

export interface SeqItem {
  readonly seq: number;
}

function bySeq(a: SeqItem, b: SeqItem): number {
  return a.seq - b.seq;
}

/**
 * Orders and de-duplicates one log. While a replay is in progress live items are held back, so
 * history is always emitted before anything newer; every seq is emitted at most once.
 */
export class SeqAssembler<T extends SeqItem> {
  private readonly emit: (item: T) => void;
  private highWater = 0;
  private replaying = false;
  private held: T[] = [];
  private firstLiveSeq: number | null = null;

  constructor(emit: (item: T) => void) {
    this.emit = emit;
  }

  /** Highest seq emitted so far: the `afterSeq` of the next replay request. */
  get cursor(): number {
    return this.highWater;
  }

  /**
   * True when the replay has reached an item that also arrived live during this replay pass:
   * history and the live stream overlap, so nothing can be missing between them.
   */
  get replayReachedLive(): boolean {
    return this.firstLiveSeq !== null && this.highWater >= this.firstLiveSeq;
  }

  /** Starts (or restarts) a replay pass; live items are held until `endReplay`. */
  beginReplay(): void {
    this.replaying = true;
    this.firstLiveSeq = null;
  }

  /** Emits the unseen items of one replay page in seq order. */
  applyReplayPage(page: readonly T[]): void {
    for (const item of [...page].sort(bySeq)) this.emitNew(item);
  }

  /** Ends the replay and releases the live items that arrived meanwhile. */
  endReplay(): void {
    this.replaying = false;
    const held = this.held.sort(bySeq);
    this.held = [];
    for (const item of held) this.emitNew(item);
  }

  /** Accepts an item from the realtime channel (delivered in seq order by the server). */
  pushLive(item: T): void {
    if (!this.replaying) {
      this.emitNew(item);
      return;
    }
    this.firstLiveSeq ??= item.seq;
    if (item.seq > this.highWater) this.held.push(item);
  }

  private emitNew(item: T): void {
    if (item.seq <= this.highWater) return;
    this.highWater = item.seq;
    this.emit(item);
  }
}

export interface SeqStreamOptions<T extends SeqItem> {
  emit: (item: T) => void;
  /** Loads stored items with `seq > afterSeq`, oldest first. */
  fetchPage: (afterSeq: number, signal: AbortSignal) => Promise<readonly T[]>;
  /** Reports a failed replay attempt. Return `true` to retry with backoff, `false` to give up. */
  onError: (error: unknown) => boolean;
  /** History is complete and live items now flow straight through. */
  onSynced?: () => void;
}

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 15_000;

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const finish = () => {
    window.clearTimeout(timer);
    signal.removeEventListener('abort', finish);
    resolve();
  };
  const timer = window.setTimeout(finish, ms);
  signal.addEventListener('abort', finish);
  return promise;
}

/**
 * Keeps a `SeqAssembler` in sync with the server: `resync()` pages through REST from the current
 * cursor while live items are held back. Call it once at start and whenever the realtime
 * subscription is (re)confirmed — events published while disconnected are only available via REST.
 */
export class SeqStream<T extends SeqItem> {
  private readonly options: SeqStreamOptions<T>;
  private readonly assembler: SeqAssembler<T>;
  private readonly controller = new AbortController();
  private syncing = false;
  private resyncRequested = false;

  constructor(options: SeqStreamOptions<T>) {
    this.options = options;
    this.assembler = new SeqAssembler<T>((item) => {
      if (!this.controller.signal.aborted) options.emit(item);
    });
  }

  pushLive(item: T): void {
    if (!this.controller.signal.aborted) this.assembler.pushLive(item);
  }

  /** Requests a replay; requests made while one is running are coalesced into one more pass. */
  resync(): void {
    if (this.controller.signal.aborted) return;
    this.resyncRequested = true;
    if (!this.syncing) void this.run();
  }

  /** Stops fetching and emitting; the stream cannot be reused afterwards. */
  dispose(): void {
    this.controller.abort();
  }

  private async run(): Promise<void> {
    const { signal } = this.controller;
    this.syncing = true;
    let complete = false;
    let retryDelay = RETRY_BASE_MS;

    while (this.resyncRequested && !signal.aborted) {
      this.resyncRequested = false;
      // Synchronous with the `resync()` call that started this pass: an event delivered right
      // after it is already held back.
      this.assembler.beginReplay();
      try {
        await this.replayPass(signal);
        complete = true;
        retryDelay = RETRY_BASE_MS;
      } catch (error) {
        complete = false;
        if (signal.aborted || !this.options.onError(error)) break;
        this.resyncRequested = true;
        await abortableDelay(retryDelay, signal);
        retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
      }
    }

    this.assembler.endReplay();
    this.syncing = false;
    if (complete && !signal.aborted) this.options.onSynced?.();
  }

  private async replayPass(signal: AbortSignal): Promise<void> {
    for (;;) {
      const cursor = this.assembler.cursor;
      const page = await this.options.fetchPage(cursor, signal);
      if (signal.aborted) return;
      this.assembler.applyReplayPage(page);
      // Caught up: the server had nothing newer, or history now overlaps the live stream.
      if (this.assembler.cursor === cursor || this.assembler.replayReachedLive) return;
    }
  }
}
