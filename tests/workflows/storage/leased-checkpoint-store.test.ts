import { describe, expect, test } from "bun:test";
import type { InvocationContext } from "@google/adk";
import {
  createWorkflowCheckpoint,
  withWorkflowCompleted,
  withWorkflowFailed,
  withWorkflowStepWaiting,
} from "../../../src/workflows/checkpoint/checkpoint.js";
import type { WorkflowCheckpointV1 } from "../../../src/workflows/checkpoint/schema.js";
import {
  WorkflowCheckpointConflictError,
  workflowCheckpointKey,
  workflowCheckpointRevision,
} from "../../../src/workflows/checkpoint/store.js";
import type { WorkflowStep } from "../../../src/workflows/contracts.js";
import { defineWorkflow } from "../../../src/workflows/definition.js";
import {
  BaseWorkflowCheckpointStore,
  type WorkflowCheckpointStoreCapabilities,
} from "../../../src/workflows/storage/checkpoint-store.js";
import {
  isWorkflowStorageError,
  type WorkflowStorageError,
} from "../../../src/workflows/storage/errors.js";
import { InMemoryWorkflowCheckpointStore } from "../../../src/workflows/storage/in-memory-checkpoint-store.js";
import {
  DEFAULT_WORKFLOW_CHECKPOINT_LEASE_TTL_MS,
  LeasedWorkflowCheckpointStore,
} from "../../../src/workflows/storage/leased-checkpoint-store.js";
import * as support from "../../../src/workflows/storage/support.js";
import { fromPartial } from "../../helpers/partial.js";

const context = fromPartial<InvocationContext>({});
const WF = "wf";
const EXEC = "exec-1";
const locator = { workflowId: WF, executionId: EXEC };

const definition = defineWorkflow({
  id: WF,
  version: "1",
  handler: () => "done",
});

async function makeCheckpoint(now = 1): Promise<WorkflowCheckpointV1> {
  return await createWorkflowCheckpoint({
    definition,
    executionId: EXEC,
    input: "input",
    now,
  });
}

async function reject(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

function clock(start = 1_000_000) {
  const state = { now: start };
  return { state, now: () => state.now };
}

/** A provider that reports advisory compare-and-set and counts every call. */
class AdvisoryStore extends BaseWorkflowCheckpointStore {
  readonly providerName = "advisory-fake";
  readonly capabilities: WorkflowCheckpointStoreCapabilities;
  reads = 0;
  writes = 0;
  leaseCalls = 0;

  constructor(flags: Partial<WorkflowCheckpointStoreCapabilities> = {}) {
    super();
    this.capabilities = {
      compareAndSet: "advisory",
      leases: true,
      durable: false,
      multiProcess: false,
      listing: false,
      pruning: false,
      maxCheckpointBytes: 4 * 1024 * 1024,
      ...flags,
    };
  }

  protected async readCheckpoint(): Promise<undefined> {
    this.reads += 1;
    return undefined;
  }

  protected async writeCheckpoint(): Promise<number> {
    this.writes += 1;
    return 1;
  }

  protected async acquireCheckpointLease(): Promise<never> {
    this.leaseCalls += 1;
    throw new Error("must not be called");
  }
}

function tryConstruct(build: () => unknown): unknown {
  try {
    build();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("LeasedWorkflowCheckpointStore construction", () => {
  test("a provider whose compareAndSet is advisory is refused with a typed error and nothing is written", async () => {
    const store = new AdvisoryStore();
    const error = tryConstruct(
      () => new LeasedWorkflowCheckpointStore({ store }),
    );
    expect(isWorkflowStorageError(error, "WORKFLOW_STORAGE_UNSUPPORTED")).toBe(
      true,
    );
    const typed = error as WorkflowStorageError & { capability?: unknown };
    expect(typed.capability ?? typed.details.capability).toBe("compareAndSet");
    expect(store.writes).toBe(0);
    expect(store.reads).toBe(0);
    expect(store.leaseCalls).toBe(0);
  });

  test("the construction guard is the exported requireWorkflowCheckpointCapability", async () => {
    const store = new AdvisoryStore();
    const direct = tryConstruct(() =>
      support.requireWorkflowCheckpointCapability(store, "compareAndSet"),
    );
    const viaWrapper = tryConstruct(
      () => new LeasedWorkflowCheckpointStore({ store }),
    );
    expect((viaWrapper as WorkflowStorageError).code).toBe(
      (direct as WorkflowStorageError).code,
    );
    expect(
      support.requireWorkflowCheckpointCapability(
        new InMemoryWorkflowCheckpointStore(),
        "compareAndSet",
      ),
    ).toBeUndefined();
  });

  test("the advisory refusal happens even when the provider claims leases", () => {
    const store = new AdvisoryStore({ leases: true });
    expect(
      isWorkflowStorageError(
        tryConstruct(() => new LeasedWorkflowCheckpointStore({ store })),
        "WORKFLOW_STORAGE_UNSUPPORTED",
      ),
    ).toBe(true);
  });

  test("a provider without leases is refused with WORKFLOW_STORAGE_UNSUPPORTED", () => {
    const store = new AdvisoryStore({ compareAndSet: "atomic", leases: false });
    const error = tryConstruct(
      () => new LeasedWorkflowCheckpointStore({ store }),
    );
    expect(isWorkflowStorageError(error, "WORKFLOW_STORAGE_UNSUPPORTED")).toBe(
      true,
    );
    expect(store.writes).toBe(0);
  });

  test("the in-memory provider is accepted", () => {
    const store = new InMemoryWorkflowCheckpointStore();
    const leased = new LeasedWorkflowCheckpointStore({ store });
    expect(leased.store).toBe(store);
  });

  test("rejects a bad ttlMs or ownerId with WORKFLOW_STORAGE_INVALID_OPTION", () => {
    const store = new InMemoryWorkflowCheckpointStore();
    for (const options of [
      { ttlMs: 0 },
      { ttlMs: -1 },
      { ttlMs: 1.5 },
      { ttlMs: Number.NaN },
      { ownerId: "" },
      { ownerId: "   " },
    ]) {
      expect(
        isWorkflowStorageError(
          tryConstruct(
            () => new LeasedWorkflowCheckpointStore({ store, ...options }),
          ),
          "WORKFLOW_STORAGE_INVALID_OPTION",
        ),
      ).toBe(true);
    }
  });

  test("keeps a given owner id and generates a distinct one per instance otherwise", () => {
    const store = new InMemoryWorkflowCheckpointStore();
    expect(
      new LeasedWorkflowCheckpointStore({ store, ownerId: "me" }).ownerId,
    ).toBe("me");
    const a = new LeasedWorkflowCheckpointStore({ store });
    const b = new LeasedWorkflowCheckpointStore({ store });
    expect(a.ownerId.length).toBeGreaterThan(8);
    expect(a.ownerId).not.toBe(b.ownerId);
  });

  test("the default lease lifetime is 30 seconds", () => {
    expect(DEFAULT_WORKFLOW_CHECKPOINT_LEASE_TTL_MS).toBe(30_000);
  });
});

describe("LeasedWorkflowCheckpointStore leasing", () => {
  async function workers(count: number, ttlMs = 60_000) {
    const store = new InMemoryWorkflowCheckpointStore();
    const leased = Array.from(
      { length: count },
      (_, i) =>
        new LeasedWorkflowCheckpointStore({
          store,
          ownerId: `worker-${i}`,
          ttlMs,
        }),
    );
    return { store, leased };
  }

  test("the first load acquires the lease and another worker is refused with WORKFLOW_STORAGE_LEASE_HELD", async () => {
    const { leased } = await workers(2);
    const [a, b] = leased as [
      LeasedWorkflowCheckpointStore,
      LeasedWorkflowCheckpointStore,
    ];
    try {
      expect(await a.load({ ...locator, context })).toBeUndefined();
      const error = await reject(b.load({ ...locator, context }));
      expect(isWorkflowStorageError(error, "WORKFLOW_STORAGE_LEASE_HELD")).toBe(
        true,
      );
    } finally {
      await Promise.all(leased.map((w) => w.close()));
    }
  });

  test("a refused save writes nothing", async () => {
    const { store, leased } = await workers(2);
    const [a, b] = leased as [
      LeasedWorkflowCheckpointStore,
      LeasedWorkflowCheckpointStore,
    ];
    try {
      await a.load({ ...locator, context });
      const error = await reject(
        b.save({ context, checkpoint: await makeCheckpoint() }),
      );
      expect(isWorkflowStorageError(error, "WORKFLOW_STORAGE_LEASE_HELD")).toBe(
        true,
      );
      expect(await store.get(locator)).toBeUndefined();
    } finally {
      await Promise.all(leased.map((w) => w.close()));
    }
  });

  test("a save acquires the lease when no load came first, and returns the plain stateDelta", async () => {
    const { store, leased } = await workers(2);
    const [a, b] = leased as [
      LeasedWorkflowCheckpointStore,
      LeasedWorkflowCheckpointStore,
    ];
    try {
      const checkpoint = await makeCheckpoint();
      const write = await a.save({
        context,
        checkpoint,
        expectedRevision: null,
      });
      const key = workflowCheckpointKey(WF, EXEC);
      expect(write.checkpointKey).toBe(key);
      expect(write.stateDelta).toEqual({ [key]: checkpoint });
      expect((await store.get(locator))?.checkpoint).toEqual(checkpoint);
      expect(
        isWorkflowStorageError(
          await reject(b.load({ ...locator, context })),
          "WORKFLOW_STORAGE_LEASE_HELD",
        ),
      ).toBe(true);
    } finally {
      await Promise.all(leased.map((w) => w.close()));
    }
  });

  test("the lease is acquired once and reused by later calls of the same worker", async () => {
    const { store, leased } = await workers(1);
    const [a] = leased as [LeasedWorkflowCheckpointStore];
    const original = store.acquireLease.bind(store);
    let acquisitions = 0;
    store.acquireLease = (input) => {
      acquisitions += 1;
      return original(input);
    };
    try {
      await a.load({ ...locator, context });
      const first = await makeCheckpoint(1);
      await a.save({ context, checkpoint: first, expectedRevision: null });
      await a.save({
        context,
        checkpoint: await makeCheckpoint(2),
        expectedRevision: await workflowCheckpointRevision(first),
      });
      await a.load({ ...locator, context });
      expect(acquisitions).toBe(1);
    } finally {
      await a.close();
    }
  });

  test("only one of N workers gets an execution", async () => {
    const { leased } = await workers(8);
    try {
      const results = await Promise.allSettled(
        leased.map((w) => w.load({ ...locator, context })),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const result of results) {
        if (result.status === "rejected") {
          expect(
            isWorkflowStorageError(
              result.reason,
              "WORKFLOW_STORAGE_LEASE_HELD",
            ),
          ).toBe(true);
        }
      }
    } finally {
      await Promise.all(leased.map((w) => w.close()));
    }
  });

  test("executions are leased independently", async () => {
    const { leased } = await workers(2);
    const [a, b] = leased as [
      LeasedWorkflowCheckpointStore,
      LeasedWorkflowCheckpointStore,
    ];
    try {
      await a.load({ ...locator, context });
      await b.load({ workflowId: WF, executionId: "exec-2", context });
    } finally {
      await Promise.all(leased.map((w) => w.close()));
    }
  });

  test("compare-and-set preconditions pass through: a stale expectedRevision conflicts", async () => {
    const { store, leased } = await workers(1);
    const [a] = leased as [LeasedWorkflowCheckpointStore];
    try {
      const first = await makeCheckpoint(1);
      await a.save({ context, checkpoint: first, expectedRevision: null });
      const error = await reject(
        a.save({
          context,
          checkpoint: await makeCheckpoint(2),
          expectedRevision: "sha256:stale",
        }),
      );
      expect(error).toBeInstanceOf(WorkflowCheckpointConflictError);
      expect((await store.get(locator))?.checkpoint).toEqual(first);
    } finally {
      await a.close();
    }
  });

  test("a worker that lost its lease cannot overwrite the checkpoint of the new owner", async () => {
    const time = clock();
    const store = new InMemoryWorkflowCheckpointStore({ now: time.now });
    const lost: Array<{
      workflowId: string;
      executionId: string;
      fencingToken: number;
    }> = [];
    const a = new LeasedWorkflowCheckpointStore({
      store,
      ownerId: "a",
      ttlMs: 60_000,
      onLeaseLost: (info) => lost.push(info),
    });
    const b = new LeasedWorkflowCheckpointStore({
      store,
      ownerId: "b",
      ttlMs: 60_000,
    });
    try {
      const first = await makeCheckpoint(1);
      await a.save({ context, checkpoint: first, expectedRevision: null });
      // A pauses past the lease lifetime; B takes the execution over.
      time.state.now += 120_000;
      await b.load({ ...locator, context });
      const second = await makeCheckpoint(2);
      await b.save({
        context,
        checkpoint: second,
        expectedRevision: await workflowCheckpointRevision(first),
      });
      const error = await reject(
        a.save({
          context,
          checkpoint: await makeCheckpoint(3),
          expectedRevision: await workflowCheckpointRevision(first),
        }),
      );
      expect(isWorkflowStorageError(error, "WORKFLOW_STORAGE_LEASE_LOST")).toBe(
        true,
      );
      expect((await store.get(locator))?.checkpoint).toEqual(second);
      expect(lost).toEqual([{ ...locator, fencingToken: 1 }]);
    } finally {
      await a.close();
      await b.close();
    }
  });

  test("onLeaseLost is called once even when several saves are fenced", async () => {
    const time = clock();
    const store = new InMemoryWorkflowCheckpointStore({ now: time.now });
    let calls = 0;
    const a = new LeasedWorkflowCheckpointStore({
      store,
      ownerId: "a",
      ttlMs: 60_000,
      onLeaseLost: () => {
        calls += 1;
      },
    });
    try {
      await a.save({ context, checkpoint: await makeCheckpoint(1) });
      time.state.now += 120_000;
      await store.acquireLease({ ...locator, ownerId: "thief", ttlMs: 60_000 });
      for (const now of [2, 3, 4]) {
        await reject(
          a.save({ context, checkpoint: await makeCheckpoint(now) }),
        );
      }
      expect(calls).toBe(1);
    } finally {
      await a.close();
    }
  });

  test("the lease is renewed while the execution is active", async () => {
    const store = new InMemoryWorkflowCheckpointStore();
    const a = new LeasedWorkflowCheckpointStore({
      store,
      ownerId: "a",
      ttlMs: 90,
    });
    const b = new LeasedWorkflowCheckpointStore({
      store,
      ownerId: "b",
      ttlMs: 90,
    });
    try {
      await a.load({ ...locator, context });
      // Three times the lifetime: without renewal A would have expired.
      await new Promise((resolve) => setTimeout(resolve, 280));
      const error = await reject(b.load({ ...locator, context }));
      expect(isWorkflowStorageError(error, "WORKFLOW_STORAGE_LEASE_HELD")).toBe(
        true,
      );
    } finally {
      await a.close();
      await b.close();
    }
  });

  test("a failed renewal reports the lost lease", async () => {
    const time = clock();
    const store = new InMemoryWorkflowCheckpointStore({ now: time.now });
    const lost: number[] = [];
    const a = new LeasedWorkflowCheckpointStore({
      store,
      ownerId: "a",
      ttlMs: 90,
      onLeaseLost: (info) => lost.push(info.fencingToken),
    });
    try {
      await a.load({ ...locator, context });
      time.state.now += 10_000;
      await store.acquireLease({ ...locator, ownerId: "thief", ttlMs: 60_000 });
      const deadline = Date.now() + 2000;
      while (lost.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(lost).toEqual([1]);
    } finally {
      await a.close();
    }
  });

  describe("release", () => {
    async function holdsThenSaves(
      finalCheckpoint: (base: WorkflowCheckpointV1) => WorkflowCheckpointV1,
    ): Promise<boolean> {
      const store = new InMemoryWorkflowCheckpointStore();
      const a = new LeasedWorkflowCheckpointStore({
        store,
        ownerId: "a",
        ttlMs: 60_000,
      });
      const b = new LeasedWorkflowCheckpointStore({
        store,
        ownerId: "b",
        ttlMs: 60_000,
      });
      try {
        const first = await makeCheckpoint(1);
        await a.save({ context, checkpoint: first, expectedRevision: null });
        expect(
          isWorkflowStorageError(
            await reject(b.load({ ...locator, context })),
            "WORKFLOW_STORAGE_LEASE_HELD",
          ),
        ).toBe(true);
        await a.save({
          context,
          checkpoint: finalCheckpoint(first),
          expectedRevision: await workflowCheckpointRevision(first),
        });
        try {
          await b.load({ ...locator, context });
          return true;
        } catch (error) {
          if (isWorkflowStorageError(error, "WORKFLOW_STORAGE_LEASE_HELD")) {
            return false;
          }
          throw error;
        }
      } finally {
        await a.close();
        await b.close();
      }
    }

    test("saving a completed checkpoint releases the lease", async () => {
      expect(
        await holdsThenSaves((base) => withWorkflowCompleted(base, "out", 2)),
      ).toBe(true);
    });

    test("saving a failed checkpoint releases the lease", async () => {
      expect(
        await holdsThenSaves((base) =>
          withWorkflowFailed(
            base,
            { code: "WORKFLOW_EXECUTION_ERROR", message: "boom" },
            "failed",
            2,
          ),
        ),
      ).toBe(true);
    });

    test("saving a waiting run releases the lease so another worker can answer it", async () => {
      expect(
        await holdsThenSaves((base) =>
          withWorkflowStepWaiting(
            base,
            fromPartial<WorkflowStep>({ id: "s1", agentName: "agent" }),
            "hash",
            1,
            {
              kind: "input",
              functionCallIds: ["c1"],
              requests: [],
              events: [],
            },
            { role: "user", parts: [{ text: "hi" }] },
            2,
          ),
        ),
      ).toBe(true);
    });

    test("saving a running checkpoint keeps the lease", async () => {
      expect(await holdsThenSaves((base) => ({ ...base, updatedAt: 5 }))).toBe(
        false,
      );
    });

    test("close releases every lease the worker holds and leaves the provider open", async () => {
      const store = new InMemoryWorkflowCheckpointStore();
      const a = new LeasedWorkflowCheckpointStore({
        store,
        ownerId: "a",
        ttlMs: 60_000,
      });
      await a.load({ ...locator, context });
      await a.load({ workflowId: WF, executionId: "exec-2", context });
      await a.close();
      for (const executionId of [EXEC, "exec-2"]) {
        const lease = await store.acquireLease({
          workflowId: WF,
          executionId,
          ownerId: "b",
          ttlMs: 1000,
        });
        expect(lease.ownerId).toBe("b");
      }
      expect(await store.get(locator)).toBeUndefined();
    });

    test("closing twice does nothing", async () => {
      const store = new InMemoryWorkflowCheckpointStore();
      const a = new LeasedWorkflowCheckpointStore({ store, ownerId: "a" });
      await a.load({ ...locator, context });
      await a.close();
      await a.close();
    });
  });
});

describe("LeasedWorkflowCheckpointStore check-only loads", () => {
  test("loading a completed checkpoint does not keep the lease", async () => {
    const store = new InMemoryWorkflowCheckpointStore();
    await store.put({
      checkpoint: withWorkflowCompleted(await makeCheckpoint(1), "out", 2),
    });
    const a = new LeasedWorkflowCheckpointStore({ store, ownerId: "a" });
    const b = new LeasedWorkflowCheckpointStore({ store, ownerId: "b" });
    try {
      expect((await a.load({ ...locator, context }))?.status).toBe("completed");
      expect((await b.load({ ...locator, context }))?.status).toBe("completed");
      const lease = await store.acquireLease({
        ...locator,
        ownerId: "c",
        ttlMs: 1000,
      });
      expect(lease.ownerId).toBe("c");
    } finally {
      await a.close();
      await b.close();
    }
  });

  test("a lease that was loaded but never saved is released after ten lifetimes", async () => {
    const store = new InMemoryWorkflowCheckpointStore();
    const a = new LeasedWorkflowCheckpointStore({
      store,
      ownerId: "a",
      ttlMs: 15,
    });
    try {
      await a.load({ ...locator, context });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const lease = await store.acquireLease({
        ...locator,
        ownerId: "b",
        ttlMs: 1000,
      });
      expect(lease.ownerId).toBe("b");
    } finally {
      await a.close();
    }
  });

  test("a lease that has saved keeps renewing", async () => {
    const store = new InMemoryWorkflowCheckpointStore();
    const a = new LeasedWorkflowCheckpointStore({
      store,
      ownerId: "a",
      ttlMs: 15,
    });
    try {
      await a.save({ context, checkpoint: await makeCheckpoint(1) });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const error = await reject(
        store.acquireLease({ ...locator, ownerId: "b", ttlMs: 1000 }),
      );
      expect(isWorkflowStorageError(error, "WORKFLOW_STORAGE_LEASE_HELD")).toBe(
        true,
      );
    } finally {
      await a.close();
    }
  });
});
