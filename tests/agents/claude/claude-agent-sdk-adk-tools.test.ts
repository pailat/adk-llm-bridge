import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type BaseTool,
  BaseToolset,
  FunctionTool,
  GOOGLE_SEARCH,
  type InvocationContext,
  LongRunningFunctionTool,
  resetLogger,
} from "@google/adk";
import { z } from "zod";
import {
  CLAUDE_AGENT_DEFINITION,
  ClaudeAgent,
} from "../../../src/agents/claude-agent.js";
import { CODEX_AGENT_DEFINITION } from "../../../src/agents/codex-agent.js";
import {
  ClaudeAgentSdkDriver,
  type ClaudeAgentSdkDriverConfig,
  claudeSdkSessionStateKey,
} from "../../../src/agents/driver/claude-agent-sdk.js";
import { CodexSdkDriver } from "../../../src/agents/driver/codex-sdk.js";
import { FxCliDriver } from "../../../src/agents/driver/fx-cli.js";
import { ExternalAgent } from "../../../src/agents/external-agent.js";
import { FX_AGENT_DEFINITION } from "../../../src/agents/fx-agent.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/schema.js";
import { createAdkToolBridge } from "../../../src/agents/tools/adk-tool-bridge.js";
import { captureWarnings } from "../../helpers/fake-logger.js";

type Handler = (args: Record<string, unknown>) => Promise<unknown>;
type SdkToolHandler = Parameters<
  NonNullable<NonNullable<ClaudeAgentSdkDriverConfig["sdk"]>["tool"]>
>[3];

function fakeSdk() {
  const handlers = new Map<string, Handler>();
  const schemas = new Map<string, Record<string, unknown>>();
  return {
    handlers,
    schemas,
    sdk: {
      query: () => (async function* () {})() as never,
      tool: (
        name: string,
        _description: string,
        schema: Record<string, unknown>,
        handler: SdkToolHandler,
      ) => {
        handlers.set(name, (args) => handler(args, undefined));
        schemas.set(name, schema);
        return { name };
      },
      createSdkMcpServer: (options: Record<string, unknown>) => options,
    },
  };
}

function invocation(state: Record<string, unknown> = {}): InvocationContext {
  return {
    invocationId: "inv-1",
    agent: { name: "claude" },
    session: { id: "s1", state, events: [] },
  } as unknown as InvocationContext;
}

const weather = new FunctionTool({
  name: "get_weather",
  description: "Weather for a city.",
  parameters: z.object({ city: z.string() }),
  execute: ({ city }, toolContext) => {
    toolContext?.state.set("last_city", city);
    return { city, temp: 21 };
  },
});

const deleteAll = new FunctionTool({
  name: "delete_all",
  description: "Dangerous.",
  parameters: z.object({}),
  requireConfirmation: true,
  execute: () => ({ deleted: true }),
});

class ListToolset extends BaseToolset {
  constructor(private readonly members: BaseTool[]) {
    super([]);
  }
  async getTools() {
    return this.members;
  }
  async close() {}
}

async function setup(
  overrides: Partial<
    Parameters<ClaudeAgentSdkDriver["buildOptionsForRun"]>[0]
  > = {},
) {
  const context = invocation();
  const adkTools = await createAdkToolBridge([weather, deleteAll], context);
  const stateDeltas: Array<Record<string, unknown>> = [];
  const { sdk, handlers, schemas } = fakeSdk();
  const driver = new ClaudeAgentSdkDriver({ sdk });
  const request = {
    provider: CLAUDE_PROVIDER,
    context,
    adkTools,
    emitStateDelta: (delta: Record<string, unknown>) => stateDeltas.push(delta),
    ...overrides,
  };
  const options = await driver.buildOptionsForRun(request, sdk);
  return { options, handlers, schemas, stateDeltas, adkTools };
}

describe("Claude SDK driver hosts ADK tools", () => {
  test("registers ADK tools on the adk_bridge MCP server and pre-authorizes them", async () => {
    const { options, schemas } = await setup();

    expect(options.mcpServers?.adk_bridge).toMatchObject({
      name: "adk_bridge",
      tools: [
        { name: "adk_tool__get_weather" },
        { name: "adk_tool__delete_all" },
      ],
    });
    expect(options.allowedTools).toEqual([
      "mcp__adk_bridge__adk_tool__get_weather",
      "mcp__adk_bridge__adk_tool__delete_all",
    ]);
    // JSON Schema was translated into a zod raw shape.
    expect(Object.keys(schemas.get("adk_tool__get_weather") ?? {})).toEqual([
      "city",
    ]);
  });

  test("a tool call runs the ADK tool and publishes its state delta", async () => {
    const { handlers, stateDeltas } = await setup();

    const result = await handlers.get("adk_tool__get_weather")?.({
      city: "Paris",
    });

    expect(result).toEqual({
      content: [
        { type: "text", text: JSON.stringify({ city: "Paris", temp: 21 }) },
      ],
    });
    expect(stateDeltas).toEqual([{ last_city: "Paris" }]);
  });

  test("a tool that requires confirmation is denied without an approver", async () => {
    const { handlers } = await setup();

    const result = (await handlers.get("adk_tool__delete_all")?.({})) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("no approver");
  });

  test("an approved confirmation runs the tool; a rejected one does not", async () => {
    const asked: string[] = [];
    const allow = await setup({
      requestPermission: async (request) => {
        asked.push(request.toolName);
        return { behavior: "allow" };
      },
    });
    const approved = (await allow.handlers.get("adk_tool__delete_all")?.(
      {},
    )) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(asked).toEqual(["adk_tool__delete_all"]);
    expect(approved.isError).toBeUndefined();
    expect(approved.content[0]?.text).toContain("deleted");

    const deny = await setup({
      requestPermission: async () => ({ behavior: "deny", message: "nope" }),
    });
    const rejected = (await deny.handlers.get("adk_tool__delete_all")?.(
      {},
    )) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0]?.text).toContain("nope");
  });

  test("a failing permission request counts as a denial", async () => {
    const { handlers } = await setup({
      requestPermission: async () => {
        throw new Error("boom");
      },
    });
    const result = (await handlers.get("adk_tool__delete_all")?.({})) as {
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
  });

  test("no ADK tools and no sub-agents leaves the options untouched", async () => {
    const { sdk } = fakeSdk();
    const driver = new ClaudeAgentSdkDriver({ sdk });
    const options = await driver.buildOptionsForRun(
      { provider: CLAUDE_PROVIDER, context: invocation() },
      sdk,
    );
    expect(options.mcpServers).toBeUndefined();
  });
});

describe("ExternalAgent read-only exposure of ADK tools", () => {
  async function exposed(
    permissions: { mode: "read-only" | "ask" },
    readOnlyTools?: string[],
  ) {
    let names: string[] = [];
    const agent = new ExternalAgent({
      name: "claude",
      provider: CLAUDE_PROVIDER,
      permissions,
      tools: [weather, deleteAll],
      readOnlyTools,
      driver: {
        providerId: CLAUDE_PROVIDER.id,
        async *run(request) {
          names = (request.adkTools?.declarations ?? []).map((d) => d.name);
          yield { type: "completed", exitCode: 0 };
        },
      },
    });
    for await (const _event of agent.runAsync(invocationForAgent(agent))) {
      // drain
    }
    return names;
  }

  function invocationForAgent(agent: ExternalAgent): InvocationContext {
    return {
      invocationId: "inv-1",
      agent,
      session: { id: "s1", appName: "a", userId: "u", state: {}, events: [] },
    } as unknown as InvocationContext;
  }

  test("outside read-only every tool is exposed", async () => {
    expect(await exposed({ mode: "ask" })).toEqual([
      "adk_tool__get_weather",
      "adk_tool__delete_all",
    ]);
  });

  test("in read-only only listed tools are exposed, and an unlisted direct tool is refused at construction", async () => {
    // The agent that used to expose [] and drop both tools
    // silently now refuses to be built.
    await expect(exposed({ mode: "read-only" })).rejects.toMatchObject({
      code: "EXTERNAL_AGENT_TOOL_NOT_READ_ONLY",
    });
    await expect(
      exposed({ mode: "read-only" }, ["get_weather"]),
    ).rejects.toMatchObject({ code: "EXTERNAL_AGENT_TOOL_NOT_READ_ONLY" });
    expect(
      await exposed({ mode: "read-only" }, ["get_weather", "delete_all"]),
    ).toEqual(["adk_tool__get_weather", "adk_tool__delete_all"]);
  });

  test("an allow-listed name does not expose longer names that share its prefix", async () => {
    const longer = new FunctionTool({
      name: "get_weather_forecast",
      description: "Forecast.",
      parameters: z.object({}),
      execute: () => ({}),
    });
    let names: string[] = [];
    const agent = new ExternalAgent({
      name: "claude",
      provider: CLAUDE_PROVIDER,
      permissions: { mode: "read-only" },
      // Behind a toolset: a direct unlisted tool would be refused at
      // construction, the run-time filter is still what matters.
      tools: [new ListToolset([weather, longer])],
      readOnlyTools: ["get_weather"],
      driver: {
        providerId: CLAUDE_PROVIDER.id,
        async *run(request) {
          names = (request.adkTools?.declarations ?? []).map((d) => d.name);
          yield { type: "completed", exitCode: 0 };
        },
      },
    });
    for await (const _event of agent.runAsync(invocationForAgent(agent))) {
      // drain
    }
    expect(names).toEqual(["adk_tool__get_weather"]);
  });

  async function exposedWith(
    tools: ConstructorParameters<typeof ExternalAgent>[0]["tools"],
    readOnlyTools: string[],
  ) {
    let names: string[] = [];
    let ran: string | undefined;
    const agent = new ExternalAgent({
      name: "claude",
      provider: CLAUDE_PROVIDER,
      permissions: { mode: "read-only" },
      tools,
      readOnlyTools,
      driver: {
        providerId: CLAUDE_PROVIDER.id,
        async *run(request) {
          names = (request.adkTools?.declarations ?? []).map((d) => d.name);
          const result = await request.adkTools?.execute(
            "adk_tool__get_2",
            {},
            request.context,
          );
          ran = result?.status;
          yield { type: "completed", exitCode: 0 };
        },
      },
    });
    for await (const _event of agent.runAsync(invocationForAgent(agent))) {
      // drain
    }
    return { names, ran };
  }

  test("an allow-listed name does not expose a tool literally named like its collision suffix", async () => {
    const executed: string[] = [];
    const get = new FunctionTool({
      name: "get",
      description: "Read.",
      parameters: z.object({}),
      execute: () => ({}),
    });
    const get2 = new FunctionTool({
      name: "get_2",
      description: "Writes, despite its name.",
      parameters: z.object({}),
      execute: () => {
        executed.push("get_2");
        return {};
      },
    });
    const { names, ran } = await exposedWith(
      [new ListToolset([get, get2])],
      ["get"],
    );
    expect(names).toEqual(["adk_tool__get"]);
    expect(ran).toBe("error");
    expect(executed).toEqual([]);
  });

  test("toolset members are filtered by their own names in read-only", async () => {
    class Toolset extends BaseToolset {
      constructor(private readonly members: BaseTool[]) {
        super([]);
      }
      async getTools() {
        return this.members;
      }
      async close() {}
    }
    const { names } = await exposedWith(
      [new Toolset([weather, deleteAll])],
      ["get_weather"],
    );
    expect(names).toEqual(["adk_tool__get_weather"]);
  });

  test("a toolset that fails once is skipped in read-only, never listed again unfiltered", async () => {
    let deleted = 0;
    const deleteEverything = new FunctionTool({
      name: "delete_everything",
      description: "Writes.",
      parameters: z.object({}),
      execute: () => {
        deleted++;
        return { ok: true };
      },
    });
    class FlakyToolset extends BaseToolset {
      calls = 0;
      constructor() {
        super([]);
      }
      async getTools() {
        if (this.calls++ === 0) throw new Error("transient");
        return [deleteEverything];
      }
      async close() {}
    }
    const toolset = new FlakyToolset();
    let names: string[] = [];
    let skipped: unknown;
    let status: string | undefined;
    const agent = new ExternalAgent({
      name: "claude",
      provider: CLAUDE_PROVIDER,
      permissions: { mode: "read-only" },
      tools: [toolset],
      readOnlyTools: [],
      driver: {
        providerId: CLAUDE_PROVIDER.id,
        async *run(request) {
          names = (request.adkTools?.declarations ?? []).map((d) => d.name);
          skipped = request.adkTools?.skipped;
          status = (
            await request.adkTools?.execute(
              "adk_tool__delete_everything",
              {},
              request.context,
            )
          )?.status;
          yield { type: "completed", exitCode: 0 };
        },
      },
    });
    for await (const _event of agent.runAsync(invocationForAgent(agent))) {
      // drain
    }
    expect(names).toEqual([]);
    expect(status).toBe("error");
    expect(deleted).toBe(0);
    expect(toolset.calls).toBe(1);
    expect(skipped).toEqual([
      {
        name: "FlakyToolset",
        reason: "toolset-failed",
        cause: new Error("transient"),
      },
    ]);
  });

  test("a hidden tool cannot be executed through the filtered bridge", async () => {
    let result: { status: string } | undefined;
    const agent = new ExternalAgent({
      name: "claude",
      provider: CLAUDE_PROVIDER,
      permissions: { mode: "read-only" },
      tools: [new ListToolset([weather])],
      driver: {
        providerId: CLAUDE_PROVIDER.id,
        async *run(request) {
          result = await request.adkTools?.execute(
            "adk_tool__get_weather",
            { city: "x" },
            request.context,
          );
          yield { type: "completed", exitCode: 0 };
        },
      },
    });
    for await (const _event of agent.runAsync(invocationForAgent(agent))) {
      // drain
    }
    expect(result?.status).toBe("error");
  });
});

describe("Claude SDK canUseTool and persisted resume", () => {
  test("canUseTool is absent without requestPermission and routes decisions otherwise", async () => {
    const driver = new ClaudeAgentSdkDriver({ sdk: fakeSdk().sdk });
    const base = { provider: CLAUDE_PROVIDER, context: invocation() };
    expect(driver.buildOptions(base).canUseTool).toBeUndefined();

    const seen: string[] = [];
    const withHost = driver.buildOptions({
      ...base,
      requestPermission: async (request) => {
        seen.push(`${request.toolName}:${request.requestId}`);
        return request.toolName === "Bash"
          ? { behavior: "allow" }
          : { behavior: "deny", message: "no" };
      },
    });
    const input = { command: "ls" };
    await expect(
      withHost.canUseTool?.("Bash", input, { toolUseID: "tu-1" }),
    ).resolves.toEqual({ behavior: "allow", updatedInput: input });
    await expect(
      withHost.canUseTool?.("Write", {}, { toolUseID: "tu-2" }),
    ).resolves.toEqual({ behavior: "deny", message: "no" });
    expect(seen).toEqual(["Bash:tu-1", "Write:tu-2"]);
  });

  test("a throwing host denies", async () => {
    const driver = new ClaudeAgentSdkDriver({ sdk: fakeSdk().sdk });
    const options = driver.buildOptions({
      provider: CLAUDE_PROVIDER,
      context: invocation(),
      requestPermission: async () => {
        throw new Error("boom");
      },
    });
    await expect(options.canUseTool?.("Bash", {}, {})).resolves.toMatchObject({
      behavior: "deny",
    });
  });

  test("the SDK session id is published in state and used to resume after a restart", async () => {
    const resumes: Array<string | undefined> = [];
    const makeDriver = () =>
      new ClaudeAgentSdkDriver({
        sdk: {
          query: ({ options }) => {
            resumes.push((options as { resume?: string }).resume);
            return (async function* () {
              yield {
                type: "system",
                subtype: "init",
                session_id: "sdk-42",
              } as never;
              yield {
                type: "result",
                subtype: "success",
                result: "ok",
                session_id: "sdk-42",
              } as never;
            })() as never;
          },
        },
      });
    const agent = { name: "claude" };
    const key = claudeSdkSessionStateKey("claude");

    const events = [];
    for await (const event of makeDriver().run({
      provider: CLAUDE_PROVIDER,
      agent: agent as never,
      context: invocation() as never,
      permissions: { mode: "ask" },
    })) {
      events.push(event);
    }
    expect(events.filter((e) => e.type === "state_delta")).toEqual([
      expect.objectContaining({ stateDelta: { [key]: "sdk-42" } }),
    ]);

    // A brand new driver instance (process restart) resumes from session state.
    for await (const _event of makeDriver().run({
      provider: CLAUDE_PROVIDER,
      agent: agent as never,
      context: invocation({ [key]: "sdk-42" }) as never,
      permissions: { mode: "ask" },
    })) {
      // drain
    }
    expect(resumes).toEqual([undefined, "sdk-42"]);
  });
});

describe("runtime capabilities are honest", () => {
  test("only the Claude SDK driver hosts ADK tools, sub-agents and approvals", () => {
    expect(new ClaudeAgentSdkDriver().capabilities()).toMatchObject({
      tools: true,
      subagents: true,
      mcpServers: true,
      approvals: true,
    });
    const codex = new CodexSdkDriver().capabilities();
    expect(codex.tools).toBeUndefined();
    expect(codex.mcpServers).toBeUndefined();
    expect(codex.approvals).toBeUndefined();
    expect(
      new FxCliDriver({ model: "anthropic/claude-haiku-4-5" }).capabilities()
        .tools,
    ).toBeUndefined();
  });

  test("definitions carry no capabilities: the driver is the only source", () => {
    for (const definition of [
      CLAUDE_AGENT_DEFINITION,
      CODEX_AGENT_DEFINITION,
      FX_AGENT_DEFINITION,
    ]) {
      expect(definition).not.toHaveProperty("capabilities");
    }
  });
});

describe("read-only agents and host tools", () => {
  const named = (name: string, executed?: string[]) =>
    new FunctionTool({
      name,
      description: `Tool ${name}.`,
      parameters: z.object({}),
      execute: () => {
        executed?.push(name);
        return { name };
      },
    });

  function contextFor(agent: ExternalAgent): InvocationContext {
    return {
      invocationId: "inv-1",
      agent,
      session: { id: "s1", appName: "a", userId: "u", state: {}, events: [] },
    } as unknown as InvocationContext;
  }

  interface RunSeen {
    names: string[];
    skipped: readonly { name: string; reason: string }[];
    statuses: Record<string, string>;
    metadata: Record<string, unknown> | undefined;
  }

  type AgentConfig = ConstructorParameters<typeof ExternalAgent>[0];

  /** Builds an agent and runs one turn; the driver tries to execute `probe` names. */
  async function runAgent(
    config: Partial<AgentConfig>,
    probe: string[] = [],
  ): Promise<RunSeen> {
    const seen: RunSeen = {
      names: [],
      skipped: [],
      statuses: {},
      metadata: undefined,
    };
    const agent = new ExternalAgent({
      name: "claude",
      provider: CLAUDE_PROVIDER,
      driver: {
        providerId: CLAUDE_PROVIDER.id,
        async *run(request) {
          seen.names = (request.adkTools?.declarations ?? []).map(
            (d) => d.name,
          );
          seen.skipped = request.adkTools?.skipped ?? [];
          for (const name of probe) {
            const result = await request.adkTools?.execute(
              name,
              {},
              request.context,
            );
            seen.statuses[name] = result?.status ?? "none";
          }
          yield { type: "output", content: "done" };
          yield { type: "completed", exitCode: 0 };
        },
      },
      ...config,
    } as AgentConfig);
    for await (const event of agent.runAsync(contextFor(agent))) {
      const tools = (
        event.customMetadata as Record<string, unknown> | undefined
      )?.externalAgentTools;
      if (tools) seen.metadata = tools as Record<string, unknown>;
    }
    return seen;
  }

  const build = (config: Partial<AgentConfig>) =>
    new ExternalAgent({
      name: "claude",
      provider: CLAUDE_PROVIDER,
      ...config,
    } as AgentConfig);

  function codeOf(fn: () => unknown): { code?: string; message: string } {
    try {
      fn();
    } catch (e) {
      return e as { code?: string; message: string };
    }
    throw new Error("did not throw");
  }

  // 1
  test("own read-only with unlisted tools and no readOnlyTools throws, naming every tool sorted", () => {
    const error = codeOf(() =>
      build({
        permissions: { mode: "read-only" },
        tools: [weather, deleteAll],
      }),
    );
    expect(error.code).toBe("EXTERNAL_AGENT_TOOL_NOT_READ_ONLY");
    expect(error.message).toContain("delete_all, get_weather");
    expect(error.message).toContain("readOnlyTools");
  });

  // 2
  test("own read-only names only the unlisted tool", () => {
    const error = codeOf(() =>
      build({
        permissions: { mode: "read-only" },
        tools: [weather, deleteAll],
        readOnlyTools: ["get_weather"],
      }),
    );
    expect(error.code).toBe("EXTERNAL_AGENT_TOOL_NOT_READ_ONLY");
    expect(error.message).toContain("delete_all");
    expect(error.message).not.toContain("get_weather");
  });

  // 3
  test("own read-only with every tool listed constructs and exposes exactly the list", async () => {
    const seen = await runAgent({
      permissions: { mode: "read-only" },
      tools: [weather, deleteAll],
      readOnlyTools: ["get_weather", "delete_all"],
    });
    expect(seen.names).toEqual([
      "adk_tool__get_weather",
      "adk_tool__delete_all",
    ]);
    expect(seen.metadata).toBeUndefined();
  });

  // 4
  test("a typo in readOnlyTools throws with direct tools only, and is reported with a toolset", async () => {
    for (const permissions of [
      { mode: "read-only" },
      { mode: "workspace-write" },
    ] as const) {
      const error = codeOf(() =>
        build({ permissions, tools: [weather], readOnlyTools: ["get_wether"] }),
      );
      expect(error.code).toBe("EXTERNAL_AGENT_READ_ONLY_TOOL_UNKNOWN");
      expect(error.message).toContain("get_wether");
    }
    const seen = await runAgent({
      permissions: { mode: "read-only" },
      tools: [new ListToolset([weather])],
      readOnlyTools: ["get_wether", "get_weather"],
    });
    expect(seen.names).toEqual(["adk_tool__get_weather"]);
    expect(seen.metadata).toEqual({
      hidden: [],
      unmatchedReadOnlyTools: ["get_wether"],
      reason: "read-only",
    });
  });

  // 5
  test("empty and duplicate readOnlyTools entries throw READ_ONLY_TOOL_UNKNOWN", () => {
    for (const readOnlyTools of [
      ["", "get_weather"],
      ["get_weather", "get_weather"],
    ]) {
      expect(
        codeOf(() => build({ tools: [weather], readOnlyTools })).code,
      ).toBe("EXTERNAL_AGENT_READ_ONLY_TOOL_UNKNOWN");
    }
    // With no tools at all, any entry names nothing.
    expect(codeOf(() => build({ readOnlyTools: ["x"] })).code).toBe(
      "EXTERNAL_AGENT_READ_ONLY_TOOL_UNKNOWN",
    );
  });

  // 6
  test("an unknown entry is reported before an undeclared tool", () => {
    const error = codeOf(() =>
      build({
        permissions: { mode: "read-only" },
        tools: [weather, deleteAll],
        readOnlyTools: ["get_wether"],
      }),
    );
    expect(error.code).toBe("EXTERNAL_AGENT_READ_ONLY_TOOL_UNKNOWN");
  });

  // 7
  test("an inherited read-only policy hides the tool, constructs, runs and reports it", async () => {
    const executed: string[] = [];
    const child = new ExternalAgent({
      name: "child",
      provider: CLAUDE_PROVIDER,
      permissions: { mode: "workspace-write", allowNetwork: false },
      tools: [named("delete_all", executed)],
      driver: {
        providerId: CLAUDE_PROVIDER.id,
        async *run(request) {
          expect(request.adkTools?.declarations).toEqual([]);
          const result = await request.adkTools?.execute(
            "adk_tool__delete_all",
            {},
            request.context,
          );
          expect(result?.status).toBe("error");
          yield { type: "output", content: "done" };
          yield { type: "completed", exitCode: 0 };
        },
      },
    });
    new ExternalAgent({
      name: "parent",
      provider: CLAUDE_PROVIDER,
      permissions: { mode: "read-only", allowNetwork: false },
      subAgents: [child],
    });
    let metadata: unknown;
    for await (const event of child.runAsync(contextFor(child))) {
      const tools = (
        event.customMetadata as Record<string, unknown> | undefined
      )?.externalAgentTools;
      if (tools) metadata = tools;
    }
    expect(executed).toEqual([]);
    expect(metadata).toEqual({ hidden: ["delete_all"], reason: "read-only" });
  });

  // 8
  test("a toolset under own read-only exposes the listed tool and reports the unlisted one", async () => {
    const seen = await runAgent({
      permissions: { mode: "read-only" },
      tools: [new ListToolset([weather, deleteAll])],
      readOnlyTools: ["get_weather"],
    });
    expect(seen.names).toEqual(["adk_tool__get_weather"]);
    expect(seen.metadata).toEqual({
      hidden: ["delete_all"],
      reason: "read-only",
    });
  });

  // 9
  test("nothing hidden means no externalAgentTools key", async () => {
    const seen = await runAgent({
      permissions: { mode: "read-only" },
      tools: [weather],
      readOnlyTools: ["get_weather"],
    });
    expect(seen.metadata).toBeUndefined();
    const open = await runAgent({ tools: [weather, deleteAll] });
    expect(open.metadata).toBeUndefined();
  });

  // 12
  test("bridge tools are pre-approved under read-only with the network off, and the guard is never asked", async () => {
    const exposed = "mcp__adk_bridge__adk_tool__get_weather";
    const permissions = { mode: "read-only", allowNetwork: false } as const;
    const context = invocation();
    const adkTools = await createAdkToolBridge([weather], context);
    const { sdk } = fakeSdk();
    const driver = new ClaudeAgentSdkDriver({ sdk });

    // Without a permission callback the bridge tool is in allowedTools.
    const plain = await driver.buildOptionsForRun(
      { provider: CLAUDE_PROVIDER, context, adkTools, permissions },
      sdk,
    );
    expect(plain.mcpServers).toHaveProperty("adk_bridge");
    expect(plain.allowedTools).toContain(exposed);

    // With one, canUseTool allows it itself: the host's guard, whose
    // read-only rule denies everything, is never called for it.
    const asked: string[] = [];
    const guarded = await driver.buildOptionsForRun(
      {
        provider: CLAUDE_PROVIDER,
        context,
        adkTools,
        permissions,
        requestPermission: async (request) => {
          asked.push(request.toolName);
          return { behavior: "deny", message: "read-only" } as never;
        },
      },
      sdk,
    );
    const extra = {
      signal: new AbortController().signal,
      toolUseID: "t1",
    } as never;
    expect((await guarded.canUseTool?.(exposed, {}, extra))?.behavior).toBe(
      "allow",
    );
    expect(asked).toEqual([]);
    // The spy is live: any other tool does reach the guard.
    await guarded.canUseTool?.("Write", { file_path: "/x" }, extra);
    expect(asked).toEqual(["Write"]);
  });

  // 13
  test("the documented example constructs and keeps its declaration", () => {
    const agent = new ClaudeAgent({
      name: "reviewer",
      permissions: { mode: "read-only" },
      tools: [named("reui_get_component"), named("reui_validate_usage")],
      readOnlyTools: ["reui_get_component", "reui_validate_usage"],
    });
    expect(agent.readOnlyTools).toEqual([
      "reui_get_component",
      "reui_validate_usage",
    ]);
  });

  // The run-time filter on direct tools, under an inherited read-only.
  async function inheritedExposure(
    tools: BaseTool[],
    readOnlyTools: string[],
    probe: string[] = [],
  ) {
    const seen = {
      names: [] as string[],
      statuses: {} as Record<string, string>,
    };
    const child = new ExternalAgent({
      name: "child",
      provider: CLAUDE_PROVIDER,
      permissions: { mode: "workspace-write", allowNetwork: false },
      tools,
      readOnlyTools,
      driver: {
        providerId: CLAUDE_PROVIDER.id,
        async *run(request) {
          seen.names = (request.adkTools?.declarations ?? []).map(
            (d) => d.name,
          );
          for (const name of probe) {
            seen.statuses[name] =
              (await request.adkTools?.execute(name, {}, request.context))
                ?.status ?? "none";
          }
          yield { type: "completed", exitCode: 0 };
        },
      },
    });
    new ExternalAgent({
      name: "parent",
      provider: CLAUDE_PROVIDER,
      permissions: { mode: "read-only", allowNetwork: false },
      subAgents: [child],
    });
    for await (const _event of child.runAsync(contextFor(child))) {
      // drain
    }
    return seen;
  }

  test("under an inherited read-only, a listed direct tool does not expose a longer name sharing its prefix", async () => {
    const seen = await inheritedExposure(
      [weather, named("get_weather_forecast")],
      ["get_weather"],
    );
    expect(seen.names).toEqual(["adk_tool__get_weather"]);
  });

  test("under an inherited read-only, a listed direct tool does not expose one named like its collision suffix", async () => {
    const executed: string[] = [];
    const seen = await inheritedExposure(
      [named("get"), named("get_2", executed)],
      ["get"],
      ["adk_tool__get_2"],
    );
    expect(seen.names).toEqual(["adk_tool__get"]);
    expect(seen.statuses.adk_tool__get_2).toBe("error");
    expect(executed).toEqual([]);
  });

  describe("hidden tools are always logged, whatever the run does", () => {
    let warnings: ReturnType<typeof captureWarnings>;
    beforeEach(() => {
      warnings = captureWarnings();
    });
    afterEach(() => {
      resetLogger();
    });

    const hiddenWarnings = () =>
      warnings.mock.calls
        .map((call, index) => ({
          text: String(call[0]),
          code: warnings.codes[index],
        }))
        .filter((entry) => entry.code === "EXTERNAL_AGENT_TOOLS_HIDDEN");

    async function inherited(
      run: (
        request: Parameters<NonNullable<ExternalAgent["driver"]["run"]>>[0],
      ) => AsyncIterable<never>,
    ) {
      const child = new ExternalAgent({
        name: "child",
        provider: CLAUDE_PROVIDER,
        permissions: { mode: "workspace-write", allowNetwork: false },
        tools: [named("delete_all")],
        driver: { providerId: CLAUDE_PROVIDER.id, run: run as never },
      });
      new ExternalAgent({
        name: "parent",
        provider: CLAUDE_PROVIDER,
        permissions: { mode: "read-only", allowNetwork: false },
        subAgents: [child],
      });
      try {
        for await (const _event of child.runAsync(contextFor(child))) {
          // drain
        }
      } catch {
        // a failing driver rejects the run; only the log matters here
      }
    }

    test("a driver that throws before completed", async () => {
      await inherited(async function* () {
        yield* [];
        throw new Error("driver crashed");
      });
      const logged = hiddenWarnings();
      expect(logged).toHaveLength(1);
      expect(logged[0]?.text).toContain("delete_all");
    });

    test("a driver stream that ends without completed", async () => {
      await inherited(async function* () {});
      expect(hiddenWarnings()).toHaveLength(1);
    });

    test("a run paused on a long-running tool", async () => {
      const lookup = new LongRunningFunctionTool({
        name: "lookup",
        description: "starts a job",
        parameters: z.object({}),
        execute: () => undefined as never,
      });
      const agent = new ExternalAgent({
        name: "claude",
        provider: CLAUDE_PROVIDER,
        permissions: { mode: "read-only" },
        tools: [new ListToolset([lookup, named("write_it")])],
        readOnlyTools: ["lookup"],
        driver: {
          providerId: CLAUDE_PROVIDER.id,
          async *run(request) {
            await request.adkTools?.execute(
              "adk_tool__lookup",
              {},
              request.context,
            );
            yield { type: "output", content: "never reached" };
            yield { type: "completed", exitCode: 0 };
          },
        },
      });
      for await (const _event of agent.runAsync(contextFor(agent))) {
        // drain
      }
      const logged = hiddenWarnings();
      expect(logged).toHaveLength(1);
      expect(logged[0]?.text).toContain("write_it");
    });

    test("one warning per run names hidden, ambiguous and unmatched tools", async () => {
      const agent = new ExternalAgent({
        name: "claude",
        provider: CLAUDE_PROVIDER,
        permissions: { mode: "read-only" },
        tools: [
          named("dup"),
          new ListToolset([named("dup"), named("write_it")]),
        ],
        readOnlyTools: ["dup", "ghost"],
        driver: {
          providerId: CLAUDE_PROVIDER.id,
          async *run() {
            yield { type: "completed", exitCode: 0 };
          },
        },
      });
      for await (const _event of agent.runAsync(contextFor(agent))) {
        // drain
      }
      const logged = hiddenWarnings();
      expect(logged).toHaveLength(1);
      for (const name of ["write_it", "dup", "ghost"]) {
        expect(logged[0]?.text).toContain(name);
      }
      // The bridge's own per-name warning for the ambiguous skip.
      expect(warnings.codes).toContain("ADK_TOOL_AMBIGUOUS_SKIPPED");
    });

    test("nothing hidden logs nothing", async () => {
      const agent = new ExternalAgent({
        name: "claude",
        provider: CLAUDE_PROVIDER,
        permissions: { mode: "read-only" },
        tools: [weather],
        readOnlyTools: ["get_weather"],
        driver: {
          providerId: CLAUDE_PROVIDER.id,
          async *run() {
            yield { type: "completed", exitCode: 0 };
          },
        },
      });
      for await (const _event of agent.runAsync(contextFor(agent))) {
        // drain
      }
      expect(hiddenWarnings()).toEqual([]);
      expect(warnings.codes).not.toContain("ADK_TOOL_AMBIGUOUS_SKIPPED");
    });
  });

  // 14
  test("two direct tools with a listed name throw as ambiguous, in any mode", () => {
    const a = named("get_component");
    const b = named("get_component");
    for (const permissions of [
      { mode: "read-only" },
      { mode: "workspace-write" },
    ] as const) {
      const error = codeOf(() =>
        build({ permissions, tools: [a, b], readOnlyTools: ["get_component"] }),
      );
      expect(error.code).toBe("EXTERNAL_AGENT_READ_ONLY_TOOL_UNKNOWN");
      expect(error.message).toContain("ambiguous");
    }
    // Not listed: constructs under workspace-write, as before.
    expect(() =>
      build({ permissions: { mode: "workspace-write" }, tools: [a, b] }),
    ).not.toThrow();
  });

  describe("15: run-time ambiguity under the effective read-only", () => {
    const readOnly = { mode: "read-only" } as const;

    // (a)
    test("a direct tool plus a toolset tool of the same name: neither is exposed or runs", async () => {
      const executed: string[] = [];
      const seen = await runAgent(
        {
          permissions: readOnly,
          tools: [
            named("get_component", executed),
            new ListToolset([named("get_component", executed)]),
            named("echo", executed),
          ],
          readOnlyTools: ["get_component", "echo"],
        },
        [
          "adk_tool__get_component",
          "adk_tool__get_component_2",
          "adk_tool__echo",
        ],
      );
      expect(seen.names).toEqual(["adk_tool__echo"]);
      expect(seen.statuses.adk_tool__echo).toBe("ok");
      expect(seen.statuses.adk_tool__get_component).toBe("error");
      expect(seen.statuses.adk_tool__get_component_2).toBe("error");
      expect(executed).toEqual(["echo"]);
      expect(seen.metadata).toEqual({
        hidden: ["get_component"],
        ambiguous: ["get_component"],
        reason: "read-only",
      });
    });

    // (b)
    test("two toolsets that each resolve the name: same result", async () => {
      const executed: string[] = [];
      const seen = await runAgent(
        {
          permissions: readOnly,
          tools: [
            new ListToolset([named("get_component", executed)]),
            new ListToolset([named("get_component", executed)]),
          ],
          readOnlyTools: ["get_component"],
        },
        ["adk_tool__get_component", "adk_tool__get_component_2"],
      );
      expect(seen.names).toEqual([]);
      expect(executed).toEqual([]);
      expect(seen.metadata).toEqual({
        hidden: ["get_component"],
        ambiguous: ["get_component"],
        reason: "read-only",
      });
    });

    // (c)
    test("one toolset tool of that name is exposed, with no ambiguous key", async () => {
      const seen = await runAgent({
        permissions: readOnly,
        tools: [new ListToolset([named("get_component")])],
        readOnlyTools: ["get_component"],
      });
      expect(seen.names).toEqual(["adk_tool__get_component"]);
      expect(seen.metadata).toBeUndefined();
    });

    // (d)
    test("a direct tool plus an in-model tool of the same name is ambiguous", async () => {
      const inModel = Object.assign(Object.create(GOOGLE_SEARCH), {
        name: "get_component",
      });
      const seen = await runAgent({
        permissions: readOnly,
        tools: [named("get_component"), new ListToolset([inModel])],
        readOnlyTools: ["get_component"],
      });
      expect(seen.names).toEqual([]);
      expect(seen.metadata).toMatchObject({ ambiguous: ["get_component"] });
    });

    // (e)
    test("a toolset that fails to list adds nothing to the count", async () => {
      class Failing extends BaseToolset {
        constructor() {
          super([]);
        }
        async getTools(): Promise<BaseTool[]> {
          throw new Error("boom");
        }
        async close() {}
      }
      const seen = await runAgent({
        permissions: readOnly,
        tools: [named("get_component"), new Failing()],
        readOnlyTools: ["get_component"],
      });
      expect(seen.names).toEqual(["adk_tool__get_component"]);
      expect(seen.skipped.map((s) => s.reason)).toEqual(["toolset-failed"]);
      expect(seen.metadata).toBeUndefined();
    });
  });
});
