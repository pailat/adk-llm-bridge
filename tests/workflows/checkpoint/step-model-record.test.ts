import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BaseAgent } from "@google/adk";
import {
  createWorkflowCheckpoint,
  resolveWorkflowStep,
  withWorkflowStepCompleted,
  withWorkflowStepRunning,
  withWorkflowStepWaiting,
} from "../../../src/workflows/checkpoint/checkpoint.js";
import {
  isWorkflowCheckpointV1,
  type WorkflowCheckpointStepV1,
  type WorkflowCheckpointV1,
} from "../../../src/workflows/checkpoint/schema.js";
import {
  WorkflowError,
  type WorkflowStep,
  type WorkflowStepResult,
} from "../../../src/workflows/contracts.js";
import { defineWorkflow } from "../../../src/workflows/definition.js";
import { ScriptWorkflowAgent } from "../../../src/workflows/script-workflow-agent.js";
import { WorkflowAgent } from "../../../src/workflows/workflow-agent.js";

const definition = defineWorkflow({
  id: "model-record",
  version: "1",
  handler: async () => "unused",
});

const step: WorkflowStep = {
  id: "review",
  agentName: "worker",
  agentRevision: "rev-1",
  input: "original",
};

async function base(): Promise<WorkflowCheckpointV1> {
  return createWorkflowCheckpoint({
    definition,
    executionId: "inv-record",
    input: "go",
    now: 1,
  });
}

function result(): WorkflowStepResult {
  return {
    status: "completed",
    id: step.id,
    agentName: step.agentName,
    output: "ok",
    attempts: 1,
    startedAt: 2,
    completedAt: 3,
  };
}

async function completed(
  record?: Parameters<typeof withWorkflowStepRunning>[6],
): Promise<WorkflowCheckpointV1> {
  const running = withWorkflowStepRunning(
    await base(),
    step,
    "sha256:in",
    1,
    2,
    undefined,
    record,
  );
  return withWorkflowStepCompleted(running, result(), 3);
}

function mismatchOf(run: () => unknown): WorkflowError {
  try {
    run();
  } catch (error) {
    if (error instanceof WorkflowError) return error;
    throw error;
  }
  throw new Error("expected a throw");
}

describe("WORKFLOW_STEP_MISMATCH mismatch[] (test 1)", () => {
  test("lists each differing part, in a fixed order", async () => {
    const checkpoint = await completed({ model: { requested: "m1" } });
    const current = (over: Partial<WorkflowStep>) => ({ ...step, ...over });
    const cases: [Partial<WorkflowStep>, string, string[]][] = [
      [{ agentName: "other" }, "sha256:in", ["agentName"]],
      [{ agentRevision: "rev-2" }, "sha256:in", ["agentRevision"]],
      [{}, "sha256:other", ["input"]],
      [
        { agentName: "other", agentRevision: "rev-2" },
        "sha256:in",
        ["agentName", "agentRevision"],
      ],
      [
        { agentName: "other", agentRevision: "rev-2" },
        "sha256:x",
        ["agentName", "agentRevision", "input"],
      ],
    ];
    for (const [over, hash, expected] of cases) {
      const error = mismatchOf(() =>
        resolveWorkflowStep(checkpoint, current(over), hash),
      );
      expect(error.code).toBe("WORKFLOW_STEP_MISMATCH");
      expect(error.details?.mismatch).toEqual(expected);
    }
  });

  test("strict mode adds model last, with the two requested models", async () => {
    const checkpoint = await completed({ model: { requested: "m1" } });
    const error = mismatchOf(() =>
      resolveWorkflowStep(checkpoint, step, "sha256:x", {
        modelChange: "mismatch",
        currentModel: { requested: "m2" },
      }),
    );
    expect(error.details?.mismatch).toEqual(["input", "model"]);
    expect(error.details?.savedRequestedModel).toBe("m1");
    expect(error.details?.requestedModel).toBe("m2");
  });

  test("details hold no diff, window or length key", async () => {
    const checkpoint = await completed({ model: { requested: "m1" } });
    const error = mismatchOf(() =>
      resolveWorkflowStep(checkpoint, step, "sha256:x"),
    );
    const json = JSON.stringify(error.toJSON());
    for (const key of ["diff", "firstDifference", "inputLength", "chunks"]) {
      expect(json).not.toContain(key);
    }
  });
});

describe("model check in resolveWorkflowStep (tests 9, 11)", () => {
  test("warn: a changed model replays with a marker; an equal one has none", async () => {
    const checkpoint = await completed({ model: { requested: "m1" } });
    const changed = resolveWorkflowStep(checkpoint, step, "sha256:in", {
      currentModel: { requested: "m2" },
    });
    expect(changed).toMatchObject({
      action: "replay",
      modelChanged: {
        savedRequestedModel: "m1",
        requestedModel: "m2",
      },
    });
    const same = resolveWorkflowStep(checkpoint, step, "sha256:in", {
      currentModel: { requested: "m1" },
    });
    expect("modelChanged" in same).toBe(false);
  });

  test("warn: one side absent counts as changed; both absent is equal", async () => {
    const savedNone = await completed({ model: {} });
    expect(
      resolveWorkflowStep(savedNone, step, "sha256:in", {
        currentModel: { requested: "m2" },
      }),
    ).toMatchObject({ modelChanged: { requestedModel: "m2" } });
    expect(
      "modelChanged" in
        resolveWorkflowStep(savedNone, step, "sha256:in", { currentModel: {} }),
    ).toBe(false);
    const saved = await completed({ model: { requested: "m1" } });
    expect(
      resolveWorkflowStep(saved, step, "sha256:in", { currentModel: {} }),
    ).toMatchObject({ modelChanged: { savedRequestedModel: "m1" } });
  });

  test("warn: an unrecorded saved model is marked, not reported as a change", async () => {
    const checkpoint = await completed();
    const resolution = resolveWorkflowStep(checkpoint, step, "sha256:in", {
      currentModel: { requested: "m2" },
    });
    expect(resolution).toMatchObject({
      action: "replay",
      modelUnrecorded: true,
    });
    expect("modelChanged" in resolution).toBe(false);
  });

  test("warn: a waiting step resumes with the marker", async () => {
    const running = withWorkflowStepRunning(
      await base(),
      step,
      "sha256:in",
      1,
      2,
      undefined,
      { model: { requested: "m1" } },
    );
    const waiting = withWorkflowStepWaiting(
      running,
      step,
      "sha256:in",
      1,
      { kind: "input", functionCallIds: ["c1"], requests: [], events: [] },
      { role: "user", parts: [] },
      3,
      { model: { requested: "m1" } },
    );
    expect(
      resolveWorkflowStep(waiting, step, "sha256:in", {
        currentModel: { requested: "m2" },
      }),
    ).toMatchObject({
      action: "resume",
      modelChanged: { savedRequestedModel: "m1", requestedModel: "m2" },
    });
  });

  test("without currentModel no model check runs", async () => {
    const checkpoint = await completed({ model: { requested: "m1" } });
    const resolution = resolveWorkflowStep(checkpoint, step, "sha256:in");
    expect("modelChanged" in resolution).toBe(false);
    expect("modelUnrecorded" in resolution).toBe(false);
  });

  test("strict: differ, saved unrecorded, current absent, saved absent are mismatches; equal replays", async () => {
    const strict = (
      checkpoint: WorkflowCheckpointV1,
      requested: string | undefined,
    ) =>
      resolveWorkflowStep(checkpoint, step, "sha256:in", {
        modelChange: "mismatch",
        currentModel: requested === undefined ? {} : { requested },
      });
    const recorded = await completed({ model: { requested: "m1" } });
    const unrecorded = await completed();
    const emptyModel = await completed({ model: {} });
    expect(mismatchOf(() => strict(recorded, "m2")).details?.mismatch).toEqual([
      "model",
    ]);
    expect(
      mismatchOf(() => strict(unrecorded, "m1")).details?.mismatch,
    ).toEqual(["model"]);
    expect(
      mismatchOf(() => strict(recorded, undefined)).details?.mismatch,
    ).toEqual(["model"]);
    expect(
      mismatchOf(() => strict(emptyModel, "m1")).details?.mismatch,
    ).toEqual(["model"]);
    expect(strict(recorded, "m1").action).toBe("replay");
  });

  test("strict: a step that will run again (failed with retry) is not a model mismatch", async () => {
    const running = withWorkflowStepRunning(
      await base(),
      step,
      "sha256:in",
      1,
      2,
      undefined,
      { model: { requested: "m1" } },
    );
    const resolution = resolveWorkflowStep(
      running,
      { ...step, resumePolicy: "retry" },
      "sha256:in",
      {
        modelChange: "mismatch",
        currentModel: { requested: "m2" },
      },
    );
    expect(resolution.action).toBe("execute");
  });
});

describe("writers (test 12 part, mutant: waiting)", () => {
  test("running and waiting keep the model and fingerprint fields; completed keeps them by spread", async () => {
    const record = {
      model: { requested: "m1" },
      inputLength: 9,
    };
    const running = withWorkflowStepRunning(
      await base(),
      step,
      "sha256:in",
      1,
      2,
      undefined,
      record,
    );
    expect(running.steps.review).toMatchObject(record);
    const waiting = withWorkflowStepWaiting(
      running,
      step,
      "sha256:in",
      1,
      {
        kind: "input",
        functionCallIds: ["c1"],
        requests: [],
        events: [],
      },
      { role: "user", parts: [] },
      3,
      record,
    );
    expect(waiting.steps.review).toMatchObject(record);
    const done = withWorkflowStepCompleted(running, result(), 3);
    expect(done.steps.review).toMatchObject(record);
  });

  test("a rebuilt record without fields loses them", async () => {
    const running = withWorkflowStepRunning(
      await base(),
      step,
      "sha256:in",
      1,
      2,
      undefined,
      { model: { requested: "m1" }, inputLength: 9 },
    );
    const again = withWorkflowStepRunning(running, step, "sha256:in", 2, 3);
    expect(again.steps.review?.model).toBeUndefined();
    expect(again.steps.review?.inputLength).toBeUndefined();
  });
});

describe("checkpoint validator for the new step fields (test 5)", () => {
  const chunk = "0123456789ab";

  async function withStep(
    extra: Record<string, unknown>,
  ): Promise<WorkflowCheckpointV1> {
    const checkpoint = await completed();
    const stored = checkpoint.steps.review as WorkflowCheckpointStepV1;
    return {
      ...checkpoint,
      steps: { review: { ...stored, ...extra } },
    } as WorkflowCheckpointV1;
  }

  test("well-formed fields load", async () => {
    for (const extra of [
      { model: { requested: "gpt-5.5" } },
      { model: {} },
      { inputLength: 0 },
      { inputLength: 100 },
      {
        inputLength: 300,
        inputDigest: { chunkSize: 256, chunks: [chunk, chunk] },
      },
      {
        model: { requested: "m" },
        inputLength: 8192,
        inputDigest: { chunkSize: 256, chunks: Array(32).fill(chunk) },
      },
    ]) {
      expect(
        isWorkflowCheckpointV1(await withStep(extra)),
        JSON.stringify(extra),
      ).toBe(true);
    }
  });

  test("each malformed variant is corrupt", async () => {
    const bad: Record<string, unknown>[] = [
      { model: { requested: "m", extra: 1 } },
      { model: { requested: "" } },
      { model: { requested: "x".repeat(257) } },
      { model: { requested: 5 } },
      { model: "m" },
      { inputLength: -1 },
      { inputLength: 1.5 },
      { inputLength: Number.MAX_SAFE_INTEGER + 1 },
      { inputDigest: { chunkSize: 256, chunks: [chunk, chunk] } },
      {
        inputLength: 256,
        inputDigest: { chunkSize: 256, chunks: [chunk, chunk] },
      },
      {
        inputLength: 8448,
        inputDigest: { chunkSize: 256, chunks: Array(33).fill(chunk) },
      },
      {
        inputLength: 600,
        inputDigest: { chunkSize: 256, chunks: [chunk, chunk] },
      },
      {
        inputLength: 700,
        inputDigest: { chunkSize: 300, chunks: [chunk, chunk, chunk] },
      },
      {
        inputLength: 300,
        inputDigest: { chunkSize: 128, chunks: [chunk, chunk, chunk] },
      },
      {
        inputLength: 300,
        inputDigest: { chunkSize: 256, chunks: [chunk, "ZZZZZZZZZZZZ"] },
      },
      {
        inputLength: 300,
        inputDigest: { chunkSize: 256, chunks: [chunk, "0123456789a"] },
      },
      {
        inputLength: 300,
        inputDigest: { chunkSize: 256, chunks: [chunk, chunk.toUpperCase()] },
      },
      {
        inputLength: 300,
        inputDigest: { chunkSize: 256, chunks: [chunk, chunk], extra: 1 },
      },
    ];
    for (const extra of bad) {
      expect(
        isWorkflowCheckpointV1(await withStep(extra)),
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  test("a pre-0.7 checkpoint loads unchanged", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("./fixtures/pre-compact-0.7.0.json", import.meta.url),
        "utf8",
      ),
    ) as { sessionState: Record<string, unknown> };
    const checkpoints = Object.values(fixture.sessionState);
    expect(checkpoints.length).toBeGreaterThan(0);
    for (const checkpoint of checkpoints) {
      expect(isWorkflowCheckpointV1(checkpoint)).toBe(true);
    }
  });
});

describe("replay option validation (test 6)", () => {
  class Idle extends BaseAgent {
    constructor() {
      super({ name: "worker" });
    }
    protected async *runAsyncImpl() {}
    protected async *runLiveImpl() {}
  }
  const build = (replay: unknown) =>
    new WorkflowAgent({
      name: "wf",
      definition,
      subAgents: [new Idle()],
      replay: replay as never,
    });
  const code = (replay: unknown): string | undefined => {
    try {
      build(replay);
    } catch (error) {
      return error instanceof WorkflowError ? error.code : String(error);
    }
    return undefined;
  };

  test("valid options build", () => {
    expect(code(undefined)).toBeUndefined();
    expect(code({})).toBeUndefined();
    expect(
      code({
        modelChange: "mismatch",
        inputDigest: false,
        onStepMismatch: () => {},
      }),
    ).toBeUndefined();
  });

  test("each invalid shape is WORKFLOW_DEFINITION_INVALID", () => {
    for (const replay of [
      null,
      "warn",
      [],
      { modelChange: "strict" },
      { modelChange: 1 },
      { inputDigest: "yes" },
      { inputDigest: 1 },
      { onStepMismatch: "log" },
      { unknown: true },
    ]) {
      expect(code(replay), JSON.stringify(replay)).toBe(
        "WORKFLOW_DEFINITION_INVALID",
      );
    }
  });

  test("the script workflow agent applies the same rules", () => {
    const make = (replay: unknown) =>
      new ScriptWorkflowAgent({
        name: "script",
        definition: {
          kind: "script",
          id: "s",
          version: "1",
          source: "export default 1",
        } as never,
        replay: replay as never,
      });
    expect(() => make({ modelChange: "x" })).toThrow(WorkflowError);
    expect(() => make({ modelChange: "warn" })).not.toThrow();
  });
});
