import { describe, expect, test } from "bun:test";
import {
  BaseAgent,
  BaseLlm,
  type BaseLlmConnection,
  createEvent,
  type Event,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  type LlmResponse,
  PluginManager,
  SequentialAgent,
} from "@google/adk";
import type { Content } from "@google/genai";
import { convertResponse } from "../../src/converters/response.js";
import { convertAnthropicResponse } from "../../src/providers/anthropic/converters/response.js";
import type { WorkflowCheckpointV1 } from "../../src/workflows/checkpoint/schema.js";
import type {
  SaveWorkflowCheckpointInput,
  WorkflowCheckpointStore,
} from "../../src/workflows/checkpoint/store.js";
import type { WorkflowStep } from "../../src/workflows/contracts.js";
import {
  defineScriptWorkflow,
  defineWorkflow,
} from "../../src/workflows/definition.js";
import type {
  WorkflowEvent,
  WorkflowStepCompletedEvent,
  WorkflowStepFailedEvent,
} from "../../src/workflows/events.js";
import { QuickJSSyncGeneratorRuntime } from "../../src/workflows/sandbox/quickjs-generator-runtime.js";
import { runWorkflowScript } from "../../src/workflows/sandbox/workflow-script-runner.js";
import { ScriptWorkflowAgent } from "../../src/workflows/script-workflow-agent.js";
import { WorkflowAgent } from "../../src/workflows/workflow-agent.js";
import { sandboxTest } from "../helpers/sandbox-test.js";

type Reply = {
  text?: string;
  finishReason?: string;
  candidates?: number;
  thoughts?: number;
  call?: string;
  partials?: string[];
  partialFinish?: string;
};

/** A model that answers each call with the next scripted reply (the last repeats). */
class ScriptedLlm extends BaseLlm {
  calls = 0;
  readonly #replies: readonly Reply[];

  constructor(replies: readonly Reply[]) {
    super({ model: "scripted-trunc" });
    this.#replies = replies;
  }

  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    const reply =
      this.#replies[Math.min(this.calls, this.#replies.length - 1)] ?? {};
    this.calls += 1;
    for (const partial of reply.partials ?? []) {
      yield {
        partial: true,
        content: { role: "model", parts: [{ text: partial }] },
        ...(reply.partialFinish
          ? { finishReason: reply.partialFinish as never }
          : {}),
      };
    }
    const parts: NonNullable<Content["parts"]> = [];
    if (reply.text !== undefined) parts.push({ text: reply.text });
    if (reply.call)
      parts.push({ functionCall: { id: "c1", name: reply.call, args: {} } });
    yield {
      content: { role: "model", parts },
      ...(reply.finishReason
        ? { finishReason: reply.finishReason as never }
        : {}),
      ...(reply.candidates !== undefined
        ? {
            usageMetadata: {
              promptTokenCount: 10,
              candidatesTokenCount: reply.candidates,
              thoughtsTokenCount: reply.thoughts,
              totalTokenCount:
                10 + (reply.candidates ?? 0) + (reply.thoughts ?? 0),
            },
          }
        : {}),
    };
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error("not implemented");
  }
}

function llmAgent(
  name: string,
  replies: readonly Reply[],
  maxOutputTokens?: number,
): { agent: LlmAgent; llm: ScriptedLlm } {
  const llm = new ScriptedLlm(replies);
  const agent = new LlmAgent({
    name,
    model: llm,
    tools: [
      new FunctionTool({
        name: "lookup",
        description: "lookup",
        execute: () => ({ ok: true }),
      }),
    ],
    ...(maxOutputTokens ? { generateContentConfig: { maxOutputTokens } } : {}),
  });
  return { agent, llm };
}

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

/** A new writer agent over the same scripted model, for a rebuilt workflow. */
const rebuilt = (llm: ScriptedLlm) =>
  new LlmAgent({ name: "writer", model: llm });

function turn(agent: BaseAgent, id = "inv-1"): InvocationContext {
  return new InvocationContext({
    pluginManager: new PluginManager(),
    invocationId: id,
    branch: "root",
    agent,
    userContent: { role: "user", parts: [{ text: "go" }] },
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

async function drain(agent: BaseAgent, id?: string) {
  const events: Event[] = [];
  let error:
    | (Error & { code?: string; details?: Record<string, unknown> })
    | undefined;
  try {
    for await (const event of agent.runAsync(turn(agent, id)))
      events.push(event);
  } catch (caught) {
    error = caught as typeof error;
  }
  const flow = events
    .map((event) => event.customMetadata?.workflowEvent as WorkflowEvent)
    .filter(Boolean);
  return {
    events,
    error,
    completed: flow.filter(
      (e): e is WorkflowStepCompletedEvent => e.type === "step_completed",
    ),
    failed: flow.filter(
      (e): e is WorkflowStepFailedEvent => e.type === "step_failed",
    ),
    started: flow.filter((e) => e.type === "step_started"),
  };
}

function oneStep(
  worker: BaseAgent,
  step: Partial<WorkflowStep> = {},
  extra: {
    store?: MemoryStore;
    retryFailedSteps?: boolean;
    follow?: BaseAgent;
  } = {},
) {
  return new WorkflowAgent({
    name: "wf",
    subAgents: extra.follow ? [worker, extra.follow] : [worker],
    ...(extra.store
      ? { checkpointStore: extra.store, resolveExecutionId: () => "run-1" }
      : {}),
    ...(extra.retryFailedSteps ? { retryFailedSteps: true } : {}),
    definition: defineWorkflow({
      id: "trunc",
      version: "1",
      limits: { maxAttemptsPerStep: 2 },
      handler: async (ctx) => {
        const first = await ctx.run({
          id: "s1",
          agentName: worker.name,
          input: "x",
          ...step,
        });
        if (extra.follow) {
          await ctx.run({
            id: "s2",
            agentName: extra.follow.name,
            input: first.output,
          });
        }
        return first.output;
      },
    }),
  });
}

const CUT: Reply = {
  text: "cut off",
  finishReason: "MAX_TOKENS",
  candidates: 4339,
  thoughts: 7661,
};

describe("a step with an incomplete model response", () => {
  test("a MAX_TOKENS reply fails the step with typed details and the next step does not run", async () => {
    const { agent } = llmAgent("writer", [CUT], 12000);
    const follow = llmAgent("after", [{ text: "ok", finishReason: "STOP" }]);
    const result = await drain(oneStep(agent, {}, { follow: follow.agent }));
    expect(result.completed).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(result.error?.code).toBe("WORKFLOW_STEP_INCOMPLETE");
    expect(result.failed[0]?.failure.error).toMatchObject({
      code: "WORKFLOW_STEP_INCOMPLETE",
      details: {
        stepId: "s1",
        agentName: "writer",
        attempt: 1,
        finishReason: "MAX_TOKENS",
        author: "writer",
        outputTokens: 4339,
        thoughtsTokens: 7661,
        maxOutputTokens: 12000,
      },
    });
    expect(follow.llm.calls).toBe(0);
  });

  test("streaming: partial events are ignored and the final MAX_TOKENS event fails the step", async () => {
    const { agent } = llmAgent("writer", [
      { ...CUT, partials: ["cut ", "off"] },
    ]);
    const result = await drain(oneStep(agent));
    expect(result.error?.code).toBe("WORKFLOW_STEP_INCOMPLETE");
    expect(result.failed[0]?.failure.error.details).toMatchObject({
      finishReason: "MAX_TOKENS",
    });
  });

  test("SAFETY with partial content fails; SAFETY with no content keeps the execution error", async () => {
    const partial = llmAgent("writer", [
      { text: "half", finishReason: "SAFETY" },
    ]);
    const cut = await drain(oneStep(partial.agent));
    expect(cut.error?.code).toBe("WORKFLOW_STEP_INCOMPLETE");
    expect(cut.failed[0]?.failure.error.details).toMatchObject({
      finishReason: "SAFETY",
    });

    const empty = new (class extends BaseAgent {
      protected async *runAsyncImpl(context: InvocationContext) {
        yield createEvent({
          invocationId: context.invocationId,
          author: this.name,
          finishReason: "SAFETY" as never,
          errorCode: "SAFETY" as never,
          errorMessage: "blocked",
        });
      }
      protected async *runLiveImpl() {}
    })({ name: "blocked" });
    const none = await drain(oneStep(empty));
    expect(none.error?.code).toBe("WORKFLOW_EXECUTION_ERROR");
    expect(none.error?.details).toMatchObject({ causeCode: "SAFETY" });
  });

  test("STOP completes and puts finishReason on the result and the event", async () => {
    const { agent } = llmAgent("writer", [
      { text: "done", finishReason: "STOP" },
    ]);
    const result = await drain(oneStep(agent));
    expect(result.error).toBeUndefined();
    expect(result.completed[0]?.result.finishReason).toBe("STOP");
  });

  test("allowIncompleteOutput completes with the partial output and the finish reason", async () => {
    const { agent } = llmAgent("writer", [CUT]);
    const result = await drain(oneStep(agent, { allowIncompleteOutput: true }));
    expect(result.error).toBeUndefined();
    expect(result.completed[0]?.result).toMatchObject({
      output: "cut off",
      finishReason: "MAX_TOKENS",
    });
  });

  test("a MAX_TOKENS turn with a valid function call runs the tool and completes", async () => {
    const { agent, llm } = llmAgent("writer", [
      { call: "lookup", finishReason: "MAX_TOKENS", candidates: 5 },
      { text: "answer", finishReason: "STOP" },
    ]);
    const result = await drain(oneStep(agent));
    expect(result.error).toBeUndefined();
    expect(llm.calls).toBe(2);
    expect(result.completed[0]?.result.output).toBe("answer");
  });

  test("an undefined or OTHER finish reason completes", async () => {
    const plain = llmAgent("plain", [{ text: "fine" }]);
    const plainResult = await drain(oneStep(plain.agent));
    expect(plainResult.error).toBeUndefined();
    expect("finishReason" in (plainResult.completed[0]?.result ?? {})).toBe(
      false,
    );

    const other = llmAgent("other", [{ text: "fine", finishReason: "OTHER" }]);
    const otherResult = await drain(oneStep(other.agent));
    expect(otherResult.error).toBeUndefined();
  });

  test("the retry policy resamples: MAX_TOKENS then STOP completes on attempt 2", async () => {
    const { agent, llm } = llmAgent("writer", [
      CUT,
      { text: "whole", finishReason: "STOP" },
    ]);
    const result = await drain(oneStep(agent, { retry: { maxAttempts: 2 } }));
    expect(result.error).toBeUndefined();
    expect(llm.calls).toBe(2);
    expect(result.completed[0]?.result).toMatchObject({
      output: "whole",
      attempts: 2,
    });
  });

  test("the failure is checkpointed, replays on resume and reruns with retryFailedSteps", async () => {
    const store = new MemoryStore();
    const first = llmAgent("writer", [
      CUT,
      { text: "whole", finishReason: "STOP" },
    ]);
    const initial = await drain(
      oneStep(rebuilt(first.llm), {}, { store }),
      "inv-1",
    );
    expect(initial.error?.code).toBe("WORKFLOW_STEP_INCOMPLETE");
    expect(store.checkpoint?.steps.s1?.status).toBe("failed");

    const replay = await drain(
      oneStep(rebuilt(first.llm), {}, { store }),
      "inv-2",
    );
    expect(replay.error?.code).toBe("WORKFLOW_STEP_INCOMPLETE");
    expect(first.llm.calls).toBe(1);

    const retried = await drain(
      oneStep(rebuilt(first.llm), {}, { store, retryFailedSteps: true }),
      "inv-3",
    );
    expect(retried.error).toBeUndefined();
    expect(first.llm.calls).toBe(2);
    expect(store.checkpoint?.steps.s1?.status).toBe("completed");
  });

  test("a SequentialAgent step fails when its first child was cut", async () => {
    const a = llmAgent("a", [CUT]);
    const b = llmAgent("b", [{ text: "fine", finishReason: "STOP" }]);
    const seq = new SequentialAgent({
      name: "seq",
      subAgents: [a.agent, b.agent],
    });
    const result = await drain(oneStep(seq));
    expect(result.error?.code).toBe("WORKFLOW_STEP_INCOMPLETE");
    expect(result.failed[0]?.failure.error.details).toMatchObject({
      author: "a",
    });
  });

  test("a nested workflow whose inner step opts out completes the outer step", async () => {
    const { agent } = llmAgent("inner_writer", [CUT]);
    const inner = new WorkflowAgent({
      name: "inner",
      subAgents: [agent],
      definition: defineWorkflow({
        id: "inner",
        version: "1",
        handler: async (ctx) =>
          (
            await ctx.run({
              id: "i1",
              agentName: "inner_writer",
              input: "x",
              allowIncompleteOutput: true,
            })
          ).output,
      }),
    });
    const result = await drain(oneStep(inner));
    expect(result.error).toBeUndefined();
    expect(result.completed.map((e) => e.result.id)).toContain("s1");
  });
});

/** A model that yields fixed, already converted responses. */
class RawLlm extends BaseLlm {
  constructor(readonly responses: readonly LlmResponse[]) {
    super({ model: "raw-trunc" });
  }
  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    yield* this.responses;
  }
  async connect(): Promise<BaseLlmConnection> {
    throw new Error("not implemented");
  }
}

const rawAgent = (name: string, response: LlmResponse) =>
  new LlmAgent({ name, model: new RawLlm([response]) });

const openAiCut = (message: Record<string, unknown>) =>
  convertResponse({
    id: "c",
    object: "chat.completion",
    created: 1,
    model: "m",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          refusal: null,
          content: null,
          ...message,
        },
        finish_reason: "length",
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  } as never);

const anthropicCut = (content: unknown[]) =>
  convertAnthropicResponse({
    id: "m",
    type: "message",
    role: "assistant",
    model: "claude",
    content,
    stop_reason: "max_tokens",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 2 },
  } as never);

describe("a cut with no visible text", () => {
  const cases: [string, LlmResponse][] = [
    ["OpenAI thought-only", openAiCut({ reasoning_content: "thinking hard" })],
    ["OpenAI empty content", openAiCut({})],
    [
      "Anthropic thought-only",
      anthropicCut([{ type: "thinking", thinking: "hm", signature: "sig" }]),
    ],
    ["Anthropic empty content", anthropicCut([])],
  ];
  for (const [name, response] of cases) {
    test(`${name} fails the step with WORKFLOW_STEP_INCOMPLETE`, async () => {
      const result = await drain(oneStep(rawAgent("writer", response)));
      expect(result.completed).toHaveLength(0);
      expect(result.error?.code).toBe("WORKFLOW_STEP_INCOMPLETE");
      expect(result.error?.details).toMatchObject({
        finishReason: "MAX_TOKENS",
      });
    });
  }
});

describe("step edge rules", () => {
  test("partial events that carry MAX_TOKENS do not fail a step that ends with STOP", async () => {
    const { agent } = llmAgent("writer", [
      {
        partials: ["a", "b"],
        partialFinish: "MAX_TOKENS",
        text: "ab",
        finishReason: "STOP",
      },
    ]);
    const result = await drain(oneStep(agent));
    expect(result.error).toBeUndefined();
    expect(result.completed[0]?.result.finishReason).toBe("STOP");
  });

  test("a non-boolean allowIncompleteOutput is refused", async () => {
    for (const bad of ["true", "false", 1, null]) {
      const { agent, llm } = llmAgent("writer", [CUT]);
      const result = await drain(
        oneStep(agent, { allowIncompleteOutput: bad as never }),
      );
      expect(result.error?.code).toBe("WORKFLOW_DEFINITION_INVALID");
      expect(llm.calls).toBe(0);
    }
  });

  test("an agent error after a cut event keeps WORKFLOW_EXECUTION_ERROR and its cause", async () => {
    const worker = new (class extends BaseAgent {
      protected async *runAsyncImpl(context: InvocationContext) {
        yield createEvent({
          invocationId: context.invocationId,
          author: this.name,
          content: { role: "model", parts: [{ text: "cut" }] },
          finishReason: "MAX_TOKENS" as never,
        });
        yield createEvent({
          invocationId: context.invocationId,
          author: this.name,
          errorCode: "MODEL_NOT_FOUND",
          errorMessage: "model_not_found",
        });
      }
      protected async *runLiveImpl() {}
    })({ name: "mixed" });
    const result = await drain(oneStep(worker));
    expect(result.error?.code).toBe("WORKFLOW_EXECUTION_ERROR");
    expect(result.error?.details).toMatchObject({
      causeCode: "MODEL_NOT_FOUND",
    });
  });

  test("an accepted cut keeps its finishReason when a later final event has no text", async () => {
    const a = llmAgent("a", [{ text: "half", finishReason: "MAX_TOKENS" }]);
    const b = llmAgent("b", [{ text: "", finishReason: "STOP" }]);
    const seq = new SequentialAgent({
      name: "seq",
      subAgents: [a.agent, b.agent],
    });
    const result = await drain(oneStep(seq, { allowIncompleteOutput: true }));
    expect(result.error).toBeUndefined();
    expect(result.completed[0]?.result.output).toBe("half");
    expect(result.completed[0]?.result.finishReason).toBe("MAX_TOKENS");
  });

  test("a bridge workflow below a SequentialAgent keeps its opt-out for the outer step", async () => {
    const cut = llmAgent("inner_writer", [CUT]);
    const inner = new WorkflowAgent({
      name: "inner",
      subAgents: [cut.agent],
      definition: defineWorkflow({
        id: "inner2",
        version: "1",
        handler: async (ctx) =>
          (
            await ctx.run({
              id: "i1",
              agentName: "inner_writer",
              input: "x",
              allowIncompleteOutput: true,
            })
          ).output,
      }),
    });
    const tail = llmAgent("tail", [{ text: "fine", finishReason: "STOP" }]);
    const seq = new SequentialAgent({
      name: "seq",
      subAgents: [inner, tail.agent],
    });
    const result = await drain(oneStep(seq));
    expect(result.error).toBeUndefined();
    expect(result.completed.map((e) => e.result.id)).toContain("s1");
  });
});

describe("script workflows", () => {
  sandboxTest("allowIncompleteOutput is an accepted step key", async () => {
    const steps: WorkflowStep[] = [];
    await runWorkflowScript(new QuickJSSyncGeneratorRuntime(), {
      source:
        'yield ctx.run({ id: "a", agentName: "agent", input: "go", allowIncompleteOutput: true }); return "done";',
      host: {
        async run(step) {
          steps.push(step);
          return {
            status: "completed",
            id: step.id,
            agentName: step.agentName,
            output: "ok",
            attempts: 1,
            startedAt: 1,
            completedAt: 2,
          };
        },
        async parallel() {
          return [];
        },
        emit() {},
      },
    });
    expect(steps[0]?.allowIncompleteOutput).toBe(true);
    await expect(
      runWorkflowScript(new QuickJSSyncGeneratorRuntime(), {
        source:
          'yield ctx.run({ id: "a", agentName: "agent", input: "go", allowIncompleteOutput: "yes" }); return "done";',
        host: {
          async run() {
            throw new Error("no");
          },
          async parallel() {
            return [];
          },
          emit() {},
        },
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_SCRIPT_INVALID" });
  });

  sandboxTest(
    "a cut step without the opt-out fails the script run",
    async () => {
      const { agent } = llmAgent("writer", [CUT]);
      const script = new ScriptWorkflowAgent({
        name: "script_wf",
        definition: defineScriptWorkflow({
          id: "script-trunc",
          version: "1",
          source:
            'yield ctx.run({ id: "a", agentName: "writer", input: "go" }); return "done";',
        }),
        subAgents: [agent],
        runtime: new QuickJSSyncGeneratorRuntime(),
      });
      const result = await drain(script);
      expect(result.error?.code).toBe("WORKFLOW_STEP_INCOMPLETE");
    },
  );
});
