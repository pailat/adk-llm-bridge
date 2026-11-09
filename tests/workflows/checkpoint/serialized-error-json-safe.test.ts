import { describe, expect, test } from "bun:test";
import {
  BaseAgent,
  createEvent,
  type Event,
  InvocationContext,
  PluginManager,
} from "@google/adk";
import {
  createWorkflowCheckpoint,
  resolveWorkflowStep,
  withWorkflowFailed,
  withWorkflowStepFailed,
  withWorkflowStepRunning,
} from "../../../src/workflows/checkpoint/checkpoint.js";
import { hashWorkflowInput } from "../../../src/workflows/checkpoint/hash.js";
import {
  isWorkflowCheckpointV1,
  toDurableWorkflowCheckpoint,
  type WorkflowCheckpointV1,
} from "../../../src/workflows/checkpoint/schema.js";
import { workflowCheckpointKey } from "../../../src/workflows/checkpoint/store.js";
import {
  WorkflowError,
  type WorkflowSerializedError,
} from "../../../src/workflows/contracts.js";
import { defineWorkflow } from "../../../src/workflows/definition.js";
import { WorkflowAgent } from "../../../src/workflows/workflow-agent.js";

const definition = defineWorkflow({
  id: "json-safe-errors",
  version: "1",
  handler: async (ctx) =>
    (await ctx.run({ id: "review", agentName: "worker", input: "changed" }))
      .output,
});

/** A legacy step: no `agentRevision`, as in checkpoints written before revisions existed. */
const savedStep = { id: "review", agentName: "worker", input: "original" };

async function checkpointWithSavedStep(): Promise<WorkflowCheckpointV1> {
  const checkpoint = await createWorkflowCheckpoint({
    definition,
    executionId: "inv-json-safe",
    input: { role: "user", parts: [{ text: "go" }] },
    now: 1,
  });
  return withWorkflowStepRunning(
    checkpoint,
    savedStep,
    await hashWorkflowInput(savedStep.input),
    1,
    2,
  );
}

function mismatchError(checkpoint: WorkflowCheckpointV1): WorkflowError {
  try {
    resolveWorkflowStep(checkpoint, savedStep, "sha256:different");
  } catch (error) {
    if (error instanceof WorkflowError) return error;
    throw error;
  }
  throw new Error("expected a step mismatch");
}

function executionError(
  details: Record<string, unknown>,
): WorkflowSerializedError {
  return {
    code: "WORKFLOW_EXECUTION_ERROR",
    message: "original failure",
    details,
  };
}

function undefinedKeys(value: unknown, path = ""): string[] {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) =>
    item === undefined
      ? [`${path}${key}`]
      : undefinedKeys(item, `${path}${key}.`),
  );
}

describe("serialized workflow errors are always JSON-safe", () => {
  test("a step mismatch on a step without agentRevision serializes without undefined details", async () => {
    const error = mismatchError(await checkpointWithSavedStep());
    const serialized = error.toJSON();

    expect(serialized.code).toBe("WORKFLOW_STEP_MISMATCH");
    expect(serialized.message).toBe(
      "Checkpoint step does not match current step: review",
    );
    expect(undefinedKeys(serialized)).toEqual([]);
    expect(serialized.details).toMatchObject({
      stepId: "review",
      savedAgentName: "worker",
      agentName: "worker",
      inputHash: "sha256:different",
    });
    expect(serialized.details).not.toHaveProperty("savedAgentRevision");
    expect(serialized.details).not.toHaveProperty("agentRevision");
    expect(serialized).toEqual(JSON.parse(JSON.stringify(serialized)));
  });

  test("withWorkflowFailed records a step mismatch as a valid checkpoint", async () => {
    const checkpoint = await checkpointWithSavedStep();
    const error = mismatchError(checkpoint);

    for (const status of ["failed", "cancelled"] as const) {
      const failed = withWorkflowFailed(checkpoint, error.toJSON(), status, 3);
      expect(isWorkflowCheckpointV1(failed)).toBe(true);
      expect(failed.error).toMatchObject({
        code: "WORKFLOW_STEP_MISMATCH",
        message: "Checkpoint step does not match current step: review",
      });
      expect(() => toDurableWorkflowCheckpoint(failed)).not.toThrow();
    }
  });

  test("withWorkflowFailed and withWorkflowStepFailed normalize details that are not JSON-safe", async () => {
    const checkpoint = await checkpointWithSavedStep();
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    const details = {
      kept: "yes",
      missing: undefined,
      nested: { inner: undefined, value: 1, list: [1, undefined, Number.NaN] },
      big: 12345678901234567890n,
      when: new Date(0),
      cause: new Error("hidden"),
      callback: () => "x",
      cyclic,
      throwing: Object.defineProperty({}, "boom", {
        enumerable: true,
        get() {
          throw new Error("getter");
        },
      }),
    };
    const error = {
      code: "WORKFLOW_EXECUTION_ERROR",
      message: "original failure",
      details,
    } as WorkflowSerializedError;

    const failed = withWorkflowFailed(checkpoint, error, "failed", 3);
    expect(isWorkflowCheckpointV1(failed)).toBe(true);
    expect(failed.error).toEqual({
      code: "WORKFLOW_EXECUTION_ERROR",
      message: "original failure",
      details: {
        kept: "yes",
        nested: { value: 1, list: [1, null, null] },
        big: "12345678901234567890",
        when: "1970-01-01T00:00:00.000Z",
        cause: {},
        cyclic: { name: "loop" },
        throwing: {},
      },
    });

    const stepFailed = withWorkflowStepFailed(
      checkpoint,
      {
        status: "failed",
        id: "review",
        agentName: "worker",
        attempts: 1,
        startedAt: 2,
        completedAt: 3,
        error,
      },
      3,
    );
    expect(isWorkflowCheckpointV1(stepFailed)).toBe(true);
    expect(stepFailed.steps.review?.error).toEqual(failed.error);
  });

  test("a value referenced twice without a cycle is recorded at both places", async () => {
    const checkpoint = await checkpointWithSavedStep();
    const shared = { value: 1 };
    const failed = withWorkflowFailed(
      checkpoint,
      executionError({ a: shared, b: shared, list: [shared, shared] }),
      "failed",
      3,
    );

    expect(isWorkflowCheckpointV1(failed)).toBe(true);
    expect(failed.error?.details).toEqual({
      a: { value: 1 },
      b: { value: 1 },
      list: [{ value: 1 }, { value: 1 }],
    });
  });

  test("a __proto__ key from parsed JSON is kept as an own key and leaves the prototype alone", async () => {
    const checkpoint = await checkpointWithSavedStep();
    const parsed: unknown = JSON.parse('{"__proto__":{"x":1},"k":1}');
    const failed = withWorkflowFailed(
      checkpoint,
      executionError(parsed as Record<string, unknown>),
      "failed",
      3,
    );

    expect(isWorkflowCheckpointV1(failed)).toBe(true);
    const details = failed.error?.details;
    expect(details).toBeDefined();
    expect(Object.getPrototypeOf(details)).toBe(Object.prototype);
    expect(Object.keys(details ?? {})).toEqual(["__proto__", "k"]);
    expect(
      Object.getOwnPropertyDescriptor(details, "__proto__")?.value,
    ).toEqual({ x: 1 });
    expect((details as { x?: unknown }).x).toBeUndefined();
    expect(() => toDurableWorkflowCheckpoint(failed)).not.toThrow();
  });

  test("a throwing toJSON or a revoked Proxy drops only that value and recording does not throw", async () => {
    const checkpoint = await checkpointWithSavedStep();
    const revocable = Proxy.revocable({ hidden: true }, {});
    revocable.revoke();
    const details = {
      kept: "yes",
      badJson: {
        toJSON() {
          throw new Error("toJSON");
        },
      },
      revoked: revocable.proxy,
      list: [1, revocable.proxy],
    };

    let failed: WorkflowCheckpointV1 | undefined;
    expect(() => {
      failed = withWorkflowFailed(
        checkpoint,
        executionError(details),
        "failed",
        3,
      );
    }).not.toThrow();
    expect(failed && isWorkflowCheckpointV1(failed)).toBe(true);
    expect(failed?.error).toEqual({
      code: "WORKFLOW_EXECUTION_ERROR",
      message: "original failure",
      details: { kept: "yes", list: [1, null] },
    });
  });

  test("details nested deeper than 32 levels are cut at 32 levels", async () => {
    const checkpoint = await checkpointWithSavedStep();
    type Link = { level: number; next?: Link };
    let chain: Link = { level: 39 };
    for (let level = 38; level >= 0; level--) chain = { level, next: chain };

    const failed = withWorkflowFailed(
      checkpoint,
      executionError(chain),
      "failed",
      3,
    );

    expect(isWorkflowCheckpointV1(failed)).toBe(true);
    const levels: number[] = [];
    let node = failed.error?.details as Link | undefined;
    while (node) {
      levels.push(node.level);
      node = node.next;
    }
    expect(levels).toEqual(Array.from({ length: 32 }, (_, index) => index));
  });

  test("an empty message or a details value that is not an object keeps the error recordable", async () => {
    const checkpoint = await checkpointWithSavedStep();
    const failed = withWorkflowFailed(
      checkpoint,
      {
        code: "WORKFLOW_ABORTED",
        message: "  ",
        details: "not a record",
      } as unknown as WorkflowSerializedError,
      "cancelled",
      3,
    );

    expect(isWorkflowCheckpointV1(failed)).toBe(true);
    expect(failed.error).toEqual({
      code: "WORKFLOW_ABORTED",
      message: "Workflow error WORKFLOW_ABORTED",
    });
  });

  test("a resumed run whose step input changed fails with WORKFLOW_STEP_MISMATCH and records it", async () => {
    const key = workflowCheckpointKey("json-safe-errors", "inv-json-safe");
    const workflow = new WorkflowAgent({
      name: "workflow",
      definition,
      subAgents: [new WorkerAgent("worker")],
    });
    const state: Record<string, unknown> = {
      [key]: await checkpointWithSavedStep(),
    };

    const events: Event[] = [];
    let caught: unknown;
    try {
      for await (const event of workflow.runAsync(invocation(workflow, state)))
        events.push(event);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(WorkflowError);
    expect(caught).toMatchObject({
      code: "WORKFLOW_STEP_MISMATCH",
      message: "Checkpoint step does not match current step: review",
    });
    const saved = events
      .map((event) => event.actions?.stateDelta?.[key])
      .filter((value): value is WorkflowCheckpointV1 => value !== undefined)
      .at(-1);
    expect(saved?.status).toBe("failed");
    expect(saved?.error?.code).toBe("WORKFLOW_STEP_MISMATCH");
  });

  test("a handler error with an empty message is recorded instead of failing the checkpoint write", async () => {
    const workflow = new WorkflowAgent({
      name: "workflow",
      definition: defineWorkflow({
        id: "empty-message",
        version: "1",
        handler: () => {
          throw new Error("");
        },
      }),
    });
    const key = workflowCheckpointKey("empty-message", "inv-json-safe");

    const events: Event[] = [];
    let caught: unknown;
    try {
      for await (const event of workflow.runAsync(invocation(workflow, {})))
        events.push(event);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "WORKFLOW_EXECUTION_ERROR" });
    expect((caught as Error).message).not.toContain(
      "invalid workflow checkpoint",
    );
    const saved = events
      .map((event) => event.actions?.stateDelta?.[key])
      .filter((value): value is WorkflowCheckpointV1 => value !== undefined)
      .at(-1);
    expect(saved?.status).toBe("failed");
    expect(saved?.error).toEqual({
      code: "WORKFLOW_EXECUTION_ERROR",
      message: "Workflow error WORKFLOW_EXECUTION_ERROR",
    });
  });
});

class WorkerAgent extends BaseAgent {
  constructor(name: string) {
    super({ name });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: { role: "model", parts: [{ text: "done" }] },
    });
  }

  protected async *runLiveImpl() {}
}

function invocation(
  agent: BaseAgent,
  state: Record<string, unknown>,
): InvocationContext {
  return new InvocationContext({
    pluginManager: new PluginManager(),
    invocationId: "inv-json-safe",
    branch: "root",
    agent,
    userContent: { role: "user", parts: [{ text: "go" }] },
    session: {
      id: "session-1",
      appName: "app",
      userId: "user",
      state,
      events: [],
      lastUpdateTime: 1,
    },
  });
}
