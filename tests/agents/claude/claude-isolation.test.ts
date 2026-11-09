import { describe, expect, test } from "bun:test";
import { InputValidationError } from "@google/adk";
import { ClaudeAgentSdkDriver } from "../../../src/agents/driver/claude-agent-sdk.js";
import {
  ClaudeCliDriver,
  type ClaudeCliSpawn,
} from "../../../src/agents/driver/claude-cli.js";
import {
  assertClaudeInitIsolated,
  CLAUDE_NO_NETWORK_SANDBOX,
  claudeCliIsolationArgs,
  DEFAULT_CLAUDE_TOOLS,
  findIsolationViolations,
  findToolUseViolations,
  isExpectedClaudeTool,
  planClaudeIsolation,
} from "../../../src/agents/driver/claude-isolation.js";
import {
  EXTERNAL_AGENT_ISOLATION_VIOLATED,
  ExternalAgentPolicyError,
} from "../../../src/agents/driver/policy-errors.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import type { ExternalAgentRunRequest } from "../../../src/agents/external-agent-driver.js";
import type { ExternalAgentPermissionPolicy } from "../../../src/agents/permissions/schema.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/schema.js";

const ISOLATED = { inheritHostConfig: false, allowUnsandboxedShell: false };

function request(
  permissions?: ExternalAgentPermissionPolicy,
  extra: Partial<ExternalAgentRunRequest> = {},
): ExternalAgentRunRequest {
  return {
    provider: CLAUDE_PROVIDER,
    context: { input: "hi" } as never,
    workingDirectory: "/repo",
    ...(permissions ? { permissions } : {}),
    ...extra,
  };
}

function init(tools: string[], mcpServers: string[] = []) {
  return {
    type: "system",
    subtype: "init",
    model: "claude-haiku-5-5",
    session_id: "s-1",
    tools,
    mcp_servers: mcpServers.map((name) => ({ name, status: "connected" })),
  };
}

const RESULT = { type: "result", subtype: "success", result: "done" };

async function collect(
  run: AsyncIterable<ExternalAgentEvent>,
): Promise<ExternalAgentEvent[]> {
  const events: ExternalAgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

describe("planClaudeIsolation", () => {
  test("isolated by default with the default tool list and no sandbox", () => {
    const plan = planClaudeIsolation(
      { mode: "ask", allowNetwork: true },
      ISOLATED,
    );
    expect(plan.isolated).toBe(true);
    expect(plan.tools).toEqual([...DEFAULT_CLAUDE_TOOLS]);
    expect(plan.sandbox).toBeUndefined();
    expect(plan.networkSandbox).toBeUndefined();
  });

  test("allowNetwork: false removes the web tools and sandboxes Bash", () => {
    const plan = planClaudeIsolation(
      { mode: "workspace-write", allowNetwork: false },
      ISOLATED,
    );
    expect(plan.tools).not.toContain("WebFetch");
    expect(plan.tools).not.toContain("WebSearch");
    expect(plan.tools).toContain("Bash");
    expect(plan.disallowedTools).toEqual(["WebFetch", "WebSearch"]);
    expect(plan.sandbox).toEqual(CLAUDE_NO_NETWORK_SANDBOX);
    expect(plan.networkSandbox).toBe("enforced");
  });

  test("the sandbox denies every host and has no unsandboxed escape", () => {
    expect(CLAUDE_NO_NETWORK_SANDBOX).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      network: { allowedDomains: [], strictAllowlist: true },
    });
  });

  test("allowUnsandboxedShell waives the sandbox and says so", () => {
    const plan = planClaudeIsolation(
      { mode: "ask", allowNetwork: false },
      { ...ISOLATED, allowUnsandboxedShell: true },
    );
    expect(plan.sandbox).toBeUndefined();
    expect(plan.networkSandbox).toBe("waived");
  });

  test("no sandbox when no shell tool is offered", () => {
    expect(
      planClaudeIsolation(
        { mode: "ask", allowNetwork: false },
        { ...ISOLATED, tools: ["Read", "Grep"] },
      ).sandbox,
    ).toBeUndefined();
    // Read-only removes Bash.
    expect(
      planClaudeIsolation({ mode: "read-only", allowNetwork: false }, ISOLATED)
        .sandbox,
    ).toBeUndefined();
  });

  test("inheritHostConfig keeps the runtime tool default but still sandboxes", () => {
    const plan = planClaudeIsolation(
      { mode: "ask", allowNetwork: false },
      { ...ISOLATED, inheritHostConfig: true },
    );
    expect(plan.isolated).toBe(false);
    expect(plan.tools).toBeUndefined();
    expect(plan.sandbox).toEqual(CLAUDE_NO_NETWORK_SANDBOX);
  });

  test("allowNetwork unset behaves as false", () => {
    const plan = planClaudeIsolation({ mode: "ask" }, ISOLATED);
    expect(plan.tools).not.toContain("WebFetch");
    expect(plan.sandbox).toEqual(CLAUDE_NO_NETWORK_SANDBOX);
    expect(plan.networkSandbox).toBe("enforced");
  });
});

describe("ClaudeCliDriver isolation flags", () => {
  test("inheritHostConfig passes no isolation flags", () => {
    const args = new ClaudeCliDriver({ inheritHostConfig: true }).buildArgs(
      // With network on; without it the no-network sandbox is still passed.
      request({ mode: "ask", allowNetwork: true }),
    );
    expect(args.some((arg) => arg.startsWith("--tools"))).toBe(false);
    expect(args).not.toContain("--strict-mcp-config");
    expect(args).not.toContain("--disable-slash-commands");
    expect(args.some((arg) => arg.startsWith("--settings"))).toBe(false);
  });

  test("an empty tool list disables every built-in tool", () => {
    const args = new ClaudeCliDriver({ tools: [] }).buildArgs(
      request({ mode: "ask" }),
    );
    expect(args).toContain("--tools=");
  });

  test("read-only pins the read tools and lists the removed ones", () => {
    const args = new ClaudeCliDriver().buildArgs(
      request({ mode: "read-only" }),
    );
    expect(args).toContain("--tools=Read,Glob,Grep,TodoWrite");
    expect(args).toContain(
      "--disallowedTools=Edit,Write,MultiEdit,NotebookEdit,Bash,PowerShell,WebFetch,WebSearch",
    );
  });

  test("allowNetwork: false puts the no-network sandbox in --settings", () => {
    const args = new ClaudeCliDriver().buildArgs(
      request({ mode: "workspace-write", allowNetwork: false }),
    );
    const settings = args.find((arg) => arg.startsWith("--settings="));
    expect(settings).toBeDefined();
    expect(JSON.parse(settings?.slice("--settings=".length) ?? "{}")).toEqual({
      disableClaudeAiConnectors: true,
      permissions: { deny: ["mcp__*"] },
      sandbox: CLAUDE_NO_NETWORK_SANDBOX,
    });
  });

  test("user args still come last", () => {
    const args = new ClaudeCliDriver({ args: ["--model", "x"] }).buildArgs(
      request({ mode: "ask" }),
    );
    expect(args.slice(-2)).toEqual(["--model", "x"]);
  });

  test("claudeCliIsolationArgs uses the --flag=value form only", () => {
    const args = claudeCliIsolationArgs(
      planClaudeIsolation({ mode: "ask", allowNetwork: false }, ISOLATED),
    );
    for (const arg of args) {
      expect(arg.startsWith("--")).toBe(true);
    }
  });
});

describe("ClaudeAgentSdkDriver isolation options", () => {
  test("allowNetwork: false passes the no-network sandbox", () => {
    const options = new ClaudeAgentSdkDriver().buildOptions(
      request({ mode: "workspace-write", allowNetwork: false }),
    ) as Record<string, unknown>;
    expect(options.sandbox).toEqual(CLAUDE_NO_NETWORK_SANDBOX);
    expect(options.strictMcpConfig).toBe(true);
  });

  test("allowUnsandboxedShell passes no sandbox", () => {
    const options = new ClaudeAgentSdkDriver({
      allowUnsandboxedShell: true,
    }).buildOptions(
      request({ mode: "workspace-write", allowNetwork: false }),
    ) as Record<string, unknown>;
    expect(options.sandbox).toBeUndefined();
  });

  test("the sandbox passed to the SDK is a mutable copy", () => {
    const options = new ClaudeAgentSdkDriver().buildOptions(
      request({ mode: "workspace-write", allowNetwork: false }),
    ) as Record<string, unknown>;
    expect(options.sandbox).not.toBe(CLAUDE_NO_NETWORK_SANDBOX);
    expect(Object.isFrozen(options.sandbox)).toBe(false);
  });

  test("permission prompts tell the guard Bash is sandboxed", async () => {
    const seen: Record<string, unknown>[] = [];
    const options = new ClaudeAgentSdkDriver().buildOptions(
      request(
        { mode: "ask", allowNetwork: false },
        {
          requestPermission: async (req) => {
            seen.push(req as never);
            return { behavior: "allow" };
          },
        },
      ),
    ) as {
      canUseTool?: (
        name: string,
        input: Record<string, unknown>,
        extra: Record<string, unknown>,
      ) => Promise<unknown>;
    };
    await options.canUseTool?.("Bash", { command: "ls" }, { toolUseID: "t" });
    expect(seen[0]?.networkSandbox).toBe("enforced");
  });
});

describe("init isolation check", () => {
  const expected = { tools: ["Read", "Grep", "TodoWrite"], mcpServers: [] };

  test("ignores messages other than system/init", () => {
    expect(findIsolationViolations(RESULT, expected)).toBeUndefined();
  });

  test("a missing expected tool is not a violation", () => {
    expect(findIsolationViolations(init(["Read"]), expected)).toEqual({
      tools: [],
      mcpServers: [],
    });
  });

  test("an extra host tool or connector server is a violation", () => {
    expect(
      findIsolationViolations(
        init(["Read", "CronCreate"], ["claude_ai_Gmail"]),
        expected,
      ),
    ).toEqual({ tools: ["CronCreate"], mcpServers: ["claude_ai_Gmail"] });
  });

  test("bridge tools are expected only with the bridge server", () => {
    const bridgeTool = "mcp__adk_bridge__lookup";
    expect(
      findIsolationViolations(init([bridgeTool], ["adk_bridge"]), {
        tools: [],
        mcpServers: ["adk_bridge"],
      }),
    ).toEqual({ tools: [], mcpServers: [] });
    expect(
      findIsolationViolations(init([bridgeTool]), { tools: [], mcpServers: [] })
        ?.tools,
    ).toEqual([bridgeTool]);
  });

  test("throws a typed non-recoverable error naming what leaked", () => {
    let caught: unknown;
    try {
      assertClaudeInitIsolated(
        init(["Read", "ToolSearch"]),
        expected,
        "Claude CLI",
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExternalAgentPolicyError);
    expect((caught as ExternalAgentPolicyError).code).toBe(
      EXTERNAL_AGENT_ISOLATION_VIOLATED,
    );
    expect((caught as ExternalAgentPolicyError).recoverable).toBe(false);
    expect((caught as Error).message).toContain("ToolSearch");
  });
});

function fakeSdk(messages: Record<string, unknown>[]) {
  const state = { interrupted: 0, read: 0 };
  const sdk = {
    query: () => {
      const generator = (async function* () {
        for (const message of messages) {
          state.read++;
          yield message;
        }
      })();
      return Object.assign(generator, {
        interrupt: async () => {
          state.interrupted++;
        },
      });
    },
    tool: (name: string) => ({ name }),
    createSdkMcpServer: (config: Record<string, unknown>) => config,
  };
  return { sdk, state };
}

describe("ClaudeAgentSdkDriver stops a run that is not isolated", () => {
  test("an extra tool in init ends the run with the isolation error", async () => {
    const { sdk, state } = fakeSdk([
      init(["Read", "Glob", "CronCreate"]),
      RESULT,
    ]);
    const events = await collect(
      new ClaudeAgentSdkDriver({ sdk }).run(request({ mode: "ask" })),
    );
    const error = events.find((event) => event.type === "error");
    expect(error).toMatchObject({
      code: EXTERNAL_AGENT_ISOLATION_VIOLATED,
      recoverable: false,
    });
    expect(events.some((event) => event.type === "output")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 1 });
    expect(state.read).toBe(1);
    expect(state.interrupted).toBe(1);
  });

  test("a connector MCP server in init ends the run", async () => {
    const { sdk } = fakeSdk([init(["Read"], ["claude_ai_Drive"]), RESULT]);
    const events = await collect(
      new ClaudeAgentSdkDriver({ sdk }).run(request({ mode: "ask" })),
    );
    expect(events.find((event) => event.type === "error")).toMatchObject({
      code: EXTERNAL_AGENT_ISOLATION_VIOLATED,
    });
  });

  test("the bridge server and its tools are allowed", async () => {
    const { sdk } = fakeSdk([
      init(["Read", "mcp__adk_bridge__lookup"], ["adk_bridge"]),
      RESULT,
    ]);
    const events = await collect(
      new ClaudeAgentSdkDriver({ sdk }).run(
        request(
          { mode: "ask" },
          {
            adkTools: {
              declarations: [
                {
                  name: "lookup",
                  description: "Look up",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
              execute: async () => {
                throw new Error("not called");
              },
            } as never,
          },
        ),
      ),
    );
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.find((event) => event.type === "output")).toMatchObject({
      content: "done",
    });
  });

  test("inheritHostConfig turns the check off", async () => {
    const { sdk } = fakeSdk([init(["Read", "CronCreate"], ["host"]), RESULT]);
    const events = await collect(
      new ClaudeAgentSdkDriver({ sdk, inheritHostConfig: true }).run(
        request({ mode: "ask" }),
      ),
    );
    expect(events.some((event) => event.type === "error")).toBe(false);
  });
});

/** `exits: false` models a CLI that keeps running until it is killed. */
function cliSpawn(lines: unknown[], exits = true) {
  const state = { kills: [] as Array<string | undefined> };
  const spawn: ClaudeCliSpawn = () => ({
    stdout: [`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`],
    stderr: [],
    exited: exits ? Promise.resolve(0) : new Promise<number>(() => undefined),
    kill: (signal) => {
      state.kills.push(signal);
    },
  });
  return { spawn, state };
}

describe("ClaudeCliDriver stops a run that is not isolated", () => {
  test("an extra tool in init ends the run and kills the process", async () => {
    const { spawn, state } = cliSpawn(
      [
        init(["Read", "Workflow"]),
        { type: "assistant", message: { content: [{ text: "leak" }] } },
      ],
      false,
    );
    const events = await collect(
      new ClaudeCliDriver({ spawn, killGraceMs: 0 }).run(
        request({ mode: "ask" }),
      ),
    );
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "error",
      "completed",
    ]);
    expect(events[1]).toMatchObject({
      code: EXTERNAL_AGENT_ISOLATION_VIOLATED,
      recoverable: false,
    });
    expect(events[2]).toMatchObject({ exitCode: 1 });
    expect(state.kills[0]).toBe("SIGTERM");
  });

  test("an isolated init passes", async () => {
    const { spawn } = cliSpawn([init(["Read", "Bash"]), RESULT]);
    const events = await collect(
      new ClaudeCliDriver({ spawn, killGraceMs: 0 }).run(
        request({ mode: "ask" }),
      ),
    );
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.find((event) => event.type === "output")).toMatchObject({
      content: "done",
    });
  });

  test("inheritHostConfig turns the check off", async () => {
    const { spawn } = cliSpawn([init(["Read", "Workflow"]), RESULT]);
    const events = await collect(
      new ClaudeCliDriver({
        spawn,
        inheritHostConfig: true,
        killGraceMs: 0,
      }).run(request({ mode: "ask" })),
    );
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  test("a non-JSON stdout line is skipped, not thrown", async () => {
    const spawn: ClaudeCliSpawn = () => ({
      stdout: [`not json\n${JSON.stringify(RESULT)}\n`],
      stderr: [],
      exited: Promise.resolve(0),
    });
    const events = await collect(
      new ClaudeCliDriver({ spawn }).run(request({ mode: "ask" })),
    );
    expect(events.find((event) => event.type === "output")).toMatchObject({
      content: "done",
    });
    expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 0 });
  });
});

function toolUse(name: string, id = "tu-1") {
  return {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id, name, input: {} }],
    },
  };
}

describe("every expected MCP server's tools are expected", () => {
  const expected = { tools: ["Read"], mcpServers: ["adk_bridge", "workflow"] };

  test("in init", () => {
    expect(
      findIsolationViolations(
        init(
          ["Read", "mcp__workflow__start", "mcp__adk_bridge__x"],
          ["adk_bridge", "workflow"],
        ),
        expected,
      ),
    ).toEqual({ tools: [], mcpServers: [] });
  });

  test("a tool of a server that is not expected is a violation", () => {
    expect(
      findIsolationViolations(init(["mcp__other__run"], ["adk_bridge"]), {
        tools: [],
        mcpServers: ["adk_bridge"],
      })?.tools,
    ).toEqual(["mcp__other__run"]);
  });

  test("a server name with characters Claude Code rewrites still matches", () => {
    expect(
      isExpectedClaudeTool("mcp__my_server__go", {
        tools: [],
        mcpServers: ["my.server"],
      }),
    ).toBe(true);
    expect(
      isExpectedClaudeTool("mcp__workflow_extra__go", {
        tools: [],
        mcpServers: ["workflow"],
      }),
    ).toBe(false);
  });
});

describe("requiredMcpServers needs inheritHostConfig", () => {
  test("an isolated driver with a required host server throws at construction", () => {
    expect(
      () => new ClaudeAgentSdkDriver({ requiredMcpServers: ["workflow"] }),
    ).toThrow(InputValidationError);
    expect(
      () => new ClaudeAgentSdkDriver({ requiredMcpServers: ["workflow"] }),
    ).toThrow(/inheritHostConfig: true/);
  });

  test("the bridge server alone, or inheritHostConfig, is accepted", () => {
    expect(
      () => new ClaudeAgentSdkDriver({ requiredMcpServers: ["adk_bridge"] }),
    ).not.toThrow();
    expect(
      () =>
        new ClaudeAgentSdkDriver({
          requiredMcpServers: ["workflow"],
          inheritHostConfig: true,
        }),
    ).not.toThrow();
  });
});

describe("tool_use isolation check", () => {
  const expected = { tools: ["Read"], mcpServers: ["adk_bridge"] };

  test("names tools outside the set and ignores other messages", () => {
    expect(findToolUseViolations(toolUse("Read"), expected)).toEqual([]);
    expect(
      findToolUseViolations(toolUse("mcp__adk_bridge__lookup"), expected),
    ).toEqual([]);
    expect(
      findToolUseViolations(toolUse("mcp__claude_ai_X__y"), expected),
    ).toEqual(["mcp__claude_ai_X__y"]);
    expect(findToolUseViolations(RESULT, expected)).toEqual([]);
    expect(findToolUseViolations(init(["CronCreate"]), expected)).toEqual([]);
  });

  test("Claude Agent SDK: a late connector tool_use stops the run", async () => {
    const { sdk, state } = fakeSdk([
      init(["Read"]),
      toolUse("mcp__claude_ai_X__y"),
      { type: "assistant", message: { content: [{ text: "leaked" }] } },
      RESULT,
    ]);
    const events = await collect(
      new ClaudeAgentSdkDriver({ sdk }).run(request({ mode: "ask" })),
    );
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "error",
      "completed",
    ]);
    expect(events[1]).toMatchObject({
      code: EXTERNAL_AGENT_ISOLATION_VIOLATED,
      recoverable: false,
    });
    expect((events[1] as { message: string }).message).toContain(
      "mcp__claude_ai_X__y",
    );
    expect(state.read).toBe(2);
    expect(state.interrupted).toBe(1);
  });

  test("Claude CLI: a late connector tool_use stops the run", async () => {
    const { spawn, state } = cliSpawn(
      [
        init(["Read"]),
        toolUse("mcp__claude_ai_X__y"),
        { type: "assistant", message: { content: [{ text: "leaked" }] } },
        RESULT,
      ],
      false,
    );
    const events = await collect(
      new ClaudeCliDriver({ spawn, killGraceMs: 0 }).run(
        request({ mode: "ask" }),
      ),
    );
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "error",
      "completed",
    ]);
    expect(events[1]).toMatchObject({
      code: EXTERNAL_AGENT_ISOLATION_VIOLATED,
    });
    expect(state.kills[0]).toBe("SIGTERM");
  });

  test("inheritHostConfig turns the tool_use check off", async () => {
    const { sdk } = fakeSdk([init(["Read"]), toolUse("mcp__host__x"), RESULT]);
    const events = await collect(
      new ClaudeAgentSdkDriver({ sdk, inheritHostConfig: true }).run(
        request({ mode: "ask" }),
      ),
    );
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  test("canUseTool denies a tool outside the set without asking the host", async () => {
    let options: Record<string, unknown> | undefined;
    const sdk = {
      query: (input: { options: Record<string, unknown> }) => {
        options = input.options;
        return (async function* () {
          yield RESULT;
        })();
      },
      tool: (name: string) => ({ name }),
      createSdkMcpServer: (config: Record<string, unknown>) => config,
    };
    const asked: string[] = [];
    await collect(
      new ClaudeAgentSdkDriver({ sdk: sdk as never }).run(
        request(
          { mode: "ask" },
          {
            requestPermission: async (permission) => {
              asked.push(permission.toolName);
              return { behavior: "allow" };
            },
          },
        ),
      ),
    );
    const canUseTool = options?.canUseTool as (
      name: string,
      input: Record<string, unknown>,
      extra: Record<string, unknown>,
    ) => Promise<{ behavior: string }>;
    expect(
      await canUseTool("mcp__claude_ai_X__y", {}, { signal: undefined }),
    ).toMatchObject({ behavior: "deny" });
    expect(asked).toEqual([]);
    expect(await canUseTool("Read", {}, { signal: undefined })).toMatchObject({
      behavior: "allow",
    });
    expect(asked).toEqual(["Read"]);
  });
});

type HookFn = (
  input: Record<string, unknown>,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<Record<string, unknown>>;

/** A fake SDK that records the options and, optionally, runs PreToolUse first. */
function hookSdk(toolsToTry: string[] = []) {
  const state: {
    options?: Record<string, unknown>;
    decisions: Array<Record<string, unknown>>;
  } = { decisions: [] };
  const sdk = {
    query: (input: { options: Record<string, unknown> }) => {
      state.options = input.options;
      const hooks = (
        input.options.hooks as
          | { PreToolUse?: Array<{ hooks: HookFn[] }> }
          | undefined
      )?.PreToolUse;
      return (async function* () {
        yield init(["Read"], ["adk_bridge"]);
        // The SDK runs the hook before the tool, whatever the stream shows.
        for (const toolName of toolsToTry) {
          for (const matcher of hooks ?? []) {
            for (const hook of matcher.hooks) {
              state.decisions.push(
                await hook(
                  { hook_event_name: "PreToolUse", tool_name: toolName },
                  "tu-1",
                  { signal: new AbortController().signal },
                ),
              );
            }
          }
        }
        yield { type: "assistant", message: { content: [{ text: "x" }] } };
        yield RESULT;
      })();
    },
    tool: (name: string) => ({ name }),
    createSdkMcpServer: (config: Record<string, unknown>) => config,
  };
  return { sdk, state };
}

const LOOKUP_TOOL = {
  adkTools: {
    declarations: [
      {
        name: "lookup",
        description: "Look up",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    execute: async () => {
      throw new Error("not called");
    },
  } as never,
};

function preToolUse(options: Record<string, unknown> | undefined): HookFn {
  const matchers = (
    options?.hooks as { PreToolUse?: Array<{ hooks: HookFn[] }> } | undefined
  )?.PreToolUse;
  const hook = matchers?.[0]?.hooks[0];
  if (!hook) throw new Error("no PreToolUse hook");
  return hook;
}

describe("isolated SDK runs block outside tools with a PreToolUse hook", () => {
  for (const mode of ["full-access", "ask"] as const) {
    test(`the hook denies a connector tool and allows the pinned and bridge tools (${mode})`, async () => {
      const { sdk, state } = hookSdk();
      await collect(
        new ClaudeAgentSdkDriver({ sdk: sdk as never }).run(
          request({ mode }, LOOKUP_TOOL),
        ),
      );
      const hook = preToolUse(state.options);
      const decide = (toolName: string) =>
        hook({ hook_event_name: "PreToolUse", tool_name: toolName }, "tu", {
          signal: new AbortController().signal,
        });
      expect(await decide("mcp__claude_ai_X__y")).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: expect.stringContaining(
            "mcp__claude_ai_X__y",
          ),
        },
      });
      expect(await decide("Read")).toEqual({});
      expect(await decide("mcp__adk_bridge__lookup")).toEqual({});
    });
  }

  test("a tool the hook blocked ends the run with the isolation error", async () => {
    const { sdk, state } = hookSdk(["mcp__claude_ai_X__y"]);
    const events = await collect(
      new ClaudeAgentSdkDriver({ sdk: sdk as never }).run(
        request({ mode: "full-access" }, LOOKUP_TOOL),
      ),
    );
    expect(state.decisions[0]).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "error",
      "completed",
    ]);
    expect(events[1]).toMatchObject({
      code: EXTERNAL_AGENT_ISOLATION_VIOLATED,
      recoverable: false,
    });
  });

  test("inheritHostConfig passes no isolation hook", async () => {
    const { sdk, state } = hookSdk();
    await collect(
      new ClaudeAgentSdkDriver({
        sdk: sdk as never,
        inheritHostConfig: true,
      }).run(request({ mode: "full-access" })),
    );
    expect(state.options?.hooks).toBeUndefined();
  });
});

describe("the bridge's tools are matched by their registered names", () => {
  const expected = {
    tools: ["Read"],
    mcpServers: ["adk_bridge"],
    bridgeTools: [
      "mcp__adk_bridge__run_adk_subagent",
      "mcp__adk_bridge__lookup",
    ],
  };

  test("a host server named like the bridge does not pass as the bridge", () => {
    expect(isExpectedClaudeTool("mcp__adk_bridge__x__y", expected)).toBe(false);
    expect(isExpectedClaudeTool("mcp__adk_bridge__other", expected)).toBe(
      false,
    );
    expect(
      findToolUseViolations(toolUse("mcp__adk_bridge__x__y"), expected),
    ).toEqual(["mcp__adk_bridge__x__y"]);
  });

  test("the registered bridge tools are expected", () => {
    expect(isExpectedClaudeTool("mcp__adk_bridge__lookup", expected)).toBe(
      true,
    );
    expect(
      isExpectedClaudeTool("mcp__adk_bridge__run_adk_subagent", expected),
    ).toBe(true);
  });

  test("other expected servers keep the prefix rule", () => {
    expect(
      isExpectedClaudeTool("mcp__workflow__start", {
        ...expected,
        mcpServers: ["adk_bridge", "workflow"],
      }),
    ).toBe(true);
  });

  test("the SDK driver stops a late adk_bridge__x tool", async () => {
    const { sdk } = fakeSdk([
      init(["Read", "mcp__adk_bridge__lookup"], ["adk_bridge"]),
      toolUse("mcp__adk_bridge__x__y"),
      RESULT,
    ]);
    const events = await collect(
      new ClaudeAgentSdkDriver({ sdk }).run(
        request({ mode: "ask" }, LOOKUP_TOOL),
      ),
    );
    expect(events.find((event) => event.type === "error")).toMatchObject({
      code: EXTERNAL_AGENT_ISOLATION_VIOLATED,
    });
  });
});

describe("read-only holds with inheritHostConfig", () => {
  test("the CLI denies every MCP tool under read-only, host config or not", () => {
    for (const inheritHostConfig of [false, true]) {
      const args = new ClaudeCliDriver({ inheritHostConfig }).buildArgs(
        request({ mode: "read-only" }),
      );
      const settings = args.find((arg) => arg.startsWith("--settings="));
      expect(settings).toBeDefined();
      const parsed = JSON.parse(settings?.slice("--settings=".length) ?? "{}");
      expect(parsed.permissions).toEqual({ deny: ["mcp__*"] });
      expect(args).toContain("--permission-mode");
      expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    }
  });

  test("the CLI keeps host MCP tools when inheriting outside read-only", () => {
    const args = new ClaudeCliDriver({ inheritHostConfig: true }).buildArgs(
      request({ mode: "workspace-write" }),
    );
    expect(args.some((arg) => arg.includes("mcp__*"))).toBe(false);
  });

  test("the SDK hook denies host MCP tools under read-only with inheritHostConfig", async () => {
    const { sdk, state } = hookSdk();
    await collect(
      new ClaudeAgentSdkDriver({
        sdk: sdk as never,
        inheritHostConfig: true,
      }).run(request({ mode: "read-only" }, LOOKUP_TOOL)),
    );
    const hook = preToolUse(state.options);
    const decide = (toolName: string) =>
      hook({ hook_event_name: "PreToolUse", tool_name: toolName }, "tu", {
        signal: new AbortController().signal,
      });
    expect(await decide("mcp__github__create_issue")).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      },
    });
    for (const foreign of [
      "mcp__adk_bridge__not_registered",
      "mcp__adk_bridge_evil__x",
      "mcp__filesystem__write_file",
    ]) {
      expect(await decide(foreign)).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
    }
    expect(await decide("mcp__adk_bridge__lookup")).toEqual({});
    expect(await decide("Read")).toEqual({});
  });
});
