import { describe, expect, test } from "bun:test";
import {
  BaseAgent,
  createEvent,
  type Event,
  InvocationContext,
  PluginManager,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
} from "@google/adk";
import type { Content } from "@google/genai";
import {
  createWorkflowCheckpoint,
  resolveWorkflowStep,
  validateWorkflowCheckpoint,
  withWorkflowStepFailed,
  withWorkflowStepRunning,
} from "../../src/workflows/checkpoint/checkpoint.js";
import { hashWorkflowInput } from "../../src/workflows/checkpoint/hash.js";
import type { WorkflowCheckpointV1 } from "../../src/workflows/checkpoint/schema.js";
import type {
  SaveWorkflowCheckpointInput,
  WorkflowCheckpointStore,
} from "../../src/workflows/checkpoint/store.js";
import type {
  WorkflowStep,
  WorkflowStepFailure,
} from "../../src/workflows/contracts.js";
import { WorkflowError } from "../../src/workflows/contracts.js";
import { defineWorkflow } from "../../src/workflows/definition.js";
import type {
  WorkflowEvent,
  WorkflowStepFailedEvent,
} from "../../src/workflows/events.js";
import { WorkflowAgent } from "../../src/workflows/workflow-agent.js";

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

/** Fails its first run with an agent error, then answers with a new text each run. */
class FlakyAgent extends BaseAgent {
  calls = 0;

  constructor(name = "flaky") {
    super({ name });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.calls += 1;
    if (this.calls === 1) {
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        errorCode: "MODEL_NOT_FOUND",
        errorMessage: "model_not_found",
      });
      return;
    }
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: { role: "model", parts: [{ text: `run ${this.calls}` }] },
    });
  }

  protected async *runLiveImpl() {}
}

class DoneAgent extends BaseAgent {
  constructor(name: string) {
    super({ name });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: { role: "model", parts: [{ text: `${this.name} done` }] },
    });
  }

  protected async *runLiveImpl() {}
}

/** Asks for input on its first run and finishes once answered. */
class AskAgent extends BaseAgent {
  constructor() {
    super({ name: "ask" });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    const answered = context.userContent?.parts?.some(
      (part) => part.functionResponse,
    );
    if (answered) {
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        content: { role: "model", parts: [{ text: "verified" }] },
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
              id: "ask-1",
              name: REQUEST_INPUT_FUNCTION_CALL_NAME,
              args: { message: "approve?" },
            },
          },
        ],
      },
      longRunningToolIds: ["ask-1"],
    });
  }

  protected async *runLiveImpl() {}
}

const START: Content = { role: "user", parts: [{ text: "start" }] };
const ANSWER: Content = {
  role: "user",
  parts: [
    {
      functionResponse: {
        id: "ask-1",
        name: REQUEST_INPUT_FUNCTION_CALL_NAME,
        response: { approved: true },
      },
    },
  ],
};

function hitlWorkflow(
  flaky: FlakyAgent,
  store: MemoryStore,
  options: {
    resumePolicy?: WorkflowStep["resumePolicy"];
    retryFailedSteps?: boolean;
  } = {},
) {
  return new WorkflowAgent({
    name: "workflow",
    subAgents: [new DoneAgent("ok"), flaky, new AskAgent()],
    checkpointStore: store,
    resolveExecutionId: () => "run-1",
    retryFailedSteps: options.retryFailedSteps,
    definition: defineWorkflow({
      id: "failure-replay",
      version: "1",
      handler: async (ctx) => {
        const outcomes = await ctx.parallel(
          [
            { id: "ok", agentName: "ok", input: "x" },
            {
              id: "flaky",
              agentName: "flaky",
              input: "x",
              ...(options.resumePolicy
                ? { resumePolicy: options.resumePolicy }
                : {}),
            },
          ],
          { failureMode: "all-settled" },
        );
        const summary = outcomes
          .map((outcome) =>
            outcome.status === "completed"
              ? outcome.output
              : `failed ${outcome.error.code}: ${outcome.error.message}`,
          )
          .join("; ");
        const verified = await ctx.run({
          id: "verify",
          agentName: "ask",
          input: summary,
        });
        return `${summary} -> ${verified.output}`;
      },
    }),
  });
}

function turn(agent: BaseAgent, userContent: Content, invocationId: string) {
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
  let error: (Error & { code?: string; details?: unknown }) | undefined;
  try {
    for await (const event of agent.runAsync(context)) events.push(event);
  } catch (caught) {
    error = caught as typeof error;
  }
  return { events, error };
}

const workflowEvents = (events: readonly Event[]) =>
  events
    .map((event) => event.customMetadata?.workflowEvent as WorkflowEvent)
    .filter(Boolean);

const failedEvents = (events: readonly Event[]) =>
  workflowEvents(events).filter(
    (event): event is WorkflowStepFailedEvent => event.type === "step_failed",
  );

describe("recorded step failures on a HITL answer turn", () => {
  for (const variant of [
    { name: "resumePolicy retry", options: { resumePolicy: "retry" as const } },
    { name: "the default resumePolicy", options: {} },
    {
      name: "retryFailedSteps",
      options: { retryFailedSteps: true, resumePolicy: "retry" as const },
    },
  ]) {
    test(`replay the recorded failure instead of re-running the step (${variant.name})`, async () => {
      const flaky = new FlakyAgent();
      const store = new MemoryStore();
      const workflow = hitlWorkflow(flaky, store, variant.options);

      const first = await drain(workflow, turn(workflow, START, "inv-1"));
      expect(first.error).toBeUndefined();
      expect(store.checkpoint?.steps.verify?.status).toBe("waiting");
      expect(store.checkpoint?.steps.flaky?.status).toBe("failed");

      const second = await drain(workflow, turn(workflow, ANSWER, "inv-2"));

      expect(second.error).toBeUndefined();
      expect(flaky.calls).toBe(1);
      expect(store.checkpoint?.status).toBe("completed");
      expect(store.checkpoint?.output).toBe(
        "ok done; failed WORKFLOW_EXECUTION_ERROR: Workflow step flaky failed: model_not_found -> verified",
      );
      const [replayed] = failedEvents(second.events);
      expect(replayed?.failure).toMatchObject({
        id: "flaky",
        replayed: true,
        attempts: 1,
        error: {
          code: "WORKFLOW_EXECUTION_ERROR",
          message: "Workflow step flaky failed: model_not_found",
        },
      });
    });
  }
});

describe("recorded step failures on a re-entry that is not an answer", () => {
  function plainWorkflow(
    flaky: FlakyAgent,
    store: MemoryStore,
    step: Partial<WorkflowStep> = {},
    retryFailedSteps?: boolean,
  ) {
    return new WorkflowAgent({
      name: "workflow",
      subAgents: [flaky],
      checkpointStore: store,
      resolveExecutionId: () => "run-1",
      retryFailedSteps,
      definition: defineWorkflow({
        id: "failure-reentry",
        version: "1",
        handler: async (ctx) =>
          (await ctx.run({ id: "s", agentName: "flaky", input: "x", ...step }))
            .output,
      }),
    });
  }

  test("rethrow the recorded error by default, without running the agent", async () => {
    const flaky = new FlakyAgent();
    const store = new MemoryStore();
    const workflow = plainWorkflow(flaky, store);
    const first = await drain(workflow, turn(workflow, START, "inv"));

    const second = await drain(workflow, turn(workflow, START, "inv"));

    expect(flaky.calls).toBe(1);
    expect(second.error?.code).toBe(first.error?.code);
    expect(second.error?.message).toBe(first.error?.message);
    expect(second.error?.details).toEqual(first.error?.details);
    expect(failedEvents(second.events)[0]?.failure.replayed).toBe(true);
  });

  test("re-run the step when it declares resumePolicy retry", async () => {
    const flaky = new FlakyAgent();
    const store = new MemoryStore();
    const workflow = plainWorkflow(flaky, store, { resumePolicy: "retry" });
    await drain(workflow, turn(workflow, START, "inv"));

    const second = await drain(workflow, turn(workflow, START, "inv"));

    expect(second.error).toBeUndefined();
    expect(flaky.calls).toBe(2);
    expect(store.checkpoint?.steps.s?.attempts).toBe(2);
  });

  test("re-run the step when retryFailedSteps is on", async () => {
    const flaky = new FlakyAgent();
    const store = new MemoryStore();
    const workflow = plainWorkflow(flaky, store, {}, true);
    await drain(workflow, turn(workflow, START, "inv"));

    const second = await drain(workflow, turn(workflow, START, "inv"));

    expect(second.error).toBeUndefined();
    expect(flaky.calls).toBe(2);
  });
});

describe("step failure details", () => {
  test("carry the agent's error code and kind", async () => {
    const flaky = new FlakyAgent();
    const store = new MemoryStore();
    const workflow = new WorkflowAgent({
      name: "workflow",
      subAgents: [flaky],
      checkpointStore: store,
      resolveExecutionId: () => "run-1",
      definition: defineWorkflow({
        id: "failure-details",
        version: "1",
        handler: async (ctx) =>
          (await ctx.run({ id: "s", agentName: "flaky", input: "x" })).output,
      }),
    });

    const { events, error } = await drain(workflow, turn(workflow, START, "i"));

    const expected = {
      agentName: "flaky",
      stepId: "s",
      attempt: 1,
      causeCode: "MODEL_NOT_FOUND",
      errorKind: "agent-error",
    };
    expect(error?.details).toEqual(expected);
    expect(failedEvents(events)[0]?.failure.error.details).toEqual(expected);
    expect(store.checkpoint?.steps.s?.error?.details).toEqual(expected);
  });
});

describe("resolveWorkflowStep with a recorded failure", () => {
  const step: WorkflowStep = { id: "s", agentName: "a", input: "x" };

  async function failedCheckpoint(error?: WorkflowStepFailure["error"]) {
    const inputHash = await hashWorkflowInput(step.input);
    let checkpoint = await createWorkflowCheckpoint({
      definition: defineWorkflow({ id: "w", version: "1", handler: () => "" }),
      executionId: "e",
      input: "i",
    });
    checkpoint = withWorkflowStepRunning(checkpoint, step, inputHash, 1, 10);
    checkpoint = withWorkflowStepFailed(
      checkpoint,
      {
        status: "failed",
        id: "s",
        agentName: "a",
        error: error ?? {
          code: "WORKFLOW_EXECUTION_ERROR",
          message: "boom",
          details: { causeCode: "X" },
        },
        attempts: 1,
        startedAt: 10,
        completedAt: 20,
      },
      20,
    );
    return { checkpoint, inputHash };
  }

  test("replays it on an answer turn whatever the retry settings", async () => {
    const { checkpoint, inputHash } = await failedCheckpoint();
    for (const resumePolicy of [undefined, "fail", "retry"] as const) {
      for (const retryFailed of [false, true]) {
        const resolution = resolveWorkflowStep(
          checkpoint,
          { ...step, ...(resumePolicy ? { resumePolicy } : {}) },
          inputHash,
          { retryFailed, answerTurn: true },
        );
        expect(resolution).toEqual({
          action: "replay-failure",
          failure: {
            status: "failed",
            id: "s",
            agentName: "a",
            error: {
              code: "WORKFLOW_EXECUTION_ERROR",
              message: "boom",
              details: { causeCode: "X" },
            },
            attempts: 1,
            startedAt: 10,
            completedAt: 20,
            replayed: true,
          },
        });
      }
    }
  });

  test("replays it on other turns unless a retry was asked for", async () => {
    const { checkpoint, inputHash } = await failedCheckpoint();
    expect(resolveWorkflowStep(checkpoint, step, inputHash).action).toBe(
      "replay-failure",
    );
    expect(
      resolveWorkflowStep(
        checkpoint,
        { ...step, resumePolicy: "retry" },
        inputHash,
      ),
    ).toEqual({
      action: "execute",
      attempt: 2,
      resumeReason: "retry",
    });
    expect(
      resolveWorkflowStep(checkpoint, step, inputHash, { retryFailed: true }),
    ).toEqual({
      action: "execute",
      attempt: 2,
      resumeReason: "retry",
    });
  });

  test("keeps retrying a running step with resumePolicy retry on an answer turn", async () => {
    const inputHash = await hashWorkflowInput(step.input);
    const checkpoint = withWorkflowStepRunning(
      await createWorkflowCheckpoint({
        definition: defineWorkflow({
          id: "w",
          version: "1",
          handler: () => "",
        }),
        executionId: "e",
        input: "i",
      }),
      step,
      inputHash,
      1,
      10,
    );
    expect(
      resolveWorkflowStep(
        checkpoint,
        { ...step, resumePolicy: "retry" },
        inputHash,
        { answerTurn: true },
      ),
    ).toEqual({
      action: "execute",
      attempt: 2,
      resumeReason: "interrupted",
    });
  });

  test("rejects a failed step without a recorded error", async () => {
    const { checkpoint, inputHash } = await failedCheckpoint();
    const saved = checkpoint.steps.s;
    if (saved) delete saved.error;
    expect(() => resolveWorkflowStep(checkpoint, step, inputHash)).toThrow(
      WorkflowError,
    );
    try {
      resolveWorkflowStep(checkpoint, step, inputHash);
    } catch (error) {
      expect((error as WorkflowError).code).toBe("WORKFLOW_EXECUTION_ERROR");
    }
  });
});

describe("checkpoint identity mismatch details", () => {
  test("name the stored value checkpoint and the incoming one current", async () => {
    const definition = defineWorkflow({
      id: "w",
      version: "1",
      handler: () => "",
    });
    const stored = await createWorkflowCheckpoint({
      definition,
      executionId: "e",
      input: "original",
    });
    const incoming = await createWorkflowCheckpoint({
      definition: { ...definition, version: "2" },
      executionId: "e",
      input: "answer",
    });
    const expectation = {
      workflowId: incoming.workflowId,
      executionId: incoming.executionId,
      workflowVersion: incoming.workflowVersion,
      inputHash: incoming.inputHash,
      sourceHash: incoming.sourceHash,
    };

    expect(() =>
      validateWorkflowCheckpoint(stored, {
        ...expectation,
        workflowVersion: stored.workflowVersion,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "WORKFLOW_INPUT_MISMATCH",
        details: { checkpoint: stored.inputHash, current: incoming.inputHash },
      }),
    );
    expect(() => validateWorkflowCheckpoint(stored, expectation)).toThrow(
      expect.objectContaining({
        code: "WORKFLOW_VERSION_MISMATCH",
        details: { checkpoint: "1", current: "2" },
      }),
    );
  });
});
