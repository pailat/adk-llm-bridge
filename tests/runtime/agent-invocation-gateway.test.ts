import { describe, expect, test } from "bun:test";
import {
  BaseAgent,
  createEvent,
  createEventActions,
  type Event,
  InvocationContext,
  PluginManager,
} from "@google/adk";
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
});
