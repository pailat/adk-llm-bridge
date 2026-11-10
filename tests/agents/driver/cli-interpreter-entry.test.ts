import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { InputValidationError } from "@google/adk";
import {
  AGENT_CWD_ENV,
  CHDIR_PRELOAD,
  isNativeExecutableHeader,
  readExecutableHeader,
  resolveCliLaunch,
} from "../../../src/agents/driver/launch.js";
import {
  type DriverSpawnOptions,
  type NodeSpawnLike,
  spawnSubprocess,
} from "../../../src/agents/driver/spawn.js";
import {
  ClaudeCliDriver,
  CodexCliDriver,
  EXTERNAL_AGENT_INTERPRETER_UNSAFE,
  type ExternalAgentEvent,
  ExternalAgentPolicyError,
  type ExternalAgentRunRequest,
  GEMINI_CLI_PROVIDER,
  GeminiCliDriver,
} from "../../../src/agents/index.js";

// The real Node binary (through a version-manager shim, if any): only Node
// is accepted as an interpreter, and under `bun test` process.execPath is Bun.
const NODE = execFileSync("node", ["-p", "process.execPath"], {
  encoding: "utf8",
}).trim();

// Every directory a test creates, canonical (macOS /var -> /private/var).
// Host-owned: next to this file, not in the temp directory, which a runtime
// sandbox keeps writable and the driver therefore refuses for an entry.
// `.native`: the resolver the driver's canonical paths use (on Windows the
// JavaScript one can differ in case or short names).
const scratch = realpathSync.native(
  mkdtempSync(join(import.meta.dir, ".host-scratch-")),
);
// A temp directory, for the tests that the driver refuses it.
const tempScratch = realpathSync.native(
  mkdtempSync(join(tmpdir(), "interp-tmp-")),
);
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(tempScratch, { recursive: true, force: true });
});
let counter = 0;
function dir(name: string): string {
  const path = join(scratch, `${name}-${counter++}`);
  mkdirSync(path, { recursive: true });
  return path;
}

/** The arguments before the driver's flags with an interpreter. */
const PREFIX = (entry: string) => ["--import", CHDIR_PRELOAD, entry];

/** A fake CLI entry script: records its argv and stdin, prints nothing, exits 0. */
function fakeEntry(where: string): { entry: string; record: string } {
  const entry = join(where, "fake-cli.cjs");
  const record = join(where, "record.json");
  writeFileSync(
    entry,
    [
      'const { writeFileSync, readFileSync } = require("node:fs");',
      "let input = '';",
      "try { input = readFileSync(0, 'utf8'); } catch {}",
      `writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), input, dotenv: process.env.FROM_DOTENV ?? null, cwd: process.cwd(), pwd: process.env.PWD ?? null, agentCwdVar: process.env.ADK_LLM_BRIDGE_AGENT_CWD ?? null }));`,
    ].join("\n"),
  );
  return { entry, record };
}

type Make = (config: Record<string, unknown>) => {
  run(request: ExternalAgentRunRequest): AsyncIterable<ExternalAgentEvent>;
};

const DRIVERS: Array<[string, Make]> = [
  ["gemini", (config) => new GeminiCliDriver(config as never)],
  ["claude", (config) => new ClaudeCliDriver(config as never)],
  ["codex", (config) => new CodexCliDriver(config as never)],
];

function request(
  workingDirectory: string,
  extra: Partial<ExternalAgentRunRequest> = {},
): ExternalAgentRunRequest {
  return {
    provider: GEMINI_CLI_PROVIDER,
    context: {} as ExternalAgentRunRequest["context"],
    instruction: "x & echo injected> injected.txt",
    workingDirectory,
    permissions: { mode: "ask", allowNetwork: true },
    ...extra,
  };
}

async function collect(
  events: AsyncIterable<ExternalAgentEvent>,
): Promise<ExternalAgentEvent[]> {
  const out: ExternalAgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function errorOf(events: ExternalAgentEvent[]) {
  return events.find((event) => event.type === "error") as
    | { code?: string; message: string }
    | undefined;
}

/** A custom spawn that records each start and exits 0 with no output. */
function recordingSpawn() {
  const calls: Array<[string, readonly string[]]> = [];
  const options: Array<{ cwd?: string; env?: Record<string, string> }> = [];
  const spawn = (
    command: string,
    args: readonly string[],
    spawnOptions: { cwd?: string; env?: Record<string, string> } = {},
  ) => {
    calls.push([command, [...args]]);
    options.push(spawnOptions);
    return {
      stdout: null,
      stderr: null,
      exited: Promise.resolve(0),
      kill() {},
    };
  };
  return { calls, options, spawn };
}

describe("interpreter + entry: constructor validation", () => {
  const entry = join(scratch, "outside", "cli.js");
  for (const [name, make] of DRIVERS) {
    test(`${name}: both or neither, non-empty, absolute entry, not with command`, () => {
      for (const config of [
        { interpreter: "node" },
        { entry },
        { interpreter: "", entry },
        { interpreter: "node", entry: "" },
        { interpreter: "  ", entry },
        { interpreter: "node", entry: "relative/cli.js" },
        { interpreter: "node", entry: "./cli.js" },
        { interpreter: "node", entry, command: "gemini" },
        { interpreter: 42, entry },
        { interpreter: "node", entry: ["x"] },
      ]) {
        expect(() => make(config)).toThrow(InputValidationError);
      }
      for (const interpreter of ["bin/node", "./node", "..\\node.exe"]) {
        expect(() => make({ interpreter, entry })).toThrow(/bare name/);
      }
      expect(() => make({ interpreter: "node" })).toThrow(/go together/);
      expect(() => make({ entry })).toThrow(/go together/);
      expect(() => make({ interpreter: "node", entry })).not.toThrow();
      expect(() =>
        make({ interpreter: process.execPath, entry }),
      ).not.toThrow();
    });
  }
});

describe("interpreter + entry: the launch shape", () => {
  for (const [name, make] of DRIVERS) {
    test(`${name}: runs <interpreter> <entry> <the same flags as without>`, async () => {
      const work = dir("work");
      const entry = join(dir("pkg"), "cli.js");
      const plain = recordingSpawn();
      await collect(make({ spawn: plain.spawn }).run(request(work)));
      const routed = recordingSpawn();
      await collect(
        make({ spawn: routed.spawn, interpreter: "node", entry }).run(
          request(work),
        ),
      );

      expect(plain.calls).toHaveLength(1);
      expect(routed.calls).toHaveLength(1);
      const [command, args] = routed.calls[0] ?? ["", []];
      expect(command).toBe("node");
      expect(args.slice(0, 3)).toEqual(PREFIX(entry));
      expect(args.slice(3)).toEqual([...(plain.calls[0]?.[1] ?? [])]);
      // A host-owned working directory, with the workspace for the preload.
      expect(routed.options[0]?.cwd).toBe(dirname(entry));
      expect(routed.options[0]?.env?.[AGENT_CWD_ENV]).toBe(work);
      expect(plain.options[0]?.cwd).toBe(work);
      expect(plain.options[0]?.env?.[AGENT_CWD_ENV]).toBeUndefined();
      // The preload URL is a constant: the workspace is never part of it.
      expect(CHDIR_PRELOAD).not.toContain(encodeURIComponent(work));
      expect(CHDIR_PRELOAD).not.toContain(work);
    });
  }
});

describe("interpreter + entry: the entry is never inside an agent-writable root", () => {
  for (const [name, make] of DRIVERS) {
    test(`${name}: an entry inside the working directory is refused before any spawn`, async () => {
      const work = dir("work");
      const { calls, spawn } = recordingSpawn();
      const events = await collect(
        make({
          spawn,
          interpreter: "node",
          entry: join(work, "node_modules", "cli.js"),
        }).run(request(work)),
      );

      expect(calls).toHaveLength(0);
      expect(errorOf(events)).toMatchObject({
        code: EXTERNAL_AGENT_INTERPRETER_UNSAFE,
        recoverable: false,
      });
      expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 1 });
    });

    test(`${name}: an entry inside allowedPaths is refused`, async () => {
      const work = dir("work");
      const shared = dir("shared");
      const { calls, spawn } = recordingSpawn();
      const events = await collect(
        make({
          spawn,
          interpreter: "node",
          entry: join(shared, "cli.js"),
          allowUnenforcedPaths: true,
        }).run(
          request(work, {
            permissions: {
              mode: "ask",
              allowNetwork: true,
              allowedPaths: [shared],
            },
          }),
        ),
      );

      expect(calls).toHaveLength(0);
      expect(errorOf(events)?.code).toBe(EXTERNAL_AGENT_INTERPRETER_UNSAFE);
    });

    test(`${name}: an entry reached through a symlink into the working directory is refused`, async () => {
      const work = dir("work");
      writeFileSync(join(work, "cli.js"), "");
      const outside = dir("outside");
      // A junction on Windows: a directory symlink there needs a privilege.
      symlinkSync(
        work,
        join(outside, "link"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const { calls, spawn } = recordingSpawn();
      const events = await collect(
        make({
          spawn,
          interpreter: "node",
          entry: join(outside, "link", "cli.js"),
        }).run(request(work)),
      );

      expect(calls).toHaveLength(0);
      expect(errorOf(events)?.code).toBe(EXTERNAL_AGENT_INTERPRETER_UNSAFE);
    });

    test.skipIf(process.platform === "win32")(
      `${name}: an entry behind a symlink loop is refused (cannot be resolved)`,
      async () => {
        const work = dir("work");
        const outside = dir("outside");
        symlinkSync(join(outside, "b"), join(outside, "a"));
        symlinkSync(join(outside, "a"), join(outside, "b"));
        const { calls, spawn } = recordingSpawn();
        const events = await collect(
          make({
            spawn,
            interpreter: "node",
            entry: join(outside, "a", "cli.js"),
          }).run(request(work)),
        );

        expect(calls).toHaveLength(0);
        expect(errorOf(events)?.code).toBe(EXTERNAL_AGENT_INTERPRETER_UNSAFE);
      },
    );

    test(`${name}: an interpreter path inside the working directory is refused`, async () => {
      const work = dir("work");
      const { calls, spawn } = recordingSpawn();
      const events = await collect(
        make({
          spawn,
          interpreter: join(work, "bin", "node"),
          entry: join(dir("pkg"), "cli.js"),
        }).run(request(work)),
      );

      expect(calls).toHaveLength(0);
      expect(errorOf(events)?.code).toBe(EXTERNAL_AGENT_INTERPRETER_UNSAFE);
    });
  }
});

describe("interpreter + entry with the built-in spawn", () => {
  for (const [name, make] of DRIVERS) {
    test(`${name}: a missing entry is MISSING_BINARY naming the entry`, async () => {
      const work = dir("work");
      const entry = join(dir("pkg"), "missing.js");
      const events = await collect(
        make({ interpreter: NODE, entry }).run(request(work)),
      );

      const error = errorOf(events);
      expect(error?.code).toBe("MISSING_BINARY");
      expect(error?.message).toContain(entry);
    });

    test(`${name}: a bare interpreter not on PATH is MISSING_BINARY naming it`, async () => {
      const work = dir("work");
      const { entry } = fakeEntry(dir("pkg"));
      const events = await collect(
        make({
          interpreter: "no-such-interpreter-4k",
          entry,
          env: { PATH: dir("empty-bin") },
        }).run(request(work)),
      );

      const error = errorOf(events);
      expect(error?.code).toBe("MISSING_BINARY");
      expect(error?.message).toContain("no-such-interpreter-4k");
    });

    test(`${name}: a real interpreter runs the entry; the prompt is never re-parsed`, async () => {
      const work = dir("work");
      const { entry, record } = fakeEntry(dir("pkg"));
      const events = await collect(
        make({ interpreter: NODE, entry }).run(request(work)),
      );

      expect(errorOf(events)).toBeUndefined();
      expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 0 });
      expect(existsSync(join(work, "injected.txt"))).toBe(false);
      const seen = JSON.parse(readFileSync(record, "utf8")) as {
        argv: string[];
        input: string;
      };
      // The prompt arrives intact: as an argument (Gemini, Codex) or on
      // stdin (Claude).
      const all = [...seen.argv, seen.input].join("\n");
      expect(all).toContain("x & echo injected> injected.txt");
      // The CLI starts in the workspace (the preload moved it there) and
      // does not see the variable that carried it.
      const where = seen as unknown as {
        cwd: string;
        pwd: string | null;
        agentCwdVar: string | null;
      };
      expect(realpathSync(where.cwd)).toBe(realpathSync(work));
      expect(where.pwd).toBe(where.cwd);
      expect(where.agentCwdVar).toBeNull();
    });
  }
});

describe("Codex lists its MCP servers through the same interpreter + entry", () => {
  test("the listing runs <interpreter> <entry> mcp list --json", async () => {
    const work = dir("work");
    const entry = join(dir("pkg"), "codex.js");
    const calls: Array<[string, readonly string[]]> = [];
    const where: Array<{ cwd?: string; env?: Record<string, string> }> = [];
    const spawn = (
      command: string,
      args: readonly string[],
      options: { cwd?: string; env?: Record<string, string> },
    ) => {
      calls.push([command, [...args]]);
      where.push(options);
      const listing = args.includes("mcp");
      return {
        stdout: listing
          ? (async function* () {
              yield "[]";
            })()
          : null,
        stderr: null,
        exited: Promise.resolve(0),
        kill() {},
      };
    };
    await collect(
      new CodexCliDriver({
        spawn: spawn as never,
        interpreter: "node",
        entry,
      }).run(request(work, { permissions: { mode: "ask" } })),
    );

    expect(calls[0]).toEqual([
      "node",
      [...PREFIX(entry), "mcp", "list", "--json"],
    ]);
    expect(calls[1]?.[0]).toBe("node");
    expect(calls[1]?.[1].slice(0, 3)).toEqual(PREFIX(entry));
    // Both start in the entry's directory; the preload moves to the workspace.
    for (const options of where) {
      expect(options.cwd).toBe(dirname(entry));
      expect(options.env?.[AGENT_CWD_ENV]).toBe(work);
    }
  });

  test("a custom lister receives the entry", async () => {
    const work = dir("work");
    const entry = join(dir("pkg"), "codex.js");
    const seen: unknown[] = [];
    const { spawn } = recordingSpawn();
    await collect(
      new CodexCliDriver({
        spawn,
        interpreter: "node",
        entry,
        listMcpServers: async (options) => {
          seen.push(options);
          return [];
        },
      }).run(request(work, { permissions: { mode: "ask" } })),
    );

    expect(seen[0]).toMatchObject({
      command: "node",
      prefixArgs: PREFIX(entry),
      cwd: dirname(entry),
      env: { [AGENT_CWD_ENV]: work },
    });
  });
});

describe("on Windows the interpreter follows the command rule", () => {
  // Only node.cmd on PATH: the spawn lookup refuses it, nothing starts.
  const files = new Set(["c:\\shims\\node.cmd"]);
  const env = { Path: "C:\\shims" };
  const nodeSpawn: NodeSpawnLike = () => {
    throw new Error("a batch interpreter must never be spawned");
  };
  const spawn = (
    command: string,
    args: readonly string[],
    options: DriverSpawnOptions,
  ) =>
    spawnSubprocess(
      command,
      args,
      { ...options, env },
      {
        bun: null,
        nodeSpawn,
        platform: "win32",
        fileExists: (path) => files.has(path.toLowerCase()),
      },
    );

  for (const [name, make] of DRIVERS) {
    test(`${name}: a node.cmd interpreter is EXTERNAL_AGENT_BATCH_COMMAND_REFUSED`, async () => {
      const work = dir("work");
      const events = await collect(
        make({
          spawn,
          interpreter: "node",
          entry: join(dir("pkg"), "cli.js"),
        }).run(request(work)),
      );

      expect(errorOf(events)?.code).toBe(
        "EXTERNAL_AGENT_BATCH_COMMAND_REFUSED",
      );
    });
  }

  test("the Gemini batch remedy names interpreter and entry", async () => {
    const work = dir("work");
    const events = await collect(
      new GeminiCliDriver({ spawn: spawn as never }).run(request(work)),
    );
    files.add("c:\\shims\\gemini.cmd");
    const again = await collect(
      new GeminiCliDriver({ spawn: spawn as never }).run(request(work)),
    );

    expect(errorOf(events)?.code).toBe("MISSING_BINARY");
    const message = errorOf(again)?.message ?? "";
    expect(message).toContain("interpreter");
    expect(message).toContain("entry");
  });
});

describe("resolveCliLaunch", () => {
  const missing = () =>
    new ExternalAgentPolicyError("MISSING_BINARY", "the CLI is missing");
  const windowsFiles = new Set([
    "C:\\shims\\node.cmd",
    "C:\\tools\\node.exe",
    "C:\\shims\\gemini.cmd",
  ]);
  const host = {
    platform: "win32" as const,
    // Windows file names compare without case (PATHEXT is upper case).
    isExecutableFile: (path: string) =>
      [...windowsFiles].some(
        (file) => file.toLowerCase() === path.toLowerCase(),
      ),
    isSearchable: () => true,
    isFile: () => true,
    // The checked real file, as a path this (POSIX or Windows) host reads as
    // absolute: only C:\tools\node.exe resolves, so node.cmd was skipped.
    realpath: (path: string) =>
      path.toLowerCase() === "c:\\tools\\node.exe"
        ? "/opt/tools/node.exe"
        : undefined,
    readHeader: () => new Uint8Array([0x4d, 0x5a, 0x90, 0x00]),
  };
  const env = { PATH: "C:\\shims;C:\\tools", PATHEXT: ".COM;.EXE;.BAT;.CMD" };

  test("a bare interpreter skips node.cmd for the native node.exe; the entry comes first", () => {
    const work = dir("work");
    const entry = join(dir("pkg"), "cli.js");

    expect(
      resolveCliLaunch({
        command: "node",
        entry,
        env,
        request: { workingDirectory: work },
        builtInSpawn: true,
        missing,
        host,
      }),
    ).toMatchObject({
      launch: {
        command: "/opt/tools/node.exe",
        prefix: PREFIX(entry),
      },
    });
  });

  test("without an entry it is the command rule, with no prefix", () => {
    const work = dir("work");
    const base = {
      env,
      request: { workingDirectory: work },
      missing,
      host,
    };

    // Only gemini.cmd: handed on, so the spawn refuses it with the remedy.
    expect(
      resolveCliLaunch({ ...base, command: "gemini", builtInSpawn: true }),
    ).toEqual({
      launch: {
        command: expect.stringMatching(/^C:\\shims\\gemini\.cmd$/i),
        prefix: [],
      },
    });
    expect(
      resolveCliLaunch({ ...base, command: "codex", builtInSpawn: true }),
    ).toEqual({
      refusal: expect.objectContaining({ message: "the CLI is missing" }),
    });
    expect(
      resolveCliLaunch({ ...base, command: "codex", builtInSpawn: false }),
    ).toEqual({ launch: { command: "codex", prefix: [] } });
  });

  test("a custom spawn gets the interpreter as given and skips the file probe", () => {
    const work = dir("work");
    const entry = join(dir("pkg"), "cli.js");

    expect(
      resolveCliLaunch({
        command: "node",
        entry,
        env: {},
        request: { workingDirectory: work },
        builtInSpawn: false,
        missing,
        host: { ...host, isFile: () => false },
      }),
    ).toMatchObject({ launch: { command: "node", prefix: PREFIX(entry) } });
  });

  test("the entry at the root itself, or a sibling with the root as a prefix", () => {
    const work = dir("work");
    const base = {
      command: "node",
      env,
      request: { workingDirectory: work },
      builtInSpawn: false,
      missing,
    };

    expect("refusal" in resolveCliLaunch({ ...base, entry: work })).toBe(true);
    // `/x/work-1-sibling` is not inside `/x/work-1`.
    expect(
      "launch" in
        resolveCliLaunch({ ...base, entry: `${work}-sibling/cli.js` }),
    ).toBe(true);
  });

  test("an absolute interpreter outside every root is used as given", () => {
    const work = dir("work");
    const entry = join(dir("pkg"), "cli.js");

    expect(
      resolveCliLaunch({
        command: NODE,
        entry,
        env: {},
        request: { workingDirectory: work },
        builtInSpawn: true,
        missing,
        host: { isFile: () => true },
      }),
    ).toMatchObject({ launch: { command: NODE, prefix: PREFIX(entry) } });
  });
});

describe("only Node runs an entry", () => {
  /** A workspace with the files Bun would load from its working directory. */
  function plantedWorkspace(): { work: string; marker: string } {
    const work = dir("work");
    const marker = join(dir("marks"), "preload-ran");
    writeFileSync(
      join(work, "evil.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "agent code ran");`,
    );
    writeFileSync(join(work, "bunfig.toml"), 'preload = ["./evil.js"]\n');
    writeFileSync(join(work, ".env"), "FROM_DOTENV=agent-controlled\n");
    writeFileSync(
      join(work, "node.config.json"),
      JSON.stringify({ nodeOptions: { require: ["./evil.js"] } }),
    );
    writeFileSync(join(work, ".npmrc"), "node-options=--require ./evil.js\n");
    return { work, marker };
  }

  for (const [name, make] of DRIVERS) {
    test(`${name}: Bun as the interpreter is refused before anything runs, and the planted preload never runs`, async () => {
      const { work, marker } = plantedWorkspace();
      const { entry, record } = fakeEntry(dir("pkg"));
      const events = await collect(
        make({
          interpreter: process.versions.bun ? process.execPath : "bun",
          entry,
        }).run(request(work)),
      );

      const error = errorOf(events);
      expect(error?.code).toBe(EXTERNAL_AGENT_INTERPRETER_UNSAFE);
      expect(error?.message).toContain("not Node");
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(record)).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 1 });
    });

    test(`${name}: with a custom spawn, a non-Node interpreter name is refused with no spawn`, async () => {
      const work = dir("work");
      const entry = join(dir("pkg"), "cli.js");
      for (const interpreter of ["bun", "deno", "mise", "nodejs", "node.exe"]) {
        const { calls, spawn } = recordingSpawn();
        const events = await collect(
          make({ spawn, interpreter, entry }).run(request(work)),
        );
        if (interpreter === "node.exe" && process.platform === "win32") {
          expect(calls).toHaveLength(1);
          continue;
        }
        expect(calls).toHaveLength(0);
        expect(errorOf(events)?.code).toBe(EXTERNAL_AGENT_INTERPRETER_UNSAFE);
      }
    });

    test.skipIf(process.platform === "win32")(
      `${name}: a symlink named node to another binary is refused (real path checked)`,
      async () => {
        const work = dir("work");
        const bin = dir("bin");
        // A version-manager shim looks like this: bin/node -> mise.
        const other = join(dir("other"), "mise");
        writeFileSync(other, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        symlinkSync(other, join(bin, "node"));
        const { entry, record } = fakeEntry(dir("pkg"));
        for (const config of [
          { interpreter: join(bin, "node"), entry },
          { interpreter: "node", entry, env: { PATH: bin } },
        ]) {
          const events = await collect(make(config).run(request(work)));
          const error = errorOf(events);
          expect(error?.code).toBe(EXTERNAL_AGENT_INTERPRETER_UNSAFE);
          expect(error?.message).toContain(realpathSync(other));
        }
        // With a custom spawn the path is resolved here too.
        const { calls, spawn } = recordingSpawn();
        const events = await collect(
          make({ spawn, interpreter: join(bin, "node"), entry }).run(
            request(work),
          ),
        );
        expect(calls).toHaveLength(0);
        expect(errorOf(events)?.code).toBe(EXTERNAL_AGENT_INTERPRETER_UNSAFE);
        expect(errorOf(events)?.message).toContain(realpathSync(other));
        expect(existsSync(record)).toBe(false);
      },
    );

    test(`${name}: Node with the same planted workspace runs the entry, and nothing planted runs`, async () => {
      const { work, marker } = plantedWorkspace();
      const { entry, record } = fakeEntry(dir("pkg"));
      const events = await collect(
        make({ interpreter: NODE, entry }).run(request(work)),
      );

      expect(errorOf(events)).toBeUndefined();
      expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 0 });
      expect(existsSync(marker)).toBe(false);
      const seen = JSON.parse(readFileSync(record, "utf8")) as {
        dotenv: string | null;
      };
      expect(seen.dotenv).toBeNull();
    });
  }

  test("resolveCliLaunch: a missing interpreter file is MISSING_BINARY; node + .exe passes on win32", () => {
    const work = dir("work");
    const entry = join(dir("pkg"), "cli.js");
    const base = {
      entry,
      env: {},
      request: { workingDirectory: work },
      builtInSpawn: true,
      missing: () =>
        new ExternalAgentPolicyError("MISSING_BINARY", "the CLI is missing"),
    };
    const gone = resolveCliLaunch({
      ...base,
      command: join(dir("bin"), "node"),
      host: { isFile: () => true, isExecutableFile: () => true },
    });
    expect("refusal" in gone && gone.refusal.code).toBe("MISSING_BINARY");

    const windows = resolveCliLaunch({
      ...base,
      command: "/opt/nodejs/node",
      host: {
        platform: "win32",
        isFile: () => true,
        realpath: (path) =>
          path === "/opt/nodejs/node.exe" ? path : undefined,
        readHeader: () => new Uint8Array([0x4d, 0x5a, 0x90, 0x00]),
      },
    });
    expect(windows).toMatchObject({
      launch: { command: "/opt/nodejs/node.exe", prefix: PREFIX(entry) },
    });
  });

  test("resolveCliLaunch on win32: node.cmd is handed on to the batch refusal; node, NODE.EXE pass with a custom spawn", () => {
    const work = dir("work");
    const entry = join(dir("pkg"), "cli.js");
    const missing = () =>
      new ExternalAgentPolicyError("MISSING_BINARY", "the CLI is missing");
    const batchOnly = resolveCliLaunch({
      command: "node",
      entry,
      env: { PATH: "C:\\shims", PATHEXT: ".EXE;.CMD" },
      request: { workingDirectory: work },
      builtInSpawn: true,
      missing,
      host: {
        platform: "win32",
        isFile: () => true,
        isSearchable: () => true,
        isExecutableFile: (path) =>
          path.toLowerCase() === "c:\\shims\\node.cmd",
        realpath: () => undefined,
      },
    });
    expect(batchOnly).toMatchObject({
      launch: {
        command: expect.stringMatching(/^C:\\shims\\node\.cmd$/i),
        prefix: PREFIX(entry),
      },
    });
    for (const command of ["node", "NODE.EXE", "Node"]) {
      expect(
        resolveCliLaunch({
          command,
          entry,
          env: {},
          request: { workingDirectory: work },
          builtInSpawn: false,
          missing,
          host: { platform: "win32" },
        }),
      ).toMatchObject({ launch: { command, prefix: PREFIX(entry) } });
    }
    expect(
      "refusal" in
        resolveCliLaunch({
          command: "Node",
          entry,
          env: {},
          request: { workingDirectory: work },
          builtInSpawn: false,
          missing,
          host: { platform: "linux" },
        }),
    ).toBe(true);
  });
});

describe("the interpreter must be a native executable, not a script named node", () => {
  /**
   * A host-installed version-manager shim (asdf, nodenv style): a script
   * named node, outside every root, that runs the node the working
   * directory's `.tool-versions` names.
   */
  function scriptShim(): { bin: string; shim: string } {
    const bin = dir("shims");
    const shim = join(bin, process.platform === "win32" ? "node.exe" : "node");
    writeFileSync(
      shim,
      '#!/bin/sh\nexec "$(sed -n "s/^nodejs path://p" .tool-versions)/bin/node" "$@"\n',
      { mode: 0o755 },
    );
    return { bin, shim };
  }

  function plantedToolVersions(): { work: string; marker: string } {
    const work = dir("work");
    const marker = join(dir("marks"), "agent-node-ran");
    mkdirSync(join(work, "evilnode", "bin"), { recursive: true });
    writeFileSync(
      join(work, "evilnode", "bin", "node"),
      `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(work, ".tool-versions"),
      `nodejs path:${join(work, "evilnode")}\n`,
    );
    return { work, marker };
  }

  for (const [name, make] of DRIVERS) {
    test(`${name}: a script shim named node is refused before any spawn (explicit path, bare on PATH, custom spawn)`, async () => {
      const { bin, shim } = scriptShim();
      const { work, marker } = plantedToolVersions();
      const { entry, record } = fakeEntry(dir("pkg"));
      for (const config of [
        { interpreter: shim, entry },
        { interpreter: "node", entry, env: { PATH: bin } },
      ]) {
        const events = await collect(make(config).run(request(work)));
        const error = errorOf(events);
        expect(error?.code).toBe(EXTERNAL_AGENT_INTERPRETER_UNSAFE);
        expect(error?.message).toContain("not a native executable");
        expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 1 });
      }
      const { calls, spawn } = recordingSpawn();
      const events = await collect(
        make({ spawn, interpreter: shim, entry }).run(request(work)),
      );
      expect(calls).toHaveLength(0);
      expect(errorOf(events)?.code).toBe(EXTERNAL_AGENT_INTERPRETER_UNSAFE);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(record)).toBe(false);
    });

    test(`${name}: an empty or truncated file named node is refused`, async () => {
      const work = dir("work");
      const { entry } = fakeEntry(dir("pkg"));
      const file = process.platform === "win32" ? "node.exe" : "node";
      for (const content of [
        new Uint8Array([]),
        new Uint8Array([0x7f, 0x45, 0x4c]),
        new Uint8Array([0xcf, 0xfa, 0xed]),
        new Uint8Array([0x4d]),
      ]) {
        const interpreter = join(dir("bin"), file);
        writeFileSync(interpreter, content, { mode: 0o755 });
        const events = await collect(
          make({ interpreter, entry }).run(request(work)),
        );
        expect(errorOf(events)?.code).toBe(EXTERNAL_AGENT_INTERPRETER_UNSAFE);
      }
    });

    test(`${name}: the real Node is accepted and its real path is spawned`, async () => {
      const work = dir("work");
      const { entry } = fakeEntry(dir("pkg"));
      const { calls, spawn } = recordingSpawn();
      await collect(
        make({ spawn, interpreter: NODE, entry }).run(request(work)),
      );
      expect(calls).toHaveLength(1);
      const events = await collect(
        make({ interpreter: NODE, entry }).run(request(work)),
      );
      expect(errorOf(events)).toBeUndefined();
      expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 0 });
    });
  }

  test("a symlink to the real Node launches the real path it checked", () => {
    if (process.platform === "win32") return;
    const work = dir("work");
    const entry = join(dir("pkg"), "cli.js");
    writeFileSync(entry, "");
    const link = join(dir("bin"), "node");
    symlinkSync(NODE, link);
    expect(
      resolveCliLaunch({
        command: link,
        entry,
        env: {},
        request: { workingDirectory: work },
        builtInSpawn: true,
        missing: () =>
          new ExternalAgentPolicyError("MISSING_BINARY", "missing"),
      }),
    ).toMatchObject({
      launch: { command: realpathSync(NODE), prefix: PREFIX(entry) },
    });
  });

  test("isNativeExecutableHeader: per platform format, thin and fat Mach-O, both byte orders", () => {
    const bytes = (...values: number[]) => new Uint8Array(values);
    for (const magic of [
      [0xfe, 0xed, 0xfa, 0xce],
      [0xfe, 0xed, 0xfa, 0xcf],
      [0xce, 0xfa, 0xed, 0xfe],
      [0xcf, 0xfa, 0xed, 0xfe],
      [0xca, 0xfe, 0xba, 0xbe],
      [0xbe, 0xba, 0xfe, 0xca],
      [0xca, 0xfe, 0xba, 0xbf],
      [0xbf, 0xba, 0xfe, 0xca],
    ]) {
      expect(isNativeExecutableHeader(bytes(...magic), "darwin")).toBe(true);
      expect(isNativeExecutableHeader(bytes(...magic), "linux")).toBe(false);
    }
    const elf = bytes(0x7f, 0x45, 0x4c, 0x46);
    expect(isNativeExecutableHeader(elf, "linux")).toBe(true);
    expect(isNativeExecutableHeader(elf, "freebsd")).toBe(true);
    expect(isNativeExecutableHeader(elf, "darwin")).toBe(false);
    expect(isNativeExecutableHeader(elf, "win32")).toBe(false);
    const pe = bytes(0x4d, 0x5a, 0x90, 0x00);
    expect(isNativeExecutableHeader(pe, "win32")).toBe(true);
    expect(isNativeExecutableHeader(bytes(0x4d, 0x5a), "win32")).toBe(true);
    expect(isNativeExecutableHeader(pe, "linux")).toBe(false);
    expect(isNativeExecutableHeader(pe, "darwin")).toBe(false);
    const script = new TextEncoder().encode("#!/b");
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(isNativeExecutableHeader(script, platform)).toBe(false);
      expect(isNativeExecutableHeader(bytes(), platform)).toBe(false);
    }
    expect(isNativeExecutableHeader(bytes(0xca, 0xfe, 0xba), "darwin")).toBe(
      false,
    );
    expect(isNativeExecutableHeader(bytes(0x7f, 0x45, 0x4c), "linux")).toBe(
      false,
    );
    expect(isNativeExecutableHeader(bytes(0x4d), "win32")).toBe(false);
    expect(
      isNativeExecutableHeader(bytes(0x4d, 0x00, 0x90, 0x00), "win32"),
    ).toBe(false);
    expect(
      isNativeExecutableHeader(bytes(0x7f, 0x45, 0x4c, 0x00), "linux"),
    ).toBe(false);
    expect(
      isNativeExecutableHeader(bytes(0x00, 0x45, 0x4c, 0x46), "linux"),
    ).toBe(false);
    expect(isNativeExecutableHeader(bytes(0x5a, 0x4d), "win32")).toBe(false);
  });

  test("resolveCliLaunch accepts a fat (universal) Mach-O named node on macOS", () => {
    const work = dir("work");
    const entry = join(dir("pkg"), "cli.js");
    const outcome = (header: number[]) =>
      resolveCliLaunch({
        command: "/opt/node/bin/node",
        entry,
        env: {},
        request: { workingDirectory: work },
        builtInSpawn: true,
        missing: () => new ExternalAgentPolicyError("MISSING_BINARY", "x"),
        host: {
          platform: "darwin",
          isFile: () => true,
          realpath: (path) => path,
          readHeader: () => new Uint8Array(header),
        },
      });
    expect(outcome([0xca, 0xfe, 0xba, 0xbe])).toMatchObject({
      launch: { command: "/opt/node/bin/node", prefix: PREFIX(entry) },
    });
    expect("refusal" in outcome([0x23, 0x21, 0x2f, 0x62])).toBe(true);
    // A file whose header cannot be read (not a regular file, no permission).
    const unreadable = resolveCliLaunch({
      command: "/opt/node/bin/node",
      entry,
      env: {},
      request: { workingDirectory: work },
      builtInSpawn: true,
      missing: () => new ExternalAgentPolicyError("MISSING_BINARY", "x"),
      host: {
        platform: "darwin",
        isFile: () => true,
        realpath: (path) => path,
        readHeader: () => undefined,
      },
    });
    expect("refusal" in unreadable && unreadable.refusal.code).toBe(
      EXTERNAL_AGENT_INTERPRETER_UNSAFE,
    );
  });

  test("readExecutableHeader: the first 4 bytes of a regular file; a directory or a symlink is not read", () => {
    const where = dir("hdr");
    const file = join(where, "node");
    writeFileSync(file, new Uint8Array([1, 2, 3, 4, 5, 6]));
    expect([...(readExecutableHeader(file) ?? [])]).toEqual([1, 2, 3, 4]);
    writeFileSync(join(where, "short"), new Uint8Array([9]));
    expect([...(readExecutableHeader(join(where, "short")) ?? [])]).toEqual([
      9,
    ]);
    expect(readExecutableHeader(where)).toBeUndefined();
    expect(readExecutableHeader(join(where, "missing"))).toBeUndefined();
    if (process.platform !== "win32") {
      symlinkSync(file, join(where, "link"));
      expect(readExecutableHeader(join(where, "link"))).toBeUndefined();
      // A FIFO named node: not a regular file, and the open does not block.
      execFileSync("mkfifo", [join(where, "fifo")]);
      expect(readExecutableHeader(join(where, "fifo"))).toBeUndefined();
    }
  });
});

describe("the interpreter starts in a host-owned directory, then Node moves into the workspace", () => {
  // A native stand-in for a proto-style version-manager shim named node: it
  // looks for .tool-versions in its working directory and every ancestor,
  // runs the `nodejs path:` toolchain it names, else the real Node. It
  // records the directory it started in.
  const SHIM_SOURCE = `
#include <stdio.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  char dir[4096], file[4200], line[1024], bin[1100];
  if (!getcwd(dir, sizeof dir)) return 126;
  FILE *log = fopen(SHIM_LOG, "w");
  if (log) { fputs(dir, log); fclose(log); }
  for (;;) {
    snprintf(file, sizeof file, "%s/.tool-versions", dir);
    FILE *f = fopen(file, "r");
    if (f && fgets(line, sizeof line, f) && strncmp(line, "nodejs path:", 12) == 0) {
      line[strcspn(line, "\\n")] = 0;
      snprintf(bin, sizeof bin, "%s/bin/node", line + 12);
      argv[0] = bin; execv(bin, argv); return 127;
    }
    char *slash = strrchr(dir, '/');
    if (!slash || slash == dir) break;
    *slash = 0;
  }
  argv[0] = REAL_NODE; execv(REAL_NODE, argv);
  return 127;
}
`;
  const cc = (() => {
    try {
      return execFileSync("sh", ["-c", "command -v cc"], {
        encoding: "utf8",
      }).trim();
    } catch {
      return "";
    }
  })();

  function nativeShim(): { shim: string; log: string } {
    const bin = dir("proto-shims");
    const source = join(bin, "shim.c");
    const shim = join(bin, "node");
    const log = join(bin, "started-in.txt");
    writeFileSync(source, SHIM_SOURCE);
    execFileSync(cc, [
      `-DSHIM_LOG=${JSON.stringify(log)}`,
      `-DREAL_NODE=${JSON.stringify(realpathSync(NODE))}`,
      "-o",
      shim,
      source,
    ]);
    return { shim, log };
  }

  for (const [name, make] of DRIVERS) {
    test.skipIf(process.platform === "win32" || cc === "")(
      `${name}: a native shim named node that reads .tool-versions from its cwd and ancestors does not see the workspace's`,
      async () => {
        const { shim, log } = nativeShim();
        const work = dir("work");
        const marker = join(dir("marks"), "agent-node-ran");
        mkdirSync(join(work, "evilnode", "bin"), { recursive: true });
        writeFileSync(
          join(work, "evilnode", "bin", "node"),
          `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`,
          { mode: 0o755 },
        );
        writeFileSync(
          join(work, ".tool-versions"),
          `nodejs path:${join(work, "evilnode")}\n`,
        );
        const pkg = dir("pkg");
        const { entry, record } = fakeEntry(pkg);

        const events = await collect(
          make({ interpreter: shim, entry }).run(request(work)),
        );

        expect(errorOf(events)).toBeUndefined();
        expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 0 });
        expect(existsSync(marker)).toBe(false);
        // The shim started in the entry's directory, a host directory.
        expect(readFileSync(log, "utf8")).toBe(realpathSync(pkg));
        // The CLI itself still runs in the workspace.
        const seen = JSON.parse(readFileSync(record, "utf8")) as {
          cwd: string;
        };
        expect(realpathSync(seen.cwd)).toBe(realpathSync(work));
      },
    );

    test(`${name}: a working directory the preload cannot enter fails the run closed; the entry never runs`, async () => {
      const work = join(dir("parent"), "missing-workspace");
      const { entry, record } = fakeEntry(dir("pkg"));
      const events = await collect(
        make({ interpreter: NODE, entry }).run(request(work)),
      );

      expect(existsSync(record)).toBe(false);
      expect(errorOf(events)).toBeDefined();
      const last = events.at(-1) as { type: string; exitCode?: number };
      expect(last.type).toBe("completed");
      expect(last.exitCode).not.toBe(0);
    });

    test(`${name}: an entry in a sandbox-writable temp directory is refused`, async () => {
      const work = dir("work");
      const pkg = join(tempScratch, `pkg-${counter++}`);
      mkdirSync(pkg, { recursive: true });
      const { entry, record } = fakeEntry(pkg);
      const { calls, spawn } = recordingSpawn();
      for (const config of [
        { interpreter: NODE, entry },
        { spawn, interpreter: "node", entry },
      ]) {
        const events = await collect(make(config).run(request(work)));
        const error = errorOf(events);
        expect(error?.code).toBe(EXTERNAL_AGENT_INTERPRETER_UNSAFE);
        expect(error?.message).toContain("temp directory");
      }
      expect(calls).toHaveLength(0);
      expect(existsSync(record)).toBe(false);
    });

    test.skipIf(process.platform === "win32")(
      `${name}: an interpreter whose real file is in a temp directory is refused`,
      async () => {
        const work = dir("work");
        const target = join(tempScratch, `bin-${counter++}`);
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, "node"), "#!/bin/sh\n", { mode: 0o755 });
        const link = join(dir("bin"), "node");
        symlinkSync(join(target, "node"), link);
        const { entry } = fakeEntry(dir("pkg"));
        const { calls, spawn } = recordingSpawn();
        for (const config of [
          { interpreter: link, entry },
          // Found as a bare name: the PATH lookup skips only the run's own
          // roots, so the real-path check is what refuses it.
          { interpreter: "node", entry, env: { PATH: dirname(link) } },
          { spawn, interpreter: link, entry },
        ]) {
          const events = await collect(make(config).run(request(work)));
          const error = errorOf(events);
          expect(error?.code).toBe(EXTERNAL_AGENT_INTERPRETER_UNSAFE);
          expect(error?.message).toContain("temp directory");
        }
        expect(calls).toHaveLength(0);
      },
    );
  }

  test("the preload refuses to start the entry without the variable, and removes it", () => {
    const pkg = dir("pkg");
    const { entry, record } = fakeEntry(pkg);
    const run = (env: Record<string, string>) => {
      try {
        execFileSync(NODE, ["--import", CHDIR_PRELOAD, entry], {
          cwd: pkg,
          env: { PATH: process.env.PATH ?? "", ...env },
          stdio: "pipe",
          input: "",
        });
        return 0;
      } catch (error) {
        return (error as { status?: number }).status ?? -1;
      }
    };

    expect(run({})).not.toBe(0);
    expect(run({ [AGENT_CWD_ENV]: "" })).not.toBe(0);
    expect(existsSync(record)).toBe(false);
    const work = dir("work");
    expect(run({ [AGENT_CWD_ENV]: work })).toBe(0);
    const seen = JSON.parse(readFileSync(record, "utf8")) as {
      cwd: string;
      pwd: string;
      agentCwdVar: string | null;
    };
    expect(realpathSync(seen.cwd)).toBe(realpathSync(work));
    expect(seen.pwd).toBe(seen.cwd);
    expect(seen.agentCwdVar).toBeNull();
  });

  test("resolveCliLaunch: the cwd is the entry's canonical directory; the workspace is absolute", () => {
    const pkg = dir("pkg");
    writeFileSync(join(pkg, "cli.cjs"), "");
    const linkParent = dir("links");
    if (process.platform !== "win32") {
      symlinkSync(pkg, join(linkParent, "pkg-link"), "dir");
    }
    const entry =
      process.platform === "win32"
        ? join(pkg, "cli.cjs")
        : join(linkParent, "pkg-link", "cli.cjs");
    const outcome = resolveCliLaunch({
      command: "node",
      entry,
      env: {},
      request: { workingDirectory: join("..", "relative-workspace") },
      builtInSpawn: false,
      missing: () => new ExternalAgentPolicyError("MISSING_BINARY", "x"),
    });
    expect(outcome).toMatchObject({
      launch: {
        cwd: realpathSync(pkg),
        env: { [AGENT_CWD_ENV]: resolve("..", "relative-workspace") },
      },
    });
  });
});

describe("the entry is started by the canonical path that was checked", () => {
  /**
   * The host configures `entry` as a symlink chain that passes through the
   * run's working directory: host/link -> work/l2 -> host/cli.cjs. The check
   * sees the host file; the agent then re-points its own work/l2 at a file
   * it wrote. What starts must still be the host file.
   */
  function chain() {
    const work = dir("work");
    const host = dir("host");
    const { entry: real, record } = fakeEntry(host);
    const marker = join(dir("marks"), "agent-entry-ran");
    const evil = join(work, "evil.cjs");
    writeFileSync(
      evil,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "agent code ran as the CLI");`,
    );
    const inner = join(work, "l2");
    symlinkSync(real, inner);
    const link = join(host, "link.cjs");
    symlinkSync(inner, link);
    const repoint = () => {
      rmSync(inner);
      symlinkSync(evil, inner);
    };
    return { work, real, record, marker, link, repoint };
  }

  for (const [name, make] of DRIVERS) {
    test.skipIf(process.platform === "win32")(
      `${name}: re-pointing a link in the chain after the check does not change what runs`,
      async () => {
        const { work, real, record, marker, link, repoint } = chain();
        const started: Array<readonly string[]> = [];
        // Re-points the agent's link between the check and the start, then
        // starts the process for real with what the driver handed over.
        const spawn = (
          command: string,
          args: readonly string[],
          options: {
            cwd?: string;
            env?: Record<string, string>;
            input?: string;
          },
        ) => {
          started.push(args);
          repoint();
          const result = spawnSync(command, [...args], {
            cwd: options.cwd,
            env: options.env,
            input: options.input ?? "",
          });
          return {
            stdout: null,
            stderr: null,
            exited: Promise.resolve(result.status ?? 1),
            kill() {},
          };
        };

        const events = await collect(
          make({ spawn, interpreter: NODE, entry: link }).run(request(work)),
        );

        expect(started[0]?.[2]).toBe(realpathSync(real));
        expect(existsSync(marker)).toBe(false);
        expect(existsSync(record)).toBe(true);
        expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 0 });
      },
    );
  }

  test.skipIf(process.platform === "win32")(
    "resolveCliLaunch returns the canonical entry, and the checked real interpreter for a custom spawn",
    () => {
      const { work, real, link } = chain();
      const nodeLink = join(dir("bin"), "node");
      symlinkSync(NODE, nodeLink);
      const missing = () => new ExternalAgentPolicyError("MISSING_BINARY", "x");
      for (const builtInSpawn of [true, false]) {
        expect(
          resolveCliLaunch({
            command: nodeLink,
            entry: link,
            env: {},
            request: { workingDirectory: work },
            builtInSpawn,
            missing,
          }),
        ).toMatchObject({
          launch: {
            command: realpathSync(NODE),
            prefix: PREFIX(realpathSync(real)),
            cwd: dirname(realpathSync(real)),
          },
        });
      }
    },
  );
});

describe("review probes r2 and r3, kept: nothing the workspace configures runs", () => {
  /** A workspace with a bunfig.toml preload, a .env and a .tool-versions to an agent node. */
  function workspace() {
    const work = dir("ws");
    const preloadMarker = join(work, "PRELOAD_RAN");
    const shimMarker = join(work, "SHIM_RAN_AGENT_CODE");
    writeFileSync(
      join(work, "evil.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(preloadMarker)}, "x");`,
    );
    writeFileSync(join(work, "bunfig.toml"), 'preload = ["./evil.js"]\n');
    writeFileSync(join(work, ".env"), "PROBE_FROM_DOTENV=agent\n");
    const evil = join(work, "evilnode", "bin");
    mkdirSync(evil, { recursive: true });
    writeFileSync(
      join(evil, "node"),
      `#!/bin/sh\necho agent > ${JSON.stringify(shimMarker)}\nexit 0\n`,
    );
    chmodSync(join(evil, "node"), 0o755);
    writeFileSync(
      join(work, ".tool-versions"),
      `nodejs path:${join(work, "evilnode")}\n`,
    );
    return { work, preloadMarker, shimMarker };
  }

  // The reviewer's native shim (probes/adk-review/4k-winrun/native-shim.c):
  // reads ./.tool-versions only, else runs the real Node.
  const REVIEW_SHIM = `
#include <stdio.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  char line[1024], bin[1100];
  FILE *f = fopen(".tool-versions", "r");
  if (f && fgets(line, sizeof line, f) && strncmp(line, "nodejs path:", 12) == 0) {
    line[strcspn(line, "\\n")] = 0;
    snprintf(bin, sizeof bin, "%s/bin/node", line + 12);
    argv[0] = bin; execv(bin, argv);
  }
  argv[0] = REAL_NODE; execv(REAL_NODE, argv);
  return 127;
}
`;
  const cc = (() => {
    try {
      return execFileSync("sh", ["-c", "command -v cc"], {
        encoding: "utf8",
      }).trim();
    } catch {
      return "";
    }
  })();

  for (const [name, make] of DRIVERS) {
    test(`${name}: r2 inverted bunfig preload: Bun refused, Node runs the entry, the preload never runs`, async () => {
      for (const interpreter of [process.execPath, NODE]) {
        const { work, preloadMarker } = workspace();
        const { entry, record } = fakeEntry(dir("outside"));
        const events = await collect(
          make({ interpreter, entry }).run(request(work)),
        );
        expect(existsSync(preloadMarker)).toBe(false);
        if (interpreter === NODE) {
          expect(errorOf(events)).toBeUndefined();
          expect(existsSync(record)).toBe(true);
        } else if (process.versions.bun) {
          expect(errorOf(events)?.code).toBe(EXTERNAL_AGENT_INTERPRETER_UNSAFE);
          expect(existsSync(record)).toBe(false);
        }
      }
    });

    test(`${name}: r2 script shim named node (asdf/nodenv style) is refused and runs nothing`, async () => {
      const { work, shimMarker } = workspace();
      const shimDir = join(dir("host-shims"), "shims");
      mkdirSync(shimDir, { recursive: true });
      const shim = join(shimDir, "node");
      writeFileSync(
        shim,
        `#!/bin/sh\nv=$(sed -n 's/^nodejs path://p' .tool-versions 2>/dev/null)\nif [ -n "$v" ]; then exec "$v/bin/node" "$@"; fi\nexec ${JSON.stringify(NODE)} "$@"\n`,
      );
      chmodSync(shim, 0o755);
      const { entry } = fakeEntry(dir("outside"));
      const events = await collect(
        make({ interpreter: shim, entry }).run(request(work)),
      );
      expect(errorOf(events)?.code).toBe(EXTERNAL_AGENT_INTERPRETER_UNSAFE);
      expect(existsSync(shimMarker)).toBe(false);
    });

    test.skipIf(process.platform === "win32" || cc === "")(
      `${name}: r3 native shim named node (proto style) is accepted but never sees the workspace config`,
      async () => {
        const { work, shimMarker } = workspace();
        const shimDir = dir("review-native-shim");
        const source = join(shimDir, "native-shim.c");
        writeFileSync(source, REVIEW_SHIM);
        const shim = join(shimDir, "node");
        execFileSync(cc, [
          `-DREAL_NODE=${JSON.stringify(realpathSync(NODE))}`,
          "-o",
          shim,
          source,
        ]);
        const { entry, record } = fakeEntry(dir("outside"));
        const events = await collect(
          make({ interpreter: shim, entry }).run(request(work)),
        );
        expect(errorOf(events)).toBeUndefined();
        expect(existsSync(shimMarker)).toBe(false);
        expect(existsSync(record)).toBe(true);
      },
    );
  }
});
