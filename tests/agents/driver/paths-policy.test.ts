import { describe, expect, test } from "bun:test";
import { ClaudeAgentSdkDriver } from "../../../src/agents/driver/claude-agent-sdk.js";
import {
  ClaudeCliDriver,
  type ClaudeCliSpawn,
} from "../../../src/agents/driver/claude-cli.js";
import {
  CodexCliDriver,
  type CodexCliSpawn,
} from "../../../src/agents/driver/codex-cli.js";
import { CodexSdkDriver } from "../../../src/agents/driver/codex-sdk.js";
import {
  GeminiCliDriver,
  type GeminiCliSpawn,
} from "../../../src/agents/driver/gemini-cli.js";
import { EXTERNAL_AGENT_PATHS_UNENFORCEABLE } from "../../../src/agents/driver/policy-errors.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import type { ExternalAgentRunRequest } from "../../../src/agents/external-agent-driver.js";
import { EXTERNAL_AGENT_PATHS_UNENFORCEABLE as PUBLIC_CODE } from "../../../src/agents/index.js";
import type { ExternalAgentPermissionPolicy } from "../../../src/agents/permissions/schema.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/claude.js";
import { CODEX_PROVIDER } from "../../../src/agents/provider/codex.js";
import { GEMINI_CLI_PROVIDER } from "../../../src/agents/provider/gemini-cli.js";

function request(
  permissions: ExternalAgentPermissionPolicy,
  provider = CODEX_PROVIDER,
  extra: Partial<ExternalAgentRunRequest> = {},
): ExternalAgentRunRequest {
  return {
    provider,
    context: { input: "hi" } as never,
    instruction: "do it",
    permissions,
    ...extra,
  };
}

async function collect(
  run: AsyncIterable<ExternalAgentEvent>,
): Promise<ExternalAgentEvent[]> {
  const events: ExternalAgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

function countingSpawn() {
  const state = { spawned: 0 };
  const spawn = (_command: string, args: readonly string[]) => {
    if (!(args[0] === "mcp" && args[1] === "list")) state.spawned++;
    return {
      stdout: (async function* () {
        if (args[0] === "mcp") yield "[]";
      })(),
      stderr: null,
      exited: Promise.resolve(0),
    };
  };
  return { spawn, state };
}

const WITH_PATHS: ExternalAgentPermissionPolicy = {
  mode: "workspace-write",
  allowNetwork: true,
  allowedPaths: ["/repo"],
};
const WITH_BOUNDS: ExternalAgentPermissionPolicy = {
  mode: "workspace-write",
  allowNetwork: true,
  pathBounds: [["/repo"]],
};

function expectRefused(events: ExternalAgentEvent[]): void {
  expect(events.map((event) => event.type)).toEqual([
    "started",
    "error",
    "completed",
  ]);
  expect(events[1]).toMatchObject({
    code: EXTERNAL_AGENT_PATHS_UNENFORCEABLE,
    recoverable: false,
    message: expect.stringContaining("allowUnenforcedPaths"),
  });
  expect(events[2]).toMatchObject({ exitCode: 1 });
}

describe("drivers that never ask the bridge refuse allowedPaths", () => {
  test("the code is exported", () => {
    expect(PUBLIC_CODE).toBe("EXTERNAL_AGENT_PATHS_UNENFORCEABLE");
  });

  for (const permissions of [WITH_PATHS, WITH_BOUNDS]) {
    const label = permissions.allowedPaths ? "allowedPaths" : "pathBounds";

    test(`Codex CLI does not spawn (${label})`, async () => {
      const { spawn, state } = countingSpawn();
      const events = await collect(
        new CodexCliDriver({ spawn: spawn as CodexCliSpawn }).run(
          request(permissions),
        ),
      );
      expect(state.spawned).toBe(0);
      expectRefused(events);
    });

    test(`Codex SDK does not start a thread (${label})`, async () => {
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
        new CodexSdkDriver({ sdk }).run(request(permissions)),
      );
      expect(started).toBe(0);
      expectRefused(events);
    });

    test(`Gemini CLI does not spawn (${label})`, async () => {
      const { spawn, state } = countingSpawn();
      const events = await collect(
        new GeminiCliDriver({ spawn: spawn as GeminiCliSpawn }).run(
          request(permissions, GEMINI_CLI_PROVIDER),
        ),
      );
      expect(state.spawned).toBe(0);
      expectRefused(events);
    });

    test(`Claude CLI does not spawn (${label})`, async () => {
      const { spawn, state } = countingSpawn();
      const events = await collect(
        new ClaudeCliDriver({ spawn: spawn as ClaudeCliSpawn, env: {} }).run(
          request(permissions, CLAUDE_PROVIDER),
        ),
      );
      expect(state.spawned).toBe(0);
      expectRefused(events);
    });
  }

  test("allowUnenforcedPaths lets each driver run", async () => {
    const codexCli = countingSpawn();
    await collect(
      new CodexCliDriver({
        spawn: codexCli.spawn as CodexCliSpawn,
        allowUnenforcedPaths: true,
      }).run(request(WITH_PATHS)),
    );
    expect(codexCli.state.spawned).toBe(1);

    const gemini = countingSpawn();
    await collect(
      new GeminiCliDriver({
        spawn: gemini.spawn as GeminiCliSpawn,
        allowUnenforcedPaths: true,
      }).run(request(WITH_PATHS, GEMINI_CLI_PROVIDER)),
    );
    expect(gemini.state.spawned).toBe(1);

    const claude = countingSpawn();
    await collect(
      new ClaudeCliDriver({
        spawn: claude.spawn as ClaudeCliSpawn,
        env: {},
        allowUnenforcedPaths: true,
      }).run(request(WITH_PATHS, CLAUDE_PROVIDER)),
    );
    expect(claude.state.spawned).toBe(1);

    let started = 0;
    const sdk = {
      startThread: () => {
        started++;
        return {
          id: "t",
          runStreamed: async () => ({ events: (async function* () {})() }),
        };
      },
      resumeThread: () => {
        throw new Error("should not resume");
      },
    };
    await collect(
      new CodexSdkDriver({ sdk: sdk as never, allowUnenforcedPaths: true }).run(
        request(WITH_PATHS),
      ),
    );
    expect(started).toBe(1);
  });

  test("a policy without paths is not refused", async () => {
    const { spawn, state } = countingSpawn();
    await collect(
      new CodexCliDriver({ spawn: spawn as CodexCliSpawn }).run(
        request({ mode: "workspace-write", allowNetwork: true }),
      ),
    );
    expect(state.spawned).toBe(1);
  });
});

/** File tools without a shell, so the shell-confinement refusal stays out of these tests. */
const FILE_TOOLS = ["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"];

type HookFn = (
  input: Record<string, unknown>,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<Record<string, unknown>>;

/** A fake Claude Agent SDK that records the query options. */
function recordingSdk() {
  const state: { options?: Record<string, unknown> } = {};
  const sdk = {
    query: (input: { options: Record<string, unknown> }) => {
      state.options = input.options;
      return (async function* () {
        yield { type: "result", subtype: "success", result: "done" };
      })();
    },
    tool: (name: string) => ({ name }),
    createSdkMcpServer: (config: Record<string, unknown>) => config,
  };
  return { sdk, state };
}

function preToolUseHooks(options: Record<string, unknown> | undefined) {
  const matchers =
    (options?.hooks as { PreToolUse?: Array<{ hooks: HookFn[] }> } | undefined)
      ?.PreToolUse ?? [];
  return matchers.flatMap((matcher) => matcher.hooks);
}

/** Runs every PreToolUse hook; the first deny wins. */
async function decide(
  hooks: HookFn[],
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<string | undefined> {
  for (const hook of hooks) {
    const output = (await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: toolName,
        tool_input: toolInput,
      },
      "tu",
      { signal: new AbortController().signal },
    )) as { hookSpecificOutput?: { permissionDecision?: string } };
    if (output.hookSpecificOutput?.permissionDecision === "deny") {
      return "deny";
    }
  }
  return undefined;
}

describe("Claude Agent SDK checks paths on every tool call", () => {
  for (const mode of ["workspace-write", "full-access"] as const) {
    test(`a PreToolUse hook denies paths outside allowedPaths (${mode})`, async () => {
      const { sdk, state } = recordingSdk();
      await collect(
        new ClaudeAgentSdkDriver({ sdk: sdk as never, tools: FILE_TOOLS }).run(
          request(
            { mode, allowNetwork: true, allowedPaths: ["/repo/src"] },
            CLAUDE_PROVIDER,
            { workingDirectory: "/repo" },
          ),
        ),
      );
      const hooks = preToolUseHooks(state.options);
      // Inside the working directory but outside allowedPaths: Claude Code
      // would accept this edit without asking.
      expect(
        await decide(hooks, "Edit", { file_path: "/repo/package.json" }),
      ).toBe("deny");
      expect(await decide(hooks, "Write", { file_path: "/etc/x" })).toBe(
        "deny",
      );
      expect(await decide(hooks, "Read", { file_path: "../secret" })).toBe(
        "deny",
      );
      expect(
        await decide(hooks, "Edit", { file_path: "/repo/src/a.ts" }),
      ).toBeUndefined();
      expect(
        await decide(hooks, "Read", { file_path: "/repo/src/b.ts" }),
      ).toBeUndefined();
    });
  }

  test("inherited pathBounds are checked too", async () => {
    const { sdk, state } = recordingSdk();
    await collect(
      new ClaudeAgentSdkDriver({ sdk: sdk as never, tools: FILE_TOOLS }).run(
        request(
          { mode: "workspace-write", allowNetwork: true, pathBounds: [["/a"]] },
          CLAUDE_PROVIDER,
          { workingDirectory: "/a" },
        ),
      ),
    );
    const hooks = preToolUseHooks(state.options);
    expect(await decide(hooks, "Write", { file_path: "/b/x" })).toBe("deny");
    expect(await decide(hooks, "Write", { file_path: "/a/x" })).toBeUndefined();
  });

  test("the bridge's own tools are left to the bridge", async () => {
    const { sdk, state } = recordingSdk();
    // inheritHostConfig turns the isolation hook off, so only the path hook
    // decides here.
    await collect(
      new ClaudeAgentSdkDriver({
        sdk: sdk as never,
        inheritHostConfig: true,
        tools: FILE_TOOLS,
      }).run(
        request(
          {
            mode: "workspace-write",
            allowNetwork: true,
            allowedPaths: ["/repo"],
          },
          CLAUDE_PROVIDER,
          {
            workingDirectory: "/repo",
            adkTools: {
              declarations: [
                {
                  name: "lookup",
                  description: "Look up",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
              has: () => true,
              execute: async () => {
                throw new Error("not called");
              },
            } as never,
          },
        ),
      ),
    );
    const hooks = preToolUseHooks(state.options);
    expect(
      await decide(hooks, "mcp__adk_bridge__lookup", { path: "/api/v1" }),
    ).toBeUndefined();
    expect(
      await decide(hooks, "mcp__adk_bridge__x__lookup", { path: "/api/v1" }),
    ).toBe("deny");
  });

  test("no path hook without allowedPaths or pathBounds", async () => {
    const { sdk, state } = recordingSdk();
    await collect(
      new ClaudeAgentSdkDriver({
        sdk: sdk as never,
        inheritHostConfig: true,
        tools: FILE_TOOLS,
      }).run(
        request(
          { mode: "workspace-write", allowNetwork: true },
          CLAUDE_PROVIDER,
          {
            workingDirectory: "/repo",
          },
        ),
      ),
    );
    expect(preToolUseHooks(state.options)).toEqual([]);
  });
});
