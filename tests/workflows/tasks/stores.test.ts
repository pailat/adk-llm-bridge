/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import type { WorkflowTaskRecord } from "../../../src/workflows/tasks/contracts.js";
import {
  InMemoryWorkflowTaskMessageStore,
  InMemoryWorkflowTaskStore,
} from "../../../src/workflows/tasks/stores.js";

describe("InMemoryWorkflowTaskStore", () => {
  test("creates immutable snapshots and enforces CAS", async () => {
    const store = new InMemoryWorkflowTaskStore();
    const input = { nested: { value: 1 } };
    const created = await store.create(record("task-1", { input }));

    expect(created).toMatchObject({ status: "queued", revision: 1 });
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.input)).toBe(true);
    input.nested.value = 2;
    expect(created.input).toEqual({ nested: { value: 1 } });

    const running = await store.compareAndSet(
      {
        ...created,
        status: "running",
        revision: 2,
        updatedAt: 2,
        startedAt: 2,
      },
      1,
    );
    expect(running.status).toBe("running");
    await expect(
      store.compareAndSet(
        {
          ...running,
          status: "failed",
          revision: 3,
          updatedAt: 3,
          completedAt: 3,
          error: { code: "X", message: "x" },
        },
        1,
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_TASK_CONFLICT" });
  });

  test("rejects invalid transitions, identity changes, and unsafe JSON", async () => {
    const store = new InMemoryWorkflowTaskStore();
    const created = await store.create(record("task-1"));

    await expect(
      store.compareAndSet(
        {
          ...created,
          status: "completed",
          revision: 2,
          updatedAt: 2,
          startedAt: 2,
          completedAt: 2,
        },
        1,
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_TASK_INVALID_REQUEST" });
    await expect(
      store.compareAndSet(
        {
          ...created,
          agentId: "other",
          status: "running",
          revision: 2,
          updatedAt: 2,
          startedAt: 2,
        },
        1,
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_TASK_INVALID_REQUEST" });
    await expect(
      store.create(record("task-2", { input: { bad: Number.NaN } })),
    ).rejects.toMatchObject({ code: "WORKFLOW_TASK_INVALID_REQUEST" });
  });

  test("lists by execution with bounded, execution-scoped cursors", async () => {
    const store = new InMemoryWorkflowTaskStore();
    await store.create(record("ignored", { executionId: "execution-2" }));
    await store.create(record("task-1"));
    await store.create(
      record("task-2", { parentTaskId: "task-1", agentId: "reviewer" }),
    );
    await store.create(
      record("task-3", { parentTaskId: "task-1", agentId: "reviewer" }),
    );

    const first = await store.list({
      executionId: "execution-1",
      agentId: "reviewer",
      limit: 1,
    });
    expect(first.records.map(({ taskId }) => taskId)).toEqual(["task-2"]);
    expect(first.nextCursor).toBeString();
    const second = await store.list({
      executionId: "execution-1",
      agentId: "reviewer",
      cursor: first.nextCursor,
      limit: 1,
    });
    expect(second.records.map(({ taskId }) => taskId)).toEqual(["task-3"]);
    expect(second.nextCursor).toBeUndefined();
    await expect(
      store.list({ executionId: "execution-2", cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: "WORKFLOW_TASK_INVALID_REQUEST" });
    await expect(
      store.list({
        executionId: "execution-1",
        agentId: "codex",
        cursor: first.nextCursor,
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_TASK_INVALID_REQUEST" });
    await expect(
      store.list({ executionId: "execution-1", limit: 501 }),
    ).rejects.toMatchObject({ code: "WORKFLOW_TASK_INVALID_REQUEST" });
  });
});

describe("InMemoryWorkflowTaskMessageStore", () => {
  test("assigns monotonic sequences and reads with a scoped cursor", async () => {
    const store = new InMemoryWorkflowTaskMessageStore();
    const payload = { request: { value: 1 } };
    const first = await store.append({
      executionId: "execution-1",
      taskId: "task-1",
      senderTaskId: "parent",
      payload,
      sentAt: 1,
    });
    payload.request.value = 2;
    const second = await store.append({
      executionId: "execution-1",
      taskId: "task-1",
      payload: "next",
      sentAt: 2,
    });
    expect(first.sequence).toBe(1);
    expect(first.payload).toEqual({ request: { value: 1 } });
    expect(second.sequence).toBe(2);

    const page = await store.read({
      executionId: "execution-1",
      taskId: "task-1",
      limit: 1,
    });
    expect(page.messages).toEqual([first]);
    expect(page.hasMore).toBe(true);
    const tail = await store.read({
      executionId: "execution-1",
      taskId: "task-1",
      cursor: page.cursor,
    });
    expect(tail.messages).toEqual([second]);
    expect(tail.hasMore).toBe(false);
    await expect(
      store.read({
        executionId: "execution-1",
        taskId: "other",
        cursor: page.cursor,
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_TASK_INVALID_REQUEST" });
  });

  test("fails explicitly when the configured mailbox capacity is reached", async () => {
    const store = new InMemoryWorkflowTaskMessageStore({ capacity: 1 });
    const message = {
      executionId: "execution-1",
      taskId: "task-1",
      payload: "message",
      sentAt: 1,
    } as const;
    await store.append(message);
    await expect(store.append(message)).rejects.toMatchObject({
      code: "WORKFLOW_TASK_MAILBOX_FULL",
      details: { capacity: 1 },
    });
  });

  test("wakes a pending long-poll when a message is appended", async () => {
    const store = new InMemoryWorkflowTaskMessageStore();
    const wait = store.wait({
      executionId: "execution-1",
      taskId: "task-1",
    });

    await store.append({
      executionId: "execution-1",
      taskId: "task-1",
      payload: "wake",
      sentAt: 1,
    });

    await expect(wait).resolves.toMatchObject({
      messages: [{ sequence: 1, payload: "wake" }],
      hasMore: false,
    });
  });

  test("returns immediately when the cursor already has unread messages", async () => {
    const store = new InMemoryWorkflowTaskMessageStore();
    await store.append({
      executionId: "execution-1",
      taskId: "task-1",
      payload: "existing",
      sentAt: 1,
    });

    const result = await store.wait({
      executionId: "execution-1",
      taskId: "task-1",
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.payload).toBe("existing");
  });

  test("aborts and removes a pending waiter without affecting later waits", async () => {
    const store = new InMemoryWorkflowTaskMessageStore();
    const abort = new AbortController();
    const first = store.wait(
      { executionId: "execution-1", taskId: "task-1" },
      abort.signal,
    );
    abort.abort();
    await expect(first).rejects.toMatchObject({
      code: "WORKFLOW_TASK_WAIT_ABORTED",
    });

    const second = store.wait({
      executionId: "execution-1",
      taskId: "task-1",
    });
    await store.append({
      executionId: "execution-1",
      taskId: "task-1",
      payload: "after-abort",
      sentAt: 2,
    });
    await expect(second).resolves.toMatchObject({
      messages: [{ payload: "after-abort" }],
    });
  });

  test("keeps waiters isolated by execution and task mailbox", async () => {
    const store = new InMemoryWorkflowTaskMessageStore();
    let secondSettled = false;
    const first = store.wait({
      executionId: "execution-1",
      taskId: "task-1",
    });
    const second = store
      .wait({ executionId: "execution-1", taskId: "task-2" })
      .finally(() => {
        secondSettled = true;
      });

    await store.append({
      executionId: "execution-1",
      taskId: "task-1",
      payload: "first-only",
      sentAt: 1,
    });
    await first;
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    await store.append({
      executionId: "execution-1",
      taskId: "task-2",
      payload: "second",
      sentAt: 2,
    });
    await expect(second).resolves.toMatchObject({
      messages: [{ payload: "second" }],
    });
  });
});

function record(
  taskId: string,
  overrides: Partial<WorkflowTaskRecord> = {},
): WorkflowTaskRecord {
  return {
    executionId: "execution-1",
    taskId,
    agentId: "codex",
    status: "queued",
    revision: 1,
    attempt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}
