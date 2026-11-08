import { describe, expect, test } from "bun:test";
import {
  BaseAgent,
  createEvent,
  createEventActions,
  type Event,
  InvocationContext,
  LlmCallsLimitExceededError,
  PluginManager,
} from "@google/adk";
import {
  getInheritedPermissions,
  setInheritedPermissions,
} from "../../src/agents/permissions/inheritance.js";
import { AgentInvocationGateway } from "../../src/runtime/agent-invocation-gateway.js";

class CaptureAgent extends BaseAgent {
  context?: InvocationContext;

  constructor(
    name = "worker",
    private readonly eventsToYield: Event[] = [],
  ) {
    super({ name });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.context = context;
    yield* this.eventsToYield;
  }

  protected async *runLiveImpl() {}
}

function parentContext(
  agent: BaseAgent,
  abortSignal?: AbortSignal,
): InvocationContext {
  return new InvocationContext({
    invocationId: "inv-1",
    branch: "root",
    agent,
    userContent: { role: "user", parts: [{ text: "parent task" }] },
    session: {
      id: "session-1",
      appName: "app",
      userId: "user",
      state: { shared: true },
      events: [
        createEvent({
          invocationId: "previous",
          author: "user",
          content: { role: "user", parts: [{ text: "previous task" }] },
        }),
      ],
      lastUpdateTime: 1,
    },
    pluginManager: new PluginManager(),
    abortSignal,
  });
}

describe("AgentInvocationGateway", () => {
  test("runs with a real child InvocationContext and isolated session history", async () => {
    const worker = new CaptureAgent("worker", [
      createEvent({
        invocationId: "inv-1",
        author: "worker",
        content: { role: "model", parts: [{ text: "done" }] },
      }),
    ]);
    const root = new CaptureAgent("root");
    const context = parentContext(root);
    const gateway = new AgentInvocationGateway({
      resolveAgent: (name) => (name === worker.name ? worker : undefined),
    });

    const result = await gateway.run({
      agentName: "worker",
      input: { role: "user", parts: [{ text: "delegated task" }] },
      parentContext: context,
      branch: "root.worker",
      sessionState: { delegatedCapability: { fencingToken: 7 } },
    });

    expect(result.output).toBe("done");
    expect(worker.context).toBeInstanceOf(InvocationContext);
    expect(worker.context?.agent).toBe(worker);
    expect(worker.context?.invocationId).toBe(context.invocationId);
    expect(worker.context?.branch).toBe("root.worker");
    expect(worker.context?.pluginManager).toBe(context.pluginManager);
    expect(worker.context?.session).not.toBe(context.session);
    expect(worker.context?.session.state).not.toBe(context.session.state);
    expect(worker.context?.session.state).toEqual({
      shared: true,
      delegatedCapability: { fencingToken: 7 },
    });
    expect(context.session.state).toEqual({ shared: true });
    expect(worker.context?.session.events.at(-2)?.content).toEqual({
      role: "user",
      parts: [{ text: "delegated task" }],
    });
    expect(worker.context?.session.events.at(-1)).toBe(result.events[0]);
    expect(context.session.events).toHaveLength(1);
  });

  test("replace mode projects state without inheriting parent secrets", async () => {
    const worker = new CaptureAgent();
    const root = new CaptureAgent("root");
    const context = parentContext(root);
    context.session.state = {
      secret: "parent-only",
      workflowTask: { taskId: "parent-task" },
    };
    const gateway = new AgentInvocationGateway({ resolveAgent: () => worker });

    await gateway.run({
      agentName: "worker",
      input: { role: "user", parts: [{ text: "task" }] },
      parentContext: context,
      sessionState: { workflowTask: { taskId: "child-task" } },
      sessionStateMode: "replace",
    });

    expect(worker.context?.session.state).toEqual({
      workflowTask: { taskId: "child-task" },
    });
    expect(context.session.state).toEqual({
      secret: "parent-only",
      workflowTask: { taskId: "parent-task" },
    });
  });

  test("replace history mode hides parent events without mutating them", async () => {
    const worker = new CaptureAgent();
    const root = new CaptureAgent("root");
    const context = parentContext(root);
    const parentEvent = context.session.events[0];
    const gateway = new AgentInvocationGateway({ resolveAgent: () => worker });

    await gateway.run({
      agentName: "worker",
      input: { role: "user", parts: [{ text: "isolated task" }] },
      parentContext: context,
      sessionHistoryMode: "replace",
    });

    expect(worker.context?.session.events).toHaveLength(1);
    expect(worker.context?.session.events[0]?.content).toEqual({
      role: "user",
      parts: [{ text: "isolated task" }],
    });
    expect(worker.context?.session.events).not.toContain(parentEvent);
    expect(context.session.events).toEqual([parentEvent]);
  });

  test("propagates typed validation errors before resolution", async () => {
    class StaleAttemptError extends Error {}
    const stale = new StaleAttemptError("stale attempt");
    let resolutions = 0;
    const gateway = new AgentInvocationGateway({
      resolveAgent: () => {
        resolutions++;
        return new CaptureAgent();
      },
    });

    await expect(
      gateway.run({
        agentName: "worker",
        input: { role: "user", parts: [{ text: "task" }] },
        parentContext: parentContext(new CaptureAgent("root")),
        validateInvocation: (phase) => {
          expect(phase).toBe("before-resolve");
          throw stale;
        },
      }),
    ).rejects.toBe(stale);
    expect(resolutions).toBe(0);
  });

  test("revalidates after resolution and before context preparation", async () => {
    class StaleAttemptError extends Error {}
    const stale = new StaleAttemptError("ownership transferred");
    const worker = new CaptureAgent();
    const phases: string[] = [];
    let preparations = 0;
    const gateway = new AgentInvocationGateway({ resolveAgent: () => worker });

    await expect(
      gateway.run({
        agentName: "worker",
        input: { role: "user", parts: [{ text: "task" }] },
        parentContext: parentContext(new CaptureAgent("root")),
        validateInvocation: (phase) => {
          phases.push(phase);
          if (phase === "before-prepare") throw stale;
        },
        prepareContext: () => {
          preparations++;
        },
      }),
    ).rejects.toBe(stale);
    expect(phases).toEqual(["before-resolve", "before-prepare"]);
    expect(preparations).toBe(0);
    expect(worker.context).toBeUndefined();
  });

  test("revalidates after context preparation and immediately before execution", async () => {
    class StaleAttemptError extends Error {}
    const stale = new StaleAttemptError("revoked during preparation");
    const worker = new CaptureAgent();
    const phases: string[] = [];
    let valid = true;
    const gateway = new AgentInvocationGateway({ resolveAgent: () => worker });

    await expect(
      gateway.run({
        agentName: "worker",
        input: { role: "user", parts: [{ text: "task" }] },
        parentContext: parentContext(new CaptureAgent("root")),
        validateInvocation: (phase) => {
          phases.push(phase);
          if (!valid) throw stale;
        },
        prepareContext: async () => {
          await Promise.resolve();
          valid = false;
        },
      }),
    ).rejects.toBe(stale);
    expect(phases).toEqual([
      "before-resolve",
      "before-prepare",
      "before-execute",
    ]);
    expect(worker.context).toBeUndefined();
  });

  test("streams events and aggregates text, tools, errors, and state", async () => {
    const events = [
      createEvent({
        invocationId: "inv-1",
        author: "worker",
        partial: true,
        content: { role: "model", parts: [{ text: "par" }] },
      }),
      createEvent({
        invocationId: "inv-1",
        author: "worker",
        content: {
          role: "model",
          parts: [
            { text: "final" },
            { functionCall: { id: "call-1", name: "tool", args: {} } },
          ],
        },
        actions: createEventActions({ stateDelta: { answer: 42 } }),
      }),
      createEvent({
        invocationId: "inv-1",
        author: "worker",
        errorMessage: "recoverable error",
      }),
    ];
    const worker = new CaptureAgent("worker", events);
    const root = new CaptureAgent("root");
    const streamed: Event[] = [];
    const gateway = new AgentInvocationGateway({
      resolveAgent: () => worker,
      eventSink: async (event) => {
        await Promise.resolve();
        streamed.push(event);
      },
    });

    const result = await gateway.run({
      agentName: "worker",
      input: { role: "user", parts: [{ text: "task" }] },
      parentContext: parentContext(root),
    });

    expect(streamed).toEqual(events);
    expect(result.events).toEqual(events);
    expect(result.output).toBe("final");
    expect(result.stateDelta).toEqual({ answer: 42 });
    expect(result.error).toBe("recoverable error");
    expect(result.summary).toEqual({
      events: 3,
      textEvents: 1,
      toolCalls: 1,
      errors: 1,
      durationMs: expect.any(Number),
    });
  });

  test("uses function-response output when there is no visible text", async () => {
    const worker = new CaptureAgent("worker", [
      createEvent({
        invocationId: "inv-1",
        author: "worker",
        content: {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: "call-1",
                name: "tool",
                response: { output: "tool output" },
              },
            },
          ],
        },
      }),
    ]);
    const root = new CaptureAgent("root");
    const gateway = new AgentInvocationGateway({ resolveAgent: () => worker });

    const result = await gateway.run({
      agentName: "worker",
      input: { role: "user", parts: [{ text: "task" }] },
      parentContext: parentContext(root),
    });

    expect(result.output).toBe("tool output");
  });

  test("uses terminal visible text without preceding progress", async () => {
    const worker = new CaptureAgent("worker", [
      createEvent({
        invocationId: "inv-1",
        author: "worker",
        content: { role: "model", parts: [{ text: '{"status":"working"}' }] },
      }),
      createEvent({
        invocationId: "inv-1",
        author: "worker",
        content: { role: "model", parts: [{ text: '{"status":"done"}' }] },
        turnComplete: true,
      }),
    ]);
    const root = new CaptureAgent("root");
    const gateway = new AgentInvocationGateway({ resolveAgent: () => worker });

    const result = await gateway.run({
      agentName: "worker",
      input: { role: "user", parts: [{ text: "task" }] },
      parentContext: parentContext(root),
    });

    expect(result.output).toBe('{"status":"done"}');
    expect(result.summary.textEvents).toBe(2);
  });

  test("uses the latest visible terminal event", async () => {
    const worker = new CaptureAgent("worker", [
      createEvent({
        invocationId: "inv-1",
        author: "worker",
        content: { role: "model", parts: [{ text: "first terminal" }] },
        turnComplete: true,
      }),
      createEvent({
        invocationId: "inv-1",
        author: "worker",
        content: { role: "model", parts: [{ text: "late progress" }] },
      }),
      createEvent({
        invocationId: "inv-1",
        author: "worker",
        content: { role: "model", parts: [{ text: "latest terminal" }] },
        turnComplete: true,
      }),
    ]);
    const root = new CaptureAgent("root");
    const gateway = new AgentInvocationGateway({ resolveAgent: () => worker });

    const result = await gateway.run({
      agentName: "worker",
      input: { role: "user", parts: [{ text: "task" }] },
      parentContext: parentContext(root),
    });

    expect(result.output).toBe("latest terminal");
  });

  test("aggregates visible text when no terminal event is emitted", async () => {
    const worker = new CaptureAgent("worker", [
      createEvent({
        invocationId: "inv-1",
        author: "worker",
        content: { role: "model", parts: [{ text: "first" }] },
      }),
      createEvent({
        invocationId: "inv-1",
        author: "worker",
        content: { role: "model", parts: [{ text: "second" }] },
      }),
    ]);
    const root = new CaptureAgent("root");
    const gateway = new AgentInvocationGateway({ resolveAgent: () => worker });

    const result = await gateway.run({
      agentName: "worker",
      input: { role: "user", parts: [{ text: "task" }] },
      parentContext: parentContext(root),
    });

    expect(result.output).toBe("first\nsecond");
  });

  test("returns a controlled result when resolution fails", async () => {
    const root = new CaptureAgent("root");
    const gateway = new AgentInvocationGateway({
      resolveAgent: () => undefined,
    });

    const result = await gateway.run({
      agentName: "missing",
      input: { role: "user", parts: [{ text: "task" }] },
      parentContext: parentContext(root),
    });

    expect(result).toMatchObject({
      agentName: "missing",
      output: "",
      events: [],
      error: "Unknown ADK agent: missing",
      summary: { events: 0, textEvents: 0, toolCalls: 0, errors: 1 },
    });
  });

  test("combines parent and request cancellation signals", async () => {
    const parentAbort = new AbortController();
    const requestAbort = new AbortController();
    const worker = new CaptureAgent("worker");
    const root = new CaptureAgent("root");
    const gateway = new AgentInvocationGateway({ resolveAgent: () => worker });

    requestAbort.abort(new Error("request cancelled"));
    const result = await gateway.run({
      agentName: "worker",
      input: { role: "user", parts: [{ text: "task" }] },
      parentContext: parentContext(root, parentAbort.signal),
      abortSignal: requestAbort.signal,
    });

    expect(result.error).toBe("request cancelled");
    expect(result.summary.errors).toBe(1);
    expect(worker.context).toBeUndefined();
  });

  test("allows callers to prepare the neutral child context", async () => {
    const worker = new CaptureAgent("worker");
    const root = new CaptureAgent("root");
    const gateway = new AgentInvocationGateway({ resolveAgent: () => worker });
    let preparedContext: InvocationContext | undefined;

    await gateway.run({
      agentName: "worker",
      input: { role: "user", parts: [{ text: "task" }] },
      parentContext: parentContext(root),
      prepareContext: (context) => {
        preparedContext = context;
        (context as InvocationContext & { callerData?: string }).callerData =
          "custom";
      },
    });

    expect(preparedContext).toBeInstanceOf(InvocationContext);
    expect(
      (preparedContext as InvocationContext & { callerData?: string })
        .callerData,
    ).toBe("custom");
  });

  test("child context shares the parent LLM call budget and ADK 2 scope fields", async () => {
    const worker = new CaptureAgent();
    const root = new CaptureAgent("root");
    const context = parentContext(root);
    context.runConfig = { maxLlmCalls: 2 } as InvocationContext["runConfig"];
    context.isolationScope = "scope-1";
    const gateway = new AgentInvocationGateway({ resolveAgent: () => worker });

    await gateway.run({
      agentName: "worker",
      input: { role: "user", parts: [{ text: "task" }] },
      parentContext: context,
      branch: "root.worker",
    });

    const child = worker.context as InvocationContext;
    expect(child.isolationScope).toBe("scope-1");
    expect(child.nodeToolDepth).toBe(context.nodeToolDepth);
    // Single counter per invocation: parent and child exhaust maxLlmCalls together.
    context.incrementLlmCallCount();
    child.incrementLlmCallCount();
    expect(() => child.incrementLlmCallCount()).toThrow();
    expect(() => context.incrementLlmCallCount()).toThrow();
  });

  describe("ADK session semantics", () => {
    class ScriptAgent extends BaseAgent {
      context?: InvocationContext;
      constructor(
        name: string,
        private readonly script: (
          context: InvocationContext,
        ) => AsyncGenerator<Event, void, void>,
      ) {
        super({ name });
      }
      protected async *runAsyncImpl(context: InvocationContext) {
        this.context = context;
        yield* this.script(context);
      }
      protected async *runLiveImpl() {}
    }

    const modelEvent = (
      parts: Event["content"] extends infer C
        ? C extends { parts?: infer P }
          ? P
          : never
        : never,
      extra: Partial<Event> = {},
    ) =>
      createEvent({
        invocationId: "inv-1",
        author: "worker",
        content: { role: "model", parts },
        ...extra,
      });

    test("applies stateDelta to the child state, trims temp: keys and skips partials", async () => {
      let seenByNext: unknown;
      const worker = new ScriptAgent("worker", async function* (context) {
        yield modelEvent([{ text: "typing" }], { partial: true });
        yield modelEvent([{ text: "done" }], {
          actions: createEventActions({
            stateDelta: { k: 1, "temp:scratch": 2 },
          }),
        });
        seenByNext = { ...context.session.state };
      });
      const root = new CaptureAgent("root");
      const context = parentContext(root);
      const gateway = new AgentInvocationGateway({
        resolveAgent: () => worker,
      });

      const result = await gateway.run({
        agentName: "worker",
        input: { role: "user", parts: [{ text: "go" }] },
        parentContext: context,
      });

      expect(seenByNext).toEqual({ shared: true, k: 1 });
      expect(result.stateDelta).toEqual({ k: 1 });
      expect(context.session.state).toEqual({ shared: true });
      const childEvents = worker.context?.session.events ?? [];
      expect(childEvents.some((event) => event.partial)).toBe(false);
      expect(childEvents).toHaveLength(3);
      // The partial still reaches sinks and the result stream.
      expect(result.events).toHaveLength(2);
    });

    test("replace mode keeps the child state frozen while applying deltas", async () => {
      const worker = new ScriptAgent("worker", async function* () {
        yield modelEvent([{ text: "ok" }], {
          actions: createEventActions({ stateDelta: { fresh: true } }),
        });
      });
      const gateway = new AgentInvocationGateway({
        resolveAgent: () => worker,
      });

      await gateway.run({
        agentName: "worker",
        input: { role: "user", parts: [{ text: "go" }] },
        parentContext: parentContext(new CaptureAgent("root")),
        sessionState: { seed: 1 },
        sessionStateMode: "replace",
      });

      expect(worker.context?.session.state).toEqual({ seed: 1, fresh: true });
      expect(Object.isFrozen(worker.context?.session.state)).toBe(true);
    });

    test("excludes thought parts from the output", async () => {
      const worker = new ScriptAgent("worker", async function* () {
        yield modelEvent([
          { text: "secret reasoning", thought: true },
          { text: "answer" },
        ]);
      });
      const gateway = new AgentInvocationGateway({
        resolveAgent: () => worker,
      });

      const result = await gateway.run({
        agentName: "worker",
        input: { role: "user", parts: [{ text: "go" }] },
        parentContext: parentContext(new CaptureAgent("root")),
      });

      expect(result.output).toBe("answer");
      expect(result.errorKind).toBeUndefined();
    });
  });

  describe("cancellation and error classification", () => {
    class StallAgent extends BaseAgent {
      returned = false;
      constructor() {
        super({ name: "stall" });
      }
      protected async *runAsyncImpl() {
        try {
          yield createEvent({
            invocationId: "inv-1",
            author: "stall",
            content: { role: "model", parts: [{ text: "started" }] },
          });
          await new Promise<never>(() => undefined);
        } finally {
          this.returned = true;
        }
      }
      protected async *runLiveImpl() {}
    }

    test("releases run() when the agent stalls without emitting after abort", async () => {
      const stall = new StallAgent();
      const abort = new AbortController();
      setTimeout(() => abort.abort(new Error("stop now")), 50);
      const gateway = new AgentInvocationGateway({
        resolveAgent: () => stall,
      });

      const outcome = await Promise.race([
        gateway.run({
          agentName: "stall",
          input: { role: "user", parts: [{ text: "go" }] },
          parentContext: parentContext(new CaptureAgent("root")),
          abortSignal: abort.signal,
        }),
        new Promise<"hung">((resolve) =>
          setTimeout(() => resolve("hung"), 1500),
        ),
      ]);

      expect(outcome).not.toBe("hung");
      if (outcome === "hung") return;
      // return() queues behind the parked await, so it cannot run: documented.
      expect(stall.returned).toBe(false);
      expect(outcome.error).toBe("stop now");
      expect(outcome.errorKind).toBe("aborted");
    });

    test("classifies the shared LLM call budget error", async () => {
      class LimitAgent extends BaseAgent {
        constructor() {
          super({ name: "limit" });
        }
        protected async *runAsyncImpl(): AsyncGenerator<Event, void, void> {
          yield* [];
          throw new LlmCallsLimitExceededError("budget exhausted");
        }
        protected async *runLiveImpl() {}
      }
      const gateway = new AgentInvocationGateway({
        resolveAgent: () => new LimitAgent(),
      });

      const result = await gateway.run({
        agentName: "limit",
        input: { role: "user", parts: [{ text: "go" }] },
        parentContext: parentContext(new CaptureAgent("root")),
      });

      expect(result.error).toBe("budget exhausted");
      expect(result.errorKind).toBe("llm-calls-limit");
    });

    test("classifies preparation, resolution and event errors", async () => {
      const worker = new CaptureAgent("worker", [
        createEvent({
          invocationId: "inv-1",
          author: "worker",
          errorMessage: "model failed",
        }),
      ]);
      const gateway = new AgentInvocationGateway({
        resolveAgent: (name) => (name === "worker" ? worker : undefined),
      });
      const base = {
        input: { role: "user" as const, parts: [{ text: "go" }] },
        parentContext: parentContext(new CaptureAgent("root")),
      };

      const prepared = await gateway.run({
        ...base,
        agentName: "worker",
        prepareContext: () => {
          throw new Error("binder refused");
        },
      });
      const missing = await gateway.run({ ...base, agentName: "ghost" });
      const failed = await gateway.run({ ...base, agentName: "worker" });

      expect(prepared.errorKind).toBe("preparation");
      expect(missing.errorKind).toBe("agent-error");
      expect(failed.errorKind).toBe("agent-error");
      expect(failed.error).toBe("model failed");
    });
  });

  test("closes the agent generator when an event sink throws", async () => {
    const log: string[] = [];
    class FinallyAgent extends BaseAgent {
      constructor() {
        super({ name: "fin" });
      }
      protected async *runAsyncImpl() {
        try {
          yield createEvent({
            invocationId: "inv-1",
            author: "fin",
            content: { role: "model", parts: [{ text: "one" }] },
          });
          yield createEvent({
            invocationId: "inv-1",
            author: "fin",
            content: { role: "model", parts: [{ text: "two" }] },
          });
        } finally {
          log.push("agent-finally");
        }
      }
      protected async *runLiveImpl() {}
    }
    const gateway = new AgentInvocationGateway({
      resolveAgent: () => new FinallyAgent(),
    });

    const result = await gateway.run({
      agentName: "fin",
      input: { role: "user", parts: [{ text: "go" }] },
      parentContext: parentContext(new CaptureAgent("root")),
      eventSink: () => {
        throw new Error("sink boom");
      },
    });

    expect(result.error).toBe("sink boom");
    expect(result.errorKind).toBe("agent-error");
    expect(log).toEqual(["agent-finally"]);
  });

  test("ignores stateDelta carried by partial events in the aggregate", async () => {
    const worker = new CaptureAgent("worker", [
      createEvent({
        invocationId: "inv-1",
        author: "worker",
        partial: true,
        actions: createEventActions({ stateDelta: { "temp:x": 1, p: 1 } }),
      }),
    ]);
    const gateway = new AgentInvocationGateway({ resolveAgent: () => worker });

    const result = await gateway.run({
      agentName: "worker",
      input: { role: "user", parts: [{ text: "go" }] },
      parentContext: parentContext(new CaptureAgent("root")),
    });

    expect(result.stateDelta).toBeUndefined();
  });

  describe("permission inheritance", () => {
    const modes = [
      { sessionStateMode: "merge", sessionHistoryMode: "inherit" },
      { sessionStateMode: "replace", sessionHistoryMode: "replace" },
      { sessionStateMode: "merge", sessionHistoryMode: "replace" },
      { sessionStateMode: "replace", sessionHistoryMode: "inherit" },
    ] as const;

    for (const mode of modes) {
      test(`child session carries the parent policy (${mode.sessionStateMode}/${mode.sessionHistoryMode})`, async () => {
        const worker = new CaptureAgent();
        const context = parentContext(new CaptureAgent("root"));
        setInheritedPermissions(context.session, {
          mode: "read-only",
          allowNetwork: false,
        });
        const gateway = new AgentInvocationGateway({
          resolveAgent: () => worker,
        });

        await gateway.run({
          agentName: "worker",
          input: { role: "user", parts: [{ text: "go" }] },
          parentContext: context,
          ...mode,
        });

        expect(worker.context?.session).not.toBe(context.session);
        expect(getInheritedPermissions(worker.context?.session)).toEqual({
          mode: "read-only",
          allowNetwork: false,
        });
      });
    }

    test("a session without policy stays without one", async () => {
      const worker = new CaptureAgent();
      const context = parentContext(new CaptureAgent("root"));
      const gateway = new AgentInvocationGateway({
        resolveAgent: () => worker,
      });

      await gateway.run({
        agentName: "worker",
        input: { role: "user", parts: [{ text: "go" }] },
        parentContext: context,
      });

      expect(getInheritedPermissions(worker.context?.session)).toBeUndefined();
    });
  });
});
