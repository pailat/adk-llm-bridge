/**
 * Differences between Bun and Node a test that starts a child process has to
 * handle: the flag that loads a module first, and the command that runs one
 * test file in its own process.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Whether the tests run under Bun (otherwise under `scripts/node-test.mjs`). */
export const isBun =
  typeof (globalThis as { Bun?: { version?: string } }).Bun?.version ===
  "string";

/** Flags that keep a child's stderr free of the runtime's own deprecation notices. */
export const quietFlags: string[] = isBun ? [] : ["--no-deprecation"];

/** The flag that makes the runtime load a module before the script. */
export const preloadFlag = isBun ? "--preload" : "--import";

/**
 * The text a child's module loader accepts for an absolute path. Node's loader
 * rejects a Windows path such as `D:\\a\\x.ts` (it reads `D:` as a URL
 * scheme), so the path becomes a `file://` URL. `windows` forces the Windows
 * rules on any platform, for a check that needs no Windows machine.
 */
export function moduleSpecifier(
  path: string,
  options: { windows?: boolean } = {},
): string {
  return toFileURL(path, options).href;
}

/**
 * `pathToFileURL` with its `windows` option (Node 20.13+, Bun), which the
 * project's `@types/node` does not declare yet.
 */
const toFileURL = pathToFileURL as (
  path: string,
  options?: { windows?: boolean },
) => URL;

/** The arguments that preload the module at `path` in a child process. */
export function preloadArgs(path: string): string[] {
  return [preloadFlag, isBun ? path : moduleSpecifier(path)];
}

/** How a child process ended, with everything it printed. */
export interface ChildCapture {
  exitCode: number | null;
  signal?: string | number | null;
  stdout: string;
  stderr: string;
}

/** An assertion message that shows exit code, signal, stdout and stderr of a child. */
export function describeChild(label: string, child: ChildCapture): string {
  return [
    `child "${label}": exit code ${child.exitCode}, signal ${child.signal ?? "none"}`,
    "--- stdout ---",
    child.stdout.trimEnd(),
    "--- stderr ---",
    child.stderr.trimEnd(),
  ].join("\n");
}

/**
 * Throws with {@link describeChild} unless the child ended with
 * `expectedExitCode`; returns the capture otherwise.
 */
export function expectChildExit(
  label: string,
  child: ChildCapture,
  expectedExitCode = 0,
): ChildCapture {
  if (child.exitCode !== expectedExitCode) {
    throw new Error(
      `${describeChild(label, child)}\nexpected exit code ${expectedExitCode}`,
    );
  }
  return child;
}

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
