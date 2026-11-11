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
import { ExternalAgentDefinitionRegistry } from "../../src/agents/agent-registry.js";
import type { ExternalAgentDefinition } from "../../src/agents/agent-schema.js";
import { ExternalAgent } from "../../src/agents/external-agent.js";
import { PlaceholderExternalAgentDriver } from "../../src/agents/external-agent-driver.js";
import type {
  ExternalAgentDriver,
  ExternalAgentEvent,
} from "../../src/agents/index.js";
import { CODEX_PROVIDER } from "../../src/agents/provider/schema.js";
import { ExternalAgentWorkflowFactory } from "../../src/workflows/agents/external-agent-workflow-factory.js";
import { FileSystemWorkflowCheckpointStore } from "../../src/workflows/checkpoint/file-system-checkpoint-store.js";
import type { WorkflowStepMismatchHint } from "../../src/workflows/checkpoint/input-diff.js";
import type { WorkflowCheckpointV1 } from "../../src/workflows/checkpoint/schema.js";
import {
  AdkSessionCheckpointStore,
  workflowCheckpointKey,
  workflowCheckpointRevision,
} from "../../src/workflows/checkpoint/store.js";
import { WorkflowError } from "../../src/workflows/contracts.js";
import { defineWorkflow } from "../../src/workflows/definition.js";
import type { WorkflowEvent } from "../../src/workflows/events.js";
import type { WorkflowReplayOptions } from "../../src/workflows/node-config.js";
import { WorkflowAgent } from "../../src/workflows/workflow-agent.js";

const EXECUTION = "inv-rc";
const WORKFLOW = "replay-changes";

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

interface Shape {
  model?: string;
  resolved?: string;
  fail?: boolean;
}

function external(name: string, shape: Shape = {}): ExternalAgent {
  const driver: ExternalAgentDriver = {
    providerId: CODEX_PROVIDER.id,
    ...(shape.model ? { model: shape.model } : {}),
    ...(shape.resolved ? { reportsResolvedModel: true } : {}),
    async *run() {
      if (shape.fail) throw new Error("driver failed");
      const events: ExternalAgentEvent[] = [
        {
          type: "started",
          providerId: CODEX_PROVIDER.id,
          ...(shape.resolved ? { model: shape.resolved } : {}),
        },
        { type: "output", content: "done" },
        { type: "completed", exitCode: 0 },
      ];
      yield* events;
    },
  };
  return new ExternalAgent({ name, provider: CODEX_PROVIDER, driver });
}

type StepSpec = { id: string; input: () => string };

function workflowOf(
  agent: BaseAgent,
  steps: StepSpec[],
  replay?: WorkflowReplayOptions,
  extra: {
    retryFailedSteps?: boolean;
    revision?: string;
    resumePolicy?: "retry";
  } = {},
): WorkflowAgent {
  return new WorkflowAgent({
    name: "wf",
    definition: defineWorkflow({
      id: WORKFLOW,
      version: "1",
      handler: async (ctx) => {
        for (const spec of steps) {
          try {
            await ctx.run({
              id: spec.id,
              agentName: agent.name,
              input: spec.input(),
              ...(extra.revision ? { agentRevision: extra.revision } : {}),
              ...(extra.resumePolicy
                ? { resumePolicy: extra.resumePolicy }
                : {}),
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
    ...(extra.retryFailedSteps ? { retryFailedSteps: true } : {}),
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
const types = (turnResult: Turn) =>
  turnResult.workflowEvents.map((e) => e.type);

const BIG = "abcdefghij".repeat(100);

describe("a changed input: the hint stays host-side", () => {
  async function changedInputTurn(replay?: WorkflowReplayOptions) {
    let text = BIG;
    const steps = [{ id: "s1", input: () => text }];
    const first = await turn(
      workflowOf(external("worker", { model: "m1" }), steps, replay),
    );
    expect(first.error).toBeUndefined();
    text = `${BIG.slice(0, 600)}EDITED${BIG.slice(606)}`;
    const second = await turn(
      workflowOf(external("worker", { model: "m1" }), steps, replay),
      first.state,
    );
    return { first, second };
  }

  test("a changed file is WORKFLOW_STEP_MISMATCH with mismatch input; the callback gets a window covering the edit", async () => {
    const hints: WorkflowStepMismatchHint[] = [];
    const { second } = await changedInputTurn({
      onStepMismatch: (hint) => {
        hints.push(hint);
      },
    });
    expect(second.error).toBeInstanceOf(WorkflowError);
    const error = second.error as WorkflowError;
    expect(error.code).toBe("WORKFLOW_STEP_MISMATCH");
    expect(error.details?.mismatch).toEqual(["input"]);
    expect(hints).toHaveLength(1);
    const hint = hints[0];
    expect(hint?.stepId).toBe("s1");
    if (!hint?.diff.available) throw new Error("expected a hint");
    // Canonical form of a string is the quoted JSON string: offset + 1.
    expect(hint.diff.firstDifference.start).toBeLessThanOrEqual(601);
    expect(hint.diff.firstDifference.end).toBeGreaterThan(601);
    expect(hint.diff.savedLength).toBe(BIG.length + 2);
    expect(warnsWith("WORKFLOW_STEP_MISMATCH_HINT")).toHaveLength(0);
  });

  test("without a callback one WORKFLOW_STEP_MISMATCH_HINT warn is logged", async () => {
    const { second } = await changedInputTurn();
    expect((second.error as WorkflowError).code).toBe("WORKFLOW_STEP_MISMATCH");
    const lines = warnsWith("WORKFLOW_STEP_MISMATCH_HINT");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("s1");
    expect(lines[0]).not.toContain("EDITED");
  });

  test("a throwing or rejecting callback is logged and the mismatch is still thrown", async () => {
    for (const make of [
      () => {
        throw new Error("callback boom");
      },
      () => Promise.reject(new Error("callback rejected")),
    ]) {
      logs.warn.length = 0;
      const { second } = await changedInputTurn({ onStepMismatch: make });
      expect((second.error as WorkflowError).code).toBe(
        "WORKFLOW_STEP_MISMATCH",
      );
      expect(warnsWith("WORKFLOW_STEP_MISMATCH_HINT")).toHaveLength(1);
    }
  });

  test("the callback is awaited before the mismatch is thrown, and its function survives construction", async () => {
    const order: string[] = [];
    const { second } = await changedInputTurn({
      onStepMismatch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("callback-done");
      },
    });
    order.push("turn-ended");
    expect(second.error).toBeDefined();
    expect(order).toEqual(["callback-done", "turn-ended"]);
  });

  test("the stored error, events and log lines carry no hint keys and no chunk digest (test 8)", async () => {
    const hints: WorkflowStepMismatchHint[] = [];
    const { first, second } = await changedInputTurn({
      onStepMismatch: (hint) => {
        hints.push(hint);
      },
    });
    const saved = checkpointOf(first.state).steps.s1;
    const chunks = saved?.inputDigest?.chunks ?? [];
    expect(chunks.length).toBeGreaterThan(1);
    const stored = checkpointOf(second.state);
    const everything = JSON.stringify({
      error: stored.error,
      events: second.workflowEvents,
      logs: logs.all,
    });
    for (const needle of [
      "firstDifference",
      "savedLength",
      "inputLength",
      "chunkSize",
      "EDITED",
      ...chunks,
    ]) {
      expect(everything, needle).not.toContain(needle);
    }
    // The first turn is a successful run: its events and logs carry no digest either.
    const firstDump = JSON.stringify({
      events: first.workflowEvents.filter((e) => e.type !== "checkpoint_saved"),
      logs: logs.all,
    });
    for (const chunk of chunks) expect(firstDump).not.toContain(chunk);
  });

  test("inputDigest false writes neither inputLength nor inputDigest and the hint says disabled", async () => {
    const hints: WorkflowStepMismatchHint[] = [];
    const { first } = await changedInputTurn({
      inputDigest: false,
      onStepMismatch: (hint) => {
        hints.push(hint);
      },
    });
    const step = checkpointOf(first.state).steps.s1;
    expect(step && "inputLength" in step).toBe(false);
    expect(step && "inputDigest" in step).toBe(false);
    expect(hints[0]?.diff).toEqual({ available: false, reason: "disabled" });
  });

  test("a checkpoint written without the fingerprint gives not-recorded", async () => {
    let text = BIG;
    const steps = [{ id: "s1", input: () => text }];
    const first = await turn(
      workflowOf(external("worker", { model: "m1" }), steps, {
        inputDigest: false,
      }),
    );
    text = `${BIG}!`;
    const hints: WorkflowStepMismatchHint[] = [];
    await turn(
      workflowOf(external("worker", { model: "m1" }), steps, {
        onStepMismatch: (h) => void hints.push(h),
      }),
      first.state,
    );
    expect(hints[0]?.diff).toEqual({
      available: false,
      reason: "not-recorded",
    });
  });

  test("a short input stores its length only, and the hint is the whole current form", async () => {
    let text = "short";
    const steps = [{ id: "s1", input: () => text }];
    const first = await turn(
      workflowOf(external("worker", { model: "m1" }), steps),
    );
    const step = checkpointOf(first.state).steps.s1;
    expect(step?.inputLength).toBe(7);
    expect(step && "inputDigest" in step).toBe(false);
    text = "shorter";
    const hints: WorkflowStepMismatchHint[] = [];
    await turn(
      workflowOf(external("worker", { model: "m1" }), steps, {
        onStepMismatch: (h) => void hints.push(h),
      }),
      first.state,
    );
    expect(hints[0]?.diff).toMatchObject({
      available: true,
      firstDifference: { start: 0, end: 9 },
    });
  });
});

describe("the hint is only for an input mismatch", () => {
  test("an agentRevision-only mismatch calls no callback and logs no hint", async () => {
    const hints: WorkflowStepMismatchHint[] = [];
    const steps = [{ id: "s1", input: () => BIG }];
    const first = await turn(
      workflowOf(external("worker", { model: "m1" }), steps, undefined, {
        revision: "r1",
      }),
    );
    const second = await turn(
      workflowOf(
        external("worker", { model: "m1" }),
        steps,
        { onStepMismatch: (hint) => void hints.push(hint) },
        { revision: "r2" },
      ),
      first.state,
    );
    expect((second.error as WorkflowError).details?.mismatch).toEqual([
      "agentRevision",
    ]);
    expect(hints).toHaveLength(0);
    const quiet = await turn(
      workflowOf(external("worker", { model: "m1" }), steps, undefined, {
        revision: "r3",
      }),
      first.state,
    );
    expect(quiet.error).toBeDefined();
    expect(warnsWith("WORKFLOW_STEP_MISMATCH_HINT")).toHaveLength(0);
  });
});

describe("strict mode and a retried failed step", () => {
  const steps = [{ id: "s1", input: () => "one" }];
  const strict: WorkflowReplayOptions = { modelChange: "mismatch" };

  for (const [label, extra] of [
    ["retryFailedSteps", { retryFailedSteps: true }],
    ["resumePolicy retry", { resumePolicy: "retry" as const }],
  ] as const) {
    test(`${label}: a failed step whose model changed re-executes with the new model`, async () => {
      const first = await turn(
        workflowOf(
          external("worker", { model: "m1", fail: true }),
          steps,
          strict,
          extra,
        ),
      );
      const second = await turn(
        workflowOf(external("worker", { model: "m2" }), steps, strict, extra),
        first.state,
      );
      expect(second.error).toBeUndefined();
      expect(types(second)).toContain("step_started");
      expect(checkpointOf(second.state).steps.s1?.model).toEqual({
        requested: "m2",
      });
    });
  }

  test("without a retry the recorded failure is still a strict model mismatch", async () => {
    const first = await turn(
      workflowOf(
        external("worker", { model: "m1", fail: true }),
        steps,
        strict,
      ),
    );
    const second = await turn(
      workflowOf(
        external("worker", { model: "m2", fail: true }),
        steps,
        strict,
      ),
      first.state,
    );
    expect((second.error as WorkflowError).details?.mismatch).toEqual([
      "model",
    ]);
  });
});

describe("model change, warn mode (tests 9, 10)", () => {
  const steps = [
    { id: "s1", input: () => "one" },
    { id: "s2", input: () => "two" },
  ];

  test("the step records the model it ran with", async () => {
    const first = await turn(
      workflowOf(external("worker", { model: "m1" }), steps),
    );
    const stored = checkpointOf(first.state);
    expect(stored.steps.s1?.model).toEqual({ requested: "m1" });
    const bare = await turn(workflowOf(external("worker"), steps));
    expect(checkpointOf(bare.state).steps.s1?.model).toEqual({});
  });

  test("a changed model replays with step_model_changed before step_replayed and one warn", async () => {
    const first = await turn(
      workflowOf(external("worker", { model: "m1", resolved: "m1-2026" }), [
        steps[0] as StepSpec,
      ]),
    );
    const second = await turn(
      workflowOf(external("worker", { model: "m2" }), [steps[0] as StepSpec]),
      first.state,
    );
    expect(second.error).toBeUndefined();
    const sequence = types(second);
    const changed = second.workflowEvents.find(
      (e) => e.type === "step_model_changed",
    );
    expect(changed).toMatchObject({
      type: "step_model_changed",
      stepId: "s1",
      savedRecorded: true,
      savedRequestedModel: "m1",
      savedResolvedModels: ["m1-2026"],
      requestedModel: "m2",
      action: "replayed",
    });
    expect(sequence.indexOf("step_model_changed")).toBeLessThan(
      sequence.indexOf("step_replayed"),
    );
    expect(sequence).not.toContain("step_started");
    expect(warnsWith("WORKFLOW_STEP_MODEL_CHANGED")).toHaveLength(1);
    // The saved record is history: it still names the model the step ran with.
    expect(checkpointOf(second.state).steps.s1?.model).toEqual({
      requested: "m1",
    });
  });

  test("an unchanged model emits nothing extra", async () => {
    const first = await turn(
      workflowOf(external("worker", { model: "m1" }), steps),
    );
    const second = await turn(
      workflowOf(external("worker", { model: "m1" }), steps),
      first.state,
    );
    expect(types(second)).not.toContain("step_model_changed");
    expect(warnsWith("WORKFLOW_STEP_MODEL_CHANGED")).toHaveLength(0);
  });

  test("a recorded failure replays with action replayed-failure", async () => {
    const first = await turn(
      workflowOf(external("worker", { model: "m1", fail: true }), [
        steps[0] as StepSpec,
      ]),
    );
    const second = await turn(
      workflowOf(external("worker", { model: "m2", fail: true }), [
        steps[0] as StepSpec,
      ]),
      first.state,
    );
    const changed = second.workflowEvents.find(
      (e) => e.type === "step_model_changed",
    );
    expect(changed).toMatchObject({ action: "replayed-failure" });
    const sequence = types(second);
    expect(sequence.indexOf("step_model_changed")).toBeLessThan(
      sequence.indexOf("step_failed"),
    );
  });

  test("a retry runs with the new model: no model event, the record is rewritten", async () => {
    const first = await turn(
      workflowOf(external("worker", { model: "m1", fail: true }), [
        steps[0] as StepSpec,
      ]),
    );
    const second = await turn(
      workflowOf(
        external("worker", { model: "m2" }),
        [steps[0] as StepSpec],
        undefined,
        { retryFailedSteps: true },
      ),
      first.state,
    );
    expect(types(second)).not.toContain("step_model_changed");
    const started = second.workflowEvents.find(
      (e) => e.type === "step_started",
    );
    expect(started).toMatchObject({ requestedModel: "m2" });
    expect(checkpointOf(second.state).steps.s1?.model).toEqual({
      requested: "m2",
    });
  });

  test("an old checkpoint (no model record): no per-step event, one UNRECORDED log with the count", async () => {
    const first = await turn(
      workflowOf(external("worker", { model: "m1" }), steps),
    );
    const stripped = structuredClone(checkpointOf(first.state));
    for (const step of Object.values(stripped.steps)) {
      delete (step as { model?: unknown }).model;
    }
    const second = await turn(
      workflowOf(external("worker", { model: "m2" }), steps),
      { ...first.state, [KEY]: stripped },
    );
    expect(second.error).toBeUndefined();
    expect(types(second)).not.toContain("step_model_changed");
    const lines = warnsWith("WORKFLOW_STEP_MODEL_UNRECORDED");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("2");
    expect(lines[0]).toContain("s1");
    expect(lines[0]).toContain("s2");
    expect(warnsWith("WORKFLOW_STEP_MODEL_CHANGED")).toHaveLength(0);
  });
});

describe("strict model mode (test 11)", () => {
  const steps = [{ id: "s1", input: () => "one" }];
  const strict: WorkflowReplayOptions = { modelChange: "mismatch" };

  test("a changed model is WORKFLOW_STEP_MISMATCH with mismatch model and both ids", async () => {
    const first = await turn(
      workflowOf(external("worker", { model: "m1" }), steps, strict),
    );
    const second = await turn(
      workflowOf(external("worker", { model: "m2" }), steps, strict),
      first.state,
    );
    const error = second.error as WorkflowError;
    expect(error.code).toBe("WORKFLOW_STEP_MISMATCH");
    expect(error.details).toMatchObject({
      mismatch: ["model"],
      savedRequestedModel: "m1",
      requestedModel: "m2",
    });
    expect(types(second)).not.toContain("step_model_changed");
    expect(types(second)).not.toContain("step_replayed");
  });

  test("an equal model replays", async () => {
    const first = await turn(
      workflowOf(external("worker", { model: "m1" }), steps, strict),
    );
    const second = await turn(
      workflowOf(external("worker", { model: "m1" }), steps, strict),
      first.state,
    );
    expect(second.error).toBeUndefined();
    expect(types(second)).toContain("step_replayed");
  });

  test("a saved step without a model record, or an agent without a model, is a mismatch", async () => {
    const first = await turn(
      workflowOf(external("worker", { model: "m1" }), steps),
    );
    const stripped = structuredClone(checkpointOf(first.state));
    delete (stripped.steps.s1 as { model?: unknown }).model;
    const unrecorded = await turn(
      workflowOf(external("worker", { model: "m1" }), steps, strict),
      { ...first.state, [KEY]: stripped },
    );
    expect((unrecorded.error as WorkflowError).details?.mismatch).toEqual([
      "model",
    ]);
    const noCurrent = await turn(
      workflowOf(external("worker"), steps, strict),
      first.state,
    );
    expect((noCurrent.error as WorkflowError).details?.mismatch).toEqual([
      "model",
    ]);
  });
});

describe("factory agents (test 12)", () => {
  class KeepingDriver extends PlaceholderExternalAgentDriver {
    readonly model?: string;
    constructor(id: string, options?: { model?: string }) {
      super(id);
      this.model = options?.model;
    }
    async *run(): AsyncGenerator<ExternalAgentEvent> {
      yield { type: "started", providerId: this.providerId };
      yield { type: "output", content: "done" };
      yield { type: "completed", exitCode: 0 };
    }
  }

  function factory(): ExternalAgentWorkflowFactory {
    const definition: ExternalAgentDefinition<{ model?: string }> = {
      provider: { id: "codex", name: "codex" },
      createDriver: (options) => new KeepingDriver("codex", options),
    };
    return new ExternalAgentWorkflowFactory({
      registry: new ExternalAgentDefinitionRegistry([
        definition as ExternalAgentDefinition,
      ]),
    });
  }

  test("a model change on a factory agent warns instead of mismatching", async () => {
    const step = [{ id: "s1", input: () => "x" }];
    const make = (model: string) => {
      const handle = factory().create({
        providerId: "codex",
        name: "worker",
        config: { description: "d", model },
      });
      return {
        agent: handle.agent as BaseAgent,
        revision: handle.descriptor.revision,
      };
    };
    const one = make("gpt-5.4");
    const two = make("gpt-5.5");
    expect(two.revision).toBe(one.revision);
    const first = await turn(
      workflowOf(one.agent, step, undefined, { revision: one.revision }),
    );
    const second = await turn(
      workflowOf(two.agent, step, undefined, { revision: two.revision }),
      first.state,
    );
    expect(second.error).toBeUndefined();
    expect(
      second.workflowEvents.find((e) => e.type === "step_model_changed"),
    ).toMatchObject({
      savedRequestedModel: "gpt-5.4",
      requestedModel: "gpt-5.5",
    });
  });
});

describe("telemetry (test 21)", () => {
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

  test("a model change adds a span event with the models and no content", async () => {
    const step = [{ id: "s1", input: () => "secret prompt text" }];
    const first = await turn(
      workflowOf(external("worker", { model: "m1" }), step),
    );
    spans.length = 0;
    await turn(
      workflowOf(external("worker", { model: "m2" }), step),
      first.state,
    );
    const events = spans.flatMap((span) => span.events);
    const changed = events.find((event) => event.name === "step_model_changed");
    expect(changed?.attributes).toMatchObject({
      "adk.workflow.step.id": "s1",
      "adk.workflow.step.saved_model": "m1",
      "adk.workflow.step.requested_model": "m2",
    });
    expect(JSON.stringify(events)).not.toContain("secret prompt");
  });
});

describe("store round trip (test 22)", () => {
  async function recorded() {
    const first = await turn(
      workflowOf(external("worker", { model: "m1" }), [
        { id: "s1", input: () => BIG },
      ]),
    );
    return checkpointOf(first.state);
  }

  test("the ADK session store keeps the new fields", async () => {
    const checkpoint = await recorded();
    const step = checkpoint.steps.s1;
    expect(step?.model).toEqual({ requested: "m1" });
    expect(step?.inputLength).toBe(BIG.length + 2);
    expect(step?.inputDigest?.chunks.length).toBeGreaterThan(1);
    const context = invocation(external("w"), {});
    const store = new AdkSessionCheckpointStore();
    const write = await store.save({ context, checkpoint });
    const loaded = await store.load({
      context: invocation(external("w"), write.stateDelta),
      workflowId: WORKFLOW,
      executionId: EXECUTION,
    });
    expect(JSON.stringify(loaded)).toBe(JSON.stringify(checkpoint));
  });

  test("the file system store keeps the new fields byte for byte", async () => {
    const checkpoint = await recorded();
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "ckpt-rt-"));
    try {
      const store = new FileSystemWorkflowCheckpointStore({ root: directory });
      const ctx = invocation(external("w"), {});
      const revision = await workflowCheckpointRevision(checkpoint);
      await store.save({
        context: ctx,
        checkpoint,
        expectedRevision: null,
        revision,
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
