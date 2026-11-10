import { describe, expect, it } from "bun:test";
import {
  BaseTool,
  BaseToolset,
  FunctionTool,
  type InvocationContext,
  type ReadonlyContext,
} from "@google/adk";
import { z } from "zod";
import {
  ADK_TOOL_PREFIX,
  createAdkToolBridge,
  toResponseObject,
} from "../../src/agents/tools/adk-tool-bridge.js";

function invocation(
  overrides: Partial<InvocationContext> = {},
): InvocationContext {
  return {
    invocationId: "inv-1",
    agent: { name: "root" },
    session: { id: "s1", state: {}, events: [] },
    ...overrides,
  } as unknown as InvocationContext;
}

const weather = new FunctionTool({
  name: "get_weather",
  description: "Weather for a city.",
  parameters: z.object({ city: z.string().describe("City name") }),
  execute: ({ city }) => ({ city, temp: 21 }),
});

class StaticToolset extends BaseToolset {
  constructor(
    private readonly tools: BaseTool[],
    prefix?: string,
  ) {
    super([], prefix);
  }
  async getTools(_context?: ReadonlyContext): Promise<BaseTool[]> {
    return this.tools;
  }
  async close(): Promise<void> {}
}

class NoDeclarationTool extends BaseTool {
  constructor() {
    super({ name: "builtin_search", description: "in-model" });
  }
  async runAsync(): Promise<unknown> {
    throw new Error("must not run");
  }
}

class JsonSchemaTool extends BaseTool {
  constructor() {
    super({ name: "raw", description: "raw schema" });
  }
  override _getDeclaration() {
    return {
      name: "raw",
      description: "raw schema",
      parametersJsonSchema: {
        type: "object",
        properties: { q: { type: "string" } },
        required: ["q"],
      },
    };
  }
  async runAsync({ args }: { args: Record<string, unknown> }) {
    return `got ${String(args.q)}`;
  }
}

describe("createAdkToolBridge declarations", () => {
  it("namespaces names and converts Zod parameters to JSON Schema", async () => {
    const bridge = await createAdkToolBridge([weather], invocation());
    expect(bridge.declarations).toHaveLength(1);
    const [decl] = bridge.declarations;
    expect(decl?.name).toBe(`${ADK_TOOL_PREFIX}get_weather`);
    expect(decl?.description).toBe("Weather for a city.");
    expect(decl?.inputSchema.type).toBe("object");
    expect(JSON.stringify(decl?.inputSchema)).toContain('"city"');
    expect(JSON.stringify(decl?.inputSchema)).not.toContain('"STRING"');
    expect(bridge.has(`${ADK_TOOL_PREFIX}get_weather`)).toBe(true);
    expect(bridge.has("get_weather")).toBe(false);
  });

  it("forwards parametersJsonSchema as-is and defaults to an empty object schema", async () => {
    const noParams = new FunctionTool({
      name: "ping",
      description: "no params",
      execute: () => "pong",
    });
    const bridge = await createAdkToolBridge(
      [new JsonSchemaTool(), noParams],
      invocation(),
    );
    expect(bridge.declarations[0]?.inputSchema).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    });
    expect(bridge.declarations[1]?.inputSchema.type).toBe("object");
  });

  it("expands toolsets (honoring their prefix) and keeps names collision-free", async () => {
    const a = new FunctionTool({
      name: "dup",
      description: "a",
      execute: () => "a",
    });
    const b = new FunctionTool({
      name: "dup",
      description: "b",
      execute: () => "b",
    });
    const odd = new FunctionTool({
      name: "has space.and/chars",
      description: "odd",
      execute: () => "odd",
    });
    const bridge = await createAdkToolBridge(
      [a, new StaticToolset([b, odd])],
      invocation(),
    );
    const names = bridge.declarations.map((d) => d.name);
    expect(names).toEqual([
      "adk_tool__dup",
      "adk_tool__dup_2",
      "adk_tool__has_space_and_chars",
    ]);
    expect(new Set(names).size).toBe(3);
  });

  it("truncates long names to 64 characters and stays unique", async () => {
    const long = (suffix: string) =>
      new FunctionTool({
        name: `${"x".repeat(80)}${suffix}`,
        description: "long",
        execute: () => suffix,
      });
    const bridge = await createAdkToolBridge(
      [long("1"), long("2")],
      invocation(),
    );
    const names = bridge.declarations.map((d) => d.name);
    expect(names.every((n) => n.length <= 64)).toBe(true);
    expect(new Set(names).size).toBe(2);
  });

  it("reports tools it cannot expose instead of throwing", async () => {
    const failing = new (class extends BaseToolset {
      constructor() {
        super([]);
      }
      async getTools(): Promise<BaseTool[]> {
        throw new Error("boom");
      }
      async close(): Promise<void> {}
    })();
    const bridge = await createAdkToolBridge(
      [new NoDeclarationTool(), failing, { name: "node" } as never, weather],
      invocation(),
    );
    expect(bridge.declarations.map((d) => d.name)).toEqual([
      "adk_tool__get_weather",
    ]);
    expect(bridge.skipped.map((s) => s.reason).sort()).toEqual([
      "no-declaration",
      "not-a-tool",
      "toolset-failed",
    ]);
  });
});

describe("createAdkToolBridge filter", () => {
  it("keeps only the accepted tools, toolsets' tools included, by their own name", async () => {
    const tool = (name: string) =>
      new FunctionTool({
        name,
        description: name,
        parameters: z.object({}),
        execute: () => name,
      });
    const seen: string[] = [];
    const bridge = await createAdkToolBridge(
      [tool("read"), new StaticToolset([tool("read"), tool("write")])],
      invocation(),
      {
        filter: (candidate) => {
          seen.push(candidate.name);
          return candidate.name === "read";
        },
      },
    );
    expect(seen).toEqual(["read", "read", "write"]);
    expect(bridge.declarations.map((d) => d.name)).toEqual([
      "adk_tool__read",
      "adk_tool__read_2",
    ]);
    // A rejected tool is not reported as skipped.
    expect(bridge.skipped).toEqual([]);
  });
});

describe("AdkToolBridge.execute", () => {
  it("runs the tool and returns its response", async () => {
    const bridge = await createAdkToolBridge([weather], invocation());
    const result = await bridge.execute(
      "adk_tool__get_weather",
      { city: "Paris" },
      invocation(),
    );
    expect(result.status).toBe("ok");
    expect(result.response).toEqual({ city: "Paris", temp: 21 });
    expect(result.error).toBeUndefined();
  });

  it("wraps non-object results as { result }", async () => {
    const bridge = await createAdkToolBridge(
      [new JsonSchemaTool()],
      invocation(),
    );
    const result = await bridge.execute(
      "adk_tool__raw",
      { q: "x" },
      invocation(),
    );
    expect(result.response).toEqual({ result: "got x" });
  });

  it("captures state and artifact deltas written through the ADK tool context", async () => {
    const stateful = new FunctionTool({
      name: "remember",
      description: "writes state",
      execute: (_input, toolContext) => {
        if (!toolContext) throw new Error("missing tool context");
        toolContext.state.set("favorite", "blue");
        toolContext.actions.skipSummarization = true;
        return "saved";
      },
    });
    const bridge = await createAdkToolBridge([stateful], invocation());
    const result = await bridge.execute("adk_tool__remember", {}, invocation());
    expect(result.status).toBe("ok");
    expect(result.actions.stateDelta).toEqual({ favorite: "blue" });
    expect(result.actions.skipSummarization).toBe(true);
    expect(result.actions.artifactDelta).toEqual({});
  });

  it("returns a structured error for unknown tools, bad args, failures and aborts", async () => {
    const boom = new FunctionTool({
      name: "boom",
      description: "fails",
      execute: () => {
        throw new Error("kaput");
      },
    });
    const bridge = await createAdkToolBridge([boom], invocation());

    const unknown = await bridge.execute("adk_tool__nope", {}, invocation());
    expect(unknown.status).toBe("error");
    expect(unknown.error?.code).toBe("UNKNOWN_TOOL");

    const badArgs = await bridge.execute("adk_tool__boom", [1], invocation());
    expect(badArgs.error?.code).toBe("INVALID_ARGUMENTS");

    const failed = await bridge.execute("adk_tool__boom", {}, invocation());
    expect(failed.error).toEqual({
      code: "EXECUTION_FAILED",
      message: "Error in tool 'boom': kaput",
    });
    expect(failed.response).toEqual({ error: "Error in tool 'boom': kaput" });

    const controller = new AbortController();
    controller.abort();
    const aborted = await bridge.execute(
      "adk_tool__boom",
      {},
      invocation({ abortSignal: controller.signal }),
    );
    expect(aborted.error?.code).toBe("ABORTED");
  });

  it("reports a Zod argument mismatch as an error result (never throws)", async () => {
    const bridge = await createAdkToolBridge([weather], invocation());
    const result = await bridge.execute(
      "adk_tool__get_weather",
      { city: 5 },
      invocation(),
    );
    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("get_weather");
  });
});

describe("AdkToolBridge confirmation handling", () => {
  let runs = 0;
  const gated = () =>
    new FunctionTool({
      name: "delete_all",
      description: "dangerous",
      parameters: z.object({ scope: z.string() }),
      requireConfirmation: true,
      execute: ({ scope }) => {
        runs++;
        return { deleted: scope };
      },
    });

  it("does not run a gated tool and reports confirmationRequired", async () => {
    runs = 0;
    const bridge = await createAdkToolBridge([gated()], invocation());
    const result = await bridge.execute(
      "adk_tool__delete_all",
      { scope: "tmp" },
      invocation(),
      { functionCallId: "call-9" },
    );
    expect(result.status).toBe("confirmationRequired");
    expect(result.confirmation?.functionCallId).toBe("call-9");
    expect(result.confirmation?.hint).toContain("delete_all");
    expect(result.confirmation?.origin).toBe("requireConfirmation");
    expect(runs).toBe(0);
  });

  it("runs the tool once a human approved it", async () => {
    runs = 0;
    const bridge = await createAdkToolBridge([gated()], invocation());
    const result = await bridge.execute(
      "adk_tool__delete_all",
      { scope: "tmp" },
      invocation(),
      { toolConfirmation: { confirmed: true } },
    );
    expect(result.status).toBe("ok");
    expect(result.response).toEqual({ deleted: "tmp" });
    expect(runs).toBe(1);
  });

  it("does not run the tool when the human rejected it", async () => {
    runs = 0;
    const bridge = await createAdkToolBridge([gated()], invocation());
    const result = await bridge.execute(
      "adk_tool__delete_all",
      { scope: "tmp" },
      invocation(),
      { toolConfirmation: { confirmed: false } },
    );
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("CONFIRMATION_REJECTED");
    expect(runs).toBe(0);
  });

  it("evaluates a predicate against the arguments", async () => {
    runs = 0;
    const conditional = new FunctionTool({
      name: "transfer",
      description: "moves money",
      parameters: z.object({ amount: z.number() }),
      requireConfirmation: ({ amount }) => amount > 100,
      execute: () => {
        runs++;
        return "done";
      },
    });
    const bridge = await createAdkToolBridge([conditional], invocation());
    const small = await bridge.execute(
      "adk_tool__transfer",
      { amount: 5 },
      invocation(),
    );
    expect(small.status).toBe("ok");
    const large = await bridge.execute(
      "adk_tool__transfer",
      { amount: 500 },
      invocation(),
    );
    expect(large.status).toBe("confirmationRequired");
    expect(runs).toBe(1);
  });
});

describe("AdkToolBridge requestConfirmation() inside execute", () => {
  const decisions: Array<boolean | undefined> = [];
  const asking = () =>
    new FunctionTool({
      name: "deploy",
      description: "asks inside execute",
      parameters: z.object({}),
      execute: async (_args, context) => {
        const decision = context?.toolConfirmation;
        decisions.push(decision?.confirmed);
        await context?.saveArtifact("plan.txt", { text: "plan" });
        if (!decision) {
          context?.state.set("attempt", 1);
          context?.requestConfirmation({ hint: "Ship it?", payload: { n: 1 } });
          return { status: "waiting" };
        }
        return { deployed: decision.confirmed };
      },
    });
  const withArtifacts = () =>
    invocation({
      artifactService: {
        saveArtifact: async () => 3,
      } as unknown as InvocationContext["artifactService"],
    });

  it("reports confirmationRequired with the tool's hint and payload", async () => {
    decisions.length = 0;
    const context = withArtifacts();
    const bridge = await createAdkToolBridge([asking()], context);
    const result = await bridge.execute("adk_tool__deploy", {}, context, {
      functionCallId: "call-1",
    });
    expect(result.status).toBe("confirmationRequired");
    expect(result.confirmation).toEqual({
      functionCallId: "call-1",
      hint: "Ship it?",
      payload: { n: 1 },
      origin: "requestConfirmation",
    });
    // The unconfirmed run's response and state are dropped, as in ADK; the
    // artifact it saved stays reported.
    expect(result.response).toEqual({
      error: "This tool call requires confirmation.",
    });
    expect(result.actions.stateDelta).toEqual({});
    expect(result.actions.artifactDelta).toEqual({ "plan.txt": 3 });
    expect(result.actions.requestedToolConfirmations["call-1"]).toMatchObject({
      hint: "Ship it?",
      confirmed: false,
    });
    expect(decisions).toEqual([undefined]);
  });

  it("runs the tool with the decision on the next call", async () => {
    decisions.length = 0;
    const context = withArtifacts();
    const bridge = await createAdkToolBridge([asking()], context);
    const approved = await bridge.execute("adk_tool__deploy", {}, context, {
      functionCallId: "call-1",
      toolConfirmation: { confirmed: true },
    });
    const rejected = await bridge.execute("adk_tool__deploy", {}, context, {
      functionCallId: "call-2",
      toolConfirmation: { confirmed: false },
    });
    expect(approved).toMatchObject({
      status: "ok",
      response: { deployed: true },
    });
    // Without `requireConfirmation`, a rejection is the tool's to handle.
    expect(rejected).toMatchObject({
      status: "ok",
      response: { deployed: false },
    });
    expect(decisions).toEqual([true, false]);
  });
});

describe("toResponseObject", () => {
  it("uses plain and null-prototype objects as they are", () => {
    const plain = { a: 1 };
    const bare = Object.assign(Object.create(null), { b: 2 });
    expect(toResponseObject(plain)).toBe(plain);
    expect(toResponseObject(bare)).toBe(bare);
  });

  it("wraps a Date, a Map and a class instance", () => {
    class Point {
      x = 1;
    }
    const date = new Date(0);
    const map = new Map([["k", 1]]);
    const point = new Point();
    expect(toResponseObject(date)).toEqual({ result: date });
    expect(toResponseObject(map)).toEqual({ result: map });
    expect(toResponseObject(point).result).toBe(point);
  });

  it("wraps arrays as results and primitives as result, with undefined as null", () => {
    expect(toResponseObject([1])).toEqual({ results: [1] });
    expect(toResponseObject("x")).toEqual({ result: "x" });
    expect(toResponseObject(undefined)).toEqual({ result: null });
  });
});
