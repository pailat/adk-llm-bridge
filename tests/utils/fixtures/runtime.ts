/**
 * Differences between Bun and Node a test that starts a child process has to
 * handle: the flag that loads a module first, and the command that runs one
 * test file in its own process.
 */

import { join } from "node:path";

/** Whether the tests run under Bun (otherwise under `scripts/node-test.mjs`). */
export const isBun =
  typeof (globalThis as { Bun?: { version?: string } }).Bun?.version ===
  "string";

/** Flags that keep a child's stderr free of the runtime's own deprecation notices. */
export const quietFlags: string[] = isBun ? [] : ["--no-deprecation"];

/** The flag that makes the runtime load a module before the script. */
export const preloadFlag = isBun ? "--preload" : "--import";

/**
 * The command that runs one test file alone and reports `N pass` and `N fail`
 * counts in its output.
 */
export function singleTestCommand(file: string): string[] {
  return isBun
    ? [process.execPath, "test", file]
    : [
        process.execPath,
        join(import.meta.dirname, "../../../scripts/node-test.mjs"),
        file,
      ];
}

/** Matches the pass count `count` in the output of {@link singleTestCommand}. */
export function passCount(output: string): number {
  const match = /(\d+) pass\b|ℹ pass (\d+)/u.exec(output);
  return Number(match?.[1] ?? match?.[2] ?? Number.NaN);
}
