import { describe, expect, test } from "bun:test";
import {
  BaseAgent,
  createEvent,
  type Event,
  InvocationContext,
  PluginManager,
} from "@google/adk";
import type { Content } from "@google/genai";
import { defineWorkflow } from "../../src/workflows/definition.js";
import type { WorkflowEvent } from "../../src/workflows/events.js";
import { WorkflowAgent } from "../../src/workflows/workflow-agent.js";

class ReplyAgent extends BaseAgent {
  calls = 0;
  readonly #outputs: Array<string | Error>;

  constructor(name: string, outputs: Array<string | Error>) {
    super({ name });
    this.#outputs = outputs;
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    const output =
      this.#outputs[Math.min(this.calls, this.#outputs.length - 1)];
    this.calls++;
    if (output instanceof Error) throw output;
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: { role: "model", parts: [{ text: output }] },
    });
  }

  protected async *runLiveImpl() {}
}

/** The workflow event an ADK event carries in its metadata, if any. */
const workflowEventOf = (event: Event) =>
  event.customMetadata?.workflowEvent as WorkflowEvent | undefined;

function invocation(agent: BaseAgent, input = "build it"): InvocationContext {
  return new InvocationContext({
    pluginManager: new PluginManager(),
    invocationId: "inv-workflow",
    branch: "root",
    agent,
    userContent: { role: "user", parts: [{ text: input }] },
    session: {
      id: "session-1",
      appName: "app",
      userId: "user",
      state: {},
      events: [],
      lastUpdateTime: 1,
    },
  });
}

async function collect(agent: BaseAgent, context = invocation(agent)) {
  const events: Event[] = [];
  for await (const event of agent.runAsync(context)) events.push(event);
  return events;
}

function workflowEvents(events: readonly Event[]) {
  return events
    .map((event) => event.customMetadata?.workflowEvent)
    .filter(Boolean) as Array<{ type: string; [key: string]: unknown }>;
}

describe("WorkflowAgent", () => {
  test("executes a trusted workflow as an ADK agent and streams child events", async () => {
    const worker = new ReplyAgent("worker", ["implemented"]);
    const definition = defineWorkflow({
      id: "implementation",
      version: "1",
      handler: async (ctx) => {
        expect(ctx.inputText).toBe("build it");
        ctx.emit({ type: "custom", name: "planning", data: { ready: true } });
        const result = await ctx.run({
          id: "implement",
          agentName: "worker",
          input: ctx.input,
        });
        return `final: ${result.output}`;
      },
    });
    const workflow = new WorkflowAgent({
      name: "workflow",
      definition,
      subAgents: [worker],
    });

    const events = await collect(workflow);
    const lifecycle = workflowEvents(events);

    expect(workflow).toBeInstanceOf(BaseAgent);
    expect(events.some((event) => event.author === "worker")).toBe(true);
    expect(events.find((event) => event.author === "worker")?.branch).toBe(
      "root.worker",
    );
    expect(events.at(-2)?.content).toEqual({
      role: "model",
      parts: [{ text: "final: implemented" }],
    });
    expect(lifecycle.map((event) => event.type)).toEqual([
      "checkpoint_saved",
      "workflow_started",
      "custom",
      "checkpoint_saved",
      "step_started",
      "checkpoint_saved",
      "step_completed",
      "checkpoint_saved",
      "output",
      "workflow_completed",
    ]);
  });

  test("only invokes directly declared sub-agents", async () => {
    const nested = new ReplyAgent("nested", ["no"]);
    const direct = new WorkflowAgent({
      name: "direct",
      definition: defineWorkflow({
        id: "inner",
        version: "1",
        handler: () => undefined,
      }),
      subAgents: [nested],
    });
    const workflow = new WorkflowAgent({
      name: "workflow",
      definition: defineWorkflow({
        id: "outer",
        version: "1",
        handler: async (ctx) =>
          (await ctx.run({ id: "nested", agentName: "nested", input: "task" }))
            .output,
      }),
      subAgents: [direct],
    });

    await expect(collect(workflow)).rejects.toMatchObject({
      code: "WORKFLOW_UNKNOWN_AGENT",
    });
    expect(nested.calls).toBe(0);
  });

  test("enforces unique step ids and the execution step limit", async () => {
    const worker = new ReplyAgent("worker", ["one", "two"]);
    const duplicate = new WorkflowAgent({
      name: "duplicate",
      definition: defineWorkflow({
        id: "duplicate",
        version: "1",
        handler: async (ctx) => {
          await ctx.run({ id: "same", agentName: "worker", input: "one" });
          await ctx.run({ id: "same", agentName: "worker", input: "two" });
        },
      }),
      subAgents: [worker],
    });
    await expect(collect(duplicate)).rejects.toMatchObject({
      code: "WORKFLOW_STEP_MISMATCH",
    });

    const limitedWorker = new ReplyAgent("limited_worker", ["one"]);
    const limited = new WorkflowAgent({
      name: "limited",
      definition: defineWorkflow({
        id: "limited",
        version: "1",
        limits: { maxSteps: 1 },
        handler: async (ctx) => {
          await ctx.run({ id: "one", agentName: "limited_worker", input: "1" });
          await ctx.run({ id: "two", agentName: "limited_worker", input: "2" });
        },
      }),
      subAgents: [limitedWorker],
    });
    await expect(collect(limited)).rejects.toMatchObject({
      code: "WORKFLOW_LIMIT_EXCEEDED",
    });
    expect(limitedWorker.calls).toBe(1);
  });

  test("retries only when the step declares an allowed retry policy", async () => {
    const worker = new ReplyAgent("worker", [new Error("temporary"), "done"]);
    const workflow = new WorkflowAgent({
      name: "workflow",
      definition: defineWorkflow({
        id: "retry",
        version: "1",
        limits: { maxAttemptsPerStep: 2 },
        handler: async (ctx) => {
          const result = await ctx.run({
            id: "retry-step",
            agentName: "worker",
            input: "task",
            retry: { maxAttempts: 2 },
          });
          return result.output;
        },
      }),
      subAgents: [worker],
    });

    const events = await collect(workflow);
    const completed = workflowEvents(events).find(
      (event) => event.type === "step_completed",
    );
    expect(worker.calls).toBe(2);
    expect(
      (completed?.result as { attempts?: number } | undefined)?.attempts,
    ).toBe(2);
    expect(events.at(-2)?.content?.parts?.[0]?.text).toBe("done");
  });

  test("rejects retry policies that are not finite, bounded and known", async () => {
    const invalid: Array<[unknown, string]> = [
      [{ maxAttempts: Number.NaN }, "WORKFLOW_LIMIT_EXCEEDED"],
      [{ maxAttempts: "2" }, "WORKFLOW_LIMIT_EXCEEDED"],
      [{ maxAttempts: 2, delayMs: Number.NaN }, "WORKFLOW_DEFINITION_INVALID"],
      [{ maxAttempts: 2, delayMs: "10" }, "WORKFLOW_DEFINITION_INVALID"],
      [
        { maxAttempts: 2, delayMs: Number.POSITIVE_INFINITY },
        "WORKFLOW_DEFINITION_INVALID",
      ],
      [{ maxAttempts: 2, delayMs: 2 ** 31 }, "WORKFLOW_DEFINITION_INVALID"],
      [{ maxAttempts: 2, maxDelayMs: 2 ** 31 }, "WORKFLOW_DEFINITION_INVALID"],
      [
        { maxAttempts: 2, backoffMultiplier: Number.NaN },
        "WORKFLOW_DEFINITION_INVALID",
      ],
      [{ maxAttempts: 2, delayMs: -1 }, "WORKFLOW_DEFINITION_INVALID"],
      [{ maxAttempts: 2, jitter: true }, "WORKFLOW_DEFINITION_INVALID"],
      ["twice", "WORKFLOW_DEFINITION_INVALID"],
    ];
    for (const [retry, code] of invalid) {
      const worker = new ReplyAgent("worker", ["done"]);
      const workflow = new WorkflowAgent({
        name: "workflow",
        definition: defineWorkflow({
          id: "retry-invalid",
          version: "1",
          limits: { maxAttemptsPerStep: 2 },
          handler: async (ctx) =>
            (
              await ctx.run({
                id: "retry-step",
                agentName: "worker",
                input: "task",
                retry: retry as never,
              })
            ).output,
        }),
        subAgents: [worker],
      });

      await expect(collect(workflow)).rejects.toMatchObject({ code });
      expect(worker.calls).toBe(0);
    }
  });

  test("preserves Content returned by a trusted workflow", async () => {
    const content: Content = {
      role: "model",
      parts: [{ text: "structured" }],
    };
    const workflow = new WorkflowAgent({
      name: "workflow",
      definition: defineWorkflow({
        id: "content",
        version: "1",
        handler: () => content,
      }),
    });

    const events = await collect(workflow);
    expect(events.at(-2)?.content).toBe(content);
  });

  test("marks the final event as the ADK node output", async () => {
    const workflow = new WorkflowAgent({
      name: "workflow",
      definition: defineWorkflow({
        id: "node-output",
        version: "1",
        handler: () => "answer",
      }),
    });

    const events = await collect(workflow);
    const final = events.find(
      (event) => workflowEventOf(event)?.type === "output",
    );
    expect(final?.output).toBe("answer");
    expect(final?.nodeInfo?.messageAsOutput).toBe(true);
    expect(events.filter((event) => event.output !== undefined)).toHaveLength(
      1,
    );
  });

  test("uses the visible text of Content as node output, ignoring thoughts", async () => {
    const workflow = new WorkflowAgent({
      name: "workflow",
      definition: defineWorkflow({
        id: "node-output-content",
        version: "1",
        handler: () => ({
          role: "model",
          parts: [
            { text: "hidden", thought: true },
            { text: "a" },
            { text: "b" },
          ],
        }),
      }),
    });

    const events = await collect(workflow);
    expect(events.find((event) => event.output !== undefined)?.output).toBe(
      "ab",
    );
  });

  test("keeps Content as node output when it has no text", async () => {
    const content: Content = {
      role: "model",
      parts: [{ inlineData: { data: "AA==", mimeType: "image/png" } }],
    };
    const workflow = new WorkflowAgent({
      name: "workflow",
      definition: defineWorkflow({
        id: "node-output-binary",
        version: "1",
        handler: () => content,
      }),
    });

    const events = await collect(workflow);
    expect(events.find((event) => event.output !== undefined)?.output).toBe(
      content,
    );
  });

  test("aborts the runtime when the consumer closes the event stream", async () => {
    let aborted = false;
    let reachedSecondStep = false;
    class SlowAgent extends BaseAgent {
      constructor() {
        super({ name: "slow" });
      }

      protected async *runAsyncImpl(context: InvocationContext) {
        // Delivery has back-pressure: the step is mid-flight while the
        // consumer holds this event.
        yield createEvent({
          invocationId: context.invocationId,
          author: this.name,
          content: { role: "model", parts: [{ text: "working" }] },
        });
        await new Promise<void>((resolve) => {
          if (context.abortSignal?.aborted) {
            aborted = true;
            resolve();
            return;
          }
          const timer = setTimeout(resolve, 2_000);
          context.abortSignal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        yield createEvent({
          invocationId: context.invocationId,
          author: this.name,
          content: { role: "model", parts: [{ text: "late" }] },
        });
      }

      protected async *runLiveImpl() {}
    }
    const workflow = new WorkflowAgent({
      name: "workflow",
      subAgents: [new SlowAgent()],
      definition: defineWorkflow({
        id: "abort-on-close",
        version: "1",
        handler: async (ctx) => {
          await ctx.run({ id: "one", agentName: "slow", input: "x" });
          reachedSecondStep = true;
          await ctx.run({ id: "two", agentName: "slow", input: "x" });
          return "done";
        },
      }),
    });

    const iterator = workflow
      .runAsync(invocation(workflow))
      [Symbol.asyncIterator]();
    // First events are lifecycle/checkpoint ones; stop at step one's first event.
    while (true) {
      const next = await iterator.next();
      if (next.done || next.value.author === "slow") break;
    }
    const closedAt = Date.now();
    await iterator.return?.();

    expect(Date.now() - closedAt).toBeLessThan(1_000);
    expect(aborted).toBe(true);
    expect(reachedSecondStep).toBe(false);
  });

  test("parses JSON text as node output only when outputSchema is declared", async () => {
    const make = (outputSchema?: unknown) =>
      new WorkflowAgent({
        name: "workflow",
        definition: defineWorkflow({
          id: "structured",
          version: "1",
          handler: () => '{"a":1}',
        }),
        ...(outputSchema ? { outputSchema: outputSchema as never } : {}),
      });
    const plain = await collect(make());
    expect(plain.find((e) => e.output !== undefined)?.output).toBe('{"a":1}');

    const parsed = await collect(
      make({ safeParse: () => ({ success: true }) }),
    );
    expect(parsed.find((e) => e.output !== undefined)?.output).toEqual({
      a: 1,
    });
  });

  test("forwards ADK node settings to the BaseAgent", () => {
    const workflow = new WorkflowAgent({
      name: "workflow",
      definition: defineWorkflow({
        id: "node-config",
        version: "1",
        handler: () => "ok",
      }),
      timeout: 3,
      isolationScope: "scope-a",
    });

    expect(workflow.timeout).toBe(3);
    expect(workflow.isolationScope).toBe("scope-a");
  });
});
