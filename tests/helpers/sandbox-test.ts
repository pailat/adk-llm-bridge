/**
 * `test` for tests that run a script sandbox: an explicit deadline, and the
 * watchdog of `sandbox-watchdog.ts`, which also fires when the test blocks the
 * host thread synchronously (where the runner's own timeout cannot).
 *
 * Tests run one at a time per process; do not combine with `test.concurrent`.
 */

import { test } from "bun:test";
import { watchSyncBlock } from "./sandbox-watchdog.js";

/**
 * Default deadline of a sandbox test, in milliseconds. It is there to catch a
 * hang, not slowness: a loaded runner can take several times a test's idle
 * time. The watchdog kills at twice this.
 */
export const SANDBOX_TEST_DEADLINE_MS = 30_000;

async function watched(
  name: string,
  deadlineMs: number,
  run: () => unknown,
): Promise<void> {
  const stop = watchSyncBlock(name, deadlineMs);
  try {
    await run();
  } finally {
    stop();
  }
}

/**
 * Registers a sandbox test with a deadline and the watchdog.
 *
 * @param name - Test name.
 * @param run - Test body.
 * @param deadlineMs - Deadline for the runner and the watchdog.
 */
function sandboxTestFn(
  name: string,
  run: () => unknown,
  deadlineMs = SANDBOX_TEST_DEADLINE_MS,
): void {
  test(name, () => watched(name, deadlineMs, run), deadlineMs);
}

/**
 * `test.each` for sandbox tests. The watchdog names a row by the test name
 * and the row's first value.
 *
 * @param table - Rows; each row is spread into `run`.
 * @returns A function that registers one sandbox test per row.
 */
function each<Row extends readonly unknown[]>(table: readonly Row[]) {
  return (
    name: string,
    run: (...row: [...Row]) => unknown,
    deadlineMs = SANDBOX_TEST_DEADLINE_MS,
  ): void => {
    test.each(table as Row[])(
      name,
      // biome-ignore lint/suspicious/noExplicitAny: bun's each spreads the row.
      ((...row: any[]) =>
        watched(`${name} [${String(row[0])}]`, deadlineMs, () =>
          run(...(row as unknown as [...Row])),
        )) as never,
      deadlineMs,
    );
  };
}

/** {@link sandboxTestFn} with `.each`. */
export const sandboxTest = Object.assign(sandboxTestFn, { each });
