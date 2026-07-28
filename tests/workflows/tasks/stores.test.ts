/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import type {
  WorkflowTaskClaim,
  WorkflowTaskRecord,
} from "../../../src/workflows/tasks/contracts.js";
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

  test("atomically grants only one claim and fences generic CAS", async () => {
    let now = 10;
    const store = new InMemoryWorkflowTaskStore({ now: () => now });
    await store.create(record("task-1"));

    const attempts = await Promise.allSettled([
      store.claim({
        executionId: "execution-1",
        taskId: "task-1",
        workerId: "worker-1",
        leaseId: "lease-1",
        leaseDurationMs: 10,
      }),
      store.claim({
        executionId: "execution-1",
        taskId: "task-1",
        workerId: "worker-2",
        leaseId: "lease-2",
        leaseDurationMs: 10,
      }),
    ]);

    const fulfilled = attempts.filter(
      (attempt) => attempt.status === "fulfilled",
    );
    const rejected = attempts.filter(
      (attempt) => attempt.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: { code: "WORKFLOW_TASK_CLAIM_CONFLICT" },
    });

    const claimed = await store.get("execution-1", "task-1");
    if (!claimed) throw new Error("Expected claimed task");
    expect(claimed).toMatchObject({
      status: "running",
      revision: 2,
      claim: {
        fencingToken: 1,
        claimedAt: 10,
        heartbeatAt: 10,
        expiresAt: 20,
      },
    });
    expect(Object.isFrozen(claimed?.claim)).toBe(true);

    now = 11;
    await expect(
      store.compareAndSet(
        {
          ...claimed,
          status: "completed",
          revision: 3,
          updatedAt: now,
          completedAt: now,
          output: "unsafe",
          claim: undefined,
        },
        2,
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_TASK_CLAIM_CONFLICT" });
  });

  test("renews a live claim and completes through its fencing guard", async () => {
    let now = 10;
    const store = new InMemoryWorkflowTaskStore({ now: () => now });
    await store.create(record("task-1"));
    const claimed = await store.claim({
      executionId: "execution-1",
      taskId: "task-1",
      workerId: "worker-1",
      leaseId: "lease-1",
      leaseDurationMs: 10,
      expectedRevision: 1,
    });
    const initialClaim = claimOf(claimed);

    now = 15;
    const renewed = await store.renewClaim({
      executionId: "execution-1",
      taskId: "task-1",
      workerId: "worker-1",
      leaseId: "lease-1",
      fencingToken: initialClaim.fencingToken,
      expectedRevision: claimed.revision,
      leaseDurationMs: 20,
    });
    const renewedClaim = claimOf(renewed);
    expect(renewed).toMatchObject({
      revision: 3,
      claim: { heartbeatAt: 15, expiresAt: 35 },
    });

    now = 16;
    const { claim: _claim, ...unclaimed } = renewed;
    const completed = await store.compareAndSetClaimed({
      expectedRevision: renewed.revision,
      claim: {
        executionId: renewed.executionId,
        taskId: renewed.taskId,
        workerId: renewedClaim.workerId,
        leaseId: renewedClaim.leaseId,
        fencingToken: renewedClaim.fencingToken,
      },
      record: {
        ...unclaimed,
        status: "completed",
        revision: renewed.revision + 1,
        updatedAt: now,
        completedAt: now,
        output: { result: "ok" },
      },
    });
    expect(completed).toMatchObject({
      status: "completed",
      revision: 4,
      output: { result: "ok" },
    });
    expect(completed.claim).toBeUndefined();
  });

  test("requeues only expired claims and rejects the old worker after reclaim", async () => {
    let now = 10;
    const store = new InMemoryWorkflowTaskStore({ now: () => now });
    await store.create(record("task-1"));
    const first = await store.claim({
      executionId: "execution-1",
      taskId: "task-1",
      workerId: "worker-1",
      leaseId: "lease-1",
      leaseDurationMs: 10,
    });
    const firstClaim = claimOf(first);

    now = 19;
    await expect(
      store.requeueExpired({
        executionId: "execution-1",
        taskId: "task-1",
        expectedRevision: first.revision,
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_TASK_CLAIM_CONFLICT" });

    now = 20;
    await expect(
      store.renewClaim({
        executionId: "execution-1",
        taskId: "task-1",
        workerId: firstClaim.workerId,
        leaseId: firstClaim.leaseId,
        fencingToken: firstClaim.fencingToken,
        expectedRevision: first.revision,
        leaseDurationMs: 10,
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_TASK_LEASE_EXPIRED" });

    const queued = await store.requeueExpired({
      executionId: "execution-1",
      taskId: "task-1",
      expectedRevision: first.revision,
    });
    expect(queued).toMatchObject({
      status: "queued",
      revision: 3,
      attempt: 2,
    });
    expect(queued.claim).toBeUndefined();
    expect(queued.startedAt).toBeUndefined();

    now = 21;
    const second = await store.claim({
      executionId: "execution-1",
      taskId: "task-1",
      workerId: "worker-2",
      leaseId: "lease-2",
      leaseDurationMs: 10,
      expectedRevision: queued.revision,
    });
    expect(second.claim?.fencingToken).toBe(2);

    now = 22;
    await expect(
      store.renewClaim({
        executionId: "execution-1",
        taskId: "task-1",
        workerId: "worker-1",
        leaseId: "lease-1",
        fencingToken: firstClaim.fencingToken,
        expectedRevision: second.revision,
        leaseDurationMs: 10,
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_TASK_CLAIM_CONFLICT" });

    const { claim: _secondClaim, ...withoutClaim } = second;
    await expect(
      store.compareAndSetClaimed({
        expectedRevision: second.revision,
        claim: {
          executionId: first.executionId,
          taskId: first.taskId,
          workerId: firstClaim.workerId,
          leaseId: firstClaim.leaseId,
          fencingToken: firstClaim.fencingToken,
        },
        record: {
          ...withoutClaim,
          status: "completed",
          revision: second.revision + 1,
          updatedAt: now,
          completedAt: now,
        },
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_TASK_CLAIM_CONFLICT" });
  });

  test("recovers an expired cancelling claim without reviving its worker", async () => {
    let now = 10;
    const store = new InMemoryWorkflowTaskStore({ now: () => now });
    await store.create(record("task-1"));
    const claimed = await store.claim({
      executionId: "execution-1",
      taskId: "task-1",
      workerId: "worker-1",
      leaseId: "lease-1",
      leaseDurationMs: 10,
    });
    const oldClaim = claimOf(claimed);

    now = 11;
    const cancelling = await store.compareAndSetClaimed({
      expectedRevision: claimed.revision,
      claim: {
        executionId: claimed.executionId,
        taskId: claimed.taskId,
        workerId: oldClaim.workerId,
        leaseId: oldClaim.leaseId,
        fencingToken: oldClaim.fencingToken,
      },
      record: {
        ...claimed,
        status: "cancelling",
        revision: claimed.revision + 1,
        updatedAt: now,
        cancelRequestedAt: now,
      },
    });

    now = 19;
    await expect(
      store.cancelExpiredClaim({
        executionId: cancelling.executionId,
        taskId: cancelling.taskId,
        expectedRevision: cancelling.revision,
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_TASK_CLAIM_CONFLICT" });

    now = 20;
    const cancelled = await store.cancelExpiredClaim({
      executionId: cancelling.executionId,
      taskId: cancelling.taskId,
      expectedRevision: cancelling.revision,
    });
    expect(cancelled).toMatchObject({
      status: "cancelled",
      revision: 4,
      cancelRequestedAt: 11,
      completedAt: 20,
      error: {
        code: "WORKFLOW_TASK_CANCELLED",
        message: "Workflow task was cancelled",
      },
    });
    expect(cancelled.claim).toBeUndefined();

    await expect(
      store.cancelExpiredClaim({
        executionId: cancelled.executionId,
        taskId: cancelled.taskId,
        expectedRevision: cancelling.revision,
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_TASK_CONFLICT" });

    await expect(
      store.cancelExpiredClaim({
        executionId: cancelled.executionId,
        taskId: cancelled.taskId,
        expectedRevision: cancelled.revision,
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_TASK_CLAIM_CONFLICT" });

    now = 21;
    await expect(
      store.compareAndSetClaimed({
        expectedRevision: cancelled.revision,
        claim: {
          executionId: claimed.executionId,
          taskId: claimed.taskId,
          workerId: oldClaim.workerId,
          leaseId: oldClaim.leaseId,
          fencingToken: oldClaim.fencingToken,
        },
        record: {
          ...cancelled,
          revision: cancelled.revision + 1,
          updatedAt: now,
        },
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_TASK_CLAIM_CONFLICT" });

    await store.create(record("task-running"));
    const running = await store.claim({
      executionId: "execution-1",
      taskId: "task-running",
      workerId: "worker-2",
      leaseId: "lease-2",
      leaseDurationMs: 1,
    });
    now = 22;
    await expect(
      store.cancelExpiredClaim({
        executionId: running.executionId,
        taskId: running.taskId,
        expectedRevision: running.revision,
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_TASK_CLAIM_CONFLICT" });
  });

  test("waits for a later revision and supports cancellation", async () => {
    let now = 10;
    const store = new InMemoryWorkflowTaskStore({ now: () => now });
    await store.create(record("task-1"));
    const changed = store.waitForRevision("execution-1", "task-1", 1);

    now = 11;
    await store.claim({
      executionId: "execution-1",
      taskId: "task-1",
      workerId: "worker-1",
      leaseId: "lease-1",
      leaseDurationMs: 10,
    });
    await expect(changed).resolves.toMatchObject({ revision: 2 });

    const abort = new AbortController();
    const waiting = store.waitForRevision(
      "execution-1",
      "task-1",
      2,
      abort.signal,
    );
    abort.abort();
    await expect(waiting).rejects.toMatchObject({
      code: "WORKFLOW_TASK_WAIT_ABORTED",
    });
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

function claimOf(record: WorkflowTaskRecord): WorkflowTaskClaim {
  if (!record.claim) throw new Error("Expected task to contain a claim");
  return record.claim;
}
