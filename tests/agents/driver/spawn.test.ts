import { describe, expect, test } from "bun:test";
import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import {
  type BunSpawnLike,
  type NodeSpawnLike,
  spawnSubprocess,
  superviseSubprocess,
} from "../../../src/agents/driver/spawn.js";
import { withDeadline } from "../helpers.js";

async function readAll(
  stream: ReadableStream<Uint8Array> | null,
): Promise<string> {
  if (!stream) {
    return "";
  }
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

/** A source stream that never ends unless the test closes it. */
function openStream(initial?: string) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      if (initial) {
        value.enqueue(new TextEncoder().encode(initial));
      }
    },
  });
  return { stream, controller };
}

function fakeBun() {
  const calls: Array<{ command: string[]; options: unknown }> = [];
  const kills: Array<string | number | undefined> = [];
  const stdout = openStream("hello\n");
  const stderr = openStream();
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const bun: BunSpawnLike = {
    spawn(command, options) {
      calls.push({ command, options });
      return {
        stdout: stdout.stream,
        stderr: stderr.stream,
        exited,
        kill(signal) {
          kills.push(signal);
          resolveExit(143);
        },
      };
    },
  };
  return { bun, calls, kills, stdout, resolveExit };
}

describe("spawnSubprocess: Bun branch", () => {
  test("uses Bun.spawn with piped stdout/stderr and an ignored stdin", async () => {
    const fake = fakeBun();
    const child = spawnSubprocess(
      "claude",
      ["-p", "hi"],
      { cwd: "/work", env: { PATH: "/bin" } },
      { bun: fake.bun },
    );

    expect(fake.calls).toEqual([
      {
        command: ["claude", "-p", "hi"],
        options: {
          cwd: "/work",
          env: { PATH: "/bin" },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      },
    ]);

    fake.stdout.controller.enqueue(new TextEncoder().encode("world\n"));
    fake.stdout.controller.close();
    expect(await readAll(child.stdout)).toBe("hello\nworld\n");
    fake.resolveExit(0);
    expect(await child.exited).toBe(0);
  });

  test("kill() signals the process and ends stdout even if the pipe stays open", async () => {
    const fake = fakeBun();
    const child = spawnSubprocess("claude", [], {}, { bun: fake.bun });

    const reader = child.stdout?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toBe("hello\n");

    child.kill();
    child.kill();

    const next = await withDeadline(
      reader?.read() ?? Promise.resolve({ done: true }),
      2000,
      "stdout did not end after kill()",
    );
    expect(next.done).toBe(true);
    expect(fake.kills).toEqual(["SIGTERM", "SIGTERM"]);
    expect(await child.exited).toBe(143);
  });
});

describe("spawnSubprocess: Node branch", () => {
  test("adapts node:child_process to web streams and an exit code", async () => {
    const child = spawnSubprocess(
      "/bin/sh",
      ["-c", "echo out; echo err 1>&2; exit 3"],
      { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } },
      { bun: null },
    );

    const [stdout, stderr] = await Promise.all([
      readAll(child.stdout),
      readAll(child.stderr),
    ]);
    expect(stdout).toBe("out\n");
    expect(stderr).toBe("err\n");
    expect(await child.exited).toBe(3);
  });

  test("passes cwd, env and stdio ['ignore', 'pipe', 'pipe'] to spawn", async () => {
    const seen: SpawnOptions[] = [];
    const recordingSpawn: NodeSpawnLike = (command, args, options) => {
      seen.push(options);
      return nodeSpawn(command, [...args], options);
    };
    const child = spawnSubprocess(
      "/bin/sh",
      ["-c", 'pwd; printf "%s" "$ONLY"'],
      { cwd: "/", env: { ONLY: "value" } },
      { bun: null, nodeSpawn: recordingSpawn },
    );

    expect(await readAll(child.stdout)).toBe("/\nvalue");
    expect(await child.exited).toBe(0);
    expect(seen[0]).toMatchObject({
      cwd: "/",
      env: { ONLY: "value" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  test("kill() terminates the process and ends stdout although a grandchild holds the pipe", async () => {
    const child = spawnSubprocess(
      "/bin/sh",
      ["-c", "echo ready; sleep 5 & wait"],
      { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } },
      { bun: null },
    );

    const reader = child.stdout?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toBe("ready\n");

    child.kill();
    const next = await withDeadline(
      reader?.read() ?? Promise.resolve({ done: true }),
      2000,
      "stdout did not end after kill()",
    );
    expect(next.done).toBe(true);
    expect(await withDeadline(child.exited, 2000, "process did not exit")).toBe(
      143,
    );
    // A second kill after exit is a no-op.
    child.kill();
  });

  test("a missing command rejects exited instead of throwing synchronously", async () => {
    const child = spawnSubprocess(
      "/definitely/not/a/command",
      [],
      {},
      { bun: null },
    );
    await readAll(child.stdout);
    await expect(child.exited).rejects.toThrow(/ENOENT/);
  });
});

describe("superviseSubprocess", () => {
  test("kills on abort, once", () => {
    let kills = 0;
    const controller = new AbortController();
    const supervisor = superviseSubprocess(
      { kill: () => kills++ },
      controller.signal,
    );
    controller.abort();
    supervisor.markExited();
    supervisor.release();
    expect(kills).toBe(1);
  });

  test("kills right away when the signal is already aborted", () => {
    let kills = 0;
    superviseSubprocess({ kill: () => kills++ }, AbortSignal.abort());
    expect(kills).toBe(1);
  });

  test("release() kills a process that was not seen to exit", () => {
    let kills = 0;
    superviseSubprocess({ kill: () => kills++ }, undefined).release();
    expect(kills).toBe(1);
  });

  test("release() after markExited() does not kill and detaches the listener", () => {
    let kills = 0;
    const controller = new AbortController();
    const supervisor = superviseSubprocess(
      { kill: () => kills++ },
      controller.signal,
    );
    supervisor.markExited();
    supervisor.release();
    controller.abort();
    expect(kills).toBe(0);
  });

  test("a throwing kill() does not escape release()", () => {
    const supervisor = superviseSubprocess(
      {
        kill: () => {
          throw new Error("already gone");
        },
      },
      undefined,
    );
    expect(() => supervisor.release()).not.toThrow();
  });

  test("tolerates custom subprocesses without kill()", () => {
    const supervisor = superviseSubprocess({}, AbortSignal.abort());
    expect(() => supervisor.release()).not.toThrow();
  });
});
