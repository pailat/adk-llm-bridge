import { afterAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  processGroupHooksForTesting,
  spawnSubprocess,
} from "../../../src/agents/driver/spawn.js";
import { withDeadline } from "../helpers.js";

const POSIX = process.platform !== "win32";
const SPAWN_MODULE = resolve(
  import.meta.dir,
  "../../../src/agents/driver/spawn.ts",
);
const dir = mkdtempSync(join(tmpdir(), "adk-host-signals-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A real Node binary, when one is on PATH (the host then runs on Node). */
const NODE = (() => {
  const found = spawnSync(
    "node",
    ["-e", "process.stdout.write(process.execPath)"],
    {
      encoding: "utf8",
    },
  );
  return found.status === 0 && found.stdout ? found.stdout : undefined;
})();

/** Host program, and the spawn path it uses. */
type Host = { label: string; bin: string; spawnPath: "bun" | "node" };
const HOSTS: Host[] = [
  { label: "Bun host, Bun spawn", bin: process.execPath, spawnPath: "bun" },
  { label: "Bun host, Node spawn", bin: process.execPath, spawnPath: "node" },
  ...(NODE
    ? [{ label: "Node host", bin: NODE, spawnPath: "node" as const }]
    : []),
];

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 40 && isAlive(pid); i++) await sleep(25);
  return !isAlive(pid);
}

/**
 * A host that starts a CLI (which starts a grandchild) through
 * `spawnSubprocess`, prints `pids <cli> <grandchild>`, and idles.
 * `own` gives the host its own SIGINT listener.
 */
function writeHost(hostConfig: Host, own: boolean): string {
  const runtime = hostConfig.spawnPath;
  const cli = [
    'const { spawn } = require("node:child_process");',
    'const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    'setTimeout(() => console.log("ready " + g.pid), 200);',
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const native = hostConfig.bin !== process.execPath;
  const file = join(
    dir,
    `host-${native ? "native" : runtime}-${own ? "own" : "plain"}.${native ? "mts" : "ts"}`,
  );
  writeFileSync(
    file,
    [
      `import { spawnSubprocess } from ${JSON.stringify(SPAWN_MODULE)};`,
      own ? 'process.on("SIGINT", () => console.log("host handled"));' : "",
      `const child = spawnSubprocess(process.execPath, ["-e", ${JSON.stringify(cli)}], { env: { PATH: process.env.PATH ?? "" } }, ${runtime === "node" && !native ? "{ bun: null }" : "{}"});`,
      "const reader = child.stdout.getReader();",
      'let text = "";',
      "while (!/ready \\d+/.test(text)) {",
      "  const chunk = await reader.read();",
      "  if (chunk.done) break;",
      "  text += new TextDecoder().decode(chunk.value);",
      "}",
      'console.log("pids " + child.pid + " " + /ready (\\d+)/.exec(text)[1]);',
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  return file;
}

async function startHost(
  hostConfig: Host,
  file: string,
): Promise<{ host: ChildProcess; cli: number; grandchild: number }> {
  const host = spawn(hostConfig.bin, [file], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  let text = "";
  await withDeadline(
    new Promise<void>((done, fail) => {
      host.stdout?.on("data", (chunk) => {
        text += String(chunk);
        if (/pids \d+ \d+/.test(text)) done();
      });
      host.once("exit", () => fail(new Error(`host exited early: ${text}`)));
    }),
    10_000,
  );
  const [, cli, grandchild] = /pids (\d+) (\d+)/.exec(text) ?? [];
  return { host, cli: Number(cli), grandchild: Number(grandchild) };
}

function exited(host: ChildProcess): Promise<NodeJS.Signals | number | null> {
  return new Promise((done) => {
    if (host.exitCode !== null || host.signalCode !== null) {
      done(host.signalCode ?? host.exitCode);
      return;
    }
    host.once("exit", (code, signal) => done(signal ?? code));
  });
}

for (const hostConfig of HOSTS) {
  describe.if(POSIX)(
    `host signals reach the CLI group (${hostConfig.label})`,
    () => {
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        test(`${signal} ends the host, the CLI and its grandchild`, async () => {
          const { host, cli, grandchild } = await startHost(
            hostConfig,
            writeHost(hostConfig, false),
          );
          expect(isAlive(cli)).toBe(true);
          expect(isAlive(grandchild)).toBe(true);
          const done = exited(host);
          host.kill(signal);
          // The default action still ends the host, by that signal.
          expect(await withDeadline(done, 5000)).toBe(signal);
          expect(await waitDead(cli)).toBe(true);
          expect(await waitDead(grandchild)).toBe(true);
        });
      }

      test("a host with its own SIGINT listener is not ended by the bridge", async () => {
        const { host, cli, grandchild } = await startHost(
          hostConfig,
          writeHost(hostConfig, true),
        );
        try {
          host.kill("SIGINT");
          // The CLI group still gets the signal, as with a terminal Ctrl-C.
          expect(await waitDead(cli)).toBe(true);
          expect(await waitDead(grandchild)).toBe(true);
          await sleep(200);
          expect(host.exitCode).toBeNull();
          expect(host.signalCode).toBeNull();
        } finally {
          host.kill("SIGKILL");
          await exited(host);
        }
      });
    },
  );
}

for (const runtime of ["bun", "node"] as const) {
  describe.if(POSIX)(
    `host hooks are removed when idle (${runtime} spawn)`,
    () => {
      test("no listener is left after the last CLI exits", async () => {
        const before = {
          SIGINT: process.listenerCount("SIGINT"),
          SIGTERM: process.listenerCount("SIGTERM"),
          SIGHUP: process.listenerCount("SIGHUP"),
          exit: process.listenerCount("exit"),
        };
        const children = [100, 1500].map((ms) =>
          spawnSubprocess(
            process.execPath,
            ["-e", `setTimeout(() => {}, ${ms})`],
            { env: { PATH: process.env.PATH ?? "" } },
            runtime === "node" ? { bun: null } : {},
          ),
        );
        expect(processGroupHooksForTesting()).toEqual({
          liveGroups: 2,
          signalListeners: 3,
          exitHook: true,
        });
        expect(process.listenerCount("SIGINT")).toBe(before.SIGINT + 1);

        await withDeadline(children[0]?.exited ?? Promise.resolve(0), 5000);
        await sleep(0);
        // One CLI still runs: the hooks stay.
        expect(processGroupHooksForTesting().signalListeners).toBe(3);

        await withDeadline(children[1]?.exited ?? Promise.resolve(0), 5000);
        await sleep(0);
        expect(processGroupHooksForTesting()).toEqual({
          liveGroups: 0,
          signalListeners: 0,
          exitHook: false,
        });
        expect({
          SIGINT: process.listenerCount("SIGINT"),
          SIGTERM: process.listenerCount("SIGTERM"),
          SIGHUP: process.listenerCount("SIGHUP"),
          exit: process.listenerCount("exit"),
        }).toEqual(before);
      });
    },
  );
}
