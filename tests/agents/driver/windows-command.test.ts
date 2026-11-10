import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, win32 } from "node:path";
import { batchCommandRefusal } from "../../../src/agents/driver/policy-errors.js";
import {
  BatchCommandRefusedError,
  type DriverSpawnOptions,
  type NodeSpawnLike,
  resolveWindowsCommand,
  spawnSubprocess,
  windowsExecutableKind,
} from "../../../src/agents/driver/spawn.js";
import { resolveCliCommand } from "../../../src/agents/driver/subprocess-jsonl.js";
import type { ExternalAgentRunRequest } from "../../../src/agents/index.js";
import {
  ClaudeCliDriver,
  CodexCliDriver,
  GEMINI_CLI_PROVIDER,
  GeminiCliDriver,
  type GeminiCliSpawn,
} from "../../../src/agents/index.js";

/** A Windows file system with only these files. */
function host(files: string[], env: Record<string, string> = {}) {
  const present = new Set(files.map((file) => file.toLowerCase()));
  return {
    env: { Path: "C:\\shims;C:\\tools", ...env },
    exists: (path: string) => present.has(path.toLowerCase()),
  };
}

function code(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
  return undefined;
}

describe("resolveWindowsCommand", () => {
  test("a bare name resolves to the first .exe on PATH", () => {
    const fs = host(["C:\\tools\\gemini.exe"]);

    expect(resolveWindowsCommand("gemini", fs)).toBe("C:\\tools\\gemini.exe");
  });

  test("an npm shim ahead of the .exe is skipped: the native file wins", () => {
    const fs = host(["C:\\shims\\gemini.cmd", "C:\\tools\\gemini.exe"]);

    expect(resolveWindowsCommand("gemini", fs)).toBe("C:\\tools\\gemini.exe");
  });

  test("only a .cmd or .bat on PATH is a refusal, not a missing binary", () => {
    for (const shim of ["C:\\shims\\claude.cmd", "C:\\tools\\claude.BAT"]) {
      expect(code(() => resolveWindowsCommand("claude", host([shim])))).toBe(
        "EXTERNAL_AGENT_BATCH_COMMAND_REFUSED",
      );
    }
  });

  test("an explicit batch path is refused without looking at the disk", () => {
    for (const command of [
      "C:\\npm\\gemini.cmd",
      "gemini.CMD",
      "tool.bat",
      "C:\\npm\\gemini.cmd.",
      "C:\\npm\\gemini.cmd ",
      "./gemini.cmd",
    ]) {
      expect(code(() => resolveWindowsCommand(command, host([])))).toBe(
        "EXTERNAL_AGENT_BATCH_COMMAND_REFUSED",
      );
    }
  });

  test("an explicit .exe path is used as given", () => {
    expect(resolveWindowsCommand("C:\\Apps\\claude.exe", host([]))).toBe(
      "C:\\Apps\\claude.exe",
    );
  });

  test("a path without extension finds its .exe, and refuses a sibling .cmd", () => {
    expect(
      resolveWindowsCommand("C:\\Apps\\codex", host(["C:\\Apps\\codex.exe"])),
    ).toBe("C:\\Apps\\codex.exe");
    expect(
      code(() =>
        resolveWindowsCommand("C:\\Apps\\codex", host(["C:\\Apps\\codex.cmd"])),
      ),
    ).toBe("EXTERNAL_AGENT_BATCH_COMMAND_REFUSED");
  });

  test("nothing found is ENOENT, so the driver reports a missing binary", () => {
    expect(code(() => resolveWindowsCommand("gemini", host([])))).toBe(
      "ENOENT",
    );
    expect(code(() => resolveWindowsCommand("C:\\x\\gemini", host([])))).toBe(
      "ENOENT",
    );
  });

  test("the working directory is not searched", () => {
    // `gemini.exe` next to the host process does not count, only PATH.
    expect(
      code(() =>
        resolveWindowsCommand("gemini", host(["gemini.exe", ".\\gemini.exe"])),
      ),
    ).toBe("ENOENT");
  });

  test("the PATH variable is found in any letter case, and quoted entries work", () => {
    const fs = {
      env: { PATH: '"C:\\Program Files\\g";C:\\x' },
      exists: (path: string) => path === "C:\\Program Files\\g\\gemini.exe",
    };

    expect(resolveWindowsCommand("gemini", fs)).toBe(
      "C:\\Program Files\\g\\gemini.exe",
    );
  });
});

describe("resolveWindowsCommand returns absolute paths only", () => {
  const everything = {
    env: { Path: ".;bin;node_modules\\.bin;C:\\tools" },
    exists: () => true,
  };

  test("relative PATH entries are skipped", () => {
    expect(resolveWindowsCommand("gemini", everything)).toBe(
      "C:\\tools\\gemini.com",
    );
    expect(
      code(() =>
        resolveWindowsCommand("gemini", {
          env: { Path: ".;bin;node_modules\\.bin" },
          exists: () => true,
        }),
      ),
    ).toBe("ENOENT");
  });

  test("a bare claude.exe is looked up over PATH, never left to the runtime", () => {
    const fs = host(["C:\\tools\\claude.exe"]);

    expect(resolveWindowsCommand("claude.exe", fs)).toBe(
      "C:\\tools\\claude.exe",
    );
    expect(code(() => resolveWindowsCommand("claude.exe", host([])))).toBe(
      "ENOENT",
    );
    // `claude.com` on PATH is not `claude.exe`.
    expect(
      code(() =>
        resolveWindowsCommand("claude.exe", host(["C:\\tools\\claude.com"])),
      ),
    ).toBe("ENOENT");
  });

  test("a relative path with a directory becomes absolute", () => {
    for (const command of [".\\claude.exe", "bin\\claude.exe"]) {
      expect(win32.isAbsolute(resolveWindowsCommand(command, host([])))).toBe(
        true,
      );
    }
  });

  test("every result of every shape is absolute", () => {
    const fs = host(["C:\\tools\\a.exe", "C:\\tools\\b.com"]);
    for (const command of ["a", "a.exe", "b", "C:\\x\\c.exe"]) {
      expect(win32.isAbsolute(resolveWindowsCommand(command, fs))).toBe(true);
    }
  });

  test("a .com wins over a .exe in the same directory, as in the default PATHEXT", () => {
    const fs = host(["C:\\tools\\t.exe", "C:\\tools\\t.com"]);

    expect(resolveWindowsCommand("t", fs)).toBe("C:\\tools\\t.com");
  });
});

describe("resolveWindowsCommand never searches the run's working directory", () => {
  const env = {
    Path: "C:\\run\\node_modules\\.bin;C:\\run;C:\\run2;C:\\tools",
  };
  const files = [
    "C:\\run\\node_modules\\.bin\\claude.exe",
    "C:\\run\\claude.exe",
    "C:\\run2\\claude.exe",
    "C:\\tools\\claude.exe",
  ];

  test("entries at or under the working directory are dropped", () => {
    const present = new Set(files.map((file) => file.toLowerCase()));
    const fs = {
      env,
      exists: (path: string) => present.has(path.toLowerCase()),
      excluded: ["C:\\run"],
    };

    // `C:\run2` only shares a prefix with `C:\run`, so it is searched.
    expect(resolveWindowsCommand("claude", fs)).toBe("C:\\run2\\claude.exe");
    expect(resolveWindowsCommand("claude.exe", fs)).toBe(
      "C:\\run2\\claude.exe",
    );
  });

  test("the comparison ignores case and a trailing separator", () => {
    const fs = {
      env: { Path: "C:\\RUN\\Node_Modules\\.bin;C:\\tools" },
      exists: () => true,
      excluded: ["c:\\run\\"],
    };

    expect(resolveWindowsCommand("claude", fs)).toBe("C:\\tools\\claude.com");
  });

  test("a planted shim under the working directory is skipped, not refused", () => {
    const fs = {
      env,
      exists: (path: string) =>
        path === "C:\\run\\node_modules\\.bin\\claude.cmd" ||
        path === "C:\\tools\\claude.exe",
      excluded: ["C:\\run"],
    };

    expect(resolveWindowsCommand("claude", fs)).toBe("C:\\tools\\claude.exe");
  });

  test("when only the working directory has it, the command is missing", () => {
    const fs = {
      env: { Path: "C:\\run\\node_modules\\.bin" },
      exists: () => true,
      excluded: ["C:\\run"],
    };

    expect(code(() => resolveWindowsCommand("claude", fs))).toBe("ENOENT");
  });

  test("spawnSubprocess excludes options.cwd", () => {
    const present = new Set(files.map((file) => file.toLowerCase()));
    const calls: string[] = [];
    const nodeSpawn: NodeSpawnLike = (command) => {
      calls.push(command);
      throw new Error("stop here");
    };

    expect(() =>
      spawnSubprocess(
        "claude",
        [],
        { env, cwd: "C:\\run" },
        {
          bun: null,
          nodeSpawn,
          platform: "win32",
          fileExists: (path) => present.has(path.toLowerCase()),
        },
      ),
    ).toThrow("stop here");
    expect(calls).toEqual(["C:\\run2\\claude.exe"]);
  });
});

describe("one rule for explicit paths: the caller's choice", () => {
  const fs = {
    env: { Path: "C:\\tools" },
    exists: (path: string) =>
      path.toLowerCase() === "c:\\run\\tools\\claude.exe",
    excluded: ["C:\\run"],
  };

  test("an explicit path under the working directory is used, with or without extension", () => {
    expect(resolveWindowsCommand("C:\\run\\tools\\claude.exe", fs)).toBe(
      "C:\\run\\tools\\claude.exe",
    );
    expect(resolveWindowsCommand("C:\\run\\tools\\claude", fs)).toBe(
      "C:\\run\\tools\\claude.exe",
    );
  });

  test("the same file found through PATH is skipped", () => {
    expect(
      code(() =>
        resolveWindowsCommand("claude", {
          ...fs,
          env: { Path: "C:\\run\\tools" },
        }),
      ),
    ).toBe("ENOENT");
  });
});

describe("the candidate check alone keeps an excluded file out", () => {
  test("a PATH entry outside the excluded roots whose candidate is excluded", () => {
    const fs = {
      env: { Path: "C:\\tools;C:\\other" },
      exists: () => true,
      // The file itself is excluded (as a symlink into the run's directory
      // would be after resolution), though its directory is not.
      excluded: ["C:\\tools\\claude.com", "C:\\tools\\claude.exe"],
    };

    expect(resolveWindowsCommand("claude", fs)).toBe("C:\\other\\claude.com");
    expect(resolveWindowsCommand("claude.exe", fs)).toBe(
      "C:\\other\\claude.exe",
    );
  });
});

describe("merged lookup: the drivers' resolveCliCommand, then the spawn", () => {
  const request = { workingDirectory: "C:\\run" };

  function chain(files: string[], path: string, command = "claude") {
    const present = new Set(files.map((file) => file.toLowerCase()));
    const env = { PATH: path };
    const resolved = resolveCliCommand(command, env, request, {
      platform: "win32",
      isExecutableFile: (file) => present.has(file.toLowerCase()),
      isSearchable: () => true,
    });
    const calls: string[] = [];
    const nodeSpawn: NodeSpawnLike = (executable) => {
      calls.push(executable);
      throw new Error("stop here");
    };
    const run = () =>
      spawnSubprocess(
        resolved ?? command,
        [],
        { env },
        {
          bun: null,
          nodeSpawn,
          platform: "win32",
          fileExists: (file) => present.has(file.toLowerCase()),
        },
      );
    return { resolved, calls, run };
  }

  test("a .cmd earlier on PATH and a .exe later: both pick the .exe and it is spawned", () => {
    const { resolved, calls, run } = chain(
      ["C:\\npm\\claude.cmd", "C:\\tools\\claude.exe"],
      "C:\\npm;C:\\tools",
    );

    expect(resolved?.toLowerCase()).toBe("c:\\tools\\claude.exe");
    expect(run).toThrow("stop here");
    expect(calls.map((call) => call.toLowerCase())).toEqual([
      "c:\\tools\\claude.exe",
    ]);
  });

  test("a .exe earlier and a .cmd later: the .exe", () => {
    const { resolved } = chain(
      ["C:\\tools\\claude.exe", "C:\\npm\\claude.cmd"],
      "C:\\tools;C:\\npm",
    );

    expect(resolved?.toLowerCase()).toBe("c:\\tools\\claude.exe");
  });

  test("only a .cmd: the lookup hands it on and the spawn refuses it with the remedy path", () => {
    const { resolved, calls, run } = chain(
      ["C:\\npm\\claude.cmd"],
      "C:\\npm;C:\\tools",
    );

    expect(resolved?.toLowerCase()).toBe("c:\\npm\\claude.cmd");
    expect(code(run)).toBe("EXTERNAL_AGENT_BATCH_COMMAND_REFUSED");
    expect(calls.map((call) => call.toLowerCase())).toEqual([]);
  });

  const npmShims = [
    "C:\\npm\\claude",
    "C:\\npm\\claude.cmd",
    "C:\\npm\\claude.ps1",
  ];

  test("the npm layout (sh shim, .cmd, .ps1) ahead of a native .exe: the .exe is spawned", () => {
    const { resolved, calls, run } = chain(
      [...npmShims, "C:\\tools\\claude.exe"],
      "C:\\npm;C:\\tools",
    );

    expect(resolved?.toLowerCase()).toBe("c:\\tools\\claude.exe");
    expect(run).toThrow("stop here");
    expect(calls.map((call) => call.toLowerCase())).toEqual([
      "c:\\tools\\claude.exe",
    ]);
  });

  test("the npm layout alone: the batch refusal, with the remedy and the doc pointer", () => {
    const { resolved, calls, run } = chain(npmShims, "C:\\npm;C:\\tools");

    // The extensionless shim and the .ps1 are not answers; the .cmd is kept
    // so the refusal can explain.
    expect(resolved?.toLowerCase()).toBe("c:\\npm\\claude.cmd");
    let refused: unknown;
    try {
      run();
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(BatchCommandRefusedError);
    const message = batchCommandRefusal(refused as Error, "claude").message;
    expect(message).toContain("native claude.exe");
    expect(message).toContain("Windows: batch files and npm installs");
    expect(calls).toEqual([]);
  });

  test("an extensionless shim or a .ps1 alone is a missing binary, never an answer", () => {
    for (const files of [
      ["C:\\npm\\claude"],
      ["C:\\npm\\claude.ps1"],
      ["C:\\npm\\claude", "C:\\npm\\claude.ps1"],
    ]) {
      expect(chain(files, "C:\\npm").resolved).toBeUndefined();
    }
  });

  test("nothing on PATH: no command, so the driver reports a missing binary", () => {
    expect(chain([], "C:\\npm").resolved).toBeUndefined();
  });

  test("off Windows the batch rule does not apply", () => {
    const resolved = resolveCliCommand("tool", { PATH: "/a:/b" }, request, {
      platform: "linux",
      isExecutableFile: (file) => file === "/a/tool.cmd" || file === "/b/tool",
      isSearchable: () => true,
    });

    expect(resolved?.toLowerCase()).toBe("/b/tool");
  });
});

describe("windowsExecutableKind", () => {
  test("only .com and .exe are native; .cmd and .bat are batch; the rest is other", () => {
    expect(
      ["a.exe", "A.COM", "C:\\x\\a.Exe"].map(windowsExecutableKind),
    ).toEqual(["native", "native", "native"]);
    expect(["a.cmd", "a.BAT", "a.cmd."].map(windowsExecutableKind)).toEqual([
      "batch",
      "batch",
      "batch",
    ]);
    expect(
      ["a", "a.ps1", "a.js", "a.v2", ""].map(windowsExecutableKind),
    ).toEqual(["other", "other", "other", "other", "other"]);
  });
});

describe("spawnSubprocess on Windows", () => {
  function spy() {
    const calls: Array<[string, readonly string[]]> = [];
    const nodeSpawn: NodeSpawnLike = (command, args) => {
      calls.push([command, args]);
      throw Object.assign(new Error("stop here"), { code: "STOPPED" });
    };
    return { calls, nodeSpawn };
  }

  test("spawns the resolved .exe, on the Node path and on the Bun path", () => {
    const fs = host(["C:\\tools\\gemini.exe"]);
    const node = spy();
    expect(() =>
      spawnSubprocess(
        "gemini",
        ["-p", "a & b"],
        { env: fs.env },
        {
          bun: null,
          nodeSpawn: node.nodeSpawn,
          platform: "win32",
          fileExists: fs.exists,
        },
      ),
    ).toThrow("stop here");
    expect(node.calls).toEqual([["C:\\tools\\gemini.exe", ["-p", "a & b"]]]);

    const bunCalls: string[][] = [];
    expect(() =>
      spawnSubprocess(
        "gemini",
        ["-p", "a & b"],
        { env: fs.env },
        {
          bun: {
            spawn: (command) => {
              bunCalls.push(command);
              throw new Error("stop here");
            },
          },
          platform: "win32",
          fileExists: fs.exists,
        },
      ),
    ).toThrow("stop here");
    expect(bunCalls).toEqual([["C:\\tools\\gemini.exe", "-p", "a & b"]]);
  });

  test("a .cmd shim never reaches either spawn", () => {
    const fs = host(["C:\\shims\\gemini.cmd"]);
    const node = spy();
    let bunCalled = false;

    for (const bun of [
      null,
      {
        spawn: () => {
          bunCalled = true;
          throw new Error("must not run");
        },
      },
    ]) {
      expect(
        code(() =>
          spawnSubprocess(
            "gemini",
            ["-p", "x"],
            { env: fs.env },
            {
              bun,
              nodeSpawn: node.nodeSpawn,
              platform: "win32",
              fileExists: fs.exists,
            },
          ),
        ),
      ).toBe("EXTERNAL_AGENT_BATCH_COMMAND_REFUSED");
    }
    expect(node.calls).toEqual([]);
    expect(bunCalled).toBe(false);
  });

  test("other platforms pass the command through untouched", () => {
    const node = spy();

    expect(() =>
      spawnSubprocess(
        "gemini",
        [],
        {},
        {
          bun: null,
          nodeSpawn: node.nodeSpawn,
          platform: "linux",
          fileExists: () => {
            throw new Error("no lookup off Windows");
          },
        },
      ),
    ).toThrow("stop here");
    expect(node.calls).toEqual([["gemini", []]]);
  });
});

describe("the CLI drivers on Windows with only a .cmd shim on PATH", () => {
  const fs = host([
    "C:\\shims\\gemini.cmd",
    "C:\\shims\\claude.cmd",
    "C:\\shims\\codex.cmd",
  ]);
  const nodeSpawn: NodeSpawnLike = () => {
    throw new Error("a shim must never be spawned");
  };
  const spawn = (
    command: string,
    args: readonly string[],
    options: DriverSpawnOptions,
  ) =>
    spawnSubprocess(
      command,
      args,
      { ...options, env: fs.env },
      { bun: null, nodeSpawn, platform: "win32", fileExists: fs.exists },
    );

  function request(allowNetwork: boolean): ExternalAgentRunRequest {
    return {
      provider: GEMINI_CLI_PROVIDER,
      context: {} as ExternalAgentRunRequest["context"],
      instruction: "say hello",
      permissions: { mode: "ask", allowNetwork },
    };
  }

  // Gemini refuses a run with the network off before it spawns anything, so
  // only the other two have a network-off run that reaches the spawn. Codex
  // lists its MCP servers first in that case, through the same spawn.
  const cases: Array<
    [
      string,
      () => { run: typeof CodexCliDriver.prototype.run },
      boolean,
      RegExp,
    ]
  > = [
    [
      "gemini",
      () => new GeminiCliDriver({ spawn: spawn as never }),
      true,
      /`interpreter`.*`entry`/,
    ],
    [
      "claude",
      () => new ClaudeCliDriver({ spawn: spawn as never }),
      true,
      /native claude\.exe/,
    ],
    [
      "claude",
      () => new ClaudeCliDriver({ spawn: spawn as never }),
      false,
      /native claude\.exe/,
    ],
    [
      "codex",
      () => new CodexCliDriver({ spawn: spawn as never }),
      true,
      /@openai\\codex-win32-x64/,
    ],
    [
      "codex",
      () => new CodexCliDriver({ spawn: spawn as never }),
      false,
      /@openai\\codex-win32-x64/,
    ],
  ];

  for (const [name, make, allowNetwork, advice] of cases) {
    test(`${name} (network ${allowNetwork ? "on" : "off"}): ends with a typed refusal event and never spawns`, async () => {
      const events = [];
      for await (const event of make().run(request(allowNetwork))) {
        events.push(event);
      }

      const error = events.find((event) => event.type === "error");
      expect(error).toMatchObject({
        type: "error",
        code: "EXTERNAL_AGENT_BATCH_COMMAND_REFUSED",
        recoverable: false,
      });
      const message = (error as { message: string }).message;
      expect(message).toMatch(advice);
      expect(message).toContain("Windows: batch files and npm installs");
      expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 1 });
    });
  }

  test("codex with allowUnenforcedNetwork still refuses a batch shim", async () => {
    const events = [];
    const driver = new CodexCliDriver({
      spawn: spawn as never,
      allowUnenforcedNetwork: true,
    });
    for await (const event of driver.run(request(false))) events.push(event);

    expect(events.find((event) => event.type === "error")).toMatchObject({
      code: "EXTERNAL_AGENT_BATCH_COMMAND_REFUSED",
    });
  });
});

describe("the documented Gemini route: a custom spawn that runs node", () => {
  test("the driver's command and arguments are rerouted through process.execPath", async () => {
    const entry =
      "C:\\npm\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js";
    const started: Array<[string, readonly string[]]> = [];
    // The example from docs/external-agent-isolation.md, with the real
    // process start replaced by a fake.
    const spawn: GeminiCliSpawn = (_command, args) => {
      started.push([process.execPath, [entry, ...args]]);
      return { exited: Promise.resolve(0), stdout: null, stderr: null };
    };
    const driver = new GeminiCliDriver({ spawn });

    const events = [];
    for await (const event of driver.run({
      provider: GEMINI_CLI_PROVIDER,
      context: {} as ExternalAgentRunRequest["context"],
      instruction: "say hello",
      permissions: { mode: "ask", allowNetwork: true },
    })) {
      events.push(event);
    }

    expect(started).toHaveLength(1);
    expect(started[0]?.[0]).toBe(process.execPath);
    expect(started[0]?.[1][0]).toBe(entry);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });
});

// Runs on the Windows CI job only: a real `.cmd` that records its own run.
describe.skipIf(process.platform !== "win32")(
  "a real fake .cmd on PATH (Windows)",
  () => {
    function shimDir(name: string) {
      const dir = mkdtempSync(join(tmpdir(), "win-shim-"));
      const marker = join(dir, "ran.txt");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${name}.cmd`),
        `@echo off\r\necho ran> "${marker}"\r\nexit /b 0\r\n`,
      );
      return { dir, marker };
    }

    for (const [name, make] of [
      ["gemini", () => new GeminiCliDriver({})],
      ["claude", () => new ClaudeCliDriver({})],
      ["codex", () => new CodexCliDriver({})],
    ] as const) {
      test(`${name}.cmd on PATH is a refusal and never runs`, async () => {
        const { dir, marker } = shimDir(name);
        // The run's working directory is a sibling, not the shim directory: a
        // PATH entry under it would be skipped, and the shim never reached.
        const work = mkdtempSync(join(tmpdir(), "win-work-"));
        const previous = process.env.PATH ?? process.env.Path;
        process.env.PATH = `${dir}${delimiter}${previous ?? ""}`;
        try {
          const events = [];
          for await (const event of make().run({
            provider: GEMINI_CLI_PROVIDER,
            context: {} as ExternalAgentRunRequest["context"],
            instruction: "x & echo injected> injected.txt",
            workingDirectory: work,
            permissions: { mode: "ask", allowNetwork: true },
          })) {
            events.push(event);
          }
          expect(existsSync(marker)).toBe(false);
          expect(existsSync(join(work, "injected.txt"))).toBe(false);
          const error = events.find((event) => event.type === "error");
          expect([
            "EXTERNAL_AGENT_BATCH_COMMAND_REFUSED",
            "MISSING_BINARY",
          ]).toContain((error as { code?: string } | undefined)?.code ?? "");
        } finally {
          if (previous === undefined) delete process.env.PATH;
          else process.env.PATH = previous;
          rmSync(dir, { recursive: true, force: true });
          rmSync(work, { recursive: true, force: true });
        }
      });
    }
  },
);
