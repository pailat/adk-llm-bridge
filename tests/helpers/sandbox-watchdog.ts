/**
 * A watchdog for tests that can block the host thread synchronously, such as
 * a sandbox turn stuck inside WebAssembly. A test runner's own timeout cannot
 * fire while the thread is blocked, so the check runs on a worker thread: it
 * names the test on stderr and kills the process, so the run fails at once
 * instead of at the CI job timeout. Works under Bun and Node; this file uses
 * only erasable TypeScript, so Node can run it by type stripping.
 *
 * Scope: only code between {@link watchSyncBlock} and the function it returns
 * is watched (hooks and module top level are not), and one watched test runs
 * at a time per process: starting a second watch while one is active and
 * still inside its deadline throws. A watch past its deadline belongs to a
 * test the runner already timed out (its body may still be finishing), so a
 * new watch takes it over, and the stale test's late stop is ignored.
 */

import { Worker } from "node:worker_threads";

/** Bytes kept for the test name; a longer name is cut. */
const NAME_BYTES = 4096;
/**
 * 64-bit slots. `SEQUENCE` is odd while the writer updates the others, so the
 * worker reads name, start and limit as one consistent set. `START` is a
 * `process.hrtime` reading in nanoseconds: monotonic and shared by every
 * thread of the process (unlike `performance.now()`), 0 when idle. `LIMIT`
 * and `DEADLINE` are nanoseconds after `START`; `OWNER` names the watch that
 * may stop it.
 */
const SEQUENCE = 0;
const START = 1;
const LIMIT = 2;
const NAME_LENGTH = 3;
const DEADLINE = 4;
const OWNER = 5;
const SLOTS = 6;

let watches = 0n;

let shared: { slots: BigInt64Array; name: Uint8Array } | undefined;

function watchdog(): { slots: BigInt64Array; name: Uint8Array } {
  if (shared) return shared;
  const buffer = new SharedArrayBuffer(SLOTS * 8 + NAME_BYTES);
  shared = {
    slots: new BigInt64Array(buffer, 0, SLOTS),
    name: new Uint8Array(buffer, SLOTS * 8, NAME_BYTES),
  };
  // A file next to this one: never evaluated source.
  const worker = new Worker(
    new URL("./sandbox-watchdog-worker.mjs", import.meta.url),
    { workerData: { buffer, slots: SLOTS, nameBytes: NAME_BYTES } },
  );
  worker.unref();
  return shared;
}

function write(slots: BigInt64Array, update: () => void): void {
  Atomics.add(slots, SEQUENCE, 1n);
  update();
  Atomics.add(slots, SEQUENCE, 1n);
}

/**
 * Starts watching one test. If the test is still running when the kill time
 * has passed, the worker prints
 * `SANDBOX WATCHDOG: <name> blocked the host for <n> ms` and sends SIGKILL to
 * the process.
 *
 * @param name - The test's name, as it should appear in the message.
 * @param deadlineMs - The test's own deadline; the runner enforces it for
 *   asynchronous overruns.
 * @param graceMs - Time after the deadline before the kill. By default the
 *   kill comes at `max(2 * deadlineMs, deadlineMs + 10_000)`: the aim is to
 *   beat the CI job timeout on a loaded runner, not precision.
 * @returns A function that stops watching; call it when the test ends.
 * @throws Error when another watch is active and inside its deadline (tests
 *   run concurrently).
 */
export function watchSyncBlock(
  name: string,
  deadlineMs: number,
  graceMs = Math.max(deadlineMs, 10_000),
): () => void {
  const { slots, name: nameBytes } = watchdog();
  const active = Atomics.load(slots, START);
  if (
    active !== 0n &&
    process.hrtime.bigint() - active <= Atomics.load(slots, DEADLINE)
  ) {
    throw new Error(
      "watchSyncBlock: another watched test is running; the watchdog supports one test at a time per process",
    );
  }
  const encoded = new TextEncoder().encode(name).slice(0, NAME_BYTES);
  watches += 1n;
  const owner = watches;
  write(slots, () => {
    nameBytes.fill(0);
    nameBytes.set(encoded);
    Atomics.store(slots, NAME_LENGTH, BigInt(encoded.length));
    Atomics.store(
      slots,
      LIMIT,
      BigInt(Math.ceil((deadlineMs + graceMs) * 1e6)),
    );
    Atomics.store(slots, DEADLINE, BigInt(Math.ceil(deadlineMs * 1e6)));
    Atomics.store(slots, OWNER, owner);
    Atomics.store(slots, START, process.hrtime.bigint());
  });
  return () => {
    // A later watch took this one over: leave it running.
    if (Atomics.load(slots, OWNER) !== owner) return;
    write(slots, () => {
      Atomics.store(slots, START, 0n);
    });
  };
}
