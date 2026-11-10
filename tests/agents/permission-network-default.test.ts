import { describe, expect, test } from "bun:test";
import { type BaseAgent, InMemorySessionService, Runner } from "@google/adk";
import { ClaudeAgentSdkDriver } from "../../src/agents/driver/claude-agent-sdk.js";
import { ClaudeCliDriver } from "../../src/agents/driver/claude-cli.js";
import {
  CLAUDE_NO_NETWORK_SANDBOX,
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
import { guardPermissionRequest } from "../../src/agents/permissions/confirmation.js";
import {
  deriveSubAgentPermissionPolicy,
  resolveEffectivePermissions,
} from "../../src/agents/permissions/inheritance.js";
import type { ExternalAgentPermissionPolicy } from "../../src/agents/permissions/schema.js";
import { GEMINI_CLI_PROVIDER } from "../../src/agents/provider/gemini-cli.js";
import {
  CLAUDE_PROVIDER,
  CODEX_PROVIDER,
} from "../../src/agents/provider/schema.js";
import { defineWorkflow } from "../../src/workflows/definition.js";
import { WorkflowAgent } from "../../src/workflows/workflow-agent.js";

/**
 * Network is off unless a policy sets `allowNetwork: true`: an unset value,
 * or no policy at all, behaves exactly like `allowNetwork: false` at the
 * root, in workflow steps, in delegated children and in every driver.
 */

const UNSET: ExternalAgentPermissionPolicy = { mode: "workspace-write" };

class CaptureDriver implements ExternalAgentDriver {
  readonly providerId = CODEX_PROVIDER.id;
  request?: ExternalAgentRunRequest;

  async *run(request: ExternalAgentRunRequest) {
    this.request = request;
    yield { type: "output" as const, content: "done" };
  }
}

function capture(
  name: string,
  permissions?: ExternalAgentPermissionPolicy,
): { agent: ExternalAgent; driver: CaptureDriver } {
  const driver = new CaptureDriver();
  const agent = new ExternalAgent({
    name,
    provider: CODEX_PROVIDER,
    driver,
    ...(permissions ? { permissions } : {}),
  });
  return { agent, driver };
}

async function runRoot(agent: BaseAgent): Promise<void> {
  const sessions = new InMemorySessionService();
  const runner = new Runner({
    appName: "network-default",
    agent,
    sessionService: sessions,
  });
  const session = await sessions.createSession({
    appName: "network-default",
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

function request(
  permissions: ExternalAgentPermissionPolicy | undefined,
  provider = CODEX_PROVIDER,
): ExternalAgentRunRequest {
  return {
    provider,
    context: { input: "hi" } as never,
    instruction: "do it",
    workingDirectory: "/repo",
    ...(permissions ? { permissions } : {}),
  };
}

async function collect(
  run: AsyncIterable<ExternalAgentEvent>,
): Promise<ExternalAgentEvent[]> {
  const events: ExternalAgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

/** A spawn that records runs and answers `mcp list --json` with `listing`. */
function recordingSpawn(listing = "[]") {
  const state = { spawned: 0, listed: 0, runArgs: [] as string[][] };
  const spawn = (_command: string, args: readonly string[]) => {
    const isListing = args[0] === "mcp" && args[1] === "list";
    if (isListing) state.listed++;
    else {
      state.spawned++;
      state.runArgs.push([...args]);
    }
    return {
      stdout: (async function* () {
        if (isListing) yield listing;
      })(),
      stderr: null,
      exited: Promise.resolve(0),
    };
  };
  return { spawn, state };
}

const HOST_SERVERS = JSON.stringify([
  { name: "web-srv", enabled: true, transport: { type: "stdio" } },
]);

describe("effective policy: an unset allowNetwork is false", () => {
  test("a root agent's own policy without allowNetwork resolves to false", () => {
    expect(resolveEffectivePermissions(undefined, UNSET)).toEqual({
      mode: "workspace-write",
      allowNetwork: false,
    });
  });

  test("an explicit allowNetwork: true at the root keeps the network", () => {
    expect(
      resolveEffectivePermissions(undefined, {
        mode: "ask",
        allowNetwork: true,
      }),
    ).toEqual({ mode: "ask", allowNetwork: true });
  });

  test("a root ExternalAgent without allowNetwork runs with it false", async () => {
    const { agent, driver } = capture("root_agent", UNSET);
    await runRoot(agent);
    expect(driver.request?.permissions).toEqual({
      mode: "workspace-write",
      allowNetwork: false,
    });
  });

  test("a delegated child under a parent with allowNetwork unset gets false", () => {
    expect(
      deriveSubAgentPermissionPolicy(UNSET, {
        mode: "workspace-write",
        allowNetwork: true,
      }).allowNetwork,
    ).toBe(false);
  });

  test("a static child of an ExternalAgent cannot turn the network on", async () => {
    const child = capture("child", { mode: "ask", allowNetwork: true });
    new ExternalAgent({
      name: "parent",
      provider: CODEX_PROVIDER,
      driver: new CaptureDriver(),
      permissions: UNSET,
      subAgents: [child.agent],
    });
    await runRoot(child.agent);
    expect(child.driver.request?.permissions?.allowNetwork).toBe(false);
  });

  test("a step under a root WorkflowAgent: unset means false, explicit true stays", async () => {
    const unset = capture("unset", UNSET);
    const open = capture("open", {
      mode: "workspace-write",
      allowNetwork: true,
    });
    const workflow = new WorkflowAgent({
      name: "root_workflow",
      subAgents: [unset.agent, open.agent],
      definition: defineWorkflow({
        id: "root",
        version: "1",
        handler: async (ctx) => {
          await ctx.run({ id: "a", agentName: "unset", input: ctx.input });
          await ctx.run({ id: "b", agentName: "open", input: ctx.input });
          return "done";
        },
      }),
    });
    await runRoot(workflow);
    expect(unset.driver.request?.permissions).toEqual({
      mode: "workspace-write",
      allowNetwork: false,
    });
    // A root WorkflowAgent is not a ceiling: an explicit opt-in keeps network.
    expect(open.driver.request?.permissions).toEqual({
      mode: "workspace-write",
      allowNetwork: true,
    });
  });
});

describe("the permission guard treats unset and no policy as no network", () => {
  for (const [label, policy] of [
    ["allowNetwork unset", UNSET],
    ["no policy", undefined],
  ] as const) {
    test(`${label}: web, non-bridge MCP and unsandboxed shell are denied`, () => {
      for (const toolName of ["WebFetch", "mcp__web__get", "Bash"]) {
        expect(
          guardPermissionRequest(policy, {
            requestId: "r",
            toolName,
            input: { command: "curl x", url: "https://x" },
          })?.behavior,
        ).toBe("deny");
      }
    });
  }
});

describe("Claude drivers default to no network", () => {
  const ISOLATED = { inheritHostConfig: false, allowUnsandboxedShell: false };

  for (const [label, policy] of [
    ["allowNetwork unset", UNSET],
    ["no policy", undefined],
  ] as const) {
    test(`${label}: web tools are removed and Bash is sandboxed`, () => {
      const plan = planClaudeIsolation(policy, ISOLATED);
      expect(plan.tools).not.toContain("WebFetch");
      expect(plan.tools).not.toContain("WebSearch");
      expect(plan.disallowedTools).toEqual(["WebFetch", "WebSearch"]);
      expect(plan.sandbox).toEqual(CLAUDE_NO_NETWORK_SANDBOX);
      expect(plan.networkSandbox).toBe("enforced");
    });
  }

  test("allowNetwork: true keeps the web tools and runs Bash unsandboxed", () => {
    const plan = planClaudeIsolation(
      { mode: "workspace-write", allowNetwork: true },
      ISOLATED,
    );
    expect(plan.tools).toContain("WebFetch");
    expect(plan.sandbox).toBeUndefined();
  });

  test("Claude Agent SDK passes the no-network sandbox when unset", () => {
    const options = new ClaudeAgentSdkDriver().buildOptions(
      request(UNSET, CLAUDE_PROVIDER),
    ) as Record<string, unknown>;
    expect(options.sandbox).toEqual(CLAUDE_NO_NETWORK_SANDBOX);
    expect(options.disallowedTools).toEqual(["WebFetch", "WebSearch"]);
  });

  test("Claude CLI puts the no-network sandbox in --settings when unset", () => {
    const args = new ClaudeCliDriver().buildArgs(
      request(UNSET, CLAUDE_PROVIDER),
    );
    const settings = args.find((arg) => arg.startsWith("--settings="));
    expect(
      JSON.parse(settings?.slice("--settings=".length) ?? "{}").sandbox,
    ).toEqual(CLAUDE_NO_NETWORK_SANDBOX);
    expect(args).toContain("--disallowedTools=WebFetch,WebSearch");
  });
});

describe("Codex drivers default to no network", () => {
  test("Codex CLI pins the sandbox network and web search off when unset", () => {
    for (const policy of [UNSET, undefined]) {
      expect(mapPolicyToCodexArgs(policy).slice(-4)).toEqual([
        "-c",
        "sandbox_workspace_write.network_access=false",
        "-c",
        'web_search="disabled"',
      ]);
    }
  });

  test("Codex CLI turns host MCP servers off when unset", async () => {
    const { spawn, state } = recordingSpawn(HOST_SERVERS);
    await collect(
      new CodexCliDriver({ spawn: spawn as CodexCliSpawn }).run(request(UNSET)),
    );
    expect(state.listed).toBe(1);
    expect(state.runArgs[0]).toContain("mcp_servers.web-srv.enabled=false");
  });

  test("Codex CLI refuses full-access when unset unless allowUnenforcedNetwork", async () => {
    const refused = recordingSpawn();
    const events = await collect(
      new CodexCliDriver({ spawn: refused.spawn as CodexCliSpawn }).run(
        request({ mode: "full-access" }),
      ),
    );
    expect(refused.state.spawned).toBe(0);
    expect(events.find((event) => event.type === "error")).toMatchObject({
      code: EXTERNAL_AGENT_NETWORK_UNENFORCEABLE,
    });

    const waived = recordingSpawn();
    await collect(
      new CodexCliDriver({
        spawn: waived.spawn as CodexCliSpawn,
        allowUnenforcedNetwork: true,
      }).run(request({ mode: "full-access" })),
    );
    expect(waived.state.spawned).toBe(1);
  });

  test("Codex SDK disables network access and web search when unset", () => {
    expect(mapPolicyToCodexSdkThreadOptions(UNSET).networkAccessEnabled).toBe(
      false,
    );
    const options = new CodexSdkDriver({
      webSearchMode: "live",
    }).buildThreadOptions(request(UNSET)) as Record<string, unknown>;
    expect(options.networkAccessEnabled).toBe(false);
    expect(options.webSearchMode).toBe("disabled");
  });

  test("Codex SDK refuses a prebuilt client and full-access when unset", async () => {
    const sdk = {
      startThread: () => {
        throw new Error("should not start");
      },
      resumeThread: () => {
        throw new Error("should not resume");
      },
    };
    for (const policy of [UNSET, { mode: "full-access" as const }]) {
      const events = await collect(
        new CodexSdkDriver({ sdk }).run(request(policy)),
      );
      expect(events.find((event) => event.type === "error")).toMatchObject({
        code: EXTERNAL_AGENT_NETWORK_UNENFORCEABLE,
      });
    }
  });
});

describe("Gemini CLI is refused by default", () => {
  for (const [label, policy] of [
    ["allowNetwork unset", UNSET],
    ["no policy", undefined],
  ] as const) {
    test(`${label}: refused with a message naming allowNetwork: true`, async () => {
      const { spawn, state } = recordingSpawn();
      const events = await collect(
        new GeminiCliDriver({ spawn: spawn as GeminiCliSpawn }).run(
          request(policy, GEMINI_CLI_PROVIDER),
        ),
      );
      expect(state.spawned).toBe(0);
      const error = events.find((event) => event.type === "error");
      expect(error).toMatchObject({
        code: EXTERNAL_AGENT_NETWORK_UNENFORCEABLE,
      });
      expect((error as { message: string }).message).toContain(
        "allowNetwork: true",
      );
    });
  }

  test("allowNetwork: true runs", async () => {
    const { spawn, state } = recordingSpawn();
    await collect(
      new GeminiCliDriver({ spawn: spawn as GeminiCliSpawn }).run(
        request({ mode: "ask", allowNetwork: true }, GEMINI_CLI_PROVIDER),
      ),
    );
    expect(state.spawned).toBe(1);
  });
});
