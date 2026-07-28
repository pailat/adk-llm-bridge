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
} from "../../../src/workflows/tasks/contracts.js";
import {
  WorkflowTaskController,
  type WorkflowTaskHeartbeatHandle,
} from "../../../src/workflows/tasks/controller.js";
import {
  InMemoryWorkflowTaskMessageStore,
  InMemoryWorkflowTaskStore,
} from "../../../src/workflows/tasks/stores.js";

describe("WorkflowTaskController durable recovery", () => {
  test("heartbeats a live driver and finishes against the latest revision", async () => {
    let now = 10;
    const scheduler = new ManualHeartbeatScheduler();
    const gate = deferred<WorkflowTaskDriverResult>();
    const store = new InMemoryWorkflowTaskStore({ now: () => now });
    const controller = durableController({
      store,
      now: () => now,
      scheduler,
      workerId: "worker-1",
      leaseId: "lease-1",
      driver: { execute: async () => await gate.promise },
    });

    const handle = await controller.spawn(spawn("task-1"));
    await flushUntil(async () => {
      expect(await controller.status(handle)).toMatchObject({
        status: "running",
        revision: 2,
        claim: { heartbeatAt: 10, expiresAt: 30 },
      });
    });

    now = 15;
    await scheduler.heartbeat();
    expect(await controller.status(handle)).toMatchObject({
      revision: 3,
      claim: { heartbeatAt: 15, expiresAt: 35 },
    });

    now = 16;
    gate.resolve({ output: "done" });
    await expect(controller.join(handle)).resolves.toMatchObject({
      status: "completed",
      revision: 4,
      output: "done",
    });
    expect((await controller.status(handle)).claim).toBeUndefined();
    expect(scheduler.cancelled).toBe(true);
  });

  test("recovers an expired attempt and fences the previous worker", async () => {
    let now = 10;
    const store = new InMemoryWorkflowTaskStore({ now: () => now });
    const messages = new InMemoryWorkflowTaskMessageStore();
    const oldGate = deferred<WorkflowTaskDriverResult>();
    const newGate = deferred<WorkflowTaskDriverResult>();
    let oldRequest: WorkflowTaskDriverRequest | undefined;
    const backgroundErrors: unknown[] = [];
    const oldController = durableController({
      store,
      messageStore: messages,
      now: () => now,
      scheduler: new ManualHeartbeatScheduler(),
      workerId: "worker-old",
      leaseId: "lease-old",
      driver: {
        async execute(request) {
          oldRequest = request;
          return await oldGate.promise;
        },
      },
      onBackgroundError: (error) => backgroundErrors.push(error),
    });
    const recoveryController = durableController({
      store,
      messageStore: messages,
      now: () => now,
      scheduler: new ManualHeartbeatScheduler(),
      workerId: "worker-new",
      leaseId: "lease-new",
      driver: { execute: async () => await newGate.promise },
    });

    const handle = await oldController.spawn(spawn("task-1"));
    await flushUntil(() => expect(oldRequest).toBeDefined());
    expect((await oldController.status(handle)).claim?.fencingToken).toBe(1);

    now = 30;
    await recoveryController.recoverExpired(handle);
    await flushUntil(async () => {
      expect(await recoveryController.status(handle)).toMatchObject({
        status: "running",
        attempt: 2,
        revision: 4,
        claim: { workerId: "worker-new", fencingToken: 2 },
      });
    });

    await expect(
      oldRequest?.send({ taskId: handle.taskId, payload: "stale" }),
    ).rejects.toMatchObject({ code: "WORKFLOW_TASK_NOT_OWNED" });
    oldGate.resolve({ output: "must-not-win" });
    await oldController.waitForIdle();
    expect(await recoveryController.status(handle)).toMatchObject({
      status: "running",
      attempt: 2,
      claim: { fencingToken: 2 },
    });
    expect(backgroundErrors).toHaveLength(1);

    now = 31;
    newGate.resolve({ output: "recovered" });
    await expect(recoveryController.join(handle)).resolves.toMatchObject({
      status: "completed",
      attempt: 2,
      output: "recovered",
    });
  });

  test("aborts the local driver when heartbeat renewal loses its fence", async () => {
    let now = 10;
    const store = new InMemoryWorkflowTaskStore({ now: () => now });
    const oldScheduler = new ManualHeartbeatScheduler();
    const newScheduler = new ManualHeartbeatScheduler();
    const driverStarted = deferred<void>();
    let oldSignal: AbortSignal | undefined;
    const oldController = durableController({
      store,
      now: () => now,
      scheduler: oldScheduler,
      workerId: "worker-old",
      leaseId: "lease-old",
      driver: {
        async execute(request) {
          oldSignal = request.signal;
          driverStarted.resolve(undefined);
          await new Promise<void>((resolve) => {
            request.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          return {};
        },
      },
    });
    const newGate = deferred<WorkflowTaskDriverResult>();
    const recoveryController = durableController({
      store,
      now: () => now,
      scheduler: newScheduler,
      workerId: "worker-new",
      leaseId: "lease-new",
      driver: { execute: async () => await newGate.promise },
    });

    const handle = await oldController.spawn(spawn("task-1"));
    await driverStarted.promise;
    now = 30;
    await recoveryController.recoverExpired(handle);
    await flushUntil(async () => {
      expect((await recoveryController.status(handle)).claim?.workerId).toBe(
        "worker-new",
      );
    });

    await oldScheduler.heartbeat();
    expect(oldSignal?.aborted).toBe(true);
    await oldController.waitForIdle();
    expect(await recoveryController.status(handle)).toMatchObject({
      status: "running",
      claim: { workerId: "worker-new" },
    });

    now = 31;
    newGate.resolve({});
    await recoveryController.join(handle);
  });

  test("waits for a published claim response before cancelling with its fence", async () => {
    const now = 10;
    const store = new ClaimResponseBarrierStore({ now: () => now });
    const controller = durableController({
      store,
      now: () => now,
      scheduler: new ManualHeartbeatScheduler(),
      workerId: "worker-1",
      leaseId: "lease-1",
      driver: {
        async execute(request) {
          await new Promise<void>((_resolve, reject) => {
            request.signal.addEventListener(
              "abort",
              () => reject(request.signal.reason),
              { once: true },
            );
          });
          return {};
        },
      },
    });

    const handle = await controller.spawn(spawn("task-1"));
    await store.claimPublished.promise;
    const cancellation = controller.cancel(handle);
    await Promise.resolve();
    store.allowClaimResponse.resolve(undefined);

    await expect(cancellation).resolves.toMatchObject({ status: "cancelling" });
    await expect(controller.join(handle)).resolves.toMatchObject({
      status: "cancelled",
    });
  });

  test("rejects recovery of cancelling expiry until the store defines it", async () => {
    let now = 10;
    const gate = deferred<WorkflowTaskDriverResult>();
    const store = new InMemoryWorkflowTaskStore({ now: () => now });
    const controller = durableController({
      store,
      now: () => now,
      scheduler: new ManualHeartbeatScheduler(),
      workerId: "worker-1",
      leaseId: "lease-1",
      driver: { execute: async () => await gate.promise },
    });
    const handle = await controller.spawn(spawn("task-1"));
    await flushUntil(async () =>
      expect((await controller.status(handle)).status).toBe("running"),
    );
    await controller.cancel(handle);
    now = 30;

    await expect(controller.recoverExpired(handle)).rejects.toMatchObject({
      code: "WORKFLOW_TASK_INVALID_TRANSITION",
    });
    gate.resolve({});
    await controller.waitForIdle();
  });
});

interface DurableControllerOptions {
  store: InMemoryWorkflowTaskStore;
  messageStore?: InMemoryWorkflowTaskMessageStore;
  driver: WorkflowTaskDriver;
  now: () => number;
  scheduler: ManualHeartbeatScheduler;
  workerId: string;
  leaseId: string;
  onBackgroundError?: (error: unknown, handle: WorkflowTaskHandle) => void;
}

function durableController(options: DurableControllerOptions) {
  return new WorkflowTaskController({
    store: options.store,
    messageStore:
      options.messageStore ?? new InMemoryWorkflowTaskMessageStore(),
    driver: options.driver,
    now: options.now,
    durable: {
      workerId: options.workerId,
      leaseDurationMs: 20,
      heartbeatIntervalMs: 5,
      createLeaseId: () => options.leaseId,
      scheduleHeartbeat: (heartbeat, intervalMs) =>
        options.scheduler.schedule(heartbeat, intervalMs),
    },
    onBackgroundError: options.onBackgroundError,
  });
}

class ManualHeartbeatScheduler {
  #callback: (() => Promise<void>) | undefined;
  cancelled = false;

  schedule(
    callback: () => Promise<void>,
    intervalMs: number,
  ): WorkflowTaskHeartbeatHandle {
    expect(intervalMs).toBe(5);
    this.#callback = callback;
    return {
      cancel: () => {
        this.cancelled = true;
      },
    };
  }

  async heartbeat(): Promise<void> {
    if (!this.#callback) throw new Error("Heartbeat was not scheduled");
    await this.#callback();
  }
}

class ClaimResponseBarrierStore extends InMemoryWorkflowTaskStore {
  readonly claimPublished = deferred<void>();
  readonly allowClaimResponse = deferred<void>();

  override async claim(
    request: Parameters<InMemoryWorkflowTaskStore["claim"]>[0],
  ) {
    const record = await super.claim(request);
    this.claimPublished.resolve(undefined);
    await this.allowClaimResponse.promise;
    return record;
  }
}

function spawn(taskId: string) {
  return {
    executionId: "execution-1",
    taskId,
    agentId: "codex",
  };
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

async function flushUntil(
  assertion: () => void | Promise<void>,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await Promise.resolve();
    }
  }
  throw lastError;
}
