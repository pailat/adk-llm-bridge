/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import {
  BaseAgent,
  createEvent,
  InvocationContext,
  PluginManager,
} from "@google/adk";
import { AgentInvocationGateway } from "../../../src/runtime/agent-invocation-gateway.js";
import {
  type AdkWorkflowTaskCapabilityBinder,
  AdkWorkflowTaskDriver,
  AdkWorkflowTaskDriverError,
} from "../../../src/workflows/tasks/adk-workflow-task-driver.js";
import type {
  WorkflowTaskDriverRequest,
  WorkflowTaskJsonValue,
  WorkflowTaskRecord,
} from "../../../src/workflows/tasks/contracts.js";

class TestAgent extends BaseAgent {
  context?: InvocationContext;

  constructor(
    name = "worker",
    private readonly run: (
      context: InvocationContext,
    ) => Promise<string> = async () => "done",
  ) {
    super({ name });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.context = context;
    const output = await this.run(context);
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: { role: "model", parts: [{ text: output }] },
      turnComplete: true,
    });
  }

  protected async *runLiveImpl() {}
}

function parentContext(agent: BaseAgent): InvocationContext {
  return new InvocationContext({
    invocationId: "inv-task",
    branch: "root",
    agent,
    userContent: { role: "user", parts: [{ text: "parent" }] },
    session: {
      id: "session-1",
      appName: "app",
      userId: "user",
      state: { existing: "kept" },
      events: [],
      lastUpdateTime: 1,
    },
    pluginManager: new PluginManager(),
  });
}

function task(overrides: Partial<WorkflowTaskRecord> = {}): WorkflowTaskRecord {
  return {
    executionId: "execution-1",
    taskId: "task-1",
    parentTaskId: "parent-1",
    agentId: "worker",
    status: "running",
    revision: 2,
    attempt: 1,
    createdAt: 1,
    updatedAt: 2,
    startedAt: 2,
    input: { instruction: "inspect", iteration: 2 },
    claim: {
      workerId: "host-1",
      leaseId: "lease-1",
      fencingToken: 19,
      claimedAt: 2,
      heartbeatAt: 2,
      expiresAt: 1_002,
    },
    orchestration: {
      planRevision: 7,
      ownership: [{ grantId: "grant-1", fencingToken: 11 }],
    },
    ...overrides,
  };
}

function request(
  record: WorkflowTaskRecord,
  signal = new AbortController().signal,
  onSend: (payload: WorkflowTaskJsonValue) => void = () => undefined,
): WorkflowTaskDriverRequest {
  return {
    task: record,
    signal,
    resumed: false,
    spawn: async (child) => ({
      executionId: record.executionId,
      taskId: child.taskId,
    }),
    send: async (message) => {
      onSend(message.payload);
      return {
        executionId: record.executionId,
        taskId: message.taskId,
        senderTaskId: record.taskId,
        payload: message.payload,
        sequence: 1,
        sentAt: 3,
      };
    },
    readMailbox: async () => ({
      messages: [],
      cursor: {
        executionId: record.executionId,
        taskId: record.taskId,
        afterSequence: 0,
      },
      hasMore: false,
    }),
    waitForMailbox: async () => ({
      messages: [],
      cursor: {
        executionId: record.executionId,
        taskId: record.taskId,
        afterSequence: 0,
      },
      hasMore: false,
    }),
    join: async (handle) => task({ ...handle, status: "completed" }),
    awaitAny: async (handles) => ({
      handle: handles[0],
      record: task({ ...handles[0], status: "completed" }),
    }),
    cancel: async (handle) => task({ ...handle, status: "cancelled" }),
  };
}

describe("AdkWorkflowTaskDriver", () => {
  test("runs a real ADK agent with projected input, authority, and bound capabilities", async () => {
    const worker = new TestAgent();
    const root = new TestAgent("root");
    const context = parentContext(root);
    const lifecycle: string[] = [];
    const sent: WorkflowTaskJsonValue[] = [];
    let binderContext: InvocationContext | undefined;
    const binder: AdkWorkflowTaskCapabilityBinder = {
      bind: async (binding) => {
        lifecycle.push("bind");
        binderContext = binding.context;
        expect(binding.agent).toBe(worker);
        expect(binding.task.taskId).toBe("task-1");
        expect(binding.signal).toBeInstanceOf(AbortSignal);
        expect(binding.binding).toEqual({
          planRevision: 7,
          ownership: [{ grantId: "grant-1", fencingToken: 11 }],
        });
        await binding.capabilities.send({
          taskId: "parent-1",
          payload: { kind: "ready" },
        });
        return { release: () => lifecycle.push("release-binder") };
      },
    };
    const driver = new AdkWorkflowTaskDriver({
      gateway: new AgentInvocationGateway({ resolveAgent: () => worker }),
      contextProvider: {
        acquire: () => ({
          context,
          release: () => lifecycle.push("release-context"),
        }),
      },
      capabilityBinder: binder,
    });

    const result = await driver.execute(
      request(task(), undefined, (value) => sent.push(value)),
    );

    expect(result).toEqual({ output: "done" });
    expect(sent).toEqual([{ kind: "ready" }]);
    expect(binderContext).toBeInstanceOf(InvocationContext);
    expect(binderContext?.session.state).toEqual(worker.context?.session.state);
    expect(worker.context?.userContent).toEqual({
      role: "user",
      parts: [{ text: '{"instruction":"inspect","iteration":2}' }],
    });
    expect(worker.context?.session.state).toEqual({
      existing: "kept",
      workflowTask: {
        executionId: "execution-1",
        taskId: "task-1",
        parentTaskId: "parent-1",
        planRevision: 7,
        ownership: [{ grantId: "grant-1", fencingToken: 11 }],
        claim: {
          workerId: "host-1",
          leaseId: "lease-1",
          fencingToken: 19,
        },
      },
    });
    expect(JSON.parse(JSON.stringify(worker.context?.session.state))).toEqual(
      worker.context?.session.state,
    );
    expect(
      Object.values(
        worker.context?.session.state.workflowTask as Record<string, unknown>,
      ).some((value) => typeof value === "function"),
    ).toBe(false);
    expect(lifecycle).toEqual(["bind", "release-binder", "release-context"]);
  });

  test("supports an explicit task-aware agent and a host-only output projector", async () => {
    const worker = new TestAgent("worker", async () => "raw");
    const context = parentContext(new TestAgent("root"));
    const driver = new AdkWorkflowTaskDriver({
      gateway: new AgentInvocationGateway({ resolveAgent: () => worker }),
      contextProvider: { acquire: () => ({ context }) },
      capabilityMode: "task-aware",
      outputProjector: (result, record) => ({
        answer: result.output,
        taskId: record.taskId,
      }),
    });

    await expect(
      driver.execute(request(task({ input: "plain" }))),
    ).resolves.toEqual({ output: { answer: "raw", taskId: "task-1" } });
    expect(worker.context?.userContent).toEqual({
      role: "user",
      parts: [{ text: "plain" }],
    });
  });

  test("rejects an unbound task before acquiring host resources", async () => {
    let acquired = 0;
    const worker = new TestAgent();
    const driver = new AdkWorkflowTaskDriver({
      gateway: new AgentInvocationGateway({ resolveAgent: () => worker }),
      contextProvider: {
        acquire: () => {
          acquired++;
          return { context: parentContext(worker) };
        },
      },
      capabilityMode: "task-aware",
    });

    await expect(
      driver.execute(request(task({ orchestration: undefined }))),
    ).rejects.toMatchObject({
      name: "AdkWorkflowTaskDriverError",
      code: "ADK_WORKFLOW_TASK_UNBOUND",
    });
    expect(acquired).toBe(0);
  });

  test("propagates abort into ADK and releases both leases exactly once", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const releases = { binder: 0, context: 0 };
    const worker = new TestAgent("worker", async (context) => {
      started();
      await new Promise<void>((_resolve, reject) => {
        const signal = context.abortSignal;
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
      return "unreachable";
    });
    const driver = new AdkWorkflowTaskDriver({
      gateway: new AgentInvocationGateway({ resolveAgent: () => worker }),
      contextProvider: {
        acquire: () => ({
          context: parentContext(new TestAgent("root")),
          release: () => {
            releases.context++;
          },
        }),
      },
      capabilityBinder: {
        bind: () => ({
          release: () => {
            releases.binder++;
          },
        }),
      },
    });

    const execution = driver.execute(request(task(), controller.signal));
    await running;
    controller.abort(new Error("stop requested"));

    await expect(execution).rejects.toMatchObject({
      code: "ADK_WORKFLOW_TASK_INVOCATION_FAILED",
      message: expect.stringContaining("stop requested"),
    });
    expect(worker.context?.abortSignal?.aborted).toBe(true);
    expect(releases).toEqual({ binder: 1, context: 1 });
  });

  test("keeps an invocation failure primary when cleanup also fails", async () => {
    const worker = new TestAgent("worker", async () => {
      throw new Error("agent failed");
    });
    const driver = new AdkWorkflowTaskDriver({
      gateway: new AgentInvocationGateway({ resolveAgent: () => worker }),
      contextProvider: {
        acquire: () => ({
          context: parentContext(new TestAgent("root")),
          release: () => {
            throw new Error("context cleanup failed");
          },
        }),
      },
      capabilityBinder: {
        bind: () => ({
          release: () => {
            throw new Error("binder cleanup failed");
          },
        }),
      },
    });

    let caught: unknown;
    try {
      await driver.execute(request(task()));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AdkWorkflowTaskDriverError);
    expect(caught).toMatchObject({
      code: "ADK_WORKFLOW_TASK_INVOCATION_FAILED",
      message: expect.stringContaining("agent failed"),
    });
    expect(
      (caught as Error & { cleanupErrors: Error[] }).cleanupErrors.map(
        (error) => error.message,
      ),
    ).toEqual(["binder cleanup failed", "context cleanup failed"]);
  });

  test("throws AggregateError when cleanup is the only failure", async () => {
    const worker = new TestAgent();
    const driver = new AdkWorkflowTaskDriver({
      gateway: new AgentInvocationGateway({ resolveAgent: () => worker }),
      contextProvider: {
        acquire: () => ({
          context: parentContext(new TestAgent("root")),
          release: () => {
            throw new Error("context cleanup failed");
          },
        }),
      },
      capabilityMode: "task-aware",
    });

    await expect(driver.execute(request(task()))).rejects.toMatchObject({
      name: "AggregateError",
      message: "ADK workflow task cleanup failed",
      errors: [expect.objectContaining({ message: "context cleanup failed" })],
    });
  });
});
