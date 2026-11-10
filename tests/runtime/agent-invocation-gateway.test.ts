import { describe, expect, spyOn, test } from "bun:test";
import {
  BaseAgent,
  BaseLlm,
  type BaseLlmConnection,
  BaseSessionService,
  type BaseTool,
  BaseToolset,
  createEvent,
  createEventActions,
  type Event,
  FunctionNode,
  InvocationContext,
  LlmAgent,
  LlmCallsLimitExceededError,
  type LlmRequest,
  type LlmResponse,
  LongRunningFunctionTool,
  NodeTool,
  PluginManager,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  RequestInput,
  type Session,
  Workflow,
} from "@google/adk";
import { z } from "zod";
import {
  getInheritedPermissions,
  setInheritedPermissions,
} from "../../src/agents/permissions/inheritance.js";
import { AgentInvocationGateway } from "../../src/runtime/agent-invocation-gateway.js";
import { withDeadline } from "../agents/helpers.js";

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

/** ADK's own append rules, used as the reference for the child session. */
class ReferenceSessionService extends BaseSessionService {
  createSession(): Promise<Session> {
    throw new Error("unused");
  }
  getSession(): Promise<Session | undefined> {
    throw new Error("unused");
  }
  listSessions(): Promise<never> {
    throw new Error("unused");
  }
  deleteSession(): Promise<void> {
    throw new Error("unused");
  }
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

describe("AgentInvocationGateway appendInput", () => {
  const input = { role: "user", parts: [{ text: "previous task" }] };

  test("false keeps the input out of the child session and sets userContent", async () => {
    const worker = new CaptureAgent();
    const gateway = new AgentInvocationGateway({ resolveAgent: () => worker });

    const result = await gateway.run({
      agentName: "worker",
      input,
      parentContext: parentContext(worker),
      sessionHistoryMode: "inherit",
      appendInput: false,
    });

    expect(result.error).toBeUndefined();
    expect(worker.context?.userContent).toEqual(input);
    const texts = worker.context?.session.events.map(
      (event) => event.content?.parts?.[0]?.text,
    );
    expect(texts).toEqual(["previous task"]);
  });

  test("by default the input is appended as a new user event", async () => {
    const worker = new CaptureAgent();
    const gateway = new AgentInvocationGateway({ resolveAgent: () => worker });

    await gateway.run({
      agentName: "worker",
      input,
      parentContext: parentContext(worker),
      sessionHistoryMode: "inherit",
    });

    const texts = worker.context?.session.events.map(
      (event) => event.content?.parts?.[0]?.text,
    );
    expect(texts).toEqual(["previous task", "previous task"]);
    expect(worker.context?.session.events.at(-1)?.author).toBe("user");
  });
});

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

  for (const sessionStateMode of ["merge", "replace"] as const) {
    test(`sessionState shares no nested object with the caller (${sessionStateMode})`, async () => {
      let resume: () => void = () => {};
      const resumed = new Promise<void>((resolve) => {
        resume = resolve;
      });
      let started: () => void = () => {};
      const running = new Promise<void>((resolve) => {
        started = resolve;
      });
      let seenByChild: unknown;
      class NestedStateAgent extends BaseAgent {
        protected async *runAsyncImpl(context: InvocationContext) {
          started();
          await resumed;
          const task = context.session.state.task as {
            id: string;
            tags: string[];
          };
          seenByChild = structuredClone(task);
          task.tags.push("from-child");
          yield createEvent({
            invocationId: context.invocationId,
            author: this.name,
            content: { role: "model", parts: [{ text: "done" }] },
          });
        }

        protected async *runLiveImpl() {}
      }
      const worker = new NestedStateAgent({ name: "worker" });
      const sessionState = { task: { id: "t-1", tags: ["caller"] } };
      const gateway = new AgentInvocationGateway({
        resolveAgent: () => worker,
      });

      const result = gateway.run({
        agentName: "worker",
        input: { role: "user", parts: [{ text: "task" }] },
        parentContext: parentContext(new CaptureAgent("root")),
        sessionState,
        sessionStateMode,
      });
      await running;
      sessionState.task.id = "changed-by-caller";
      sessionState.task.tags.push("from-caller");
      resume();

      expect((await result).error).toBeUndefined();
      expect(seenByChild).toEqual({ id: "t-1", tags: ["caller"] });
      expect(sessionState.task).toEqual({
        id: "changed-by-caller",
        tags: ["caller", "from-caller"],
      });
    });
  }

  test("a frozen sessionState value stays frozen in the child's copy", async () => {
    const worker = new CaptureAgent();
    const grant = Object.freeze({ id: "g-1", scopes: Object.freeze(["read"]) });
    const gateway = new AgentInvocationGateway({ resolveAgent: () => worker });

    await gateway.run({
      agentName: "worker",
      input: { role: "user", parts: [{ text: "task" }] },
      parentContext: parentContext(new CaptureAgent("root")),
      sessionState: { grant, open: { n: 1 } },
    });

    const state = worker.context?.session.state;
    expect(state?.grant).toEqual(grant);
    expect(state?.grant).not.toBe(grant);
    expect(Object.isFrozen(state?.grant)).toBe(true);
    expect(
      Object.isFrozen((state?.grant as typeof grant | undefined)?.scopes),
    ).toBe(true);
    expect(Object.isFrozen(state?.open)).toBe(false);
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

    // The output is the last final response (ADK Runner/AgentTool
    // semantics); the previous concatenation lives in `transcript`.
    expect(result.output).toBe("second");
    expect(result.transcript).toBe("first\nsecond");
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

    /** Runs a worker that writes `k` and `temp:scratch`, after a partial. */
    async function runTempWriter() {
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
      const context = parentContext(new CaptureAgent("root"));
      const gateway = new AgentInvocationGateway({
        resolveAgent: () => worker,
      });
      const result = await gateway.run({
        agentName: "worker",
        input: { role: "user", parts: [{ text: "go" }] },
        parentContext: context,
      });
      return { worker, context, result, seenByNext };
    }

    test("applies stateDelta to the child state with ADK's append rules and skips partials", async () => {
      const { worker, result, seenByNext } = await runTempWriter();

      // The child session follows the installed ADK's appendEvent, whatever it
      // does with `temp:` keys during the invocation.
      const reference: Session = {
        id: "s",
        appName: "a",
        userId: "u",
        state: { shared: true },
        events: [],
        lastUpdateTime: 0,
      };
      await new ReferenceSessionService().appendEvent({
        session: reference,
        event: modelEvent([{ text: "done" }], {
          actions: createEventActions({
            stateDelta: { k: 1, "temp:scratch": 2 },
          }),
        }),
      });
      expect(seenByNext).toEqual(reference.state);
      const childEvents = worker.context?.session.events ?? [];
      expect(childEvents.some((event) => event.partial)).toBe(false);
      // Default history is `replace` (AgentTool-like): input + final only.
      expect(childEvents).toHaveLength(2);
      // The partial still reaches sinks and the result stream.
      expect(result.events).toHaveLength(2);
    });

    test("returns an aggregate stateDelta without temp: keys and leaves the parent state alone", async () => {
      const { context, result } = await runTempWriter();

      expect(result.stateDelta).toEqual({ k: 1 });
      expect(context.session.state).toEqual({ shared: true });
    });

    test("keeps temp: keys out of the aggregate when the session service does not trim them", async () => {
      // An appendEvent that keeps `temp:` keys in the event and the state.
      const append = spyOn(
        BaseSessionService.prototype,
        "appendEvent",
      ).mockImplementation(async ({ session, event }) => {
        if (event.partial) return event;
        Object.assign(session.state, event.actions?.stateDelta ?? {});
        session.events.push(event);
        return event;
      });
      try {
        const { context, result, seenByNext } = await runTempWriter();

        expect(seenByNext).toEqual({ shared: true, k: 1, "temp:scratch": 2 });
        expect(result.stateDelta).toEqual({ k: 1 });
        expect(context.session.state).toEqual({ shared: true });
      } finally {
        append.mockRestore();
      }
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
      /** Resolves once the agent is parked after its first event. */
      readonly stalled: Promise<void>;
      #markStalled!: () => void;
      constructor() {
        super({ name: "stall" });
        this.stalled = new Promise((resolve) => {
          this.#markStalled = resolve;
        });
      }
      protected async *runAsyncImpl() {
        try {
          yield createEvent({
            invocationId: "inv-1",
            author: "stall",
            content: { role: "model", parts: [{ text: "started" }] },
          });
          this.#markStalled();
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
      void stall.stalled.then(() => abort.abort(new Error("stop now")));
      const gateway = new AgentInvocationGateway({
        resolveAgent: () => stall,
      });

      const outcome = await withDeadline(
        gateway.run({
          agentName: "stall",
          input: { role: "user", parts: [{ text: "go" }] },
          parentContext: parentContext(new CaptureAgent("root")),
          abortSignal: abort.signal,
        }),
        5_000,
        "run() hung after abort",
      );

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

  describe("final output and transcript", () => {
    test("output is the last final text, transcript keeps the narration", async () => {
      const worker = new CaptureAgent("worker", [
        createEvent({
          invocationId: "inv-1",
          author: "worker",
          content: {
            role: "model",
            parts: [
              { text: "let me check" },
              { functionCall: { id: "c", name: "t", args: {} } },
            ],
          },
        }),
        createEvent({
          invocationId: "inv-1",
          author: "worker",
          content: {
            role: "user",
            parts: [{ functionResponse: { id: "c", name: "t", response: {} } }],
          },
        }),
        createEvent({
          invocationId: "inv-1",
          author: "worker",
          content: {
            role: "model",
            parts: [{ text: "hidden", thought: true }, { text: "the answer" }],
          },
        }),
      ]);
      const gateway = new AgentInvocationGateway({
        resolveAgent: () => worker,
      });

      const result = await gateway.run({
        agentName: "worker",
        input: { role: "user", parts: [{ text: "go" }] },
        parentContext: parentContext(new CaptureAgent("root")),
      });

      expect(result.transcript).toBe("let me check\nthe answer");
      expect(result.output).toBe("the answer");
    });

    test("skipSummarization and long-running events are final too", async () => {
      const worker = new CaptureAgent("worker", [
        createEvent({
          invocationId: "inv-1",
          author: "worker",
          content: {
            role: "model",
            parts: [
              { text: "json" },
              { functionCall: { id: "c", name: "t", args: {} } },
            ],
          },
          actions: createEventActions({ skipSummarization: true }),
        }),
      ]);
      const gateway = new AgentInvocationGateway({
        resolveAgent: () => worker,
      });

      const result = await gateway.run({
        agentName: "worker",
        input: { role: "user", parts: [{ text: "go" }] },
        parentContext: parentContext(new CaptureAgent("root")),
      });

      expect(result.output).toBe("json");
    });
  });

  describe("session isolation defaults", () => {
    test("defaults to a deep copy of the parent state and no parent history", async () => {
      const worker = new CaptureAgent();
      const context = parentContext(new CaptureAgent("root"));
      context.session.state = { nested: { n: 1 }, fn: () => 1 };
      const gateway = new AgentInvocationGateway({
        resolveAgent: () => worker,
      });

      await gateway.run({
        agentName: "worker",
        input: { role: "user", parts: [{ text: "go" }] },
        parentContext: context,
      });

      const childState = worker.context?.session.state as {
        nested: { n: number };
        fn?: unknown;
      };
      expect(childState.nested).toEqual({ n: 1 });
      expect(childState.nested).not.toBe(context.session.state.nested);
      childState.nested.n = 99;
      expect((context.session.state.nested as { n: number }).n).toBe(1);
      // Non-cloneable values are left out instead of shared.
      expect("fn" in childState).toBe(false);
      expect(worker.context?.session.events).toHaveLength(1);
    });

    test("inherit exposes the parent history (native transfer semantics)", async () => {
      const worker = new CaptureAgent();
      const context = parentContext(new CaptureAgent("root"));
      const gateway = new AgentInvocationGateway({
        resolveAgent: () => worker,
      });

      await gateway.run({
        agentName: "worker",
        input: { role: "user", parts: [{ text: "go" }] },
        parentContext: context,
        sessionHistoryMode: "inherit",
      });

      expect(worker.context?.session.events).toHaveLength(2);
      expect(worker.context?.session.events[0]).toBe(context.session.events[0]);
    });
  });

  describe("interrupt and resume", () => {
    const confirmationRequest = () =>
      createEvent({
        invocationId: "inv-1",
        author: "worker",
        content: {
          role: "user",
          parts: [
            {
              functionCall: {
                id: "req-1",
                name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
                args: {
                  originalFunctionCall: { id: "orig", name: "delete" },
                  toolConfirmation: { hint: "Delete it?" },
                },
              },
            },
          ],
        },
        actions: createEventActions({ stateDelta: { stage: "asked" } }),
        longRunningToolIds: ["req-1"],
      });

    const answer = (id: string, name: string) => ({
      role: "user" as const,
      parts: [
        { functionResponse: { id, name, response: { confirmed: true } } },
      ],
    });

    test("reports a pending confirmation with the events needed to resume", async () => {
      const request = confirmationRequest();
      const worker = new CaptureAgent("worker", [request]);
      const gateway = new AgentInvocationGateway({
        resolveAgent: () => worker,
      });

      const result = await gateway.run({
        agentName: "worker",
        input: { role: "user", parts: [{ text: "go" }] },
        parentContext: parentContext(new CaptureAgent("root")),
      });

      expect(result.interrupt?.kind).toBe("confirmation");
      expect(result.interrupt?.functionCallIds).toEqual(["req-1"]);
      expect(result.interrupt?.requests[0]).toMatchObject({
        interruptId: "req-1",
        toolName: "delete",
        message: "Delete it?",
      });
      // input event + the request event
      expect(result.interrupt?.events).toHaveLength(2);
      expect(result.interrupt?.events.at(-1)).toBe(request);
    });

    test("reports input and credential requests and bare long-running calls", async () => {
      const mk = (name: string, args: Record<string, unknown>, lro = true) =>
        createEvent({
          invocationId: "inv-1",
          author: "worker",
          content: {
            role: "user",
            parts: [{ functionCall: { id: `${name}-1`, name, args } }],
          },
          ...(lro ? { longRunningToolIds: [`${name}-1`] } : {}),
        });
      const run = async (event: Event) => {
        const worker = new CaptureAgent("worker", [event]);
        return new AgentInvocationGateway({
          resolveAgent: () => worker,
        }).run({
          agentName: "worker",
          input: { role: "user", parts: [{ text: "go" }] },
          parentContext: parentContext(new CaptureAgent("root")),
        });
      };

      const input = await run(
        mk(REQUEST_INPUT_FUNCTION_CALL_NAME, { message: "Name?" }),
      );
      const credential = await run(
        mk(REQUEST_CREDENTIAL_FUNCTION_CALL_NAME, { auth_config: {} }),
      );
      const lro = await run(
        createEvent({
          invocationId: "inv-1",
          author: "worker",
          content: {
            role: "model",
            parts: [{ functionCall: { id: "slow-1", name: "slow", args: {} } }],
          },
          longRunningToolIds: ["slow-1"],
        }),
      );
      const none = await run(
        createEvent({
          invocationId: "inv-1",
          author: "worker",
          content: { role: "model", parts: [{ text: "done" }] },
        }),
      );

      expect(input.interrupt).toMatchObject({
        kind: "input",
        functionCallIds: [`${REQUEST_INPUT_FUNCTION_CALL_NAME}-1`],
      });
      expect(credential.interrupt?.kind).toBe("credential");
      expect(lro.interrupt).toMatchObject({
        kind: "long-running",
        functionCallIds: ["slow-1"],
        requests: [],
      });
      expect(none.interrupt).toBeUndefined();
    });

    test("resumes with the pending call in history and the answer as input", async () => {
      const first = new CaptureAgent("worker", [confirmationRequest()]);
      const context = parentContext(new CaptureAgent("root"));
      const interrupted = await new AgentInvocationGateway({
        resolveAgent: () => first,
      }).run({
        agentName: "worker",
        input: { role: "user", parts: [{ text: "go" }] },
        parentContext: context,
      });

      const second = new CaptureAgent("worker", [
        createEvent({
          invocationId: "inv-1",
          author: "worker",
          content: { role: "model", parts: [{ text: "deleted" }] },
        }),
      ]);
      const answerContent = answer(
        "req-1",
        REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
      );
      const resumed = await new AgentInvocationGateway({
        resolveAgent: () => second,
      }).run({
        agentName: "worker",
        input: answerContent,
        parentContext: context,
        resume: { events: interrupted.interrupt?.events ?? [] },
      });

      expect(resumed.error).toBeUndefined();
      expect(resumed.output).toBe("deleted");
      expect(resumed.interrupt).toBeUndefined();
      const history = second.context?.session.events ?? [];
      expect(history).toHaveLength(4);
      expect(history[0]?.content?.parts?.[0]?.text).toBe("go");
      expect(history[1]?.content?.parts?.[0]?.functionCall?.id).toBe("req-1");
      expect(history[2]?.content).toEqual(answerContent);
      expect(history[3]?.content?.parts?.[0]?.text).toBe("deleted");
      // State written before the interrupt survives the resume.
      expect(second.context?.session.state).toMatchObject({
        shared: true,
        stage: "asked",
      });
    });

    test("an unanswered resume stays interrupted and rejects unrelated input", async () => {
      const first = new CaptureAgent("worker", [confirmationRequest()]);
      const context = parentContext(new CaptureAgent("root"));
      const interrupted = await new AgentInvocationGateway({
        resolveAgent: () => first,
      }).run({
        agentName: "worker",
        input: { role: "user", parts: [{ text: "go" }] },
        parentContext: context,
      });
      const never = new CaptureAgent("worker");
      const gateway = new AgentInvocationGateway({ resolveAgent: () => never });

      const unrelated = await gateway.run({
        agentName: "worker",
        input: { role: "user", parts: [{ text: "just text" }] },
        parentContext: context,
        resume: { events: interrupted.interrupt?.events ?? [] },
      });
      const wrongId = await gateway.run({
        agentName: "worker",
        input: answer("other", REQUEST_CONFIRMATION_FUNCTION_CALL_NAME),
        parentContext: context,
        resume: { events: interrupted.interrupt?.events ?? [] },
      });
      const nothingPending = await gateway.run({
        agentName: "worker",
        input: answer("req-1", REQUEST_CONFIRMATION_FUNCTION_CALL_NAME),
        parentContext: context,
        resume: { events: [] },
      });

      for (const result of [unrelated, wrongId, nothingPending]) {
        expect(result.errorKind).toBe("invalid-resume");
        expect(result.error).toBe(
          "Resume input does not answer a pending interrupt",
        );
      }
      expect(never.context).toBeUndefined();
    });

    test("a resume that is answered but pauses again reports the new interrupt", async () => {
      const first = new CaptureAgent("worker", [confirmationRequest()]);
      const context = parentContext(new CaptureAgent("root"));
      const interrupted = await new AgentInvocationGateway({
        resolveAgent: () => first,
      }).run({
        agentName: "worker",
        input: { role: "user", parts: [{ text: "go" }] },
        parentContext: context,
      });
      const next = createEvent({
        invocationId: "inv-1",
        author: "worker",
        content: {
          role: "user",
          parts: [
            {
              functionCall: {
                id: "req-2",
                name: REQUEST_INPUT_FUNCTION_CALL_NAME,
                args: { message: "Reason?" },
              },
            },
          ],
        },
        longRunningToolIds: ["req-2"],
      });
      const second = new CaptureAgent("worker", [next]);

      const resumed = await new AgentInvocationGateway({
        resolveAgent: () => second,
      }).run({
        agentName: "worker",
        input: answer("req-1", REQUEST_CONFIRMATION_FUNCTION_CALL_NAME),
        parentContext: context,
        resume: { events: interrupted.interrupt?.events ?? [] },
      });

      expect(resumed.interrupt?.functionCallIds).toEqual(["req-2"]);
      // request 1 is answered, so it is not reported again
      expect(resumed.interrupt?.requests.map((r) => r.interruptId)).toEqual([
        "req-2",
      ]);
      expect(resumed.interrupt?.events).toHaveLength(4);
    });

    // ADK 2.4 LlmAgent + LongRunningFunctionTool: the call, the tool's own
    // pending response (authored by the agent) and then the model's text.
    const longRunningTurn = () => [
      createEvent({
        invocationId: "inv-1",
        author: "worker",
        content: {
          role: "model",
          parts: [
            {
              functionCall: {
                id: "lro-1",
                name: "ask_human",
                args: { question: "ok?" },
              },
            },
          ],
        },
        longRunningToolIds: ["lro-1"],
      }),
      createEvent({
        invocationId: "inv-1",
        author: "worker",
        content: {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: "lro-1",
                name: "ask_human",
                response: { status: "pending" },
              },
            },
          ],
        },
      }),
      createEvent({
        invocationId: "inv-1",
        author: "worker",
        content: { role: "model", parts: [{ text: "Waiting for a human." }] },
      }),
    ];

    test("a long-running call followed by its pending response and text is an interrupt", async () => {
      const worker = new CaptureAgent("worker", longRunningTurn());

      const result = await new AgentInvocationGateway({
        resolveAgent: () => worker,
      }).run({
        agentName: "worker",
        input: { role: "user", parts: [{ text: "go" }] },
        parentContext: parentContext(new CaptureAgent("root")),
      });

      expect(result.error).toBeUndefined();
      expect(result.interrupt).toMatchObject({
        kind: "long-running",
        functionCallIds: ["lro-1"],
        requests: [],
      });
      // input event + the three events of the turn
      expect(result.interrupt?.events).toHaveLength(4);
    });

    test("a long-running call answered by the resume input is no longer an interrupt", async () => {
      const context = parentContext(new CaptureAgent("root"));
      const interrupted = await new AgentInvocationGateway({
        resolveAgent: () => new CaptureAgent("worker", longRunningTurn()),
      }).run({
        agentName: "worker",
        input: { role: "user", parts: [{ text: "go" }] },
        parentContext: context,
      });
      const second = new CaptureAgent("worker", [
        createEvent({
          invocationId: "inv-1",
          author: "worker",
          content: { role: "model", parts: [{ text: "DONE" }] },
        }),
      ]);

      const resumed = await new AgentInvocationGateway({
        resolveAgent: () => second,
      }).run({
        agentName: "worker",
        input: answer("lro-1", "ask_human"),
        parentContext: context,
        resume: { events: interrupted.interrupt?.events ?? [] },
      });

      expect(resumed.error).toBeUndefined();
      expect(resumed.output).toBe("DONE");
      expect(resumed.interrupt).toBeUndefined();
      expect(second.context).toBeDefined();
    });

    test("a long-running call on a partial event only is not an interrupt", async () => {
      const worker = new CaptureAgent("worker", [
        createEvent({
          invocationId: "inv-1",
          author: "worker",
          partial: true,
          content: {
            role: "model",
            parts: [{ functionCall: { id: "lro-1", name: "ask_human" } }],
          },
          longRunningToolIds: ["lro-1"],
        }),
        createEvent({
          invocationId: "inv-1",
          author: "worker",
          content: { role: "model", parts: [{ text: "done" }] },
        }),
      ]);

      const result = await new AgentInvocationGateway({
        resolveAgent: () => worker,
      }).run({
        agentName: "worker",
        input: { role: "user", parts: [{ text: "go" }] },
        parentContext: parentContext(new CaptureAgent("root")),
      });

      expect(result.interrupt).toBeUndefined();
    });
  });

  describe("long-running tools of a real LlmAgent", () => {
    /** Calls `toolName` once (id `callId`), then answers with text. */
    const oneCallLlm = (
      toolName: string,
      args: Record<string, unknown>,
      callId = "c1",
    ) => {
      let calls = 0;
      return new (class extends BaseLlm {
        constructor() {
          super({ model: `fake-${toolName}` });
        }
        async *generateContentAsync(
          _request: LlmRequest,
        ): AsyncGenerator<LlmResponse, void> {
          calls++;
          yield calls === 1
            ? {
                content: {
                  role: "model",
                  parts: [
                    { functionCall: { id: callId, name: toolName, args } },
                  ],
                },
              }
            : { content: { role: "model", parts: [{ text: "done" }] } };
        }
        async connect(): Promise<BaseLlmConnection> {
          throw new Error("not implemented");
        }
      })();
    };

    class NodeAgent extends BaseAgent {
      constructor(
        name: string,
        private readonly ask: boolean,
      ) {
        super({ name });
      }
      protected async *runAsyncImpl(context: InvocationContext) {
        yield createEvent({
          invocationId: context.invocationId,
          author: this.name,
          content: {
            role: "model",
            parts: [
              this.ask
                ? {
                    functionCall: {
                      id: "inner-1",
                      name: REQUEST_INPUT_FUNCTION_CALL_NAME,
                      args: { message: "Name?" },
                    },
                  }
                : { text: "node output" },
            ],
          },
          ...(this.ask ? { longRunningToolIds: ["inner-1"] } : {}),
        });
      }
      protected async *runLiveImpl() {}
    }

    const nodeTool = (ask: boolean) =>
      new NodeTool(
        new Workflow({
          name: "wf",
          inputSchema: z.object({ request: z.string() }),
          edges: [["START", new NodeAgent("inner", ask)]],
        } as never),
        "wf",
      );

    const run = (agent: BaseAgent) =>
      new AgentInvocationGateway({ resolveAgent: () => agent }).run({
        agentName: agent.name,
        input: { role: "user", parts: [{ text: "go" }] },
        parentContext: parentContext(new CaptureAgent("root")),
      });

    test("a completed NodeTool call is not an interrupt", async () => {
      const result = await run(
        new LlmAgent({
          name: "coordinator",
          model: oneCallLlm("wf", { request: "x" }),
          tools: [nodeTool(false)],
        }),
      );

      expect(result.error).toBeUndefined();
      expect(result.interrupt).toBeUndefined();
      expect(result.output).toBe("done");
      // ADK still flags the NodeTool call as long-running.
      expect(
        result.events.some((event) => event.longRunningToolIds?.includes("c1")),
      ).toBe(true);
    });

    test("a NodeTool whose node pauses is an interrupt through the node's ids", async () => {
      const result = await run(
        new LlmAgent({
          name: "coordinator",
          model: oneCallLlm("wf", { request: "x" }),
          tools: [nodeTool(true)],
        }),
      );

      expect(result.error).toBeUndefined();
      expect(result.interrupt?.kind).toBe("input");
      expect(result.interrupt?.functionCallIds).toContain("inner-1");
      expect(result.interrupt?.functionCallIds).not.toContain("c1");
    });

    /** A workflow whose only node asks for `inner-1`, then returns the answer. */
    const askingWorkflow = () =>
      new Workflow({
        name: "wf",
        inputSchema: z.object({ request: z.string() }),
        edges: [
          [
            "START",
            new FunctionNode("ask", async function* (context: {
              resumeInputs?: Record<string, unknown>;
            }) {
              const answer = context.resumeInputs?.["inner-1"];
              if (answer === undefined) {
                yield new RequestInput({
                  interruptId: "inner-1",
                  message: "Name?",
                });
                return;
              }
              return { name: answer };
            } as never),
          ],
        ],
      } as never);

    /** A workflow named `name` whose only node completes at once. */
    const doneWorkflow = (name: string) =>
      new Workflow({
        name,
        inputSchema: z.object({ request: z.string() }),
        edges: [
          ["START", new FunctionNode("finish", async () => ({ ok: true }))],
        ],
      } as never);

    /** A toolset that lists fixed tools and counts the listings. */
    class ListedToolset extends BaseToolset {
      listed = 0;
      constructor(private readonly listedTools: BaseTool[]) {
        super([]);
      }
      async getTools(): Promise<BaseTool[]> {
        this.listed++;
        return this.listedTools;
      }
      async close(): Promise<void> {}
    }

    test("resuming a paused NodeTool: the answer to inner-1 finishes it with no interrupt", async () => {
      const coordinator = new LlmAgent({
        name: "coordinator",
        model: oneCallLlm("wf", { request: "x" }),
        tools: [new NodeTool(askingWorkflow(), "wf")],
      });
      const gateway = new AgentInvocationGateway({
        resolveAgent: () => coordinator,
      });
      const paused = await gateway.run({
        agentName: "coordinator",
        input: { role: "user", parts: [{ text: "go" }] },
        parentContext: parentContext(new CaptureAgent("root")),
      });
      expect(paused.interrupt).toMatchObject({
        kind: "input",
        functionCallIds: ["inner-1"],
      });

      const resumed = await gateway.run({
        agentName: "coordinator",
        resume: { events: paused.interrupt?.events ?? [] },
        input: {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: "inner-1",
                name: REQUEST_INPUT_FUNCTION_CALL_NAME,
                response: { result: "Ada" },
              },
            },
          ],
        },
        parentContext: parentContext(new CaptureAgent("root")),
      });

      expect(resumed.error).toBeUndefined();
      expect(resumed.errorKind).toBeUndefined();
      expect(resumed.interrupt).toBeUndefined();
      expect(resumed.output).toBe("done");
      // The node finished: the coordinator got the response for `c1`, and
      // `c1` (still flagged long-running by ADK in the history) stays exempt.
      expect(
        resumed.events.some(
          (event) =>
            event.author === "coordinator" &&
            event.content?.parts?.some(
              (part) => part.functionResponse?.id === "c1",
            ),
        ),
      ).toBe(true);
      expect(
        paused.interrupt?.events.some((event) =>
          event.longRunningToolIds?.includes("c1"),
        ),
      ).toBe(true);
    });

    test("a NodeTool called by a graph-node LlmAgent of a NodeTool workflow is not an interrupt", async () => {
      const inner = new LlmAgent({
        name: "inner_llm",
        model: oneCallLlm("wf2", { request: "y" }, "c2"),
        tools: [new NodeTool(doneWorkflow("wf2"), "wf2")],
      });
      const outer = new Workflow({
        name: "wf",
        inputSchema: z.object({ request: z.string() }),
        edges: [["START", inner]],
      } as never);
      const result = await run(
        new LlmAgent({
          name: "coordinator",
          model: oneCallLlm("wf", { request: "x" }),
          tools: [new NodeTool(outer, "wf")],
        }),
      );

      expect(result.error).toBeUndefined();
      expect(result.interrupt).toBeUndefined();
      expect(result.output).toBe("done");
      // ADK flags the inner call long-running, on the inner agent's event
      // and again on the outer workflow node's event.
      expect(
        result.events.filter((event) =>
          event.longRunningToolIds?.includes("c2"),
        ).length,
      ).toBeGreaterThanOrEqual(1);
    });

    test("a LongRunningFunctionTool of a graph-node LlmAgent is still an interrupt", async () => {
      const inner = new LlmAgent({
        name: "inner_llm",
        model: oneCallLlm("ask_human", { question: "ok?" }, "c2"),
        tools: [
          new LongRunningFunctionTool({
            name: "ask_human",
            description: "Ask a human.",
            parameters: z.object({ question: z.string() }),
            execute: async () => ({ status: "pending" }),
          }),
        ],
      });
      const outer = new Workflow({
        name: "wf",
        inputSchema: z.object({ request: z.string() }),
        edges: [["START", inner]],
      } as never);
      const result = await run(
        new LlmAgent({
          name: "coordinator",
          model: oneCallLlm("wf", { request: "x" }),
          tools: [new NodeTool(outer, "wf")],
        }),
      );

      expect(result.error).toBeUndefined();
      expect(result.interrupt?.functionCallIds).toContain("c2");
      expect(result.interrupt?.functionCallIds).not.toContain("c1");
    });

    test("a completed NodeTool from a toolset is not an interrupt", async () => {
      const toolset = new ListedToolset([
        new NodeTool(doneWorkflow("wf"), "wf"),
      ]);
      const result = await run(
        new LlmAgent({
          name: "coordinator",
          model: oneCallLlm("wf", { request: "x" }),
          tools: [toolset],
        }),
      );

      expect(result.error).toBeUndefined();
      expect(result.interrupt).toBeUndefined();
      expect(result.output).toBe("done");
      // ADK's LlmAgent listed the toolset; the interrupt scan never calls
      // `getTools` (it resolves the call by its run marker).
      expect(toolset.listed).toBeGreaterThan(0);
    });

    test("a completed NodeTool from a toolset whose name contains a dot is not an interrupt", async () => {
      const result = await run(
        new LlmAgent({
          name: "coordinator",
          model: oneCallLlm("docs.search", { request: "x" }),
          tools: [
            new ListedToolset([
              new NodeTool(doneWorkflow("search"), "docs.search"),
            ]),
          ],
        }),
      );

      expect(result.error).toBeUndefined();
      expect(result.interrupt).toBeUndefined();
      expect(result.output).toBe("done");
      // ADK ran the node on the `docs.search@c1` branch segment.
      expect(
        result.events.some((event) =>
          event.branch?.split(".").includes("search@c1"),
        ),
      ).toBe(true);
    });

    test("a paused NodeTool from a toolset reports the node's id, not the wrapper call", async () => {
      const result = await run(
        new LlmAgent({
          name: "coordinator",
          model: oneCallLlm("wf", { request: "x" }),
          tools: [new ListedToolset([new NodeTool(askingWorkflow(), "wf")])],
        }),
      );

      expect(result.error).toBeUndefined();
      expect(result.interrupt?.kind).toBe("input");
      expect(result.interrupt?.functionCallIds).toEqual(["inner-1"]);
    });

    test("a LongRunningFunctionTool from a toolset is still an interrupt", async () => {
      const result = await run(
        new LlmAgent({
          name: "asker",
          model: oneCallLlm("ask_human", { question: "ok?" }),
          tools: [
            new ListedToolset([
              new LongRunningFunctionTool({
                name: "ask_human",
                description: "Ask a human.",
                parameters: z.object({ question: z.string() }),
                execute: async () => ({ status: "pending" }),
              }),
            ]),
          ],
        }),
      );

      expect(result.error).toBeUndefined();
      expect(result.interrupt).toMatchObject({
        kind: "long-running",
        functionCallIds: ["c1"],
      });
    });

    test("a LongRunningFunctionTool with an interim response is an interrupt", async () => {
      const result = await run(
        new LlmAgent({
          name: "asker",
          model: oneCallLlm("ask_human", { question: "ok?" }),
          tools: [
            new LongRunningFunctionTool({
              name: "ask_human",
              description: "Ask a human.",
              parameters: z.object({ question: z.string() }),
              execute: async () => ({ status: "pending" }),
            }),
          ],
        }),
      );

      expect(result.error).toBeUndefined();
      expect(result.interrupt).toMatchObject({
        kind: "long-running",
        functionCallIds: ["c1"],
      });
      // The model kept going after the tool's pending response.
      expect(result.events.at(-1)?.content?.parts?.[0]?.text).toBe("done");
    });
  });
});

describe("AgentInvocationGateway usage", () => {
  function modelEvent(
    usageMetadata?: Event["usageMetadata"],
    options: { partial?: boolean; calls?: number } = {},
  ): Event {
    const parts = Array.from({ length: options.calls ?? 0 }, (_, i) => ({
      functionCall: { id: `call-${i}`, name: "lookup", args: {} },
    }));
    return createEvent({
      invocationId: "inv-1",
      author: "worker",
      content: {
        role: "model",
        parts: parts.length ? parts : [{ text: "ok" }],
      },
      ...(options.partial ? { partial: true } : {}),
      ...(usageMetadata ? { usageMetadata } : {}),
    });
  }

  async function usageOf(events: Event[]) {
    const worker = new CaptureAgent("worker", events);
    const gateway = new AgentInvocationGateway({ resolveAgent: () => worker });
    const result = await gateway.run({
      agentName: "worker",
      input: { role: "user", parts: [{ text: "go" }] },
      parentContext: parentContext(new CaptureAgent("root")),
    });
    return result.usage;
  }

  test("a partial event's usage is not counted", async () => {
    expect(
      await usageOf([
        modelEvent(
          {
            promptTokenCount: 99,
            candidatesTokenCount: 99,
            totalTokenCount: 198,
          },
          { partial: true },
        ),
        modelEvent({
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        }),
      ]),
    ).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      cachedTokens: 0,
      toolCalls: 0,
      llmCalls: 1,
    });
  });

  test("a function call streamed on a partial and repeated on the final event is counted once", async () => {
    const worker = new CaptureAgent("worker", [
      modelEvent(undefined, { partial: true, calls: 1 }),
      modelEvent(
        { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
        { calls: 1 },
      ),
    ]);
    const gateway = new AgentInvocationGateway({ resolveAgent: () => worker });
    const result = await gateway.run({
      agentName: "worker",
      input: { role: "user", parts: [{ text: "go" }] },
      parentContext: parentContext(new CaptureAgent("root")),
    });
    expect(result.usage.toolCalls).toBe(1);
    expect(result.summary.toolCalls).toBe(1);
    // The partial still reaches the result stream.
    expect(result.events.filter((event) => event.partial)).toHaveLength(1);
  });

  test("the total falls back to prompt plus completion when totalTokenCount is absent", async () => {
    expect(
      await usageOf([
        modelEvent({ promptTokenCount: 10, candidatesTokenCount: 5 }),
        modelEvent({
          promptTokenCount: 1,
          candidatesTokenCount: 1,
          totalTokenCount: 7,
        }),
      ]),
    ).toEqual({
      promptTokens: 11,
      completionTokens: 6,
      totalTokens: 22,
      cachedTokens: 0,
      toolCalls: 0,
      llmCalls: 2,
    });
  });

  test("cached prompt tokens are summed", async () => {
    expect(
      await usageOf([
        modelEvent({
          promptTokenCount: 100,
          candidatesTokenCount: 10,
          totalTokenCount: 110,
          cachedContentTokenCount: 60,
        }),
        modelEvent({
          promptTokenCount: 50,
          candidatesTokenCount: 5,
          totalTokenCount: 55,
          cachedContentTokenCount: 40,
        }),
      ]),
    ).toEqual({
      promptTokens: 150,
      completionTokens: 15,
      totalTokens: 165,
      cachedTokens: 100,
      toolCalls: 0,
      llmCalls: 2,
    });
  });

  test("model calls count only the events that reported usage, and tool calls count function calls", async () => {
    expect(
      await usageOf([
        modelEvent(
          {
            promptTokenCount: 10,
            candidatesTokenCount: 2,
            totalTokenCount: 12,
          },
          { calls: 2 },
        ),
        modelEvent(undefined, { calls: 1 }),
        modelEvent(),
      ]),
    ).toEqual({
      promptTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
      cachedTokens: 0,
      toolCalls: 3,
      llmCalls: 1,
    });
  });

  test("a failed invocation reports zero usage", async () => {
    const gateway = new AgentInvocationGateway({
      resolveAgent: () => undefined,
    });
    const result = await gateway.run({
      agentName: "missing",
      input: { role: "user", parts: [{ text: "go" }] },
      parentContext: parentContext(new CaptureAgent("root")),
    });
    expect(result.error).toBeDefined();
    expect(result.usage).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      toolCalls: 0,
      llmCalls: 0,
    });
  });
});
