import { describe, expect, test } from "bun:test";
import {
  BaseAgent,
  BaseLlm,
  type BaseLlmConnection,
  createEvent,
  type Event,
  getFunctionCalls,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  type LlmRequest,
  type LlmResponse,
  LongRunningFunctionTool,
  PluginManager,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  Runner,
} from "@google/adk";
import type { Content } from "@google/genai";
import { z } from "zod";
import { AgentInvocationGateway } from "../../src/runtime/agent-invocation-gateway.js";
import { withWorkflowFailed } from "../../src/workflows/checkpoint/checkpoint.js";
import type { WorkflowCheckpointV1 } from "../../src/workflows/checkpoint/schema.js";
import type {
  LoadWorkflowCheckpointInput,
  SaveWorkflowCheckpointInput,
  WorkflowCheckpointStore,
} from "../../src/workflows/checkpoint/store.js";
import { defineWorkflow } from "../../src/workflows/definition.js";
import type { WorkflowEvent } from "../../src/workflows/events.js";
import { WorkflowAgent } from "../../src/workflows/workflow-agent.js";

/** Checkpoints keyed by workflow and execution id, like a real store. */
class KeyedStore implements WorkflowCheckpointStore {
  readonly checkpoints = new Map<string, WorkflowCheckpointV1>();

  async load(input: LoadWorkflowCheckpointInput) {
    return this.checkpoints.get(`${input.workflowId}:${input.executionId}`);
  }

  async save(input: SaveWorkflowCheckpointInput) {
    const key = `${input.checkpoint.workflowId}:${input.checkpoint.executionId}`;
    this.checkpoints.set(key, input.checkpoint);
    return { checkpointKey: key, stateDelta: {} };
  }
}

/** Asks for input (`adk_request_input`) unless the turn answers it. */
class AskAgent extends BaseAgent {
  calls = 0;

  constructor() {
    super({ name: "ask" });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.calls += 1;
    const response = context.userContent?.parts?.find(
      (part) => part.functionResponse,
    )?.functionResponse;
    if (response) {
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        content: {
          role: "model",
          parts: [{ text: `got ${JSON.stringify(response.response)}` }],
        },
      });
      return;
    }
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {
        role: "model",
        parts: [
          {
            functionCall: {
              id: "ask-ask",
              name: REQUEST_INPUT_FUNCTION_CALL_NAME,
              args: { message: "?" },
            },
          },
        ],
      },
      longRunningToolIds: ["ask-ask"],
    });
  }

  protected async *runLiveImpl() {}
}

class PreAgent extends BaseAgent {
  calls = 0;

  constructor() {
    super({ name: "pre" });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.calls += 1;
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: { role: "model", parts: [{ text: "p" }] },
    });
  }

  protected async *runLiveImpl() {}
}

/**
 * Mirrors ADK's `LlmAgent` with a `LongRunningFunctionTool`: the call, the
 * tool's own pending response, then the model keeps going with text.
 */
class LongRunningLlmLikeAgent extends BaseAgent {
  calls = 0;

  constructor() {
    super({ name: "real" });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.calls += 1;
    const answered = context.session.events.some(
      (event) =>
        event.author === "user" &&
        event.content?.parts?.some(
          (part) => part.functionResponse?.id === "lro-1",
        ),
    );
    if (answered) {
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        content: { role: "model", parts: [{ text: "DONE" }] },
      });
      return;
    }
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
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
    });
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
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
    });
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: { role: "model", parts: [{ text: "I asked a human." }] },
    });
  }

  protected async *runLiveImpl() {}
}

/** The workflow event an ADK event carries in its metadata, if any. */
const workflowEventOf = (event: Event) =>
  event.customMetadata?.workflowEvent as WorkflowEvent | undefined;

const START: Content = { role: "user", parts: [{ text: "start" }] };

const answer = (id: string, name = REQUEST_INPUT_FUNCTION_CALL_NAME) =>
  ({
    role: "user",
    parts: [{ functionResponse: { id, name, response: { value: 1 } } }],
  }) satisfies Content;

const workflowEvents = (events: readonly Event[]) =>
  events
    .map((event) => workflowEventOf(event))
    .filter(
      (event): event is WorkflowEvent =>
        Boolean(event) && event?.type !== "checkpoint_saved",
    );

const types = (events: readonly Event[]) =>
  workflowEvents(events).map((event) => event.type);

function preThenAsk(options: { store?: WorkflowCheckpointStore } = {}) {
  const pre = new PreAgent();
  const ask = new AskAgent();
  const workflow = new WorkflowAgent({
    name: "wf",
    subAgents: [pre, ask],
    ...(options.store ? { checkpointStore: options.store } : {}),
    definition: defineWorkflow({
      id: "waiting",
      version: "1",
      handler: async (ctx) => {
        await ctx.run({ id: "pre", agentName: "pre", input: ctx.inputText });
        const asked = await ctx.run({
          id: "ask",
          agentName: "ask",
          input: ctx.inputText,
        });
        return asked.output;
      },
    }),
  });
  return { pre, ask, workflow };
}

async function session(agent: BaseAgent) {
  const sessions = new InMemorySessionService();
  const runner = new Runner({
    appName: "app",
    agent,
    sessionService: sessions,
  });
  const { id } = await sessions.createSession({ appName: "app", userId: "u" });
  return async (message: Content) => {
    const events: Event[] = [];
    let error: { code?: string } | undefined;
    try {
      for await (const event of runner.runAsync({
        userId: "u",
        sessionId: id,
        newMessage: message,
      })) {
        events.push(event);
      }
    } catch (caught) {
      error = caught as { code?: string };
    }
    return { events, error };
  };
}

describe("turns while a run waits (default execution id)", () => {
  test("a plain-text turn is routed to the waiting run and rejected without running agents", async () => {
    const { pre, ask, workflow } = preThenAsk();
    const turn = await session(workflow);
    const first = await turn(START);
    expect(types(first.events).at(-1)).toBe("workflow_waiting");

    const second = await turn({ role: "user", parts: [{ text: "news?" }] });

    expect(second.error?.code).toBe("WORKFLOW_INPUT_MISMATCH");
    expect(types(second.events)).not.toContain("workflow_started");
    expect(pre.calls).toBe(1);
    expect(ask.calls).toBe(1);
    const waitingId = workflowEvents(first.events).at(-1)?.executionId;
    expect(workflowEvents(second.events).at(-1)?.executionId).toBe(waitingId);

    // The run is still waiting and resumes on the answer.
    const third = await turn(answer("ask-ask"));
    expect(third.error).toBeUndefined();
    expect(types(third.events)).toContain("workflow_completed");
    expect(ask.calls).toBe(2);
  });

  test("a functionResponse that answers nothing is rejected and never reaches an agent", async () => {
    const { pre, ask, workflow } = preThenAsk();
    const turn = await session(workflow);
    await turn(START);

    const second = await turn(answer("bogus"));

    expect(second.error?.code).toBe("WORKFLOW_INPUT_MISMATCH");
    expect(types(second.events)).not.toContain("workflow_started");
    expect(pre.calls).toBe(1);
    expect(ask.calls).toBe(1);
  });

  test("repeating the original message replays finished steps and keeps waiting", async () => {
    const { pre, ask, workflow } = preThenAsk();
    const turn = await session(workflow);
    const first = await turn(START);

    const second = await turn(START);

    expect(second.error).toBeUndefined();
    expect(types(second.events)).toContain("step_replayed");
    expect(types(second.events).at(-1)).toBe("workflow_waiting");
    expect(workflowEvents(second.events).at(-1)?.executionId).toBe(
      workflowEvents(first.events).at(-1)?.executionId,
    );
    expect(pre.calls).toBe(1);
    expect(ask.calls).toBe(1);
  });

  test("the matching answer resumes exactly once, then a new turn starts a fresh run", async () => {
    const { pre, ask, workflow } = preThenAsk();
    const turn = await session(workflow);
    const first = await turn(START);
    const waitingId = workflowEvents(first.events).at(-1)?.executionId;

    const resumed = await turn(answer("ask-ask"));
    expect(resumed.error).toBeUndefined();
    expect(
      types(resumed.events).filter((t) => t === "workflow_completed"),
    ).toHaveLength(1);
    expect(ask.calls).toBe(2);
    expect(pre.calls).toBe(1);

    const again = await turn(answer("ask-ask"));
    // A stale answer still names the completed run: it is rejected and never
    // reaches an agent.
    expect(again.error?.code).toBe("WORKFLOW_INPUT_MISMATCH");
    expect(types(again.events)).not.toContain("workflow_started");
    expect(ask.calls).toBe(2);

    const fresh = await turn({ role: "user", parts: [{ text: "next" }] });
    expect(fresh.error).toBeUndefined();
    expect(types(fresh.events)).toContain("workflow_started");
    expect(workflowEvents(fresh.events)[0]?.executionId).not.toBe(waitingId);
    expect(pre.calls).toBe(2);
  });

  test("a cancelled waiting run is not reused", async () => {
    const store = new KeyedStore();
    const { pre, workflow } = preThenAsk({ store });
    const turn = await session(workflow);
    const first = await turn(START);
    const waitingId = workflowEvents(first.events).at(-1)?.executionId;
    const key = `waiting:${waitingId}`;
    const saved = store.checkpoints.get(key);
    if (!saved) throw new Error("missing checkpoint");
    store.checkpoints.set(
      key,
      withWorkflowFailed(
        saved,
        { code: "WORKFLOW_ABORTED", message: "x" },
        "cancelled",
      ),
    );

    const next = await turn({ role: "user", parts: [{ text: "again" }] });

    expect(next.error).toBeUndefined();
    expect(types(next.events)[0]).toBe("workflow_started");
    expect(workflowEvents(next.events)[0]?.executionId).not.toBe(waitingId);
    expect(pre.calls).toBe(2);
  });

  test("a waiting run of another workflow agent in the session is ignored", async () => {
    const store = new KeyedStore();
    const other = preThenAsk({ store });
    const otherTurn = await session(other.workflow);
    const waiting = await otherTurn(START);
    const mine = preThenAsk({ store });
    // Same definition id and store, different agent name.
    const renamed = new WorkflowAgent({
      name: "wf2",
      subAgents: [new PreAgent(), new AskAgent()],
      checkpointStore: store,
      definition: mine.workflow.definition,
    });

    const context = new InvocationContext({
      pluginManager: new PluginManager(),
      invocationId: "fresh-1",
      agent: renamed,
      userContent: { role: "user", parts: [{ text: "mine" }] },
      session: {
        id: "s",
        appName: "app",
        userId: "u",
        state: {},
        events: [...waiting.events],
        lastUpdateTime: 1,
      },
    });
    const events: Event[] = [];
    for await (const event of renamed.runAsync(context)) events.push(event);

    expect(workflowEvents(events)[0]?.executionId).toBe("fresh-1");
    expect(types(events).at(-1)).toBe("workflow_waiting");
  });

  test("an answer to another workflow agent's waiting run is not routed to it", async () => {
    const store = new KeyedStore();
    const other = preThenAsk({ store });
    const otherTurn = await session(other.workflow);
    const waiting = await otherTurn(START);
    const otherId = workflowEvents(waiting.events).at(-1)?.executionId;
    const ask = new AskAgent();
    const renamed = new WorkflowAgent({
      name: "wf2",
      subAgents: [new PreAgent(), ask],
      checkpointStore: store,
      definition: other.workflow.definition,
    });

    const context = new InvocationContext({
      pluginManager: new PluginManager(),
      invocationId: "fresh-2",
      agent: renamed,
      userContent: answer("ask-ask"),
      session: {
        id: "s",
        appName: "app",
        userId: "u",
        state: {},
        events: [...waiting.events],
        lastUpdateTime: 1,
      },
    });
    const events: Event[] = [];
    for await (const event of renamed.runAsync(context)) events.push(event);

    expect(workflowEvents(events)[0]?.executionId).toBe("fresh-2");
    // The other agent's run is untouched and still waits.
    expect(store.checkpoints.get(`waiting:${otherId}`)?.status).toBe("running");
    expect(store.checkpoints.get(`waiting:${otherId}`)?.steps.ask?.status).toBe(
      "waiting",
    );
    expect(other.ask.calls).toBe(1);
  });
});

describe("long-running tool calls of an LlmAgent-shaped step", () => {
  test("call + pending response + trailing text waits, and the answer resumes it", async () => {
    const real = new LongRunningLlmLikeAgent();
    const workflow = new WorkflowAgent({
      name: "wf",
      subAgents: [real],
      definition: defineWorkflow({
        id: "lro",
        version: "1",
        handler: async (ctx) =>
          (
            await ctx.run({
              id: "real",
              agentName: "real",
              input: ctx.inputText,
            })
          ).output,
      }),
    });
    const turn = await session(workflow);

    const first = await turn(START);

    expect(first.error).toBeUndefined();
    const waiting = first.events
      .map((event) => workflowEventOf(event))
      .find((event) => event?.type === "step_waiting");
    expect(waiting).toMatchObject({
      kind: "long-running",
      functionCallIds: ["lro-1"],
    });
    expect(types(first.events).at(-1)).toBe("workflow_waiting");
    expect(types(first.events)).not.toContain("workflow_completed");

    const second = await turn(answer("lro-1", "ask_human"));

    expect(second.error).toBeUndefined();
    expect(types(second.events)).toContain("workflow_completed");
    expect(types(second.events)).not.toContain("step_waiting");
    expect(
      second.events.find((event) => event.output !== undefined)?.output,
    ).toBe("DONE");
    expect(real.calls).toBe(2);
  });
});

/** Events of a turn that are not workflow lifecycle events. */
const delegationEvents = (events: readonly Event[]) =>
  events.filter((event) => !event.customMetadata?.workflowEvent);

/** Asks with `adk_request_input` and explains itself in the same event. */
class ChattyAskAgent extends BaseAgent {
  calls = 0;

  constructor() {
    super({ name: "ask" });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.calls += 1;
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {
        role: "model",
        parts: [
          { text: "I need your name." },
          {
            functionCall: {
              id: "ask-ask",
              name: REQUEST_INPUT_FUNCTION_CALL_NAME,
              args: { message: "Name?" },
            },
          },
        ],
      },
      longRunningToolIds: ["ask-ask"],
    });
  }

  protected async *runLiveImpl() {}
}

function singleStep(agent: BaseAgent, stepId = "real") {
  return new WorkflowAgent({
    name: "wf",
    subAgents: [agent],
    definition: defineWorkflow({
      id: "single",
      version: "1",
      handler: async (ctx) =>
        (
          await ctx.run({
            id: stepId,
            agentName: agent.name,
            input: ctx.inputText,
          })
        ).output,
    }),
  });
}

describe("re-entering a waiting step emits nothing the model sees twice", () => {
  test("a long-running call is re-emitted as an id-only marker with no content", async () => {
    const real = new LongRunningLlmLikeAgent();
    const turn = await session(singleStep(real));
    await turn(START);

    const again = await turn(START);

    expect(again.error).toBeUndefined();
    expect(real.calls).toBe(1);
    const reemitted = delegationEvents(again.events);
    expect(reemitted).toHaveLength(1);
    expect(reemitted[0]?.author).toBe("real");
    expect(reemitted[0]?.content).toBeUndefined();
    expect(reemitted[0]?.longRunningToolIds).toEqual(["lro-1"]);
    expect(types(again.events).slice(-2)).toEqual([
      "step_waiting",
      "workflow_waiting",
    ]);
  });

  test("an adk_request_input call is re-emitted as its call part alone, without text", async () => {
    const ask = new ChattyAskAgent();
    const turn = await session(singleStep(ask, "ask"));
    await turn(START);

    const again = await turn(START);

    expect(again.error).toBeUndefined();
    expect(ask.calls).toBe(1);
    const reemitted = delegationEvents(again.events);
    expect(reemitted).toHaveLength(1);
    expect(reemitted[0]?.content?.parts).toEqual([
      {
        functionCall: {
          id: "ask-ask",
          name: REQUEST_INPUT_FUNCTION_CALL_NAME,
          args: { message: "Name?" },
        },
      },
    ]);
    expect(reemitted[0]?.longRunningToolIds).toEqual(["ask-ask"]);
    expect(
      reemitted.some((event) =>
        event.content?.parts?.some((part) => part.text !== undefined),
      ),
    ).toBe(false);
  });

  test("a later run of the step sees the long-running call id once in model history", async () => {
    const requests: LlmRequest[] = [];
    const model = new (class extends BaseLlm {
      constructor() {
        super({ model: "fake-history" });
      }
      async *generateContentAsync(
        request: LlmRequest,
      ): AsyncGenerator<LlmResponse, void> {
        requests.push(structuredClone(request.contents) as never);
        yield requests.length === 1
          ? {
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
            }
          : { content: { role: "model", parts: [{ text: "DONE" }] } };
      }
      async connect(): Promise<BaseLlmConnection> {
        throw new Error("not implemented");
      }
    })();
    const agent = new LlmAgent({
      name: "real",
      model,
      tools: [
        new LongRunningFunctionTool({
          name: "ask_human",
          description: "Ask a human.",
          parameters: z.object({ question: z.string() }),
          execute: async () => ({ status: "pending" }),
        }),
      ],
    });
    const turn = await session(singleStep(agent));

    const first = await turn(START);
    expect(types(first.events).at(-1)).toBe("workflow_waiting");
    // Re-entered twice without an answer.
    await turn(START);
    await turn(START);
    const answered = await turn(answer("lro-1", "ask_human"));
    expect(types(answered.events)).toContain("workflow_completed");
    // A new message starts a fresh run whose step inherits the history.
    const fresh = await turn({ role: "user", parts: [{ text: "again" }] });
    expect(fresh.error).toBeUndefined();

    const last = requests.at(-1) as unknown as Content[];
    const callIds = last.flatMap((content) =>
      (content.parts ?? []).flatMap((part) =>
        part.functionCall?.id ? [part.functionCall.id] : [],
      ),
    );
    expect(requests.length).toBeGreaterThanOrEqual(3);
    expect(callIds.filter((id) => id === "lro-1")).toHaveLength(1);
    expect(
      last.filter((content) =>
        content.parts?.some((part) => part.text === "I asked a human."),
      ),
    ).toHaveLength(0);
  });

  test("an outer gateway still sees the interrupt after re-entry", async () => {
    const parent = (agent: BaseAgent, invocationId: string) =>
      new InvocationContext({
        invocationId,
        agent,
        userContent: START,
        session: {
          id: "s",
          appName: "a",
          userId: "u",
          state: {},
          events: [],
          lastUpdateTime: 1,
        },
        pluginManager: new PluginManager(),
      });
    const reenter = async (agent: BaseAgent) => {
      const store = new KeyedStore();
      const workflow = new WorkflowAgent({
        name: "wf",
        subAgents: [agent],
        checkpointStore: store,
        resolveExecutionId: () => "run-1",
        definition: defineWorkflow({
          id: "single",
          version: "1",
          handler: async (ctx) =>
            (
              await ctx.run({
                id: "step",
                agentName: agent.name,
                input: ctx.inputText,
              })
            ).output,
        }),
      });
      const gateway = new AgentInvocationGateway({
        resolveAgent: () => workflow,
      });
      const delegate = (invocationId: string) =>
        gateway.run({
          agentName: "wf",
          input: START,
          parentContext: parent(workflow, invocationId),
        });
      await delegate("outer-1");
      return delegate("outer-2");
    };

    const longRunning = await reenter(new LongRunningLlmLikeAgent());
    expect(longRunning.error).toBeUndefined();
    expect(longRunning.interrupt).toMatchObject({
      kind: "long-running",
      functionCallIds: ["lro-1"],
    });

    const input = await reenter(new ChattyAskAgent());
    expect(input.error).toBeUndefined();
    expect(input.interrupt?.kind).toBe("input");
    expect(input.interrupt?.functionCallIds).toEqual(["ask-ask"]);
    expect(input.interrupt?.requests).toEqual([
      expect.objectContaining({ interruptId: "ask-ask" }),
    ]);
    expect(
      input.events.some((event) =>
        getFunctionCalls(event).some((call) => call.id === "ask-ask"),
      ),
    ).toBe(true);
  });
});

/** Runs the workflow again under the waiting run's execution id. */
async function reenter(
  workflow: WorkflowAgent,
  executionId: string,
  message: Content,
) {
  const context = new InvocationContext({
    pluginManager: new PluginManager(),
    invocationId: executionId,
    agent: workflow,
    userContent: message,
    session: {
      id: "s",
      appName: "app",
      userId: "u",
      state: {},
      events: [],
      lastUpdateTime: 1,
    },
  });
  const events: Event[] = [];
  for await (const event of workflow.runAsync(context)) events.push(event);
  return events;
}

describe("withWorkflowFailed and the workflow input", () => {
  test("a failed checkpoint with no waiting step drops the input", async () => {
    const store = new KeyedStore();
    const { workflow } = preThenAsk({ store });
    const turn = await session(workflow);
    const first = await turn(START);
    const key = `waiting:${workflowEvents(first.events).at(-1)?.executionId}`;
    const saved = store.checkpoints.get(key);
    if (!saved) throw new Error("missing checkpoint");
    const settled = {
      ...saved,
      steps: Object.fromEntries(
        Object.entries(saved.steps).map(([id, step]) => [
          id,
          { ...step, status: "completed" as const },
        ]),
      ),
    } as WorkflowCheckpointV1;

    const failed = withWorkflowFailed(settled, {
      code: "WORKFLOW_EXECUTION_ERROR",
      message: "x",
    });

    expect(saved.input).toBeDefined();
    expect(failed.input).toBeUndefined();
    expect(
      withWorkflowFailed(saved, {
        code: "WORKFLOW_EXECUTION_ERROR",
        message: "x",
      }).input,
    ).toEqual(saved.input);
  });
});

describe("a recorded wait after the run failed", () => {
  async function waitingThenFailed() {
    const store = new KeyedStore();
    const { ask, workflow } = preThenAsk({ store });
    const turn = await session(workflow);
    const first = await turn(START);
    const executionId = workflowEvents(first.events).at(-1)?.executionId ?? "";
    const key = `waiting:${executionId}`;
    const saved = store.checkpoints.get(key);
    if (!saved) throw new Error("missing checkpoint");
    return { store, ask, workflow, turn, executionId, key, saved };
  }

  test("a failed run keeps the input its wait needs, so the answer still resumes it", async () => {
    const { store, ask, turn, key, saved } = await waitingThenFailed();
    store.checkpoints.set(
      key,
      withWorkflowFailed(saved, {
        code: "WORKFLOW_EXECUTION_ERROR",
        message: "x",
      }),
    );

    const resumed = await turn(answer("ask-ask"));

    expect(resumed.error).toBeUndefined();
    expect(types(resumed.events)).toContain("workflow_completed");
    expect(ask.calls).toBe(2);
  });

  test("re-reaching the wait on a resume stores the input and the running status again", async () => {
    const { store, ask, workflow, turn, executionId, key, saved } =
      await waitingThenFailed();
    // A checkpoint written by an earlier release: failed, with no input.
    store.checkpoints.set(key, {
      ...withWorkflowFailed(saved, {
        code: "WORKFLOW_EXECUTION_ERROR",
        message: "x",
      }),
      input: undefined,
    });

    const again = await reenter(workflow, executionId, START);
    expect(types(again).at(-1)).toBe("workflow_waiting");
    const stored = store.checkpoints.get(key);
    expect(stored?.status).toBe("running");
    expect(stored?.input).toBeDefined();
    expect(stored?.error).toBeUndefined();

    const resumed = await turn(answer("ask-ask"));
    expect(resumed.error).toBeUndefined();
    expect(types(resumed.events)).toContain("workflow_completed");
    expect(ask.calls).toBe(2);
  });

  test("a run that failed on a step before the wait is resumed and answered end to end", async () => {
    const store = new KeyedStore();
    const pre = new PreAgent();
    const ask = new AskAgent();
    // The first step's input changes between turns, as a patched script would.
    let preInput = "a";
    const workflow = new WorkflowAgent({
      name: "wf",
      subAgents: [pre, ask],
      checkpointStore: store,
      definition: defineWorkflow({
        id: "waiting",
        version: "1",
        handler: async (ctx) => {
          await ctx.run({ id: "pre", agentName: "pre", input: preInput });
          const asked = await ctx.run({
            id: "ask",
            agentName: "ask",
            input: ctx.inputText,
          });
          return asked.output;
        },
      }),
    });
    const turn = await session(workflow);
    const first = await turn(START);
    expect(types(first.events).at(-1)).toBe("workflow_waiting");
    const executionId = workflowEvents(first.events).at(-1)?.executionId ?? "";
    const key = `waiting:${executionId}`;

    preInput = "changed";
    const failed = await turn(START);
    expect(failed.error?.code).toBe("WORKFLOW_STEP_MISMATCH");
    expect(store.checkpoints.get(key)?.status).toBe("failed");

    preInput = "a";
    // A failed run is not a waiting run any more, so the default execution id
    // would start a new one; the resume names the execution explicitly.
    const again = await reenter(workflow, executionId, START);
    expect(types(again).at(-1)).toBe("workflow_waiting");
    expect(store.checkpoints.get(key)?.status).toBe("running");

    const resumed = await turn(answer("ask-ask"));
    expect(resumed.error).toBeUndefined();
    expect(types(resumed.events)).toContain("workflow_completed");
    expect(ask.calls).toBe(2);
  });

  test("a running checkpoint that lost its input gets it back when the wait is re-reached", async () => {
    const { store, workflow, executionId, key, saved } =
      await waitingThenFailed();
    store.checkpoints.set(key, { ...saved, input: undefined });

    await reenter(workflow, executionId, START);

    expect(store.checkpoints.get(key)?.input).toBeDefined();
  });

  test("re-reaching a wait that is already stored writes nothing", async () => {
    const { store, workflow, executionId, key } = await waitingThenFailed();
    const before = store.checkpoints.get(key);

    await reenter(workflow, executionId, START);

    expect(store.checkpoints.get(key)).toEqual(before);
  });
});
