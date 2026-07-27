/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/** FIFO semaphore whose queued acquisitions can be cancelled. */
interface SemaphoreWaiter {
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  abort?: () => void;
}

export class AsyncSemaphore {
  readonly #waiters: SemaphoreWaiter[] = [];
  #available: number;

  constructor(capacity: number) {
    this.#available = capacity;
  }

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
