/**
 * `maxLlmCalls` overflow through the gateway with a real `LlmAgent`.
 *
 * ADK catches the limit error inside `LlmAgent` and yields an error event, so
 * the gateway must recognise that event, and only that event, as the limit.
 */
import { describe, expect, test } from "bun:test";
import {
  BaseAgent,
  BaseLlm,
  type BaseLlmConnection,
  createEvent,
  type InvocationContext,
  LlmAgent,
  type LlmResponse,
} from "@google/adk";
import type { Content } from "@google/genai";
import {
  AgentInvocationGateway,
  type AgentInvocationResult,
} from "../../src/runtime/agent-invocation-gateway.js";
import {
  parentContext,
  ScriptAgent,
  ScriptedLlm,
  Trace,
} from "./gateway-characterization/scenarios.js";

class RootAgent extends BaseAgent {
  constructor() {
    super({ name: "root" });
  }
  protected async *runAsyncImpl() {}
  protected async *runLiveImpl() {}
}

const input: Content = { role: "user", parts: [{ text: "go" }] };
const reply = (text: string) => ({
  content: { role: "model", parts: [{ text }] },
});

function worker(name: string): LlmAgent {
  return new LlmAgent({ name, model: new ScriptedLlm([reply(`${name} ok`)]) });
}

function contextWithLimit(maxLlmCalls: number | undefined): InvocationContext {
  const context = parentContext(new RootAgent());
  context.runConfig = { maxLlmCalls } as InvocationContext["runConfig"];
  return context;
}

/** Spends the whole budget, then one more call so the counter is over it. */
function exhaust(context: InvocationContext): void {
  const limit = context.runConfig?.maxLlmCalls ?? 0;
  for (let i = 0; i <= limit; i++) {
    try {
      context.incrementLlmCallCount();
    } catch {
      // The overflow is the point.
    }
  }
}

function gatewayFor(...agents: BaseAgent[]): AgentInvocationGateway {
  return new AgentInvocationGateway({
    resolveAgent: (name) => agents.find((agent) => agent.name === name),
  });
}

async function run(
  gateway: AgentInvocationGateway,
  agentName: string,
  parentContext: InvocationContext,
): Promise<AgentInvocationResult> {
  return gateway.run({ agentName, input, parentContext });
}

describe("maxLlmCalls overflow", () => {
  test("a real LlmAgent over the budget reports llm-calls-limit", async () => {
    const context = contextWithLimit(1);
    context.incrementLlmCallCount();
    const result = await run(gatewayFor(worker("w")), "w", context);
    expect(result.errorKind).toBe("llm-calls-limit");
    expect(result.error).toBe("Max number of llm calls limit of 1 exceeded");
    expect(result.summary.errors).toBe(1);
  });

  test("a run inside the budget has no error", async () => {
    const result = await run(gatewayFor(worker("w")), "w", contextWithLimit(1));
    expect(result.errorKind).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  test("the budget is shared across nested gateway hops", async () => {
    const leaf = worker("leaf");
    const inner = gatewayFor(leaf);
    const middle = new ScriptAgent("middle", new Trace(), async function* (c) {
      const result = await inner.run({
        agentName: "leaf",
        input,
        parentContext: c,
      });
      yield createEvent({
        invocationId: c.invocationId,
        author: "middle",
        content: { role: "model", parts: [{ text: result.errorKind ?? "ok" }] },
      });
    });
    const context = contextWithLimit(1);
    context.incrementLlmCallCount();
    const outer = await run(gatewayFor(middle), "middle", context);
    expect(outer.output).toBe("llm-calls-limit");
    expect(outer.errorKind).toBeUndefined();
  });

  test("a limit event without a configured budget stays agent-error", async () => {
    const bad = new ScriptAgent("bad", new Trace(), async function* (c) {
      yield createEvent({
        invocationId: c.invocationId,
        author: "bad",
        errorCode: "UNKNOWN_ERROR",
        errorMessage: "Max number of llm calls limit of 0 exceeded",
      });
    });
    const context = contextWithLimit(0);
    exhaust(context);
    const result = await run(gatewayFor(bad), "bad", context);
    expect(result.errorKind).toBe("agent-error");
  });

  test("an unlimited budget (0 or unset) never reports the limit", async () => {
    for (const limit of [0, undefined]) {
      const context = contextWithLimit(limit);
      context.incrementLlmCallCount();
      context.incrementLlmCallCount();
      const result = await run(gatewayFor(worker("w")), "w", context);
      expect(result.errorKind).toBeUndefined();
    }
  });
});

describe("ADK conformance for the limit detection", () => {
  test("invocationCostManager.numberOfLlmCalls is a number that grows per call", () => {
    const context = contextWithLimit(10);
    const read = () =>
      (
        context as unknown as {
          invocationCostManager: { numberOfLlmCalls: unknown };
        }
      ).invocationCostManager.numberOfLlmCalls;
    expect(read()).toBe(0);
    context.incrementLlmCallCount();
    expect(read()).toBe(1);
    context.incrementLlmCallCount();
    expect(read()).toBe(2);
  });

  test("the counter is incremented before the limit error is thrown", () => {
    const context = contextWithLimit(1);
    context.incrementLlmCallCount();
    expect(() => context.incrementLlmCallCount()).toThrow();
    const manager = (
      context as unknown as {
        invocationCostManager: { numberOfLlmCalls: number };
      }
    ).invocationCostManager;
    expect(manager.numberOfLlmCalls).toBe(2);
  });

  test("a child context shares the parent's counter", async () => {
    let childCounter: unknown;
    const spy = new ScriptAgent("spy", new Trace(), async function* (c) {
      childCounter = (c as unknown as { invocationCostManager: unknown })
        .invocationCostManager;
      yield createEvent({
        invocationId: c.invocationId,
        author: "spy",
        content: { role: "model", parts: [{ text: "seen" }] },
      });
    });
    const context = contextWithLimit(3);
    await run(gatewayFor(spy), "spy", context);
    expect(childCounter).toBe(
      (context as unknown as { invocationCostManager: unknown })
        .invocationCostManager,
    );
  });
});

describe("error events that are not the limit stay agent-error", () => {
  const failing = (fields: { errorCode?: string; errorMessage: string }) =>
    new ScriptAgent("bad", new Trace(), async function* (c) {
      yield createEvent({
        invocationId: c.invocationId,
        author: "bad",
        ...fields,
      });
    });

  test("an ordinary model error event", async () => {
    const result = await run(
      gatewayFor(failing({ errorCode: "UNKNOWN_ERROR", errorMessage: "boom" })),
      "bad",
      contextWithLimit(5),
    );
    expect(result.errorKind).toBe("agent-error");
    expect(result.error).toBe("boom");
  });

  test("the limit message of a different budget size", async () => {
    const context = contextWithLimit(5);
    exhaust(context);
    const result = await run(
      gatewayFor(
        failing({
          errorCode: "UNKNOWN_ERROR",
          errorMessage: "Max number of llm calls limit of 7 exceeded",
        }),
      ),
      "bad",
      context,
    );
    expect(result.errorKind).toBe("agent-error");
  });

  test("the limit text when the counter only equals the budget", async () => {
    const context = contextWithLimit(1);
    context.incrementLlmCallCount();
    const result = await run(
      gatewayFor(
        failing({
          errorCode: "UNKNOWN_ERROR",
          errorMessage: "Max number of llm calls limit of 1 exceeded",
        }),
      ),
      "bad",
      context,
    );
    expect(result.errorKind).toBe("agent-error");
  });

  test("the limit text when ADK's counter cannot be read", async () => {
    for (const manager of [undefined, {}, { numberOfLlmCalls: "9" }]) {
      const context = contextWithLimit(1);
      exhaust(context);
      (context as unknown as Record<string, unknown>).invocationCostManager =
        manager;
      const result = await run(
        gatewayFor(
          failing({
            errorCode: "UNKNOWN_ERROR",
            errorMessage: "Max number of llm calls limit of 1 exceeded",
          }),
        ),
        "bad",
        context,
      );
      expect(result.errorKind).toBe("agent-error");
    }
  });

  test("a different error after the budget is exhausted", async () => {
    const context = contextWithLimit(1);
    exhaust(context);
    const result = await run(
      gatewayFor(failing({ errorCode: "500", errorMessage: "server down" })),
      "bad",
      context,
    );
    expect(result.errorKind).toBe("agent-error");
  });

  test("a model that throws the limit text inside its budget", async () => {
    class ThrowingLlm extends BaseLlm {
      constructor() {
        super({ model: "throwing" });
      }
      // biome-ignore lint/correctness/useYield: throws before any response
      async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
        throw new Error("Max number of llm calls limit of 5 exceeded");
      }
      async connect(): Promise<BaseLlmConnection> {
        throw new Error("not implemented");
      }
    }
    const agent = new LlmAgent({ name: "w", model: new ThrowingLlm() });
    const context = contextWithLimit(5);
    const result = await run(gatewayFor(agent), "w", context);
    expect(result.errorKind).toBe("agent-error");
    expect(result.error).toBe("Max number of llm calls limit of 5 exceeded");
  });

  test("the limit text in another case", async () => {
    const context = contextWithLimit(1);
    exhaust(context);
    const result = await run(
      gatewayFor(
        failing({
          errorCode: "UNKNOWN_ERROR",
          errorMessage: "max number of llm calls limit of 1 exceeded",
        }),
      ),
      "bad",
      context,
    );
    expect(result.errorKind).toBe("agent-error");
  });

  test("the last error wins after a limit event", async () => {
    const both = new ScriptAgent("both", new Trace(), async function* (c) {
      yield createEvent({
        invocationId: c.invocationId,
        author: "both",
        errorCode: "UNKNOWN_ERROR",
        errorMessage: "Max number of llm calls limit of 1 exceeded",
      });
      yield createEvent({
        invocationId: c.invocationId,
        author: "both",
        errorCode: "500",
        errorMessage: "server down",
      });
    });
    const context = contextWithLimit(1);
    exhaust(context);
    const result = await run(gatewayFor(both), "both", context);
    expect(result.errorKind).toBe("agent-error");
    expect(result.error).toBe("server down");
    expect(result.summary.errors).toBe(2);
  });

  test("the limit text with a provider error code", async () => {
    const context = contextWithLimit(1);
    exhaust(context);
    const result = await run(
      gatewayFor(
        failing({
          errorCode: "429",
          errorMessage: "Max number of llm calls limit of 1 exceeded",
        }),
      ),
      "bad",
      context,
    );
    expect(result.errorKind).toBe("agent-error");
  });
});
