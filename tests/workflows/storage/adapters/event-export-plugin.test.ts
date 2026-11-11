import { describe, expect, test } from "bun:test";
import {
  BaseAgent,
  createEvent,
  type Event,
  InMemorySessionService,
  type InvocationContext,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  Runner,
} from "@google/adk";
import type { Content } from "@google/genai";
import { defineWorkflow } from "../../../../src/workflows/definition.js";
import { WorkflowStorageError } from "../../../../src/workflows/storage/errors.js";
import { WorkflowEventExportPipeline } from "../../../../src/workflows/storage/event-export-pipeline.js";
import {
  WORKFLOW_EVENT_EXPORT_PLUGIN_NAME,
  WorkflowEventExportPlugin,
} from "../../../../src/workflows/storage/event-export-plugin.js";
import type { WorkflowEventRecord } from "../../../../src/workflows/storage/event-exporter.js";
import { InMemoryWorkflowEventExporter } from "../../../../src/workflows/storage/in-memory-event-exporter.js";
import { WorkflowAgent } from "../../../../src/workflows/workflow-agent.js";

/** Exporter whose appends never finish. */
class HangingExporter extends InMemoryWorkflowEventExporter {
  protected override appendRecords(): Promise<never> {
    return new Promise<never>(() => {});
  }
}

/** Exporter whose appends always fail with a non-retryable error. */
class ThrowingExporter extends InMemoryWorkflowEventExporter {
  protected override async appendRecords(): Promise<never> {
    throw new WorkflowStorageError("WORKFLOW_STORAGE_UNSUPPORTED", "boom", {
      retryable: false,
    });
  }
}

/** Yields one text event. */
class TextAgent extends BaseAgent {
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

/** Asks for input unless the turn answers it. */
class AskAgent extends BaseAgent {
  constructor() {
    super({ name: "ask" });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    const response = context.userContent?.parts?.find(
      (part) => part.functionResponse,
    )?.functionResponse;
    const part = response
      ? { text: `got ${JSON.stringify(response.response)}` }
      : {
          functionCall: {
            id: "ask-ask",
            name: REQUEST_INPUT_FUNCTION_CALL_NAME,
            args: { message: "?" },
          },
        };
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: { role: "model", parts: [part] },
      ...(response ? {} : { longRunningToolIds: ["ask-ask"] }),
    });
  }

  protected async *runLiveImpl() {}
}

/** Fails when it runs. */
class FailAgent extends BaseAgent {
  constructor() {
    super({ name: "fail" });
  }

  // biome-ignore lint/correctness/useYield: the agent fails before yielding.
  protected async *runAsyncImpl(): AsyncGenerator<Event> {
    throw new Error("agent failed");
  }

  protected async *runLiveImpl() {}
}

const START: Content = { role: "user", parts: [{ text: "start" }] };
const ANSWER: Content = {
  role: "user",
  parts: [
    {
      functionResponse: {
        id: "ask-ask",
        name: REQUEST_INPUT_FUNCTION_CALL_NAME,
        response: { value: 1 },
      },
    },
  ],
};

function waitingWorkflow() {
  return new WorkflowAgent({
    name: "wf",
    subAgents: [new TextAgent("pre"), new AskAgent()],
    definition: defineWorkflow({
      id: "waiting",
      version: "1",
      handler: async (ctx) => {
        await ctx.run({ id: "pre", agentName: "pre", input: ctx.inputText });
        const asked = await ctx.run({
          id: "ask",
          agentName: "ask",
          input: ctx.inputText,
        });
        return asked.output;
      },
    }),
  });
}

function failingWorkflow() {
  return new WorkflowAgent({
    name: "wf-fail",
    subAgents: [new TextAgent("pre"), new FailAgent()],
    definition: defineWorkflow({
      id: "failing",
      version: "1",
      handler: async (ctx) => {
        await ctx.run({ id: "pre", agentName: "pre", input: ctx.inputText });
        await ctx.run({ id: "fail", agentName: "fail", input: ctx.inputText });
        return "unreachable";
      },
    }),
  });
}

/** Runs the given turns on one session and returns the events of each. */
async function runTurns(
  agent: BaseAgent,
  turns: Content[],
  plugin?: WorkflowEventExportPlugin,
): Promise<{ events: Event[][]; errors: unknown[] }> {
  const sessions = new InMemorySessionService();
  const runner = new Runner({
    appName: "app",
    agent,
    sessionService: sessions,
    ...(plugin ? { plugins: [plugin] } : {}),
  });
  const { id } = await sessions.createSession({ appName: "app", userId: "u" });
  const events: Event[][] = [];
  const errors: unknown[] = [];
  for (const newMessage of turns) {
    const turn: Event[] = [];
    try {
      for await (const event of runner.runAsync({
        userId: "u",
        sessionId: id,
        newMessage,
      })) {
        turn.push(event);
      }
    } catch (error) {
      errors.push(error);
    }
    events.push(turn);
  }
  return { events, errors };
}

const workflowEventOf = (event: Event) =>
  event.customMetadata?.workflowEvent as
    | { type: string; executionId?: string }
    | undefined;

async function readAll(
  exporter: InMemoryWorkflowEventExporter,
  executionId: string,
): Promise<WorkflowEventRecord[]> {
  const records: WorkflowEventRecord[] = [];
  let after = 0;
  for (;;) {
    const page = await exporter.read({ executionId, afterSequence: after });
    records.push(...page.records);
    if (!page.hasMore) return records;
    after = page.nextAfterSequence;
  }
}

async function executionsOf(exporter: InMemoryWorkflowEventExporter) {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await exporter.listExecutions(cursor ? { cursor } : {});
    out.push(...page.items.map((item) => item.executionId));
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

const callback = (plugin: WorkflowEventExportPlugin, event: Event) =>
  plugin.onEventCallback({
    invocationContext: {
      invocationId: event.invocationId,
    } as InvocationContext,
    event,
  });

const workflowStarted = (invocationId: string, executionId: string) =>
  createEvent({
    invocationId,
    author: "wf",
    customMetadata: {
      workflowEvent: { type: "workflow_started", executionId, timestamp: 1 },
    },
  });

/** Deep copy that keeps the symbol keys `structuredClone` drops. */
function cloneEvent<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneEvent) as T;
  if (value === null || typeof value !== "object") return value;
  const copy: Record<string | symbol, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    copy[key] = cloneEvent((value as Record<string | symbol, unknown>)[key]);
  }
  return copy as T;
}

describe("WorkflowEventExportPlugin in a real Runner", () => {
  test("exports every event the Runner yields exactly once, in order, with a gapless sequence", async () => {
    const exporter = new InMemoryWorkflowEventExporter();
    const plugin = new WorkflowEventExportPlugin({ exporter });

    const { events, errors } = await runTurns(
      waitingWorkflow(),
      [START, START, ANSWER],
      plugin,
    );

    expect(errors).toEqual([]);
    const yielded = events.flat();
    const executions = await executionsOf(exporter);
    expect(executions).toHaveLength(1);
    const records = await readAll(exporter, executions[0] as string);
    expect(records.map((record) => record.id)).toEqual(
      yielded.map((event) => event.id),
    );
    expect(records.map((record) => record.sequence)).toEqual(
      records.map((_, index) => index + 1),
    );
    expect(new Set(records.map((record) => record.id)).size).toBe(
      records.length,
    );
  });

  test("exports workflow, step, checkpoint and agent-run events, including a waiting step and its answer", async () => {
    const exporter = new InMemoryWorkflowEventExporter();
    const plugin = new WorkflowEventExportPlugin({ exporter });

    const { events } = await runTurns(
      waitingWorkflow(),
      [START, START, ANSWER],
      plugin,
    );

    const [executionId] = await executionsOf(exporter);
    const records = await readAll(exporter, executionId as string);
    const typesOf = (kind: string) =>
      new Set(
        records.filter((r) => r.kind === kind).map((record) => record.type),
      );
    for (const type of [
      "workflow_started",
      "workflow_waiting",
      "workflow_completed",
      "checkpoint_saved",
    ]) {
      expect(typesOf("workflow").has(type)).toBe(true);
    }
    for (const type of [
      "step_started",
      "step_completed",
      "step_waiting",
      "step_replayed",
    ]) {
      expect(typesOf("step").has(type)).toBe(true);
    }
    expect(records.some((record) => record.kind === "agent_run")).toBe(true);

    // The waiting step is exported in the first turn, its answer in the last.
    const answerTurnIds = new Set((events[2] ?? []).map((event) => event.id));
    const answerRecords = records.filter((record) =>
      answerTurnIds.has(record.id),
    );
    expect(answerRecords.map((record) => record.type)).toContain(
      "workflow_completed",
    );
    const waiting = records.find((record) => record.type === "step_waiting");
    expect(waiting?.stepId).toBe("ask");
    expect(
      records.find((record) => record.type === "workflow_waiting"),
    ).toBeDefined();
  });

  test("exports the failed step and the error event of a failing workflow", async () => {
    const exporter = new InMemoryWorkflowEventExporter();
    const plugin = new WorkflowEventExportPlugin({ exporter });

    const { events } = await runTurns(failingWorkflow(), [START], plugin);
    // A run that throws skips the Runner's end-of-run callback.
    await plugin.pipeline.flush();

    const [executionId] = await executionsOf(exporter);
    const records = await readAll(exporter, executionId as string);
    expect(records.map((record) => record.id)).toEqual(
      events.flat().map((event) => event.id),
    );
    const types = records.map((record) => record.type);
    expect(types).toContain("step_failed");
    expect(types).toContain("error");
  });

  test("records of workflow events carry the execution id of the workflow events", async () => {
    const exporter = new InMemoryWorkflowEventExporter();
    const plugin = new WorkflowEventExportPlugin({ exporter });

    const { events } = await runTurns(waitingWorkflow(), [START], plugin);

    const expected = events
      .flat()
      .map((event) => workflowEventOf(event)?.executionId)
      .find((id) => id !== undefined);
    expect(expected).toBeDefined();
    expect(await executionsOf(exporter)).toEqual([expected as string]);
  });
});

describe("WorkflowEventExportPlugin.onEventCallback", () => {
  test("returns undefined for every kind of event without changing it", async () => {
    const exporter = new InMemoryWorkflowEventExporter();
    const plugin = new WorkflowEventExportPlugin({ exporter });
    const sample: Event[] = [
      workflowStarted("inv-1", "exec-1"),
      createEvent({
        invocationId: "inv-1",
        author: "pre",
        content: { role: "model", parts: [{ text: "hi" }] },
      }),
      createEvent({ invocationId: "inv-1", author: "pre", partial: true }),
      createEvent({
        invocationId: "inv-2",
        author: "pre",
        customMetadata: { workflowEvent: { type: 42 } },
      }),
    ];

    for (const event of sample) {
      const before = cloneEvent(event);
      const result = await callback(plugin, event);
      expect(result).toBeUndefined();
      expect(event).toEqual(before);
    }
  });

  test("returns undefined for malformed events and when the pipeline throws", async () => {
    const throwing = {
      offerAdkEvent() {
        throw new Error("pipeline broke");
      },
      offer() {
        throw new Error("pipeline broke");
      },
      async flush() {
        return 0;
      },
    } as unknown as WorkflowEventExportPipeline;
    const plugin = new WorkflowEventExportPlugin({ pipeline: throwing });

    expect(await callback(plugin, workflowStarted("i", "e"))).toBeUndefined();
    const real = new WorkflowEventExportPlugin({
      exporter: new InMemoryWorkflowEventExporter(),
    });
    for (const bad of [null, undefined, {}, { id: 1 }]) {
      expect(
        await real.onEventCallback({
          invocationContext: {} as InvocationContext,
          event: bad as unknown as Event,
        }),
      ).toBeUndefined();
    }
  });

  test("does not wait for a hanging exporter", async () => {
    const plugin = new WorkflowEventExportPlugin({
      exporter: new HangingExporter(),
      appendTimeoutMs: 60_000,
    });

    const started = performance.now();
    for (let index = 0; index < 20; index += 1) {
      await callback(plugin, workflowStarted(`inv-${index}`, `exec-${index}`));
    }

    expect(performance.now() - started).toBeLessThan(200);
  });

  test("exports a plain event under the execution last seen for its invocation", async () => {
    const exporter = new InMemoryWorkflowEventExporter();
    const plugin = new WorkflowEventExportPlugin({ exporter });
    const plain = createEvent({
      invocationId: "inv-1",
      author: "pre",
      content: { role: "model", parts: [{ text: "hi" }] },
    });
    const orphan = createEvent({
      invocationId: "inv-9",
      author: "pre",
      content: { role: "model", parts: [{ text: "hi" }] },
    });

    await callback(plugin, workflowStarted("inv-1", "exec-1"));
    await callback(plugin, plain);
    await callback(plugin, orphan);
    await plugin.afterRunCallback({
      invocationContext: {} as InvocationContext,
    });

    expect((await readAll(exporter, "exec-1")).map((r) => r.id)).toContain(
      plain.id,
    );
    expect(
      (await readAll(exporter, "invocation:inv-9")).map((r) => r.id),
    ).toEqual([orphan.id]);
  });

  test("remembers a bounded number of invocations", async () => {
    const exporter = new InMemoryWorkflowEventExporter();
    const plugin = new WorkflowEventExportPlugin({ exporter });
    const count = 3_000;
    for (let index = 0; index < count; index += 1) {
      await callback(plugin, workflowStarted(`inv-${index}`, `exec-${index}`));
    }
    const oldest = createEvent({ invocationId: "inv-0", author: "a" });
    const newest = createEvent({
      invocationId: `inv-${count - 1}`,
      author: "a",
    });
    await callback(plugin, oldest);
    await callback(plugin, newest);
    await plugin.afterRunCallback({
      invocationContext: {} as InvocationContext,
    });

    expect(
      (await readAll(exporter, `exec-${count - 1}`)).map((r) => r.id),
    ).toContain(newest.id);
    expect(
      (await readAll(exporter, "invocation:inv-0")).map((r) => r.id),
    ).toEqual([oldest.id]);
  });

  test("skips partial events unless includePartial is set", async () => {
    const partial = createEvent({
      invocationId: "inv-1",
      author: "a",
      partial: true,
      content: { role: "model", parts: [{ text: "chunk" }] },
    });
    const skipped = new InMemoryWorkflowEventExporter();
    const kept = new InMemoryWorkflowEventExporter();
    const byDefault = new WorkflowEventExportPlugin({ exporter: skipped });
    const included = new WorkflowEventExportPlugin({
      exporter: kept,
      includePartial: true,
    });

    for (const plugin of [byDefault, included]) {
      await callback(plugin, partial);
      await plugin.afterRunCallback({
        invocationContext: {} as InvocationContext,
      });
    }

    expect(await executionsOf(skipped)).toEqual([]);
    expect(
      (await readAll(kept, "invocation:inv-1")).map((record) => record.id),
    ).toEqual([partial.id]);
  });
});

describe("WorkflowEventExportPlugin.afterRunCallback", () => {
  const ctx = { invocationContext: {} as InvocationContext };

  test("exports the buffered records before it resolves", async () => {
    const exporter = new InMemoryWorkflowEventExporter();
    const plugin = new WorkflowEventExportPlugin({
      exporter,
      flushIntervalMs: 60_000,
    });
    await callback(plugin, workflowStarted("inv-1", "exec-1"));

    await plugin.afterRunCallback(ctx);

    expect(await readAll(exporter, "exec-1")).toHaveLength(1);
  });

  test("waits at most flushOnRunEndMs for an exporter that never answers", async () => {
    const plugin = new WorkflowEventExportPlugin({
      exporter: new HangingExporter(),
      appendTimeoutMs: 60_000,
      flushOnRunEndMs: 150,
    });
    await callback(plugin, workflowStarted("inv-1", "exec-1"));

    const started = performance.now();
    await plugin.afterRunCallback(ctx);
    const elapsed = performance.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(1_000);
  });

  test("does not wait when flushOnRunEndMs is 0", async () => {
    const plugin = new WorkflowEventExportPlugin({
      exporter: new HangingExporter(),
      appendTimeoutMs: 60_000,
      flushOnRunEndMs: 0,
    });
    await callback(plugin, workflowStarted("inv-1", "exec-1"));

    const started = performance.now();
    await plugin.afterRunCallback(ctx);

    expect(performance.now() - started).toBeLessThan(100);
  });

  test("resolves when the pipeline flush rejects", async () => {
    const pipeline = {
      offerAdkEvent: () => 0,
      flush: () => Promise.reject(new Error("flush broke")),
    } as unknown as WorkflowEventExportPipeline;
    const plugin = new WorkflowEventExportPlugin({ pipeline });

    await expect(plugin.afterRunCallback(ctx)).resolves.toBeUndefined();
  });
});

describe("WorkflowEventExportPlugin construction", () => {
  test("uses the default name, a custom name and a shared pipeline", () => {
    const exporter = new InMemoryWorkflowEventExporter();
    const pipeline = new WorkflowEventExportPipeline({ exporter });

    expect(new WorkflowEventExportPlugin({ exporter }).name).toBe(
      WORKFLOW_EVENT_EXPORT_PLUGIN_NAME,
    );
    expect(new WorkflowEventExportPlugin({ exporter, name: "mine" }).name).toBe(
      "mine",
    );
    expect(new WorkflowEventExportPlugin({ pipeline }).pipeline).toBe(pipeline);
  });

  test("throwing exporter does not make the callback fail", async () => {
    const plugin = new WorkflowEventExportPlugin({
      exporter: new ThrowingExporter(),
      retry: { maxAttempts: 1, initialDelayMs: 1 },
    });

    expect(await callback(plugin, workflowStarted("i", "e"))).toBeUndefined();
    await expect(
      plugin.afterRunCallback({ invocationContext: {} as InvocationContext }),
    ).resolves.toBeUndefined();
  });
});
