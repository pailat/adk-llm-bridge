/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import {
  BaseAgent,
  createEvent,
  type Event,
  InMemorySessionService,
  InvocationContext,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  Runner,
} from "@google/adk";
import type { Content } from "@google/genai";
import { withWorkflowFailed } from "../../src/workflows/checkpoint/checkpoint.js";
import type { WorkflowCheckpointV1 } from "../../src/workflows/checkpoint/schema.js";
import type {
  LoadWorkflowCheckpointInput,
  SaveWorkflowCheckpointInput,
  WorkflowCheckpointStore,
} from "../../src/workflows/checkpoint/store.js";
import { defineWorkflow } from "../../src/workflows/definition.js";
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
 * Mirrors ADK 2.4's `LlmAgent` with a `LongRunningFunctionTool`: the call, the
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

const START: Content = { role: "user", parts: [{ text: "start" }] };

const answer = (id: string, name = REQUEST_INPUT_FUNCTION_CALL_NAME) =>
  ({
    role: "user",
    parts: [{ functionResponse: { id, name, response: { value: 1 } } }],
  }) satisfies Content;

const workflowEvents = (events: readonly Event[]) =>
  events
    .map((event) => event.customMetadata?.workflowEvent)
    .filter(
      (event): event is { type: string; executionId: string } =>
        Boolean(event) && event.type !== "checkpoint_saved",
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
        { name: "WorkflowError", code: "WORKFLOW_ABORTED", message: "x" },
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
      .map((event) => event.customMetadata?.workflowEvent)
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
