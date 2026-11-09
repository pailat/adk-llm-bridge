import { describe, expect, test } from "bun:test";
import {
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  withWorkflowStepCompleted,
  withWorkflowStepFailed,
  withWorkflowStepRunning,
  withWorkflowStepWaiting,
} from "../../src/workflows/checkpoint/checkpoint.js";
import { FileSystemWorkflowCheckpointStore } from "../../src/workflows/checkpoint/file-system-checkpoint-store.js";
import { hashWorkflowInput } from "../../src/workflows/checkpoint/hash.js";
import {
  isWorkflowCheckpointV1,
  type WorkflowCheckpointV1,
} from "../../src/workflows/checkpoint/schema.js";
import type {
  SaveWorkflowCheckpointInput,
  WorkflowCheckpointStore,
} from "../../src/workflows/checkpoint/store.js";
import type {
  WorkflowStep,
  WorkflowStepFailure,
  WorkflowStepInterrupt,
} from "../../src/workflows/contracts.js";
import {
  defineScriptWorkflow,
  defineWorkflow,
} from "../../src/workflows/definition.js";
import type {
  WorkflowEvent,
  WorkflowStepStartedEvent,
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

/** Fails with an agent error for the first `failures` runs, then answers. */
class FlakyAgent extends BaseAgent {
  calls = 0;

  constructor(private readonly failures: number) {
    super({ name: "worker" });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.calls += 1;
    if (this.calls <= this.failures) {
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
      content: { role: "model", parts: [{ text: "done" }] },
    });
  }

  protected async *runLiveImpl() {}
}

const START: Content = { role: "user", parts: [{ text: "start" }] };

function workflowFor(
  agent: FlakyAgent,
  store: MemoryStore,
  step: { resumePolicy?: "retry"; retry?: { maxAttempts: number } },
) {
  return new WorkflowAgent({
    name: "workflow",
    subAgents: [agent],
    checkpointStore: store,
    resolveExecutionId: () => "run-1",
    definition: defineWorkflow({
      id: "resume-reason",
      version: "1",
      limits: { maxAttemptsPerStep: 2 },
      handler: async (ctx) => {
        const result = await ctx.run({
          id: "work",
          agentName: "worker",
          input: "task",
          ...step,
        });
        return result.output;
      },
    }),
  });
}

async function run(agent: BaseAgent, invocationId: string) {
  const context = new InvocationContext({
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
  const events: Event[] = [];
  for await (const event of agent.runAsync(context)) events.push(event);
  return events;
}

const startedEvents = (events: readonly Event[]) =>
  events
    .map((event) => event.customMetadata?.workflowEvent as WorkflowEvent)
    .filter(
      (event): event is WorkflowStepStartedEvent =>
        event?.type === "step_started",
    );

describe("step_started resumeReason", () => {
  test("a running step re-entered under resumePolicy retry reports 'interrupted'", async () => {
    const store = new MemoryStore();
    const first = workflowFor(new FlakyAgent(0), store, {
      resumePolicy: "retry",
    });
    const firstStarted = startedEvents(await run(first, "inv-1"));
    expect(firstStarted).toHaveLength(1);
    expect(firstStarted[0]?.attempt).toBe(1);
    expect(firstStarted[0]?.resumeReason).toBeUndefined();

    // Rewind the checkpoint to what a process killed mid-step leaves behind.
    const done = store.checkpoint as WorkflowCheckpointV1;
    const { output: _output, completedAt: _completedAt, ...rest } = done;
    const stepDone = done.steps.work as WorkflowCheckpointV1["steps"][string];
    const {
      result: _result,
      completedAt: _stepCompletedAt,
      resumeReason: _reason,
      ...stepRest
    } = stepDone;
    store.checkpoint = {
      ...rest,
      status: "running",
      steps: { work: { ...stepRest, status: "running" } },
    };

    const resumed = workflowFor(new FlakyAgent(0), store, {
      resumePolicy: "retry",
    });
    const started = startedEvents(await run(resumed, "inv-2"));
    expect(started).toHaveLength(1);
    expect(started[0]?.attempt).toBe(2);
    expect(started[0]?.resumeReason).toBe("interrupted");
    expect(store.checkpoint?.steps.work?.resumeReason).toBe("interrupted");
  });

  test("in-run retries report 'retry' and the first attempt reports nothing", async () => {
    const store = new MemoryStore();
    const workflow = workflowFor(new FlakyAgent(1), store, {
      retry: { maxAttempts: 2 },
    });
    const started = startedEvents(await run(workflow, "inv-1"));
    expect(started.map((event) => event.attempt)).toEqual([1, 2]);
    expect(started[0]?.resumeReason).toBeUndefined();
    expect(started[1]?.resumeReason).toBe("retry");
    expect(store.checkpoint?.steps.work?.resumeReason).toBe("retry");
  });
});

/** Asks for input on its first run and finishes once it is answered. */
class AskAgent extends BaseAgent {
  calls = 0;

  constructor() {
    super({ name: "worker" });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.calls += 1;
    const answered = context.userContent?.parts?.some(
      (part) => part.functionResponse,
    );
    if (answered) {
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        content: { role: "model", parts: [{ text: "answered" }] },
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
              id: "worker-ask",
              name: REQUEST_INPUT_FUNCTION_CALL_NAME,
              args: { message: "value?" },
            },
          },
        ],
      },
      longRunningToolIds: ["worker-ask"],
    });
  }

  protected async *runLiveImpl() {}
}

async function runWith(
  agent: BaseAgent,
  invocationId: string,
  userContent: Content,
) {
  const context = new InvocationContext({
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
  const events: Event[] = [];
  for await (const event of agent.runAsync(context)) events.push(event);
  return events;
}

describe("resumeReason across a waiting step", () => {
  test("a step re-entered as interrupted keeps the reason while waiting and after the answer", async () => {
    const store = new MemoryStore();
    const definition = defineWorkflow({
      id: "resume-reason-waiting",
      version: "1",
      handler: async (ctx) =>
        (
          await ctx.run({
            id: "work",
            agentName: "worker",
            input: "task",
            resumePolicy: "retry",
          })
        ).output,
    });
    const step: WorkflowStep = {
      id: "work",
      agentName: "worker",
      input: "task",
      resumePolicy: "retry",
    };
    // What a process killed during attempt 1 leaves behind.
    store.checkpoint = withWorkflowStepRunning(
      await createWorkflowCheckpoint({
        definition,
        executionId: "run-1",
        input: START,
        now: 1,
      }),
      step,
      await hashWorkflowInput(step.input),
      1,
      2,
    );
    const agent = new AskAgent();
    const workflow = new WorkflowAgent({
      name: "workflow",
      subAgents: [agent],
      checkpointStore: store,
      resolveExecutionId: () => "run-1",
      definition,
    });

    const reentered = startedEvents(await runWith(workflow, "inv-2", START));
    expect(reentered.map((event) => event.attempt)).toEqual([2]);
    expect(reentered[0]?.resumeReason).toBe("interrupted");
    expect(store.checkpoint?.steps.work?.status).toBe("waiting");
    expect(store.checkpoint?.steps.work?.resumeReason).toBe("interrupted");

    const answer: Content = {
      role: "user",
      parts: [
        {
          functionResponse: {
            id: "worker-ask",
            name: REQUEST_INPUT_FUNCTION_CALL_NAME,
            response: { value: 1 },
          },
        },
      ],
    };
    const continued = startedEvents(await runWith(workflow, "inv-3", answer));
    // The answer continues the same attempt: same number, no new reason.
    expect(continued.map((event) => event.attempt)).toEqual([2]);
    expect(continued[0]?.resumeReason).toBeUndefined();
    expect(agent.calls).toBe(2);
    expect(store.checkpoint?.status).toBe("completed");
    expect(store.checkpoint?.steps.work?.status).toBe("completed");
    expect(store.checkpoint?.steps.work?.resumeReason).toBe("interrupted");
  });
});

const unitDefinition = defineScriptWorkflow({
  id: "resume-reason-unit",
  version: "1",
  source: 'yield { type: "run", step: ctx.input };',
});
const unitStep: WorkflowStep = { id: "plan", agentName: "planner", input: "x" };

async function unitBase() {
  return {
    inputHash: await hashWorkflowInput(unitStep.input),
    checkpoint: await createWorkflowCheckpoint({
      definition: unitDefinition,
      executionId: "resume-reason-execution",
      input: "in",
      now: 1,
    }),
  };
}

const waitingInterrupt: WorkflowStepInterrupt = {
  kind: "input",
  functionCallIds: ["call-1"],
  requests: [{ functionCallId: "call-1" }],
  events: [{ author: "planner", content: { role: "model", parts: [] } }],
};

describe("resumeReason in step resolution and step records", () => {
  test("a running step re-entered under resumePolicy retry resolves as interrupted", async () => {
    const { inputHash, checkpoint } = await unitBase();
    const running = withWorkflowStepRunning(
      checkpoint,
      unitStep,
      inputHash,
      1,
      10,
    );
    expect(
      resolveWorkflowStep(
        running,
        { ...unitStep, resumePolicy: "retry" },
        inputHash,
      ),
    ).toEqual({ action: "execute", attempt: 2, resumeReason: "interrupted" });
  });

  test("a failed step run again resolves as retry", async () => {
    const { inputHash, checkpoint } = await unitBase();
    const failure: WorkflowStepFailure = {
      status: "failed",
      id: unitStep.id,
      agentName: unitStep.agentName,
      error: { code: "WORKFLOW_EXECUTION_ERROR", message: "boom" },
      attempts: 1,
      startedAt: 10,
      completedAt: 20,
    };
    const failed = withWorkflowStepFailed(
      withWorkflowStepRunning(checkpoint, unitStep, inputHash, 1, 10),
      failure,
      20,
    );
    expect(
      resolveWorkflowStep(failed, unitStep, inputHash, { retryFailed: true }),
    ).toEqual({ action: "execute", attempt: 2, resumeReason: "retry" });
  });

  test("withWorkflowStepRunning stores the reason on the step record", async () => {
    const { inputHash, checkpoint } = await unitBase();
    const running = withWorkflowStepRunning(
      checkpoint,
      unitStep,
      inputHash,
      2,
      10,
      "interrupted",
    );
    expect(running.steps.plan?.resumeReason).toBe("interrupted");
  });

  test("withWorkflowStepWaiting keeps the reason of the same attempt and drops it for a new one", async () => {
    const { inputHash, checkpoint } = await unitBase();
    const running = withWorkflowStepRunning(
      checkpoint,
      unitStep,
      inputHash,
      2,
      10,
      "interrupted",
    );
    const waiting = withWorkflowStepWaiting(
      running,
      unitStep,
      inputHash,
      2,
      waitingInterrupt,
      { role: "user", parts: [{ text: "in" }] },
      20,
    );
    expect(waiting.steps.plan?.resumeReason).toBe("interrupted");
    expect(isWorkflowCheckpointV1(waiting)).toBe(true);

    const completed = withWorkflowStepCompleted(
      waiting,
      {
        status: "completed",
        id: unitStep.id,
        agentName: unitStep.agentName,
        output: "done",
        attempts: 2,
        startedAt: 10,
        completedAt: 30,
      },
      30,
    );
    expect(completed.steps.plan?.resumeReason).toBe("interrupted");

    const nextAttempt = withWorkflowStepWaiting(
      running,
      unitStep,
      inputHash,
      3,
      waitingInterrupt,
      { role: "user", parts: [{ text: "in" }] },
      20,
    );
    expect(nextAttempt.steps.plan).not.toHaveProperty("resumeReason");
  });

  test("a step record with a resumeReason outside the union is rejected", async () => {
    const { inputHash, checkpoint } = await unitBase();
    const running = withWorkflowStepRunning(
      checkpoint,
      unitStep,
      inputHash,
      2,
      10,
      "retry",
    );
    expect(isWorkflowCheckpointV1(running)).toBe(true);
    for (const resumeReason of ["bogus", "", "RETRY", 1, null]) {
      const invalid = {
        ...running,
        steps: { plan: { ...running.steps.plan, resumeReason } },
      };
      expect(isWorkflowCheckpointV1(invalid)).toBe(false);
    }
  });
});

describe("resumeReason in stored checkpoints", () => {
  test("the file store rejects a stored resumeReason outside the union as checkpoint_file_corrupt", async () => {
    await withTemporaryRoot(async (root) => {
      const { inputHash, checkpoint } = await unitBase();
      const running = withWorkflowStepRunning(
        checkpoint,
        unitStep,
        inputHash,
        2,
        10,
        "interrupted",
      );
      await new FileSystemWorkflowCheckpointStore({ root }).save({
        context: fileStoreContext(),
        checkpoint: running,
        expectedRevision: null,
      });
      await expect(loadFrom(root, running)).resolves.toMatchObject({
        steps: { plan: { resumeReason: "interrupted" } },
      });

      const path = await findCheckpointPath(root);
      const envelope = JSON.parse(await readFile(path, "utf8"));
      envelope.checkpoint.steps.plan.resumeReason = "bogus";
      await writeFile(path, JSON.stringify(envelope), "utf8");
      await expect(loadFrom(root, running)).rejects.toMatchObject({
        code: "WORKFLOW_EXECUTION_ERROR",
        details: { reason: "checkpoint_file_corrupt" },
      });
    });
  });

  test("a stored checkpoint without resumeReason loads and resumes", async () => {
    await withTemporaryRoot(async (root) => {
      const definition = defineWorkflow({
        id: "resume-reason-legacy",
        version: "1",
        handler: async (ctx) =>
          (
            await ctx.run({
              id: "work",
              agentName: "worker",
              input: "task",
              resumePolicy: "retry",
            })
          ).output,
      });
      const step: WorkflowStep = {
        id: "work",
        agentName: "worker",
        input: "task",
        resumePolicy: "retry",
      };
      const legacy = withWorkflowStepRunning(
        await createWorkflowCheckpoint({
          definition,
          executionId: "run-1",
          input: START,
          now: 1,
        }),
        step,
        await hashWorkflowInput(step.input),
        1,
        2,
      );
      expect(legacy.steps.work).not.toHaveProperty("resumeReason");
      const store = new FileSystemWorkflowCheckpointStore({ root });
      await store.save({
        context: fileStoreContext(),
        checkpoint: legacy,
        expectedRevision: null,
      });
      const path = await findCheckpointPath(root);
      expect(await readFile(path, "utf8")).not.toContain("resumeReason");

      const workflow = new WorkflowAgent({
        name: "workflow",
        subAgents: [new FlakyAgent(0)],
        checkpointStore: store,
        resolveExecutionId: () => "run-1",
        definition,
      });
      const started = startedEvents(await runWith(workflow, "inv-2", START));
      expect(started.map((event) => event.attempt)).toEqual([2]);
      expect(started[0]?.resumeReason).toBe("interrupted");
      const reloaded = await loadFrom(root, legacy);
      expect(reloaded?.status).toBe("completed");
      expect(reloaded?.steps.work?.resumeReason).toBe("interrupted");
    });
  });
});

async function withTemporaryRoot(
  operation: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "adk-resume-reason-"));
  try {
    await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fileStoreContext(): InvocationContext {
  return new InvocationContext({
    pluginManager: new PluginManager(),
    invocationId: "execution-1",
    agent: new AskAgent(),
    session: {
      id: "session-1",
      appName: "app",
      userId: "user",
      state: {},
      events: [],
      lastUpdateTime: 1,
    },
  });
}

async function loadFrom(
  root: string,
  checkpoint: WorkflowCheckpointV1,
): Promise<WorkflowCheckpointV1 | undefined> {
  return await new FileSystemWorkflowCheckpointStore({ root }).load({
    context: fileStoreContext(),
    workflowId: checkpoint.workflowId,
    executionId: checkpoint.executionId,
  });
}

async function findCheckpointPath(root: string): Promise<string> {
  for (const shard of (await readdir(root)).sort()) {
    const shardPath = join(root, shard);
    if (!(await lstat(shardPath)).isDirectory()) continue;
    const file = (await readdir(shardPath)).find((name) =>
      name.endsWith(".json"),
    );
    if (file) return join(shardPath, file);
  }
  throw new Error("checkpoint file not found");
}
