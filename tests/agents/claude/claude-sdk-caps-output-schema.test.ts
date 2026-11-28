import { describe, expect, test } from "bun:test";
import {
  type Event,
  InMemoryRunner,
  InputValidationError,
  Workflow,
} from "@google/adk";
import {
  CLAUDE_MAX_BUDGET_INVALID,
  CLAUDE_OUTPUT_SCHEMA_MISMATCH,
  ClaudeAgentSdkDriver,
  type ClaudeAgentSdkDriverConfig,
} from "../../../src/agents/driver/claude-agent-sdk.js";
import { ClaudeCliDriver } from "../../../src/agents/driver/claude-cli.js";
import { looserSchema } from "../../../src/agents/driver/claude-run-caps.js";
import {
  EXTERNAL_AGENT_OPTION_UNSUPPORTED,
  ExternalAgentPolicyError,
} from "../../../src/agents/driver/policy-errors.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import * as agents from "../../../src/agents/index.js";
import { ExternalAgent } from "../../../src/agents/index.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/schema.js";

// Budget and effort caps, and native structured output, on the Claude Agent
// SDK driver. Every test plays a scripted SDK: no process, no network.

const MODEL = "claude-haiku-5-5";

type Message = Record<string, unknown>;

const init = (session: string): Message => ({
  type: "system",
  subtype: "init",
  model: MODEL,
  session_id: session,
  tools: [],
  mcp_servers: [],
});

const assistant = (session: string, text: string): Message => ({
  type: "assistant",
  session_id: session,
  parent_tool_use_id: null,
  message: {
    role: "assistant",
    model: MODEL,
    content: [{ type: "text", text }],
  },
});

const success = (session: string, extra: Message = {}): Message => ({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 1,
  result: "Acme invoice summary in prose",
  session_id: session,
  duration_ms: 5,
  total_cost_usd: 0.01,
  ...extra,
});

const failure = (session: string, subtype: string): Message => ({
  type: "result",
  subtype,
  is_error: true,
  num_turns: 3,
  session_id: session,
  duration_ms: 5,
  total_cost_usd: 1.5,
  errors: [],
});

/** A fake Agent SDK that plays one script per `query()` call. */
class ScriptedSdk {
  readonly scripts: Message[][] = [];
  readonly options: Array<Record<string, unknown>> = [];

  readonly sdk = {
    query: ({ options }: { prompt: unknown; options: Message }) => {
      this.options.push(options);
      const messages = this.scripts.shift() ?? [];
      const iterator = (async function* () {
        for (const message of messages) yield message;
      })();
      return Object.assign(iterator, { interrupt: async () => {} });
    },
    tool: (name: string) => ({ name }),
    createSdkMcpServer: (config: Record<string, unknown>) => config,
  };

  driver(config: ClaudeAgentSdkDriverConfig = {}): ClaudeAgentSdkDriver {
    return new ClaudeAgentSdkDriver({
      sdk: this.sdk as never,
      model: MODEL,
      ...config,
    });
  }
}

async function run(
  driver: ClaudeAgentSdkDriver,
): Promise<ExternalAgentEvent[]> {
  const events: ExternalAgentEvent[] = [];
  for await (const event of driver.run({
    provider: CLAUDE_PROVIDER,
    context: {
      session: {
        id: "adk-1",
        state: {},
        events: [
          {
            author: "user",
            content: { role: "user", parts: [{ text: "summarize Acme" }] },
          },
        ],
      },
    } as never,
    workingDirectory: "/repo",
  })) {
    events.push(event);
  }
  return events;
}

const outputs = (events: ExternalAgentEvent[]) =>
  events.flatMap((e) => (e.type === "output" ? [e.content] : []));
const errorsOf = (events: ExternalAgentEvent[]) =>
  events.filter(
    (e): e is Extract<ExternalAgentEvent, { type: "error" }> =>
      e.type === "error",
  );
const exitCodes = (events: ExternalAgentEvent[]) =>
  events.flatMap((e) => (e.type === "completed" ? [e.exitCode] : []));

function thrown(build: () => unknown): unknown {
  try {
    build();
  } catch (error) {
    return error;
  }
  return undefined;
}

const SCHEMA = {
  type: "object",
  properties: {
    customer: { type: "string" },
    total: { type: "number" },
  },
  required: ["customer", "total"],
  additionalProperties: false,
};

describe("ClaudeAgentSdkDriver budget and effort caps", () => {
  test("a numeric maxBudgetUsd reaches every query() call", async () => {
    const fake = new ScriptedSdk();
    fake.scripts.push([init("s-1"), success("s-1")]);
    fake.scripts.push([init("s-2"), success("s-2")]);
    const driver = fake.driver({ maxBudgetUsd: 2.5 });
    await run(driver);
    await run(driver);
    expect(fake.options.map((o) => o.maxBudgetUsd)).toEqual([2.5, 2.5]);
  });

  test("a function maxBudgetUsd is read when each query() call starts", async () => {
    const fake = new ScriptedSdk();
    fake.scripts.push([init("s-1"), success("s-1")]);
    fake.scripts.push([init("s-2"), success("s-2")]);
    let remaining = 3;
    const driver = fake.driver({ maxBudgetUsd: () => remaining });
    await run(driver);
    remaining = 0.75;
    await run(driver);
    expect(fake.options.map((o) => o.maxBudgetUsd)).toEqual([3, 0.75]);
  });

  test("effort and maxThinkingTokens reach query()", () => {
    const fake = new ScriptedSdk();
    const options = fake
      .driver({ effort: "high", maxThinkingTokens: 8_000 })
      .buildOptions({ provider: CLAUDE_PROVIDER, context: {} as never });
    expect(options).toMatchObject({ effort: "high", maxThinkingTokens: 8_000 });
  });

  test("maxThinkingTokens 0 (thinking off) reaches query()", () => {
    const options = new ScriptedSdk()
      .driver({ maxThinkingTokens: 0 })
      .buildOptions({ provider: CLAUDE_PROVIDER, context: {} as never });
    expect(options).toMatchObject({ maxThinkingTokens: 0 });
  });

  test("without the caps no key is passed (the SDK defaults apply)", () => {
    const options = new ScriptedSdk()
      .driver()
      .buildOptions({ provider: CLAUDE_PROVIDER, context: {} as never });
    for (const key of [
      "maxBudgetUsd",
      "effort",
      "maxThinkingTokens",
      "outputFormat",
    ]) {
      expect(key in options).toBe(false);
    }
  });

  test.each([
    [{ maxBudgetUsd: 0 }, "maxBudgetUsd"],
    [{ maxBudgetUsd: -1 }, "maxBudgetUsd"],
    [{ maxBudgetUsd: Number.NaN }, "maxBudgetUsd"],
    [{ maxBudgetUsd: Number.POSITIVE_INFINITY }, "maxBudgetUsd"],
    [{ maxBudgetUsd: "1" }, "maxBudgetUsd"],
    [{ maxBudgetUsd: null }, "maxBudgetUsd"],
    [{ effort: "extreme" }, "effort"],
    [{ effort: 3 }, "effort"],
    [{ maxThinkingTokens: -5 }, "maxThinkingTokens"],
    [{ maxThinkingTokens: 1.5 }, "maxThinkingTokens"],
    [{ maxThinkingTokens: Number.POSITIVE_INFINITY }, "maxThinkingTokens"],
  ])("refuses %p when the driver is built", (config, field) => {
    const error = thrown(() => new ScriptedSdk().driver(config as never));
    expect(error).toBeInstanceOf(InputValidationError);
    expect(String((error as Error).message)).toContain(field);
  });

  test.each([[0], [-2], [Number.NaN], [Number.POSITIVE_INFINITY], ["5"]])(
    "a budget function that returns %p ends the run typed, before query()",
    async (value) => {
      const fake = new ScriptedSdk();
      const events = await run(
        fake.driver({ maxBudgetUsd: () => value as never }),
      );
      expect(fake.options).toHaveLength(0);
      const errors = errorsOf(events);
      expect(errors.map((e) => e.code)).toEqual([CLAUDE_MAX_BUDGET_INVALID]);
      expect(errors[0]?.recoverable).toBe(false);
      expect(exitCodes(events)).toEqual([1]);
    },
  );

  test("a budget function that throws ends the run typed, before query()", async () => {
    const fake = new ScriptedSdk();
    const events = await run(
      fake.driver({
        maxBudgetUsd: () => {
          throw new Error("Acme ledger offline");
        },
      }),
    );
    expect(fake.options).toHaveLength(0);
    expect(errorsOf(events).map((e) => e.code)).toEqual([
      CLAUDE_MAX_BUDGET_INVALID,
    ]);
    expect(exitCodes(events)).toEqual([1]);
  });

  test("error_max_budget_usd is a non-recoverable MAX_BUDGET_EXCEEDED", async () => {
    const fake = new ScriptedSdk();
    fake.scripts.push([init("s-1"), failure("s-1", "error_max_budget_usd")]);
    const events = await run(fake.driver({ maxBudgetUsd: 1 }));
    const errors = errorsOf(events);
    expect(errors.map((e) => e.code)).toEqual(["MAX_BUDGET_EXCEEDED"]);
    expect(errors[0]?.recoverable).toBe(false);
    expect(exitCodes(events)).toEqual([1]);
  });
});

describe("ClaudeAgentSdkDriver native outputSchema", () => {
  test("the schema reaches query() as JSON-schema output", () => {
    const options = new ScriptedSdk()
      .driver({ outputSchema: SCHEMA })
      .buildOptions({ provider: CLAUDE_PROVIDER, context: {} as never });
    expect(options).toMatchObject({
      outputFormat: { type: "json_schema", schema: SCHEMA },
    });
  });

  test("the structured value is the run's only output", async () => {
    const fake = new ScriptedSdk();
    fake.scripts.push([
      init("s-1"),
      assistant("s-1", "Let me look at the Acme ledger."),
      success("s-1", { structured_output: { customer: "Acme", total: 42 } }),
    ]);
    const events = await run(fake.driver({ outputSchema: SCHEMA }));
    expect(errorsOf(events)).toEqual([]);
    expect(outputs(events)).toEqual(['{"customer":"Acme","total":42}']);
    expect(exitCodes(events)).toEqual([0]);
  });

  test("a success with no structured value ends typed, never with the raw text", async () => {
    const fake = new ScriptedSdk();
    fake.scripts.push([
      init("s-1"),
      assistant("s-1", "Here is the Acme summary."),
      success("s-1"),
    ]);
    const events = await run(fake.driver({ outputSchema: SCHEMA }));
    expect(outputs(events)).toEqual([]);
    const errors = errorsOf(events);
    expect(errors.map((e) => e.code)).toEqual([CLAUDE_OUTPUT_SCHEMA_MISMATCH]);
    expect(errors[0]?.recoverable).toBe(false);
    expect(exitCodes(events)).toEqual([1]);
  });

  test("a structured value that does not match the schema ends typed", async () => {
    const fake = new ScriptedSdk();
    fake.scripts.push([
      init("s-1"),
      success("s-1", { structured_output: { customer: "Acme" } }),
    ]);
    const events = await run(fake.driver({ outputSchema: SCHEMA }));
    expect(outputs(events)).toEqual([]);
    expect(errorsOf(events).map((e) => e.code)).toEqual([
      CLAUDE_OUTPUT_SCHEMA_MISMATCH,
    ]);
    expect(exitCodes(events)).toEqual([1]);
  });

  // The SDK checks formats; the driver's second check reads structure only,
  // so a valid relative reference is not refused as a URL.
  const FORMAT_SCHEMA = {
    type: "object",
    properties: {
      doc: { type: "string", format: "uri-reference" },
      format: { type: "string" },
    },
    required: ["doc", "format"],
    additionalProperties: false,
  };

  test("a relative uri-reference value is not refused", async () => {
    const fake = new ScriptedSdk();
    const value = { doc: "docs/acme.md", format: "pdf" };
    fake.scripts.push([
      init("s-1"),
      success("s-1", { structured_output: value }),
    ]);
    const events = await run(fake.driver({ outputSchema: FORMAT_SCHEMA }));
    expect(errorsOf(events)).toEqual([]);
    expect(outputs(events)).toEqual([JSON.stringify(value)]);
  });

  test("a property named format is still required", async () => {
    const fake = new ScriptedSdk();
    fake.scripts.push([
      init("s-1"),
      success("s-1", { structured_output: { doc: "docs/acme.md" } }),
    ]);
    const events = await run(fake.driver({ outputSchema: FORMAT_SCHEMA }));
    expect(errorsOf(events).map((e) => e.code)).toEqual([
      CLAUDE_OUTPUT_SCHEMA_MISMATCH,
    ]);
  });

  test("the schema sent to the SDK keeps its formats", () => {
    const options = new ScriptedSdk()
      .driver({ outputSchema: FORMAT_SCHEMA })
      .buildOptions({ provider: CLAUDE_PROVIDER, context: {} as never });
    expect(options).toMatchObject({
      outputFormat: { type: "json_schema", schema: FORMAT_SCHEMA },
    });
  });

  // The second check must never be stricter than JSON Schema. These schemas
  // use keywords zod reads more strictly (exclusive unions, regexes without
  // the u flag, object literals compared by reference); the SDK accepted
  // each value, so the driver must not refuse it.
  test.each<[string, Record<string, unknown>, unknown]>([
    [
      "an untyped-branch oneOf",
      {
        type: "object",
        oneOf: [{ required: ["a"] }, { required: ["b"] }],
      },
      { a: "Acme" },
    ],
    [
      "a format-discriminated oneOf",
      {
        type: "object",
        properties: {
          when: {
            oneOf: [
              { type: "string", format: "date" },
              { type: "string", format: "email" },
            ],
          },
        },
        required: ["when"],
      },
      { when: "2026-01-31" },
    ],
    [
      "a oneOf next to an anyOf",
      {
        type: "object",
        anyOf: [{ required: ["a"] }, { required: ["c"] }],
        oneOf: [{ required: ["a"] }, { required: ["b"] }],
      },
      { a: "Acme" },
    ],
    [
      "a Unicode pattern",
      {
        type: "object",
        properties: { name: { type: "string", pattern: "^\\p{L}+$" } },
        required: ["name"],
      },
      { name: "abc" },
    ],
    [
      "a Unicode patternProperties with additionalProperties false",
      {
        type: "object",
        patternProperties: { "^\\p{L}+$": { type: "string" } },
        additionalProperties: false,
      },
      { abc: "Acme" },
    ],
    [
      "an object const",
      {
        type: "object",
        properties: { meta: { const: { kind: "acme" } } },
        required: ["meta"],
      },
      { meta: { kind: "acme" } },
    ],
    [
      "an enum with an array member",
      {
        type: "object",
        properties: { pair: { enum: [[1, 2], "none"] } },
        required: ["pair"],
      },
      { pair: [1, 2] },
    ],
    // Relaxing a subschema under `not` or `contains` narrows the outer
    // schema, so those positions must not be relaxed.
    [
      "a not of a format",
      {
        type: "object",
        properties: { contact: { type: "string", not: { format: "email" } } },
        required: ["contact"],
      },
      { contact: "acme-desk" },
    ],
    [
      "a not of a pattern",
      {
        type: "object",
        properties: { code: { type: "string", not: { pattern: "^x" } } },
        required: ["code"],
      },
      { code: "acme" },
    ],
    [
      "a not of an object const",
      {
        type: "object",
        properties: { meta: { not: { const: { kind: "acme" } } } },
        required: ["meta"],
      },
      { meta: { kind: "other" } },
    ],
    [
      "a contains of a pattern with maxContains",
      {
        type: "object",
        properties: {
          tags: {
            type: "array",
            contains: { type: "string", pattern: "^a" },
            maxContains: 1,
          },
        },
        required: ["tags"],
      },
      { tags: ["a", "b"] },
    ],
    // zod counts UTF-16 units where JSON Schema counts code points.
    [
      "a maxLength met in code points",
      {
        type: "object",
        properties: { tag: { type: "string", maxLength: 2 } },
        required: ["tag"],
      },
      { tag: "😀😀" },
    ],
    [
      "a propertyNames maxLength met in code points",
      { type: "object", propertyNames: { maxLength: 2 } },
      { "😀😀": "Acme" },
    ],
    // zod's `.int()` accepts only safe integers.
    [
      "an integer beyond 2^53",
      {
        type: "object",
        properties: { id: { type: "integer" } },
        required: ["id"],
      },
      { id: 2 ** 64 },
    ],
    [
      "an integer beyond 2^53 in a type array",
      {
        type: "object",
        properties: { id: { type: ["integer", "null"] } },
        required: ["id"],
      },
      { id: 2 ** 64 },
    ],
  ])("a valid value for %s is not refused", async (_name, schema, value) => {
    const fake = new ScriptedSdk();
    fake.scripts.push([
      init("s-1"),
      success("s-1", { structured_output: value }),
    ]);
    const events = await run(fake.driver({ outputSchema: schema }));
    expect(errorsOf(events)).toEqual([]);
    expect(outputs(events)).toEqual([JSON.stringify(value)]);
    expect(exitCodes(events)).toEqual([0]);
  });

  test("the looser schema doubles maxLength and reads integer as number", () => {
    // zod 4.6 counts code points, older zod 4 releases count UTF-16 units.
    expect(
      looserSchema({
        type: "object",
        properties: {
          tag: { type: "string", maxLength: 2 },
          id: { type: ["integer", "number", "null"] },
          n: { type: "integer" },
        },
        propertyNames: { maxLength: 3 },
      }),
    ).toEqual({
      type: "object",
      properties: {
        tag: { type: "string", maxLength: 4 },
        id: { type: ["number", "null"] },
        n: { type: "number" },
      },
      propertyNames: { maxLength: 6 },
    });
  });

  test("a value missing a oneOf branch's required key is still refused", async () => {
    const fake = new ScriptedSdk();
    fake.scripts.push([
      init("s-1"),
      success("s-1", { structured_output: { c: "Acme" } }),
    ]);
    const events = await run(
      fake.driver({
        outputSchema: {
          type: "object",
          oneOf: [
            {
              type: "object",
              properties: { a: { type: "string" } },
              required: ["a"],
            },
            {
              type: "object",
              properties: { b: { type: "string" } },
              required: ["b"],
            },
          ],
        },
      }),
    );
    expect(errorsOf(events).map((e) => e.code)).toEqual([
      CLAUDE_OUTPUT_SCHEMA_MISMATCH,
    ]);
  });

  test("an API error sent as a success result keeps its text and class", async () => {
    const fake = new ScriptedSdk();
    fake.scripts.push([
      init("s-1"),
      success("s-1", { is_error: true, result: "API Error: 529 overloaded" }),
    ]);
    const events = await run(fake.driver({ outputSchema: SCHEMA }));
    expect(outputs(events)).toEqual([]);
    const errors = errorsOf(events);
    expect(errors.map((e) => e.code)).toEqual([
      "CLAUDE_AGENT_SDK_RESULT_ERROR",
    ]);
    expect(errors[0]?.message).toContain("API Error: 529 overloaded");
    expect(errors[0]?.recoverable).toBe(true);
    expect(exitCodes(events)).toEqual([1]);
  });

  test("the SDK giving up on the schema is MAX_STRUCTURED_OUTPUT_RETRIES", async () => {
    const fake = new ScriptedSdk();
    fake.scripts.push([
      init("s-1"),
      failure("s-1", "error_max_structured_output_retries"),
    ]);
    const events = await run(fake.driver({ outputSchema: SCHEMA }));
    expect(outputs(events)).toEqual([]);
    const errors = errorsOf(events);
    expect(errors.map((e) => e.code)).toEqual([
      "MAX_STRUCTURED_OUTPUT_RETRIES",
    ]);
    expect(errors[0]?.recoverable).toBe(false);
  });

  test.each([[[]], ["{}"], [null], [42]])(
    "refuses outputSchema %p when the driver is built",
    (schema) => {
      const error = thrown(() =>
        new ScriptedSdk().driver({ outputSchema: schema as never }),
      );
      expect(error).toBeInstanceOf(InputValidationError);
      expect(String((error as Error).message)).toContain("outputSchema");
    },
  );

  test("ClaudeCliDriver refuses outputSchema with a typed error", () => {
    const error = thrown(
      () => new ClaudeCliDriver({ outputSchema: SCHEMA } as never),
    );
    expect(error).toBeInstanceOf(ExternalAgentPolicyError);
    expect((error as ExternalAgentPolicyError).code).toBe(
      EXTERNAL_AGENT_OPTION_UNSUPPORTED,
    );
    expect((error as Error).message).toContain("outputSchema");
  });

  test("the structured value becomes the Workflow node output", async () => {
    expect(await nodeOutputOf({ customer: "Acme", total: 42 })).toEqual([
      { customer: "Acme", total: 42 },
    ]);
  });

  test("a large number in the structured value stays a number", async () => {
    expect(await nodeOutputOf({ customer: "Acme", total: 1e16 })).toEqual([
      { customer: "Acme", total: 1e16 },
    ]);
  });

  async function nodeOutputOf(value: Message): Promise<unknown[]> {
    const fake = new ScriptedSdk();
    fake.scripts.push([
      init("s-1"),
      success("s-1", { structured_output: value }),
    ]);
    const agent = new ExternalAgent({
      name: "acme_summary",
      provider: CLAUDE_PROVIDER,
      driver: fake.driver({ outputSchema: SCHEMA }),
    });
    const received: unknown[] = [];
    const sink = Object.defineProperty(
      (_ctx: unknown, input: unknown) => {
        received.push(input);
        return "done";
      },
      "name",
      { value: "sink" },
    );
    const runner = new InMemoryRunner({
      agent: new Workflow({
        name: "wf",
        edges: [["START", agent, sink]],
      } as never) as never,
      appName: "app",
    });
    const session = await runner.sessionService.createSession({
      appName: "app",
      userId: "user",
    });
    const errors: string[] = [];
    for await (const event of runner.runAsync({
      userId: "user",
      sessionId: session.id,
      newMessage: { role: "user", parts: [{ text: "go" }] },
    }) as AsyncIterable<Event>) {
      if (event.errorCode) errors.push(event.errorMessage ?? event.errorCode);
    }
    expect(errors).toEqual([]);
    return received;
  }

  test("the new codes are exported from adk-llm-bridge/agents", () => {
    expect(agents.CLAUDE_OUTPUT_SCHEMA_MISMATCH).toBe(
      "CLAUDE_OUTPUT_SCHEMA_MISMATCH",
    );
    expect(agents.CLAUDE_MAX_BUDGET_INVALID).toBe("CLAUDE_MAX_BUDGET_INVALID");
  });
});
