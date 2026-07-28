/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import type {
  WorkflowTaskDriver,
  WorkflowTaskDriverResult,
  WorkflowTaskRecord,
} from "../../../src/workflows/tasks/contracts.js";
import {
  WorkflowTaskController,
  type WorkflowTaskHeartbeatHandle,
} from "../../../src/workflows/tasks/controller.js";
import { WorkflowTaskDispatcher } from "../../../src/workflows/tasks/dispatcher.js";
import {
  InMemoryWorkflowTaskMessageStore,
  InMemoryWorkflowTaskStore,
} from "../../../src/workflows/tasks/stores.js";

describe("WorkflowTaskDispatcher", () => {
  test("dispatches queued tasks with a bounded host-triggered sweep", async () => {
    const now = 10;
    const store = new InMemoryWorkflowTaskStore({ now: () => now });
    await store.create(record("task-1", now));
    await store.create(record("task-2", now));
    const gates = new Map<
      string,
      ReturnType<typeof deferred<WorkflowTaskDriverResult>>
    >();
    const controller = controllerFor(store, () => now, "worker-1", {
      async execute({ task }) {
        const gate = deferred<WorkflowTaskDriverResult>();
        gates.set(task.taskId, gate);
        return await gate.promise;
      },
    });
    const dispatcher = new WorkflowTaskDispatcher({
      controller,
      now: () => now,
    });

    const result = await dispatcher.sweep({ executionId: "execution-1" });
    expect(result).toMatchObject({ inspected: 2, failures: [] });
    expect(result.outcomes.map(({ action }) => action)).toEqual([
      "dispatched",
      "dispatched",
    ]);
    await flushUntil(() => expect(gates.size).toBe(2));
    for (const gate of gates.values()) gate.resolve({});
    await controller.waitForIdle();
  });

  test("recovers expired running work and finalizes expired cancellation", async () => {
    let now = 10;
    const store = new InMemoryWorkflowTaskStore({ now: () => now });
    await store.create(record("running", now));
    await store.create(record("cancelling", now));
    await store.claim({
      executionId: "execution-1",
      taskId: "running",
      workerId: "old-worker",
      leaseId: "old-running",
      leaseDurationMs: 10,
    });
    const claimedCancellation = await store.claim({
      executionId: "execution-1",
      taskId: "cancelling",
      workerId: "old-worker",
      leaseId: "old-cancelling",
      leaseDurationMs: 10,
    });
    await store.requestCancellation({
      executionId: "execution-1",
      taskId: "cancelling",
      expectedRevision: claimedCancellation.revision,
    });
    const gate = deferred<WorkflowTaskDriverResult>();
    const controller = controllerFor(store, () => now, "new-worker", {
      execute: async () => await gate.promise,
    });
    const dispatcher = new WorkflowTaskDispatcher({
      controller,
      now: () => now,
    });

    now = 20;
    const result = await dispatcher.sweep({ executionId: "execution-1" });
    expect(result.failures).toEqual([]);
    expect(result.outcomes).toEqual([
      {
        executionId: "execution-1",
        taskId: "running",
        action: "recovered",
      },
      {
        executionId: "execution-1",
        taskId: "cancelling",
        action: "cancelled-expired",
      },
    ]);
    await flushUntil(async () => {
      expect(await controller.status(handle("running"))).toMatchObject({
        status: "running",
        attempt: 2,
        claim: { workerId: "new-worker", fencingToken: 2 },
      });
    });
    expect(await controller.status(handle("cancelling"))).toMatchObject({
      status: "cancelled",
      attempt: 1,
    });
    gate.resolve({ output: "recovered" });
    await controller.join(handle("running"));
  });

  test("competing sweepers grant only one durable execution claim", async () => {
    const now = 10;
    const store = new InMemoryWorkflowTaskStore({ now: () => now });
    await store.create(record("task-1", now));
    const gate = deferred<WorkflowTaskDriverResult>();
    let driverCalls = 0;
    const driver: WorkflowTaskDriver = {
      async execute() {
        driverCalls++;
        return await gate.promise;
      },
    };
    const first = new WorkflowTaskDispatcher({
      controller: controllerFor(store, () => now, "worker-1", driver),
      now: () => now,
    });
    const second = new WorkflowTaskDispatcher({
      controller: controllerFor(store, () => now, "worker-2", driver),
      now: () => now,
    });

    const results = await Promise.all([
      first.sweep({ executionId: "execution-1" }),
      second.sweep({ executionId: "execution-1" }),
    ]);
    expect(
      results.flatMap(({ outcomes }) => outcomes).map(({ action }) => action),
    ).toContain("contended");
    expect(driverCalls).toBe(1);
    gate.resolve({});
  });
});

function controllerFor(
  store: InMemoryWorkflowTaskStore,
  now: () => number,
  workerId: string,
  driver: WorkflowTaskDriver,
) {
  return new WorkflowTaskController({
    store,
    messageStore: new InMemoryWorkflowTaskMessageStore(),
    driver,
    now,
    durable: {
      workerId,
      leaseDurationMs: 20,
      heartbeatIntervalMs: 5,
      createLeaseId: ({ taskId }) => `${workerId}:${taskId}`,
      scheduleHeartbeat: () => noopHeartbeat(),
    },
  });
}

function noopHeartbeat(): WorkflowTaskHeartbeatHandle {
  return Object.freeze({ cancel() {} });
}

function record(taskId: string, now: number): WorkflowTaskRecord {
  return {
    executionId: "execution-1",
    taskId,
    agentId: "codex",
    status: "queued",
    revision: 1,
    attempt: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function handle(taskId: string) {
  return { executionId: "execution-1", taskId };
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
