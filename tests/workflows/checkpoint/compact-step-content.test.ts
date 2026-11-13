import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BaseAgent,
  createEvent,
  type Event,
  InvocationContext,
  PluginManager,
} from "@google/adk";
import type { Content, Part } from "@google/genai";
import { resolveWorkflowStep } from "../../../src/workflows/checkpoint/checkpoint.js";
import { FileSystemWorkflowCheckpointStore } from "../../../src/workflows/checkpoint/file-system-checkpoint-store.js";
import {
  isWorkflowCheckpointV1,
  toDurableWorkflowCheckpoint,
  type WorkflowCheckpointStepResultV1,
  type WorkflowCheckpointV1,
  workflowStepResultFromCheckpoint,
} from "../../../src/workflows/checkpoint/schema.js";
import {
  ADKSessionCheckpointStore,
  type WorkflowCheckpointStore,
  workflowCheckpointByteLength,
  workflowCheckpointRevision,
} from "../../../src/workflows/checkpoint/store.js";
import type { WorkflowStepResult } from "../../../src/workflows/contracts.js";
import { defineWorkflow } from "../../../src/workflows/definition.js";
import * as workflowsEntry from "../../../src/workflows/index.js";
import { WorkflowAgent } from "../../../src/workflows/workflow-agent.js";

/**
 * Checkpoints written by release/0.7.0 at commit 0b06133, before a step's
 * text was stored once: `fixtureWorkflow` below run against that commit with
 * both bundled stores (see the fixture's `meta`).
 */
const fixture = JSON.parse(
  await readFile(
    join(import.meta.dir, "fixtures", "pre-compact-0.7.0.json"),
    "utf8",
  ),
) as {
  files: Record<string, string>;
  sessionState: Record<string, unknown>;
};

const TEXT = "plain step text ✓ ünïcode";

function result(
  overrides: Partial<WorkflowCheckpointStepResultV1> = {},
): WorkflowCheckpointStepResultV1 {
  return {
    status: "completed",
    id: "s",
    agentName: "agent",
    output: TEXT,
    content: { role: "model", parts: [{ text: TEXT }] },
    attempts: 1,
    startedAt: 1,
    completedAt: 2,
    ...overrides,
  };
}

function checkpointWith(
  stepResult: WorkflowCheckpointStepResultV1,
): WorkflowCheckpointV1 {
  return {
    schemaVersion: 1,
    workflowId: "wf",
    workflowVersion: "1",
    executionId: "run",
    inputHash: "hash",
    status: "running",
    steps: {
      s: {
        id: "s",
        agentName: "agent",
        inputHash: "step-hash",
        status: "completed",
        attempts: 1,
        startedAt: 1,
        updatedAt: 2,
        completedAt: 2,
        result: stepResult,
      },
    },
    startedAt: 1,
    updatedAt: 2,
  };
}

const storedResult = (checkpoint: WorkflowCheckpointV1) =>
  checkpoint.steps.s?.result as WorkflowCheckpointStepResultV1;

describe("durable step content", () => {
  test("drops content that is the plain text of output and marks it", () => {
    const durable = toDurableWorkflowCheckpoint(checkpointWith(result()));
    const stored = storedResult(durable);
    expect(stored).not.toHaveProperty("content");
    expect(stored.contentFromOutput).toBe(true);
    expect(stored.output).toBe(TEXT);
    expect(isWorkflowCheckpointV1(durable)).toBe(true);
  });

  test("compaction is idempotent and keeps an already compact checkpoint", () => {
    const once = toDurableWorkflowCheckpoint(checkpointWith(result()));
    expect(toDurableWorkflowCheckpoint(once)).toBe(once);
  });

  test("also drops runtime-only fields while compacting", () => {
    const durable = toDurableWorkflowCheckpoint(
      checkpointWith({
        ...result(),
        events: [],
        replayed: true,
      } as WorkflowCheckpointStepResultV1),
    );
    const stored = storedResult(durable);
    expect(stored).not.toHaveProperty("events");
    expect(stored).not.toHaveProperty("replayed");
    expect(stored).not.toHaveProperty("content");
  });

  const kept: { name: string; content: Content; output?: string }[] = [
    { name: "a user role", content: { role: "user", parts: [{ text: TEXT }] } },
    { name: "no role", content: { parts: [{ text: TEXT }] } },
    {
      name: "two text parts",
      content: { role: "model", parts: [{ text: "plain " }, { text: "x" }] },
      output: "plain x",
    },
    {
      name: "a thought flag",
      content: { role: "model", parts: [{ text: TEXT, thought: false }] },
    },
    {
      name: "a part without text",
      content: { role: "model", parts: [{ functionCall: { name: "f" } }] },
    },
    {
      name: "text that differs from output",
      content: { role: "model", parts: [{ text: "other" }] },
    },
    {
      name: "an extra content field",
      content: { role: "model", parts: [{ text: TEXT }], extra: 1 } as Content,
    },
    { name: "no parts", content: { role: "model", parts: [] } },
    {
      name: "a second, empty text part",
      content: { role: "model", parts: [{ text: TEXT }, { text: "" }] },
    },
    {
      name: "a symbol key",
      content: {
        role: "model",
        parts: [{ text: TEXT }],
        [Symbol("extra")]: 1,
      } as Content,
    },
    {
      name: "a non-enumerable text",
      content: {
        role: "model",
        parts: [Object.defineProperty({}, "text", { value: TEXT })],
      },
    },
    {
      name: "a getter for the text",
      content: {
        role: "model",
        parts: [
          Object.defineProperty({}, "text", {
            enumerable: true,
            get: () => TEXT,
          }),
        ],
      },
    },
  ];
  test.each(kept)("keeps content with $name", ({ content, output }) => {
    const original = result({ content, ...(output ? { output } : {}) });
    const durable = toDurableWorkflowCheckpoint(checkpointWith(original));
    const stored = storedResult(durable);
    expect(stored.content).toEqual(content);
    expect(stored).not.toHaveProperty("contentFromOutput");
    expect(workflowStepResultFromCheckpoint(stored)).toEqual(original);
  });

  test("a result without content stays without content", () => {
    const { content: _content, ...withoutContent } = result();
    const durable = toDurableWorkflowCheckpoint(checkpointWith(withoutContent));
    const stored = storedResult(durable);
    expect(stored).not.toHaveProperty("content");
    expect(stored).not.toHaveProperty("contentFromOutput");
    expect(workflowStepResultFromCheckpoint(stored)).not.toHaveProperty(
      "content",
    );
  });

  test("an empty output compacts and rebuilds", () => {
    const original = result({
      output: "",
      content: { role: "model", parts: [{ text: "" }] },
    });
    const stored = storedResult(
      toDurableWorkflowCheckpoint(checkpointWith(original)),
    );
    expect(stored.contentFromOutput).toBe(true);
    expect(workflowStepResultFromCheckpoint(stored)).toEqual(original);
  });

  test("rebuilds the content on read and drops the marker", () => {
    const original = result();
    const stored = storedResult(
      toDurableWorkflowCheckpoint(checkpointWith(original)),
    );
    const rebuilt = workflowStepResultFromCheckpoint(stored);
    expect(rebuilt).toEqual(original);
    expect(rebuilt).not.toHaveProperty("contentFromOutput");
    // A fresh object each time: callers may mutate a replayed result.
    expect(rebuilt.content).not.toBe(
      workflowStepResultFromCheckpoint(stored).content,
    );
  });

  test("resolveWorkflowStep replays the rebuilt content", () => {
    const durable = toDurableWorkflowCheckpoint(checkpointWith(result()));
    const resolution = resolveWorkflowStep(
      durable,
      { id: "s", agentName: "agent", input: "x" },
      "step-hash",
    );
    expect(resolution).toEqual({
      action: "replay",
      result: { ...result(), replayed: true },
    });
  });

  const invalid: [string, Record<string, unknown>][] = [
    ["a marker that is not true", { contentFromOutput: false }],
    ["a string marker", { contentFromOutput: "yes" }],
    ["a marker with stored content", { contentFromOutput: true }],
    ["a null marker", { contentFromOutput: null }],
  ];
  test.each(invalid)("rejects a stored result with %s", (name, fields) => {
    const base: Record<string, unknown> = { ...result(), ...fields };
    if (name !== "a marker with stored content") delete base.content;
    expect(
      isWorkflowCheckpointV1(
        checkpointWith(base as unknown as WorkflowCheckpointStepResultV1),
      ),
    ).toBe(false);
  });

  test("the reader is exported from the workflows entry point", () => {
    expect(workflowsEntry.workflowStepResultFromCheckpoint).toBe(
      workflowStepResultFromCheckpoint,
    );
  });
});

class PartsAgent extends BaseAgent {
  constructor(
    name: string,
    readonly parts: Part[],
    readonly counter = { calls: 0 },
  ) {
    super({ name });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.counter.calls += 1;
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: { role: "model", parts: this.parts },
    });
  }

  protected async *runLiveImpl() {}
}

class FlakyAgent extends BaseAgent {
  constructor(readonly fail: boolean) {
    super({ name: "flaky" });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    if (this.fail) throw new Error("flaky failed on the first run");
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: { role: "model", parts: [{ text: "flaky ok" }] },
    });
  }

  protected async *runLiveImpl() {}
}

interface Captured {
  results: Record<string, WorkflowStepResult>;
}

function fixtureWorkflow(
  store: WorkflowCheckpointStore,
  options: {
    failFlaky: boolean;
    captured: Captured;
    counter?: { calls: number };
  },
) {
  const counter = options.counter ?? { calls: 0 };
  const agents = [
    new PartsAgent("plain", [{ text: TEXT }], counter),
    new PartsAgent("multi", [{ text: "first " }, { text: "second" }], counter),
    new FlakyAgent(options.failFlaky),
  ];
  return new WorkflowAgent({
    name: "workflow",
    subAgents: agents,
    checkpointStore: store,
    resolveExecutionId: () => "run-1",
    retryFailedSteps: !options.failFlaky,
    definition: defineWorkflow({
      id: "compact-fixture",
      version: "1",
      handler: async (ctx) => {
        const outputs: string[] = [];
        for (const id of ["plain", "multi", "flaky"]) {
          const stepResult = await ctx.run({ id, agentName: id, input: id });
          options.captured.results[id] = stepResult;
          outputs.push(stepResult.output);
        }
        return outputs.join("|");
      },
    }),
  });
}

function turn(agent: BaseAgent, state: Record<string, unknown> = {}) {
  return new InvocationContext({
    pluginManager: new PluginManager(),
    invocationId: "inv-2",
    agent,
    userContent: { role: "user", parts: [{ text: "start" }] },
    session: {
      id: "s",
      appName: "a",
      userId: "u",
      state,
      events: [],
      lastUpdateTime: 1,
    },
  });
}

async function drain(agent: BaseAgent, context: InvocationContext) {
  const events: Event[] = [];
  let error: (Error & { details?: Record<string, unknown> }) | undefined;
  try {
    for await (const event of agent.runAsync(context)) events.push(event);
  } catch (caught) {
    error = caught as typeof error;
  }
  return { events, error };
}

const PLAIN_CONTENT: Content = { role: "model", parts: [{ text: TEXT }] };
const MULTI_CONTENT: Content = {
  role: "model",
  parts: [{ text: "first " }, { text: "second" }],
};

let roots: string[] = [];
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "ckpt-compact-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
  roots = [];
});

async function onlyCheckpointFile(root: string) {
  const [path] = Object.keys(fixture.files);
  const raw = await readFile(join(root, path as string), "utf8");
  return { raw, envelope: JSON.parse(raw) };
}

describe("file-system store", () => {
  test("stores the step text once and replays the same content", async () => {
    const root = await tempRoot();
    const store = new FileSystemWorkflowCheckpointStore({ root });
    const first: Captured = { results: {} };
    const counter = { calls: 0 };
    const run = fixtureWorkflow(store, {
      failFlaky: true,
      captured: first,
      counter,
    });
    await drain(run, turn(run));

    const { raw, envelope } = await onlyCheckpointFile(root);
    const steps = envelope.checkpoint.steps;
    expect(steps.plain.result).not.toHaveProperty("content");
    expect(steps.plain.result.contentFromOutput).toBe(true);
    expect(steps.multi.result.content).toEqual(MULTI_CONTENT);
    expect(raw.split(TEXT).length - 1).toBe(1);

    const second: Captured = { results: {} };
    const resumed = fixtureWorkflow(
      new FileSystemWorkflowCheckpointStore({ root }),
      {
        failFlaky: false,
        captured: second,
        counter,
      },
    );
    const { error } = await drain(resumed, turn(resumed));
    expect(error).toBeUndefined();
    expect(counter.calls).toBe(2);
    expect(second.results.plain?.content).toEqual(PLAIN_CONTENT);
    expect(second.results.plain?.replayed).toBe(true);
    expect(second.results.plain).not.toHaveProperty("contentFromOutput");
    expect(second.results.multi?.content).toEqual(MULTI_CONTENT);
    const {
      content: _a,
      replayed: _b,
      events: _c,
      ...firstPlain
    } = first.results.plain as WorkflowStepResult;
    const {
      content: _d,
      replayed: _e,
      events: _f,
      ...secondPlain
    } = second.results.plain as WorkflowStepResult;
    expect(secondPlain).toEqual(firstPlain);
    expect(first.results.plain?.content).toEqual(PLAIN_CONTENT);
  });

  test("a text-heavy step uses about half the bytes", async () => {
    const size = 200_000;
    const root = await tempRoot();
    const big = new PartsAgent("big", [{ text: "x".repeat(size) }]);
    const run = new WorkflowAgent({
      name: "workflow",
      subAgents: [big],
      checkpointStore: new FileSystemWorkflowCheckpointStore({
        root,
        maxCheckpointBytes: Math.floor(size * 1.5),
      }),
      resolveExecutionId: () => "run-1",
      definition: defineWorkflow({
        id: "big",
        version: "1",
        handler: async (ctx) =>
          (
            await ctx.run({ id: "big", agentName: "big", input: "x" })
          ).output.length.toString(),
      }),
    });
    const { error } = await drain(run, turn(run));
    expect(error).toBeUndefined();
  });

  test("loads a checkpoint written before compaction and compacts it on the next save", async () => {
    const root = await tempRoot();
    for (const [path, contents] of Object.entries(fixture.files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), contents);
    }
    const before = (await onlyCheckpointFile(root)).envelope;
    expect(before.checkpoint.steps.plain.result.content).toEqual(PLAIN_CONTENT);
    expect(before.checkpoint.steps.plain.result).not.toHaveProperty(
      "contentFromOutput",
    );

    const captured: Captured = { results: {} };
    const counter = { calls: 0 };
    const resumed = fixtureWorkflow(
      new FileSystemWorkflowCheckpointStore({ root }),
      {
        failFlaky: false,
        captured,
        counter,
      },
    );
    const { error } = await drain(resumed, turn(resumed));

    expect(error).toBeUndefined();
    expect(counter.calls).toBe(0);
    expect(captured.results.plain?.replayed).toBe(true);
    expect(captured.results.plain?.output).toBe(TEXT);
    expect(captured.results.plain?.content).toEqual(PLAIN_CONTENT);
    expect(captured.results.multi?.content).toEqual(MULTI_CONTENT);
    expect(captured.results.flaky?.output).toBe("flaky ok");

    const after = (await onlyCheckpointFile(root)).envelope;
    expect(after.checkpoint.status).toBe("completed");
    expect(after.checkpoint.steps.plain.result).not.toHaveProperty("content");
    expect(after.checkpoint.steps.plain.result.contentFromOutput).toBe(true);
    expect(after.checkpoint.steps.multi.result.content).toEqual(MULTI_CONTENT);
    expect(after.revision).toBe(
      await workflowCheckpointRevision(after.checkpoint),
    );
  });

  test("the store returns the compact form of an old file with its canonical revision", async () => {
    const root = await tempRoot();
    for (const [path, contents] of Object.entries(fixture.files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), contents);
    }
    const store = new FileSystemWorkflowCheckpointStore({ root });
    const loaded = await store.load({
      context: turn(new PartsAgent("x", [])),
      workflowId: "compact-fixture",
      executionId: "run-1",
    });
    expect(loaded).toBeDefined();
    const stored = loaded?.steps.plain
      ?.result as WorkflowCheckpointStepResultV1;
    expect(stored.contentFromOutput).toBe(true);
    expect(workflowStepResultFromCheckpoint(stored).content).toEqual(
      PLAIN_CONTENT,
    );
  });
});

describe("ADK session store", () => {
  test("loads a session checkpoint written before compaction", async () => {
    const captured: Captured = { results: {} };
    const counter = { calls: 0 };
    const resumed = fixtureWorkflow(new ADKSessionCheckpointStore(), {
      failFlaky: false,
      captured,
      counter,
    });
    const state = structuredClone(fixture.sessionState) as Record<
      string,
      unknown
    >;
    const { events, error } = await drain(resumed, turn(resumed, state));

    expect(error).toBeUndefined();
    expect(counter.calls).toBe(0);
    expect(captured.results.plain?.content).toEqual(PLAIN_CONTENT);
    expect(captured.results.multi?.content).toEqual(MULTI_CONTENT);

    const [key] = Object.keys(fixture.sessionState);
    const deltas = events
      .map((event) => event.actions?.stateDelta?.[key as string])
      .filter(Boolean) as WorkflowCheckpointV1[];
    const last = deltas.at(-1) as WorkflowCheckpointV1;
    expect(last.status).toBe("completed");
    const plain = last.steps.plain?.result as WorkflowCheckpointStepResultV1;
    expect(plain).not.toHaveProperty("content");
    expect(plain.contentFromOutput).toBe(true);
  });

  test("the compact session value is smaller than the old one", () => {
    const [value] = Object.values(fixture.sessionState);
    const old = value as unknown as WorkflowCheckpointV1;
    expect(isWorkflowCheckpointV1(old)).toBe(true);
    const compact = toDurableWorkflowCheckpoint(old);
    expect(workflowCheckpointByteLength(compact)).toBeLessThan(
      workflowCheckpointByteLength(old) - TEXT.length,
    );
  });
});
