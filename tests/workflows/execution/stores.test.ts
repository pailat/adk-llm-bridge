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
    const completed = {
      ...initial,
      status: "completed",
      revision: 2,
      updatedAt: 2,
      completedAt: 2,
    } satisfies WorkflowExecutionRecord;
    const failed = {
      ...initial,
      status: "failed",
      revision: 2,
      updatedAt: 2,
      completedAt: 2,
      error: { code: "FAILED", message: "failed" },
    } satisfies WorkflowExecutionRecord;

    const results = await Promise.allSettled([
      store.compareAndSet(completed, 1),
      store.compareAndSet(failed, 1),
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
