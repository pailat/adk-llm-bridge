import { afterEach, describe, expect, it } from "bun:test";
import {
  BaseTool,
  BaseToolset,
  FunctionTool,
  GOOGLE_SEARCH,
  type InvocationContext,
  LoadArtifactsTool,
  PRELOAD_MEMORY,
  type ReadonlyContext,
  resetLogger,
  URL_CONTEXT,
} from "@google/adk";
import { z } from "zod";
import { createAdkToolBridge } from "../../src/agents/tools/adk-tool-bridge.js";
import { LogCode } from "../../src/utils/log.js";
import { captureWarnings } from "../helpers/fake-logger.js";

function invocation(): InvocationContext {
  return {
    invocationId: "inv-1",
    agent: { name: "root" },
    session: { id: "s1", state: {}, events: [] },
  } as unknown as InvocationContext;
}

const weather = new FunctionTool({
  name: "get_weather",
  description: "Weather for a city.",
  parameters: z.object({ city: z.string() }),
  execute: ({ city }) => ({ city }),
});

class StaticToolset extends BaseToolset {
  constructor(private readonly tools: BaseTool[]) {
    super([]);
  }
  async getTools(_context?: ReadonlyContext): Promise<BaseTool[]> {
    return this.tools;
  }
  async close(): Promise<void> {}
}

/** A toolset that also adds instructions to the model request, like ADK's SkillToolset. */
class InstructingToolset extends StaticToolset {
  override async processLlmRequest(): Promise<void> {}
}

class PlainNoDeclarationTool extends BaseTool {
  constructor() {
    super({ name: "plain", description: "no declaration, no request hook" });
  }
  async runAsync(): Promise<unknown> {
    return undefined;
  }
}

class FailingToolset extends BaseToolset {
  constructor(readonly error: unknown) {
    super([]);
  }
  async getTools(): Promise<BaseTool[]> {
    throw this.error;
  }
  async close(): Promise<void> {}
}

afterEach(() => resetLogger());

describe("createAdkToolBridge skipped-tool warnings", () => {
  it("reports in-model tools as in-model and warns once per tool", async () => {
    const warnings = captureWarnings();
    const bridge = await createAdkToolBridge(
      [GOOGLE_SEARCH, URL_CONTEXT, weather],
      invocation(),
    );
    expect(bridge.declarations.map((d) => d.name)).toEqual([
      "adk_tool__get_weather",
    ]);
    expect(bridge.skipped).toEqual([
      { name: GOOGLE_SEARCH.name, reason: "in-model" },
      { name: URL_CONTEXT.name, reason: "in-model" },
    ]);
    expect(warnings.codes).toEqual([
      LogCode.ADK_TOOL_IN_MODEL_SKIPPED,
      LogCode.ADK_TOOL_IN_MODEL_SKIPPED,
    ]);
    expect(String(warnings.mock.calls[0]?.[0])).toContain(GOOGLE_SEARCH.name);
    expect(String(warnings.mock.calls[1]?.[0])).toContain(URL_CONTEXT.name);
  });

  it("reports a request-only tool (PreloadMemory) and warns", async () => {
    const warnings = captureWarnings();
    const bridge = await createAdkToolBridge([PRELOAD_MEMORY], invocation());
    expect(bridge.declarations).toEqual([]);
    expect(bridge.skipped).toEqual([
      { name: PRELOAD_MEMORY.name, reason: "request-processor" },
    ]);
    expect(warnings.codes).toEqual([
      LogCode.ADK_TOOL_REQUEST_PROCESSING_SKIPPED,
    ]);
    expect(String(warnings.mock.calls[0]?.[0])).toContain(PRELOAD_MEMORY.name);
  });

  it("exposes a declared tool whose request hook cannot run, and warns about the hook", async () => {
    const warnings = captureWarnings();
    const bridge = await createAdkToolBridge(
      [new LoadArtifactsTool()],
      invocation(),
    );
    expect(bridge.declarations.map((d) => d.name)).toEqual([
      "adk_tool__load_artifacts",
    ]);
    expect(bridge.skipped).toEqual([]);
    expect(warnings.codes).toEqual([
      LogCode.ADK_TOOL_REQUEST_PROCESSING_SKIPPED,
    ]);
    expect(String(warnings.mock.calls[0]?.[0])).toContain("load_artifacts");
  });

  it("warns about a toolset's own request hook only when one of its tools is exposed", async () => {
    const warnings = captureWarnings();
    await createAdkToolBridge(
      [new InstructingToolset([weather])],
      invocation(),
    );
    expect(warnings.codes).toEqual([
      LogCode.ADK_TOOL_REQUEST_PROCESSING_SKIPPED,
    ]);
    expect(String(warnings.mock.calls[0]?.[0])).toContain("InstructingToolset");

    warnings.mockClear();
    warnings.codes.length = 0;
    await createAdkToolBridge(
      [new InstructingToolset([weather])],
      invocation(),
      { filter: () => false },
    );
    expect(warnings.codes).toEqual([]);
  });

  it("warns once per run about a hooked toolset with several tools, one also listed directly", async () => {
    const tool = (name: string) =>
      new FunctionTool({
        name,
        description: name,
        parameters: z.object({}),
        execute: () => name,
      });
    const warnings = captureWarnings();
    const bridge = await createAdkToolBridge(
      [weather, new InstructingToolset([weather, tool("read"), tool("write")])],
      invocation(),
    );
    expect(bridge.declarations.map((d) => d.name)).toEqual([
      "adk_tool__get_weather",
      "adk_tool__get_weather_2",
      "adk_tool__read",
      "adk_tool__write",
    ]);
    expect(warnings.codes).toEqual([
      LogCode.ADK_TOOL_REQUEST_PROCESSING_SKIPPED,
    ]);
    expect(String(warnings.mock.calls[0]?.[0])).toContain("InstructingToolset");

    // The next run warns again, once.
    await createAdkToolBridge(
      [new InstructingToolset([tool("read"), tool("write")])],
      invocation(),
    );
    expect(warnings.codes).toEqual([
      LogCode.ADK_TOOL_REQUEST_PROCESSING_SKIPPED,
      LogCode.ADK_TOOL_REQUEST_PROCESSING_SKIPPED,
    ]);
  });

  it("does not warn for a plain tool without a declaration or for normal tools", async () => {
    const warnings = captureWarnings();
    const bridge = await createAdkToolBridge(
      [new PlainNoDeclarationTool(), weather, new StaticToolset([weather])],
      invocation(),
    );
    expect(bridge.skipped).toEqual([
      { name: "plain", reason: "no-declaration" },
    ]);
    expect(warnings.codes).toEqual([]);
  });

  it("warns once per tool per bridge, not once per listing", async () => {
    const warnings = captureWarnings();
    await createAdkToolBridge(
      [GOOGLE_SEARCH, new StaticToolset([GOOGLE_SEARCH]), GOOGLE_SEARCH],
      invocation(),
    );
    expect(warnings.codes).toEqual([LogCode.ADK_TOOL_IN_MODEL_SKIPPED]);

    // A new bridge (the next agent run) warns again.
    await createAdkToolBridge([GOOGLE_SEARCH], invocation());
    expect(warnings.codes).toEqual([
      LogCode.ADK_TOOL_IN_MODEL_SKIPPED,
      LogCode.ADK_TOOL_IN_MODEL_SKIPPED,
    ]);
  });

  it("does not warn about tools the filter rejects", async () => {
    const warnings = captureWarnings();
    const bridge = await createAdkToolBridge(
      [GOOGLE_SEARCH, PRELOAD_MEMORY, new LoadArtifactsTool()],
      invocation(),
      { filter: () => false },
    );
    expect(bridge.skipped).toEqual([]);
    expect(warnings.codes).toEqual([]);
  });
});

describe("createAdkToolBridge toolset failures", () => {
  it("keeps the getTools error as the skipped entry's cause and warns with its message", async () => {
    const warnings = captureWarnings();
    const error = new Error("MCP server refused the connection");
    const bridge = await createAdkToolBridge(
      [new FailingToolset(error), weather],
      invocation(),
    );
    expect(bridge.declarations.map((d) => d.name)).toEqual([
      "adk_tool__get_weather",
    ]);
    expect(bridge.skipped).toHaveLength(1);
    expect(bridge.skipped[0]?.name).toBe("FailingToolset");
    expect(bridge.skipped[0]?.reason).toBe("toolset-failed");
    expect(bridge.skipped[0]?.cause).toBe(error);
    expect(warnings.codes).toEqual([LogCode.ADK_TOOLSET_FAILED]);
    const message = String(warnings.mock.calls[0]?.[0]);
    expect(message).toContain("FailingToolset");
    expect(message).toContain("MCP server refused the connection");
  });

  it("warns once per failing toolset, each with its own error", async () => {
    const warnings = captureWarnings();
    const bridge = await createAdkToolBridge(
      [new FailingToolset(new Error("first")), new FailingToolset("second")],
      invocation(),
    );
    expect(bridge.skipped.map((s) => s.cause)).toEqual([
      new Error("first"),
      "second",
    ]);
    expect(warnings.codes).toEqual([
      LogCode.ADK_TOOLSET_FAILED,
      LogCode.ADK_TOOLSET_FAILED,
    ]);
    expect(String(warnings.mock.calls[0]?.[0])).toContain("first");
    expect(String(warnings.mock.calls[1]?.[0])).toContain("second");
  });
});

describe("createAdkToolBridge output schema", () => {
  it("keeps a FunctionTool response schema as outputSchema", async () => {
    const typed = new FunctionTool({
      name: "typed",
      description: "returns a city",
      parameters: z.object({ q: z.string() }),
      response: z.object({ city: z.string() }),
      execute: () => ({ city: "Paris" }),
    });
    const bridge = await createAdkToolBridge([typed, weather], invocation());
    const [withSchema, without] = bridge.declarations;
    expect(withSchema?.outputSchema).toMatchObject({
      type: "object",
      properties: { city: { type: "string" } },
    });
    expect(without).not.toHaveProperty("outputSchema");
  });

  it("prefers responseJsonSchema, which is already standard JSON Schema", async () => {
    const tool = new (class extends BaseTool {
      constructor() {
        super({ name: "raw", description: "raw" });
      }
      override _getDeclaration() {
        return {
          name: "raw",
          description: "raw",
          parametersJsonSchema: { type: "object", properties: {} },
          responseJsonSchema: {
            type: "object",
            properties: { n: { type: "integer" } },
          },
        };
      }
      async runAsync(): Promise<unknown> {
        return { n: 1 };
      }
    })();
    const bridge = await createAdkToolBridge([tool], invocation());
    expect(bridge.declarations[0]?.outputSchema).toEqual({
      type: "object",
      properties: { n: { type: "integer" } },
    });
  });
});

describe("createAdkToolBridge uniqueNames", () => {
  const tool = (name: string) =>
    new FunctionTool({
      name,
      description: name,
      parameters: z.object({}),
      execute: () => name,
    });

  it("skips every tool of a listed name that occurs more than once, as ambiguous", async () => {
    const bridge = await createAdkToolBridge(
      [tool("get"), new StaticToolset([tool("get"), tool("other")])],
      invocation(),
      { uniqueNames: new Set(["get"]) },
    );
    expect(bridge.declarations.map((d) => d.name)).toEqual(["adk_tool__other"]);
    expect(bridge.skipped).toEqual([
      { name: "get", reason: "ambiguous" },
      { name: "get", reason: "ambiguous" },
    ]);
  });

  it("keeps the _2 rename for a duplicate that is not in uniqueNames", async () => {
    const bridge = await createAdkToolBridge(
      [tool("get"), tool("get"), tool("solo")],
      invocation(),
      { uniqueNames: new Set(["solo"]) },
    );
    expect(bridge.declarations.map((d) => d.name)).toEqual([
      "adk_tool__get",
      "adk_tool__get_2",
      "adk_tool__solo",
    ]);
    expect(bridge.skipped).toEqual([]);
  });

  it("counts an in-model tool, and a toolset that failed contributes nothing", async () => {
    const inModel = Object.assign(Object.create(GOOGLE_SEARCH), {
      name: "get",
    });
    const counted = await createAdkToolBridge(
      [tool("get"), new StaticToolset([inModel])],
      invocation(),
      { uniqueNames: new Set(["get"]) },
    );
    expect(counted.declarations).toEqual([]);
    expect(counted.skipped.map((s) => s.reason)).toEqual([
      "ambiguous",
      "ambiguous",
    ]);
    const failed = await createAdkToolBridge(
      [tool("get"), new FailingToolset(new Error("x"))],
      invocation(),
      { uniqueNames: new Set(["get"]) },
    );
    expect(failed.declarations.map((d) => d.name)).toEqual(["adk_tool__get"]);
  });
});

describe("createAdkToolBridge ambiguous warning", () => {
  it("warns once per ambiguous name with ADK_TOOL_AMBIGUOUS_SKIPPED", async () => {
    const warnings = captureWarnings();
    const tool = (name: string) =>
      new FunctionTool({
        name,
        description: name,
        parameters: z.object({}),
        execute: () => name,
      });
    await createAdkToolBridge(
      [tool("get"), tool("get"), tool("get"), tool("solo")],
      invocation(),
      { uniqueNames: new Set(["get", "solo"]) },
    );
    expect(warnings.codes).toEqual([LogCode.ADK_TOOL_AMBIGUOUS_SKIPPED]);
    expect(String(warnings.mock.calls[0]?.[0])).toContain("get");
  });
});
