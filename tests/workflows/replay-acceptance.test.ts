import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  type BaseAgent,
  type Event,
  InvocationContext,
  type Logger,
  PluginManager,
  resetLogger,
  setLogger,
} from "@google/adk";
import { type Context, context, type Span, trace } from "@opentelemetry/api";
import { ExternalAgent } from "../../src/agents/external-agent.js";
import type {
  ExternalAgentDriver,
  ExternalAgentEvent,
} from "../../src/agents/index.js";
import { CODEX_PROVIDER } from "../../src/agents/provider/schema.js";
import { FileSystemWorkflowCheckpointStore } from "../../src/workflows/checkpoint/file-system-checkpoint-store.js";
import { workflowStepInputCanonicalForm } from "../../src/workflows/checkpoint/hash.js";
import type { WorkflowReplayAcceptance } from "../../src/workflows/checkpoint/replay-acceptance.js";
import type { WorkflowCheckpointV1 } from "../../src/workflows/checkpoint/schema.js";
import {
  AdkSessionCheckpointStore,
  type SaveWorkflowCheckpointInput,
  type WorkflowCheckpointWrite,
  workflowCheckpointKey,
  workflowCheckpointRevision,
} from "../../src/workflows/checkpoint/store.js";
import {
  type WorkflowContext,
  WorkflowError,
} from "../../src/workflows/contracts.js";
import { defineWorkflow } from "../../src/workflows/definition.js";
import type { WorkflowEvent } from "../../src/workflows/events.js";
import { sha256Digest } from "../../src/workflows/internal/canonical-hash.js";
import type { WorkflowReplayOptions } from "../../src/workflows/node-config.js";
import { WorkflowAgent } from "../../src/workflows/workflow-agent.js";

const EXECUTION = "inv-acc";
const WORKFLOW = "replay-acceptance";

interface Logs {
  warn: string[];
  debug: string[];
  all: string[];
}
let logs: Logs;

beforeEach(() => {
  logs = { warn: [], debug: [], all: [] };
  const record = (bucket: "warn" | "debug") => (message: unknown) => {
    const text = String(message);
    logs[bucket].push(text);
    logs.all.push(text);
  };
  const fake: Logger = {
    log: record("debug"),
    debug: record("debug"),
    info: record("debug"),
    error: record("warn"),
    warn: record("warn"),
    setLogLevel: () => {},
  };
  setLogger(fake);
});
afterEach(() => resetLogger());

const warnsWith = (code: string) =>
  logs.warn.filter((line) => line.includes(`[${code}]`));
const debugsWith = (code: string) =>
  logs.debug.filter((line) => line.includes(`[${code}]`));

function external(
  name: string,
  shape: { model?: string; fail?: boolean } = {},
): ExternalAgent {
  const driver: ExternalAgentDriver = {
    providerId: CODEX_PROVIDER.id,
    ...(shape.model ? { model: shape.model } : {}),
    async *run() {
      if (shape.fail) throw new Error("driver failed");
      const events: ExternalAgentEvent[] = [
        { type: "started", providerId: CODEX_PROVIDER.id },
        { type: "output", content: "done" },
        { type: "completed", exitCode: 0 },
      ];
      yield* events;
    },
  };
  return new ExternalAgent({ name, provider: CODEX_PROVIDER, driver });
}

type StepSpec = { id: string; input: () => string };

interface Extra {
  revision?: string;
  store?: AdkSessionCheckpointStore;
  probe?: (ctx: WorkflowContext) => void;
}

function workflowOf(
  agent: BaseAgent,
  steps: StepSpec[],
  replay?: WorkflowReplayOptions,
  extra: Extra = {},
): WorkflowAgent {
  return new WorkflowAgent({
    name: "wf",
    definition: defineWorkflow({
      id: WORKFLOW,
      version: "1",
      handler: async (ctx) => {
        extra.probe?.(ctx);
        for (const spec of steps) {
          try {
            await ctx.run({
              id: spec.id,
              agentName: agent.name,
              input: spec.input(),
              ...(extra.revision ? { agentRevision: extra.revision } : {}),
            });
          } catch (error) {
            if (
              error instanceof WorkflowError &&
              error.code === "WORKFLOW_STEP_MISMATCH"
            ) {
              throw error;
            }
          }
        }
        return "end";
      },
    }),
    subAgents: [agent],
    ...(replay ? { replay } : {}),
    ...(extra.store ? { checkpointStore: extra.store } : {}),
  });
}

function invocation(
  agent: BaseAgent,
  state: Record<string, unknown>,
): InvocationContext {
  return new InvocationContext({
    pluginManager: new PluginManager(),
    invocationId: EXECUTION,
    branch: "root",
    agent,
    userContent: { role: "user", parts: [{ text: "go" }] },
    session: {
      id: "s",
      appName: "app",
      userId: "u",
      state,
      events: [],
      lastUpdateTime: 1,
    },
  });
}

interface Turn {
  events: Event[];
  state: Record<string, unknown>;
  error?: unknown;
  workflowEvents: WorkflowEvent[];
}

async function turn(
  workflow: WorkflowAgent,
  state: Record<string, unknown> = {},
): Promise<Turn> {
  const events: Event[] = [];
  let error: unknown;
  try {
    for await (const event of workflow.runAsync(invocation(workflow, state))) {
      events.push(event);
    }
  } catch (caught) {
    error = caught;
  }
  const delta = Object.assign(
    {},
    ...events.map((event) => event.actions?.stateDelta ?? {}),
  ) as Record<string, unknown>;
  return {
    events,
    state: { ...state, ...delta },
    error,
    workflowEvents: events
      .map((event) => event.customMetadata?.workflowEvent as WorkflowEvent)
      .filter(Boolean),
  };
}

const KEY = workflowCheckpointKey(WORKFLOW, EXECUTION);
const checkpointOf = (state: Record<string, unknown>) =>
  state[KEY] as WorkflowCheckpointV1;
const types = (t: Turn) => t.workflowEvents.map((e) => e.type);
const hashOf = (text: string) =>
  sha256Digest(workflowStepInputCanonicalForm(text));

const BIG = "abcdefghij".repeat(100);
const EDITED = `${BIG.slice(0, 600)}EDITED${BIG.slice(606)}`;
const REASON = "only whitespace changed in the decision file";

async function acceptInput(
  over: Partial<WorkflowReplayAcceptance> = {},
): Promise<WorkflowReplayAcceptance> {
  return {
    executionId: EXECUTION,
    stepId: "s1",
    kind: "input",
    from: await hashOf(BIG),
    to: await hashOf(EDITED),
    reason: REASON,
    ...over,
  };
}

/** Turn 1 completes s1 with BIG; the caller then runs with EDITED. */
async function completedWithBig(model = "m1") {
  const first = await turn(
    workflowOf(external("worker", { model }), [{ id: "s1", input: () => BIG }]),
  );
  expect(first.error).toBeUndefined();
  return first;
}

const editedSteps: StepSpec[] = [{ id: "s1", input: () => EDITED }];

describe("input acceptance applied (test 13)", () => {
  test("replays the saved result and records the change in one save", async () => {
    const first = await completedWithBig();
    const acceptance = await acceptInput({ approvedBy: "operator" });
    const second = await turn(
      workflowOf(external("worker", { model: "m1" }), editedSteps, {
        acceptChanges: [acceptance],
      }),
      first.state,
    );
    expect(second.error).toBeUndefined();
    const order = types(second);
    const saved = order.indexOf("checkpoint_saved");
    const accepted = order.indexOf("step_change_accepted");
    const replayed = order.indexOf("step_replayed");
    expect(order).not.toContain("step_started");
    expect(saved).toBeGreaterThanOrEqual(0);
    expect(saved).toBeLessThan(accepted);
    expect(accepted).toBeLessThan(replayed);
    // One save for the step: the acceptance (the other is workflow completion).
    const stepSaves = second.workflowEvents.filter(
      (e) => e.type === "checkpoint_saved" && e.stepId === "s1",
    );
    expect(stepSaves).toHaveLength(1);

    const step = checkpointOf(second.state).steps.s1;
    expect(step?.status).toBe("completed");
    expect(step?.inputHash).toBe(acceptance.to);
    expect(step?.inputLength).toBe(EDITED.length + 2);
    expect(step?.inputDigest?.chunks).not.toEqual(
      checkpointOf(first.state).steps.s1?.inputDigest?.chunks,
    );
    expect(step?.model).toEqual({ requested: "m1" });
    expect(step?.result).toEqual(checkpointOf(first.state).steps.s1?.result);
    expect(step?.acceptances).toHaveLength(1);
    expect(step?.acceptances?.[0]).toMatchObject({
      kind: "input",
      from: acceptance.from,
      to: acceptance.to,
      reason: REASON,
      approvedBy: "operator",
    });
    expect(typeof step?.acceptances?.[0]?.acceptedAt).toBe("number");

    const event = second.workflowEvents.find(
      (e) => e.type === "step_change_accepted",
    );
    expect(event).toMatchObject({
      stepId: "s1",
      acceptance: { kind: "input", from: acceptance.from, to: acceptance.to },
    });
    const lines = warnsWith("WORKFLOW_REPLAY_CHANGE_ACCEPTED");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("s1");
    expect(lines[0]).not.toContain(REASON);
  });

  test("a relaunch with the same entry is a no-op, and one without it replays", async () => {
    const first = await completedWithBig();
    const acceptance = await acceptInput();
    const replay = { acceptChanges: [acceptance] };
    const second = await turn(
      workflowOf(external("worker", { model: "m1" }), editedSteps, replay),
      first.state,
    );
    expect(second.error).toBeUndefined();
    logs.warn.length = 0;
    const third = await turn(
      workflowOf(external("worker", { model: "m1" }), editedSteps, replay),
      second.state,
    );
    expect(third.error).toBeUndefined();
    expect(types(third)).not.toContain("step_change_accepted");
    expect(checkpointOf(third.state).steps.s1?.acceptances).toHaveLength(1);
    expect(warnsWith("WORKFLOW_REPLAY_CHANGE_ACCEPTED")).toHaveLength(0);
    expect(warnsWith("WORKFLOW_REPLAY_ACCEPTANCE_UNUSED")).toHaveLength(0);

    const fourth = await turn(
      workflowOf(external("worker", { model: "m1" }), editedSteps),
      third.state,
    );
    expect(fourth.error).toBeUndefined();
    expect(types(fourth)).toContain("step_replayed");
    expect(types(fourth)).not.toContain("step_started");
  });

  test("an execution that failed on the mismatch resumes with the acceptance", async () => {
    const first = await completedWithBig();
    const failed = await turn(
      workflowOf(external("worker", { model: "m1" }), editedSteps),
      first.state,
    );
    expect((failed.error as WorkflowError).code).toBe("WORKFLOW_STEP_MISMATCH");
    expect(checkpointOf(failed.state).status).toBe("failed");
    const details = (failed.error as WorkflowError).details ?? {};
    const third = await turn(
      workflowOf(external("worker", { model: "m1" }), editedSteps, {
        acceptChanges: [
          {
            executionId: EXECUTION,
            stepId: "s1",
            kind: "input",
            from: details.savedInputHash as string,
            to: details.inputHash as string,
            reason: REASON,
          },
        ],
      }),
      failed.state,
    );
    expect(third.error).toBeUndefined();
    expect(checkpointOf(third.state).status).toBe("completed");
  });

  test("with inputDigest false the stale fingerprint is dropped", async () => {
    const first = await completedWithBig();
    const second = await turn(
      workflowOf(external("worker", { model: "m1" }), editedSteps, {
        inputDigest: false,
        acceptChanges: [await acceptInput()],
      }),
      first.state,
    );
    expect(second.error).toBeUndefined();
    const step = checkpointOf(second.state).steps.s1;
    expect(step && "inputLength" in step).toBe(false);
    expect(step && "inputDigest" in step).toBe(false);
  });
});

describe("acceptance rejections (test 14)", () => {
  async function refused(
    state: Record<string, unknown>,
    acceptChanges: WorkflowReplayAcceptance[],
    reason: string,
    steps: StepSpec[] = editedSteps,
  ) {
    const before = JSON.stringify(checkpointOf(state));
    const result = await turn(
      workflowOf(external("worker", { model: "m1" }), steps, {
        acceptChanges,
      }),
      state,
    );
    const error = result.error as WorkflowError;
    expect(error).toBeInstanceOf(WorkflowError);
    expect(error.code).toBe("WORKFLOW_REPLAY_ACCEPTANCE_INVALID");
    expect(error.details).toMatchObject({ reason, executionId: EXECUTION });
    expect(JSON.stringify(error.toJSON())).not.toContain(REASON);
    // Nothing was saved and no step ran.
    expect(JSON.stringify(checkpointOf(result.state))).toBe(before);
    expect(result.workflowEvents.map((e) => e.type)).toEqual(["error"]);
    return error;
  }

  test("a wrong from is refused before any step, and a corrected entry resumes", async () => {
    const first = await completedWithBig();
    await refused(
      first.state,
      [await acceptInput({ from: `sha256:${"0".repeat(64)}` })],
      "from-does-not-match",
    );
    const fixed = await turn(
      workflowOf(external("worker", { model: "m1" }), editedSteps, {
        acceptChanges: [await acceptInput()],
      }),
      first.state,
    );
    expect(fixed.error).toBeUndefined();
  });

  test("an entry whose to is the saved value but whose from differs from the stored audit is refused", async () => {
    const first = await completedWithBig();
    const applied = await turn(
      workflowOf(external("worker", { model: "m1" }), editedSteps, {
        acceptChanges: [await acceptInput()],
      }),
      first.state,
    );
    expect(applied.error).toBeUndefined();
    await refused(
      applied.state,
      [await acceptInput({ from: `sha256:${"0".repeat(64)}` })],
      "from-does-not-match",
    );
  });

  test("an entry whose to is the saved value with no stored audit is refused, not a no-op", async () => {
    const first = await completedWithBig();
    await refused(
      first.state,
      [
        await acceptInput({
          from: `sha256:${"0".repeat(64)}`,
          to: await hashOf(BIG),
        }),
      ],
      "from-does-not-match",
      [{ id: "s1", input: () => BIG }],
    );
  });

  test.each(["__proto__", "constructor", "toString"])(
    "a step id %s that is not a saved step is refused as step-not-found",
    async (stepId) => {
      const first = await completedWithBig();
      await refused(
        first.state,
        [await acceptInput({ stepId })],
        "step-not-found",
      );
    },
  );

  test("a step that does not exist is refused", async () => {
    const first = await completedWithBig();
    await refused(
      first.state,
      [await acceptInput({ stepId: "s9" })],
      "step-not-found",
    );
  });

  test("an entry for this execution before it has a checkpoint is refused, and nothing is created", async () => {
    const result = await turn(
      workflowOf(external("worker", { model: "m1" }), editedSteps, {
        acceptChanges: [await acceptInput()],
      }),
    );
    expect((result.error as WorkflowError).code).toBe(
      "WORKFLOW_REPLAY_ACCEPTANCE_INVALID",
    );
    expect(checkpointOf(result.state)).toBeUndefined();
  });

  test("a failed step is refused", async () => {
    const first = await turn(
      workflowOf(external("worker", { model: "m1", fail: true }), [
        { id: "s1", input: () => BIG },
      ]),
    );
    expect(checkpointOf(first.state).steps.s1?.status).toBe("failed");
    const error = await refused(
      first.state,
      [await acceptInput()],
      "step-not-completed",
    );
    expect(error.details?.savedStatus).toBe("failed");
  });

  test("a running or interrupted step is refused", async () => {
    const first = await completedWithBig();
    const running = structuredClone(checkpointOf(first.state));
    const step = running.steps.s1 as unknown as Record<string, unknown>;
    delete step.result;
    delete step.completedAt;
    step.status = "running";
    await refused(
      { ...first.state, [KEY]: running },
      [await acceptInput()],
      "step-not-completed",
    );
    const interrupted = structuredClone(running);
    Object.assign(interrupted.steps.s1 as object, {
      status: "interrupted",
      completedAt: 2_000_000_000_000,
      updatedAt: 2_000_000_000_000,
      error: { code: "WORKFLOW_ABORTED", message: "aborted" },
    });
    await refused(
      { ...first.state, [KEY]: interrupted },
      [await acceptInput()],
      "step-not-completed",
    );
  });

  test("a model acceptance for a step without a model record is refused", async () => {
    const first = await completedWithBig();
    const stripped = structuredClone(checkpointOf(first.state));
    delete (stripped.steps.s1 as { model?: unknown }).model;
    await refused(
      { ...first.state, [KEY]: stripped },
      [
        {
          executionId: EXECUTION,
          stepId: "s1",
          kind: "model",
          from: "m1",
          to: "m2",
          reason: REASON,
        },
      ],
      "model-not-recorded",
    );
  });

  test("all failures are counted, the first in config order is thrown", async () => {
    const first = await completedWithBig();
    const error = await refused(
      first.state,
      [
        await acceptInput({ stepId: "s8" }),
        await acceptInput({ stepId: "s9" }),
      ],
      "step-not-found",
    );
    expect(error.details).toMatchObject({ stepId: "s8", count: 2 });
  });

  test("a to that does not match this turn's input is the ordinary mismatch, listing acceptanceToDoesNotMatch", async () => {
    const first = await completedWithBig();
    const result = await turn(
      workflowOf(external("worker", { model: "m1" }), editedSteps, {
        acceptChanges: [await acceptInput({ to: await hashOf("other") })],
      }),
      first.state,
    );
    const error = result.error as WorkflowError;
    expect(error.code).toBe("WORKFLOW_STEP_MISMATCH");
    expect(error.details?.mismatch).toEqual(["input"]);
    expect(error.details?.acceptanceToDoesNotMatch).toEqual(["input"]);
    expect(checkpointOf(result.state).steps.s1?.acceptances).toBeUndefined();
  });

  test("a to that differs from this turn's input hash only in its last character does not match", async () => {
    const first = await completedWithBig();
    const exact = await hashOf(EDITED);
    const near = `${exact.slice(0, -1)}${exact.endsWith("0") ? "1" : "0"}`;
    const result = await turn(
      workflowOf(external("worker", { model: "m1" }), editedSteps, {
        acceptChanges: [await acceptInput({ to: near })],
      }),
      first.state,
    );
    const error = result.error as WorkflowError;
    expect(error.code).toBe("WORKFLOW_STEP_MISMATCH");
    expect(error.details?.acceptanceToDoesNotMatch).toEqual(["input"]);
  });

  test("an agent revision change is a mismatch even with a matching input acceptance", async () => {
    const first = await turn(
      workflowOf(
        external("worker", { model: "m1" }),
        [{ id: "s1", input: () => BIG }],
        undefined,
        { revision: "r1" },
      ),
    );
    const result = await turn(
      workflowOf(
        external("worker", { model: "m1" }),
        editedSteps,
        { acceptChanges: [await acceptInput()] },
        { revision: "r2" },
      ),
      first.state,
    );
    const error = result.error as WorkflowError;
    expect(error.code).toBe("WORKFLOW_STEP_MISMATCH");
    expect(error.details?.mismatch).toEqual(["agentRevision", "input"]);
    expect(checkpointOf(result.state).steps.s1?.acceptances).toBeUndefined();
    expect(types(result)).not.toContain("step_change_accepted");
  });
});

describe("stored acceptances are audit, not authority", () => {
  test("an acceptance written into the checkpoint without host config grants nothing", async () => {
    const first = await completedWithBig();
    const forged = structuredClone(checkpointOf(first.state));
    const acceptance = await acceptInput();
    (forged.steps.s1 as { acceptances?: unknown }).acceptances = [
      {
        kind: "input",
        from: acceptance.from,
        to: acceptance.to,
        reason: REASON,
        acceptedAt: 1,
      },
    ];
    const result = await turn(
      workflowOf(external("worker", { model: "m1" }), editedSteps),
      { ...first.state, [KEY]: forged },
    );
    expect((result.error as WorkflowError).code).toBe("WORKFLOW_STEP_MISMATCH");
    expect(types(result)).not.toContain("step_replayed");
  });

  test("a step with 31 accepted changes cannot take an input and a model change at once", async () => {
    const first = await completedWithBig();
    const full = structuredClone(checkpointOf(first.state));
    (full.steps.s1 as { acceptances?: unknown }).acceptances = Array.from(
      { length: 31 },
      () => ({
        kind: "model",
        from: "m0",
        to: "m1",
        reason: REASON,
        acceptedAt: 1,
      }),
    );
    const store = { ...first.state, [KEY]: full };
    const result = await turn(
      workflowOf(external("worker", { model: "m2" }), editedSteps, {
        acceptChanges: [
          await acceptInput(),
          {
            executionId: EXECUTION,
            stepId: "s1",
            kind: "model",
            from: "m1",
            to: "m2",
            reason: REASON,
          },
        ],
      }),
      store,
    );
    const error = result.error as WorkflowError;
    expect(error.code).toBe("WORKFLOW_REPLAY_ACCEPTANCE_INVALID");
    expect(error.details?.reason).toBe("too-many-acceptances");
    expect(checkpointOf(result.state).steps.s1?.acceptances).toHaveLength(31);
    expect(types(result)).not.toContain("step_change_accepted");
  });

  test("a step that already holds 32 accepted changes takes no more", async () => {
    const first = await completedWithBig();
    const full = structuredClone(checkpointOf(first.state));
    (full.steps.s1 as { acceptances?: unknown }).acceptances = Array.from(
      { length: 32 },
      () => ({
        kind: "model",
        from: "m0",
        to: "m1",
        reason: REASON,
        acceptedAt: 1,
      }),
    );
    const result = await turn(
      workflowOf(external("worker", { model: "m1" }), editedSteps, {
        acceptChanges: [await acceptInput()],
      }),
      { ...first.state, [KEY]: full },
    );
    const error = result.error as WorkflowError;
    expect(error.code).toBe("WORKFLOW_REPLAY_ACCEPTANCE_INVALID");
    expect(error.details?.reason).toBe("too-many-acceptances");
  });
});

describe("entries for another execution (test 15)", () => {
  test("are ignored, counted once at debug level, and the mismatch stands", async () => {
    const first = await completedWithBig();
    const result = await turn(
      workflowOf(external("worker", { model: "m1" }), editedSteps, {
        acceptChanges: [
          await acceptInput({ executionId: "inv-typo" }),
          await acceptInput({ executionId: "inv-other", stepId: "s2" }),
        ],
      }),
      first.state,
    );
    expect((result.error as WorkflowError).code).toBe("WORKFLOW_STEP_MISMATCH");
    const lines = debugsWith("WORKFLOW_REPLAY_ACCEPTANCE_OTHER_EXECUTION");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("2");
  });
});

describe("model acceptance (test 16)", () => {
  const steps: StepSpec[] = [{ id: "s1", input: () => "one" }];
  const modelEntry = (): WorkflowReplayAcceptance => ({
    executionId: EXECUTION,
    stepId: "s1",
    kind: "model",
    from: "m1",
    to: "m2",
    reason: "same model family, cost change",
  });

  test("strict mode: lifts the mismatch, keeps model.requested, and later turns replay quietly", async () => {
    const strict: WorkflowReplayOptions = { modelChange: "mismatch" };
    const first = await turn(
      workflowOf(external("worker", { model: "m1" }), steps, strict),
    );
    const refusedTurn = await turn(
      workflowOf(external("worker", { model: "m2" }), steps, strict),
      first.state,
    );
    expect((refusedTurn.error as WorkflowError).details?.mismatch).toEqual([
      "model",
    ]);
    const second = await turn(
      workflowOf(external("worker", { model: "m2" }), steps, {
        ...strict,
        acceptChanges: [modelEntry()],
      }),
      first.state,
    );
    expect(second.error).toBeUndefined();
    const step = checkpointOf(second.state).steps.s1;
    expect(step?.model).toEqual({ requested: "m1" });
    expect(step?.acceptances?.[0]).toMatchObject({
      kind: "model",
      from: "m1",
      to: "m2",
    });
    logs.warn.length = 0;
    const third = await turn(
      workflowOf(external("worker", { model: "m2" }), steps, strict),
      second.state,
    );
    expect(third.error).toBeUndefined();
    expect(types(third)).toContain("step_replayed");
    expect(warnsWith("WORKFLOW_STEP_MODEL_CHANGED")).toHaveLength(0);
  });

  test("strict mode refuses a replay when neither the saved nor the current model is known", async () => {
    const strict: WorkflowReplayOptions = { modelChange: "mismatch" };
    const first = await turn(workflowOf(external("worker"), steps, strict));
    expect(first.error).toBeUndefined();
    expect(checkpointOf(first.state).steps.s1?.model).toEqual({});
    const second = await turn(
      workflowOf(external("worker"), steps, strict),
      first.state,
    );
    const error = second.error as WorkflowError;
    expect(error.code).toBe("WORKFLOW_STEP_MISMATCH");
    expect(error.details?.mismatch).toEqual(["model"]);
  });

  test("an accepted input change is not a model: strict and warn modes replay quietly with the same model", async () => {
    const first = await completedWithBig();
    const strict: WorkflowReplayOptions = { modelChange: "mismatch" };
    const accepted = await turn(
      workflowOf(external("worker", { model: "m1" }), editedSteps, {
        ...strict,
        acceptChanges: [await acceptInput()],
      }),
      first.state,
    );
    expect(accepted.error).toBeUndefined();
    expect(types(accepted)).toContain("step_replayed");
    const later = await turn(
      workflowOf(external("worker", { model: "m1" }), editedSteps, strict),
      accepted.state,
    );
    expect(later.error).toBeUndefined();
    expect(types(later)).toContain("step_replayed");
    logs.warn.length = 0;
    const warned = await turn(
      workflowOf(external("worker", { model: "m1" }), editedSteps),
      accepted.state,
    );
    expect(warned.error).toBeUndefined();
    expect(types(warned)).not.toContain("step_model_changed");
    expect(warnsWith("WORKFLOW_STEP_MODEL_CHANGED")).toHaveLength(0);
  });

  test("warn mode: the accepted event replaces the model warning", async () => {
    const first = await turn(
      workflowOf(external("worker", { model: "m1" }), steps),
    );
    const second = await turn(
      workflowOf(external("worker", { model: "m2" }), steps, {
        acceptChanges: [modelEntry()],
      }),
      first.state,
    );
    expect(second.error).toBeUndefined();
    expect(types(second)).toContain("step_change_accepted");
    expect(types(second)).not.toContain("step_model_changed");
    expect(warnsWith("WORKFLOW_STEP_MODEL_CHANGED")).toHaveLength(0);
    const third = await turn(
      workflowOf(external("worker", { model: "m2" }), steps),
      second.state,
    );
    expect(types(third)).not.toContain("step_model_changed");
  });

  test("a second model acceptance is checked against the effective model, not model.requested", async () => {
    const first = await turn(
      workflowOf(external("worker", { model: "m1" }), steps),
    );
    const second = await turn(
      workflowOf(external("worker", { model: "m2" }), steps, {
        acceptChanges: [modelEntry()],
      }),
      first.state,
    );
    const stale = await turn(
      workflowOf(external("worker", { model: "m3" }), steps, {
        acceptChanges: [{ ...modelEntry(), from: "m1", to: "m3" }],
      }),
      second.state,
    );
    expect((stale.error as WorkflowError).code).toBe(
      "WORKFLOW_REPLAY_ACCEPTANCE_INVALID",
    );
    const third = await turn(
      workflowOf(external("worker", { model: "m3" }), steps, {
        acceptChanges: [{ ...modelEntry(), from: "m2", to: "m3" }],
      }),
      second.state,
    );
    expect(third.error).toBeUndefined();
    const step = checkpointOf(third.state).steps.s1;
    expect(step?.model).toEqual({ requested: "m1" });
    expect(step?.acceptances?.map((a) => a.to)).toEqual(["m2", "m3"]);
  });

  test("an input and a model change accepted together go in one save", async () => {
    const strict: WorkflowReplayOptions = { modelChange: "mismatch" };
    const first = await turn(
      workflowOf(
        external("worker", { model: "m1" }),
        [{ id: "s1", input: () => BIG }],
        strict,
      ),
    );
    const second = await turn(
      workflowOf(external("worker", { model: "m2" }), editedSteps, {
        ...strict,
        acceptChanges: [await acceptInput(), modelEntry()],
      }),
      first.state,
    );
    expect(second.error).toBeUndefined();
    const step = checkpointOf(second.state).steps.s1;
    expect(step?.acceptances?.map((a) => a.kind)).toEqual(["input", "model"]);
    expect(
      second.workflowEvents.filter(
        (e) => e.type === "checkpoint_saved" && e.stepId === "s1",
      ),
    ).toHaveLength(1);
  });

  test("only the input accepted: a strict model mismatch remains and nothing is saved", async () => {
    const strict: WorkflowReplayOptions = { modelChange: "mismatch" };
    const first = await turn(
      workflowOf(
        external("worker", { model: "m1" }),
        [{ id: "s1", input: () => BIG }],
        strict,
      ),
    );
    const second = await turn(
      workflowOf(external("worker", { model: "m2" }), editedSteps, {
        ...strict,
        acceptChanges: [await acceptInput()],
      }),
      first.state,
    );
    const error = second.error as WorkflowError;
    expect(error.code).toBe("WORKFLOW_STEP_MISMATCH");
    expect(error.details?.mismatch).toEqual(["input", "model"]);
    expect(checkpointOf(second.state).steps.s1?.acceptances).toBeUndefined();
  });
});

class FailingAcceptanceStore extends AdkSessionCheckpointStore {
  refused = 0;
  override async save(
    input: SaveWorkflowCheckpointInput,
  ): Promise<WorkflowCheckpointWrite> {
    if (input.checkpoint.steps.s1?.acceptances) {
      this.refused++;
      throw new Error("disk full");
    }
    return super.save(input);
  }
}

describe("persist failure (test 17)", () => {
  test("a failed save means no replay and no accepted event", async () => {
    const first = await completedWithBig();
    const store = new FailingAcceptanceStore();
    let stepError: unknown;
    const second = await turn(
      new WorkflowAgent({
        name: "wf",
        definition: defineWorkflow({
          id: WORKFLOW,
          version: "1",
          handler: async (ctx) => {
            try {
              await ctx.run({ id: "s1", agentName: "worker", input: EDITED });
            } catch (caught) {
              stepError = caught;
            }
            return "end";
          },
        }),
        subAgents: [external("worker", { model: "m1" })],
        replay: { acceptChanges: [await acceptInput()] },
        checkpointStore: store,
      }),
      first.state,
    );
    expect(store.refused).toBe(1);
    expect((stepError as Error).message).toBe("disk full");
    expect(types(second)).not.toContain("step_replayed");
    expect(types(second)).not.toContain("step_change_accepted");
    expect(warnsWith("WORKFLOW_REPLAY_CHANGE_ACCEPTED")).toHaveLength(0);
    expect(checkpointOf(second.state).steps.s1?.acceptances).toBeUndefined();
  });
});

describe("host-only configuration (tests 18, 19)", () => {
  test("changing the caller's list or entry after construction has no effect", async () => {
    const first = await completedWithBig();
    const entry = { ...(await acceptInput()) };
    const list = [entry];
    const workflow = workflowOf(
      external("worker", { model: "m1" }),
      editedSteps,
      {
        acceptChanges: list,
      },
    );
    entry.to = await hashOf("something else");
    list.push(await acceptInput({ stepId: "s9" }));
    const second = await turn(workflow, first.state);
    expect(second.error).toBeUndefined();
    expect(checkpointOf(second.state).steps.s1?.inputHash).toBe(
      await hashOf(EDITED),
    );
  });

  test("workflow code sees no replay or acceptance surface", async () => {
    let keys: string[] = [];
    const probe = (ctx: WorkflowContext) => {
      keys = Reflect.ownKeys(ctx).map(String);
      // @ts-expect-error the context has no replay options
      expect(ctx.replay).toBeUndefined();
      // @ts-expect-error the context has no acceptances
      expect(ctx.acceptChanges).toBeUndefined();
    };
    const result = await turn(
      workflowOf(
        external("worker", { model: "m1" }),
        [{ id: "s1", input: () => BIG }],
        { acceptChanges: [] },
        { probe },
      ),
    );
    expect(result.error).toBeUndefined();
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key).not.toMatch(/replay|accept/i);
  });
});

describe("unused acceptances (test 20)", () => {
  test("an entry for a step this turn did not reach is logged once; an applied one is not", async () => {
    const first = await turn(
      workflowOf(external("worker", { model: "m1" }), [
        { id: "s1", input: () => BIG },
        { id: "s2", input: () => "two" },
      ]),
    );
    const s2 = {
      executionId: EXECUTION,
      stepId: "s2",
      kind: "input" as const,
      from: await hashOf("two"),
      to: await hashOf("two, edited"),
      reason: REASON,
    };
    const second = await turn(
      workflowOf(external("worker", { model: "m1" }), editedSteps, {
        acceptChanges: [await acceptInput(), s2],
      }),
      first.state,
    );
    expect(second.error).toBeUndefined();
    const lines = warnsWith("WORKFLOW_REPLAY_ACCEPTANCE_UNUSED");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("s2");
    expect(lines[0]).not.toContain(REASON);
    expect(lines[0]).not.toContain('"s1"');
  });
});

describe("telemetry (test 21, acceptance part)", () => {
  // biome-ignore lint/suspicious/noExplicitAny: the root context is opaque
  const ROOT = context.active() as any as Context;
  interface Recorded {
    name: string;
    events: { name: string; attributes?: Record<string, unknown> }[];
  }
  let spans: Recorded[];

  beforeEach(() => {
    spans = [];
    const storage = new AsyncLocalStorage<Context>();
    context.disable();
    context.setGlobalContextManager({
      active: () => storage.getStore() ?? ROOT,
      with: (
        ctx: Context,
        fn: (...args: never[]) => unknown,
        thisArg?: unknown,
      ) => storage.run(ctx, () => fn.call(thisArg)),
      bind: <T>(_ctx: Context, target: T) => target,
      enable() {
        return this;
      },
      disable() {
        return this;
      },
    } as never);
    trace.disable();
    trace.setGlobalTracerProvider({
      getTracer: () => ({
        startSpan(name: string) {
          const record: Recorded = { name, events: [] };
          spans.push(record);
          const span = {
            setAttributes: () => span,
            setAttribute: () => span,
            setStatus: () => span,
            addEvent(eventName: string, attributes?: Record<string, unknown>) {
              record.events.push({ name: eventName, attributes });
              return span;
            },
            recordException() {},
            spanContext: () => ({ traceId: "t", spanId: "s", traceFlags: 1 }),
            isRecording: () => true,
            end() {},
          };
          return span as unknown as Span;
        },
      }),
    } as never);
  });
  afterEach(() => {
    trace.disable();
    context.disable();
  });

  test("an accepted change adds a span event with kind, values and the reason length, not its text", async () => {
    const first = await completedWithBig();
    spans.length = 0;
    const acceptance = await acceptInput({ approvedBy: "ops" });
    const result = await turn(
      workflowOf(external("worker", { model: "m1" }), editedSteps, {
        acceptChanges: [acceptance],
      }),
      first.state,
    );
    const events = spans.flatMap((span) => span.events);
    const accepted = events.find((e) => e.name === "step_change_accepted");
    expect(accepted?.attributes).toEqual({
      "adk.workflow.step.id": "s1",
      "adk.workflow.acceptance.kind": "input",
      "adk.workflow.acceptance.from": acceptance.from.slice(0, 19),
      "adk.workflow.acceptance.to": acceptance.to.slice(0, 19),
      "adk.workflow.acceptance.approved_by": "ops",
      "adk.workflow.acceptance.reason_length": REASON.length,
    });
    expect(JSON.stringify(events)).not.toContain(REASON);
    expect(JSON.stringify(events)).not.toContain("EDITED");
    // Full input digests stay out of spans and logs; the event keeps them.
    const telemetry = JSON.stringify(events) + logs.all.join("\n");
    expect(telemetry).not.toContain(acceptance.from);
    expect(telemetry).not.toContain(acceptance.to);
    expect(telemetry).not.toContain(acceptance.to.slice(0, 20));
    expect(warnsWith("WORKFLOW_REPLAY_CHANGE_ACCEPTED").join("\n")).toContain(
      acceptance.to.slice(0, 19),
    );
    expect(
      result.workflowEvents.find((e) => e.type === "step_change_accepted"),
    ).toMatchObject({
      acceptance: { from: acceptance.from, to: acceptance.to, reason: REASON },
    });
  });

  test("model ids stay whole in spans and logs", async () => {
    const steps: StepSpec[] = [{ id: "s1", input: () => "one" }];
    const first = await turn(
      workflowOf(
        external("worker", { model: "claude-opus-5-5-20261101" }),
        steps,
      ),
    );
    spans.length = 0;
    await turn(
      workflowOf(
        external("worker", { model: "claude-sonnet-5-5-20261101" }),
        steps,
        {
          acceptChanges: [
            {
              executionId: EXECUTION,
              stepId: "s1",
              kind: "model",
              from: "claude-opus-5-5-20261101",
              to: "claude-sonnet-5-5-20261101",
              reason: REASON,
            },
          ],
        },
      ),
      first.state,
    );
    const accepted = spans
      .flatMap((span) => span.events)
      .find((e) => e.name === "step_change_accepted");
    expect(accepted?.attributes).toMatchObject({
      "adk.workflow.acceptance.from": "claude-opus-5-5-20261101",
      "adk.workflow.acceptance.to": "claude-sonnet-5-5-20261101",
    });
  });
});

describe("store round trip (test 22, acceptance part)", () => {
  async function accepted() {
    const first = await completedWithBig();
    const second = await turn(
      workflowOf(external("worker", { model: "m1" }), editedSteps, {
        acceptChanges: [await acceptInput({ approvedBy: "ops" })],
      }),
      first.state,
    );
    const checkpoint = checkpointOf(second.state);
    expect(checkpoint.steps.s1?.acceptances).toHaveLength(1);
    return checkpoint;
  }

  test("the ADK session store keeps acceptances", async () => {
    const checkpoint = await accepted();
    const store = new AdkSessionCheckpointStore();
    const write = await store.save({
      context: invocation(external("w"), {}),
      checkpoint,
    });
    const loaded = await store.load({
      context: invocation(external("w"), write.stateDelta),
      workflowId: WORKFLOW,
      executionId: EXECUTION,
    });
    expect(JSON.stringify(loaded)).toBe(JSON.stringify(checkpoint));
  });

  test("the file system store keeps acceptances byte for byte", async () => {
    const checkpoint = await accepted();
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "ckpt-acc-"));
    try {
      const store = new FileSystemWorkflowCheckpointStore({ root: directory });
      const ctx = invocation(external("w"), {});
      await store.save({
        context: ctx,
        checkpoint,
        expectedRevision: null,
        revision: await workflowCheckpointRevision(checkpoint),
      });
      const loaded = await store.load({
        context: ctx,
        workflowId: WORKFLOW,
        executionId: EXECUTION,
      });
      expect(JSON.stringify(loaded)).toBe(JSON.stringify(checkpoint));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
