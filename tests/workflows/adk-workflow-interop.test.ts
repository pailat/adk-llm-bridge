import { describe, expect, test } from "bun:test";
import {
  BaseAgent,
  createEvent,
  type Event,
  FunctionNode,
  InMemorySessionService,
  type InvocationContext,
  Runner,
  Workflow,
} from "@google/adk";
import { z } from "zod";
import {
  defineScriptWorkflow,
  defineWorkflow,
} from "../../src/workflows/definition.js";
import { ScriptWorkflowAgent } from "../../src/workflows/script-workflow-agent.js";
import { WorkflowAgent } from "../../src/workflows/workflow-agent.js";

/** Contract with ADK's (experimental) graph engine: our agents work as nodes. */

class ReplyAgent extends BaseAgent {
  aborted = false;
  readonly #delayMs: number;

  constructor(name: string, delayMs = 0) {
    super({ name });
    this.#delayMs = delayMs;
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    if (this.#delayMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.#delayMs);
        context.abortSignal?.addEventListener(
          "abort",
          () => {
            this.aborted = true;
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
    const input = context.userContent?.parts?.[0]?.text ?? "";
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: { role: "model", parts: [{ text: `${this.name}:${input}` }] },
    });
  }

  protected async *runLiveImpl() {}
}

function trustedWorkflow(name: string, worker: BaseAgent, options = {}) {
  return new WorkflowAgent({
    name,
    subAgents: [worker],
    definition: defineWorkflow({
      id: name,
      version: "1",
      handler: async (ctx) => {
        const result = await ctx.run({
          id: "step",
          agentName: worker.name,
          input: ctx.inputText,
        });
        return `done(${result.output})`;
      },
    }),
    ...options,
  });
}

async function run(root: Workflow, message = "hi") {
  const sessions = new InMemorySessionService();
  const runner = new Runner({
    appName: "interop",
    agent: root,
    sessionService: sessions,
  });
  const session = await sessions.createSession({
    appName: "interop",
    userId: "user",
  });
  const events: Event[] = [];
  let error: unknown;
  try {
    for await (const event of runner.runAsync({
      userId: "user",
      sessionId: session.id,
      newMessage: { role: "user", parts: [{ text: message }] },
    })) {
      events.push(event);
    }
  } catch (caught) {
    error = caught;
  }
  const finalSession = await sessions.getSession({
    appName: "interop",
    userId: "user",
    sessionId: session.id,
  });
  return { events, error, state: finalSession?.state ?? {} };
}

describe("ADK Workflow interop", () => {
  test("WorkflowAgent as a graph node hands its output to the next node", async () => {
    const after = new FunctionNode("after", (_ctx, input) => ({
      seen: String(input),
    }));
    const graph = new Workflow({
      name: "graph",
      edges: [
        ["START", trustedWorkflow("durable", new ReplyAgent("w")), after],
      ],
    });

    const { events, error } = await run(graph);

    expect(error).toBeUndefined();
    const last = events.find((event) => event.author === "after");
    expect(last?.output).toEqual({ seen: "done(w:hi)" });
  });

  test("ScriptWorkflowAgent works through ctx.runNode", async () => {
    const script = new ScriptWorkflowAgent({
      name: "script",
      definition: defineScriptWorkflow({
        id: "script",
        version: "1",
        source: "return 'scripted';",
      }),
      runtime: {
        capabilities: {
          deterministic: true,
          isolated: true,
          asyncHostCalls: false,
        } as never,
        createSession: async () => {
          let done = false;
          return {
            get disposed() {
              return done;
            },
            next: () => ({ done: true, value: "scripted" }),
            dispose: () => {
              done = true;
            },
          } as never;
        },
      },
    });
    const graph = new Workflow({
      name: "dynamic",
      dynamicEntry: async (ctx, input) => {
        const result = await ctx.runNode(script, input);
        return { got: result.output };
      },
    });

    const { events, error } = await run(graph);

    expect(error).toBeUndefined();
    expect(events.at(-1)?.output).toEqual({ got: "scripted" });
  });

  test("checkpoint deltas pass a strict stateSchema and reach session state", async () => {
    const graph = new Workflow({
      name: "strict",
      stateSchema: z.object({ declared: z.string().optional() }),
      edges: [["START", trustedWorkflow("durable", new ReplyAgent("w"))]],
    });

    const { error, state } = await run(graph);

    expect(error).toBeUndefined();
    expect(
      Object.keys(state).some((key) =>
        key.startsWith("__adk_llm_bridge_workflow_v1:durable:"),
      ),
    ).toBe(true);
  });

  test("a node timeout stops the child agent and the handler", async () => {
    const slow = new ReplyAgent("slow", 2_000);
    let reachedSecondStep = false;
    const durable = new WorkflowAgent({
      name: "durable",
      subAgents: [slow],
      timeout: 0.1,
      definition: defineWorkflow({
        id: "timeout",
        version: "1",
        handler: async (ctx) => {
          await ctx.run({ id: "one", agentName: "slow", input: "x" });
          reachedSecondStep = true;
          await ctx.run({ id: "two", agentName: "slow", input: "x" });
          return "done";
        },
      }),
    });
    const graph = new Workflow({
      name: "timeout",
      edges: [["START", durable]],
    });

    const started = Date.now();
    const { events, error } = await run(graph);

    expect(Date.now() - started).toBeLessThan(1_500);
    const failed =
      error !== undefined ||
      events.some((event) => (event as { isNodeError?: boolean }).isNodeError);
    expect(failed).toBe(true);
    // Allow the aborted runtime to settle before checking the handler.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(slow.aborted).toBe(true);
    expect(reachedSecondStep).toBe(false);
  });

  test("outputSchema receives the parsed JSON text of the final answer", async () => {
    const structured = (text: string) =>
      new WorkflowAgent({
        name: "structured",
        outputSchema: z.object({ a: z.number() }),
        definition: defineWorkflow({
          id: "structured",
          version: "1",
          handler: () => text,
        }),
      });

    const ok = await run(
      new Workflow({ name: "ok", edges: [["START", structured('{"a":1}')]] }),
    );
    expect(ok.error).toBeUndefined();
    expect(ok.events.find((e) => e.output !== undefined)?.output).toEqual({
      a: 1,
    });

    const invalid = await run(
      new Workflow({
        name: "bad",
        edges: [["START", structured('{"a":"x"}')]],
      }),
    );
    const notJson = await run(
      new Workflow({ name: "text", edges: [["START", structured("plain")]] }),
    );
    for (const failedRun of [invalid, notJson]) {
      const failed =
        failedRun.error !== undefined ||
        failedRun.events.some(
          (event) => (event as { isNodeError?: boolean }).isNodeError,
        );
      expect(failed).toBe(true);
    }
  });

  test("distinct run ids keep separate checkpoints with a branch-aware execution id", async () => {
    const worker = new ReplyAgent("w");
    const durable = trustedWorkflow("durable", worker, {
      resolveExecutionId: (ctx: InvocationContext) =>
        `${ctx.invocationId}:${ctx.branch ?? "root"}`,
    });
    const graph = new Workflow({
      name: "twice",
      dynamicEntry: async (ctx) => {
        const a = await ctx.runNode(durable, "a", {
          runId: "run-a",
          useSubBranch: true,
        });
        const b = await ctx.runNode(durable, "b", {
          runId: "run-b",
          useSubBranch: true,
        });
        return [a.output, b.output];
      },
    });

    const { events, error, state } = await run(graph);

    expect(error).toBeUndefined();
    // ADK hands a non-LLM agent its conversation, not the node input.
    expect(events.at(-1)?.output).toEqual(["done(w:hi)", "done(w:hi)"]);
    const keys = Object.keys(state).filter((key) =>
      key.startsWith("__adk_llm_bridge_workflow_v1:durable:"),
    );
    expect(keys).toHaveLength(2);
  });

  describe("node retryConfig", () => {
    class FlakyAgent extends BaseAgent {
      calls = 0;
      readonly #plan: Array<"fail" | "slow" | "ok">;

      constructor(name: string, plan: Array<"fail" | "slow" | "ok">) {
        super({ name });
        this.#plan = plan;
      }

      protected async *runAsyncImpl(context: InvocationContext) {
        const mode = this.#plan[Math.min(this.calls, this.#plan.length - 1)];
        this.calls += 1;
        if (mode === "fail") throw new Error("transient");
        if (mode === "slow") {
          await new Promise<void>((resolve) => {
            // Blocks until the node timeout aborts it; the long fallback never fires.
            const timer = setTimeout(resolve, 10_000);
            context.abortSignal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
        }
        yield createEvent({
          invocationId: context.invocationId,
          author: this.name,
          content: { role: "model", parts: [{ text: `${this.name}:ok` }] },
        });
      }

      protected async *runLiveImpl() {}
    }

    function twoStepWorkflow(
      first: BaseAgent,
      second: BaseAgent,
      options: Record<string, unknown>,
    ) {
      return new WorkflowAgent({
        name: "durable",
        subAgents: [first, second],
        definition: defineWorkflow({
          id: "retry",
          version: "1",
          handler: async (ctx) => {
            const a = await ctx.run({
              id: "first",
              agentName: first.name,
              input: ctx.inputText,
            });
            const b = await ctx.run({
              id: "second",
              agentName: second.name,
              input: ctx.inputText,
            });
            return `${a.output}|${b.output}`;
          },
        }),
        ...options,
      });
    }

    const retryConfig = {
      maxAttempts: 2,
      initialDelay: 0.01,
      jitter: 0,
    };

    test("an ADK retry replays finished steps and re-runs the failed one", async () => {
      const first = new FlakyAgent("first", ["ok"]);
      const second = new FlakyAgent("second", ["fail", "ok"]);
      const graph = new Workflow({
        name: "retry",
        edges: [["START", twoStepWorkflow(first, second, { retryConfig })]],
      });

      const { events, error } = await run(graph);

      expect(error).toBeUndefined();
      expect(first.calls).toBe(1);
      expect(second.calls).toBe(2);
      expect(events.some((e) => e.output === "first:ok|second:ok")).toBe(true);
    });

    test("without retryConfig a re-entered failed step is not re-run", async () => {
      const first = new FlakyAgent("first", ["ok"]);
      const second = new FlakyAgent("second", ["fail", "ok"]);
      const durable = twoStepWorkflow(first, second, {});
      const graph = new Workflow({
        name: "noretry",
        edges: [["START", durable]],
      });

      const { events, error } = await run(graph);

      const failed =
        error !== undefined ||
        events.some((e) => (e as { isNodeError?: boolean }).isNodeError);
      expect(failed).toBe(true);
      expect(second.calls).toBe(1);
    });

    test("a node timeout records the step as failed and the retry completes", async () => {
      const first = new FlakyAgent("first", ["ok"]);
      const second = new FlakyAgent("second", ["slow", "ok"]);
      const graph = new Workflow({
        name: "timeout-retry",
        edges: [
          [
            "START",
            // The timeout applies to each attempt, so it must leave room for a
            // full replay attempt on a loaded machine.
            twoStepWorkflow(first, second, { retryConfig, timeout: 0.6 }),
          ],
        ],
      });

      const { events, error } = await run(graph);

      expect(error).toBeUndefined();
      expect(first.calls).toBe(1);
      expect(second.calls).toBe(2);
      expect(events.some((e) => e.output === "first:ok|second:ok")).toBe(true);
    });
  });
});
