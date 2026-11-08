/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  BaseAgent,
  createEvent,
  InvocationContext,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
} from "@google/adk";
import { type Context, context, type Span, trace } from "@opentelemetry/api";
import { defineWorkflow } from "../../src/workflows/definition.js";
import { WorkflowAgent } from "../../src/workflows/workflow-agent.js";

interface RecordedSpan {
  name: string;
  parent?: RecordedSpan;
  attributes: Record<string, unknown>;
  ended: boolean;
}

// biome-ignore lint/suspicious/noExplicitAny: the root context is opaque
const ROOT = context.active() as any as Context;

/** Recording tracer plus an AsyncLocalStorage context manager. */
function installOtel(): RecordedSpan[] {
  const spans: RecordedSpan[] = [];
  const storage = new AsyncLocalStorage<Context>();
  const spanOf = new WeakMap<object, RecordedSpan>();
  context.disable();
  context.setGlobalContextManager({
    active: () => storage.getStore() ?? ROOT,
    with: (
      ctx: Context,
      fn: (...args: never[]) => unknown,
      thisArg?: unknown,
    ) => storage.run(ctx, () => fn.call(thisArg)),
    bind: <T>(_ctx: Context, target: T) => target,
    enable() {
      return this;
    },
    disable() {
      return this;
    },
  } as never);
  trace.disable();
  trace.setGlobalTracerProvider({
    getTracer: () => ({
      startSpan(name: string, _options?: unknown, ctx?: Context) {
        const parentSpan = trace.getSpan(ctx ?? context.active());
        const record: RecordedSpan = {
          name,
          parent: parentSpan ? spanOf.get(parentSpan) : undefined,
          attributes: {},
          ended: false,
        };
        spans.push(record);
        const span = {
          setAttributes(attributes: Record<string, unknown>) {
            Object.assign(record.attributes, attributes);
            return span;
          },
          setAttribute(key: string, value: unknown) {
            record.attributes[key] = value;
            return span;
          },
          setStatus() {
            return span;
          },
          recordException() {},
          spanContext: () => ({ traceId: "t", spanId: "s", traceFlags: 1 }),
          isRecording: () => true,
          end() {
            record.ended = true;
          },
        };
        spanOf.set(span, record);
        return span as unknown as Span;
      },
    }),
  } as never);
  return spans;
}

let spans: RecordedSpan[];

beforeEach(() => {
  spans = installOtel();
});

afterEach(() => {
  trace.disable();
  context.disable();
});

const byName = (name: string) => spans.find((span) => span.name === name);

/** Opens a span the way ADK's `invoke_agent` does, then optionally pauses. */
class TracedAgent extends BaseAgent {
  constructor(
    name: string,
    private readonly ask = false,
  ) {
    super({ name });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    trace
      .getTracer("gcp.vertex.agent")
      .startSpan(`invoke_agent ${this.name}`)
      .end();
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: this.ask
        ? {
            role: "model",
            parts: [
              {
                functionCall: {
                  id: "ask-1",
                  name: REQUEST_INPUT_FUNCTION_CALL_NAME,
                  args: { message: "?" },
                },
              },
            ],
          }
        : { role: "model", parts: [{ text: "ok" }] },
      ...(this.ask ? { longRunningToolIds: ["ask-1"] } : {}),
    });
  }

  protected async *runLiveImpl() {}
}

function run(agent: BaseAgent) {
  const context = new InvocationContext({
    invocationId: "inv",
    agent,
    userContent: { role: "user", parts: [{ text: "go" }] },
    session: {
      id: "session-1",
      appName: "a",
      userId: "u",
      state: {},
      events: [],
      lastUpdateTime: 1,
    },
  });
  return (async () => {
    for await (const _ of agent.runAsync(context)) {
      // drain
    }
  })();
}

function workflowOf(child: BaseAgent) {
  return new WorkflowAgent({
    name: "pipeline",
    subAgents: [child],
    definition: defineWorkflow({
      id: "traced",
      version: "1",
      handler: async (ctx) =>
        (await ctx.run({ id: "build", agentName: child.name, input: "x" }))
          .output,
    }),
  });
}

describe("workflow runtime spans", () => {
  test("one invoke_workflow span, one execute_node span per step, sub-agent spans nested", async () => {
    await run(workflowOf(new TracedAgent("worker")));

    const workflow = byName("invoke_workflow pipeline");
    const step = byName("execute_node build");
    const child = byName("invoke_agent worker");
    expect(workflow?.attributes["gen_ai.conversation.id"]).toBe("session-1");
    expect(step?.parent).toBe(workflow);
    expect(child?.parent).toBe(step);
    expect(step?.attributes["adk.node.status"]).toBe("completed");
    expect(spans.every((span) => span.ended)).toBe(true);
    expect(spans.filter((s) => s.name.startsWith("execute_node"))).toHaveLength(
      1,
    );
  });

  test("a step waiting for input ends its span as waiting, not failed", async () => {
    await run(workflowOf(new TracedAgent("worker", true)));

    const step = byName("execute_node build");
    expect(step?.attributes["adk.node.status"]).toBe("waiting");
    expect(step?.attributes["adk.node.interrupt_count"]).toBe(1);
    expect(step?.attributes["error.type"]).toBeUndefined();
  });

  test("no span carries workflow input or output text", async () => {
    await run(workflowOf(new TracedAgent("worker")));

    const text = JSON.stringify(spans.map((s) => [s.name, s.attributes]));
    expect(text).not.toContain('"go"');
    expect(text).not.toContain('ok"');
  });
});
