/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import type { WorkflowTaskAuthorityPort } from "../../../src/workflows/tasks/authority.js";
import type {
  WorkflowTaskDriver,
  WorkflowTaskDriverRequest,
  WorkflowTaskDriverResult,
  WorkflowTaskHandle,
  WorkflowTaskRecord,
} from "../../../src/workflows/tasks/contracts.js";
import { WorkflowTaskController } from "../../../src/workflows/tasks/controller.js";
import {
  InMemoryWorkflowTaskCommandStore,
  InMemoryWorkflowTaskMessageStore,
  InMemoryWorkflowTaskStore,
  type WorkflowTaskStore,
} from "../../../src/workflows/tasks/stores.js";

describe("WorkflowTaskController", () => {
  test("derives root authority from the host capability and discards forged bindings", async () => {
    const trustedCapability = Object.freeze({ execution: "trusted" });
    let validations = 0;
    const authority: WorkflowTaskAuthorityPort = {
      async resolveRoot({ capability, request }) {
        expect(capability).toBe(trustedCapability);
        expect(request.orchestration).toEqual({
          planRevision: 999,
          ownership: [{ grantId: "forged", fencingToken: 999 }],
        });
        return binding("root-grant", 7, 11);
      },
      async deriveChild() {
        return binding("child-grant", 7, 12);
      },
      async validateAttempt({ task }) {
        validations++;
        expect(task.orchestration).toEqual(binding("root-grant", 7, 11));
      },
      async validateAuthenticatedSender() {},
    };
    const { controller } = orchestratedHarness({
      authority,
      driver: {
        async execute() {
          expect(validations).toBe(2);
          return { output: "authorized" };
        },
      },
    });

    const forged = {
      ...spawn("root"),
      operationId: "root-create",
      orchestration: binding("forged", 999, 999),
    };
    await expect(controller.spawn(forged)).rejects.toMatchObject({
      code: "WORKFLOW_TASK_INVALID_REQUEST",
    });
    const handle = await controller.spawn(forged, {
      capability: trustedCapability,
    });

    await expect(controller.join(handle)).resolves.toMatchObject({
      status: "completed",
      orchestration: binding("root-grant", 7, 11),
      output: "authorized",
    });
  });

  test("derives child authority independently and fences driver commands", async () => {
    let child: WorkflowTaskHandle | undefined;
    const authority: WorkflowTaskAuthorityPort = {
      async resolveRoot() {
        return binding("root-grant", 7, 11);
      },
      async deriveChild({ parent, request }) {
        expect(parent.orchestration).toEqual(binding("root-grant", 7, 11));
        expect(request.operationId).toBe("spawn-child");
        return binding("child-grant", 7, 22);
      },
      async validateAttempt() {},
      async validateAuthenticatedSender() {},
    };
    const { controller } = orchestratedHarness({
      authority,
      driver: {
        async execute(request) {
          if (request.task.taskId === "root") {
            child = await request.spawn({
              operationId: "spawn-child",
              taskId: "child",
              agentId: "reviewer",
            });
            return { output: child };
          }
          return { output: "child-done" };
        },
      },
    });

    const root = await controller.spawn(
      { ...spawn("root"), operationId: "spawn-root" },
      { capability: { host: true } },
    );
    await controller.join(root);
    expect(child).toBeDefined();
    await expect(
      controller.join(child as WorkflowTaskHandle),
    ).resolves.toMatchObject({
      status: "completed",
      orchestration: binding("child-grant", 7, 22),
      output: "child-done",
    });
  });

  test("authenticates external mailbox send and appends through the claimed sender fence", async () => {
    const gate = deferred<WorkflowTaskDriverResult>();
    const actor = Object.freeze({ task: "sender" });
    let authenticated = 0;
    const authority: WorkflowTaskAuthorityPort = {
      async resolveRoot() {
        return binding("grant", 7, 1);
      },
      async deriveChild() {
        return binding("child", 7, 2);
      },
      async validateAttempt() {},
      async validateAuthenticatedSender({ actor: actual, sender }) {
        expect(actual).toBe(actor);
        expect(sender.taskId).toBe("sender");
        authenticated++;
      },
    };
    const { controller } = orchestratedHarness({
      authority,
      driver: { execute: async () => await gate.promise },
    });
    const target = await controller.spawn(
      { ...spawn("target"), operationId: "spawn-target" },
      { capability: {} },
    );
    const sender = await controller.spawn(
      { ...spawn("sender"), operationId: "spawn-sender" },
      { capability: {} },
    );
    await eventually(async () => {
      expect((await controller.status(sender)).status).toBe("running");
    });

    await expect(
      controller.send({ ...target, senderTaskId: sender.taskId, payload: "x" }),
    ).rejects.toMatchObject({ code: "WORKFLOW_TASK_INVALID_REQUEST" });
    const message = await controller.send(
      { ...target, senderTaskId: sender.taskId, payload: "hello" },
      { actor, operationId: "send-1" },
    );
    expect(message).toMatchObject({ senderTaskId: "sender", payload: "hello" });
    expect(authenticated).toBe(1);

    gate.resolve({});
    await controller.waitForIdle();
  });

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

    const root = await controller.start({
      ...spawn("root"),
      orchestration: {
        planRevision: 7,
        ownership: [{ grantId: "grant-root", fencingToken: 11 }],
      },
    });
    const rootResult = await controller.join(root);
    expect(rootResult.output).toEqual({
      executionId: "execution-1",
      taskId: "child",
    });
    expect(rootResult.orchestration).toEqual({
      planRevision: 7,
      ownership: [{ grantId: "grant-root", fencingToken: 11 }],
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
    // Child authority is deny-by-default. WorkflowTaskDriverChildRequest does
    // not currently expose an orchestration binding, so parent grants cannot
    // be inherited implicitly.
    expect(childRequest?.task.orchestration).toBeUndefined();
    childGate.resolve({ output: "ack" });
    await expect(
      controller.join(childHandle as WorkflowTaskHandle),
    ).resolves.toMatchObject({
      status: "completed",
      output: "ack",
    });
  });

  test("lets a driver join, await, and cancel scoped child handles", async () => {
    const childrenReady = deferred<void>();
    const gates = new Map<
      string,
      ReturnType<typeof deferred<WorkflowTaskDriverResult>>
    >();
    let created = 0;
    const { controller } = harness({
      async execute(request) {
        if (request.task.taskId === "root") {
          const first = await request.spawn({
            taskId: "first",
            agentId: "codex",
          });
          const second = await request.spawn({
            taskId: "second",
            agentId: "codex",
          });
          childrenReady.resolve(undefined);
          const selected = await request.awaitAny([second, first]);
          const remaining =
            selected.handle.taskId === first.taskId ? second : first;
          const joined = await request.join(remaining);
          const cancelled = await request.spawn({
            taskId: "cancelled",
            agentId: "codex",
          });
          await request.cancel(cancelled);
          const cancelledRecord = await request.join(cancelled);
          return {
            output: {
              selected: selected.handle.taskId,
              joined: joined.taskId,
              cancelled: cancelledRecord.status,
            },
          };
        }
        const gate = deferred<WorkflowTaskDriverResult>();
        gates.set(request.task.taskId, gate);
        created++;
        if (created === 2) childrenReady.resolve(undefined);
        await new Promise<void>((resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true },
          );
          gate.promise.then(() => resolve(), reject);
        });
        return await gate.promise;
      },
    });

    const root = await controller.spawn(spawn("root"));
    await childrenReady.promise;
    await eventually(() => expect(gates.size).toBe(2));
    gates.get("first")?.resolve({ output: "first" });
    gates.get("second")?.resolve({ output: "second" });

    await expect(controller.join(root)).resolves.toMatchObject({
      status: "completed",
      output: {
        selected: "second",
        joined: "first",
        cancelled: "cancelled",
      },
    });
  });

  test("aborts a local join without cancelling the joined task", async () => {
    const gate = deferred<WorkflowTaskDriverResult>();
    const { controller } = harness({ execute: async () => await gate.promise });
    const handle = await controller.spawn(spawn("task-1"));
    await eventually(async () =>
      expect((await controller.status(handle)).status).toBe("running"),
    );
    const abort = new AbortController();
    const joined = controller.join(handle, abort.signal);
    abort.abort();

    await expect(joined).rejects.toMatchObject({
      code: "WORKFLOW_TASK_WAIT_ABORTED",
    });
    expect((await controller.status(handle)).status).toBe("running");
    gate.resolve({});
    await expect(controller.join(handle)).resolves.toMatchObject({
      status: "completed",
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

  test("keeps legacy CAS execution when durable mode is omitted", async () => {
    const gate = deferred<WorkflowTaskDriverResult>();
    const { controller } = harness({ execute: async () => await gate.promise });
    const handle = await controller.spawn(spawn("legacy"));
    await eventually(async () => {
      expect(await controller.status(handle)).toMatchObject({
        status: "running",
        revision: 2,
      });
    });
    expect((await controller.status(handle)).claim).toBeUndefined();

    gate.resolve({ output: "legacy" });
    await expect(controller.join(handle)).resolves.toMatchObject({
      status: "completed",
      revision: 3,
      output: "legacy",
    });
  });

  test("accepts only known spawn fields after adding orchestration", async () => {
    const { controller } = harness({ execute: async () => ({}) });
    await expect(
      controller.spawn({
        ...spawn("unknown"),
        unexpected: true,
      } as Parameters<WorkflowTaskController["spawn"]>[0]),
    ).rejects.toMatchObject({ code: "WORKFLOW_TASK_INVALID_REQUEST" });
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

function orchestratedHarness(options: {
  authority: WorkflowTaskAuthorityPort;
  driver: WorkflowTaskDriver;
}) {
  const store = new InMemoryWorkflowTaskStore();
  const messageStore = new InMemoryWorkflowTaskMessageStore();
  const commandStore = new InMemoryWorkflowTaskCommandStore({
    taskStore: store,
    messageStore,
  });
  return {
    store,
    messageStore,
    controller: new WorkflowTaskController({
      store,
      messageStore,
      commandStore,
      authorityPort: options.authority,
      driver: options.driver,
      durable: {
        workerId: "worker-test",
        leaseDurationMs: 60_000,
        heartbeatIntervalMs: 10_000,
        scheduleHeartbeat: () => ({ cancel() {} }),
      },
    }),
  };
}

function binding(grantId: string, planRevision: number, fencingToken: number) {
  return {
    planRevision,
    ownership: [{ grantId, fencingToken }],
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
