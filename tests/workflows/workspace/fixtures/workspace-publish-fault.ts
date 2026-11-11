/**
 * Acquires one workspace lease with the state file's publishing rename blocked,
 * in its own process so the module mock cannot leak into other tests.
 *
 * Usage: `bun workspace-publish-fault.ts <blocked|blocked-forever> <stateDirectory>`.
 * `blocked` fails the first three publishing renames (temporary file to
 * `state.json`) with `EPERM`, as Windows does while a reader holds the state
 * file open; `blocked-forever` fails every one with `EBUSY`. Other renames,
 * such as the lock's, run for real. Prints one JSON line:
 * `{ acquired, code, thrown, tmpLeft, stateWritten }`.
 */

import { mock } from "bun:test";
import * as realFs from "node:fs";
import { join } from "node:path";

const [mode, stateDirectory] = process.argv.slice(2);
if (
  (mode !== "blocked" && mode !== "blocked-forever") ||
  typeof stateDirectory !== "string"
) {
  throw new Error("usage: <blocked|blocked-forever> <stateDirectory>");
}

let blocks = 0;
let thrown = 0;
const realRename = realFs.renameSync;
mock.module("node:fs", () => ({
  ...realFs,
  renameSync: (from: string, to: string) => {
    if (String(from).includes(".tmp-") && String(to).endsWith("state.json")) {
      blocks += 1;
      if (mode === "blocked-forever" || blocks <= 3) {
        thrown += 1;
        const code = mode === "blocked" ? "EPERM" : "EBUSY";
        throw Object.assign(new Error(`injected ${code}`), { code });
      }
    }
    realRename(from, to);
  },
}));

const { FileSystemWorkspaceAdapter } = await import(
  "../../../../src/workflows/workspace/file-system-workspace-adapter.js"
);
const adapter = new FileSystemWorkspaceAdapter({
  stateDirectory,
  leaseTtlMs: 60_000,
  heartbeatIntervalMs: 30_000,
  pollIntervalMs: 5,
  lockAcquireTimeoutMs: 10_000,
});
let acquired = false;
let code: unknown;
try {
  const lease = await adapter.acquire({
    workspaceId: "repo",
    ownerId: "agent-a",
    writePaths: ["src"],
  });
  acquired = true;
  await lease.release();
} catch (error) {
  code = (error as { code?: unknown }).code;
}
adapter.dispose();

const leftovers: string[] = [];
let stateWritten = false;
const walk = (directory: string) => {
  for (const entry of realFs.readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.includes(".tmp-")) leftovers.push(entry.name);
    else if (entry.name === "state.json") stateWritten = true;
  }
};
walk(stateDirectory);
// Exit from the write callback: a pipe write is asynchronous on Windows, and
// `process.exit` right after it can drop the line.
process.stdout.write(
  `${JSON.stringify({ acquired, code, thrown, tmpLeft: leftovers.length, stateWritten })}\n`,
  () => process.exit(0),
);
