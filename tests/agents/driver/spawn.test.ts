import { describe, expect, test } from "bun:test";
import {
  spawn as nodeSpawn,
  type SpawnOptions,
  spawnSync,
} from "node:child_process";
import { delimiter, resolve } from "node:path";
import {
  collectTail,
  readAll as readAllText,
  readLines,
  STDERR_LINE_CHARS,
} from "../../../src/agents/driver/lines.js";
import {
  describeMissingExecutable,
  executableCandidates,
  findExecutable,
} from "../../../src/agents/driver/shared.js";
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
          // Its own process group, so a kill reaches its children too.
          ...(process.platform === "win32" ? {} : { detached: true }),
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
      ...(process.platform === "win32" ? {} : { detached: true }),
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

describe("driver line reading", () => {
  async function lines(source: Parameters<typeof readLines>[0]) {
    const out: string[] = [];
    for await (const line of readLines(source)) out.push(line);
    return out;
  }

  test("reads sync iterables, async iterables and streams the same way", async () => {
    const chunks = ["a\r\nb", "\nc"];
    expect(await lines(chunks)).toEqual(["a", "b", "c"]);
    expect(
      await lines(
        (async function* () {
          yield* chunks;
        })(),
      ),
    ).toEqual(["a", "b", "c"]);
    const stream = new ReadableStream<string>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    expect(await lines(stream)).toEqual(["a", "b", "c"]);
    expect(stream.locked).toBe(false);
  });

  test("releases a stream reader when reading stops early", async () => {
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("one\ntwo\n");
      },
    });
    for await (const _line of readLines(stream)) break;
    expect(stream.locked).toBe(false);
  });

  test("collectTail keeps the last lines and cuts long ones", async () => {
    const target: string[] = [];
    const input = ["", ...Array.from({ length: 10 }, (_, i) => `line ${i}`)];
    await collectTail(
      input.map((line) => `${line}\n`),
      target,
      3,
    );
    expect(target).toEqual(["line 7", "line 8", "line 9"]);

    const long: string[] = [];
    await collectTail(["x".repeat(STDERR_LINE_CHARS + 10)], long);
    expect(long[0]).toBe(`${"x".repeat(STDERR_LINE_CHARS)}...`);
  });

  test("readAll decodes bytes split inside a character", async () => {
    const bytes = new TextEncoder().encode("h\u00e9");
    expect(await readAllText([bytes.slice(0, 2), bytes.slice(2)])).toBe(
      "h\u00e9",
    );
  });
});

describe("driver executable lookup", () => {
  test("an explicit path wins without probing the candidates", () => {
    expect(findExecutable([undefined, "", "/opt/x"], ["/bin/sh"])).toEqual({
      path: "/opt/x",
      checked: ["/opt/x"],
    });
  });

  test("the first existing candidate is chosen and every probe recorded", () => {
    const result = findExecutable([], ["/does/not/exist", "/bin/sh", "/z"]);
    expect(result).toEqual({
      path: "/bin/sh",
      checked: ["/does/not/exist", "/bin/sh"],
    });
    expect(findExecutable([], ["/does/not/exist"])).toEqual({
      checked: ["/does/not/exist"],
    });
  });

  test("candidates follow PATH, extra dirs, then node_modules", () => {
    const candidates = executableCandidates({
      executable: "tool",
      env: { PATH: ["/a", "", "/b", "/a"].join(delimiter) },
      extraDirs: ["/extra", undefined],
      packagePaths: (base) => [`${base}/pkg/tool`],
    });
    expect(candidates.slice(0, 3)).toEqual([
      "/a/tool",
      "/b/tool",
      "/extra/tool",
    ]);
    expect(candidates[3]).toBe(
      resolve(process.cwd(), "node_modules", ".bin", "tool"),
    );
    expect(candidates[4]).toBe(resolve(process.cwd(), "pkg", "tool"));
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  test("the missing-executable message lists the checked paths", () => {
    expect(
      describeMissingExecutable({
        headline: "H",
        hint: "fix",
        original: "boom",
        checked: [],
      }),
    ).toBe("H\nfix\nOriginal error: boom\nChecked paths:\n  - <no candidates>");
  });
});

describe.skipIf(process.platform === "win32")(
  "spawnSubprocess stdin input",
  () => {
    for (const runtime of ["bun", "node"] as const) {
      test(`${runtime}: writes the input to stdin and closes it`, async () => {
        const child = spawnSubprocess(
          "/bin/cat",
          [],
          { env: { PATH: "/usr/bin:/bin" }, input: "update\n--version" },
          runtime === "node" ? { bun: null } : {},
        );
        const output = await withDeadline(readAll(child.stdout), 5_000);
        expect(output).toBe("update\n--version");
        expect(await child.exited).toBe(0);
      });

      test(`${runtime}: without input stdin is closed at once`, async () => {
        const child = spawnSubprocess(
          "/bin/cat",
          [],
          { env: { PATH: "/usr/bin:/bin" } },
          runtime === "node" ? { bun: null } : {},
        );
        expect(await withDeadline(readAll(child.stdout), 5_000)).toBe("");
        expect(await child.exited).toBe(0);
      });
    }
  },
);

const SPAWN_MODULE = resolve(
  import.meta.dir,
  "../../../src/agents/driver/spawn.ts",
);

describe.skipIf(process.platform === "win32")(
  "spawnSubprocess input to a child that exits without reading it",
  () => {
    // Run in a separate host process: without the EPIPE guard the write error
    // is uncaught and kills the host, which this test must observe.
    test("node: the host survives and the exit code is reported", () => {
      const script = [
        `import { spawnSubprocess } from ${JSON.stringify(SPAWN_MODULE)};`,
        "const child = spawnSubprocess(",
        '  "/bin/sh",',
        '  ["-c", "exit 3"],',
        '  { env: { PATH: "/usr/bin:/bin" }, input: "x".repeat(4 * 1024 * 1024) },',
        "  { bun: null },",
        ");",
        "const code = await child.exited;",
        // Give a late EPIPE time to surface before reporting success.
        "await new Promise((done) => setTimeout(done, 200));",
        'console.log("exited " + code);',
      ].join("\n");
      const host = spawnSync(process.execPath, ["-e", script], {
        encoding: "utf8",
        timeout: 20_000,
      });

      expect(`${host.stdout}${host.stderr}`).not.toContain("EPIPE");
      expect(host.stdout.trim()).toBe("exited 3");
      expect(host.status).toBe(0);
    });
  },
);
