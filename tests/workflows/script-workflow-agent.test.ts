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
import { AgentInvocationGateway } from "../../src/runtime/agent-invocation-gateway.js";
import {
  type WorkflowAgentDescriptor,
  type WorkflowAgentFactory,
  WorkflowAgentFactoryError,
  type WorkflowAgentFactoryRequest,
  type WorkflowAgentHandle,
} from "../../src/workflows/agents/workflow-agent-factory.js";
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
import {
  ScriptWorkflowAgent,
  type ScriptWorkflowAgentConfig,
} from "../../src/workflows/script-workflow-agent.js";
import { InMemoryWorkspaceAdapter } from "../../src/workflows/workspace/in-memory-workspace-adapter.js";

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

class TrackingAgentFactory implements WorkflowAgentFactory {
  readonly created: WorkflowAgentFactoryRequest[] = [];
  readonly released: string[] = [];
  readonly #handles = new Map<string, WorkflowAgentHandle>();
  readonly #createAgent: (request: WorkflowAgentFactoryRequest) => BaseAgent;

  constructor(
    createAgent: (request: WorkflowAgentFactoryRequest) => BaseAgent = (
      request,
    ) => new ReplyAgent(request.name, [`output:${request.name}`]),
  ) {
    this.#createAgent = createAgent;
  }

  create(request: WorkflowAgentFactoryRequest): WorkflowAgentHandle {
    if (request.providerId === "unknown") {
      throw new WorkflowAgentFactoryError(
        "WORKFLOW_AGENT_UNKNOWN_PROVIDER",
        "secret provider credential leaked",
      );
    }
    if (this.#handles.has(request.name)) {
      throw new WorkflowAgentFactoryError(
        "WORKFLOW_AGENT_DUPLICATE_NAME",
        "duplicate",
      );
    }
    const descriptor = {
      providerId: request.providerId,
      name: request.name,
    } satisfies WorkflowAgentDescriptor;
    const handle = {
      descriptor,
      agent: this.#createAgent(request),
    } satisfies WorkflowAgentHandle;
    this.created.push(request);
    this.#handles.set(request.name, handle);
    return handle;
  }

  get(name: string): WorkflowAgentHandle | undefined {
    return this.#handles.get(name);
  }

  list(): readonly WorkflowAgentDescriptor[] {
    return [...this.#handles.values()].map((handle) => handle.descriptor);
  }

  release(handle: WorkflowAgentHandle): boolean {
    if (this.#handles.get(handle.descriptor.name) !== handle) return false;
    this.#handles.delete(handle.descriptor.name);
    this.released.push(handle.descriptor.name);
    return true;
  }
}

class DynamicWaitingAgent extends BaseAgent {
  readonly started: Promise<void>;
  #markStarted!: () => void;

  constructor(name: string) {
    super({ name });
    this.started = new Promise((resolve) => {
      this.#markStarted = resolve;
    });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.#markStarted();
    await new Promise<void>((resolve) => {
      context.abortSignal?.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
  }

  protected async *runLiveImpl() {}
}

class ControlledDynamicAgent extends BaseAgent {
  readonly started: Promise<void>;
  #markStarted!: () => void;
  #proceed!: () => void;
  readonly #proceedPromise: Promise<void>;

  constructor(name: string) {
    super({ name });
    this.started = new Promise((resolve) => {
      this.#markStarted = resolve;
    });
    this.#proceedPromise = new Promise((resolve) => {
      this.#proceed = resolve;
    });
  }

  finish(): void {
    this.#proceed();
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.#markStarted();
    await this.#proceedPromise;
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: { role: "model", parts: [{ text: "finished" }] },
    });
  }

  protected async *runLiveImpl() {}
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
  invocationId = "inv-script-workflow",
): InvocationContext {
  return new InvocationContext({
    invocationId,
    branch: "root",
    agent,
    userContent: { role: "user", parts: [{ text: input }] },
    session: {
      id: `session-${invocationId}`,
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

function dynamicWorkflow(
  runtime: WorkflowScriptRuntime,
  createAgentFactory: NonNullable<
    ScriptWorkflowAgentConfig["createAgentFactory"]
  >,
  subAgents: BaseAgent[] = [],
): ScriptWorkflowAgent {
  return new ScriptWorkflowAgent({
    name: "dynamic_script_workflow",
    definition: defineScriptWorkflow({
      id: "dynamic-agents",
      version: "1",
      source: "/* executed by the injected runtime */",
    }),
    subAgents,
    runtime,
    createAgentFactory,
  });
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

  test("propagates workspace coordination to script steps", async () => {
    const workspace = new InMemoryWorkspaceAdapter();
    const worker = new ReplyAgent("worker", ["implemented"]);
    const runtime = new GeneratorScriptRuntime(function* () {
      const result = (yield operation("run", {
        step: {
          id: "implement",
          agentName: "worker",
          input: "task",
          writePaths: ["src/workflows"],
        },
      })) as { output: string };
      return result.output;
    });
    const workflow = new ScriptWorkflowAgent({
      name: "script_workflow",
      definition: defineScriptWorkflow({
        id: "workspace-script",
        version: "1",
        source: "yield ctx.run(implement);",
      }),
      subAgents: [worker],
      runtime,
      workspace: { workspaceId: "repo", adapter: workspace },
    });

    const events = await collect(workflow);
    expect(events.at(-2)?.content?.parts?.[0]?.text).toBe("implemented");
    expect(
      workspace.conflicts({
        workspaceId: "repo",
        ownerId: "verification",
        writePaths: ["src/workflows"],
      }),
    ).toEqual([]);
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

  test("forwards durable attempt hooks to script-created steps", async () => {
    const observed: Array<{ key: string; attempt: number; output: string }> =
      [];
    const workflow = new ScriptWorkflowAgent({
      name: "script_attempt_hooks",
      definition: defineScriptWorkflow({
        id: "script-attempt-hooks",
        version: "1",
        source: "yield ctx.run(step); return 'done';",
      }),
      subAgents: [new ReplyAgent("worker", ["implemented"])],
      runtime: new GeneratorScriptRuntime(function* () {
        yield operation("run", {
          step: { id: "implement", agentName: "worker", input: "task" },
        });
        return "done";
      }),
      resolveExecutionId: () => "script-attempt-execution",
      runtimeHooks: {
        afterAttempt(context, result) {
          observed.push({
            key: context.idempotencyKey,
            attempt: context.attempt,
            output: result.output,
          });
        },
      },
    });

    await collect(workflow);

    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ attempt: 1, output: "implemented" });
    expect(observed[0]?.key).toMatch(/^workflow-attempt-v1:/u);
  });

  test("spawns, lists, runs, and idempotently releases dynamic agents", async () => {
    const factory = new TrackingAgentFactory();
    const staticAgent = new ReplyAgent("static_worker", ["static"]);
    const runtime = new GeneratorScriptRuntime(function* () {
      const spawned = (yield operation("spawnAgent", {
        request: {
          providerId: "codex",
          name: "dynamic_worker",
          config: { instruction: "implement safely" },
        },
      })) as Record<string, unknown>;
      expect(spawned).toEqual({
        providerId: "codex",
        name: "dynamic_worker",
      });
      expect(Object.keys(spawned).sort()).toEqual(["name", "providerId"]);
      const listed = (yield operation("listAgents")) as unknown[];
      expect(listed).toEqual([{ providerId: "codex", name: "dynamic_worker" }]);
      expect(JSON.stringify(listed)).not.toContain("static_worker");
      const result = (yield operation("run", {
        step: {
          id: "implement",
          agentName: "dynamic_worker",
          input: "task",
        },
      })) as { output: string };
      expect(yield operation("releaseAgent", { name: "dynamic_worker" })).toBe(
        true,
      );
      expect(yield operation("releaseAgent", { name: "dynamic_worker" })).toBe(
        false,
      );
      expect(yield operation("listAgents")).toEqual([]);
      return result.output;
    });
    const workflow = dynamicWorkflow(runtime, () => factory, [staticAgent]);

    const events = await collect(workflow);

    expect(events.at(-2)?.content?.parts?.[0]?.text).toBe(
      "output:dynamic_worker",
    );
    expect(factory.created).toHaveLength(1);
    expect(factory.released).toEqual(["dynamic_worker"]);
  });

  test("cleans up dynamic handles after success, error, and abort", async () => {
    const successfulFactory = new TrackingAgentFactory();
    const successful = dynamicWorkflow(
      new GeneratorScriptRuntime(function* () {
        yield operation("spawnAgent", {
          request: { providerId: "codex", name: "success_worker" },
        });
        return "done";
      }),
      () => successfulFactory,
    );
    await collect(successful);
    expect(successfulFactory.released).toEqual(["success_worker"]);

    const failedFactory = new TrackingAgentFactory();
    const failed = dynamicWorkflow(
      new GeneratorScriptRuntime(function* () {
        yield operation("spawnAgent", {
          request: { providerId: "codex", name: "failed_worker" },
        });
        yield operation("unsupported");
      }),
      () => failedFactory,
    );
    await expect(collect(failed)).rejects.toMatchObject({
      code: "WORKFLOW_SCRIPT_INVALID",
    });
    expect(failedFactory.released).toEqual(["failed_worker"]);

    const waiting = new DynamicWaitingAgent("waiting_worker");
    const abortedFactory = new TrackingAgentFactory(() => waiting);
    const aborted = dynamicWorkflow(
      new GeneratorScriptRuntime(function* () {
        yield operation("spawnAgent", {
          request: { providerId: "codex", name: "waiting_worker" },
        });
        yield operation("run", {
          step: {
            id: "wait",
            agentName: "waiting_worker",
            input: "wait",
          },
        });
      }),
      () => abortedFactory,
    );
    const controller = new AbortController();
    const abortedExecution = collect(
      aborted,
      invocation(aborted, "wait", controller.signal, "dynamic-abort"),
    );
    await waiting.started;
    controller.abort();
    await expect(abortedExecution).rejects.toMatchObject({
      code: "WORKFLOW_ABORTED",
    });
    expect(abortedFactory.released).toEqual(["waiting_worker"]);
  });

  test("waits for runtime completion before cleanup on early iterator return", async () => {
    const controlled = new ControlledDynamicAgent("controlled_worker");
    const factory = new TrackingAgentFactory(() => controlled);
    const workflow = dynamicWorkflow(
      new GeneratorScriptRuntime(function* () {
        yield operation("spawnAgent", {
          request: { providerId: "codex", name: "controlled_worker" },
        });
        yield operation("run", {
          step: {
            id: "controlled",
            agentName: "controlled_worker",
            input: "wait",
          },
        });
        return "done";
      }),
      () => factory,
    );
    const iterator = workflow.runAsync(
      invocation(workflow, "wait", undefined, "early-return"),
    );
    await iterator.next();
    await controlled.started;

    let returned = false;
    const closing = iterator.return().then(() => {
      returned = true;
    });
    await Promise.resolve();
    expect(returned).toBe(false);
    expect(factory.released).toEqual([]);

    controlled.finish();
    await closing;
    expect(factory.released).toEqual(["controlled_worker"]);
  });

  test("rejects unknown, duplicate, static shadow, and static release operations", async () => {
    const shadowFactory = new TrackingAgentFactory();
    const shadow = dynamicWorkflow(
      new GeneratorScriptRuntime(function* () {
        yield operation("spawnAgent", {
          request: { providerId: "codex", name: "static_worker" },
        });
      }),
      () => shadowFactory,
      [new ReplyAgent("static_worker", ["static"])],
    );
    await expect(collect(shadow)).rejects.toThrow("cannot shadow static agent");
    expect(shadowFactory.created).toHaveLength(0);

    const duplicateFactory = new TrackingAgentFactory();
    const duplicate = dynamicWorkflow(
      new GeneratorScriptRuntime(function* () {
        yield operation("spawnAgent", {
          request: { providerId: "codex", name: "worker" },
        });
        yield operation("spawnAgent", {
          request: { providerId: "codex", name: "worker" },
        });
      }),
      () => duplicateFactory,
    );
    await expect(collect(duplicate)).rejects.toThrow("already exists");
    expect(duplicateFactory.released).toEqual(["worker"]);

    const releaseFactory = new TrackingAgentFactory();
    const staticRelease = dynamicWorkflow(
      new GeneratorScriptRuntime(function* () {
        yield operation("releaseAgent", { name: "static_worker" });
      }),
      () => releaseFactory,
      [new ReplyAgent("static_worker", ["static"])],
    );
    await expect(collect(staticRelease)).rejects.toThrow(
      "Static workflow agent cannot be released",
    );

    const unknownRelease = dynamicWorkflow(
      new GeneratorScriptRuntime(function* () {
        yield operation("releaseAgent", { name: "missing" });
      }),
      () => new TrackingAgentFactory(),
    );
    await expect(collect(unknownRelease)).rejects.toThrow(
      "Unknown dynamic workflow agent",
    );

    const unknownProvider = dynamicWorkflow(
      new GeneratorScriptRuntime(function* () {
        yield operation("spawnAgent", {
          request: { providerId: "unknown", name: "worker" },
        });
      }),
      () => new TrackingAgentFactory(),
    );
    const providerError = await collect(unknownProvider).catch(
      (error: unknown) => error,
    );
    expect(providerError).toMatchObject({
      code: "WORKFLOW_EXECUTION_ERROR",
      message: "Workflow dynamic agent spawn failed",
      details: { factoryCode: "WORKFLOW_AGENT_UNKNOWN_PROVIDER" },
    });
    expect(String(providerError)).not.toContain("secret provider credential");
  });

  test("isolates the same dynamic name across concurrent invocations", async () => {
    const factories: TrackingAgentFactory[] = [];
    const runtime = new GeneratorScriptRuntime(function* () {
      yield operation("spawnAgent", {
        request: { providerId: "codex", name: "shared_worker" },
      });
      const result = (yield operation("run", {
        step: {
          id: "work",
          agentName: "shared_worker",
          input: "task",
        },
      })) as { output: string };
      return result.output;
    });
    const workflow = dynamicWorkflow(runtime, () => {
      const number = factories.length + 1;
      const factory = new TrackingAgentFactory(
        (request) => new ReplyAgent(request.name, [`factory-${number}`]),
      );
      factories.push(factory);
      return factory;
    });

    const [first, second] = await Promise.all([
      collect(
        workflow,
        invocation(workflow, "first", undefined, "dynamic-first"),
      ),
      collect(
        workflow,
        invocation(workflow, "second", undefined, "dynamic-second"),
      ),
    ]);

    expect(factories).toHaveLength(2);
    expect(factories.map((factory) => factory.created[0]?.name)).toEqual([
      "shared_worker",
      "shared_worker",
    ]);
    expect(factories.map((factory) => factory.released)).toEqual([
      ["shared_worker"],
      ["shared_worker"],
    ]);
    expect(
      [first, second]
        .map((events) => events.at(-2)?.content?.parts?.[0]?.text)
        .sort(),
    ).toEqual(["factory-1", "factory-2"]);
  });

  test("rejects dynamic factories with a custom gateway", () => {
    const gateway = new AgentInvocationGateway({
      resolveAgent: () => undefined,
    });

    expect(
      () =>
        new ScriptWorkflowAgent({
          name: "unsafe_dynamic_gateway",
          definition: defineScriptWorkflow({
            id: "unsafe-dynamic-gateway",
            version: "1",
            source: "return 'never';",
          }),
          gateway,
          createAgentFactory: () => new TrackingAgentFactory(),
        }),
    ).toThrow("cannot be combined with a custom gateway");
  });
});
