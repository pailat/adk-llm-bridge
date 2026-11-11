import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { watchSyncBlock } from "./sandbox-watchdog.js";

const FIXTURE = fileURLToPath(
  new URL("./watchdog-fixtures/spin.mjs", import.meta.url),
);
const HELPER = fileURLToPath(new URL("./sandbox-watchdog.ts", import.meta.url));

/** Whether `node` on PATH can run a `.ts` file (type stripping). */
const nodeRunsTypeScript = (() => {
  const probe = spawnSync("node", [
    "-e",
    "process.exit(process.features.typescript ? 0 : 1)",
  ]);
  return probe.status === 0;
})();

describe("sandbox watchdog", () => {
  const runners: [string, string, boolean][] = [
    ["Bun", process.execPath, true],
    ["Node", "node", nodeRunsTypeScript],
  ];
  for (const [label, command, available] of runners) {
    test.skipIf(!available)(
      `${label}: a test that blocks the host in wasm is named and killed`,
      () => {
        const started = Date.now();
        const run = spawnSync(command, [FIXTURE], {
          encoding: "utf8",
          timeout: 10_000,
          killSignal: "SIGKILL",
        });
        const elapsed = Date.now() - started;

        // Killed by the watchdog (300 ms + 200 ms grace), not by this test's
        // 10 s cap: spawnSync reports its own timeout as an error.
        expect(run.error).toBeUndefined();
        expect(run.signal).toBe("SIGKILL");
        expect(run.stderr).toContain(
          "SANDBOX WATCHDOG: fixture > a turn stuck in wasm blocked the host for",
        );
        expect(elapsed).toBeLessThan(8_000);
      },
      15_000,
    );
  }

  test("the worker is a file next to the helper, never evaluated source", () => {
    const source = readFileSync(HELPER, "utf8");

    expect(source).toContain(
      'new URL("./sandbox-watchdog-worker.mjs", import.meta.url)',
    );
    expect(source).not.toMatch(/eval\s*:\s*true|data:|blob:/);
  });

  test("an idle watchdog never fires", async () => {
    // A limit of 2 ms, stopped at once: with nothing watched, a long idle
    // time must not count as a blocked test.
    watchSyncBlock("idle", 1, 1)();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(true).toBe(true);
  });

  test("a second watch while one is active is refused", () => {
    const stop = watchSyncBlock("outer", 60_000);
    try {
      expect(() => watchSyncBlock("inner", 60_000)).toThrow(
        "one test at a time",
      );
    } finally {
      stop();
    }
    // Free again once the first one stopped.
    watchSyncBlock("after", 60_000)();
  });

  test("a watch past its deadline is taken over, and its late stop is ignored", async () => {
    // The runner timed this test out (deadline 1 ms), but its body is still
    // finishing when the next test starts.
    const staleStop = watchSyncBlock("stale", 1, 60_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stop = watchSyncBlock("next", 60_000);
    try {
      staleStop();
      // "next" is still watched: a concurrent watch is still refused.
      expect(() => watchSyncBlock("third", 60_000)).toThrow(
        "one test at a time",
      );
    } finally {
      stop();
    }
    watchSyncBlock("after", 60_000)();
  });
});
