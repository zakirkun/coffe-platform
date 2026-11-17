interface Waiter<F> {
  matches(frame: F): boolean;
  resolve(frame: F): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * Frames received from a socket, kept until a test asks for them: `take` returns the oldest
 * matching frame, waiting for it when none arrived yet; everything else stays buffered.
 */
export class Inbox<F> {
  private readonly frames: F[] = [];
  private readonly waiters = new Set<Waiter<F>>();
  private failure: Error | null = null;

  push(frame: F): void {
    for (const waiter of this.waiters) {
      if (!waiter.matches(frame)) continue;
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
      return;
    }
    this.frames.push(frame);
  }

  /** Rejects after `timeoutMs`, or as soon as the socket failed before a matching frame came. */
  take(matches: (frame: F) => boolean, timeoutMs: number, what: string): Promise<F> {
    for (const [index, frame] of this.frames.entries()) {
      if (!matches(frame)) continue;
      this.frames.splice(index, 1);
      return Promise.resolve(frame);
    }
    if (this.failure) return Promise.reject(this.failure);

    const { promise, resolve, reject } = Promise.withResolvers<F>();
    const waiter: Waiter<F> = {
      matches,
      resolve,
      reject,
      timer: setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`no ${what} within ${timeoutMs} ms`));
      }, timeoutMs),
    };
    this.waiters.add(waiter);
    return promise;
  }

  /** The socket is gone (or sent garbage): pending and future `take` calls without a frame fail. */
  fail(error: Error): void {
    this.failure ??= error;
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(this.failure);
    }
    this.waiters.clear();
  }

  /** Forgets everything, for a new connection. */
  reset(): void {
    this.frames.length = 0;
    this.failure = null;
  }
}
