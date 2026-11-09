import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySessionService, Runner } from "@google/adk";
import { ClaudeAgentSdkDriver } from "../../src/agents/driver/claude-agent-sdk.js";
import { ClaudeCliDriver } from "../../src/agents/driver/claude-cli.js";
import {
  claudeCliIsolationArgs,
  planClaudeIsolation,
} from "../../src/agents/driver/claude-isolation.js";
import {
  CodexCliDriver,
  type CodexCliSpawn,
  mapPolicyToCodexArgs,
} from "../../src/agents/driver/codex-cli.js";
import {
  CodexSdkDriver,
  mapPolicyToCodexSdkThreadOptions,
} from "../../src/agents/driver/codex-sdk.js";
import {
  GeminiCliDriver,
  type GeminiCliSpawn,
} from "../../src/agents/driver/gemini-cli.js";
import { EXTERNAL_AGENT_NETWORK_UNENFORCEABLE } from "../../src/agents/driver/policy-errors.js";
import type { ExternalAgentEvent } from "../../src/agents/events.js";
import {
  ExternalAgent,
  type ExternalAgentDriver,
  type ExternalAgentRunRequest,
} from "../../src/agents/index.js";
import {
  guardPermissionRequest,
  type PermissionDecision,
  type PermissionRequest,
} from "../../src/agents/permissions/confirmation.js";
import type { ExternalAgentPermissionPolicy } from "../../src/agents/permissions/schema.js";
import { GEMINI_CLI_PROVIDER } from "../../src/agents/provider/gemini-cli.js";
import {
  CLAUDE_PROVIDER,
  CODEX_PROVIDER,
} from "../../src/agents/provider/schema.js";

/**
 * A read-only agent with `allowNetwork: true` may read the web: its web
 * tools run without a confirmation, while every other read-only rule stays.
 * Web tools offered with the network off refuse the run instead of being
 * dropped without a word.
 */

const READ_ONLY_NETWORK: ExternalAgentPermissionPolicy = {
  mode: "read-only",
  allowNetwork: true,
};

/** The driver opt-ins at their defaults. */
const PLAN_DEFAULTS = {
  inheritHostConfig: false,
  allowUnsandboxedShell: false,
};

const DENY_READ_ONLY =
  "Denied: this agent runs with a read-only policy, which cannot be overridden by a confirmation.";

const WEB_TOOLS = [
  "WebFetch",
  "WebSearch",
  "web_fetch",
  "web_search",
  "google_web_search",
];

function request(toolName: string, input = {}): PermissionRequest {
  return { requestId: "call-1", toolName, input };
}

async function collect(
  run: AsyncIterable<ExternalAgentEvent>,
): Promise<ExternalAgentEvent[]> {
  const events: ExternalAgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

describe("guard: read-only with allowNetwork", () => {
  for (const tool of WEB_TOOLS) {
    test(`${tool} is not denied`, () => {
      expect(
        guardPermissionRequest(
          READ_ONLY_NETWORK,
          request(tool, { url: "https://example.com" }),
        ),
      ).toBeUndefined();
    });

    test(`${tool} is denied when the network is off or unset`, () => {
      for (const policy of [
        { mode: "read-only" },
        { mode: "read-only", allowNetwork: false },
      ] satisfies ExternalAgentPermissionPolicy[]) {
        expect(guardPermissionRequest(policy, request(tool))).toEqual({
          behavior: "deny",
          message: DENY_READ_ONLY,
        });
      }
    });
  }

  for (const tool of [
    "Write",
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "Bash",
    "PowerShell",
    "shell",
    "apply_patch",
    "Read",
    "webfetch",
    "WEBSEARCH",
    "Web_Fetch",
    " WebFetch",
    "mcp__web__WebFetch",
    "mcp__adk_bridge__WebSearch",
  ]) {
    test(`${JSON.stringify(tool)} is still denied`, () => {
      expect(guardPermissionRequest(READ_ONLY_NETWORK, request(tool))).toEqual({
        behavior: "deny",
        message: DENY_READ_ONLY,
      });
    });
  }

  test("a web tool in another mode is still left to the approver", () => {
    expect(
      guardPermissionRequest(
        { mode: "ask", allowNetwork: true },
        request("WebFetch"),
      ),
    ).toBeUndefined();
  });
});

/** A driver that asks the agent's permission callback for each tool. */
class AskingDriver implements ExternalAgentDriver {
  readonly providerId = CODEX_PROVIDER.id;
  readonly decisions: PermissionDecision[] = [];

  constructor(private readonly tools: string[]) {}

  async *run(request: ExternalAgentRunRequest) {
    for (const toolName of this.tools) {
      const decision = await request.requestPermission?.({
        requestId: `call-${toolName}`,
        toolName,
        input: { url: "https://example.com", file_path: "/repo/x" },
      });
      if (decision) this.decisions.push(decision);
    }
    yield { type: "output" as const, content: "done" };
  }
}

async function runAgent(
  driver: ExternalAgentDriver,
  permissions: ExternalAgentPermissionPolicy,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const agent = new ExternalAgent({
    name: "researcher",
    provider: CODEX_PROVIDER,
    driver,
    permissions,
    ...extra,
  });
  const sessions = new InMemorySessionService();
  const runner = new Runner({
    appName: "web",
    agent,
    sessionService: sessions,
  });
  const session = await sessions.createSession({
    appName: "web",
    userId: "user",
  });
  for await (const _ of runner.runAsync({
    userId: "user",
    sessionId: session.id,
    newMessage: { role: "user", parts: [{ text: "go" }] },
  })) {
    // drain
  }
}

describe("agent: read-only with allowNetwork", () => {
  test("web tools are allowed without an approver; other tools stay denied", async () => {
    const driver = new AskingDriver(["WebFetch", "WebSearch", "Write", "Bash"]);
    await runAgent(driver, READ_ONLY_NETWORK);
    expect(driver.decisions).toEqual([
      { behavior: "allow" },
      { behavior: "allow" },
      { behavior: "deny", message: DENY_READ_ONLY },
      { behavior: "deny", message: DENY_READ_ONLY },
    ]);
  });

  test("an approver is not asked for a read-only web tool", async () => {
    const asked: string[] = [];
    const driver = new AskingDriver(["WebFetch"]);
    await runAgent(driver, READ_ONLY_NETWORK, {
      confirmation: {
        approver: (req: PermissionRequest) => {
          asked.push(req.toolName);
          return false;
        },
      },
    });
    expect(asked).toEqual([]);
    expect(driver.decisions).toEqual([{ behavior: "allow" }]);
  });

  test("without allowNetwork web tools stay denied", async () => {
    const driver = new AskingDriver(["WebFetch"]);
    await runAgent(driver, { mode: "read-only" });
    expect(driver.decisions).toEqual([
      { behavior: "deny", message: DENY_READ_ONLY },
    ]);
  });

  test("workspace-write with allowNetwork still needs an approver", async () => {
    const driver = new AskingDriver(["WebFetch"]);
    await runAgent(driver, { mode: "workspace-write", allowNetwork: true });
    expect(driver.decisions).toEqual([
      {
        behavior: "deny",
        message: "Denied: no approver is configured for this agent.",
      },
    ]);
  });
});

describe("Claude isolation plan", () => {
  test("read-only with allowNetwork pre-approves the offered web tools", () => {
    const plan = planClaudeIsolation(READ_ONLY_NETWORK, {
      ...PLAN_DEFAULTS,
      tools: ["Read", "Grep", "Glob", "WebFetch", "WebSearch"],
    });
    expect(plan.tools).toEqual([
      "Read",
      "Grep",
      "Glob",
      "WebFetch",
      "WebSearch",
    ]);
    expect(plan.readOnlyWebTools).toEqual(["WebFetch", "WebSearch"]);
    expect(plan.unenforceableWebTools).toBeUndefined();
  });

  test("only the web tools actually offered are pre-approved, by canonical name", () => {
    expect(
      planClaudeIsolation(READ_ONLY_NETWORK, {
        ...PLAN_DEFAULTS,
        tools: ["Read", "webfetch"],
      }).readOnlyWebTools,
    ).toEqual(["WebFetch"]);
    expect(
      planClaudeIsolation(READ_ONLY_NETWORK, {
        ...PLAN_DEFAULTS,
        tools: ["Read"],
      }).readOnlyWebTools,
    ).toBeUndefined();
  });

  test("the default tool list under read-only with allowNetwork pre-approves both", () => {
    expect(
      planClaudeIsolation(READ_ONLY_NETWORK, PLAN_DEFAULTS).readOnlyWebTools,
    ).toEqual(["WebFetch", "WebSearch"]);
  });

  test("nothing is pre-approved outside read-only or without the network", () => {
    const tools = ["Read", "WebFetch"];
    for (const policy of [
      { mode: "workspace-write", allowNetwork: true },
      { mode: "ask", allowNetwork: true },
      { mode: "read-only" },
      { mode: "read-only", allowNetwork: false },
    ] satisfies ExternalAgentPermissionPolicy[]) {
      expect(
        planClaudeIsolation(policy, { ...PLAN_DEFAULTS, tools })
          .readOnlyWebTools,
      ).toBe(undefined);
    }
  });

  test("web tools offered explicitly with the network off are reported, in any spelling", () => {
    for (const policy of [
      { mode: "read-only" },
      { mode: "read-only", allowNetwork: false },
      { mode: "workspace-write" },
      undefined,
    ] satisfies (ExternalAgentPermissionPolicy | undefined)[]) {
      const plan = planClaudeIsolation(policy, {
        ...PLAN_DEFAULTS,
        tools: ["Read", "webfetch", "WebSearch"],
      });
      expect(plan.unenforceableWebTools).toEqual(["WebFetch", "WebSearch"]);
      expect(plan.tools).toEqual(["Read"]);
    }
  });

  test("the default tool list with the network off is trimmed, not refused", () => {
    const plan = planClaudeIsolation({ mode: "read-only" }, PLAN_DEFAULTS);
    expect(plan.unenforceableWebTools).toBeUndefined();
    expect(plan.tools).not.toContain("WebFetch");
  });

  test("the CLI settings allow the pre-approved web tools next to the MCP deny", () => {
    const args = claudeCliIsolationArgs(
      planClaudeIsolation(READ_ONLY_NETWORK, {
        ...PLAN_DEFAULTS,
        tools: ["Read", "WebFetch"],
      }),
    );
    const settings = args.find((arg) => arg.startsWith("--settings="));
    expect(
      JSON.parse(String(settings).slice("--settings=".length)).permissions,
    ).toEqual({ allow: ["WebFetch"], deny: ["mcp__*"] });
  });

  test("the CLI settings allow nothing without the network", () => {
    const args = claudeCliIsolationArgs(
      planClaudeIsolation({ mode: "read-only" }, PLAN_DEFAULTS),
    );
    const settings = args.find((arg) => arg.startsWith("--settings="));
    expect(
      JSON.parse(String(settings).slice("--settings=".length)).permissions,
    ).toEqual({ deny: ["mcp__*"] });
  });
});

type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; toolUseID: string },
) => Promise<{ behavior: string; message?: string }>;

/**
 * A fake SDK that decides each call the way Claude Code does in `default`
 * mode: an `allowedTools` rule approves the tool, otherwise `canUseTool` is
 * asked with the real `(toolName, input, options)` shape, and without one the
 * call is denied.
 */
function webSdk(calls: string[]) {
  const state = {
    started: false,
    outcomes: [] as string[],
    options: undefined as Record<string, unknown> | undefined,
  };
  const sdk = {
    query: (input: { options: Record<string, unknown> }) => {
      state.started = true;
      const options = input.options;
      state.options = options;
      const allowed = new Set((options.allowedTools as string[]) ?? []);
      const canUseTool = options.canUseTool as CanUseTool | undefined;
      return (async function* () {
        yield {
          type: "system",
          subtype: "init",
          model: "claude-haiku-5-5",
          session_id: "s-1",
          tools: (options.tools as string[]) ?? [],
          mcp_servers: [],
        };
        for (const tool of calls) {
          if (allowed.has(tool)) {
            state.outcomes.push(`${tool}:allowed-by-rule`);
            continue;
          }
          const decision = canUseTool
            ? await canUseTool(
                tool,
                { url: "https://example.com", prompt: "title" },
                {
                  signal: new AbortController().signal,
                  toolUseID: `tu-${tool}`,
                },
              )
            : { behavior: "deny" };
          state.outcomes.push(`${tool}:${decision.behavior}`);
        }
        yield { type: "result", subtype: "success", result: "done" };
      })();
    },
    tool: (name: string) => ({ name }),
    createSdkMcpServer: (config: Record<string, unknown>) => config,
  };
  return { sdk, state };
}

describe("Claude Agent SDK driver: read-only with allowNetwork", () => {
  test("through an agent, WebFetch and WebSearch run and nothing else is opened up", async () => {
    const { sdk, state } = webSdk(["WebFetch", "WebSearch", "Write"]);
    const agent = new ExternalAgent({
      name: "researcher",
      provider: CLAUDE_PROVIDER,
      driver: new ClaudeAgentSdkDriver({
        sdk: sdk as never,
        tools: ["Read", "Grep", "Glob", "WebFetch", "WebSearch"],
      }),
      permissions: READ_ONLY_NETWORK,
    });
    const sessions = new InMemorySessionService();
    const runner = new Runner({
      appName: "web",
      agent,
      sessionService: sessions,
    });
    const session = await sessions.createSession({
      appName: "web",
      userId: "user",
    });
    for await (const _ of runner.runAsync({
      userId: "user",
      sessionId: session.id,
      newMessage: { role: "user", parts: [{ text: "go" }] },
    })) {
      // drain
    }
    // The isolation layers end the run on the first tool outside the
    // offered set, so Write never reaches the permission callback.
    expect(state.outcomes.slice(0, 2)).toEqual([
      "WebFetch:allow",
      "WebSearch:allow",
    ]);
    expect(state.outcomes).not.toContain("Write:allow");
    expect(state.options?.permissionMode).toBe("default");
    // With a permission callback, no bare allowedTools entry shadows it.
    expect(state.options?.allowedTools).toBeUndefined();
  });

  test("driven without a permission callback, the web tools are allowed by rule", async () => {
    const { sdk, state } = webSdk(["WebFetch", "Write"]);
    await collect(
      new ClaudeAgentSdkDriver({
        sdk: sdk as never,
        tools: ["Read", "WebFetch"],
      }).run({
        provider: CLAUDE_PROVIDER,
        context: { input: "hi" } as never,
        instruction: "research",
        permissions: READ_ONLY_NETWORK,
      }),
    );
    expect(state.options?.allowedTools).toEqual(["WebFetch"]);
    expect(state.outcomes[0]).toBe("WebFetch:allowed-by-rule");
  });

  test("web tools offered with the network off refuse the run before query()", async () => {
    for (const permissions of [
      { mode: "read-only" },
      { mode: "read-only", allowNetwork: false },
      { mode: "workspace-write" },
    ] satisfies ExternalAgentPermissionPolicy[]) {
      const { sdk, state } = webSdk([]);
      const events = await collect(
        new ClaudeAgentSdkDriver({
          sdk: sdk as never,
          tools: ["Read", "WebFetch"],
        }).run({
          provider: CLAUDE_PROVIDER,
          context: { input: "hi" } as never,
          instruction: "research",
          permissions,
        }),
      );
      expect(state.started).toBe(false);
      expect(events.find((event) => event.type === "error")).toMatchObject({
        code: EXTERNAL_AGENT_NETWORK_UNENFORCEABLE,
        recoverable: false,
      });
      expect(events.at(-1)?.type).toBe("completed");
    }
  });
});

describe("Claude CLI driver: web tools with the network off", () => {
  test("refuses before spawning", async () => {
    let spawned = 0;
    const driver = new ClaudeCliDriver({
      tools: ["Read", "WebSearch"],
      spawn: () => {
        spawned++;
        throw new Error("must not spawn");
      },
    } as never);
    const events = await collect(
      driver.run({
        provider: CLAUDE_PROVIDER,
        context: { input: "hi" } as never,
        instruction: "research",
        permissions: { mode: "read-only" },
      }),
    );
    expect(spawned).toBe(0);
    expect(events.find((event) => event.type === "error")).toMatchObject({
      code: EXTERNAL_AGENT_NETWORK_UNENFORCEABLE,
      recoverable: false,
    });
  });
});

/** A spawn that records each run's arguments and exits cleanly. */
function recordingSpawn() {
  const runs: string[][] = [];
  const spawn = (_command: string, args: readonly string[]) => {
    const listing = args[0] === "mcp" && args[1] === "list";
    if (!listing) runs.push([...args]);
    return {
      stdout: (async function* () {
        if (listing) yield "[]";
      })(),
      stderr: null,
      exited: Promise.resolve(0),
    };
  };
  return { spawn, runs };
}

function runRequest(
  permissions: ExternalAgentPermissionPolicy,
  provider = CODEX_PROVIDER,
): ExternalAgentRunRequest {
  return {
    provider,
    context: { input: "hi" } as never,
    instruction: "research",
    workingDirectory: "/repo",
    permissions,
  };
}

describe("Codex and Gemini CLI: read-only with allowNetwork", () => {
  test("Codex SDK keeps the read-only sandbox and passes the web search mode through", () => {
    expect(mapPolicyToCodexSdkThreadOptions(READ_ONLY_NETWORK)).toMatchObject({
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: true,
    });
    const options = new CodexSdkDriver({
      webSearchMode: "live",
    }).buildThreadOptions(runRequest(READ_ONLY_NETWORK)) as Record<
      string,
      unknown
    >;
    expect(options.sandboxMode).toBe("read-only");
    expect(options.webSearchMode).toBe("live");
  });

  test("Codex SDK disables web search under read-only without the network", () => {
    const options = new CodexSdkDriver({
      webSearchMode: "live",
    }).buildThreadOptions(runRequest({ mode: "read-only" })) as Record<
      string,
      unknown
    >;
    expect(options.webSearchMode).toBe("disabled");
  });

  test("Codex CLI keeps the read-only sandbox and leaves web search on", async () => {
    const args = mapPolicyToCodexArgs(READ_ONLY_NETWORK);
    expect(args).toContain("read-only");
    expect(args).not.toContain('web_search="disabled"');
    const { spawn, runs } = recordingSpawn();
    await collect(
      new CodexCliDriver({ spawn: spawn as CodexCliSpawn }).run(
        runRequest(READ_ONLY_NETWORK),
      ),
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).not.toContain('web_search="disabled"');
  });

  test("Gemini CLI runs read-only with the network in plan mode, sandboxed", async () => {
    const { spawn, runs } = recordingSpawn();
    const events = await collect(
      new GeminiCliDriver({ spawn: spawn as GeminiCliSpawn }).run(
        runRequest(READ_ONLY_NETWORK, GEMINI_CLI_PROVIDER),
      ),
    );
    expect(events.find((event) => event.type === "error")).toBeUndefined();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain("--approval-mode=plan");
    expect(runs[0]).toContain("--sandbox");
  });
});

describe("read-only with allowNetwork: a path outside allowedPaths still wins", () => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "web-paths-")));
  afterAll(() => rmSync(workspace, { recursive: true, force: true }));
  const policy: ExternalAgentPermissionPolicy = {
    ...READ_ONLY_NETWORK,
    allowedPaths: [workspace],
  };
  const outside = "/etc/passwd";

  test("the guard denies a web tool whose input names an outside path, with the path reason", () => {
    for (const tool of WEB_TOOLS) {
      const decision = guardPermissionRequest(
        policy,
        request(tool, { url: "https://example.com", path: outside }),
        { workingDirectory: workspace },
      );
      expect(decision?.behavior).toBe("deny");
      expect(decision?.behavior === "deny" && decision.message).toContain(
        outside,
      );
    }
  });

  test("the guard still lets a web tool with only a URL through", () => {
    expect(
      guardPermissionRequest(
        policy,
        request("WebFetch", { url: "https://example.com" }),
        { workingDirectory: workspace },
      ),
    ).toBeUndefined();
  });

  test("the agent denies it with the path reason and does not ask the approver", async () => {
    const asked: string[] = [];
    const decisions: PermissionDecision[] = [];
    const driver: ExternalAgentDriver = {
      providerId: CODEX_PROVIDER.id,
      async *run(runRequest: ExternalAgentRunRequest) {
        for (const input of [
          { url: "https://example.com", path: outside },
          { url: "https://example.com" },
        ]) {
          const decision = await runRequest.requestPermission?.({
            requestId: "call-web",
            toolName: "WebFetch",
            input,
          });
          if (decision) decisions.push(decision);
        }
        yield { type: "output" as const, content: "done" };
      },
    };
    await runAgent(driver, policy, {
      workingDirectory: workspace,
      confirmation: {
        approver: (req: PermissionRequest) => {
          asked.push(req.toolName);
          return true;
        },
      },
    });
    expect(asked).toEqual([]);
    expect(decisions).toHaveLength(2);
    expect(decisions[0]?.behavior).toBe("deny");
    expect(decisions[0]?.behavior === "deny" && decisions[0].message).toContain(
      outside,
    );
    expect(decisions[1]).toEqual({ behavior: "allow" });
  });
});
