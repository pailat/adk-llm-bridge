/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import {
  BaseAgent,
  createEvent,
  type Event,
  InvocationContext,
} from "@google/adk";
import type { Content } from "@google/genai";
import { hashWorkflowSource } from "../../src/workflows/checkpoint/hash.js";
import type { WorkflowCheckpointV1 } from "../../src/workflows/checkpoint/schema.js";
import type {
  LoadWorkflowCheckpointInput,
  SaveWorkflowCheckpointInput,
  WorkflowCheckpointStore,
} from "../../src/workflows/checkpoint/store.js";
import { WorkflowError } from "../../src/workflows/contracts.js";
import { defineScriptWorkflow } from "../../src/workflows/definition.js";
import type { WorkflowEvent } from "../../src/workflows/events.js";
import {
  WORKFLOW_SCRIPT_PROTOCOL,
  WORKFLOW_SCRIPT_PROTOCOL_VERSION,
} from "../../src/workflows/sandbox/protocol.js";
import { QUICKJS_SYNC_CAPABILITIES } from "../../src/workflows/sandbox/quickjs-generator-runtime.js";
import type {
  WorkflowScriptGeneratorSession,
  WorkflowScriptRuntime,
  WorkflowScriptSessionOptions,
} from "../../src/workflows/sandbox/types.js";
import { ScriptWorkflowAgent } from "../../src/workflows/script-workflow-agent.js";

class ReplyAgent extends BaseAgent {
  calls = 0;
  readonly #outputs: readonly string[];

  constructor(name: string, outputs: readonly string[]) {
    super({ name });
    this.#outputs = outputs;
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.calls += 1;
    for (const output of this.#outputs) {
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        branch: context.branch,
        content: { role: "model", parts: [{ text: output }] },
      });
    }
  }

  protected async *runLiveImpl() {}
}

type ScriptGenerator = Generator<unknown, unknown, unknown>;

class GeneratorScriptRuntime implements WorkflowScriptRuntime {
  readonly capabilities = QUICKJS_SYNC_CAPABILITIES;
  readonly sessions: WorkflowScriptSessionOptions[] = [];
  readonly #factory: (options: WorkflowScriptSessionOptions) => ScriptGenerator;

  constructor(
    factory: (options: WorkflowScriptSessionOptions) => ScriptGenerator,
  ) {
    this.#factory = factory;
  }

  async createSession(
    options: WorkflowScriptSessionOptions,
  ): Promise<WorkflowScriptGeneratorSession> {
    this.sessions.push(options);
    const generator = this.#factory(options);
    let disposed = false;
    return {
      get disposed() {
        return disposed;
      },
      next(value) {
        return generator.next(value);
      },
      dispose() {
        disposed = true;
        generator.return(undefined);
      },
    };
  }
}

class MemoryCheckpointStore implements WorkflowCheckpointStore {
  checkpoint?: WorkflowCheckpointV1;

  async load(_input: LoadWorkflowCheckpointInput) {
    return this.checkpoint;
  }

  async save(input: SaveWorkflowCheckpointInput) {
    this.checkpoint = input.checkpoint;
    return {
      checkpointKey: `script:${input.checkpoint.executionId}`,
      stateDelta: { scriptCheckpoint: input.checkpoint },
    };
  }
}

function operation(op: string, payload: Record<string, unknown> = {}) {
  return {
    protocol: WORKFLOW_SCRIPT_PROTOCOL,
    version: WORKFLOW_SCRIPT_PROTOCOL_VERSION,
    op,
    ...payload,
  };
}

function invocation(
  agent: BaseAgent,
  input = "build it",
  abortSignal?: AbortSignal,
): InvocationContext {
  return new InvocationContext({
    invocationId: "inv-script-workflow",
    branch: "root",
    agent,
    userContent: { role: "user", parts: [{ text: input }] },
    session: {
      id: "session-1",
      appName: "app",
      userId: "user",
      state: {},
      events: [],
      lastUpdateTime: 1,
    },
    abortSignal,
  });
}

async function collect(agent: BaseAgent, context = invocation(agent)) {
  const events: Event[] = [];
  for await (const event of agent.runAsync(context)) events.push(event);
  return events;
}

function workflowEvents(events: readonly Event[]) {
  return events
    .map((event) => event.customMetadata?.workflowEvent)
    .filter(Boolean) as WorkflowEvent[];
}

describe("ScriptWorkflowAgent", () => {
  test("runs multiple script yields and streams child events in ADK", async () => {
    const planner = new ReplyAgent("planner", ["plan-a", "plan-b"]);
    const left = new ReplyAgent("left", ["left-result"]);
    const right = new ReplyAgent("right", ["right-result"]);
    const runtime = new GeneratorScriptRuntime(function* (options) {
      expect(options.input).toEqual({
        role: "user",
        parts: [{ text: "build it" }],
      });
      const plan = (yield operation("run", {
        step: { id: "plan", agentName: "planner", input: "build it" },
      })) as { output: string };
      yield operation("emit", {
        event: { type: "custom", name: "planned", data: plan.output },
      });
      const implementations = (yield operation("parallel", {
        steps: [
          { id: "left", agentName: "left", input: plan.output },
          { id: "right", agentName: "right", input: plan.output },
        ],
        options: { concurrency: 2 },
      })) as Array<{ output: string }>;
      return implementations.map((result) => result.output).join(" + ");
    });
    const observed: WorkflowEvent[] = [];
    const workflow = new ScriptWorkflowAgent({
      name: "script_workflow",
      definition: defineScriptWorkflow({
        id: "implementation",
        version: "1",
        source: "/* executed by the injected runtime */",
      }),
      subAgents: [planner, left, right],
      runtime,
      limits: { maxConcurrency: 2 },
      onEvent: (event) => observed.push(event),
    });

    const events = await collect(workflow);

    expect(workflow).toBeInstanceOf(BaseAgent);
    expect(events.filter((event) => event.author === "planner")).toHaveLength(
      2,
    );
    expect(events.find((event) => event.author === "planner")?.branch).toBe(
      "root.planner",
    );
    expect(events.at(-2)).toMatchObject({
      author: "script_workflow",
      content: {
        role: "model",
        parts: [{ text: "left-result + right-result" }],
      },
      turnComplete: true,
    });
    const lifecycle = workflowEvents(events).filter(
      (event) => event.type !== "checkpoint_saved",
    );
    expect(lifecycle.slice(0, 4).map((event) => event.type)).toEqual([
      "workflow_started",
      "step_started",
      "step_completed",
      "custom",
    ]);
    expect(
      lifecycle.filter((event) => event.type === "step_started"),
    ).toHaveLength(3);
    expect(
      lifecycle.filter((event) => event.type === "step_completed"),
    ).toHaveLength(3);
    expect(lifecycle.slice(-2).map((event) => event.type)).toEqual([
      "output",
      "workflow_completed",
    ]);
    expect(observed.map((event) => event.type)).toEqual(
      workflowEvents(events).map((event) => event.type),
    );
    expect(runtime.sessions[0]).toMatchObject({
      source: "/* executed by the injected runtime */",
      filename: "implementation.workflow.js",
      limits: { maxConcurrency: 2 },
    });
  });

  test("preserves structured final output authored by the workflow", async () => {
    const output: Content = {
      role: "model",
      parts: [{ text: "structured" }],
    };
    const runtime = new GeneratorScriptRuntime(function* () {
      yield operation("emit", {
        event: { type: "custom", name: "producing_output" },
      });
      return output;
    });
    const workflow = new ScriptWorkflowAgent({
      name: "script_workflow",
      definition: defineScriptWorkflow({
        id: "content",
        version: "1",
        source: "return structured;",
      }),
      runtime,
    });

    const events = await collect(workflow);
    expect(events.at(-2)?.author).toBe("script_workflow");
    expect(events.at(-2)?.content).toEqual(output);
  });

  test("rejects agents that are not directly declared", async () => {
    const runtime = new GeneratorScriptRuntime(function* () {
      yield operation("run", {
        step: { id: "hidden", agentName: "hidden", input: "task" },
      });
    });
    const workflow = new ScriptWorkflowAgent({
      name: "script_workflow",
      definition: defineScriptWorkflow({
        id: "unknown",
        version: "1",
        source: "yield ctx.run(hidden);",
      }),
      runtime,
    });

    await expect(collect(workflow)).rejects.toMatchObject({
      code: "WORKFLOW_UNKNOWN_AGENT",
    });
  });

  test("propagates cancellation through script and child execution", async () => {
    class WaitingAgent extends BaseAgent {
      protected async *runAsyncImpl(context: InvocationContext) {
        await new Promise<void>((resolve) => {
          context.abortSignal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      }
      protected async *runLiveImpl() {}
    }
    const runtime = new GeneratorScriptRuntime(function* () {
      yield operation("run", {
        step: { id: "wait", agentName: "waiting", input: "wait" },
      });
    });
    const waiting = new WaitingAgent({ name: "waiting" });
    const workflow = new ScriptWorkflowAgent({
      name: "script_workflow",
      definition: defineScriptWorkflow({
        id: "cancel",
        version: "1",
        source: "yield ctx.run(waiting);",
      }),
      subAgents: [waiting],
      runtime,
    });
    const controller = new AbortController();
    const execution = collect(
      workflow,
      invocation(workflow, "wait", controller.signal),
    );
    setTimeout(() => controller.abort(), 5);

    await expect(execution).rejects.toMatchObject({ code: "WORKFLOW_ABORTED" });
  });

  test("surfaces a stable error when the injected sandbox is unavailable", async () => {
    const unavailable: WorkflowScriptRuntime = {
      capabilities: QUICKJS_SYNC_CAPABILITIES,
      async createSession() {
        throw new WorkflowError(
          "WORKFLOW_SANDBOX_UNAVAILABLE",
          "QuickJS sandbox dependencies are unavailable",
        );
      },
    };
    const workflow = new ScriptWorkflowAgent({
      name: "script_workflow",
      definition: defineScriptWorkflow({
        id: "missing-sandbox",
        version: "1",
        source: "return 'never';",
      }),
      runtime: unavailable,
    });

    await expect(collect(workflow)).rejects.toMatchObject({
      code: "WORKFLOW_SANDBOX_UNAVAILABLE",
      message: "QuickJS sandbox dependencies are unavailable",
    });
  });

  test("checkpoints script source identity and replays completed steps", async () => {
    const source = "yield ctx.run(worker); return result.output;";
    const worker = new ReplyAgent("worker", ["implemented"]);
    const store = new MemoryCheckpointStore();
    const runtime = new GeneratorScriptRuntime(function* () {
      const result = (yield operation("run", {
        step: { id: "implement", agentName: "worker", input: "task" },
      })) as { output: string };
      return result.output;
    });
    const workflow = new ScriptWorkflowAgent({
      name: "script_workflow",
      definition: defineScriptWorkflow({
        id: "durable-script",
        version: "1",
        source,
      }),
      subAgents: [worker],
      runtime,
      checkpointStore: store,
      resolveExecutionId: () => "business-script-42",
    });

    const firstEvents = await collect(workflow);
    expect(worker.calls).toBe(1);
    expect(store.checkpoint).toMatchObject({
      workflowId: "durable-script",
      executionId: "business-script-42",
      sourceHash: await hashWorkflowSource(source),
      status: "completed",
    });

    const replayEvents = await collect(workflow);
    expect(worker.calls).toBe(1);
    expect(
      workflowEvents(replayEvents).some(
        (event) => event.type === "step_replayed",
      ),
    ).toBe(true);
    expect(replayEvents.at(-2)?.content?.parts?.[0]?.text).toBe("implemented");
    expect(firstEvents.at(-2)?.content?.parts?.[0]?.text).toBe("implemented");

    const changed = new ScriptWorkflowAgent({
      name: "changed_script_workflow",
      definition: defineScriptWorkflow({
        id: "durable-script",
        version: "1",
        source: `${source}\n// changed`,
      }),
      subAgents: [new ReplyAgent("worker", ["must-not-run"])],
      runtime,
      checkpointStore: store,
      resolveExecutionId: () => "business-script-42",
    });
    await expect(collect(changed)).rejects.toMatchObject({
      code: "WORKFLOW_SOURCE_MISMATCH",
    });
    expect(worker.calls).toBe(1);
  });
});
