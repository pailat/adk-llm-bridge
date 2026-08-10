/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/** Minimal push-driven async queue used to stream workflow and child events. */
export class AsyncEventQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  #closed = false;
  #error: unknown;

  push(item: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve({ value: item, done: false });
      return;
    }
    this.#items.push(item);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    while (this.#waiters.length > 0) {
      this.#waiters.shift()?.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.#closed) return;
    this.#error = error;
    this.#closed = true;
    while (this.#waiters.length > 0) {
      this.#waiters.shift()?.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }

  private next(): Promise<IteratorResult<T>> {
    if (this.#items.length > 0) {
      return Promise.resolve({ value: this.#items.shift() as T, done: false });
    }
    if (this.#error !== undefined) return Promise.reject(this.#error);
    if (this.#closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }
}
