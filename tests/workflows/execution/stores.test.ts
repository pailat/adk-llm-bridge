/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import type { WorkflowEvent } from "../../../src/workflows/events.js";
import type { WorkflowExecutionRecord } from "../../../src/workflows/execution/contracts.js";
import {
  InMemoryWorkflowExecutionEventStore,
  InMemoryWorkflowExecutionStore,
  MAX_WORKFLOW_EVENT_READ_LIMIT,
  MAX_WORKFLOW_EXECUTION_LIST_LIMIT,
} from "../../../src/workflows/execution/stores.js";

describe("InMemoryWorkflowExecutionStore", () => {
  test("applies exactly one concurrent CAS transition", async () => {
    const store = new InMemoryWorkflowExecutionStore();
    const initial = await store.create(record("execution-1"));
    const running = {
      ...initial,
      status: "running",
      revision: 2,
      updatedAt: 2,
      startedAt: 2,
    } satisfies WorkflowExecutionRecord;
    const cancelling = {
      ...initial,
      status: "cancelling",
      revision: 2,
      updatedAt: 2,
      cancelRequestedAt: 2,
    } satisfies WorkflowExecutionRecord;

    const results = await Promise.allSettled([
      store.compareAndSet(running, 1),
      store.compareAndSet(cancelling, 1),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({
      reason: { code: "WORKFLOW_EXECUTION_CONFLICT" },
    });
    expect((await store.get("execution-1"))?.revision).toBe(2);
  });

  test("enforces record shapes, transition matrix, and attempt semantics", async () => {
    const store = new InMemoryWorkflowExecutionStore();
    await expect(
      store.create(record("invalid-running", { status: "running" })),
    ).rejects.toMatchObject({ code: "WORKFLOW_EXECUTION_INVALID_REQUEST" });
    const queued = await store.create(record("execution-1"));

    await expect(
      store.compareAndSet(
        {
          ...queued,
          status: "completed",
          revision: 2,
          updatedAt: 2,
          startedAt: 2,
          completedAt: 2,
        },
        1,
      ),
    ).rejects.toMatchObject({
      code: "WORKFLOW_EXECUTION_INVALID_TRANSITION",
    });
    await expect(
      store.compareAndSet(
        {
          ...queued,
          status: "running",
          revision: 2,
          attempt: 2,
          updatedAt: 2,
          startedAt: 2,
        },
        1,
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_EXECUTION_INVALID_REQUEST" });

    const terminalStore = new InMemoryWorkflowExecutionStore();
    const completed = await terminalStore.create(
      record("terminal", {
        status: "completed",
        updatedAt: 2,
        startedAt: 1,
        completedAt: 2,
      }),
    );
    await expect(
      terminalStore.compareAndSet(
        {
          ...completed,
          status: "running",
          revision: 2,
          updatedAt: 3,
          startedAt: 1,
          completedAt: undefined,
        },
        1,
      ),
    ).rejects.toMatchObject({
      code: "WORKFLOW_EXECUTION_INVALID_TRANSITION",
    });
  });

  test("rejects inconsistent terminal and cancellation fields", async () => {
    const invalidRecords: WorkflowExecutionRecord[] = [
      record("completed-with-error", {
        status: "completed",
        updatedAt: 2,
        startedAt: 1,
        completedAt: 2,
        error: { code: "FAILED", message: "unexpected" },
      }),
      record("failed-without-error", {
        status: "failed",
        updatedAt: 2,
        startedAt: 1,
        completedAt: 2,
      }),
      record("cancelled-without-request", {
        status: "cancelled",
        updatedAt: 2,
        completedAt: 2,
        error: { code: "CANCELLED", message: "cancelled" },
      }),
    ];

    for (const invalidRecord of invalidRecords) {
      await expect(
        new InMemoryWorkflowExecutionStore().create(invalidRecord),
      ).rejects.toMatchObject({
        code: "WORKFLOW_EXECUTION_INVALID_REQUEST",
      });
    }
  });

  test("keeps workflow request identity and payload immutable across CAS", async () => {
    const store = new InMemoryWorkflowExecutionStore();
    const queued = await store.create(
      record("execution-1", {
        input: { task: "original" },
        metadata: { owner: "agent-a" },
      }),
    );

    await expect(
      store.compareAndSet(
        {
          ...queued,
          input: { task: "mutated" },
          status: "running",
          revision: 2,
          updatedAt: 2,
          startedAt: 2,
        },
        1,
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_EXECUTION_INVALID_REQUEST" });
    await expect(
      store.compareAndSet(
        {
          ...queued,
          metadata: { owner: "agent-b" },
          status: "running",
          revision: 2,
          updatedAt: 2,
          startedAt: 2,
        },
        1,
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_EXECUTION_INVALID_REQUEST" });
  });

  test("does not rewrite lifecycle timestamps across transitions", async () => {
    const store = new InMemoryWorkflowExecutionStore();
    const queued = await store.create(record("execution-1"));
    const running = await store.compareAndSet(
      {
        ...queued,
        status: "running",
        revision: 2,
        updatedAt: 2,
        startedAt: 2,
      },
      1,
    );

    await expect(
      store.compareAndSet(
        {
          ...running,
          status: "completed",
          revision: 3,
          updatedAt: 4,
          startedAt: 3,
          completedAt: 4,
        },
        2,
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_EXECUTION_INVALID_REQUEST" });
  });

  test("stores immutable JSON snapshots and rejects duplicates", async () => {
    const store = new InMemoryWorkflowExecutionStore();
    const mutable = record("execution-1", {
      metadata: { nested: { value: "original" } },
    });
    const saved = await store.create(mutable);
    (mutable.metadata?.nested as { value: string }).value = "mutated";

    expect(saved.metadata).toEqual({ nested: { value: "original" } });
    expect(Object.isFrozen(saved)).toBe(true);
    expect(Object.isFrozen(saved.metadata?.nested)).toBe(true);
    expect(() => {
      (saved.metadata?.nested as { value: string }).value = "forbidden";
    }).toThrow();
    await expect(store.create(record("execution-1"))).rejects.toMatchObject({
      code: "WORKFLOW_EXECUTION_DUPLICATE",
    });
  });

  test("lists records through bounded opaque cursors", async () => {
    const store = new InMemoryWorkflowExecutionStore();
    await store.create(record("execution-1"));
    await store.create(record("execution-2"));
    await store.create(record("execution-3"));

    const first = await store.list({ limit: 2 });
    const second = await store.list({ limit: 2, cursor: first.nextCursor });

    expect(first.records.map((item) => item.executionId)).toEqual([
      "execution-1",
      "execution-2",
    ]);
    expect(first.nextCursor).toBeString();
    expect(second.records.map((item) => item.executionId)).toEqual([
      "execution-3",
    ]);
    expect(second.nextCursor).toBeUndefined();
    await expect(
      store.list({ limit: MAX_WORKFLOW_EXECUTION_LIST_LIMIT + 1 }),
    ).rejects.toMatchObject({ code: "WORKFLOW_EXECUTION_INVALID_REQUEST" });
    await expect(store.list({ cursor: "invalid" })).rejects.toMatchObject({
      code: "WORKFLOW_EXECUTION_INVALID_REQUEST",
    });
  });
});

describe("InMemoryWorkflowExecutionEventStore", () => {
  test("validates bounded capacity configuration", () => {
    expect(
      () =>
        new InMemoryWorkflowExecutionEventStore({
          maxEventsPerExecution: 0,
        }),
    ).toThrowError(
      expect.objectContaining({
        code: "WORKFLOW_EXECUTION_INVALID_REQUEST",
      }),
    );
  });

  test("assigns monotonic sequences and reads strictly after a cursor", async () => {
    const store = new InMemoryWorkflowExecutionEventStore();
    const appended = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        store.append("execution-1", event("execution-1", index + 1)),
      ),
    );

    expect(appended.map((item) => item.sequence)).toEqual([1, 2, 3, 4, 5]);
    const first = await store.read({ executionId: "execution-1", limit: 2 });
    const second = await store.read({
      executionId: "execution-1",
      cursor: first.cursor,
      limit: 2,
    });
    const third = await store.read({
      executionId: "execution-1",
      cursor: second.cursor,
      limit: 2,
    });

    expect(first.events.map((item) => item.sequence)).toEqual([1, 2]);
    expect(second.events.map((item) => item.sequence)).toEqual([3, 4]);
    expect(third.events.map((item) => item.sequence)).toEqual([5]);
    expect(first.hasMore).toBe(true);
    expect(third.hasMore).toBe(false);
    expect(third.cursor).toEqual({
      executionId: "execution-1",
      afterSequence: 5,
    });
  });

  test("normalizes event snapshots and enforces stream and read bounds", async () => {
    const store = new InMemoryWorkflowExecutionEventStore();
    const mutable = event("execution-1", 1) as WorkflowEvent & {
      data: { value: string };
    };
    mutable.data = { value: "original" };
    const saved = await store.append("execution-1", mutable);
    mutable.data.value = "mutated";

    expect(saved.event).toMatchObject({ data: { value: "original" } });
    expect(Object.isFrozen(saved.event)).toBe(true);
    await expect(
      store.append("execution-2", event("execution-1", 2)),
    ).rejects.toMatchObject({ code: "WORKFLOW_EXECUTION_INVALID_REQUEST" });
    await expect(
      store.read({
        executionId: "execution-1",
        limit: MAX_WORKFLOW_EVENT_READ_LIMIT + 1,
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_EXECUTION_INVALID_REQUEST" });
    await expect(
      store.read({
        executionId: "execution-1",
        cursor: { executionId: "execution-2", afterSequence: 0 },
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_EXECUTION_INVALID_REQUEST" });
  });

  test("rejects capacity overflow without deleting events or invalidating cursors", async () => {
    const store = new InMemoryWorkflowExecutionEventStore({
      maxEventsPerExecution: 2,
      maxTotalEvents: 3,
    });
    await store.append("execution-1", event("execution-1", 1));
    const first = await store.read({ executionId: "execution-1", limit: 1 });
    await store.append("execution-1", event("execution-1", 2));

    await expect(
      store.append("execution-1", event("execution-1", 3)),
    ).rejects.toMatchObject({
      code: "WORKFLOW_EXECUTION_CAPACITY_EXCEEDED",
    });
    const remaining = await store.read({
      executionId: "execution-1",
      cursor: first.cursor,
    });
    expect(remaining.events.map((item) => item.sequence)).toEqual([2]);

    await store.append("execution-2", event("execution-2", 3));
    await expect(
      store.append("execution-3", event("execution-3", 4)),
    ).rejects.toMatchObject({
      code: "WORKFLOW_EXECUTION_CAPACITY_EXCEEDED",
    });
    expect(
      (await store.read({ executionId: "execution-1" })).events,
    ).toHaveLength(2);
  });
});

function record(
  executionId: string,
  overrides: Partial<WorkflowExecutionRecord> = {},
): WorkflowExecutionRecord {
  return {
    executionId,
    workflowId: "workflow",
    workflowVersion: "1",
    status: "queued",
    revision: 1,
    attempt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function event(executionId: string, timestamp: number): WorkflowEvent {
  return {
    type: "custom",
    workflowId: "workflow",
    workflowVersion: "1",
    executionId,
    timestamp,
    name: `event-${timestamp}`,
  };
}
