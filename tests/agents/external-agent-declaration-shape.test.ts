import { describe, expect, test } from "bun:test";
import {
  type BaseTool,
  BaseToolset,
  FunctionTool,
  InputValidationError,
} from "@google/adk";
import { z } from "zod";
import { ClaudeCliDriver } from "../../src/agents/driver/claude-cli.js";
import {
  ClaudeAgent,
  CodexAgent,
  ExternalAgent,
} from "../../src/agents/index.js";
import { CLAUDE_PROVIDER } from "../../src/agents/provider/schema.js";

function errorOf(fn: () => unknown): { code?: string; message: string } {
  try {
    fn();
  } catch (e) {
    return e as { code?: string; message: string };
  }
  throw new Error("did not throw");
}

class EmptyToolset extends BaseToolset {
  constructor() {
    super([]);
  }
  async getTools(): Promise<BaseTool[]> {
    return [];
  }
  async close(): Promise<void> {}
}

const tool = () =>
  new FunctionTool({
    name: "get_weather",
    description: "Weather.",
    parameters: z.object({}),
    execute: () => ({}),
  });

const withDelegation = (delegation: unknown) => () =>
  new ClaudeAgent({ name: "k", delegation: delegation as never });

describe("delegation shape", () => {
  test("an unknown key is refused and named", () => {
    const fn = withDelegation({ finalAnser: "coordinator" });
    expect(fn).toThrow(InputValidationError);
    expect(fn).toThrow("finalAnser");
  });

  test("a finalAnswer other than subagent or coordinator is refused and quoted", () => {
    const fn = withDelegation({ finalAnswer: "coordinater" });
    expect(fn).toThrow(InputValidationError);
    expect(fn).toThrow("coordinater");
    expect(withDelegation({ finalAnswer: undefined })).not.toThrow();
    expect(withDelegation({ finalAnswer: "" })).toThrow(InputValidationError);
    expect(withDelegation({ finalAnswer: 1 })).toThrow(InputValidationError);
  });

  test("a finalAnswer that JSON cannot print is still refused as malformed", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const [value, type] of [
      [10n, "bigint"],
      [cyclic, "object"],
    ] as const) {
      const fn = withDelegation({ finalAnswer: value });
      expect(fn).toThrow(InputValidationError);
      expect(fn).toThrow(`got finalAnswer of type ${type}`);
    }
  });

  test("a non-object is refused", () => {
    for (const value of ["subagent", 1, true, null, [], [{}]]) {
      expect(withDelegation(value)).toThrow(InputValidationError);
    }
  });

  test("both valid values, an empty object and no delegation are accepted", () => {
    expect(withDelegation({ finalAnswer: "subagent" })).not.toThrow();
    expect(withDelegation({ finalAnswer: "coordinator" })).not.toThrow();
    expect(withDelegation({})).not.toThrow();
    expect(withDelegation(undefined)).not.toThrow();
  });
});

describe("tools entry shape", () => {
  const build =
    (tools: unknown[], driver = new ClaudeCliDriver()) =>
    () =>
      new ExternalAgent({
        name: "x",
        provider: CLAUDE_PROVIDER,
        driver,
        tools: tools as never,
      });

  test("an entry that is not an ADK tool or toolset is refused with its index", () => {
    const fn = build([tool(), { nme: "x" }], undefined);
    expect(fn).toThrow(InputValidationError);
    expect(fn).toThrow("tools[1]");
    expect(fn).toThrow("not an ADK tool or toolset");
  });

  test("null and a string entry are refused", () => {
    expect(build([null])).toThrow(InputValidationError);
    expect(build(["get_weather"])).toThrow(InputValidationError);
  });

  test("the shape check runs before the capability check", () => {
    // ClaudeCliDriver cannot host tools: a malformed entry must still be
    // reported as malformed, not as unsupported.
    const error = errorOf(build([{ nme: "x" }]));
    expect(error.code).not.toBe("EXTERNAL_AGENT_TOOLS_UNSUPPORTED");
    expect(error.message).toContain("tools[0]");
    // A well-formed tool on the same driver still reports the capability.
    expect(errorOf(build([tool()])).code).toBe(
      "EXTERNAL_AGENT_TOOLS_UNSUPPORTED",
    );
  });

  test("a tool and a toolset are accepted on a driver that hosts tools", () => {
    expect(() => new ClaudeAgent({ name: "k", tools: [tool()] })).not.toThrow();
    expect(
      () => new ClaudeAgent({ name: "k", tools: [new EmptyToolset()] }),
    ).not.toThrow();
    expect(
      () => new ClaudeAgent({ name: "k", tools: [tool(), new EmptyToolset()] }),
    ).not.toThrow();
    expect(() => new CodexAgent({ name: "c", tools: [] })).not.toThrow();
  });
});
