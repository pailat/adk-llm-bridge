import { describe, expect, test } from "bun:test";
import { InputValidationError } from "@google/adk";
import { ClaudeAgentSdkDriver } from "../../../src/agents/driver/claude-agent-sdk.js";
import {
  ClaudeCliDriver,
  type ClaudeCliSpawn,
} from "../../../src/agents/driver/claude-cli.js";
import {
  assertClaudeInitIsolated,
  assertClaudeMessageIsolated,
  CLAUDE_NO_NETWORK_SANDBOX,
  canonicalClaudeToolName,
  claudeCliIsolationArgs,
  claudeInitTools,
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
      autoMemoryEnabled: false,
      permissions: { deny: ["mcp__*"] },
      sandbox: CLAUDE_NO_NETWORK_SANDBOX,
    });
  });

  test("user args are the last arguments (the prompt goes on stdin)", () => {
    const args = new ClaudeCliDriver({
      args: ["--max-budget-usd", "2"],
    }).buildArgs(request({ mode: "ask" }));
    expect(args.slice(-2)).toEqual(["--max-budget-usd", "2"]);
    expect(args).not.toContain("--");
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

  test("inheritHostConfig with the network on passes no isolation hook", async () => {
    const { sdk, state } = hookSdk();
    await collect(
      new ClaudeAgentSdkDriver({
        sdk: sdk as never,
        inheritHostConfig: true,
      }).run(request({ mode: "full-access", allowNetwork: true })),
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

  test("the CLI keeps host MCP tools when inheriting outside read-only with the network on", () => {
    const args = new ClaudeCliDriver({ inheritHostConfig: true }).buildArgs(
      request({ mode: "workspace-write", allowNetwork: true }),
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

describe("network off holds for MCP tools with inheritHostConfig", () => {
  // A host MCP server runs outside the shell sandbox, so with the network
  // off its tools are denied in every mode, even when host settings
  // pre-approve them (which skips the permission prompt).
  const modes = ["ask", "workspace-write", "full-access"] as const;

  test("the CLI denies every MCP tool", () => {
    for (const mode of modes) {
      for (const permissions of [{ mode }, { mode, allowNetwork: false }]) {
        const args = new ClaudeCliDriver({ inheritHostConfig: true }).buildArgs(
          request(permissions),
        );
        const settings = args.find((arg) => arg.startsWith("--settings="));
        const parsed = JSON.parse(
          settings?.slice("--settings=".length) ?? "{}",
        );
        expect(parsed.permissions).toEqual({ deny: ["mcp__*"] });
      }
    }
  });

  test("the SDK hook denies host MCP tools and keeps the bridge's", async () => {
    for (const mode of modes) {
      const { sdk, state } = hookSdk();
      await collect(
        new ClaudeAgentSdkDriver({
          sdk: sdk as never,
          inheritHostConfig: true,
        }).run(request({ mode }, LOOKUP_TOOL)),
      );
      const hook = preToolUse(state.options);
      const decide = (toolName: string) =>
        hook({ hook_event_name: "PreToolUse", tool_name: toolName }, "tu", {
          signal: new AbortController().signal,
        });
      expect(await decide("mcp__github__create_issue")).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
      expect(await decide("mcp__adk_bridge__lookup")).toEqual({});
      expect(await decide("Read")).toEqual({});
    }
  });
});

describe("tool_use name spelling", () => {
  function assistantToolUse(name: string, parentToolUseId: string | null) {
    return {
      type: "assistant",
      uuid: "00000000-0000-4000-8000-000000000001",
      session_id: "session-1",
      parent_tool_use_id: parentToolUseId,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name, input: {} }],
      },
    };
  }
  const full = {
    tools: ["Bash", "Edit", "Glob", "Grep", "NotebookEdit", "Read", "Write"],
    mcpServers: ["adk_bridge"],
  };
  const readOnly = { tools: ["Read"], mcpServers: ["adk_bridge"] };
  const violationsOf = (
    name: string,
    expected: { tools: string[]; mcpServers: string[] } = full,
  ) => findToolUseViolations(assistantToolUse(name, null), expected);

  for (const parent of [null, "toolu_parent"]) {
    test(`lowercase 'bash' is accepted when Bash was offered (parent ${parent})`, () => {
      const message = assistantToolUse("bash", parent);
      expect(findToolUseViolations(message, full)).toEqual([]);
      expect(() =>
        assertClaudeMessageIsolated(message, full, "Claude"),
      ).not.toThrow();
    });
  }

  test("'bash' and 'Bash' stay violations when Bash was not offered", () => {
    expect(violationsOf("bash", readOnly)).toEqual(["bash"]);
    expect(violationsOf("Bash", readOnly)).toEqual(["Bash"]);
  });

  test("not-offered built-ins and foreign mcp tools stay violations", () => {
    expect(violationsOf("WebFetch")).toEqual(["WebFetch"]);
    expect(violationsOf("mcp__claude_ai_X__y")).toEqual([
      "mcp__claude_ai_X__y",
    ]);
    expect(violationsOf("CronCreate")).toEqual(["CronCreate"]);
  });

  test("an unknown name is a violation, whatever its case (fail closed)", () => {
    for (const name of ["frobnicate", "skill", "task", "croncreate"]) {
      expect(violationsOf(name)).toEqual([name]);
    }
  });

  test("near-miss spellings of an offered tool stay violations", () => {
    for (const name of [
      " Bash",
      "Bash ",
      "bash\u0000",
      "\uff42\uff41\uff53\uff48",
      "_Bash",
      "1Bash",
      "",
    ]) {
      expect(violationsOf(name)).toEqual([name]);
    }
    expect(() =>
      assertClaudeMessageIsolated(
        assistantToolUse(" Bash", null),
        full,
        "Claude",
      ),
    ).toThrow('tried to use " Bash", outside');
  });

  test("a tool_use with no name or a non-string name is a violation", () => {
    const blocks: Record<string, unknown>[] = [
      { type: "tool_use", id: "toolu_1", input: {} },
      { type: "tool_use", id: "toolu_1", name: 5, input: {} },
      { type: "tool_use", id: "toolu_1", name: null, input: {} },
    ];
    for (const block of blocks) {
      const message = {
        type: "assistant",
        uuid: "00000000-0000-4000-8000-000000000001",
        session_id: "session-1",
        parent_tool_use_id: null,
        message: { role: "assistant", content: [block] },
      };
      expect(findToolUseViolations(message, full)).toEqual([""]);
      expect(() =>
        assertClaudeMessageIsolated(message, full, "Claude"),
      ).toThrow('tried to use "", outside');
    }
  });

  test("mcp tool names are never case-folded", () => {
    for (const name of [
      "mcp__ADK_BRIDGE__x",
      "MCP__adk_bridge__x",
      "mCP__claude_ai_X__y",
    ]) {
      expect(canonicalClaudeToolName(name)).toBeUndefined();
      expect(violationsOf(name)).toEqual([name]);
    }
    const exact = {
      tools: [...full.tools, "mcp__adk_bridge__x"],
      mcpServers: [],
      bridgeTools: ["mcp__adk_bridge__x"],
    };
    expect(
      findToolUseViolations(
        assistantToolUse("mcp__ADK_BRIDGE__x", null),
        exact,
      ),
    ).toEqual(["mcp__ADK_BRIDGE__x"]);
    expect(
      findToolUseViolations(
        assistantToolUse("mcp__adk_bridge__x", null),
        exact,
      ),
    ).toEqual([]);
  });

  test("the fold only returns built-in names, none of which is an mcp name", () => {
    for (const tool of DEFAULT_CLAUDE_TOOLS) {
      expect(tool.startsWith("mcp__")).toBe(false);
      expect(canonicalClaudeToolName(tool.toUpperCase())).toBe(tool);
    }
    expect(canonicalClaudeToolName("multiedit")).toBe("MultiEdit");
    expect(canonicalClaudeToolName("frobnicate")).toBeUndefined();
  });
});

describe("isolation hooks deny a call without a tool name", () => {
  const nameless: Array<Record<string, unknown>> = [
    { hook_event_name: "PreToolUse" },
    { hook_event_name: "PreToolUse", tool_name: "" },
    { hook_event_name: "PreToolUse", tool_name: 5 },
    { hook_event_name: "PreToolUse", tool_name: null },
  ];

  async function hookFor(
    config: Record<string, unknown>,
    mode: "full-access" | "read-only",
  ): Promise<HookFn> {
    const { sdk, state } = hookSdk();
    await collect(
      new ClaudeAgentSdkDriver({ sdk: sdk as never, ...config }).run(
        request({ mode }, LOOKUP_TOOL),
      ),
    );
    return preToolUse(state.options);
  }

  test("the isolation hook denies it", async () => {
    const hook = await hookFor({}, "full-access");
    for (const input of nameless) {
      expect(
        await hook(input, "tu", { signal: new AbortController().signal }),
      ).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: expect.stringContaining("no tool name"),
        },
      });
    }
  });

  test("a nameless call the hook blocked stops the run with a quoted empty name", async () => {
    const { sdk, state } = hookSdk([""]);
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
      message: expect.stringContaining(
        'tried to use "", outside the isolated set; the call was blocked',
      ),
    });
  });

  test("the read-only foreign-MCP hook (inheritHostConfig) denies it", async () => {
    const hook = await hookFor({ inheritHostConfig: true }, "read-only");
    for (const input of nameless) {
      expect(
        await hook(input, "tu", { signal: new AbortController().signal }),
      ).toMatchObject({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
        },
      });
    }
  });
});

describe("isolated runs turn Claude Code auto-memory off", () => {
  test("the SDK driver passes settings.autoMemoryEnabled false when isolated, nothing with inheritHostConfig", () => {
    for (const mode of [
      "read-only",
      "workspace-write",
      "full-access",
    ] as const) {
      const isolated = new ClaudeAgentSdkDriver().buildOptions(
        request({ mode }),
      ) as Record<string, unknown>;
      expect(isolated.settings).toEqual({ autoMemoryEnabled: false });
      const inherited = new ClaudeAgentSdkDriver({
        inheritHostConfig: true,
      }).buildOptions(request({ mode })) as Record<string, unknown>;
      expect("settings" in inherited).toBe(false);
    }
  });

  test("the CLI driver puts autoMemoryEnabled false in --settings when isolated, not with inheritHostConfig", () => {
    const settingsOf = (args: readonly string[]) => {
      const arg = args.find((value) => value.startsWith("--settings="));
      return arg ? JSON.parse(arg.slice("--settings=".length)) : undefined;
    };
    for (const mode of [
      "read-only",
      "workspace-write",
      "full-access",
    ] as const) {
      expect(
        settingsOf(new ClaudeCliDriver().buildArgs(request({ mode }))),
      ).toMatchObject({ autoMemoryEnabled: false });
      const inherited = settingsOf(
        new ClaudeCliDriver({ inheritHostConfig: true }).buildArgs(
          request({ mode }),
        ),
      );
      expect(inherited?.autoMemoryEnabled).toBeUndefined();
    }
  });
});

describe("the tool_use stop message names what the bridge observed", () => {
  const expected = { tools: ["Read"], mcpServers: ["adk_bridge"] };

  function stopMessage(
    name: string | string[],
    offered: readonly string[] | undefined,
  ): string {
    const names = Array.isArray(name) ? name : [name];
    const message = {
      type: "assistant",
      message: {
        content: names.map((tool, index) => ({
          type: "tool_use",
          id: `tu-${index}`,
          name: tool,
          input: {},
        })),
      },
    };
    try {
      assertClaudeMessageIsolated(message, expected, "Claude", offered);
    } catch (error) {
      expect(error).toBeInstanceOf(ExternalAgentPolicyError);
      expect((error as ExternalAgentPolicyError).code).toBe(
        EXTERNAL_AGENT_ISOLATION_VIOLATED,
      );
      expect((error as ExternalAgentPolicyError).recoverable).toBe(false);
      return (error as Error).message;
    }
    throw new Error("expected a stop");
  }

  test("a built-in the runtime did not offer: the model requested a tool that was not offered", () => {
    const message = stopMessage("Bash", ["Read"]);
    expect(message).toContain('the model requested "Bash"');
    expect(message).toContain("was not offered");
    expect(message).toContain("isolation policy stopped the run");
    expect(message).not.toContain("host or managed setting");
  });

  test("an MCP tool the runtime did not offer at start: not offered, and a late server may have added it", () => {
    const message = stopMessage("mcp__claude_ai_X__y", ["Read"]);
    expect(message).toContain('the model requested "mcp__claude_ai_X__y"');
    expect(message).toContain("was not offered");
    expect(message).toContain("connects after start");
  });

  test("a tool the runtime offered but outside the isolated set keeps the host or managed setting hint", () => {
    for (const [name, offered] of [
      ["Bash", ["Read", "Bash"]],
      ["bash", ["Read", "Bash"]],
      ["mcp__host__x", ["Read", "mcp__host__x"]],
    ] as const) {
      const message = stopMessage(name, offered);
      expect(message).toContain(`tried to use ${JSON.stringify(name)}`);
      expect(message).toContain("host or managed setting");
      expect(message).not.toContain("was not offered");
    }
  });

  test("several tools: an offered one wins the hint, and every name is listed", () => {
    const message = stopMessage(["Invented", "Bash"], ["Read", "Bash"]);
    expect(message).toContain('"Invented", "Bash"');
    expect(message).toContain("host or managed setting");
  });

  test("object-form system/init tools ({ name }) are read: the init check flags them and they count as offered", () => {
    const objectInit = {
      type: "system",
      subtype: "init",
      tools: [{ name: "Read" }, { name: "Skill" }],
    };
    expect(claudeInitTools(objectInit)).toEqual(["Read", "Skill"]);
    expect(findIsolationViolations(objectInit, expected)).toEqual({
      tools: ["Skill"],
      mcpServers: [],
    });
    expect(() =>
      assertClaudeInitIsolated(objectInit, expected, "Claude"),
    ).toThrow(ExternalAgentPolicyError);
    const message = stopMessage("Skill", claudeInitTools(objectInit));
    expect(message).toContain('tried to use "Skill"');
    expect(message).toContain("host or managed setting");
    expect(message).not.toContain("was not offered");
  });

  test("before system/init the wording is neutral", () => {
    const message = stopMessage("Bash", undefined);
    expect(message).toContain('tried to use "Bash", outside the isolated set');
    expect(message).toContain("had not reported");
    expect(message).not.toContain("was not offered");
    expect(message).not.toContain("host or managed setting");
  });

  test("Claude Agent SDK: an invented tool after init with no answer is reported as not offered", async () => {
    // The driver waits for the runtime's answer to an invented call; with
    // none before the result, the run stops.
    const { sdk } = fakeSdk([init(["Read"]), toolUse("CronCreate"), RESULT]);
    const events = await collect(
      new ClaudeAgentSdkDriver({ sdk }).run(request({ mode: "ask" })),
    );
    expect(events.find((event) => event.type === "error")).toMatchObject({
      code: EXTERNAL_AGENT_ISOLATION_VIOLATED,
      recoverable: false,
      message: expect.stringContaining(
        'the model requested "CronCreate", a tool that was not offered, and the runtime gave no result',
      ),
    });
  });

  test("Claude Agent SDK: a tool_use before init gets the neutral wording", async () => {
    const { sdk } = fakeSdk([toolUse("CronCreate"), init(["Read"]), RESULT]);
    const events = await collect(
      new ClaudeAgentSdkDriver({ sdk }).run(request({ mode: "ask" })),
    );
    expect(events[1]).toMatchObject({
      code: EXTERNAL_AGENT_ISOLATION_VIOLATED,
      message: expect.stringContaining("had not reported"),
    });
  });

  test("Claude CLI: an invented tool after init is reported as not offered", async () => {
    const { spawn } = cliSpawn(
      [init(["Read"]), toolUse("CronCreate"), RESULT],
      false,
    );
    const events = await collect(
      new ClaudeCliDriver({ spawn, killGraceMs: 0 }).run(
        request({ mode: "ask" }),
      ),
    );
    expect(events[1]).toMatchObject({
      code: EXTERNAL_AGENT_ISOLATION_VIOLATED,
      message: expect.stringContaining(
        'the model requested "CronCreate", a tool that was not offered',
      ),
    });
  });
});

describe("the always-writable temp area follows the runtime's environment", () => {
  // The workspace is outside every host temp directory, so only the
  // driver's configured TMPDIR / CLAUDE_CODE_TMPDIR can put it inside.
  const workingDirectory = "/opt/adk-bridge-s7-workspace";
  const policy = {
    mode: "workspace-write" as const,
    allowedPaths: [workingDirectory],
  };
  const plan = (env?: Record<string, string | undefined>) =>
    planClaudeIsolation(policy, {
      inheritHostConfig: false,
      allowUnsandboxedShell: false,
      workingDirectory,
      ...(env ? { env } : {}),
    });

  test("without a configured temp directory the shell is confined", () => {
    expect(plan().shellPathsUnenforceable).toBeUndefined();
    expect(plan({ PATH: "/usr/bin" }).shellPathsUnenforceable).toBeUndefined();
  });

  for (const key of ["TMPDIR", "CLAUDE_CODE_TMPDIR"]) {
    test(`a configured ${key} around the workspace is refused`, () => {
      expect(plan({ [key]: "/opt" }).shellPathsUnenforceable).toContain(
        "temp directory",
      );
    });
  }

  test("the SDK driver passes its env to the plan", () => {
    const driver = new ClaudeAgentSdkDriver({ env: { TMPDIR: "/opt" } });
    expect(
      driver.isolationPlan({
        provider: CLAUDE_PROVIDER,
        context: {} as never,
        workingDirectory,
        permissions: policy,
      }).shellPathsUnenforceable,
    ).toContain("temp directory");
  });
});

describe("shell tools are recognized whatever their case", () => {
  // Claude Code matches tool names case-insensitively, so a lower-case
  // shell name still offers a shell and must get the no-network sandbox.
  for (const [name, canonical] of [
    ["bash", "Bash"],
    ["BASH", "Bash"],
    ["powershell", "PowerShell"],
    ["POWERSHELL", "PowerShell"],
  ] as const) {
    test(`${name} gets the no-network sandbox and is passed on as ${canonical}`, () => {
      const plan = planClaudeIsolation(
        { mode: "workspace-write" },
        {
          tools: [name, "Read"],
          inheritHostConfig: false,
          allowUnsandboxedShell: false,
          workingDirectory: "/repo",
        },
      );
      expect(plan.sandbox).toBeDefined();
      expect(plan.networkSandbox).toBe("enforced");
      expect(plan.tools).toEqual([canonical, "Read"]);
    });
  }

  test("an unknown name is passed on unchanged and offers no shell", () => {
    const plan = planClaudeIsolation(
      { mode: "workspace-write" },
      {
        tools: ["Read", "MyTool"],
        inheritHostConfig: false,
        allowUnsandboxedShell: false,
        workingDirectory: "/repo",
      },
    );
    expect(plan.tools).toEqual(["Read", "MyTool"]);
    expect(plan.sandbox).toBeUndefined();
  });

  test("duplicate spellings collapse to one tool", () => {
    const plan = planClaudeIsolation(
      { mode: "workspace-write" },
      {
        tools: ["bash", "Bash", "read"],
        inheritHostConfig: false,
        allowUnsandboxedShell: false,
        workingDirectory: "/repo",
      },
    );
    expect(plan.tools).toEqual(["Bash", "Read"]);
  });

  test("the CLI gets the sandbox settings for a lower-case shell name", () => {
    const args = new ClaudeCliDriver({ tools: ["bash"] }).buildArgs(
      request({ mode: "workspace-write" }),
    );
    expect(args).toContain("--tools=Bash");
    const settings = args.find((arg) => arg.startsWith("--settings="));
    const parsed = JSON.parse(settings?.slice("--settings=".length) ?? "{}");
    expect(parsed.sandbox).toMatchObject({ enabled: true });
  });
});

describe("each PreToolUse guard is put in front of the hooks already set", () => {
  // A guard decides before the hooks configured earlier; a hook that lets a
  // call through must not run ahead of it.
  test("the path guard comes first and the isolation hook stays after it", async () => {
    const { sdk, state } = hookSdk();
    await collect(
      new ClaudeAgentSdkDriver({ sdk: sdk as never, tools: ["Read"] }).run(
        request(
          { mode: "workspace-write", allowedPaths: ["/repo"] },
          LOOKUP_TOOL,
        ),
      ),
    );
    const matchers = (
      state.options?.hooks as
        | { PreToolUse?: Array<{ hooks: HookFn[] }> }
        | undefined
    )?.PreToolUse;
    expect(matchers).toHaveLength(2);
    const [first, second] = (matchers ?? []).map((matcher) => {
      const hook = matcher.hooks[0];
      if (!hook) throw new Error("matcher without a hook");
      return hook;
    });
    const call = (hook: HookFn | undefined, input: Record<string, unknown>) =>
      hook?.({ hook_event_name: "PreToolUse", ...input }, "tu", {
        signal: new AbortController().signal,
      });
    const outside = {
      tool_name: "Read",
      tool_input: { file_path: "/etc/passwd" },
    };
    const connector = { tool_name: "mcp__github__create_issue" };

    // First: the path guard (added last). It denies a path outside the
    // roots and leaves other tools to the next hook.
    expect(await call(first, outside)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(await call(first, connector)).toEqual({});
    // Second: the isolation hook, kept as it was.
    expect(await call(second, connector)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(await call(second, outside)).toEqual({});
  });
});
