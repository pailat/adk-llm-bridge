import { describe, expect } from "bun:test";
import {
  BaseAgent,
  createEvent,
  type Event,
  FunctionNode,
  getFunctionCalls,
  InMemorySessionService,
  InvocationContext,
  PluginManager,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  Runner,
  Workflow,
} from "@google/adk";
import type { Content } from "@google/genai";
import { AgentInvocationGateway } from "../../src/runtime/agent-invocation-gateway.js";
import type { WorkflowCheckpointV1 } from "../../src/workflows/checkpoint/schema.js";
import type {
  SaveWorkflowCheckpointInput,
  WorkflowCheckpointStore,
} from "../../src/workflows/checkpoint/store.js";
import {
  defineScriptWorkflow,
  defineWorkflow,
} from "../../src/workflows/definition.js";
import type { WorkflowEvent } from "../../src/workflows/events.js";
import {
  WORKFLOW_SCRIPT_PROTOCOL,
  WORKFLOW_SCRIPT_PROTOCOL_VERSION,
} from "../../src/workflows/sandbox/protocol.js";
import { QUICKJS_SYNC_CAPABILITIES } from "../../src/workflows/sandbox/quickjs-generator-runtime.js";
import type { WorkflowScriptRuntime } from "../../src/workflows/sandbox/types.js";
import { ScriptWorkflowAgent } from "../../src/workflows/script-workflow-agent.js";
import { WorkflowAgent } from "../../src/workflows/workflow-agent.js";
// Every test here gets a deadline and the host-blocking watchdog.
import { sandboxTest as test } from "../helpers/sandbox-test.js";

class MemoryStore implements WorkflowCheckpointStore {
  checkpoint?: WorkflowCheckpointV1;

  async load() {
    return this.checkpoint;
  }

  async save(input: SaveWorkflowCheckpointInput) {
    this.checkpoint = input.checkpoint;
    return { checkpointKey: "k", stateDelta: { k: input.checkpoint } };
  }
}

/** Asks for input on the first run and finishes once it is answered. */
class AskAgent extends BaseAgent {
  calls = 0;
  answeredWith: unknown[] = [];

  constructor(name: string) {
    super({ name });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.calls += 1;
    const response = context.userContent?.parts?.find(
      (part) => part.functionResponse,
    )?.functionResponse;
    if (response) {
      this.answeredWith.push(response.response);
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        content: {
          role: "model",
          parts: [
            { text: `${this.name} got ${JSON.stringify(response.response)}` },
          ],
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
              id: `${this.name}-ask`,
              name: REQUEST_INPUT_FUNCTION_CALL_NAME,
              args: { message: `${this.name}?` },
            },
          },
        ],
      },
      longRunningToolIds: [`${this.name}-ask`],
    });
  }

  protected async *runLiveImpl() {}
}

class DoneAgent extends BaseAgent {
  calls = 0;

  constructor(name: string) {
    super({ name });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.calls += 1;
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: { role: "model", parts: [{ text: `${this.name} done` }] },
    });
  }

  protected async *runLiveImpl() {}
}

/** The workflow event an ADK event carries in its metadata, if any. */
const workflowEventOf = (event: Event) =>
  event.customMetadata?.workflowEvent as WorkflowEvent | undefined;

function answerFor(agent: string, response: unknown): Content {
  return {
    role: "user",
    parts: [
      {
        functionResponse: {
          id: `${agent}-ask`,
          name: REQUEST_INPUT_FUNCTION_CALL_NAME,
          response: response as Record<string, unknown>,
        },
      },
    ],
  };
}

function turn(
  agent: BaseAgent,
  userContent: Content,
  invocationId: string,
): InvocationContext {
  return new InvocationContext({
    pluginManager: new PluginManager(),
    invocationId,
    agent,
    userContent,
    session: {
      id: "s",
      appName: "a",
      userId: "u",
      state: {},
      events: [],
      lastUpdateTime: 1,
    },
  });
}

async function drain(agent: BaseAgent, context: InvocationContext) {
  const events: Event[] = [];
  let error: { code?: string } | undefined;
  try {
    for await (const event of agent.runAsync(context)) events.push(event);
  } catch (caught) {
    error = caught as { code?: string };
  }
  return { events, error };
}

const types = (events: readonly Event[]) =>
  events.map((event) => workflowEventOf(event)?.type).filter(Boolean);

const START: Content = { role: "user", parts: [{ text: "start" }] };

function sequential(ask: BaseAgent, store: MemoryStore) {
  return new WorkflowAgent({
    name: "workflow",
    subAgents: [ask],
    checkpointStore: store,
    resolveExecutionId: () => "run-1",
    definition: defineWorkflow({
      id: "interrupt",
      version: "1",
      handler: async (ctx) => {
        const result = await ctx.run({
          id: "ask",
          agentName: ask.name,
          input: ctx.inputText,
        });
        return `done(${result.output})`;
      },
    }),
  });
}

describe("workflow step interrupts", () => {
  test("a step that asks for input is persisted as waiting and the run ends cleanly", async () => {
    const ask = new AskAgent("ask");
    const store = new MemoryStore();
    const workflow = sequential(ask, store);

    const { events, error } = await drain(
      workflow,
      turn(workflow, START, "i1"),
    );

    expect(error).toBeUndefined();
    expect(types(events)).toContain("step_waiting");
    expect(types(events).at(-1)).toBe("workflow_waiting");
    expect(types(events)).not.toContain("workflow_completed");
    expect(types(events)).not.toContain("output");
    // ADK form: the child's own pause event is forwarded to the caller.
    const pause = events.find((event) => event.longRunningToolIds?.length);
    expect(pause?.longRunningToolIds).toEqual(["ask-ask"]);
    const saved = store.checkpoint?.steps.ask;
    expect(saved?.status).toBe("waiting");
    expect(saved?.interrupt?.functionCallIds).toEqual(["ask-ask"]);
    expect(saved?.interrupt?.kind).toBe("input");
    expect(store.checkpoint?.input).toEqual(START);
    expect(store.checkpoint?.status).toBe("running");
  });

  test("the next turn answers the step, resumes it and completes the workflow", async () => {
    const ask = new AskAgent("ask");
    const store = new MemoryStore();
    const workflow = sequential(ask, store);
    await drain(workflow, turn(workflow, START, "i1"));

    const { events, error } = await drain(
      workflow,
      turn(workflow, answerFor("ask", { value: 42 }), "i2"),
    );

    expect(error).toBeUndefined();
    expect(ask.calls).toBe(2);
    expect(ask.answeredWith).toEqual([{ value: 42 }]);
    expect(types(events)).toContain("workflow_completed");
    const output = events.find((event) => event.output !== undefined);
    expect(output?.output).toBe('done(ask got {"value":42})');
    expect(store.checkpoint?.status).toBe("completed");
    expect(store.checkpoint?.steps.ask?.status).toBe("completed");
    expect(store.checkpoint?.steps.ask?.interrupt).toBeUndefined();
    expect(store.checkpoint?.input).toBeUndefined();
  });

  test("re-entering without an answer keeps waiting and does not run the agent", async () => {
    const ask = new AskAgent("ask");
    const store = new MemoryStore();
    const workflow = sequential(ask, store);
    await drain(workflow, turn(workflow, START, "i1"));

    const { events, error } = await drain(
      workflow,
      turn(workflow, START, "i2"),
    );

    expect(error).toBeUndefined();
    expect(ask.calls).toBe(1);
    expect(types(events)).toContain("workflow_waiting");
    expect(store.checkpoint?.steps.ask?.status).toBe("waiting");
  });

  test("re-entering without an answer re-emits the pending request and step_waiting", async () => {
    const ask = new AskAgent("ask");
    const store = new MemoryStore();
    const workflow = sequential(ask, store);
    await drain(workflow, turn(workflow, START, "i1"));

    const { events, error } = await drain(
      workflow,
      turn(workflow, START, "i2"),
    );

    expect(error).toBeUndefined();
    expect(ask.calls).toBe(1);
    const request = events.find((event) =>
      getFunctionCalls(event).some((call) => call.id === "ask-ask"),
    );
    expect(request?.author).toBe("ask");
    expect(request?.invocationId).toBe("i2");
    expect(request?.longRunningToolIds).toEqual(["ask-ask"]);
    expect(getFunctionCalls(request as Event)[0]?.name).toBe(
      REQUEST_INPUT_FUNCTION_CALL_NAME,
    );
    expect(types(events).slice(-2)).toEqual([
      "step_waiting",
      "workflow_waiting",
    ]);
    const waiting = events.find(
      (event) => workflowEventOf(event)?.type === "step_waiting",
    )?.customMetadata?.workflowEvent;
    expect(waiting).toMatchObject({
      executionId: "run-1",
      stepId: "ask",
      attempt: 1,
      kind: "input",
      functionCallIds: ["ask-ask"],
    });
  });

  test("a gateway re-entering a still-waiting workflow sees its interrupt", async () => {
    const ask = new AskAgent("ask");
    const store = new MemoryStore();
    const workflow = sequential(ask, store);
    const gateway = new AgentInvocationGateway({
      resolveAgent: () => workflow,
    });
    const parent = (invocationId: string) =>
      new InvocationContext({
        invocationId,
        agent: workflow,
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
    const delegate = (invocationId: string) =>
      gateway.run({
        agentName: "workflow",
        input: START,
        parentContext: parent(invocationId),
      });

    const first = await delegate("outer-1");
    expect(first.interrupt?.functionCallIds).toEqual(["ask-ask"]);

    // A fresh delegation (no resume) re-enters the same waiting run.
    const second = await delegate("outer-2");

    expect(second.error).toBeUndefined();
    expect(ask.calls).toBe(1);
    expect(second.interrupt).toMatchObject({
      kind: "input",
      functionCallIds: ["ask-ask"],
    });

    // The re-emitted request is answerable: resuming with it completes.
    const resumed = await gateway.run({
      agentName: "workflow",
      input: answerFor("ask", { value: "blue" }),
      resume: { events: second.interrupt?.events ?? [] },
      parentContext: parent("outer-3"),
    });
    expect(resumed.error).toBeUndefined();
    expect(resumed.interrupt).toBeUndefined();
    expect(resumed.output).toContain('ask got {"value":"blue"}');
    expect(store.checkpoint?.status).toBe("completed");
  });

  test("an outer workflow re-entering a waiting inner workflow waits instead of completing", async () => {
    const ask = new AskAgent("ask");
    const innerStore = new MemoryStore();
    const inner = sequential(ask, innerStore);
    let outerRun = 0;
    const outer = new WorkflowAgent({
      name: "outer",
      subAgents: [inner],
      // Each turn is a fresh outer run (the default store keeps it in the
      // turn's session state); the inner run id and store stay the same.
      resolveExecutionId: () => `outer-${++outerRun}`,
      definition: defineWorkflow({
        id: "outer",
        version: "1",
        handler: async (ctx) =>
          (
            await ctx.run({
              id: "inner",
              agentName: "workflow",
              input: ctx.inputText,
            })
          ).output,
      }),
    });

    const first = await drain(outer, turn(outer, START, "o1"));
    expect(types(first.events).at(-1)).toBe("workflow_waiting");

    const second = await drain(outer, turn(outer, START, "o2"));

    expect(second.error).toBeUndefined();
    expect(ask.calls).toBe(1);
    expect(types(second.events)).not.toContain("workflow_completed");
    const outerWaiting = second.events
      .map((event) => workflowEventOf(event))
      .find(
        (event) =>
          event?.type === "step_waiting" && event.executionId === "outer-2",
      );
    expect(outerWaiting).toMatchObject({
      stepId: "inner",
      functionCallIds: ["ask-ask"],
    });
    expect(innerStore.checkpoint?.steps.ask?.status).toBe("waiting");
  });

  test("a stale or foreign response is rejected without touching the checkpoint", async () => {
    const ask = new AskAgent("ask");
    const store = new MemoryStore();
    const workflow = sequential(ask, store);
    await drain(workflow, turn(workflow, START, "i1"));
    const before = JSON.stringify(store.checkpoint);

    const { error } = await drain(
      workflow,
      turn(workflow, answerFor("someone-else", { value: 1 }), "i2"),
    );

    expect(error?.code).toBe("WORKFLOW_INPUT_MISMATCH");
    expect(ask.calls).toBe(1);
    expect(JSON.stringify(store.checkpoint)).toBe(before);
  });

  test("a waiting step does not cancel its parallel siblings and each is resumed once", async () => {
    const ask = new AskAgent("ask");
    const done = new DoneAgent("done");
    const store = new MemoryStore();
    const workflow = new WorkflowAgent({
      name: "workflow",
      subAgents: [ask, done],
      checkpointStore: store,
      resolveExecutionId: () => "run-1",
      definition: defineWorkflow({
        id: "parallel-interrupt",
        version: "1",
        handler: async (ctx) => {
          const [a, b] = await ctx.parallel(
            [
              { id: "ask", agentName: "ask", input: ctx.inputText },
              { id: "done", agentName: "done", input: ctx.inputText },
            ],
            { failureMode: "all-settled" },
          );
          return `${a?.status === "completed" ? a.output : "?"}|${b?.status === "completed" ? b.output : "?"}`;
        },
      }),
    });

    const first = await drain(workflow, turn(workflow, START, "i1"));

    expect(first.error).toBeUndefined();
    expect(types(first.events)).toContain("workflow_waiting");
    expect(store.checkpoint?.steps.ask?.status).toBe("waiting");
    expect(store.checkpoint?.steps.done?.status).toBe("completed");

    const second = await drain(
      workflow,
      turn(workflow, answerFor("ask", { ok: true }), "i2"),
    );

    expect(second.error).toBeUndefined();
    expect(done.calls).toBe(1);
    expect(ask.calls).toBe(2);
    expect(second.events.find((e) => e.output !== undefined)?.output).toBe(
      'ask got {"ok":true}|done done',
    );
  });

  test("two turns through the Runner resume with the default store and execution id", async () => {
    const ask = new AskAgent("ask");
    const workflow = new WorkflowAgent({
      name: "workflow",
      subAgents: [ask],
      definition: defineWorkflow({
        id: "runner-interrupt",
        version: "1",
        handler: async (ctx) => {
          const result = await ctx.run({
            id: "ask",
            agentName: "ask",
            input: ctx.inputText,
          });
          return `done(${result.output})`;
        },
      }),
    });
    const sessions = new InMemorySessionService();
    const runner = new Runner({
      appName: "interrupts",
      agent: workflow,
      sessionService: sessions,
    });
    const session = await sessions.createSession({
      appName: "interrupts",
      userId: "user",
    });
    const run = async (message: Content) => {
      const events: Event[] = [];
      for await (const event of runner.runAsync({
        userId: "user",
        sessionId: session.id,
        newMessage: message,
      })) {
        events.push(event);
      }
      return events;
    };

    const first = await run(START);
    expect(types(first)).toContain("workflow_waiting");

    const second = await run(answerFor("ask", { value: "blue" }));

    expect(types(second)).toContain("workflow_completed");
    expect(second.find((event) => event.output !== undefined)?.output).toBe(
      'done(ask got {"value":"blue"})',
    );
    expect(ask.calls).toBe(2);
  });

  test("a script workflow pauses on a waiting step and resumes on the next turn", async () => {
    const ask = new AskAgent("ask");
    const store = new MemoryStore();
    const op = (name: string, payload: Record<string, unknown>) => ({
      protocol: WORKFLOW_SCRIPT_PROTOCOL,
      version: WORKFLOW_SCRIPT_PROTOCOL_VERSION,
      op: name,
      ...payload,
    });
    const runtime: WorkflowScriptRuntime = {
      capabilities: QUICKJS_SYNC_CAPABILITIES,
      async createSession() {
        const generator = (function* (): Generator<unknown, unknown, unknown> {
          const result = (yield op("run", {
            step: { id: "ask", agentName: "ask", input: "start" },
          })) as { output: string };
          return `scripted(${result.output})`;
        })();
        let disposed = false;
        return {
          get disposed() {
            return disposed;
          },
          next: (value?: unknown) => generator.next(value),
          dispose() {
            disposed = true;
            generator.return(undefined);
          },
        } as never;
      },
    };
    const workflow = new ScriptWorkflowAgent({
      name: "script",
      subAgents: [ask],
      runtime,
      checkpointStore: store,
      resolveExecutionId: () => "run-1",
      definition: defineScriptWorkflow({
        id: "script-interrupt",
        version: "1",
        source: "/* executed by the injected runtime */",
      }),
    });

    const first = await drain(workflow, turn(workflow, START, "i1"));
    expect(first.error).toBeUndefined();
    expect(types(first.events)).toContain("workflow_waiting");
    expect(store.checkpoint?.steps.ask?.status).toBe("waiting");

    const second = await drain(
      workflow,
      turn(workflow, answerFor("ask", { v: 1 }), "i2"),
    );
    expect(second.error).toBeUndefined();
    expect(second.events.find((e) => e.output !== undefined)?.output).toBe(
      'scripted(ask got {"v":1})',
    );
    expect(ask.calls).toBe(2);
  });

  test("as an ADK Workflow node it pauses the graph and resumes on the answer", async () => {
    const ask = new AskAgent("ask");
    const durable = new WorkflowAgent({
      name: "durable",
      subAgents: [ask],
      definition: defineWorkflow({
        id: "node-interrupt",
        version: "1",
        handler: async (ctx) =>
          (await ctx.run({ id: "ask", agentName: "ask", input: ctx.inputText }))
            .output,
      }),
    });
    expect(durable.rerunOnResume).toBe(true);
    const after = new FunctionNode("after", (_ctx, input) => ({
      seen: String(input),
    }));
    const graph = new Workflow({
      name: "graph",
      edges: [["START", durable, after]],
    });
    const sessions = new InMemorySessionService();
    const runner = new Runner({
      appName: "node-interrupt",
      agent: graph,
      sessionService: sessions,
    });
    const session = await sessions.createSession({
      appName: "node-interrupt",
      userId: "user",
    });
    const run = async (message: Content) => {
      const events: Event[] = [];
      for await (const event of runner.runAsync({
        userId: "user",
        sessionId: session.id,
        newMessage: message,
      })) {
        events.push(event);
      }
      return events;
    };

    const first = await run(START);
    expect(first.some((event) => event.author === "after")).toBe(false);

    const second = await run(answerFor("ask", { value: "blue" }));
    const final = second.find((event) => event.author === "after");
    expect(final?.output).toEqual({ seen: 'ask got {"value":"blue"}' });
    expect(ask.calls).toBe(2);
  });
});
