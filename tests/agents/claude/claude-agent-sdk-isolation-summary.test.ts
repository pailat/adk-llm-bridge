import { describe, expect, test } from "bun:test";
import {
  ClaudeAgentSdkDriver,
  DEFAULT_CLAUDE_SDK_TOOLS,
} from "../../../src/agents/driver/claude-agent-sdk.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import { ExternalAgent } from "../../../src/agents/external-agent.js";
import type { ExternalAgentRunRequest } from "../../../src/agents/external-agent-driver.js";
import type { ExternalAgentPermissionPolicy } from "../../../src/agents/permissions/schema.js";
import {
  CLAUDE_PROVIDER,
  CODEX_PROVIDER,
} from "../../../src/agents/provider/schema.js";

type Options = Record<string, unknown> & {
  canUseTool?: (
    name: string,
    input: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => Promise<{ behavior: string; [key: string]: unknown }>;
};

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

function fakeSdk(messages: Record<string, unknown>[]) {
  let options: Options | undefined;
  const sdk = {
    query: (params: { options?: Options }) => {
      options = params.options;
      return (async function* () {
        for (const message of messages) yield message;
      })();
    },
    tool: (name: string) => ({ name }),
    createSdkMcpServer: (config: Record<string, unknown>) => config,
  };
  return { sdk, options: () => options };
}

async function collect(
  driver: ClaudeAgentSdkDriver,
  req: ExternalAgentRunRequest = request(),
): Promise<ExternalAgentEvent[]> {
  const events: ExternalAgentEvent[] = [];
  for await (const event of driver.run(req)) events.push(event);
  return events;
}

const INIT = {
  type: "system",
  subtype: "init",
  model: "claude-haiku-5-5",
  session_id: "sdk-1",
  tools: ["Read"],
  mcp_servers: [],
};

const RESULT = {
  type: "result",
  subtype: "success",
  result: "done",
  num_turns: 4,
  duration_ms: 23975,
  total_cost_usd: 0.00508644,
  usage: {
    input_tokens: 8,
    output_tokens: 873,
    cache_creation_input_tokens: 19817,
    cache_read_input_tokens: 55464,
  },
  modelUsage: {
    "claude-haiku-5-5": {
      inputTokens: 1229,
      outputTokens: 891,
      cacheReadInputTokens: 55464,
      cacheCreationInputTokens: 19817,
      costUSD: 0.00508644,
      contextWindow: 1000000,
    },
  },
};

// Network is off by default, so the default run leaves out the web tools.
const DEFAULT_OFFLINE_TOOLS = DEFAULT_CLAUDE_SDK_TOOLS.filter(
  (name) => name !== "WebFetch" && name !== "WebSearch",
);

describe("host configuration isolation", () => {
  test("isolated by default: explicit tools, strict MCP, no skills, no claude.ai connectors, no auto-memory", () => {
    const options = new ClaudeAgentSdkDriver().buildOptions(
      request({ mode: "workspace-write", allowNetwork: true }),
    ) as Options;

    expect(options.tools).toEqual([...DEFAULT_CLAUDE_SDK_TOOLS]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.skills).toEqual([]);
    expect(options.managedSettings).toEqual({
      disableClaudeAiConnectors: true,
    });
    expect(options.settings).toEqual({ autoMemoryEnabled: false });
    expect(options.settingSources).toEqual([]);
    expect(options.disallowedTools).toBeUndefined();
  });

  test("the default tool set leaves out host-level tools", () => {
    for (const hostTool of [
      "Task",
      "Agent",
      "CronCreate",
      "Workflow",
      "ToolSearch",
      "SendMessage",
      "EnterWorktree",
      "Skill",
      "ScheduleWakeup",
      "RemoteTrigger",
    ]) {
      expect(DEFAULT_CLAUDE_SDK_TOOLS).not.toContain(hostTool);
    }
    expect(Object.isFrozen(DEFAULT_CLAUDE_SDK_TOOLS)).toBe(true);
  });

  test("a configured tools list replaces the default", () => {
    const options = new ClaudeAgentSdkDriver({
      tools: ["Read", "Grep"],
    }).buildOptions(request({ mode: "full-access" })) as Options;

    expect(options.tools).toEqual(["Read", "Grep"]);
    expect(options.strictMcpConfig).toBe(true);
  });

  test("inheritHostConfig opts back into the host's preset, MCP and connectors", () => {
    const options = new ClaudeAgentSdkDriver({
      inheritHostConfig: true,
    }).buildOptions(request({ mode: "workspace-write" })) as Options;

    expect("tools" in options).toBe(false);
    expect("strictMcpConfig" in options).toBe(false);
    expect("skills" in options).toBe(false);
    expect("managedSettings" in options).toBe(false);
    expect("settings" in options).toBe(false);
    // settingSources stays a separate opt-in.
    expect(options.settingSources).toEqual([]);
  });

  test("inheritHostConfig with explicit tools passes them through", () => {
    const options = new ClaudeAgentSdkDriver({
      inheritHostConfig: true,
      tools: ["Read"],
    }).buildOptions(request({ mode: "workspace-write" })) as Options;

    expect(options.tools).toEqual(["Read"]);
    expect("strictMcpConfig" in options).toBe(false);
  });

  test("the options reach sdk.query unchanged", async () => {
    const fake = fakeSdk([INIT, RESULT]);
    await collect(new ClaudeAgentSdkDriver({ sdk: fake.sdk }));

    expect(fake.options()?.tools).toEqual(DEFAULT_OFFLINE_TOOLS);
    expect(fake.options()?.strictMcpConfig).toBe(true);
  });

  test("the bridge MCP server is still added under strict MCP", async () => {
    const fake = fakeSdk([]);
    const subAgent = new ExternalAgent({
      name: "Sub",
      provider: CODEX_PROVIDER,
    });
    const options = (await new ClaudeAgentSdkDriver({
      sdk: fake.sdk,
    }).buildOptionsForRun(
      request(
        { mode: "workspace-write" },
        {
          subAgents: [subAgent],
          toolGateway: { runSubAgent: async () => undefined } as never,
        },
      ),
      fake.sdk,
    )) as Options;

    expect(options.strictMcpConfig).toBe(true);
    expect(Object.keys(options.mcpServers as object)).toEqual(["adk_bridge"]);
  });
});

describe("read-only removes write, shell and web tools from the list", () => {
  test("read-only drops write/exec/web tools from tools and disallows them", () => {
    const options = new ClaudeAgentSdkDriver().buildOptions(
      request({ mode: "read-only" }),
    ) as Options;

    expect(options.tools).toEqual(["Read", "Glob", "Grep", "TodoWrite"]);
    expect(options.disallowedTools).toEqual([
      "Edit",
      "Write",
      "MultiEdit",
      "NotebookEdit",
      "Bash",
      "PowerShell",
      "WebFetch",
      "WebSearch",
    ]);
    // Call-time denial stays as defense in depth.
    expect(options.permissionMode).toBe("default");
  });

  test("read-only with allowNetwork: true keeps the web tools", () => {
    const options = new ClaudeAgentSdkDriver().buildOptions(
      request({ mode: "read-only", allowNetwork: true }),
    ) as Options;

    expect(options.tools).toEqual([
      "Read",
      "Glob",
      "Grep",
      "WebFetch",
      "WebSearch",
      "TodoWrite",
    ]);
    expect(options.disallowedTools).not.toContain("WebFetch");
  });

  test("allowNetwork: false removes the web tools in any mode", () => {
    const options = new ClaudeAgentSdkDriver().buildOptions(
      request({ mode: "workspace-write", allowNetwork: false }),
    ) as Options;

    expect(options.tools).not.toContain("WebFetch");
    expect(options.tools).not.toContain("WebSearch");
    expect(options.tools).toContain("Edit");
    expect(options.disallowedTools).toEqual(["WebFetch", "WebSearch"]);
  });

  test("read-only also disallows write tools when inheriting the host preset", () => {
    const options = new ClaudeAgentSdkDriver({
      inheritHostConfig: true,
    }).buildOptions(request({ mode: "read-only" })) as Options;

    expect("tools" in options).toBe(false);
    expect(options.disallowedTools).toContain("Bash");
    expect(options.disallowedTools).toContain("Write");
  });
});

describe("no CLAUDE_SDK_CAN_USE_TOOL_SHADOWED in the coordinator path", () => {
  const subAgentRequest = (withApprover: boolean) =>
    request(
      { mode: "workspace-write" },
      {
        subAgents: [
          new ExternalAgent({ name: "Sub", provider: CODEX_PROVIDER }),
        ],
        toolGateway: { runSubAgent: async () => undefined } as never,
        ...(withApprover
          ? {
              requestPermission: async () => ({
                behavior: "deny" as const,
                message: "host says no",
              }),
            }
          : {}),
      },
    );

  test("with a host approver, bridge tools are approved in canUseTool, not allowedTools", async () => {
    const fake = fakeSdk([]);
    const options = (await new ClaudeAgentSdkDriver({
      sdk: fake.sdk,
    }).buildOptionsForRun(subAgentRequest(true), fake.sdk)) as Options;

    // A bare allowedTools entry plus canUseTool is what triggers the warning.
    expect(options.allowedTools).toBeUndefined();
    expect(options.canUseTool).toBeDefined();
    await expect(
      options.canUseTool?.("mcp__adk_bridge__run_adk_subagent", { a: 1 }, {}),
    ).resolves.toEqual({ behavior: "allow", updatedInput: { a: 1 } });
    // Every other tool still goes to the host.
    await expect(
      options.canUseTool?.("Bash", { command: "ls" }, {}),
    ).resolves.toEqual({ behavior: "deny", message: "host says no" });
  });

  test("another server's tool with a similar name is not auto-approved", async () => {
    const fake = fakeSdk([]);
    const options = (await new ClaudeAgentSdkDriver({
      sdk: fake.sdk,
    }).buildOptionsForRun(subAgentRequest(true), fake.sdk)) as Options;

    await expect(
      options.canUseTool?.("mcp__adk_bridge__other", {}, {}),
    ).resolves.toEqual({ behavior: "deny", message: "host says no" });
  });

  test("without an approver the bridge tools stay in allowedTools (no callback, no warning)", async () => {
    const fake = fakeSdk([]);
    const options = (await new ClaudeAgentSdkDriver({
      sdk: fake.sdk,
    }).buildOptionsForRun(subAgentRequest(false), fake.sdk)) as Options;

    expect(options.canUseTool).toBeUndefined();
    expect(options.allowedTools).toEqual(["mcp__adk_bridge__run_adk_subagent"]);
  });
});

describe("model, usage, turns and duration", () => {
  test("started carries init.model; completed carries modelUsage, cost, turns, duration", async () => {
    const fake = fakeSdk([INIT, RESULT]);
    const events = await collect(new ClaudeAgentSdkDriver({ sdk: fake.sdk }));

    expect(events[0]).toEqual({
      type: "started",
      providerId: "claude",
      model: "claude-haiku-5-5",
      timestamp: expect.any(Number),
    });
    expect(events.at(-1)).toEqual({
      type: "completed",
      exitCode: 0,
      model: "claude-haiku-5-5",
      usage: {
        inputTokens: 1229,
        outputTokens: 891,
        cacheReadInputTokens: 55464,
        cacheCreationInputTokens: 19817,
        totalCostUsd: 0.00508644,
        scope: "run",
      },
      numTurns: 4,
      durationMs: 23975,
      timestamp: expect.any(Number),
    });
  });

  test("the started timestamp is the run start, not the init arrival", async () => {
    const before = Date.now();
    const fake = fakeSdk([INIT, RESULT]);
    const events = await collect(new ClaudeAgentSdkDriver({ sdk: fake.sdk }));
    const started = events[0] as { timestamp: number };

    expect(started.timestamp).toBeGreaterThanOrEqual(before);
    expect(started.timestamp).toBeLessThanOrEqual(
      (events.at(-1) as { timestamp: number }).timestamp,
    );
  });

  test("an error result also carries usage", async () => {
    const fake = fakeSdk([
      INIT,
      {
        type: "result",
        subtype: "error_max_turns",
        num_turns: 8,
        total_cost_usd: 0.01,
        usage: { input_tokens: 3, output_tokens: 4 },
      },
    ]);
    const events = await collect(new ClaudeAgentSdkDriver({ sdk: fake.sdk }));

    expect(events.at(-1)).toEqual({
      type: "completed",
      exitCode: 1,
      model: "claude-haiku-5-5",
      usage: {
        inputTokens: 3,
        outputTokens: 4,
        totalCostUsd: 0.01,
        scope: "run",
      },
      numTurns: 8,
      timestamp: expect.any(Number),
    });
  });

  test("unknown values are left out, never zero", async () => {
    const fake = fakeSdk([{ type: "result", subtype: "success" }]);
    const events = await collect(new ClaudeAgentSdkDriver({ sdk: fake.sdk }));

    expect(events[0]).toEqual({
      type: "started",
      providerId: "claude",
      timestamp: expect.any(Number),
    });
    expect(events.at(-1)).toEqual({
      type: "completed",
      exitCode: 0,
      timestamp: expect.any(Number),
    });
  });

  test("started is still first when query() throws before any message", async () => {
    const sdk = {
      query: () => {
        throw new Error("boom");
      },
    };
    const events = await collect(new ClaudeAgentSdkDriver({ sdk }));

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "error",
      "completed",
    ]);
  });

  test("the model getter exposes the configured model", () => {
    expect(new ClaudeAgentSdkDriver({ model: "haiku" }).model).toBe("haiku");
    expect(new ClaudeAgentSdkDriver().model).toBeUndefined();
  });
});

describe("built-in tool calls become tool_call/tool_result events", () => {
  const assistant = (content: unknown[]) => ({
    type: "assistant",
    message: { role: "assistant", content },
  });
  const user = (content: unknown[]) => ({
    type: "user",
    message: { role: "user", content },
  });

  test("tool_use and tool_result blocks are emitted, paired by callId", async () => {
    const fake = fakeSdk([
      INIT,
      assistant([
        { type: "text", text: "Reading." },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Read",
          input: { file_path: "/repo/a.ts" },
        },
      ]),
      user([
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: "file body",
        },
      ]),
      RESULT,
    ]);
    const events = await collect(new ClaudeAgentSdkDriver({ sdk: fake.sdk }));

    expect(
      events.filter(
        (event) =>
          event.type === "output" ||
          event.type === "tool_call" ||
          event.type === "tool_result",
      ),
    ).toEqual([
      { type: "output", content: "Reading.", timestamp: expect.any(Number) },
      {
        type: "tool_call",
        name: "Read",
        input: { file_path: "/repo/a.ts" },
        callId: "toolu_1",
        metadata: { builtin: true },
        timestamp: expect.any(Number),
      },
      {
        type: "tool_result",
        name: "Read",
        result: "file body",
        callId: "toolu_1",
        metadata: { builtin: true },
        timestamp: expect.any(Number),
      },
    ]);
  });

  test("an error result carries the error text", () => {
    const driver = new ClaudeAgentSdkDriver();
    const names = new Map<string, string>();
    driver.normalizeMessage(
      assistant([
        { type: "tool_use", id: "t2", name: "Bash", input: { command: "x" } },
      ]),
      names,
    );

    expect(
      driver.normalizeMessage(
        user([
          {
            type: "tool_result",
            tool_use_id: "t2",
            is_error: true,
            content: [{ type: "text", text: "Permission denied" }],
          },
        ]),
        names,
      ),
    ).toEqual([
      {
        type: "tool_result",
        name: "Bash",
        result: [{ type: "text", text: "Permission denied" }],
        callId: "t2",
        error: "Permission denied",
        metadata: { builtin: true },
        timestamp: expect.any(Number),
      },
    ]);
  });

  test("the bridge delegation tool is skipped; ADK bridge tools are marked adkTool", () => {
    const driver = new ClaudeAgentSdkDriver();
    const names = new Map<string, string>();
    const calls = driver.normalizeMessage(
      assistant([
        {
          type: "tool_use",
          id: "d1",
          name: "mcp__adk_bridge__run_adk_subagent",
          input: { agentName: "Sub", task: "x" },
        },
        {
          type: "tool_use",
          id: "a1",
          name: "mcp__adk_bridge__lookup",
          input: { q: 1 },
        },
      ]),
      names,
    );
    const results = driver.normalizeMessage(
      user([
        { type: "tool_result", tool_use_id: "d1", content: "sub done" },
        { type: "tool_result", tool_use_id: "a1", content: "{}" },
      ]),
      names,
    );

    expect(calls).toEqual([
      {
        type: "tool_call",
        name: "mcp__adk_bridge__lookup",
        input: { q: 1 },
        callId: "a1",
        metadata: { builtin: false, adkTool: true },
        timestamp: expect.any(Number),
      },
    ]);
    expect(
      results.map((event) => event.type === "tool_result" && event.callId),
    ).toEqual(["a1"]);
  });

  test("a tool_result with no known tool_use is not emitted", () => {
    expect(
      new ClaudeAgentSdkDriver().normalizeMessage(
        user([{ type: "tool_result", tool_use_id: "nope", content: "x" }]),
      ),
    ).toEqual([]);
  });

  test("tool calls inside a Claude sub-agent carry parentToolUseId", () => {
    const events = new ClaudeAgentSdkDriver().normalizeMessage({
      ...assistant([
        { type: "tool_use", id: "c1", name: "Grep", input: { pattern: "x" } },
      ]),
      parent_tool_use_id: "task-1",
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "tool_call",
        metadata: { builtin: true, parentToolUseId: "task-1" },
      }),
    ]);
  });

  test("a tool_use-only assistant message produces no empty output", () => {
    const events = new ClaudeAgentSdkDriver().normalizeMessage(
      assistant([{ type: "tool_use", id: "t", name: "Read", input: {} }]),
    );

    expect(events.map((event) => event.type)).toEqual(["tool_call"]);
  });
});
