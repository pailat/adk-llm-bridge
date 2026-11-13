import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BaseAgent,
  createEvent,
  type Event,
  InvocationContext,
  PluginManager,
} from "@google/adk";
import type { Content } from "@google/genai";
import { FileSystemWorkflowCheckpointStore } from "../../src/workflows/checkpoint/file-system-checkpoint-store.js";
import type { WorkflowCheckpointV1 } from "../../src/workflows/checkpoint/schema.js";
import {
  ADKSessionCheckpointStore,
  DEFAULT_WORKFLOW_CHECKPOINT_MAX_BYTES,
  type SaveWorkflowCheckpointInput,
  type WorkflowCheckpointStore,
  workflowCheckpointByteLength,
  workflowCheckpointSizeLimitError,
} from "../../src/workflows/checkpoint/store.js";
import type { WorkflowStep } from "../../src/workflows/contracts.js";
import { defineWorkflow } from "../../src/workflows/definition.js";
import {
  isWorkflowEvent,
  type WorkflowCheckpointSizeWarningEvent,
  type WorkflowEvent,
} from "../../src/workflows/events.js";
import {
  largestCheckpointContributors,
  reachesCheckpointSizeWarning,
  WORKFLOW_CHECKPOINT_SIZE_WARNING_RATIO,
} from "../../src/workflows/runtime/checkpoint-size.js";
import { WorkflowAgent } from "../../src/workflows/workflow-agent.js";

/**
 * Returns `size` characters of text and counts its runs (its side effect) in
 * `counter`, which a second instance for a resumed run can share.
 */
class SizedAgent extends BaseAgent {
  constructor(
    name: string,
    readonly size: number,
    readonly counter = { calls: 0 },
  ) {
    super({ name });
  }

  get calls(): number {
    return this.counter.calls;
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.counter.calls += 1;
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: { role: "model", parts: [{ text: "x".repeat(this.size) }] },
    });
  }

  protected async *runLiveImpl() {}
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

/** A custom store with its own size check and no `maxCheckpointBytes`. */
class LimitedMemoryStore extends MemoryStore {
  /** Every size error this store threw, in order. */
  readonly thrown: Error[] = [];

  constructor(readonly limit: number) {
    super();
  }

  override async save(input: SaveWorkflowCheckpointInput) {
    const bytes = workflowCheckpointByteLength(input.checkpoint);
    if (bytes > this.limit) {
      const error = workflowCheckpointSizeLimitError(
        "k",
        this.limit,
        bytes,
        "save",
      );
      this.thrown.push(error);
      throw error;
    }
    return super.save(input);
  }
}

/** A custom store that reports `maxCheckpointBytes` as given, valid or not. */
class ReportingMemoryStore extends MemoryStore {
  constructor(readonly maxCheckpointBytes: number) {
    super();
  }
}

const START: Content = { role: "user", parts: [{ text: "start" }] };

function turn(agent: BaseAgent, invocationId = "inv") {
  return new InvocationContext({
    pluginManager: new PluginManager(),
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
  });
}

async function drain(agent: BaseAgent, context: InvocationContext) {
  const events: Event[] = [];
  let error:
    | (Error & { code?: string; details?: Record<string, unknown> })
    | undefined;
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

const warnings = (events: readonly Event[]) =>
  workflowEvents(events).filter(
    (event): event is WorkflowCheckpointSizeWarningEvent =>
      event.type === "checkpoint_size_warning",
  );

function workflow(
  agents: readonly SizedAgent[],
  store: WorkflowCheckpointStore,
  options: {
    step?: Partial<WorkflowStep>;
    retryFailedSteps?: boolean;
  } = {},
) {
  return new WorkflowAgent({
    name: "workflow",
    subAgents: [...agents],
    checkpointStore: store,
    resolveExecutionId: () => "run-1",
    retryFailedSteps: options.retryFailedSteps,
    definition: defineWorkflow({
      id: "size",
      version: "1",
      handler: async (ctx) => {
        let last = "";
        for (const agent of agents) {
          last = (
            await ctx.run({
              id: agent.name,
              agentName: agent.name,
              input: "x",
              ...options.step,
            })
          ).output;
        }
        return `${last.length}`;
      },
    }),
  });
}

let roots: string[] = [];
async function fileStore(maxCheckpointBytes: number) {
  const root = await mkdtemp(join(tmpdir(), "ckpt-size-"));
  roots.push(root);
  return {
    root,
    store: new FileSystemWorkflowCheckpointStore({ root, maxCheckpointBytes }),
  };
}
afterEach(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
  roots = [];
});

describe("checkpoint size limit error", () => {
  test("names the step, the sizes and the largest contributors", async () => {
    const big = new SizedAgent("big", 25_000);
    const { store } = await fileStore(20_000);
    const run = workflow([big], store);

    const { error } = await drain(run, turn(run));

    expect(error?.code).toBe("WORKFLOW_EXECUTION_ERROR");
    const details = error?.details ?? {};
    expect(details.reason).toBe("checkpoint_size_limit_exceeded");
    expect(details.direction).toBe("save");
    expect(details.stepId).toBe("big");
    expect(details.maxBytes).toBe(20_000);
    expect(details.actualBytes as number).toBeGreaterThan(25_000);
    const contributors = details.largestContributors as {
      path: string[];
      bytes: number;
    }[];
    expect(contributors.length).toBeGreaterThan(0);
    expect(contributors.length).toBeLessThanOrEqual(5);
    const paths = contributors.map((entry) => entry.path.join("."));
    expect(paths).toContain("steps.big.result.output");
    expect(paths).not.toContain("steps.big.result.content");
    const sizes = contributors.map((entry) => entry.bytes);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    expect(sizes[0] as number).toBeGreaterThan(25_000);
    expect(error?.message).toContain("Workflow checkpoint exceeds size limit");
    expect(error?.message).toContain("step big");
    expect(error?.message).toContain(String(details.actualBytes));
    expect(error?.message).toContain("20000");
  });

  test("is enriched for a custom store without maxCheckpointBytes", async () => {
    const big = new SizedAgent("big", 25_000);
    const store = new LimitedMemoryStore(20_000);
    const run = workflow([big], store);

    const { error, events } = await drain(run, turn(run));

    expect(error?.details?.reason).toBe("checkpoint_size_limit_exceeded");
    expect(error?.details?.stepId).toBe("big");
    expect(error?.details?.largestContributors).toBeArray();
    // Without a known limit there is nothing to warn against.
    expect(warnings(events)).toEqual([]);
  });

  test("keeps the store's error as a non-persisted cause", async () => {
    const big = new SizedAgent("big", 25_000);
    const store = new LimitedMemoryStore(20_000);
    const run = workflow([big], store);

    const { error } = await drain(run, turn(run));

    expect(store.thrown).toHaveLength(1);
    expect(error).not.toBe(store.thrown[0]);
    expect((error as Error & { cause?: unknown }).cause).toBe(store.thrown[0]);
    const recorded = store.checkpoint?.steps.big?.error;
    expect(recorded?.details?.stepId).toBe("big");
    expect(recorded !== undefined && "cause" in recorded).toBe(false);
    expect(JSON.stringify(store.checkpoint)).not.toContain('"cause"');
  });

  test("keeps the enriched details in the step's recorded failure", async () => {
    const big = new SizedAgent("big", 25_000);
    const { root, store } = await fileStore(20_000);
    const run = workflow([big], store);
    await drain(run, turn(run));

    const reader = new FileSystemWorkflowCheckpointStore({ root });
    const saved = await reader.load({
      workflowId: "size",
      executionId: "run-1",
      context: turn(run),
    });

    expect(saved?.steps.big?.status).toBe("failed");
    expect(saved?.steps.big?.result).toBeUndefined();
    expect(saved?.steps.big?.error?.details).toMatchObject({
      reason: "checkpoint_size_limit_exceeded",
      stepId: "big",
    });
  });
});

describe("checkpoint size limit and resume", () => {
  test("the check runs after the step's side effects and the output is not saved", async () => {
    const big = new SizedAgent("big", 25_000);
    const { root, store } = await fileStore(20_000);
    const run = workflow([big], store);

    await drain(run, turn(run));

    expect(big.calls).toBe(1);
    const reader = new FileSystemWorkflowCheckpointStore({ root });
    const saved = await reader.load({
      workflowId: "size",
      executionId: "run-1",
      context: turn(run),
    });
    expect(saved?.status).toBe("failed");
    expect(JSON.stringify(saved)).not.toContain("x".repeat(1_000));
  });

  test("raising the limit alone replays the failure without running the step", async () => {
    const big = new SizedAgent("big", 25_000);
    const { root, store } = await fileStore(20_000);
    const first = workflow([big], store);
    await drain(first, turn(first));

    const raised = new FileSystemWorkflowCheckpointStore({
      root,
      maxCheckpointBytes: 1024 * 1024,
    });
    const second = workflow(
      [new SizedAgent("big", big.size, big.counter)],
      raised,
    );
    const { error } = await drain(second, turn(second));

    expect(big.calls).toBe(1);
    expect(error?.details?.reason).toBe("checkpoint_size_limit_exceeded");
  });

  for (const variant of [
    {
      name: "resumePolicy retry",
      options: { step: { resumePolicy: "retry" as const } },
    },
    { name: "retryFailedSteps", options: { retryFailedSteps: true } },
  ]) {
    test(`raising the limit with ${variant.name} completes by running the step again`, async () => {
      const big = new SizedAgent("big", 25_000);
      const { root, store } = await fileStore(20_000);
      const first = workflow([big], store, variant.options);
      await drain(first, turn(first));

      const raised = new FileSystemWorkflowCheckpointStore({
        root,
        maxCheckpointBytes: 1024 * 1024,
      });
      const second = workflow(
        [new SizedAgent("big", big.size, big.counter)],
        raised,
        variant.options,
      );
      const { error } = await drain(second, turn(second));

      expect(error).toBeUndefined();
      expect(big.calls).toBe(2);
      const saved = await raised.load({
        workflowId: "size",
        executionId: "run-1",
        context: turn(second),
      });
      expect(saved?.status).toBe("completed");
      expect(saved?.steps.big?.attempts).toBe(2);
    });
  }
});

describe("checkpoint size warning", () => {
  test("is emitted once per run when a save reaches 80% of the limit", async () => {
    const big = new SizedAgent("big", 82_000);
    const small = new SizedAgent("small", 10);
    const { store } = await fileStore(100_000);
    const run = workflow([big, small], store);

    const { error, events } = await drain(run, turn(run));

    expect(error).toBeUndefined();
    const found = warnings(events);
    expect(found).toHaveLength(1);
    const warning = found[0] as WorkflowCheckpointSizeWarningEvent;
    expect(isWorkflowEvent(warning)).toBe(true);
    expect(warning.stepId).toBe("big");
    expect(warning.maxBytes).toBe(100_000);
    expect(warning.bytes).toBeGreaterThanOrEqual(80_000);
    expect(warning.bytes).toBeLessThanOrEqual(100_000);
    expect(warning.checkpointKey).toBe(
      "__adk_llm_bridge_workflow_v1:size:run-1",
    );
    expect(
      warning.largestContributors.map((entry) => entry.path.join(".")),
    ).toContain("steps.big.result.output");
    // Later saves above the threshold do not warn again.
    const savedAfter = workflowEvents(events).filter(
      (event) => event.type === "checkpoint_saved",
    );
    const warningIndex = workflowEvents(events).indexOf(warning);
    expect(
      savedAfter.filter(
        (event) => workflowEvents(events).indexOf(event) > warningIndex,
      ).length,
    ).toBeGreaterThan(1);
    // The warning follows the checkpoint_saved event of the save that crossed the threshold.
    expect(workflowEvents(events)[warningIndex - 1]).toMatchObject({
      type: "checkpoint_saved",
      stepId: "big",
    });
    const title = events.find(
      (event) => event.customMetadata?.workflowEvent === warning,
    )?.customMetadata?.title;
    expect(title).toBe("Workflow size: checkpoint size warning");
  });

  test.each([0, -1, 1000.5, Number.NaN])(
    "is not emitted when a custom store reports maxCheckpointBytes %p",
    async (maxCheckpointBytes) => {
      const step = new SizedAgent("step", 1_000);
      const store = new ReportingMemoryStore(maxCheckpointBytes);
      const run = workflow([step], store);

      const { error, events } = await drain(run, turn(run));

      expect(error).toBeUndefined();
      // The checkpoint (about 3 KB) is above 80% of every finite value here.
      expect(
        workflowCheckpointByteLength(store.checkpoint as WorkflowCheckpointV1),
      ).toBeGreaterThan(1_001);
      expect(warnings(events)).toEqual([]);
    },
  );

  test("is not emitted below 80% of the limit", async () => {
    const small = new SizedAgent("small", 30_000);
    const { store } = await fileStore(100_000);
    const run = workflow([small], store);

    const { error, events } = await drain(run, turn(run));

    expect(error).toBeUndefined();
    expect(warnings(events)).toEqual([]);
  });

  test("threshold is 80% inclusive", () => {
    expect(WORKFLOW_CHECKPOINT_SIZE_WARNING_RATIO).toBe(0.8);
    expect(reachesCheckpointSizeWarning(799, 1_000)).toBe(false);
    expect(reachesCheckpointSizeWarning(800, 1_000)).toBe(true);
    expect(reachesCheckpointSizeWarning(1_000, 1_000)).toBe(true);
    expect(reachesCheckpointSizeWarning(3_355_443, 4_194_304)).toBe(false);
    expect(reachesCheckpointSizeWarning(3_355_444, 4_194_304)).toBe(true);
  });
});

describe("largestCheckpointContributors", () => {
  const base: WorkflowCheckpointV1 = {
    schemaVersion: 1,
    workflowId: "w",
    workflowVersion: "1",
    executionId: "e",
    inputHash: "h",
    status: "running",
    steps: {},
    startedAt: 1,
    updatedAt: 1,
  };

  test("ranks top-level fields, step fields and result fields by UTF-8 bytes", () => {
    const checkpoint: WorkflowCheckpointV1 = {
      ...base,
      input: { role: "user", parts: [{ text: "é".repeat(100) }] },
      steps: {
        a: {
          id: "a",
          agentName: "a",
          inputHash: "h",
          status: "completed",
          attempts: 1,
          startedAt: 1,
          updatedAt: 1,
          completedAt: 1,
          result: {
            id: "a",
            agentName: "a",
            status: "completed",
            output: "y".repeat(300),
            content: { role: "model", parts: [{ text: "y".repeat(300) }] },
            attempts: 1,
            startedAt: 1,
            completedAt: 1,
          },
        },
      },
    };

    const ranked = largestCheckpointContributors(checkpoint, 3);

    expect(ranked).toHaveLength(3);
    expect(ranked[0]?.path).toEqual(["steps", "a", "result", "content"]);
    expect(ranked[1]).toEqual({
      path: ["steps", "a", "result", "output"],
      bytes: 302,
    });
    // "é" is two UTF-8 bytes.
    expect(ranked[2]?.path).toEqual(["input"]);
    expect(ranked[2]?.bytes as number).toBeGreaterThan(200);
  });

  test("defaults to five entries", () => {
    const steps: WorkflowCheckpointV1["steps"] = {};
    for (let index = 0; index < 8; index++) {
      steps[`s${index}`] = {
        id: `s${index}`,
        agentName: "a",
        inputHash: "h",
        status: "running",
        attempts: 1,
        startedAt: 1,
        updatedAt: 1,
      };
    }
    expect(largestCheckpointContributors({ ...base, steps })).toHaveLength(5);
  });
});

describe("store limits", () => {
  test("built-in stores expose their configured limit", async () => {
    expect(new ADKSessionCheckpointStore().maxCheckpointBytes).toBe(
      DEFAULT_WORKFLOW_CHECKPOINT_MAX_BYTES,
    );
    expect(
      new ADKSessionCheckpointStore({ maxCheckpointBytes: 123 })
        .maxCheckpointBytes,
    ).toBe(123);
    const { store } = await fileStore(456);
    expect(store.maxCheckpointBytes).toBe(456);
  });
});
