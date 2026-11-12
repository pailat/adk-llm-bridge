import { describe, expect, test } from "bun:test";
import {
  checkpointExpectation,
  createWorkflowCheckpoint,
  resolveWorkflowStep,
  validateWorkflowCheckpoint,
  withWorkflowCompleted,
  withWorkflowStepCompleted,
  withWorkflowStepFailed,
  withWorkflowStepRunning,
  withWorkflowStepWaiting,
} from "../../src/workflows/checkpoint/checkpoint.js";
import {
  hashWorkflowInput,
  hashWorkflowSource,
  stableSerializeWorkflowValue,
} from "../../src/workflows/checkpoint/hash.js";
import {
  isWorkflowCheckpointV1,
  toDurableWorkflowCheckpoint,
  type WorkflowCheckpointV1,
} from "../../src/workflows/checkpoint/schema.js";
import type {
  WorkflowErrorCode,
  WorkflowStep,
  WorkflowStepFailure,
  WorkflowStepResult,
} from "../../src/workflows/contracts.js";
import { WorkflowError } from "../../src/workflows/contracts.js";
import { defineScriptWorkflow } from "../../src/workflows/definition.js";
import { fromPartial } from "../helpers/partial.js";

const definition = defineScriptWorkflow({
  id: "implementation",
  version: "1",
  source: 'yield { type: "run", step: ctx.input };',
});

const step: WorkflowStep = {
  id: "plan",
  agentName: "planner",
  input: "make a plan",
};

describe("workflow checkpoints", () => {
  test("hashes semantically identical JSON values deterministically", async () => {
    expect(stableSerializeWorkflowValue({ b: 2, a: { d: 4, c: 3 } })).toBe(
      '{"a":{"c":3,"d":4},"b":2}',
    );
    expect(await hashWorkflowInput({ b: 2, a: 1 })).toBe(
      await hashWorkflowInput({ a: 1, b: 2 }),
    );
    expect(await hashWorkflowSource("return 1")).not.toBe(
      await hashWorkflowSource("return 2"),
    );
  });

  test("creates a v1 checkpoint with input and script source hashes", async () => {
    const checkpoint = await createWorkflowCheckpoint({
      definition,
      executionId: "inv-1",
      input: { role: "user", parts: [{ text: "build it" }] },
      now: 10,
    });

    expect(checkpoint).toMatchObject({
      schemaVersion: 1,
      workflowId: "implementation",
      workflowVersion: "1",
      executionId: "inv-1",
      status: "running",
      steps: {},
      startedAt: 10,
      updatedAt: 10,
      inputHash: expect.stringMatching(/^sha256:/),
      sourceHash: expect.stringMatching(/^sha256:/),
    });
  });

  test("rejects incompatible workflow, input, and source resumes", async () => {
    const checkpoint = await createWorkflowCheckpoint({
      definition,
      executionId: "inv-1",
      input: "original",
    });
    const expected = checkpointExpectation(checkpoint);

    expect(() =>
      validateWorkflowCheckpoint(checkpoint, expected),
    ).not.toThrow();
    expectWorkflowCode(
      () =>
        validateWorkflowCheckpoint(checkpoint, {
          ...expected,
          workflowVersion: "2",
        }),
      "WORKFLOW_VERSION_MISMATCH",
    );
    expectWorkflowCode(
      () =>
        validateWorkflowCheckpoint(checkpoint, {
          ...expected,
          inputHash: "sha256:changed",
        }),
      "WORKFLOW_INPUT_MISMATCH",
    );
    expectWorkflowCode(
      () =>
        validateWorkflowCheckpoint(checkpoint, {
          ...expected,
          sourceHash: "sha256:changed",
        }),
      "WORKFLOW_SOURCE_MISMATCH",
    );
  });

  test("replays completed steps and rejects mismatched step reuse", async () => {
    const inputHash = await hashWorkflowInput(step.input);
    let checkpoint = await createWorkflowCheckpoint({
      definition,
      executionId: "inv-1",
      input: "workflow input",
    });
    checkpoint = withWorkflowStepRunning(checkpoint, step, inputHash, 1, 10);
    const result = completedResult();
    checkpoint = withWorkflowStepCompleted(checkpoint, result, 20);

    expect(resolveWorkflowStep(checkpoint, step, inputHash)).toEqual({
      action: "replay",
      result: { ...result, replayed: true },
    });
    expectWorkflowCode(
      () => resolveWorkflowStep(checkpoint, step, "sha256:different"),
      "WORKFLOW_STEP_MISMATCH",
    );
    expect(checkpoint.steps.plan.result).not.toHaveProperty("replayed");
  });

  test("binds checkpoint replay to the agent revision while keeping legacy compatibility", async () => {
    const inputHash = await hashWorkflowInput(step.input);
    const original = await createWorkflowCheckpoint({
      definition,
      executionId: "inv-revision",
      input: "workflow input",
    });
    const versionedStep = { ...step, agentRevision: "sha256:agent-v1" };
    const versioned = withWorkflowStepRunning(
      original,
      versionedStep,
      inputHash,
      1,
      10,
    );

    expect(versioned.steps.plan.agentRevision).toBe("sha256:agent-v1");
    expectWorkflowCode(
      () =>
        resolveWorkflowStep(
          versioned,
          { ...versionedStep, agentRevision: "sha256:agent-v2" },
          inputHash,
        ),
      "WORKFLOW_STEP_MISMATCH",
    );
    expectWorkflowCode(
      () => resolveWorkflowStep(versioned, step, inputHash),
      "WORKFLOW_STEP_MISMATCH",
    );

    const legacy = withWorkflowStepRunning(original, step, inputHash, 1, 10);
    expect(
      resolveWorkflowStep(
        legacy,
        { ...step, resumePolicy: "retry" },
        inputHash,
      ),
    ).toEqual({
      action: "execute",
      attempt: 2,
      resumeReason: "interrupted",
    });
  });

  test("treats a running step as indeterminate unless retry is explicit", async () => {
    const inputHash = await hashWorkflowInput(step.input);
    let checkpoint = await createWorkflowCheckpoint({
      definition,
      executionId: "inv-1",
      input: "workflow input",
    });
    checkpoint = withWorkflowStepRunning(checkpoint, step, inputHash, 1, 10);

    expectWorkflowCode(
      () => resolveWorkflowStep(checkpoint, step, inputHash),
      "WORKFLOW_INDETERMINATE_STEP",
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
      resumeReason: "interrupted",
    });
  });

  test("records failed steps and terminal workflow output immutably", async () => {
    const inputHash = await hashWorkflowInput(step.input);
    const original = await createWorkflowCheckpoint({
      definition,
      executionId: "inv-1",
      input: "workflow input",
    });
    const running = withWorkflowStepRunning(original, step, inputHash, 1, 10);
    const failure: WorkflowStepFailure = {
      status: "failed",
      id: step.id,
      agentName: step.agentName,
      error: { code: "WORKFLOW_EXECUTION_ERROR", message: "agent failed" },
      attempts: 1,
      startedAt: 10,
      completedAt: 20,
    };
    const failed = withWorkflowStepFailed(running, failure, 20);
    const completed = withWorkflowCompleted(running, "done", 30);

    expect(original.steps).toEqual({});
    expect(failed.steps.plan).toMatchObject({
      status: "failed",
      error: failure.error,
      completedAt: 20,
    });
    expect(completed).toMatchObject({
      status: "completed",
      output: "done",
      completedAt: 30,
    });
  });

  test("keeps runtime events live but omits them from durable step results", async () => {
    const inputHash = await hashWorkflowInput(step.input);
    let checkpoint = await createWorkflowCheckpoint({
      definition,
      executionId: "inv-events",
      input: "workflow input",
    });
    checkpoint = withWorkflowStepRunning(checkpoint, step, inputHash, 1, 10);
    const result: WorkflowStepResult = {
      ...completedResult(),
      events: fromPartial<WorkflowStepResult["events"]>([
        { id: "runtime-only" },
      ]),
      replayed: true,
    };

    const completed = withWorkflowStepCompleted(checkpoint, result, 20);

    expect(result.events).toHaveLength(1);
    expect(completed.steps.plan.result).not.toHaveProperty("events");
    expect(completed.steps.plan.result).not.toHaveProperty("replayed");
  });

  test("accepts legacy v1 events and compacts them without mutation", async () => {
    const legacy = await completedCheckpoint();
    const legacyResult = legacy.steps.plan?.result;
    if (!legacyResult) throw new Error("missing completed result");
    legacyResult.events = fromPartial<WorkflowStepResult["events"]>([
      { id: "legacy-runtime-event" },
    ]);
    legacyResult.replayed = false;

    expect(isWorkflowCheckpointV1(legacy)).toBe(true);
    const durable = toDurableWorkflowCheckpoint(legacy);
    expect(durable).not.toBe(legacy);
    expect(durable.steps.plan?.result).not.toHaveProperty("events");
    expect(durable.steps.plan?.result).not.toHaveProperty("replayed");
    expect(legacy.steps.plan?.result?.events).toHaveLength(1);
  });

  test("rejects malformed nested durable values and inconsistent states", async () => {
    const valid = await completedCheckpoint();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const inherited = Object.create({ hidden: true }) as Record<
      string,
      unknown
    >;
    inherited.visible = true;
    const sparse: unknown[] = [];
    sparse.length = 1;
    const withUndefined = [undefined];
    const accessorResult = { ...requiredResult(valid) };
    Object.defineProperty(accessorResult, "events", {
      enumerable: true,
      get: () => [],
    });

    const invalid: WorkflowCheckpointV1[] = [
      {
        ...valid,
        steps: {
          ...valid.steps,
          plan: {
            ...requiredPlan(valid),
            result: {
              ...requiredResult(valid),
              stateDelta: { value: Number.POSITIVE_INFINITY },
            },
          },
        },
      },
      {
        ...valid,
        steps: {
          ...valid.steps,
          plan: {
            ...requiredPlan(valid),
            result: {
              ...requiredResult(valid),
              stateDelta: { sparse },
            },
          },
        },
      },
      {
        ...valid,
        // @ts-expect-error An undefined part checks that validation rejects it.
        output: { role: "model", parts: withUndefined },
      },
      {
        ...valid,
        steps: {
          ...valid.steps,
          plan: {
            ...requiredPlan(valid),
            result: accessorResult,
          },
        },
      },
      { ...valid, output: { role: "model", parts: [cyclic] } },
      {
        ...valid,
        steps: {
          ...valid.steps,
          plan: {
            ...requiredPlan(valid),
            // @ts-expect-error An inherited field checks that validation rejects it.
            result: inherited,
          },
        },
      },
      {
        ...valid,
        steps: {
          ...valid.steps,
          plan: {
            ...requiredPlan(valid),
            attempts: 2,
          },
        },
      },
      {
        ...valid,
        steps: {
          ...valid.steps,
          plan: {
            ...requiredPlan(valid),
            status: "failed",
            result: undefined,
            error: undefined,
          },
        },
      },
      { ...valid, status: "running", completedAt: valid.completedAt },
    ];

    for (const checkpoint of invalid) {
      expect(isWorkflowCheckpointV1(checkpoint)).toBe(false);
    }
  });

  test("rejects stored interrupt events whose resume fields are malformed", async () => {
    const inputHash = await hashWorkflowInput(step.input);
    const running = withWorkflowStepRunning(
      await createWorkflowCheckpoint({
        definition,
        executionId: "inv-interrupt",
        input: "workflow input",
        now: 10,
      }),
      step,
      inputHash,
      1,
      10,
    );
    const waitingWith = (event: Record<string, unknown>) =>
      withWorkflowStepWaiting(
        running,
        step,
        inputHash,
        1,
        {
          kind: "input",
          functionCallIds: ["call-1"],
          requests: [{ functionCallId: "call-1" }],
          events: [event],
        },
        { role: "user", parts: [{ text: "workflow input" }] },
        20,
      );
    const valid = {
      author: "worker",
      branch: "root.worker",
      longRunningToolIds: ["call-1"],
      content: {
        role: "model",
        parts: [{ functionCall: { id: "call-1", name: "adk_request_input" } }],
      },
    };
    expect(isWorkflowCheckpointV1(waitingWith(valid))).toBe(true);
    expect(isWorkflowCheckpointV1(waitingWith({ author: "worker" }))).toBe(
      true,
    );

    const malformed: Record<string, unknown>[] = [
      { ...valid, content: { parts: 5 } },
      { ...valid, content: "text" },
      { ...valid, content: { parts: ["text"] } },
      { ...valid, content: { parts: [{ functionCall: "call" }] } },
      { ...valid, content: { role: 1, parts: [] } },
      { ...valid, author: 1 },
      { ...valid, branch: ["root"] },
      { ...valid, longRunningToolIds: "call-1" },
      { ...valid, longRunningToolIds: [1] },
    ];
    for (const event of malformed) {
      expect(isWorkflowCheckpointV1(waitingWith(event))).toBe(false);
    }
  });

  test("rejects stored interrupt events whose actions or state delta are not objects", async () => {
    const inputHash = await hashWorkflowInput(step.input);
    const running = withWorkflowStepRunning(
      await createWorkflowCheckpoint({
        definition,
        executionId: "inv-interrupt-actions",
        input: "workflow input",
        now: 10,
      }),
      step,
      inputHash,
      1,
      10,
    );
    const waitingWith = (event: Record<string, unknown>) =>
      withWorkflowStepWaiting(
        running,
        step,
        inputHash,
        1,
        {
          kind: "input",
          functionCallIds: ["call-1"],
          requests: [{ functionCallId: "call-1" }],
          events: [event],
        },
        { role: "user", parts: [{ text: "workflow input" }] },
        20,
      );
    const event = { author: "worker" };
    expect(
      isWorkflowCheckpointV1(
        waitingWith({ ...event, actions: { stateDelta: { count: 1 } } }),
      ),
    ).toBe(true);
    expect(isWorkflowCheckpointV1(waitingWith({ ...event, actions: {} }))).toBe(
      true,
    );

    for (const actions of [
      "actions",
      ["stateDelta"],
      { stateDelta: "abc" },
      { stateDelta: ["a", "b"] },
      { stateDelta: null },
    ]) {
      expect(isWorkflowCheckpointV1(waitingWith({ ...event, actions }))).toBe(
        false,
      );
    }
  });

  test("accepts a failed step carrying any workflow error code", async () => {
    const codes: Record<WorkflowErrorCode, true> = {
      WORKFLOW_ABORTED: true,
      WORKFLOW_ATTEMPT_MISMATCH: true,
      WORKFLOW_DEFINITION_INVALID: true,
      WORKFLOW_DEFINITION_NOT_FOUND: true,
      WORKFLOW_EXECUTION_ERROR: true,
      WORKFLOW_INDETERMINATE_STEP: true,
      WORKFLOW_INPUT_MISMATCH: true,
      WORKFLOW_LIMIT_EXCEEDED: true,
      WORKFLOW_REPLAY_ACCEPTANCE_INVALID: true,
      WORKFLOW_SANDBOX_UNAVAILABLE: true,
      WORKFLOW_SCRIPT_INVALID: true,
      WORKFLOW_SOURCE_MISMATCH: true,
      WORKFLOW_STEP_INCOMPLETE: true,
      WORKFLOW_STEP_INTERRUPTED: true,
      WORKFLOW_STEP_MISMATCH: true,
      WORKFLOW_UNKNOWN_AGENT: true,
      WORKFLOW_VERSION_MISMATCH: true,
      WORKFLOW_WORKSPACE_LEASE_LOST: true,
      WORKFLOW_WORKSPACE_STATE_INCOMPATIBLE: true,
    };
    const inputHash = await hashWorkflowInput(step.input);
    const running = withWorkflowStepRunning(
      await createWorkflowCheckpoint({
        definition,
        executionId: "inv-codes",
        input: "workflow input",
        now: 10,
      }),
      step,
      inputHash,
      1,
      10,
    );
    const failedWith = (code: string) =>
      withWorkflowStepFailed(
        running,
        {
          status: "failed",
          id: step.id,
          agentName: step.agentName,
          error: { code: code as WorkflowErrorCode, message: "failed" },
          attempts: 1,
          startedAt: 10,
          completedAt: 20,
        },
        20,
      );

    for (const code of Object.keys(codes)) {
      expect(isWorkflowCheckpointV1(failedWith(code))).toBe(true);
    }
    expect(isWorkflowCheckpointV1(failedWith("WORKFLOW_NOT_A_CODE"))).toBe(
      false,
    );
  });
});

describe("stored step usage", () => {
  const usage = {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    cachedTokens: 4,
    toolCalls: 2,
    llmCalls: 1,
  };

  async function withUsage(value: unknown): Promise<unknown> {
    const copy = structuredClone(await completedCheckpoint()) as unknown as {
      steps: Record<string, { result: Record<string, unknown> }>;
    };
    const saved = copy.steps.plan;
    if (!saved) throw new Error("missing plan step");
    saved.result.usage = value;
    return copy;
  }

  test("a result with valid usage, or without usage as before usage existed, loads", async () => {
    expect(isWorkflowCheckpointV1(await withUsage(usage))).toBe(true);
    expect(
      isWorkflowCheckpointV1(await withUsage({ ...usage, promptTokens: 0 })),
    ).toBe(true);
    expect(isWorkflowCheckpointV1(await completedCheckpoint())).toBe(true);
    expect(requiredResult(await completedCheckpoint()).usage).toBeUndefined();
  });

  test("cacheCreationTokens is optional: an old usage loads, a valid one loads", async () => {
    // `usage` is the pre-cacheCreationTokens shape.
    expect("cacheCreationTokens" in usage).toBe(false);
    expect(isWorkflowCheckpointV1(await withUsage(usage))).toBe(true);
    expect(
      isWorkflowCheckpointV1(
        await withUsage({ ...usage, cacheCreationTokens: 0 }),
      ),
    ).toBe(true);
    expect(
      isWorkflowCheckpointV1(
        await withUsage({ ...usage, cacheCreationTokens: 1200 }),
      ),
    ).toBe(true);
  });

  test("a bad cacheCreationTokens is rejected as corrupt", async () => {
    for (const bad of [
      "10",
      -1,
      null,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      {},
    ]) {
      expect(
        isWorkflowCheckpointV1(
          await withUsage({ ...usage, cacheCreationTokens: bad }),
        ),
      ).toBe(false);
    }
  });

  test("costUsd is optional: old usage loads, 0 and a real cost load, a bad one is corrupt", async () => {
    for (const ok of [0, 0.0042, 15.63]) {
      expect(
        isWorkflowCheckpointV1(await withUsage({ ...usage, costUsd: ok })),
      ).toBe(true);
    }
    for (const bad of [
      "1",
      -0.01,
      null,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      {},
    ]) {
      expect(
        isWorkflowCheckpointV1(await withUsage({ ...usage, costUsd: bad })),
      ).toBe(false);
    }
  });

  test("a result whose usage is malformed is rejected as corrupt", async () => {
    const corrupt: Record<string, unknown> = {
      null: null,
      "a number": 15,
      "an array": [usage],
      "an empty record": {},
    };
    for (const field of Object.keys(usage)) {
      const missing: Record<string, unknown> = { ...usage };
      delete missing[field];
      corrupt[`no ${field}`] = missing;
      corrupt[`a negative ${field}`] = { ...usage, [field]: -1 };
      corrupt[`a string ${field}`] = { ...usage, [field]: "10" };
      corrupt[`a null ${field}`] = { ...usage, [field]: null };
      corrupt[`an infinite ${field}`] = {
        ...usage,
        [field]: Number.POSITIVE_INFINITY,
      };
      corrupt[`a NaN ${field}`] = { ...usage, [field]: Number.NaN };
    }
    for (const [name, value] of Object.entries(corrupt)) {
      expect({
        name,
        valid: isWorkflowCheckpointV1(await withUsage(value)),
      }).toEqual({ name, valid: false });
    }
  });
});

describe("interrupted steps", () => {
  async function interruptedCheckpoint(
    code: WorkflowErrorCode = "WORKFLOW_ABORTED",
  ): Promise<WorkflowCheckpointV1> {
    const inputHash = await hashWorkflowInput(step.input);
    const running = withWorkflowStepRunning(
      await createWorkflowCheckpoint({
        definition,
        executionId: "inv-interrupted",
        input: "workflow input",
        now: 10,
      }),
      step,
      inputHash,
      1,
      10,
    );
    return withWorkflowStepFailed(
      running,
      {
        status: "failed",
        id: step.id,
        agentName: step.agentName,
        error: { code, message: "Workflow execution aborted" },
        attempts: 1,
        startedAt: 10,
        completedAt: 20,
      },
      20,
    );
  }

  function withPlan(
    checkpoint: WorkflowCheckpointV1,
    change: (saved: Record<string, unknown>) => void,
  ): unknown {
    const copy = structuredClone(checkpoint) as unknown as {
      steps: Record<string, Record<string, unknown>>;
    };
    const saved = copy.steps.plan;
    if (!saved) throw new Error("missing plan step");
    change(saved);
    return copy;
  }

  test("an aborted step is stored as interrupted and an ordinary failure as failed", async () => {
    const aborted = await interruptedCheckpoint();
    expect(requiredPlan(aborted).status).toBe("interrupted");
    expect(requiredPlan(aborted).error?.code).toBe("WORKFLOW_ABORTED");
    expect(isWorkflowCheckpointV1(aborted)).toBe(true);
    const failed = await interruptedCheckpoint("WORKFLOW_EXECUTION_ERROR");
    expect(requiredPlan(failed).status).toBe("failed");
  });

  test("an inconsistent interrupted record is rejected as corrupt", async () => {
    const valid = await interruptedCheckpoint();
    const corrupt: Record<string, (saved: Record<string, unknown>) => void> = {
      "no error": (saved) => {
        delete saved.error;
      },
      "no completedAt": (saved) => {
        delete saved.completedAt;
      },
      "a result": (saved) => {
        saved.result = completedResult();
      },
      "an interrupt": (saved) => {
        saved.interrupt = {
          kind: "input",
          functionCallIds: ["call-1"],
          requests: [],
          events: [],
        };
      },
      "another error code": (saved) => {
        saved.error = {
          code: "WORKFLOW_EXECUTION_ERROR",
          message: "Workflow step failed",
        };
      },
      "a wrong-case status": (saved) => {
        saved.status = "Interrupted";
      },
    };
    for (const [name, change] of Object.entries(corrupt)) {
      expect({
        name,
        valid: isWorkflowCheckpointV1(withPlan(valid, change)),
      }).toEqual({
        name,
        valid: false,
      });
    }
  });

  test("a failed record with the abort code, written before interrupted existed, still loads and replays", async () => {
    const legacy = withPlan(await interruptedCheckpoint(), (saved) => {
      saved.status = "failed";
    });
    expect(isWorkflowCheckpointV1(legacy)).toBe(true);
    const inputHash = await hashWorkflowInput(step.input);
    const resolution = resolveWorkflowStep(
      legacy as WorkflowCheckpointV1,
      step,
      inputHash,
    );
    expect(resolution.action).toBe("replay-failure");
  });

  test("resolves to the next attempt only on opt-in and never on an answer turn", async () => {
    const checkpoint = await interruptedCheckpoint();
    const inputHash = await hashWorkflowInput(step.input);
    const rerun = {
      action: "execute" as const,
      attempt: 2,
      resumeReason: "interrupted" as const,
    };
    expect(
      resolveWorkflowStep(checkpoint, step, inputHash, { retryFailed: true }),
    ).toEqual(rerun);
    expect(
      resolveWorkflowStep(
        checkpoint,
        { ...step, resumePolicy: "retry" },
        inputHash,
      ),
    ).toEqual(rerun);
    expectWorkflowCode(
      () => resolveWorkflowStep(checkpoint, step, inputHash),
      "WORKFLOW_INDETERMINATE_STEP",
    );
    expectWorkflowCode(
      () =>
        resolveWorkflowStep(checkpoint, step, inputHash, {
          retryFailed: true,
          answerTurn: true,
        }),
      "WORKFLOW_INDETERMINATE_STEP",
    );
    expectWorkflowCode(
      () =>
        resolveWorkflowStep(
          checkpoint,
          { ...step, resumePolicy: "retry" },
          inputHash,
          { answerTurn: true },
        ),
      "WORKFLOW_INDETERMINATE_STEP",
    );
  });
});

async function completedCheckpoint(): Promise<WorkflowCheckpointV1> {
  const inputHash = await hashWorkflowInput(step.input);
  let checkpoint = await createWorkflowCheckpoint({
    definition,
    executionId: "inv-completed",
    input: "workflow input",
    now: 10,
  });
  checkpoint = withWorkflowStepRunning(checkpoint, step, inputHash, 1, 10);
  checkpoint = withWorkflowStepCompleted(checkpoint, completedResult(), 20);
  return withWorkflowCompleted(checkpoint, "done", 30);
}

function requiredPlan(checkpoint: WorkflowCheckpointV1) {
  const saved = checkpoint.steps.plan;
  if (!saved) throw new Error("missing plan step");
  return saved;
}

function requiredResult(checkpoint: WorkflowCheckpointV1) {
  const result = requiredPlan(checkpoint).result;
  if (!result) throw new Error("missing plan result");
  return result;
}

function completedResult(): WorkflowStepResult {
  return {
    status: "completed",
    id: step.id,
    agentName: step.agentName,
    output: "plan complete",
    attempts: 1,
    startedAt: 10,
    completedAt: 20,
  };
}

function expectWorkflowCode(
  action: () => unknown,
  code: WorkflowError["code"],
): void {
  try {
    action();
    throw new Error(`Expected workflow error: ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowError);
    expect((error as WorkflowError).code).toBe(code);
  }
}

describe("stored step models", () => {
  const models = {
    requested: ["claude-opus-5-5"],
    resolved: ["claude-opus-5-5"],
    unknown: false,
  };

  async function withModels(value: unknown): Promise<unknown> {
    const copy = structuredClone(await completedCheckpoint()) as unknown as {
      steps: Record<string, { result: Record<string, unknown> }>;
    };
    const saved = copy.steps.plan;
    if (!saved) throw new Error("missing plan step");
    saved.result.models = value;
    return copy;
  }

  test("valid models round-trip, and a checkpoint from before models existed loads", async () => {
    expect(isWorkflowCheckpointV1(await withModels(models))).toBe(true);
    expect(
      isWorkflowCheckpointV1(
        await withModels({ requested: [], resolved: [], unknown: true }),
      ),
    ).toBe(true);
    expect(isWorkflowCheckpointV1(await completedCheckpoint())).toBe(true);
    expect(requiredResult(await completedCheckpoint()).models).toBeUndefined();
    const copy = (await withModels(models)) as {
      steps: Record<string, { result: { models: unknown } }>;
    };
    expect(copy.steps.plan?.result.models).toEqual(models);
  });

  test("used and unexpected load when they are string arrays, and an old checkpoint without them loads", async () => {
    const full = { ...models, used: ["claude-opus-5-5"], unexpected: [] };
    expect(isWorkflowCheckpointV1(await withModels(full))).toBe(true);
    const copy = (await withModels(full)) as {
      steps: Record<string, { result: { models: unknown } }>;
    };
    // Replay returns the stored value.
    expect(copy.steps.plan?.result.models).toEqual(full);
    expect(isWorkflowCheckpointV1(await withModels(models))).toBe(true);
  });

  test("malformed models are rejected as corrupt", async () => {
    const corrupt: Record<string, unknown> = {
      null: null,
      "a string": "claude",
      "an array": [models],
      "an empty record": {},
      "no requested": { resolved: [], unknown: false },
      "no resolved": { requested: [], unknown: false },
      "no unknown": { requested: [], resolved: [] },
      "requested not an array": { ...models, requested: "x" },
      "resolved not an array": { ...models, resolved: "x" },
      "a number in requested": { ...models, requested: [1] },
      "an empty string in resolved": { ...models, resolved: [""] },
      "a null in requested": { ...models, requested: [null] },
      "unknown a string": { ...models, unknown: "false" },
      "unknown a number": { ...models, unknown: 0 },
      "an extra key": { ...models, extra: 1 },
      "used a string": { ...models, used: "x" },
      "used a string with unexpected": { ...models, used: "x", unexpected: [] },
      "used without unexpected": { ...models, used: [] },
      "used a null with unexpected": { ...models, used: null, unexpected: [] },
      "used an empty string inside": { ...models, used: [""] },
      "unexpected a number": { ...models, unexpected: [1] },
      "unexpected null": { ...models, unexpected: null },
    };
    for (const [name, value] of Object.entries(corrupt)) {
      expect({
        name,
        valid: isWorkflowCheckpointV1(await withModels(value)),
      }).toEqual({ name, valid: false });
    }
  });
});
