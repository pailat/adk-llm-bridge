/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import type { WorkflowEvent } from "../../../src/workflows/events.js";
import type {
  WorkflowExecutionDriver,
  WorkflowExecutionDriverRequest,
  WorkflowExecutionDriverResult,
  WorkflowExecutionRecord,
} from "../../../src/workflows/execution/contracts.js";
import {
  WorkflowExecutionController,
  type WorkflowExecutionControllerConfig,
} from "../../../src/workflows/execution/controller.js";
import {
  InMemoryWorkflowExecutionEventStore,
  InMemoryWorkflowExecutionStore,
  type WorkflowExecutionStore,
} from "../../../src/workflows/execution/stores.js";

describe("WorkflowExecutionController", () => {
  test("starts promptly, persists events, and exposes a wait boundary", async () => {
    const gate = deferred<WorkflowExecutionDriverResult>();
    let driverRequest: WorkflowExecutionDriverRequest | undefined;
    const { controller } = harness({
      async execute(request) {
        driverRequest = request;
        await request.emit(event(request.execution, "started"));
        return await gate.promise;
      },
    });

    const started = await controller.start(request("execution-1"));

    expect(started.status).toBe("queued");
    await eventually(async () => {
      expect((await controller.status("execution-1")).status).toBe("running");
    });
    expect(driverRequest?.signal).toBeInstanceOf(AbortSignal);
    const events = await controller.events({ executionId: "execution-1" });
    expect(events.events).toHaveLength(1);
    expect(events.events[0]).toMatchObject({
      sequence: 1,
      event: { type: "custom", name: "started" },
    });

    gate.resolve({ output: { result: "done" } });
    const completed = await controller.wait("execution-1");
    expect(completed).toMatchObject({
      status: "completed",
      attempt: 1,
      output: { result: "done" },
    });
    expect(Object.isFrozen(completed.output)).toBe(true);
  });

  test("cancels through AbortSignal and makes repeated cancel idempotent", async () => {
    let observedSignal: AbortSignal | undefined;
    const { controller } = harness({
      async execute({ signal }) {
        observedSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
        return {};
      },
    });
    await controller.start(request("execution-1"));
    await eventually(async () => {
      expect((await controller.status("execution-1")).status).toBe("running");
    });

    const first = await controller.cancel("execution-1");
    const second = await controller.cancel("execution-1");
    const terminal = await controller.wait("execution-1");
    const third = await controller.cancel("execution-1");

    expect(["cancelling", "cancelled"]).toContain(first.status);
    expect(["cancelling", "cancelled"]).toContain(second.status);
    expect(observedSignal?.aborted).toBe(true);
    expect(terminal).toMatchObject({
      status: "cancelled",
      error: { code: "WORKFLOW_EXECUTION_CANCELLED" },
    });
    expect(third).toBe(terminal);
  });

  test("cancels atomically between queued read and running claim", async () => {
    const store = new ClaimBarrierStore();
    let driverCalls = 0;
    const controller = new WorkflowExecutionController({
      store,
      eventStore: new InMemoryWorkflowExecutionEventStore(),
      driver: {
        async execute() {
          driverCalls++;
          return {};
        },
      },
    });
    await controller.start(request("execution-1"));
    await store.claimStarted.promise;

    const cancelling = await controller.cancel("execution-1");
    expect(cancelling.status).toBe("cancelling");
    store.allowClaim.resolve(undefined);

    const terminal = await controller.wait("execution-1");
    expect(terminal.status).toBe("cancelled");
    expect(driverCalls).toBe(0);
  });

  test("rejects duplicate starts atomically across controllers", async () => {
    const store = new InMemoryWorkflowExecutionStore();
    const eventStore = new InMemoryWorkflowExecutionEventStore();
    const gate = deferred<WorkflowExecutionDriverResult>();
    const driver: WorkflowExecutionDriver = {
      execute: async () => await gate.promise,
    };
    const first = new WorkflowExecutionController({
      store,
      eventStore,
      driver,
    });
    const second = new WorkflowExecutionController({
      store,
      eventStore,
      driver,
    });

    const starts = await Promise.allSettled([
      first.start(request("execution-1")),
      second.start(request("execution-1")),
    ]);

    expect(
      starts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(starts.find((result) => result.status === "rejected")).toMatchObject(
      {
        reason: { code: "WORKFLOW_EXECUTION_DUPLICATE" },
      },
    );
    gate.resolve({});
    await Promise.all([first.waitForIdle(), second.waitForIdle()]);
  });

  test("resumes only terminal executions with explicit checkpoint strategy", async () => {
    let calls = 0;
    const { controller } = harness({
      async execute() {
        calls++;
        if (calls === 1)
          throw Object.assign(new Error("first failed"), {
            code: "DRIVER_FAILED",
          });
        return { output: "recovered" };
      },
    });
    await controller.start(request("execution-1"));
    const failed = await controller.wait("execution-1");
    expect(failed).toMatchObject({
      status: "failed",
      attempt: 1,
      error: { code: "DRIVER_FAILED", message: "first failed" },
    });

    const resumed = await controller.resume({
      executionId: "execution-1",
      strategy: "checkpoint",
    });
    expect(resumed).toMatchObject({ status: "queued", attempt: 2 });
    expect(resumed.error).toBeUndefined();
    const completed = await controller.wait("execution-1");
    expect(completed).toMatchObject({
      status: "completed",
      attempt: 2,
      output: "recovered",
    });
    await expect(
      controller.resume({
        executionId: "execution-1",
        strategy: "checkpoint",
      }),
    ).rejects.toMatchObject({
      code: "WORKFLOW_EXECUTION_INVALID_TRANSITION",
    });
  });

  test("does not pretend to recover or cancel an unowned in-flight process", async () => {
    const store = new InMemoryWorkflowExecutionStore();
    await store.create({
      ...record("execution-1"),
      status: "running",
      startedAt: 2,
      updatedAt: 2,
    });
    const controller = new WorkflowExecutionController({
      store,
      eventStore: new InMemoryWorkflowExecutionEventStore(),
      driver: { execute: async () => ({}) },
    });

    await expect(controller.cancel("execution-1")).rejects.toMatchObject({
      code: "WORKFLOW_EXECUTION_NOT_OWNED",
    });
    await expect(
      controller.resume({
        executionId: "execution-1",
        strategy: "checkpoint",
      }),
    ).rejects.toMatchObject({
      code: "WORKFLOW_EXECUTION_INVALID_TRANSITION",
    });
    expect((await controller.status("execution-1")).status).toBe("running");
  });

  test("rejects driver events after the execution becomes terminal", async () => {
    let emit: WorkflowExecutionDriverRequest["emit"] | undefined;
    const { controller } = harness({
      async execute(request) {
        emit = request.emit;
        return {};
      },
    });
    await controller.start(request("execution-1"));
    const terminal = await controller.wait("execution-1");
    expect(terminal.status).toBe("completed");

    await expect(emit?.(event(terminal, "late"))).rejects.toMatchObject({
      code: "WORKFLOW_EXECUTION_INVALID_TRANSITION",
    });
  });

  test("contains background infrastructure failures and reports them", async () => {
    const store = new FailingClaimStore();
    const backgroundErrors: unknown[] = [];
    const controller = new WorkflowExecutionController({
      store,
      eventStore: new InMemoryWorkflowExecutionEventStore(),
      driver: { execute: async () => ({}) },
      onBackgroundError: (error) => backgroundErrors.push(error),
    });

    const queued = await controller.start(request("execution-1"));
    const afterBackground = await controller.wait("execution-1");

    expect(queued.status).toBe("queued");
    expect(afterBackground.status).toBe("queued");
    expect(backgroundErrors).toHaveLength(1);
    expect(backgroundErrors[0]).toBeInstanceOf(Error);
  });

  test("validates JSON-safe requests before launching a driver", async () => {
    let calls = 0;
    const { controller } = harness({
      async execute() {
        calls++;
        return {};
      },
    });

    await expect(
      controller.start({
        ...request("execution-1"),
        input: { invalid: Number.POSITIVE_INFINITY },
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_EXECUTION_INVALID_REQUEST" });
    await expect(
      controller.start({
        ...request("execution-2"),
        extra: true,
      } as never),
    ).rejects.toMatchObject({ code: "WORKFLOW_EXECUTION_INVALID_REQUEST" });
    expect(calls).toBe(0);
  });
});

function harness(driver: WorkflowExecutionDriver): {
  controller: WorkflowExecutionController;
  store: InMemoryWorkflowExecutionStore;
  eventStore: InMemoryWorkflowExecutionEventStore;
} {
  const store = new InMemoryWorkflowExecutionStore();
  const eventStore = new InMemoryWorkflowExecutionEventStore();
  let timestamp = 0;
  const config = {
    store,
    eventStore,
    driver,
    now: () => ++timestamp,
  } satisfies WorkflowExecutionControllerConfig;
  return {
    controller: new WorkflowExecutionController(config),
    store,
    eventStore,
  };
}

function request(executionId: string) {
  return {
    executionId,
    workflowId: "workflow",
    workflowVersion: "1",
    input: { task: "build" },
  } as const;
}

function record(executionId: string): WorkflowExecutionRecord {
  return {
    ...request(executionId),
    status: "queued",
    revision: 1,
    attempt: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function event(record: WorkflowExecutionRecord, name: string): WorkflowEvent {
  return {
    type: "custom",
    workflowId: record.workflowId,
    workflowVersion: record.workflowVersion,
    executionId: record.executionId,
    timestamp: record.updatedAt,
    name,
    data: { safe: true },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

class ClaimBarrierStore implements WorkflowExecutionStore {
  readonly #inner = new InMemoryWorkflowExecutionStore();
  readonly claimStarted = deferred<void>();
  readonly allowClaim = deferred<void>();

  create(record: WorkflowExecutionRecord) {
    return this.#inner.create(record);
  }

  get(executionId: string) {
    return this.#inner.get(executionId);
  }

  async compareAndSet(
    record: WorkflowExecutionRecord,
    expectedRevision: number,
  ) {
    if (record.status === "running") {
      this.claimStarted.resolve(undefined);
      await this.allowClaim.promise;
    }
    return await this.#inner.compareAndSet(record, expectedRevision);
  }

  list(request?: Parameters<WorkflowExecutionStore["list"]>[0]) {
    return this.#inner.list(request);
  }
}

class FailingClaimStore extends InMemoryWorkflowExecutionStore {
  override async compareAndSet(
    record: WorkflowExecutionRecord,
    expectedRevision: number,
  ) {
    if (record.status === "running") throw new Error("storage unavailable");
    return await super.compareAndSet(record, expectedRevision);
  }
}

async function eventually(
  assertion: () => void | Promise<void>,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (attempt === 99) throw error;
      await Promise.resolve();
    }
  }
}
