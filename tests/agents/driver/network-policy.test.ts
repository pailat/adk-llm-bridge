import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexCliDriver,
  type CodexCliSpawn,
  mapPolicyToCodexArgs,
} from "../../../src/agents/driver/codex-cli.js";
import { parseCodexMcpList } from "../../../src/agents/driver/codex-mcp.js";
import { CodexSdkDriver } from "../../../src/agents/driver/codex-sdk.js";
import {
  GeminiCliDriver,
  type GeminiCliSpawn,
} from "../../../src/agents/driver/gemini-cli.js";
import {
  EXTERNAL_AGENT_MISSING_BINARY,
  EXTERNAL_AGENT_NETWORK_UNENFORCEABLE,
} from "../../../src/agents/driver/policy-errors.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import type { ExternalAgentRunRequest } from "../../../src/agents/external-agent-driver.js";
import type { ExternalAgentPermissionPolicy } from "../../../src/agents/permissions/schema.js";
import { CODEX_PROVIDER } from "../../../src/agents/provider/codex.js";
import { GEMINI_CLI_PROVIDER } from "../../../src/agents/provider/gemini-cli.js";

const UNSANDBOXED_NO_NETWORK: ExternalAgentPermissionPolicy = {
  mode: "full-access",
  allowNetwork: false,
};

function request(
  permissions: ExternalAgentPermissionPolicy,
  provider = CODEX_PROVIDER,
): ExternalAgentRunRequest {
  return {
    provider,
    context: { input: "hi" } as never,
    instruction: "do it",
    permissions,
  };
}

async function collect(
  run: AsyncIterable<ExternalAgentEvent>,
): Promise<ExternalAgentEvent[]> {
  const events: ExternalAgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

/**
 * A spawn that counts runs. `codex mcp list --json` calls are answered with
 * `listing` and counted apart.
 */
function countingSpawn(listing = "[]") {
  const state = { spawned: 0, listed: 0, runArgs: [] as string[][] };
  const spawn = (_command: string, args: readonly string[]) => {
    if (args[0] === "mcp" && args[1] === "list") {
      state.listed++;
      return {
        stdout: (async function* () {
          yield listing;
        })(),
        stderr: null,
        exited: Promise.resolve(0),
      };
    }
    state.spawned++;
    state.runArgs.push([...args]);
    return {
      stdout: (async function* () {})(),
      stderr: null,
      exited: Promise.resolve(0),
    };
  };
  return { spawn, state };
}

describe("full-access with allowNetwork: false is refused", () => {
  test("Codex CLI does not spawn and reports the typed error", async () => {
    const { spawn, state } = countingSpawn();
    const events = await collect(
      new CodexCliDriver({ spawn: spawn as CodexCliSpawn }).run(
        request(UNSANDBOXED_NO_NETWORK),
      ),
    );
    expect(state.spawned).toBe(0);
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "error",
      "completed",
    ]);
    expect(events[1]).toMatchObject({
      code: EXTERNAL_AGENT_NETWORK_UNENFORCEABLE,
      recoverable: false,
    });
    expect(events[2]).toMatchObject({ exitCode: 1 });
  });

  test("Codex CLI runs with allowUnenforcedNetwork", async () => {
    const { spawn, state } = countingSpawn();
    await collect(
      new CodexCliDriver({
        spawn: spawn as CodexCliSpawn,
        allowUnenforcedNetwork: true,
      }).run(request(UNSANDBOXED_NO_NETWORK)),
    );
    expect(state.spawned).toBe(1);
  });

  test("Codex SDK does not start a thread", async () => {
    let started = 0;
    const sdk = {
      startThread: () => {
        started++;
        throw new Error("should not start");
      },
      resumeThread: () => {
        throw new Error("should not resume");
      },
    };
    const events = await collect(
      new CodexSdkDriver({ sdk }).run(request(UNSANDBOXED_NO_NETWORK)),
    );
    expect(started).toBe(0);
    expect(events.find((event) => event.type === "error")).toMatchObject({
      code: EXTERNAL_AGENT_NETWORK_UNENFORCEABLE,
      recoverable: false,
    });
    expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 1 });
  });

  test("Gemini CLI does not spawn", async () => {
    const { spawn, state } = countingSpawn();
    const events = await collect(
      new GeminiCliDriver({ spawn: spawn as GeminiCliSpawn }).run(
        request(UNSANDBOXED_NO_NETWORK, GEMINI_CLI_PROVIDER),
      ),
    );
    expect(state.spawned).toBe(0);
    expect(events.find((event) => event.type === "error")).toMatchObject({
      code: EXTERNAL_AGENT_NETWORK_UNENFORCEABLE,
    });
  });

  test("sandboxed modes and full-access with the network on are not refused", async () => {
    for (const permissions of [
      { mode: "workspace-write" as const, allowNetwork: false },
      { mode: "full-access" as const, allowNetwork: true },
    ]) {
      const { spawn, state } = countingSpawn();
      await collect(
        new CodexCliDriver({ spawn: spawn as CodexCliSpawn }).run(
          request(permissions),
        ),
      );
      expect(state.spawned).toBe(1);
    }
  });
});

describe("Codex CLI network flags", () => {
  test("allowNetwork: false pins the sandbox network and web search off", () => {
    expect(
      mapPolicyToCodexArgs({ mode: "workspace-write", allowNetwork: false }),
    ).toEqual([
      "--ask-for-approval",
      "never",
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "-c",
      "sandbox_workspace_write.network_access=false",
      "-c",
      'web_search="disabled"',
    ]);
  });

  test("allowNetwork: true turns the sandbox network on", () => {
    expect(
      mapPolicyToCodexArgs({ mode: "ask", allowNetwork: true }).slice(-2),
    ).toEqual(["-c", "sandbox_workspace_write.network_access=true"]);
  });

  test("allowNetwork unset pins the network off, as false does", () => {
    expect(mapPolicyToCodexArgs({ mode: "ask" })).toEqual(
      mapPolicyToCodexArgs({ mode: "ask", allowNetwork: false }),
    );
  });
});

const NO_NETWORK: ExternalAgentPermissionPolicy = {
  mode: "workspace-write",
  allowNetwork: false,
};

const HOST_SERVERS = JSON.stringify([
  { name: "web-srv", enabled: true, transport: { type: "stdio" } },
  { name: "docs_api", enabled: false, transport: { type: "http" } },
]);

describe("Codex host MCP servers under allowNetwork: false", () => {
  test("the CLI lists them with the run's env and cwd and turns each off", async () => {
    const { spawn, state } = countingSpawn(HOST_SERVERS);
    const seen: Array<{ cwd?: string; env: Record<string, string> }> = [];
    const driver = new CodexCliDriver({
      spawn: ((command, args, options) => {
        seen.push(options);
        return spawn(command, args);
      }) as CodexCliSpawn,
      env: { PATH: "/bin", CODEX_HOME: "/tmp/codex-home" },
    });
    await collect(
      driver.run({ ...request(NO_NETWORK), workingDirectory: "/work" }),
    );
    expect(state.listed).toBe(1);
    expect(state.spawned).toBe(1);
    expect(seen[0]?.cwd).toBe("/work");
    const args = state.runArgs[0] ?? [];
    const overrides = args.filter((_, i) => args[i - 1] === "-c");
    expect(overrides).toContain("mcp_servers.web-srv.enabled=false");
    expect(overrides).toContain("mcp_servers.docs_api.enabled=false");
    // Before the prompt, which is the last argument.
    expect(args.indexOf("mcp_servers.web-srv.enabled=false")).toBeLessThan(
      args.length - 1,
    );
  });

  test("the CLI does not list servers when the network is allowed", async () => {
    const { spawn, state } = countingSpawn(HOST_SERVERS);
    await collect(
      new CodexCliDriver({ spawn: spawn as CodexCliSpawn }).run(
        request({ mode: "workspace-write", allowNetwork: true }),
      ),
    );
    expect(state.listed).toBe(0);
    expect(state.runArgs[0]?.join(" ")).not.toContain("mcp_servers");
  });

  test("the CLI lists and turns off servers when allowNetwork is unset", async () => {
    const { spawn, state } = countingSpawn(HOST_SERVERS);
    await collect(
      new CodexCliDriver({ spawn: spawn as CodexCliSpawn }).run(
        request({ mode: "workspace-write" }),
      ),
    );
    expect(state.listed).toBe(1);
    expect(state.runArgs[0]).toContain("mcp_servers.web-srv.enabled=false");
  });

  test("a failed listing refuses the CLI run", async () => {
    const { spawn, state } = countingSpawn();
    const events = await collect(
      new CodexCliDriver({
        spawn: spawn as CodexCliSpawn,
        listMcpServers: async () => {
          throw new Error("config.toml is invalid");
        },
      }).run(request(NO_NETWORK)),
    );
    expect(state.spawned).toBe(0);
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "error",
      "completed",
    ]);
    expect(events[1]).toMatchObject({
      code: EXTERNAL_AGENT_NETWORK_UNENFORCEABLE,
      recoverable: false,
    });
    expect((events[1] as { message: string }).message).toContain(
      "config.toml is invalid",
    );
  });

  test("unparseable listing output refuses the CLI run", async () => {
    const { spawn, state } = countingSpawn("No MCP servers configured");
    const events = await collect(
      new CodexCliDriver({ spawn: spawn as CodexCliSpawn }).run(
        request(NO_NETWORK),
      ),
    );
    expect(state.spawned).toBe(0);
    expect(events[1]).toMatchObject({
      code: EXTERNAL_AGENT_NETWORK_UNENFORCEABLE,
    });
  });

  test("a server name that cannot be overridden refuses the run", async () => {
    const { spawn, state } = countingSpawn(
      JSON.stringify([{ name: "my.server" }]),
    );
    const events = await collect(
      new CodexCliDriver({ spawn: spawn as CodexCliSpawn }).run(
        request(NO_NETWORK),
      ),
    );
    expect(state.spawned).toBe(0);
    expect(events[1]).toMatchObject({
      code: EXTERNAL_AGENT_NETWORK_UNENFORCEABLE,
    });
  });

  test("with allowUnenforcedNetwork a failed listing only warns", async () => {
    const { spawn, state } = countingSpawn();
    await collect(
      new CodexCliDriver({
        spawn: spawn as CodexCliSpawn,
        allowUnenforcedNetwork: true,
        listMcpServers: async () => {
          throw new Error("boom");
        },
      }).run(request(NO_NETWORK)),
    );
    expect(state.spawned).toBe(1);
  });

  test("a missing codex binary during the listing is reported as missing", async () => {
    const events = await collect(
      new CodexCliDriver({
        spawn: ((_command, args) => {
          const error = Object.assign(new Error("spawn codex ENOENT"), {
            code: "ENOENT",
          });
          if (args[0] === "mcp") throw error;
          throw new Error("should not run");
        }) as CodexCliSpawn,
      }).run(request(NO_NETWORK)),
    );
    expect(events[1]).toMatchObject({
      code: EXTERNAL_AGENT_MISSING_BINARY,
      recoverable: false,
    });
    expect((events[1] as { message: string }).message).toContain(
      "npm install -g @openai/codex",
    );
  });

  test("the SDK passes the disables as configOverrides, with config.mcp_servers keys", async () => {
    const constructed: Array<Record<string, unknown>> = [];
    const listed: Array<{ command: string; cwd?: string }> = [];
    class FakeCodex {
      constructor(options: Record<string, unknown>) {
        constructed.push(options);
      }
      startThread() {
        return {
          id: "t1",
          runStreamed: async () => ({
            events: (async function* () {
              yield { type: "turn.completed" };
            })(),
          }),
        };
      }
      resumeThread() {
        return this.startThread();
      }
    }
    const events = await collect(
      new CodexSdkDriver({
        Codex: FakeCodex as never,
        codexPathOverride: "/opt/codex",
        config: { mcp_servers: { own: { command: "x" } } },
        listMcpServers: async (options) => {
          listed.push(options);
          return parseCodexMcpList(HOST_SERVERS);
        },
      }).run({ ...request(NO_NETWORK), workingDirectory: "/work" }),
    );
    expect(listed).toEqual([
      expect.objectContaining({ command: "/opt/codex", cwd: "/work" }),
    ]);
    expect(constructed[0]?.configOverrides).toEqual([
      "mcp_servers.web-srv.enabled=false",
      "mcp_servers.docs_api.enabled=false",
      "mcp_servers.own.enabled=false",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 0 });
  });

  test("a failed listing refuses the SDK run before a client is built", async () => {
    let constructed = 0;
    class FakeCodex {
      constructor() {
        constructed++;
      }
    }
    const events = await collect(
      new CodexSdkDriver({
        Codex: FakeCodex as never,
        listMcpServers: async () => {
          throw new Error("exit 1");
        },
      }).run(request(NO_NETWORK)),
    );
    expect(constructed).toBe(0);
    expect(events.find((event) => event.type === "error")).toMatchObject({
      code: EXTERNAL_AGENT_NETWORK_UNENFORCEABLE,
    });
    expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 1 });
  });

  test("the SDK adds no overrides when the network is allowed", async () => {
    const constructed: Array<Record<string, unknown>> = [];
    let listed = 0;
    class FakeCodex {
      constructor(options: Record<string, unknown>) {
        constructed.push(options);
      }
      startThread() {
        return {
          runStreamed: async () => ({
            events: (async function* () {
              yield { type: "turn.completed" };
            })(),
          }),
        };
      }
      resumeThread() {
        return this.startThread();
      }
    }
    await collect(
      new CodexSdkDriver({
        Codex: FakeCodex as never,
        listMcpServers: async () => {
          listed++;
          return ["x"];
        },
      }).run(request({ mode: "workspace-write", allowNetwork: true })),
    );
    expect(listed).toBe(0);
    expect(constructed[0]?.configOverrides).toBeUndefined();
  });
});

describe("parseCodexMcpList", () => {
  test("reads the names of a JSON array", () => {
    expect(parseCodexMcpList(HOST_SERVERS)).toEqual(["web-srv", "docs_api"]);
    expect(parseCodexMcpList("[]\n")).toEqual([]);
  });

  test("rejects anything else", () => {
    expect(() => parseCodexMcpList("")).toThrow();
    expect(() => parseCodexMcpList('{"servers":[]}')).toThrow();
    expect(() => parseCodexMcpList('[{"enabled":true}]')).toThrow();
  });
});

describe("Gemini CLI under allowNetwork: false", () => {
  for (const mode of [
    "read-only",
    "ask",
    "workspace-write",
    "full-access",
  ] as const) {
    test(`is refused in ${mode} mode`, async () => {
      const { spawn, state } = countingSpawn();
      const events = await collect(
        new GeminiCliDriver({ spawn: spawn as GeminiCliSpawn }).run(
          request({ mode, allowNetwork: false }, GEMINI_CLI_PROVIDER),
        ),
      );
      expect(state.spawned).toBe(0);
      expect(events.map((event) => event.type)).toEqual([
        "started",
        "error",
        "completed",
      ]);
      expect(events[1]).toMatchObject({
        code: EXTERNAL_AGENT_NETWORK_UNENFORCEABLE,
        recoverable: false,
      });
      expect(events[2]).toMatchObject({ exitCode: 1 });
    });
  }

  test("runs with allowUnenforcedNetwork", async () => {
    for (const mode of ["workspace-write", "full-access"] as const) {
      const { spawn, state } = countingSpawn();
      await collect(
        new GeminiCliDriver({
          spawn: spawn as GeminiCliSpawn,
          allowUnenforcedNetwork: true,
        }).run(request({ mode, allowNetwork: false }, GEMINI_CLI_PROVIDER)),
      );
      expect(state.spawned).toBe(1);
    }
  });

  test("runs when the network is allowed", async () => {
    for (const permissions of [
      { mode: "workspace-write" as const, allowNetwork: true },
      { mode: "full-access" as const, allowNetwork: true },
    ]) {
      const { spawn, state } = countingSpawn();
      await collect(
        new GeminiCliDriver({ spawn: spawn as GeminiCliSpawn }).run(
          request(permissions, GEMINI_CLI_PROVIDER),
        ),
      );
      expect(state.spawned).toBe(1);
    }
  });
});

describe("Codex SDK with a prebuilt client under allowNetwork: false", () => {
  function prebuilt() {
    const state = { started: 0 };
    const sdk = {
      startThread: () => {
        state.started++;
        return {
          runStreamed: async () => ({
            events: (async function* () {
              yield { type: "turn.completed" };
            })(),
          }),
        };
      },
      resumeThread: () => {
        throw new Error("not used");
      },
    };
    return { sdk, state };
  }

  test("is refused: its host MCP servers cannot be turned off", async () => {
    const { sdk, state } = prebuilt();
    const events = await collect(
      new CodexSdkDriver({ sdk }).run(request(NO_NETWORK)),
    );
    expect(state.started).toBe(0);
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "error",
      "completed",
    ]);
    expect(events[1]).toMatchObject({
      code: EXTERNAL_AGENT_NETWORK_UNENFORCEABLE,
      recoverable: false,
    });
    expect((events[1] as { message: string }).message).toContain(
      "prebuilt sdk client",
    );
  });

  test("runs with allowUnenforcedNetwork, or when the network is allowed", async () => {
    for (const [config, permissions] of [
      [{ allowUnenforcedNetwork: true }, NO_NETWORK],
      [{}, { mode: "workspace-write" as const, allowNetwork: true }],
    ] as const) {
      const { sdk, state } = prebuilt();
      const events = await collect(
        new CodexSdkDriver({ sdk, ...config }).run(request(permissions)),
      );
      expect(state.started).toBe(1);
      expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 0 });
    }
  });
});

const PLATFORM_PACKAGES: Record<string, [string, string]> = {
  "darwin:arm64": ["codex-darwin-arm64", "aarch64-apple-darwin"],
  "darwin:x64": ["codex-darwin-x64", "x86_64-apple-darwin"],
  "linux:arm64": ["codex-linux-arm64", "aarch64-unknown-linux-musl"],
  "linux:x64": ["codex-linux-x64", "x86_64-unknown-linux-musl"],
};
const PLATFORM = PLATFORM_PACKAGES[`${process.platform}:${process.arch}`];

describe.if(PLATFORM !== undefined)(
  "Codex SDK finds the npm-installed binary like the SDK does",
  () => {
    /**
     * A host project with `@openai/codex` and its platform package, `bin/`
     * layout. Unless `asWorkspace`, the process runs from it until `cleanup`.
     */
    function npmTree({ asWorkspace = false } = {}) {
      const [platformPackage, triple] = PLATFORM as [string, string];
      const root = mkdtempSync(join(tmpdir(), "codex-npm-tree-"));
      const scope = join(root, "node_modules", "@openai");
      mkdirSync(join(scope, "codex"), { recursive: true });
      writeFileSync(
        join(scope, "codex", "package.json"),
        JSON.stringify({ name: "@openai/codex", version: "0.167.0" }),
      );
      const pkg = join(scope, platformPackage);
      const vendor = join(pkg, "vendor", triple);
      mkdirSync(join(vendor, "bin"), { recursive: true });
      mkdirSync(join(vendor, "codex-path"), { recursive: true });
      writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({ name: `@openai/${platformPackage}` }),
      );
      writeFileSync(join(vendor, "codex-package.json"), "{}");
      const binary = join(vendor, "bin", "codex");
      writeFileSync(binary, "#!/bin/sh\nexit 0\n");
      chmodSync(binary, 0o755);
      const previous = process.cwd();
      if (!asWorkspace) process.chdir(root);
      return {
        root: realpathSync(root),
        binary: realpathSync(binary),
        pathDir: realpathSync(join(vendor, "codex-path")),
        cleanup: () => {
          process.chdir(previous);
          rmSync(root, { recursive: true, force: true });
        },
      };
    }

    test("resolves vendor/<triple>/bin/codex and its codex-path", () => {
      const tree = npmTree();
      try {
        const driver = new CodexSdkDriver({ env: { PATH: "/nonexistent" } });
        const resolution = driver.resolveCodexBinary(request(NO_NETWORK));
        expect(realpathSync(resolution.path ?? "")).toBe(tree.binary);
        expect(resolution.pathDirs?.map((dir) => realpathSync(dir))).toEqual([
          tree.pathDir,
        ]);
      } finally {
        tree.cleanup();
      }
    });

    test("an npm tree in the run's working directory is not used", () => {
      // The agent can write its working directory; a package it planted
      // there must not become the next run's binary.
      const tree = npmTree({ asWorkspace: true });
      try {
        const driver = new CodexSdkDriver({ env: { PATH: "/nonexistent" } });
        const resolution = driver.resolveCodexBinary({
          ...request(NO_NETWORK),
          workingDirectory: tree.root,
        });
        expect(resolution.path).not.toBe(tree.binary);
        expect(
          resolution.checked.some((path) => path.startsWith(tree.root)),
        ).toBe(false);
      } finally {
        tree.cleanup();
      }
    });

    test("the listing and the client get that binary and PATH", async () => {
      const tree = npmTree();
      try {
        const listed: Array<{ command: string; env: Record<string, string> }> =
          [];
        const constructed: Array<Record<string, unknown>> = [];
        class FakeCodex {
          constructor(options: Record<string, unknown>) {
            constructed.push(options);
          }
          startThread() {
            return {
              runStreamed: async () => ({
                events: (async function* () {
                  yield { type: "turn.completed" };
                })(),
              }),
            };
          }
          resumeThread() {
            return this.startThread();
          }
        }
        await collect(
          new CodexSdkDriver({
            Codex: FakeCodex as never,
            env: { PATH: "/usr/bin" },
            listMcpServers: async (options) => {
              listed.push(options);
              return [];
            },
          }).run(request(NO_NETWORK)),
        );
        expect(realpathSync(listed[0]?.command ?? "")).toBe(tree.binary);
        const listingPath = (listed[0]?.env.PATH ?? "").split(":");
        expect(realpathSync(listingPath[0] ?? "")).toBe(tree.pathDir);
        expect(listingPath).toContain("/usr/bin");
        expect(constructed[0]?.codexPathOverride).toBe(listed[0]?.command);
        expect(
          (constructed[0]?.env as Record<string, string> | undefined)?.PATH,
        ).toBe(listed[0]?.env.PATH);
      } finally {
        tree.cleanup();
      }
    });
  },
);
