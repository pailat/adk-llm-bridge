/** A queued acquisition waiting for a permit, cancellable through its abort signal. */
interface SemaphoreWaiter {
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  abort?: () => void;
}

/**
 * Counting semaphore that bounds concurrent async operations.
 *
 * @remarks
 * Waiters are served in FIFO order and a queued acquisition is removed when its
 * abort signal fires.
 *
 * @internal
 */
export class AsyncSemaphore {
  readonly #waiters: SemaphoreWaiter[] = [];
  #available: number;

  constructor(capacity: number) {
    this.#available = capacity;
  }

  /**
   * Runs `operation` while holding one permit, released when it settles.
   *
   * @param signal - Aborts a queued acquisition, rejecting with the signal's reason.
   * @param operation - Work to run once a permit is available.
   * @returns The result of `operation`.
   */
  async use<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private acquire(signal: AbortSignal): Promise<() => void> {
    throwIfSignalAborted(signal);
    if (this.#available > 0) {
      this.#available--;
      return Promise.resolve(this.releaseOnce());
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: SemaphoreWaiter = { resolve, reject, signal };
      waiter.abort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(signal.reason ?? new Error("Semaphore acquisition aborted"));
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      while (this.#waiters.length > 0) {
        const waiter = this.#waiters.shift() as SemaphoreWaiter;
        if (waiter.abort)
          waiter.signal?.removeEventListener("abort", waiter.abort);
        if (waiter.signal?.aborted) continue;
        waiter.resolve(this.releaseOnce());
        return;
      }
      this.#available++;
    };
  }
}

function throwIfSignalAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason ?? new Error("Semaphore acquisition aborted");
}
