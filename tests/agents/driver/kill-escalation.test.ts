import { describe, expect, test } from "bun:test";
import {
  GeminiCliDriver,
  type GeminiCliSpawn,
} from "../../../src/agents/driver/gemini-cli.js";
import {
  DEFAULT_KILL_GRACE_MS,
  type DriverSubprocess,
  spawnSubprocess,
  superviseSubprocess,
} from "../../../src/agents/driver/spawn.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import { GEMINI_CLI_PROVIDER } from "../../../src/agents/provider/gemini-cli.js";
import { GEMINI_NETWORK_ON, waitUntil, withDeadline } from "../helpers.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A process that records signals and ignores SIGTERM. */
function stubbornProcess() {
  const signals: Array<string | undefined> = [];
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  return {
    signals,
    exited,
    exit: (code: number) => resolveExit(code),
    kill(signal?: NodeJS.Signals) {
      signals.push(signal);
      if (signal === "SIGKILL") resolveExit(137);
    },
  };
}

describe("superviseSubprocess escalation", () => {
  test("sends SIGKILL when SIGTERM is ignored past the grace period", async () => {
    const child = stubbornProcess();
    const controller = new AbortController();
    superviseSubprocess(child, controller.signal, { killGraceMs: 10 });
    controller.abort();
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(await withDeadline(child.exited, 1000)).toBe(137);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("no SIGKILL when the process exits within the grace period", async () => {
    const child = stubbornProcess();
    const supervisor = superviseSubprocess(child, undefined, {
      killGraceMs: 30,
    });
    supervisor.release();
    child.exit(143);
    await sleep(60);
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  test("no signal at all once the process was seen to exit", async () => {
    const child = stubbornProcess();
    const supervisor = superviseSubprocess(child, undefined, {
      killGraceMs: 0,
    });
    supervisor.markExited();
    supervisor.release();
    await sleep(10);
    expect(child.signals).toEqual([]);
  });

  test("an invalid grace falls back to the default", () => {
    expect(DEFAULT_KILL_GRACE_MS).toBeGreaterThan(0);
    const child = stubbornProcess();
    const supervisor = superviseSubprocess(child, undefined, {
      killGraceMs: Number.NaN,
    });
    supervisor.release();
    child.exit(0);
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  test("a custom process without exited only gets SIGTERM", async () => {
    const signals: Array<string | undefined> = [];
    superviseSubprocess({ kill: (signal) => signals.push(signal) }, undefined, {
      killGraceMs: 0,
    }).release();
    await sleep(10);
    expect(signals).toEqual(["SIGTERM"]);
  });
});

const IGNORE_SIGTERM = [
  "-e",
  'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);',
];

async function waitForReady(child: DriverSubprocess): Promise<void> {
  const reader = child.stdout?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (reader && !text.includes("ready")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
  }
  reader?.releaseLock();
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

for (const [label, runtime] of [
  ["Bun", {}],
  ["Node", { bun: null }],
] as const) {
  describe(`a real process that ignores SIGTERM (${label} spawn)`, () => {
    test("is killed after the grace period and leaves no process behind", async () => {
      const child = spawnSubprocess(
        process.execPath,
        IGNORE_SIGTERM,
        { env: { PATH: process.env.PATH ?? "" } },
        runtime,
      );
      await withDeadline(waitForReady(child), 5000);
      const pid = child.pid;
      expect(typeof pid).toBe("number");

      const controller = new AbortController();
      superviseSubprocess(child, controller.signal, { killGraceMs: 100 });
      const startedAt = Date.now();
      controller.abort();

      // Exit code 137 means SIGKILL ended it: SIGTERM was ignored.
      const code = await withDeadline(child.exited, 5000);
      expect(code).toBe(137);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(90);
      // Reaped: no zombie keeps the pid.
      expect(await waitUntil(() => !isAlive(pid as number))).toBe(true);
    });
  });
}

/** A CLI that starts a grandchild ignoring SIGTERM and prints its pid. */
function treeScript(leaderIgnoresTerm: boolean): string[] {
  return [
    "-e",
    [
      'const { spawn } = require("node:child_process");',
      'const g = spawn(process.execPath, ["-e", "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });',
      leaderIgnoresTerm ? 'process.on("SIGTERM", () => {});' : "",
      'setTimeout(() => console.log("ready " + g.pid), 300);',
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  ];
}

async function readGrandchildPid(child: DriverSubprocess): Promise<number> {
  const reader = child.stdout?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (reader && !/ready \d+/.test(text)) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
  }
  reader?.releaseLock();
  return Number(/ready (\d+)/.exec(text)?.[1]);
}

for (const [label, runtime] of [
  ["Bun", {}],
  ["Node", { bun: null }],
] as const) {
  describe(`cancel reaches the CLI's children (${label} spawn)`, () => {
    for (const leaderIgnoresTerm of [true, false]) {
      test(
        leaderIgnoresTerm
          ? "a CLI and a grandchild that both ignore SIGTERM are both killed"
          : "a grandchild that ignores SIGTERM is killed after its CLI exits",
        async () => {
          const child = spawnSubprocess(
            process.execPath,
            treeScript(leaderIgnoresTerm),
            { env: { PATH: process.env.PATH ?? "" } },
            runtime,
          );
          const grandchild = await withDeadline(readGrandchildPid(child), 5000);
          expect(isAlive(grandchild)).toBe(true);

          const controller = new AbortController();
          superviseSubprocess(child, controller.signal, { killGraceMs: 100 });
          controller.abort();
          await withDeadline(child.exited, 5000);
          // The post-exit sweep is synchronous with the exit; give the OS a
          // moment to reap.
          expect(await waitUntil(() => !isAlive(grandchild))).toBe(true);
          expect(isAlive(child.pid as number)).toBe(false);
        },
      );
    }
  });
}

describe("CLI drivers escalate on cancel", () => {
  test("a cancelled Gemini CLI that ignores SIGTERM gets SIGKILL", async () => {
    const child = stubbornProcess();
    let push!: (line: string) => void;
    const stdout = new ReadableStream<string>({
      start(controller) {
        push = (line) => controller.enqueue(line);
        child.exited.then(() => controller.close());
      },
    });
    const spawn: GeminiCliSpawn = () => ({
      stdout,
      stderr: null,
      exited: child.exited,
      kill: (signal) => child.kill(signal),
    });
    const controller = new AbortController();
    const events: ExternalAgentEvent[] = [];
    const run = (async () => {
      for await (const event of new GeminiCliDriver({
        spawn,
        killGraceMs: 10,
      }).run({
        provider: GEMINI_CLI_PROVIDER,
        context: { input: "hi" } as never,
        permissions: GEMINI_NETWORK_ON,
        abortSignal: controller.signal,
      })) {
        events.push(event);
        if (event.type === "started") {
          push(
            `${JSON.stringify({ type: "message", role: "assistant", content: "x" })}\n`,
          );
        }
        if (event.type === "output") controller.abort();
      }
    })();
    await withDeadline(run, 2000);
    expect(await withDeadline(child.exited, 1000)).toBe(137);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("Gemini CLI skips a non-JSON stdout line", async () => {
    const spawn: GeminiCliSpawn = () => ({
      stdout: [
        `Sandbox starting\n${JSON.stringify({ type: "message", role: "assistant", content: "hello" })}\n`,
      ],
      stderr: null,
      exited: Promise.resolve(0),
    });
    const events: ExternalAgentEvent[] = [];
    for await (const event of new GeminiCliDriver({ spawn }).run({
      provider: GEMINI_CLI_PROVIDER,
      context: { input: "hi" } as never,
      permissions: GEMINI_NETWORK_ON,
    })) {
      events.push(event);
    }
    expect(events.find((event) => event.type === "output")).toMatchObject({
      content: "hello",
    });
    expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 0 });
  });
});
