import { describe, expect, test } from "bun:test";
import {
  type BaseTool,
  BaseToolset,
  FunctionTool,
  type InvocationContext,
} from "@google/adk";
import { z } from "zod";
import { CLAUDE_AGENT_DEFINITION } from "../../../src/agents/claude-agent.js";
import { CODEX_AGENT_DEFINITION } from "../../../src/agents/codex-agent.js";
import {
  ClaudeAgentSdkDriver,
  type ClaudeAgentSdkDriverConfig,
  claudeSdkSessionStateKey,
} from "../../../src/agents/driver/claude-agent-sdk.js";
import { CodexSdkDriver } from "../../../src/agents/driver/codex-sdk.js";
import { GeminiCliDriver } from "../../../src/agents/driver/gemini-cli.js";
import { ExternalAgent } from "../../../src/agents/external-agent.js";
import { GEMINI_CLI_AGENT_DEFINITION } from "../../../src/agents/gemini-cli-agent.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/schema.js";
import { createAdkToolBridge } from "../../../src/agents/tools/adk-tool-bridge.js";

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

  test("in read-only nothing is exposed unless allow-listed", async () => {
    expect(await exposed({ mode: "read-only" })).toEqual([]);
    expect(await exposed({ mode: "read-only" }, ["get_weather"])).toEqual([
      "adk_tool__get_weather",
    ]);
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
      tools: [weather, longer],
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
    const { names, ran } = await exposedWith([get, get2], ["get"]);
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
      { name: "FlakyToolset", reason: "toolset-failed" },
    ]);
  });

  test("a hidden tool cannot be executed through the filtered bridge", async () => {
    let result: { status: string } | undefined;
    const agent = new ExternalAgent({
      name: "claude",
      provider: CLAUDE_PROVIDER,
      permissions: { mode: "read-only" },
      tools: [weather],
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
    expect(new GeminiCliDriver().capabilities().tools).toBeUndefined();
  });

  test("definitions carry no capabilities: the driver is the only source", () => {
    for (const definition of [
      CLAUDE_AGENT_DEFINITION,
      CODEX_AGENT_DEFINITION,
      GEMINI_CLI_AGENT_DEFINITION,
    ]) {
      expect(definition).not.toHaveProperty("capabilities");
    }
  });
});
