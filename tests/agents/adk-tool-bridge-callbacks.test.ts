import { describe, expect, it } from "bun:test";
import {
  type AuthConfig,
  BasePlugin,
  type BaseTool,
  type Context,
  FunctionTool,
  type InvocationContext,
  LongRunningFunctionTool,
  PluginManager,
} from "@google/adk";
import { z } from "zod";
import { createAdkToolBridge } from "../../src/agents/tools/adk-tool-bridge.js";

function invocation(plugins: BasePlugin[] = []): InvocationContext {
  return {
    invocationId: "inv-1",
    agent: { name: "root" },
    session: { id: "s1", state: {}, events: [] },
    pluginManager: new PluginManager(plugins),
  } as unknown as InvocationContext;
}

type ToolParams = { tool: BaseTool; toolArgs: Record<string, unknown> };

/** Records every tool callback and answers with the configured responses. */
class RecordingPlugin extends BasePlugin {
  readonly calls: string[] = [];
  constructor(
    private readonly answers: {
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
      onError?: Record<string, unknown>;
      throwIn?: "before" | "after" | "onError";
    } = {},
  ) {
    super("recorder");
  }
  override async beforeToolCallback({ tool, toolArgs }: ToolParams) {
    this.calls.push(`plugin.before:${tool.name}:${JSON.stringify(toolArgs)}`);
    if (this.answers.throwIn === "before") throw new Error("guardrail");
    return this.answers.before;
  }
  override async afterToolCallback({
    tool,
    result,
  }: ToolParams & { result: Record<string, unknown> }) {
    this.calls.push(`plugin.after:${tool.name}:${JSON.stringify(result)}`);
    if (this.answers.throwIn === "after") throw new Error("audit down");
    return this.answers.after;
  }
  override async onToolErrorCallback({
    tool,
    error,
  }: ToolParams & { error: Error }) {
    this.calls.push(`plugin.onError:${tool.name}:${error.message}`);
    if (this.answers.throwIn === "onError") throw new Error("handler down");
    return this.answers.onError;
  }
}

function recordingTool(
  runs: string[],
  execute: (args: { q?: string }, context?: Context) => unknown = (args) => ({
    echoed: args.q,
  }),
): FunctionTool {
  return new FunctionTool({
    name: "lookup",
    description: "lookup",
    parameters: z.object({ q: z.string().optional() }),
    execute: (args, context) => {
      runs.push("tool");
      return execute(args, context) as never;
    },
  });
}

const NAME = "adk_tool__lookup";

describe("ADK tool bridge: plugin and agent tool callbacks", () => {
  it("runs plugin before, the tool, then plugin after, in ADK order", async () => {
    const runs: string[] = [];
    const plugin = new RecordingPlugin();
    const context = invocation([plugin]);
    const bridge = await createAdkToolBridge([recordingTool(runs)], context, {
      beforeToolCallbacks: [
        ({ tool }) => {
          plugin.calls.push(`agent.before:${tool.name}`);
          return undefined;
        },
      ],
      afterToolCallbacks: [
        ({ tool, response }) => {
          plugin.calls.push(
            `agent.after:${tool.name}:${JSON.stringify(response)}`,
          );
          return undefined;
        },
      ],
    });

    const result = await bridge.execute(NAME, { q: "a" }, context);

    expect(result).toMatchObject({ status: "ok", response: { echoed: "a" } });
    expect(runs).toEqual(["tool"]);
    expect(plugin.calls).toEqual([
      'plugin.before:lookup:{"q":"a"}',
      "agent.before:lookup",
      'plugin.after:lookup:{"echoed":"a"}',
      'agent.after:lookup:{"echoed":"a"}',
    ]);
  });

  it("a plugin before response replaces the call: the tool does not run", async () => {
    const runs: string[] = [];
    const agentBefore: string[] = [];
    const context = invocation([
      new RecordingPlugin({ before: { blocked: true } }),
    ]);
    const bridge = await createAdkToolBridge([recordingTool(runs)], context, {
      beforeToolCallbacks: [
        () => {
          agentBefore.push("ran");
          return undefined;
        },
      ],
    });

    const result = await bridge.execute(NAME, { q: "a" }, context);

    expect(result).toMatchObject({ status: "ok", response: { blocked: true } });
    expect(runs).toEqual([]);
    expect(agentBefore).toEqual([]);
  });

  it("an agent before response replaces the call when no plugin answered", async () => {
    const runs: string[] = [];
    const context = invocation([new RecordingPlugin()]);
    const bridge = await createAdkToolBridge([recordingTool(runs)], context, {
      beforeToolCallbacks: [() => undefined, () => ({ cached: 1 })],
    });

    const result = await bridge.execute(NAME, {}, context);

    expect(result).toMatchObject({ status: "ok", response: { cached: 1 } });
    expect(runs).toEqual([]);
  });

  it("an after callback replaces the result (plugin first, then the agent's)", async () => {
    const context = invocation([
      new RecordingPlugin({ after: { redacted: true } }),
    ]);
    const agentAfter: string[] = [];
    const bridge = await createAdkToolBridge([recordingTool([])], context, {
      afterToolCallbacks: [
        () => {
          agentAfter.push("ran");
          return { other: 1 };
        },
      ],
    });

    const result = await bridge.execute(NAME, { q: "secret" }, context);

    expect(result).toMatchObject({
      status: "ok",
      response: { redacted: true },
    });
    expect(agentAfter).toEqual([]);
  });

  it("onToolError gives the response of a throwing tool", async () => {
    const plugin = new RecordingPlugin({ onError: { fallback: "cached" } });
    const context = invocation([plugin]);
    const bridge = await createAdkToolBridge(
      [
        recordingTool([], () => {
          throw new Error("boom");
        }),
      ],
      context,
    );

    const result = await bridge.execute(NAME, {}, context);

    expect(result).toMatchObject({
      status: "ok",
      response: { fallback: "cached" },
    });
    // FunctionTool wraps the error as "Error in tool 'lookup': boom".
    expect(plugin.calls).toContain(
      "plugin.onError:lookup:Error in tool 'lookup': boom",
    );
    expect(plugin.calls).toContain('plugin.after:lookup:{"fallback":"cached"}');
  });

  it("without an onToolError answer the call fails and after callbacks see the error", async () => {
    const plugin = new RecordingPlugin();
    const context = invocation([plugin]);
    const bridge = await createAdkToolBridge(
      [
        recordingTool([], () => {
          throw new Error("boom");
        }),
      ],
      context,
    );

    const result = await bridge.execute(NAME, {}, context);

    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("EXECUTION_FAILED");
    expect(result.error?.message).toContain("boom");
    expect(plugin.calls).toContain(
      `plugin.after:lookup:${JSON.stringify({ error: result.error?.message })}`,
    );
  });

  for (const where of ["before", "after", "onError"] as const) {
    it(`a throwing ${where} callback fails the call with CALLBACK_FAILED`, async () => {
      const runs: string[] = [];
      const context = invocation([new RecordingPlugin({ throwIn: where })]);
      const bridge = await createAdkToolBridge(
        [
          recordingTool(runs, () => {
            if (where === "onError") throw new Error("boom");
            return { ok: true };
          }),
        ],
        context,
      );

      const result = await bridge.execute(NAME, {}, context);

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("CALLBACK_FAILED");
      expect(result.error?.message).toContain("lookup");
      // A failing guardrail before the call means the tool never ran.
      expect(runs).toEqual(where === "before" ? [] : ["tool"]);
    });
  }

  it("callbacks also run on the confirmed re-run of a requireConfirmation tool", async () => {
    const plugin = new RecordingPlugin();
    const context = invocation([plugin]);
    const gated = new FunctionTool({
      name: "lookup",
      description: "lookup",
      parameters: z.object({}),
      requireConfirmation: true,
      execute: () => ({ done: true }),
    });
    const bridge = await createAdkToolBridge([gated], context);

    const first = await bridge.execute(NAME, {}, context, {
      functionCallId: "c1",
    });
    expect(first.status).toBe("confirmationRequired");
    const second = await bridge.execute(NAME, {}, context, {
      functionCallId: "c1",
      toolConfirmation: { confirmed: true },
    });

    expect(second).toMatchObject({ status: "ok", response: { done: true } });
    expect(plugin.calls).toEqual([
      "plugin.before:lookup:{}",
      "plugin.before:lookup:{}",
      'plugin.after:lookup:{"done":true}',
    ]);
  });
});

describe("ADK tool bridge: after callbacks on failures and array results", () => {
  it("an after callback's response replaces a thrown tool's error, as in ADK", async () => {
    const context = invocation([new RecordingPlugin()]);
    const seen: unknown[] = [];
    const bridge = await createAdkToolBridge(
      [
        recordingTool([], () => {
          throw new Error("boom");
        }),
      ],
      context,
      {
        afterToolCallbacks: [
          ({ response }) => {
            seen.push(response);
            return { recovered: true };
          },
        ],
      },
    );

    const result = await bridge.execute(NAME, {}, context);

    expect(result).toEqual({
      status: "ok",
      response: { recovered: true },
      actions: {
        stateDelta: {},
        artifactDelta: {},
        requestedToolConfirmations: {},
      },
    });
    expect(String((seen[0] as { error?: unknown })?.error)).toContain("boom");
  });

  it("wraps an array tool result as { results }, as ADK does", async () => {
    const context = invocation();
    const bridge = await createAdkToolBridge(
      [recordingTool([], () => [1, 2])],
      context,
    );

    const result = await bridge.execute(NAME, {}, context);

    expect(result.response).toEqual({ results: [1, 2] });
  });

  it("wraps an array callback response as { results }", async () => {
    const context = invocation();
    const bridge = await createAdkToolBridge([recordingTool([])], context, {
      beforeToolCallbacks: [() => ["a"] as unknown as Record<string, unknown>],
    });

    const result = await bridge.execute(NAME, {}, context);

    expect(result.response).toEqual({ results: ["a"] });
  });
});

describe("ADK tool bridge: credential requests", () => {
  const authConfig = {
    authScheme: { type: "apiKey", in: "header", name: "X-Key" },
    credentialKey: "weather_key",
  } as unknown as AuthConfig;

  it("a requestCredential call is a CREDENTIAL_REQUIRED error, not a success", async () => {
    const plugin = new RecordingPlugin();
    const context = invocation([plugin]);
    const bridge = await createAdkToolBridge(
      [
        recordingTool([], (_args, toolContext) => {
          toolContext?.requestCredential(authConfig);
          return undefined;
        }),
      ],
      context,
    );

    const result = await bridge.execute(NAME, {}, context, {
      functionCallId: "call-1",
    });

    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("CREDENTIAL_REQUIRED");
    expect(result.response).toEqual({ error: result.error?.message });
    expect(Object.keys(result.actions.requestedAuthConfigs ?? {})).toEqual([
      "call-1",
    ]);
    expect(
      JSON.stringify(result.actions.requestedAuthConfigs?.["call-1"]),
    ).toContain("weather_key");
    // Nothing reached the model as a finished call.
    expect(plugin.calls.some((call) => call.startsWith("plugin.after"))).toBe(
      false,
    );
  });
});

describe("ADK tool bridge: long-running tools", () => {
  function longRunning(result: unknown) {
    return new LongRunningFunctionTool({
      name: "lookup",
      description: "starts a job",
      parameters: z.object({}),
      execute: () => result as never,
    });
  }

  it("a long-running tool that returns nothing is pending, not { result: null }", async () => {
    const context = invocation();
    const bridge = await createAdkToolBridge([longRunning(undefined)], context);

    const result = await bridge.execute(NAME, {}, context, {
      functionCallId: "job-1",
    });

    expect(result.status).toBe("pending");
    expect(result.pending).toEqual({
      functionCallId: "job-1",
      toolName: "lookup",
    });
    expect(result.response).not.toEqual({ result: null });
    expect(result.response.status).toBe("pending");
  });

  it("a long-running tool that returns a result is ok", async () => {
    const context = invocation();
    const bridge = await createAdkToolBridge(
      [longRunning({ ticket: "T-1" })],
      context,
    );

    const result = await bridge.execute(NAME, {}, context);

    expect(result).toMatchObject({
      status: "ok",
      response: { ticket: "T-1" },
    });
    expect(result.pending).toBeUndefined();
  });

  it("an after callback that answers a pending call makes it ok, as in ADK", async () => {
    const context = invocation([new RecordingPlugin({ after: { done: 1 } })]);
    const bridge = await createAdkToolBridge([longRunning(undefined)], context);

    const result = await bridge.execute(NAME, {}, context);

    expect(result).toMatchObject({ status: "ok", response: { done: 1 } });
  });

  it("a plain tool that returns nothing still reports { result: null }", async () => {
    const context = invocation();
    const bridge = await createAdkToolBridge(
      [recordingTool([], () => undefined)],
      context,
    );

    const result = await bridge.execute(NAME, {}, context);

    expect(result).toMatchObject({
      status: "ok",
      response: { result: null },
    });
  });
});
