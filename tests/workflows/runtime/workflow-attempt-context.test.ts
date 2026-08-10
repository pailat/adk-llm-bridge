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
import type { WorkflowCheckpointV1 } from "../../../src/workflows/checkpoint/schema.js";
import type {
  LoadWorkflowCheckpointInput,
  SaveWorkflowCheckpointInput,
  WorkflowCheckpointStore,
} from "../../../src/workflows/checkpoint/store.js";
import {
  WORKFLOW_ATTEMPT_CONTEXT_STATE_KEY,
  type WorkflowAttemptContext,
  type WorkflowAttemptReplay,
  type WorkflowStepResult,
} from "../../../src/workflows/contracts.js";
import { defineWorkflow } from "../../../src/workflows/definition.js";
import type { WorkflowRuntimeHooks } from "../../../src/workflows/runtime/workflow-runtime.js";
import { WorkflowAgent } from "../../../src/workflows/workflow-agent.js";
import type {
  WorkspaceAdapter,
  WorkspaceLease,
  WorkspaceLeaseConflict,
  WorkspaceLeaseRequest,
} from "../../../src/workflows/workspace/workspace-adapter.js";

class RecordingAgent extends BaseAgent {
  calls = 0;
  readonly contexts: InvocationContext[] = [];
  failFirst = false;

  constructor(name = "worker") {
    super({ name });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.calls++;
    this.contexts.push(context);
    if (this.failFirst && this.calls === 1) {
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        errorMessage: "retry me",
      });
      return;
    }
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: { role: "model", parts: [{ text: `done-${this.calls}` }] },
    });
  }

  protected async *runLiveImpl() {}
}

class WaitingAgent extends BaseAgent {
  readonly started = deferred<void>();
  aborted = false;

  constructor() {
    super({ name: "writer" });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    yield* [] as Event[];
    this.started.resolve();
    try {
      await waitForAbort(context.abortSignal);
    } finally {
      this.aborted = true;
    }
  }

  protected async *runLiveImpl() {}
}

describe("workflow attempt durability context", () => {
  test("keeps one idempotency key across retries", async () => {
    const agent = new RecordingAgent();
    agent.failFirst = true;
    const attempts: WorkflowAttemptContext[] = [];
    const workflow = workflowAgent({
      id: "retry-key",
      executionId: "execution-1",
      agent,
      hooks: { beforeAttempt: (context) => void attempts.push(context) },
      handler: (ctx) =>
        ctx.run({
          id: "build",
          agentName: agent.name,
          input: "same input",
          retry: { maxAttempts: 2 },
        }),
      limits: { maxAttemptsPerStep: 2 },
    });

    await collect(workflow, invocation(workflow, "inv-retry"));

    expect(attempts.map((context) => context.attempt)).toEqual([1, 2]);
    expect(attempts[0]?.idempotencyKey).toBe(attempts[1]?.idempotencyKey);
    expect(agent.calls).toBe(2);
  });

  test("changes keys across steps, executions, and inputs", async () => {
    const stepA = await captureKey("execution-1", "step-a", "same");
    const stepB = await captureKey("execution-1", "step-b", "same");
    const otherExecution = await captureKey("execution-2", "step-a", "same");
    const otherInput = await captureKey("execution-1", "step-a", "changed");

    expect(new Set([stepA, stepB, otherExecution, otherInput]).size).toBe(4);
  });

  test("binds attempt context, idempotency, and replay to agent revision", async () => {
    const unversioned = await captureKey("execution-1", "step-a", "same");
    const versioned = await captureKey(
      "execution-1",
      "step-a",
      "same",
      "sha256:agent-v1",
    );
    expect(versioned).not.toBe(unversioned);

    const agent = new RecordingAgent();
    let captured: WorkflowAttemptContext | undefined;
    const workflow = workflowAgent({
      id: "revision-replay",
      executionId: "execution-1",
      agent,
      hooks: {
        beforeAttempt: (context) => {
          captured = context;
          return {
            idempotencyKey: context.idempotencyKey,
            agentRevision: "sha256:agent-v1",
            result: completedResult(context),
          };
        },
      },
      handler: (ctx) =>
        ctx.run({
          id: "publish",
          agentName: agent.name,
          agentRevision: "sha256:agent-v2",
          input: "payload",
        }),
    });

    await expect(
      collect(workflow, invocation(workflow, "inv-revision")),
    ).rejects.toMatchObject({
      code: "WORKFLOW_ATTEMPT_MISMATCH",
      details: {
        expectedAgentRevision: "sha256:agent-v2",
        actualAgentRevision: "sha256:agent-v1",
      },
    });
    expect(captured?.agentRevision).toBe("sha256:agent-v2");
    expect(agent.calls).toBe(0);
  });

  test("replays a confirmed outbox result on resume without invoking the agent", async () => {
    const agent = new RecordingAgent();
    const store = new MemoryCheckpointStore();
    let journal: WorkflowAttemptReplay | undefined;
    let failAfterOutbox = true;
    let resumed: WorkflowStepResult | undefined;
    const hooks: WorkflowRuntimeHooks = {
      beforeAttempt: (context) =>
        journal?.idempotencyKey === context.idempotencyKey
          ? journal
          : undefined,
      afterAttempt: (context, result) => {
        const {
          events: _events,
          replayed: _replayed,
          ...durableResult
        } = result;
        journal = {
          idempotencyKey: context.idempotencyKey,
          agentRevision: context.agentRevision,
          result: durableResult,
        };
        if (failAfterOutbox) {
          failAfterOutbox = false;
          throw new Error("simulated crash after outbox");
        }
      },
    };
    const workflow = workflowAgent({
      id: "outbox-resume",
      executionId: "execution-1",
      agent,
      hooks,
      checkpointStore: store,
      handler: async (ctx) => {
        resumed = await ctx.run({
          id: "publish",
          agentName: agent.name,
          input: "payload",
          resumePolicy: "retry",
        });
      },
    });

    await expect(
      collect(workflow, invocation(workflow, "inv-first")),
    ).rejects.toMatchObject({
      code: "WORKFLOW_EXECUTION_ERROR",
      message: "simulated crash after outbox",
    });
    expect(agent.calls).toBe(1);

    await collect(workflow, invocation(workflow, "inv-resume"));

    expect(agent.calls).toBe(1);
    expect(resumed).toMatchObject({
      id: "publish",
      status: "completed",
      attempts: 2,
      replayed: true,
    });
  });

  test("rejects a replay whose durable identity does not match", async () => {
    const agent = new RecordingAgent();
    const workflow = workflowAgent({
      id: "bad-replay",
      executionId: "execution-1",
      agent,
      hooks: {
        beforeAttempt: (context) => ({
          idempotencyKey: `${context.idempotencyKey}-wrong`,
          result: completedResult(context),
        }),
      },
      handler: (ctx) =>
        ctx.run({ id: "publish", agentName: agent.name, input: "payload" }),
    });

    await expect(
      collect(workflow, invocation(workflow, "inv-bad-replay")),
    ).rejects.toMatchObject({ code: "WORKFLOW_ATTEMPT_MISMATCH" });
    expect(agent.calls).toBe(0);
  });

  test("rejects runtime events in a journaled replay", async () => {
    const agent = new RecordingAgent();
    const workflow = workflowAgent({
      id: "event-replay",
      executionId: "execution-1",
      agent,
      hooks: {
        beforeAttempt: (context) => ({
          idempotencyKey: context.idempotencyKey,
          result: {
            ...completedResult(context),
            events: [
              createEvent({
                invocationId: "journal",
                author: context.agentName,
              }),
            ],
          },
        }),
      },
      handler: (ctx) =>
        ctx.run({ id: "publish", agentName: agent.name, input: "payload" }),
    });

    await expect(
      collect(workflow, invocation(workflow, "inv-event-replay")),
    ).rejects.toMatchObject({ code: "WORKFLOW_ATTEMPT_MISMATCH" });
    expect(agent.calls).toBe(0);
  });

  test("runs the durable outbox hook before the completion checkpoint", async () => {
    const ordering: string[] = [];
    const agent = new RecordingAgent();
    const store = new MemoryCheckpointStore((checkpoint) => {
      if (
        checkpoint.status === "running" &&
        checkpoint.steps.publish?.status === "completed"
      ) {
        ordering.push("checkpoint");
      }
    });
    const workflow = workflowAgent({
      id: "outbox-order",
      executionId: "execution-1",
      agent,
      checkpointStore: store,
      hooks: { afterAttempt: () => void ordering.push("outbox") },
      handler: (ctx) =>
        ctx.run({ id: "publish", agentName: agent.name, input: "payload" }),
    });

    await collect(workflow, invocation(workflow, "inv-order"));

    expect(ordering).toEqual(["outbox", "checkpoint"]);
  });

  test("projects fencing into isolated child state", async () => {
    const agent = new RecordingAgent();
    const workspace = new TestWorkspaceAdapter();
    let hookContext: WorkflowAttemptContext | undefined;
    const workflow = workflowAgent({
      id: "fenced-attempt",
      executionId: "execution-1",
      agent,
      hooks: {
        beforeAttempt: (context) => {
          hookContext = context;
        },
      },
      workspace,
      handler: (ctx) =>
        ctx.run({
          id: "write",
          agentName: agent.name,
          input: "edit",
          writePaths: ["src"],
        }),
    });
    const parent = invocation(workflow, "inv-fencing");

    await collect(workflow, parent);

    const projected =
      agent.contexts[0]?.session.state[WORKFLOW_ATTEMPT_CONTEXT_STATE_KEY];
    expect(projected).toEqual(hookContext);
    expect(projected).toMatchObject({
      workflowId: "fenced-attempt",
      executionId: "execution-1",
      stepId: "write",
      agentName: "worker",
      attempt: 1,
      workspace: {
        workspaceId: "repository",
        leaseId: "lease-1",
        fencingToken: 42,
        expiresAt: workspace.expiresAt,
      },
    });
    expect(() => JSON.stringify(projected)).not.toThrow();
    expect(parent.session.state).toEqual({ shared: true });
    expect(agent.contexts[0]?.session.state).not.toBe(parent.session.state);
  });

  test("aborts on lease loss without checkpointing stale success", async () => {
    const agent = new WaitingAgent();
    const workspace = new TestWorkspaceAdapter({ releaseFails: true });
    const store = new MemoryCheckpointStore();
    const workflow = workflowAgent({
      id: "lease-loss",
      executionId: "execution-1",
      agent,
      checkpointStore: store,
      workspace,
      handler: (ctx) =>
        ctx.run({
          id: "write",
          agentName: agent.name,
          input: "edit",
          writePaths: ["src"],
        }),
    });
    const execution = collect(workflow, invocation(workflow, "inv-loss"));
    await agent.started.promise;
    const reason = {
      code: "workspace_lease_lost",
      message: "lease expired during attempt",
      workspaceId: "repository",
      leaseId: "lease-1",
      fencingToken: 42,
    };
    workspace.loss.abort(reason);

    await expect(execution).rejects.toMatchObject({
      code: "WORKFLOW_WORKSPACE_LEASE_LOST",
      message: reason.message,
      details: { leaseLossReason: reason, fencingToken: 42 },
    });
    expect(agent.aborted).toBe(true);
    expect(workspace.releaseCalls).toBe(1);
    expect(store.checkpoint?.steps.write?.status).not.toBe("completed");
  });

  test("rejects a successful agent result when fencing is lost before commit", async () => {
    const agent = new RecordingAgent();
    const workspace = new TestWorkspaceAdapter();
    const store = new MemoryCheckpointStore();
    const reason = {
      code: "workspace_lease_lost",
      message: "fence superseded before checkpoint",
      workspaceId: "repository",
      leaseId: "lease-1",
      fencingToken: 42,
    };
    const workflow = workflowAgent({
      id: "late-lease-loss",
      executionId: "execution-1",
      agent,
      checkpointStore: store,
      workspace,
      hooks: { afterAttempt: () => workspace.loss.abort(reason) },
      handler: (ctx) =>
        ctx.run({
          id: "write",
          agentName: agent.name,
          input: "edit",
          writePaths: ["src"],
        }),
    });

    await expect(
      collect(workflow, invocation(workflow, "inv-late-loss")),
    ).rejects.toMatchObject({
      code: "WORKFLOW_WORKSPACE_LEASE_LOST",
      details: { leaseLossReason: reason },
    });
    expect(agent.calls).toBe(1);
    expect(store.checkpoint?.steps.write?.status).not.toBe("completed");
  });
});

class MemoryCheckpointStore implements WorkflowCheckpointStore {
  checkpoint?: WorkflowCheckpointV1;

  constructor(
    private readonly onSave: (
      checkpoint: WorkflowCheckpointV1,
    ) => void = () => {},
  ) {}

  async load(_input: LoadWorkflowCheckpointInput) {
    return this.checkpoint;
  }

  async save(input: SaveWorkflowCheckpointInput) {
    this.checkpoint = input.checkpoint;
    this.onSave(input.checkpoint);
    return {
      checkpointKey: `memory:${input.checkpoint.executionId}`,
      stateDelta: { checkpoint: input.checkpoint },
    };
  }
}

class TestWorkspaceAdapter implements WorkspaceAdapter {
  readonly loss = new AbortController();
  readonly expiresAt = Date.now() + 60_000;
  releaseCalls = 0;
  readonly #releaseFails: boolean;

  constructor(options: { releaseFails?: boolean } = {}) {
    this.#releaseFails = options.releaseFails ?? false;
  }

  async acquire(
    request: WorkspaceLeaseRequest,
  ): Promise<WorkspaceLease & { lossSignal: AbortSignal }> {
    return {
      ...request,
      leaseId: "lease-1",
      acquiredAt: Date.now(),
      fencingToken: 42,
      expiresAt: this.expiresAt,
      lossSignal: this.loss.signal,
      release: async () => {
        this.releaseCalls++;
        if (this.#releaseFails) throw new Error("release also failed");
        return true;
      },
    };
  }

  conflicts(
    _request: WorkspaceLeaseRequest,
  ): readonly WorkspaceLeaseConflict[] {
    return [];
  }
}

async function captureKey(
  executionId: string,
  stepId: string,
  input: string,
  agentRevision?: string,
): Promise<string> {
  const agent = new RecordingAgent();
  let captured: WorkflowAttemptContext | undefined;
  const workflow = workflowAgent({
    id: "key-identity",
    executionId,
    agent,
    hooks: {
      beforeAttempt: (context) => {
        captured = context;
      },
    },
    handler: (ctx) =>
      ctx.run({
        id: stepId,
        agentName: agent.name,
        ...(agentRevision ? { agentRevision } : {}),
        input,
      }),
  });
  await collect(workflow, invocation(workflow, `inv-${executionId}-${stepId}`));
  if (!captured) throw new Error("attempt context was not captured");
  return captured.idempotencyKey;
}

function workflowAgent({
  id,
  executionId,
  agent,
  handler,
  hooks,
  checkpointStore,
  workspace,
  limits,
}: {
  id: string;
  executionId: string;
  agent: BaseAgent;
  handler: Parameters<typeof defineWorkflow>[0]["handler"];
  hooks?: WorkflowRuntimeHooks;
  checkpointStore?: WorkflowCheckpointStore;
  workspace?: WorkspaceAdapter;
  limits?: Parameters<typeof defineWorkflow>[0]["limits"];
}): WorkflowAgent {
  return new WorkflowAgent({
    name: `workflow_${id.replaceAll("-", "_")}`,
    definition: defineWorkflow({ id, version: "1", handler, limits }),
    subAgents: [agent],
    runtimeHooks: hooks,
    checkpointStore,
    resolveExecutionId: () => executionId,
    ...(workspace
      ? { workspace: { workspaceId: "repository", adapter: workspace } }
      : {}),
  });
}

function completedResult(context: WorkflowAttemptContext): WorkflowStepResult {
  return {
    status: "completed",
    id: context.stepId,
    agentName: context.agentName,
    output: "journal result",
    attempts: context.attempt,
    startedAt: 1,
    completedAt: 2,
  };
}

function invocation(agent: BaseAgent, invocationId: string): InvocationContext {
  return new InvocationContext({
    invocationId,
    branch: "root",
    agent,
    userContent: { role: "user", parts: [{ text: "workflow input" }] },
    session: {
      id: `session-${invocationId}`,
      appName: "app",
      userId: "user",
      state: { shared: true },
      events: [],
      lastUpdateTime: 1,
    },
  });
}

async function collect(
  agent: BaseAgent,
  context: InvocationContext,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of agent.runAsync(context)) events.push(event);
  return events;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) throw new Error("expected an abort signal");
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}
