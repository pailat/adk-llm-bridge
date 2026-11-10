import { describe, expect, test } from "bun:test";
import { AsyncSemaphore } from "../../../src/workflows/runtime/async-semaphore.js";

/** A promise with its resolve function, so a test decides when work ends. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets queued microtasks and promise callbacks run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("AsyncSemaphore", () => {
  test("runs at most `capacity` operations at once", async () => {
    const semaphore = new AsyncSemaphore(2);
    const signal = new AbortController().signal;
    const gates = [deferred(), deferred(), deferred()];
    let active = 0;
    let peak = 0;
    const runs = gates.map((gate) =>
      semaphore.use(signal, async () => {
        active++;
        peak = Math.max(peak, active);
        await gate.promise;
        active--;
      }),
    );

    await flush();
    expect(active).toBe(2);
    gates[0]?.resolve();
    await flush();
    expect(active).toBe(2);
    gates[1]?.resolve();
    gates[2]?.resolve();
    await Promise.all(runs);
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  test("serves queued operations in FIFO order", async () => {
    const semaphore = new AsyncSemaphore(1);
    const signal = new AbortController().signal;
    const first = deferred();
    const order: string[] = [];
    const runs = [
      semaphore.use(signal, async () => {
        await first.promise;
        order.push("a");
      }),
      semaphore.use(signal, async () => {
        order.push("b");
      }),
      semaphore.use(signal, async () => {
        order.push("c");
      }),
    ];

    await flush();
    first.resolve();
    await Promise.all(runs);
    expect(order).toEqual(["a", "b", "c"]);
  });

  test("returns the operation's result", async () => {
    const semaphore = new AsyncSemaphore(1);
    const result = await semaphore.use(
      new AbortController().signal,
      async () => 42,
    );
    expect(result).toBe(42);
  });

  test("releases the permit when the operation throws", async () => {
    const semaphore = new AsyncSemaphore(1);
    const signal = new AbortController().signal;
    await expect(
      semaphore.use(signal, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await semaphore.use(signal, async () => "next")).toBe("next");
  });

  test("rejects at once with the reason of an already aborted signal", async () => {
    const semaphore = new AsyncSemaphore(1);
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    let ran = false;
    await expect(
      semaphore.use(controller.signal, async () => {
        ran = true;
      }),
    ).rejects.toBe(reason);
    expect(ran).toBe(false);
  });

  test("an aborted queued acquisition rejects, never runs, and frees its slot in the queue", async () => {
    const semaphore = new AsyncSemaphore(1);
    const open = new AbortController().signal;
    const holder = deferred();
    const holding = semaphore.use(open, () => holder.promise);

    const controller = new AbortController();
    let abortedRan = false;
    const aborted = semaphore.use(controller.signal, async () => {
      abortedRan = true;
    });
    const later = semaphore.use(open, async () => "later");

    const reason = new Error("stop");
    controller.abort(reason);
    await expect(aborted).rejects.toBe(reason);

    holder.resolve();
    await holding;
    expect(await later).toBe("later");
    expect(abortedRan).toBe(false);
  });

  test("an aborted queued acquisition without a reason rejects with the default error", async () => {
    const semaphore = new AsyncSemaphore(1);
    const open = new AbortController().signal;
    const holder = deferred();
    const holding = semaphore.use(open, () => holder.promise);

    // A signal whose reason is undefined (AbortController always sets one).
    const target = new EventTarget() as AbortSignal & { aborted: boolean };
    Object.defineProperty(target, "aborted", { value: false, writable: true });
    Object.defineProperty(target, "reason", { value: undefined });
    const queued = semaphore.use(target, async () => "never");
    target.aborted = true;
    target.dispatchEvent(new Event("abort"));

    await expect(queued).rejects.toThrow("Semaphore acquisition aborted");
    holder.resolve();
    await holding;
  });
});
