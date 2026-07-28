/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import type {
  WorkflowTaskDriver,
  WorkflowTaskDriverRequest,
  WorkflowTaskDriverResult,
  WorkflowTaskHandle,
  WorkflowTaskRecord,
} from "../../../src/workflows/tasks/contracts.js";
import { WorkflowTaskController } from "../../../src/workflows/tasks/controller.js";
import {
  InMemoryWorkflowTaskMessageStore,
  InMemoryWorkflowTaskStore,
  type WorkflowTaskStore,
} from "../../../src/workflows/tasks/stores.js";

describe("WorkflowTaskController", () => {
  test("starts promptly and returns a serializable durable handle", async () => {
    const gate = deferred<WorkflowTaskDriverResult>();
    const { controller } = harness({ execute: async () => await gate.promise });

    const handle = await controller.spawn(spawn("task-1"));
    expect(handle).toEqual({ executionId: "execution-1", taskId: "task-1" });
    expect(Object.isFrozen(handle)).toBe(true);
    expect(JSON.parse(JSON.stringify(handle))).toEqual(handle);
    expect(
      Object.values(handle).every((value) => !(value instanceof Promise)),
    ).toBe(true);
    await eventually(async () => {
      expect((await controller.status(handle)).status).toBe("running");
    });

    gate.resolve({ output: { result: "done" } });
    await expect(controller.join(handle)).resolves.toMatchObject({
      status: "completed",
      output: { result: "done" },
    });
  });

  test("lets a running driver spawn a child and exchange durable messages", async () => {
    let childHandle: WorkflowTaskHandle | undefined;
    let childRequest: WorkflowTaskDriverRequest | undefined;
    const childGate = deferred<WorkflowTaskDriverResult>();
    const { controller } = harness({
      async execute(request) {
        if (request.task.taskId === "root") {
          childHandle = await request.spawn({
            taskId: "child",
            agentId: "reviewer",
            input: { scope: "module-a" },
          });
          await request.send({
            taskId: "child",
            payload: { need: "contract" },
          });
          return { output: childHandle };
        }
        childRequest = request;
        return await childGate.promise;
      },
    });

    const root = await controller.start(spawn("root"));
    const rootResult = await controller.join(root);
    expect(rootResult.output).toEqual({
      executionId: "execution-1",
      taskId: "child",
    });
    expect(childHandle).toBeDefined();
    await eventually(async () => expect(childRequest).toBeDefined());
    const mailbox = await childRequest?.readMailbox();
    expect(mailbox?.messages[0]).toMatchObject({
      sequence: 1,
      senderTaskId: "root",
      payload: { need: "contract" },
    });
    expect(
      (await controller.status(childHandle as WorkflowTaskHandle)).parentTaskId,
    ).toBe("root");
    childGate.resolve({ output: "ack" });
    await expect(
      controller.join(childHandle as WorkflowTaskHandle),
    ).resolves.toMatchObject({
      status: "completed",
      output: "ack",
    });
  });

  test("cancels through AbortSignal and keeps cancel idempotent", async () => {
    let signal: AbortSignal | undefined;
    const { controller } = harness({
      async execute(request) {
        signal = request.signal;
        await new Promise<void>((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true },
          );
        });
        return {};
      },
    });
    const handle = await controller.spawn(spawn("task-1"));
    await eventually(async () =>
      expect((await controller.status(handle)).status).toBe("running"),
    );

    const first = await controller.cancel(handle);
    const second = await controller.cancel(handle);
    const terminal = await controller.join(handle);
    const third = await controller.cancel(handle);
    expect(["cancelling", "cancelled"]).toContain(first.status);
    expect(["cancelling", "cancelled"]).toContain(second.status);
    expect(signal?.aborted).toBe(true);
    expect(terminal).toMatchObject({
      status: "cancelled",
      error: { code: "WORKFLOW_TASK_CANCELLED" },
    });
    expect(third).toBe(terminal);
  });

  test("cancels atomically between queued read and running claim", async () => {
    const store = new ClaimBarrierStore();
    let driverCalls = 0;
    const controller = new WorkflowTaskController({
      store,
      messageStore: new InMemoryWorkflowTaskMessageStore(),
      driver: {
        execute: async () => {
          driverCalls++;
          return {};
        },
      },
    });
    const handle = await controller.spawn(spawn("task-1"));
    await store.claimStarted.promise;
    const cancelling = await controller.cancel(handle);
    expect(cancelling.status).toBe("cancelling");
    store.allowClaim.resolve(undefined);

    expect(await controller.join(handle)).toMatchObject({
      status: "cancelled",
    });
    expect(driverCalls).toBe(0);
  });

  test("does not pretend to cancel or join an unowned running task", async () => {
    const store = new InMemoryWorkflowTaskStore();
    await store.create(runningRecord("task-1"));
    const controller = new WorkflowTaskController({
      store,
      messageStore: new InMemoryWorkflowTaskMessageStore(),
      driver: { execute: async () => ({}) },
    });
    const handle = { executionId: "execution-1", taskId: "task-1" };

    await expect(controller.cancel(handle)).rejects.toMatchObject({
      code: "WORKFLOW_TASK_NOT_OWNED",
    });
    await expect(controller.join(handle)).rejects.toMatchObject({
      code: "WORKFLOW_TASK_NOT_OWNED",
    });
  });

  test("resumes only failed or cancelled tasks with checkpoint strategy", async () => {
    let calls = 0;
    const { controller } = harness({
      async execute() {
        calls++;
        if (calls === 1)
          throw Object.assign(new Error("failed"), { code: "AGENT_FAILED" });
        return { output: "recovered" };
      },
    });
    const handle = await controller.spawn(spawn("task-1"));
    expect(await controller.join(handle)).toMatchObject({
      status: "failed",
      attempt: 1,
    });
    const resumed = await controller.resume({
      ...handle,
      strategy: "checkpoint",
    });
    expect(resumed).toEqual(handle);
    expect(await controller.join(handle)).toMatchObject({
      status: "completed",
      attempt: 2,
      output: "recovered",
    });
    await expect(
      controller.resume({ ...handle, strategy: "checkpoint" }),
    ).rejects.toMatchObject({
      code: "WORKFLOW_TASK_INVALID_TRANSITION",
    });
  });

  test("awaitAny deterministically selects input order after simultaneous completion", async () => {
    const gates = new Map<
      string,
      ReturnType<typeof deferred<WorkflowTaskDriverResult>>
    >();
    const { controller } = harness({
      async execute({ task }) {
        const gate = deferred<WorkflowTaskDriverResult>();
        gates.set(task.taskId, gate);
        return await gate.promise;
      },
    });
    const first = await controller.spawn(spawn("first"));
    const second = await controller.spawn(spawn("second"));
    await eventually(async () => expect(gates.size).toBe(2));
    gates.get("first")?.resolve({ output: 1 });
    gates.get("second")?.resolve({ output: 2 });
    await controller.waitForIdle();

    const selected = await controller.awaitAny([second, first]);
    expect(selected.handle).toEqual(second);
    expect(selected.record.output).toBe(2);
  });

  test("rejects duplicate task IDs atomically across controllers", async () => {
    const store = new InMemoryWorkflowTaskStore();
    const messageStore = new InMemoryWorkflowTaskMessageStore();
    const gate = deferred<WorkflowTaskDriverResult>();
    const driver = { execute: async () => await gate.promise };
    const first = new WorkflowTaskController({ store, messageStore, driver });
    const second = new WorkflowTaskController({ store, messageStore, driver });
    const starts = await Promise.allSettled([
      first.spawn(spawn("task-1")),
      second.spawn(spawn("task-1")),
    ]);
    expect(starts.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(starts.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { code: "WORKFLOW_TASK_DUPLICATE" },
    });
    gate.resolve({});
    await Promise.all([first.waitForIdle(), second.waitForIdle()]);
  });

  test("validates target and sender before appending to a mailbox", async () => {
    const gate = deferred<WorkflowTaskDriverResult>();
    const { controller } = harness({ execute: async () => await gate.promise });
    const target = await controller.spawn(spawn("target"));
    const sender = await controller.spawn(spawn("sender"));
    const message = await controller.send({
      ...target,
      senderTaskId: sender.taskId,
      payload: "hello",
    });
    expect(message).toMatchObject({ sequence: 1, payload: "hello" });
    expect((await controller.readMailbox(target)).messages).toEqual([message]);
    await expect(
      controller.send({
        executionId: "execution-1",
        taskId: "missing",
        payload: "no",
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_TASK_NOT_FOUND" });
    gate.resolve({});
    await controller.waitForIdle();
  });

  test("binds driver mailbox long-poll cancellation to the task signal", async () => {
    const waiting = deferred<void>();
    let waitError: unknown;
    const { controller } = harness({
      async execute(request) {
        waiting.resolve(undefined);
        try {
          await request.waitForMailbox();
        } catch (error) {
          waitError = error;
          throw error;
        }
        return {};
      },
    });
    const handle = await controller.spawn(spawn("task-1"));
    await waiting.promise;
    await controller.cancel(handle);

    expect(await controller.join(handle)).toMatchObject({
      status: "cancelled",
    });
    expect(waitError).toMatchObject({ code: "WORKFLOW_TASK_WAIT_ABORTED" });
  });
});

function harness(driver: WorkflowTaskDriver) {
  const store = new InMemoryWorkflowTaskStore();
  const messageStore = new InMemoryWorkflowTaskMessageStore();
  return {
    store,
    messageStore,
    controller: new WorkflowTaskController({ store, messageStore, driver }),
  };
}

function spawn(taskId: string) {
  return {
    executionId: "execution-1",
    taskId,
    agentId: "codex",
    input: { taskId },
  };
}

function runningRecord(taskId: string): WorkflowTaskRecord {
  return {
    executionId: "execution-1",
    taskId,
    agentId: "codex",
    status: "running",
    revision: 1,
    attempt: 1,
    createdAt: 1,
    updatedAt: 2,
    startedAt: 2,
  };
}

class ClaimBarrierStore implements WorkflowTaskStore {
  readonly delegate = new InMemoryWorkflowTaskStore();
  readonly claimStarted = deferred<void>();
  readonly allowClaim = deferred<void>();
  #blocked = false;

  create(record: WorkflowTaskRecord) {
    return this.delegate.create(record);
  }

  get(executionId: string, taskId: string) {
    return this.delegate.get(executionId, taskId);
  }

  async compareAndSet(record: WorkflowTaskRecord, expectedRevision: number) {
    if (record.status === "running" && !this.#blocked) {
      this.#blocked = true;
      this.claimStarted.resolve(undefined);
      await this.allowClaim.promise;
    }
    return await this.delegate.compareAndSet(record, expectedRevision);
  }

  list(request: Parameters<WorkflowTaskStore["list"]>[0]) {
    return this.delegate.list(request);
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function eventually(
  assertion: () => void | Promise<void>,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(1);
    }
  }
  throw lastError;
}
