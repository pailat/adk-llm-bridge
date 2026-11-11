import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A real Node binary, when one is on PATH. Node lets a process exit while a
 * top-level await still waits on unreferenced timers only; that is how a
 * short-lived host script loses its buffered events.
 */
const NODE = (() => {
  const found = spawnSync(
    "node",
    ["-e", "process.stdout.write(process.execPath)"],
    { encoding: "utf8" },
  );
  return found.status === 0 && found.stdout ? found.stdout : undefined;
})();

const FIXTURE = join(import.meta.dir, "fixtures", "run-only-child.ts");
const directories: string[] = [];
let bundle = "";

beforeAll(async () => {
  const out = await mkdtemp(join(tmpdir(), "event-export-shutdown-bundle-"));
  directories.push(out);
  // Node cannot run the TypeScript sources directly, so the child is bundled.
  const built = await Bun.build({
    entrypoints: [FIXTURE],
    outdir: out,
    target: "node",
    naming: "child.mjs",
  });
  if (!built.success) throw new AggregateError(built.logs, "bundle failed");
  bundle = join(out, "child.mjs");
}, 60_000);

afterAll(async () => {
  for (const dir of directories.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

type Outcome = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

/** Runs the child to its end; kills it if it outlives the deadline. */
function runChild(bin: string, file: string, mode: string, dir: string) {
  return new Promise<Outcome>((resolve, reject) => {
    const child = spawn(bin, [file, mode, dir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(deadline);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function afterRun(outcome: Outcome) {
  const line = outcome.stdout
    .split("\n")
    .find((entry) => entry.startsWith("after-run "));
  if (!line) {
    throw new Error(
      `the child never reached the code after the run loop (code ${outcome.code}, signal ${outcome.signal}): ${outcome.stderr.slice(-600)}`,
    );
  }
  return JSON.parse(line.slice("after-run ".length)) as {
    offered: number;
    exported: number;
    dropped: number;
    buffered: number;
    stored: number;
  };
}

const HOSTS = [
  ...(NODE ? [{ label: "Node", bin: NODE, node: true }] : []),
  { label: "Bun", bin: process.execPath, node: false },
];

describe("event export at shutdown of a process whose only work is the run", () => {
  for (const host of HOSTS) {
    for (const [mode, wait] of [
      ["plugin", "the plugin's end-of-run flush"],
      ["flush", "an awaited pipeline.flush()"],
      ["close", "an awaited pipeline.close() over a slow exporter"],
    ] as const) {
      test(`${host.label}: ${wait} keeps the process alive until every event is exported`, async () => {
        const dir = await mkdtemp(join(tmpdir(), "event-export-shutdown-"));
        directories.push(dir);
        const started = Date.now();
        const outcome = await runChild(
          host.bin,
          host.node ? bundle : FIXTURE,
          mode,
          dir,
        );
        const stats = afterRun(outcome);
        // The child waits up to 20 s; a wait released when the export ends
        // lets it exit long before that.
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(outcome.code).toBe(0);
        expect(stats.offered).toBeGreaterThan(0);
        expect(stats.exported).toBe(stats.offered);
        expect(stats.stored).toBe(stats.offered);
        expect(stats.dropped).toBe(0);
        expect(stats.buffered).toBe(0);
      }, 40_000);
    }
  }
});
