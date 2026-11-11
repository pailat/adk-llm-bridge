import { describe, expect, test } from "bun:test";
import type { InvocationContext } from "@google/adk";
import {
  createWorkflowCheckpoint,
  withWorkflowCompleted,
} from "../../../src/workflows/checkpoint/checkpoint.js";
import type { WorkflowCheckpointV1 } from "../../../src/workflows/checkpoint/schema.js";
import {
  WorkflowCheckpointConflictError,
  type WorkflowCheckpointLocator,
  workflowCheckpointKey,
  workflowCheckpointRevision,
} from "../../../src/workflows/checkpoint/store.js";
import { defineWorkflow } from "../../../src/workflows/definition.js";
import {
  type AcquireWorkflowCheckpointLeaseInput,
  BaseWorkflowCheckpointStore,
  type BaseWorkflowCheckpointStoreOptions,
  type DeleteWorkflowCheckpointInput,
  type ListWorkflowCheckpointsInput,
  type ListWorkflowCheckpointsResult,
  type PruneWorkflowCheckpointsResult,
  type StoredWorkflowCheckpoint,
  type WorkflowCheckpointLease,
  type WorkflowCheckpointStoreCapabilities,
  type WorkflowCheckpointWriteRequest,
} from "../../../src/workflows/storage/checkpoint-store.js";
import {
  isWorkflowStorageError,
  WorkflowStorageError,
} from "../../../src/workflows/storage/errors.js";
import type { WorkflowStorageOperationMetric } from "../../../src/workflows/storage/support.js";
import { fromPartial } from "../../helpers/partial.js";

const context = fromPartial<InvocationContext>({});
const fastRetry = { initialDelayMs: 1, maxDelayMs: 2, jitter: 0 } as const;

const definitions = new Map<string, ReturnType<typeof defineWorkflow>>();
async function makeCheckpoint(
  workflowId: string,
  executionId: string,
  now = 1,
  input = "input",
): Promise<WorkflowCheckpointV1> {
  let definition = definitions.get(workflowId);
  if (!definition) {
    definition = defineWorkflow({
      id: workflowId,
      version: "1",
      handler: () => "done",
    });
    definitions.set(workflowId, definition);
  }
  return await createWorkflowCheckpoint({
    definition,
    executionId,
    input,
    now,
  });
}

/**
 * Provider with injectable faults. It implements compare-and-set and the
 * fencing check the way a real provider must, so the base-class rules can be
 * proven on top of it.
 */
class FaultStore extends BaseWorkflowCheckpointStore {
  readonly providerName = "fault";
  readonly capabilities: WorkflowCheckpointStoreCapabilities;
  readonly data = new Map<string, StoredWorkflowCheckpoint>();
  readonly tokens = new Map<string, number>();
  readonly calls = {
    read: 0,
    write: 0,
    list: 0,
    delete: 0,
    prune: 0,
    acquire: 0,
    renew: 0,
    release: 0,
    health: 0,
    close: 0,
  };
  readonly writes: WorkflowCheckpointWriteRequest[] = [];
  listInputs: Array<ListWorkflowCheckpointsInput & { limit: number }> = [];
  pruneInputs: unknown[] = [];
  acquireNow: number[] = [];
  beforeRead?: (call: number) => Promise<void> | void;
  beforeWrite?: (call: number) => Promise<void> | void;
  afterWrite?: (call: number) => Promise<void> | void;
  tamper?: (stored: StoredWorkflowCheckpoint) => StoredWorkflowCheckpoint;
  healthFault?: () => Promise<number | undefined> | number | undefined;

  constructor(
    capabilities: Partial<WorkflowCheckpointStoreCapabilities> = {},
    options: BaseWorkflowCheckpointStoreOptions = {},
  ) {
    super({ retry: fastRetry, ...options });
    this.capabilities = {
      compareAndSet: "atomic",
      leases: true,
      durable: false,
      multiProcess: false,
      listing: true,
      pruning: true,
      maxCheckpointBytes: options.maxCheckpointBytes ?? 4 * 1024 * 1024,
      ...capabilities,
    };
  }

  private slot(locator: WorkflowCheckpointLocator): string {
    return workflowCheckpointKey(locator.workflowId, locator.executionId);
  }

  protected async readCheckpoint(
    locator: WorkflowCheckpointLocator,
  ): Promise<StoredWorkflowCheckpoint | undefined> {
    this.calls.read += 1;
    await this.beforeRead?.(this.calls.read);
    const stored = this.data.get(this.slot(locator));
    if (!stored) return undefined;
    return this.tamper ? this.tamper(stored) : stored;
  }

  protected async writeCheckpoint(
    request: WorkflowCheckpointWriteRequest,
  ): Promise<number> {
    this.calls.write += 1;
    this.writes.push(request);
    await this.beforeWrite?.(this.calls.write);
    const key = request.checkpointKey;
    const current = this.data.get(key);
    if (request.fencingToken !== undefined) {
      const token = this.tokens.get(key) ?? 0;
      if (request.fencingToken < token) {
        throw new WorkflowStorageError("WORKFLOW_STORAGE_LEASE_LOST", "fenced");
      }
    }
    if (request.expectedRevision !== undefined) {
      const actual = current?.revision ?? null;
      if (actual !== request.expectedRevision) {
        throw new WorkflowCheckpointConflictError(
          key,
          request.expectedRevision,
          actual,
        );
      }
    }
    const updatedAt = 1_000 + this.calls.write;
    this.data.set(key, {
      checkpoint: request.checkpoint,
      revision: request.revision,
      updatedAt,
    });
    await this.afterWrite?.(this.calls.write);
    return updatedAt;
  }

  protected async listCheckpoints(
    input: ListWorkflowCheckpointsInput & { limit: number },
  ): Promise<ListWorkflowCheckpointsResult> {
    this.calls.list += 1;
    this.listInputs.push(input);
    return { items: [] };
  }

  protected async deleteCheckpoint(
    input: DeleteWorkflowCheckpointInput,
  ): Promise<boolean> {
    this.calls.delete += 1;
    return this.data.delete(this.slot(input));
  }

  protected async pruneCheckpoints(
    input: unknown,
  ): Promise<PruneWorkflowCheckpointsResult> {
    this.calls.prune += 1;
    this.pruneInputs.push(input);
    return { deleted: 0, hasMore: false };
  }

  protected async acquireCheckpointLease(
    input: AcquireWorkflowCheckpointLeaseInput,
    now: number,
  ): Promise<WorkflowCheckpointLease> {
    this.calls.acquire += 1;
    this.acquireNow.push(now);
    const key = this.slot(input);
    const fencingToken = (this.tokens.get(key) ?? 0) + 1;
    this.tokens.set(key, fencingToken);
    return {
      workflowId: input.workflowId,
      executionId: input.executionId,
      ownerId: input.ownerId,
      fencingToken,
      expiresAt: now + input.ttlMs,
    };
  }

  protected async renewCheckpointLease(
    lease: WorkflowCheckpointLease,
    expiresAt: number,
  ): Promise<WorkflowCheckpointLease> {
    this.calls.renew += 1;
    return { ...lease, expiresAt };
  }

  protected async releaseCheckpointLease(): Promise<void> {
    this.calls.release += 1;
  }

  protected async checkHealth(): Promise<number | undefined> {
    this.calls.health += 1;
    return this.healthFault ? await this.healthFault() : 3;
  }

  protected async closeStore(): Promise<void> {
    this.calls.close += 1;
  }
}

/** A provider that implements only the two required primitives. */
class BareStore extends BaseWorkflowCheckpointStore {
  readonly providerName = "bare";
  readonly capabilities: WorkflowCheckpointStoreCapabilities = {
    compareAndSet: "atomic",
    leases: true,
    durable: false,
    multiProcess: false,
    listing: true,
    pruning: true,
    maxCheckpointBytes: 1024 * 1024,
  };

  protected async readCheckpoint(): Promise<undefined> {
    return undefined;
  }

  protected async writeCheckpoint(): Promise<number> {
    return 1;
  }
}

async function reject(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

function expectStorageCode(error: unknown, code: string): void {
  expect(isWorkflowStorageError(error)).toBe(true);
  expect((error as WorkflowStorageError).code).toBe(code as never);
}

describe("BaseWorkflowCheckpointStore option validation", () => {
  const invalid: Array<[string, BaseWorkflowCheckpointStoreOptions]> = [
    ["maxCheckpointBytes 0", { maxCheckpointBytes: 0 }],
    ["negative maxCheckpointBytes", { maxCheckpointBytes: -5 }],
    ["fractional maxCheckpointBytes", { maxCheckpointBytes: 1.5 }],
    ["NaN maxCheckpointBytes", { maxCheckpointBytes: Number.NaN }],
    ["infinite maxCheckpointBytes", { maxCheckpointBytes: Infinity }],
    ["operationTimeoutMs 0", { operationTimeoutMs: 0 }],
    ["fractional operationTimeoutMs", { operationTimeoutMs: 1.5 }],
    ["retry.maxAttempts 0", { retry: { maxAttempts: 0 } }],
    ["negative retry.initialDelayMs", { retry: { initialDelayMs: -1 } }],
    ["retry.jitter above 1", { retry: { jitter: 2 } }],
  ];
  for (const [name, options] of invalid) {
    test(`rejects ${name} at construction with WORKFLOW_STORAGE_INVALID_OPTION`, () => {
      let thrown: unknown;
      try {
        new FaultStore({}, options);
      } catch (error) {
        thrown = error;
      }
      expectStorageCode(thrown, "WORKFLOW_STORAGE_INVALID_OPTION");
    });
  }

  test("accepts the documented defaults", () => {
    expect(() => new FaultStore()).not.toThrow();
  });
});

describe("BaseWorkflowCheckpointStore load, save, get and put", () => {
  test("load returns undefined for a missing checkpoint", async () => {
    const store = new FaultStore();
    expect(
      await store.load({ workflowId: "wf", executionId: "e", context }),
    ).toBeUndefined();
  });

  test("save returns the checkpoint key and a stateDelta of the durable checkpoint", async () => {
    const store = new FaultStore();
    const checkpoint = await makeCheckpoint("wf", "e1");
    const write = await store.save({ context, checkpoint });
    const key = workflowCheckpointKey("wf", "e1");
    expect(write.checkpointKey).toBe(key);
    expect(write.stateDelta).toEqual({ [key]: checkpoint });
    expect(Object.keys(write.stateDelta)).toEqual([key]);
  });

  test("save then load returns the saved checkpoint", async () => {
    const store = new FaultStore();
    const checkpoint = await makeCheckpoint("wf", "e1");
    await store.save({ context, checkpoint });
    expect(
      await store.load({ workflowId: "wf", executionId: "e1", context }),
    ).toEqual(checkpoint);
  });

  test("the request handed to the storage primitive carries the validated write", async () => {
    const store = new FaultStore();
    const checkpoint = await makeCheckpoint("wf", "e1");
    await store.save({ context, checkpoint, expectedRevision: null });
    const request = store.writes[0];
    expect(request?.checkpointKey).toBe(workflowCheckpointKey("wf", "e1"));
    expect(request?.serialized).toBe(JSON.stringify(checkpoint));
    expect(request?.bytes).toBe(
      new TextEncoder().encode(JSON.stringify(checkpoint)).byteLength,
    );
    expect(request?.revision).toBe(
      await workflowCheckpointRevision(checkpoint),
    );
    expect(request?.expectedRevision).toBeNull();
    expect(request && "fencingToken" in request && request.fencingToken).toBe(
      false,
    );
  });

  test("get returns the checkpoint with its revision and save time", async () => {
    const store = new FaultStore();
    const checkpoint = await makeCheckpoint("wf", "e1");
    await store.put({ checkpoint });
    const stored = await store.get({ workflowId: "wf", executionId: "e1" });
    expect(stored?.checkpoint).toEqual(checkpoint);
    expect(stored?.revision).toBe(await workflowCheckpointRevision(checkpoint));
    expect(typeof stored?.updatedAt).toBe("number");
    expect(await store.get({ workflowId: "wf", executionId: "none" })).toBe(
      undefined,
    );
  });

  test("put needs no invocation context and returns what was stored", async () => {
    const store = new FaultStore();
    const checkpoint = await makeCheckpoint("wf", "e1");
    const stored = await store.put({ checkpoint, expectedRevision: null });
    expect(stored.checkpoint).toEqual(checkpoint);
    expect(stored.revision).toBe(await workflowCheckpointRevision(checkpoint));
  });

  test("a blank workflow or execution id is rejected before storage is touched", async () => {
    const store = new FaultStore();
    const error = await reject(
      store.load({ workflowId: " ", executionId: "e", context }),
    );
    expect(error).toMatchObject({ code: "WORKFLOW_EXECUTION_ERROR" });
    expect(store.calls.read).toBe(0);
  });

  test("a stale expectedRevision rejects with WorkflowCheckpointConflictError and writes nothing", async () => {
    const store = new FaultStore();
    const first = await makeCheckpoint("wf", "e1", 1);
    const second = await makeCheckpoint("wf", "e1", 2);
    const third = await makeCheckpoint("wf", "e1", 3);
    await store.put({ checkpoint: first, expectedRevision: null });
    await store.put({
      checkpoint: second,
      expectedRevision: await workflowCheckpointRevision(first),
    });
    const error = await reject(
      store.put({
        checkpoint: third,
        expectedRevision: await workflowCheckpointRevision(first),
      }),
    );
    expect(error).toBeInstanceOf(WorkflowCheckpointConflictError);
    expect(
      (await store.get({ workflowId: "wf", executionId: "e1" }))?.checkpoint,
    ).toEqual(second);
  });

  test("expectedRevision null rejects when a checkpoint exists", async () => {
    const store = new FaultStore();
    const first = await makeCheckpoint("wf", "e1", 1);
    await store.put({ checkpoint: first });
    const error = await reject(
      store.put({
        checkpoint: await makeCheckpoint("wf", "e1", 2),
        expectedRevision: null,
      }),
    );
    expect(error).toBeInstanceOf(WorkflowCheckpointConflictError);
    expect((error as WorkflowCheckpointConflictError).conflict).toMatchObject({
      expectedRevision: null,
      actualRevision: await workflowCheckpointRevision(first),
    });
  });

  test("a conflict is not retried and is counted once", async () => {
    const store = new FaultStore();
    await store.put({ checkpoint: await makeCheckpoint("wf", "e1", 1) });
    const before = store.calls.write;
    await reject(
      store.put({
        checkpoint: await makeCheckpoint("wf", "e1", 2),
        expectedRevision: null,
      }),
    );
    expect(store.calls.write - before).toBe(1);
  });

  test("repeating a save whose revision is already stored resolves without a conflict", async () => {
    const store = new FaultStore();
    const first = await makeCheckpoint("wf", "e1", 1);
    const second = await makeCheckpoint("wf", "e1", 2);
    const firstRevision = await workflowCheckpointRevision(first);
    await store.put({ checkpoint: first, expectedRevision: null });
    await store.put({ checkpoint: second, expectedRevision: firstRevision });
    const repeated = await store.put({
      checkpoint: second,
      expectedRevision: firstRevision,
    });
    expect(repeated.revision).toBe(await workflowCheckpointRevision(second));
    expect(repeated.checkpoint).toEqual(second);
    const save = await store.save({
      context,
      checkpoint: second,
      expectedRevision: firstRevision,
    });
    expect(save.stateDelta).toEqual({ [save.checkpointKey]: second });
  });

  test("a save applied by the backend but reported as a timeout is repaired by the retry", async () => {
    const store = new FaultStore();
    store.afterWrite = (call) => {
      if (call === 1) {
        throw new WorkflowStorageError("WORKFLOW_STORAGE_TIMEOUT", "late ack");
      }
    };
    const checkpoint = await makeCheckpoint("wf", "e1");
    const stored = await store.put({ checkpoint, expectedRevision: null });
    expect(stored.revision).toBe(await workflowCheckpointRevision(checkpoint));
    expect(store.calls.write).toBe(2);
  });

  test("the idempotent rule does not hide a conflict with a different stored revision", async () => {
    const store = new FaultStore();
    const first = await makeCheckpoint("wf", "e1", 1);
    const other = await makeCheckpoint("wf", "e1", 2);
    await store.put({ checkpoint: first });
    const error = await reject(
      store.put({ checkpoint: other, expectedRevision: "sha256:stale" }),
    );
    expect(error).toBeInstanceOf(WorkflowCheckpointConflictError);
  });

  test("an invalid checkpoint is rejected before the storage primitive is called", async () => {
    const store = new FaultStore();
    const valid = await makeCheckpoint("wf", "e1");
    const invalid = {
      ...valid,
      status: "bogus",
    } as unknown as WorkflowCheckpointV1;
    const error = await reject(store.put({ checkpoint: invalid }));
    expect(error).toMatchObject({
      code: "WORKFLOW_EXECUTION_ERROR",
      details: { reason: "checkpoint_schema_invalid" },
    });
    expect(store.calls.write).toBe(0);
  });

  test("an oversized checkpoint is rejected before the storage primitive is called", async () => {
    const store = new FaultStore({}, { maxCheckpointBytes: 2048 });
    const base = await makeCheckpoint("wf", "e1");
    const big = withWorkflowCompleted(base, "x".repeat(5000), 2);
    const error = await reject(store.put({ checkpoint: big }));
    expect(error).toMatchObject({
      code: "WORKFLOW_EXECUTION_ERROR",
      details: { reason: "checkpoint_size_limit_exceeded" },
    });
    expect(store.calls.write).toBe(0);
    expect(store.data.size).toBe(0);
  });

  test("a supplied revision that does not match the checkpoint is rejected before any write", async () => {
    const store = new FaultStore();
    const checkpoint = await makeCheckpoint("wf", "e1");
    const error = await reject(
      store.save({ context, checkpoint, revision: "sha256:wrong" }),
    );
    expect(error).toMatchObject({
      code: "WORKFLOW_EXECUTION_ERROR",
      details: { reason: "checkpoint_revision_invalid" },
    });
    expect(store.calls.write).toBe(0);
  });

  test("a supplied revision that matches is accepted", async () => {
    const store = new FaultStore();
    const checkpoint = await makeCheckpoint("wf", "e1");
    await store.save({
      context,
      checkpoint,
      revision: await workflowCheckpointRevision(checkpoint),
    });
    expect(store.calls.write).toBe(1);
  });

  test("a fencing token is forwarded to the primitive and must be a positive safe integer", async () => {
    const store = new FaultStore();
    const checkpoint = await makeCheckpoint("wf", "e1");
    await store.put({ checkpoint, fencingToken: 7 });
    expect(store.writes[0]?.fencingToken).toBe(7);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const error = await reject(store.put({ checkpoint, fencingToken: bad }));
      expectStorageCode(error, "WORKFLOW_STORAGE_INVALID_OPTION");
    }
    expect(store.calls.write).toBe(1);
  });

  test("a save with a fencing token lower than the current one rejects with WORKFLOW_STORAGE_LEASE_LOST and writes nothing", async () => {
    const store = new FaultStore();
    const first = await makeCheckpoint("wf", "e1", 1);
    await store.acquireLease({
      workflowId: "wf",
      executionId: "e1",
      ownerId: "a",
      ttlMs: 1000,
    });
    await store.acquireLease({
      workflowId: "wf",
      executionId: "e1",
      ownerId: "b",
      ttlMs: 1000,
    });
    await store.put({ checkpoint: first, fencingToken: 2 });
    const error = await reject(
      store.put({
        checkpoint: await makeCheckpoint("wf", "e1", 2),
        fencingToken: 1,
      }),
    );
    expectStorageCode(error, "WORKFLOW_STORAGE_LEASE_LOST");
    expect(
      (await store.get({ workflowId: "wf", executionId: "e1" }))?.checkpoint,
    ).toEqual(first);
    expect(store.calls.write).toBe(2);
  });

  test("a save that carries a fencing token on a provider without leases rejects as unsupported and writes nothing", async () => {
    const store = new FaultStore({ leases: false });
    const error = await reject(
      store.put({
        checkpoint: await makeCheckpoint("wf", "e1"),
        fencingToken: 1,
      }),
    );
    expectStorageCode(error, "WORKFLOW_STORAGE_UNSUPPORTED");
    expect(store.calls.write).toBe(0);
  });
});

describe("BaseWorkflowCheckpointStore read verification", () => {
  async function stored(): Promise<FaultStore> {
    const store = new FaultStore();
    await store.put({ checkpoint: await makeCheckpoint("wf", "e1", 1) });
    return store;
  }
  const locator = { workflowId: "wf", executionId: "e1" };

  function isRejection(error: unknown): boolean {
    return (
      isWorkflowStorageError(error, "WORKFLOW_STORAGE_CORRUPT") ||
      (error as { code?: string }).code === "WORKFLOW_EXECUTION_ERROR"
    );
  }

  test("a stored value that does not match its revision is never returned", async () => {
    const store = await stored();
    store.tamper = (value) => ({
      ...value,
      checkpoint: { ...value.checkpoint, status: "failed" },
    });
    const viaGet = await reject(store.get(locator));
    const viaLoad = await reject(store.load({ ...locator, context }));
    expect(isRejection(viaGet)).toBe(true);
    expect(isRejection(viaLoad)).toBe(true);
  });

  test("a stored value that is not a valid checkpoint is never returned", async () => {
    const store = await stored();
    store.tamper = (value) => ({
      ...value,
      checkpoint: { schemaVersion: 1 } as unknown as WorkflowCheckpointV1,
    });
    expect(isRejection(await reject(store.get(locator)))).toBe(true);
  });

  test("a stored value over the size limit is never returned", async () => {
    const store = new FaultStore({}, { maxCheckpointBytes: 2048 });
    const small = await makeCheckpoint("wf", "e1", 1);
    const big = withWorkflowCompleted(small, "y".repeat(5000), 2);
    store.data.set(workflowCheckpointKey("wf", "e1"), {
      checkpoint: big,
      revision: await workflowCheckpointRevision(big),
      updatedAt: 5,
    });
    expect(isRejection(await reject(store.get(locator)))).toBe(true);
  });

  test("a corrupt read is not retried", async () => {
    const store = await stored();
    store.tamper = (value) => ({ ...value, revision: "sha256:other" });
    await reject(store.get(locator));
    expect(store.calls.read).toBe(1);
  });
});

describe("BaseWorkflowCheckpointStore retry and timeout", () => {
  const locator = { workflowId: "wf", executionId: "e1" };

  test("a transient read failure is retried until it succeeds", async () => {
    const store = new FaultStore();
    await store.put({ checkpoint: await makeCheckpoint("wf", "e1") });
    store.beforeRead = (call) => {
      if (call <= 2) {
        throw new WorkflowStorageError("WORKFLOW_STORAGE_UNAVAILABLE", "busy");
      }
    };
    const result = await store.get(locator);
    expect(result).toBeDefined();
    expect(store.calls.read).toBe(3);
  });

  test("retries stop at maxAttempts and the last error is thrown", async () => {
    const store = new FaultStore(
      {},
      { retry: { ...fastRetry, maxAttempts: 3 } },
    );
    store.beforeRead = () => {
      throw new WorkflowStorageError("WORKFLOW_STORAGE_UNAVAILABLE", "down");
    };
    const error = await reject(store.get(locator));
    expectStorageCode(error, "WORKFLOW_STORAGE_UNAVAILABLE");
    expect(store.calls.read).toBe(3);
  });

  test("only retryable errors are retried", async () => {
    for (const code of [
      "WORKFLOW_STORAGE_CORRUPT",
      "WORKFLOW_STORAGE_LEASE_LOST",
      "WORKFLOW_STORAGE_UNSUPPORTED",
      "WORKFLOW_STORAGE_INVALID_OPTION",
    ] as const) {
      const store = new FaultStore();
      store.beforeRead = () => {
        throw new WorkflowStorageError(code, "no");
      };
      const error = await reject(store.get(locator));
      expectStorageCode(error, code);
      expect(store.calls.read).toBe(1);
    }
    const plain = new FaultStore();
    plain.beforeRead = () => {
      throw new Error("plain");
    };
    await reject(plain.get(locator));
    expect(plain.calls.read).toBe(1);
  });

  test("lease errors on a save are never retried", async () => {
    const store = new FaultStore();
    store.beforeWrite = () => {
      throw new WorkflowStorageError("WORKFLOW_STORAGE_LEASE_LOST", "lost");
    };
    await reject(store.put({ checkpoint: await makeCheckpoint("wf", "e1") }));
    expect(store.calls.write).toBe(1);
  });

  test("an operation past operationTimeoutMs rejects with WORKFLOW_STORAGE_TIMEOUT", async () => {
    const store = new FaultStore(
      {},
      { operationTimeoutMs: 25, retry: { ...fastRetry, maxAttempts: 1 } },
    );
    store.beforeRead = () => new Promise<void>(() => {});
    const error = await reject(store.get(locator));
    expectStorageCode(error, "WORKFLOW_STORAGE_TIMEOUT");
    expect((error as WorkflowStorageError).retryable).toBe(true);
  });

  test("a timed-out write rejects with WORKFLOW_STORAGE_TIMEOUT", async () => {
    const store = new FaultStore(
      {},
      { operationTimeoutMs: 25, retry: { ...fastRetry, maxAttempts: 1 } },
    );
    store.beforeWrite = () => new Promise<void>(() => {});
    const error = await reject(
      store.put({ checkpoint: await makeCheckpoint("wf", "e1") }),
    );
    expectStorageCode(error, "WORKFLOW_STORAGE_TIMEOUT");
  });

  test("a timeout is retried and a slow first try does not fail the operation", async () => {
    const store = new FaultStore(
      {},
      { operationTimeoutMs: 25, retry: { ...fastRetry, maxAttempts: 3 } },
    );
    await store.put({ checkpoint: await makeCheckpoint("wf", "e1") });
    store.beforeRead = (call) =>
      call === 1 ? new Promise<void>(() => {}) : undefined;
    expect(await store.get(locator)).toBeDefined();
    expect(store.calls.read).toBe(2);
  });
});

describe("BaseWorkflowCheckpointStore unsupported operations", () => {
  const locator = { workflowId: "wf", executionId: "e1" };
  const lease: WorkflowCheckpointLease = {
    ...locator,
    ownerId: "a",
    fencingToken: 1,
    expiresAt: 10,
  };

  test("operations whose capability flag is false reject with WORKFLOW_STORAGE_UNSUPPORTED without reaching the primitive", async () => {
    const store = new FaultStore({
      listing: false,
      pruning: false,
      leases: false,
    });
    const attempts: Array<Promise<unknown>> = [
      store.list({}),
      store.delete(locator),
      store.prune({ updatedBefore: 10 }),
      store.acquireLease({ ...locator, ownerId: "a", ttlMs: 1000 }),
      store.renewLease(lease, 1000),
      store.releaseLease(lease),
    ];
    for (const attempt of attempts) {
      expectStorageCode(await reject(attempt), "WORKFLOW_STORAGE_UNSUPPORTED");
    }
    expect(store.calls.list).toBe(0);
    expect(store.calls.delete).toBe(0);
    expect(store.calls.prune).toBe(0);
    expect(store.calls.acquire).toBe(0);
    expect(store.calls.renew).toBe(0);
    expect(store.calls.release).toBe(0);
  });

  test("an unsupported error is not retried", async () => {
    const store = new FaultStore({ listing: false });
    await reject(store.list({}));
    expect(store.calls.list).toBe(0);
  });

  test("the protected defaults reject with WORKFLOW_STORAGE_UNSUPPORTED when a flag is claimed but not implemented", async () => {
    const store = new BareStore();
    const attempts: Array<Promise<unknown>> = [
      store.list({}),
      store.delete({ workflowId: "wf", executionId: "e1" }),
      store.prune({ updatedBefore: 10 }),
      store.acquireLease({
        workflowId: "wf",
        executionId: "e1",
        ownerId: "a",
        ttlMs: 1000,
      }),
    ];
    for (const attempt of attempts) {
      expectStorageCode(await reject(attempt), "WORKFLOW_STORAGE_UNSUPPORTED");
    }
  });
});

describe("BaseWorkflowCheckpointStore list, delete, prune and lease delegation", () => {
  const locator = { workflowId: "wf", executionId: "e1" };

  test("list passes a concrete default limit of 50", async () => {
    const store = new FaultStore();
    await store.list();
    await store.list({ workflowId: "wf", limit: 7 });
    expect(store.listInputs[0]?.limit).toBe(50);
    expect(store.listInputs[1]).toMatchObject({ workflowId: "wf", limit: 7 });
  });

  test("list rejects a limit outside 1..500 and a non-integer limit", async () => {
    const store = new FaultStore();
    for (const limit of [0, -1, 501, 1.5, Number.NaN]) {
      expectStorageCode(
        await reject(store.list({ limit })),
        "WORKFLOW_STORAGE_INVALID_OPTION",
      );
    }
    expect(store.calls.list).toBe(0);
    await store.list({ limit: 500 });
    expect(store.calls.list).toBe(1);
  });

  test("list rejects an empty cursor and a bad updatedBefore", async () => {
    const store = new FaultStore();
    expectStorageCode(
      await reject(store.list({ cursor: "" })),
      "WORKFLOW_STORAGE_INVALID_OPTION",
    );
    expectStorageCode(
      await reject(store.list({ updatedBefore: Number.NaN })),
      "WORKFLOW_STORAGE_INVALID_OPTION",
    );
    expect(store.calls.list).toBe(0);
  });

  test("delete delegates and reports whether something was deleted", async () => {
    const store = new FaultStore();
    await store.put({ checkpoint: await makeCheckpoint("wf", "e1") });
    expect(await store.delete(locator)).toBe(true);
    expect(await store.delete(locator)).toBe(false);
  });

  test("prune passes the default statuses and limit", async () => {
    const store = new FaultStore();
    await store.prune({ updatedBefore: 99 });
    expect(store.pruneInputs[0]).toMatchObject({
      updatedBefore: 99,
      statuses: ["completed", "failed"],
      limit: 500,
    });
  });

  test("prune rejects a bad updatedBefore, limit and status", async () => {
    const store = new FaultStore();
    for (const input of [
      { updatedBefore: Number.NaN },
      { updatedBefore: 10, limit: 0 },
      { updatedBefore: 10, limit: 1.5 },
      { updatedBefore: 10, statuses: ["bogus"] },
      { updatedBefore: 10, statuses: [] },
    ]) {
      expectStorageCode(
        await reject(store.prune(input as never)),
        "WORKFLOW_STORAGE_INVALID_OPTION",
      );
    }
    expect(store.calls.prune).toBe(0);
  });

  test("acquireLease validates the owner and lifetime and hands the primitive a clock reading", async () => {
    const store = new FaultStore();
    for (const input of [
      { ownerId: "", ttlMs: 1000 },
      { ownerId: "a", ttlMs: 0 },
      { ownerId: "a", ttlMs: -5 },
      { ownerId: "a", ttlMs: 1.5 },
    ]) {
      expectStorageCode(
        await reject(store.acquireLease({ ...locator, ...input })),
        "WORKFLOW_STORAGE_INVALID_OPTION",
      );
    }
    expect(store.calls.acquire).toBe(0);
    const before = Date.now();
    const lease = await store.acquireLease({
      ...locator,
      ownerId: "a",
      ttlMs: 1000,
    });
    expect(lease.ownerId).toBe("a");
    expect(lease.fencingToken).toBe(1);
    expect(store.acquireNow[0]).toBeGreaterThanOrEqual(before);
    expect(store.acquireNow[0]).toBeLessThanOrEqual(Date.now());
    expect(lease.expiresAt).toBe((store.acquireNow[0] ?? 0) + 1000);
  });

  test("renewLease validates the lifetime and passes an absolute expiry", async () => {
    const store = new FaultStore();
    const lease = await store.acquireLease({
      ...locator,
      ownerId: "a",
      ttlMs: 1000,
    });
    expectStorageCode(
      await reject(store.renewLease(lease, 0)),
      "WORKFLOW_STORAGE_INVALID_OPTION",
    );
    const before = Date.now();
    const renewed = await store.renewLease(lease, 5000);
    expect(renewed.fencingToken).toBe(lease.fencingToken);
    expect(renewed.expiresAt).toBeGreaterThanOrEqual(before + 5000);
  });

  test("releaseLease delegates", async () => {
    const store = new FaultStore();
    const lease = await store.acquireLease({
      ...locator,
      ownerId: "a",
      ttlMs: 1000,
    });
    await store.releaseLease(lease);
    expect(store.calls.release).toBe(1);
  });
});

describe("BaseWorkflowCheckpointStore healthCheck and close", () => {
  test("healthCheck reports ok with the provider name, latency and schema version", async () => {
    const store = new FaultStore();
    const health = await store.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.provider).toBe("fault");
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    expect(health.schemaVersion).toBe(3);
  });

  test("healthCheck never throws: a backend failure becomes ok false with a code", async () => {
    const store = new FaultStore();
    store.healthFault = () => {
      throw new WorkflowStorageError(
        "WORKFLOW_STORAGE_UNAVAILABLE",
        "database is down",
      );
    };
    const health = await store.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.code).toBe("WORKFLOW_STORAGE_UNAVAILABLE");
    expect(typeof health.message).toBe("string");
  });

  test("healthCheck turns a plain error into ok false", async () => {
    const store = new FaultStore();
    store.healthFault = () => {
      throw new Error("boom");
    };
    const health = await store.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.provider).toBe("fault");
  });

  test("healthCheck honors operationTimeoutMs without throwing", async () => {
    const store = new FaultStore(
      {},
      { operationTimeoutMs: 25, retry: { ...fastRetry, maxAttempts: 1 } },
    );
    store.healthFault = () => new Promise<number>(() => {});
    const health = await store.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.code).toBe("WORKFLOW_STORAGE_TIMEOUT");
  });

  test("every operation rejects with WORKFLOW_STORAGE_CLOSED after close, without reaching storage", async () => {
    const store = new FaultStore();
    const checkpoint = await makeCheckpoint("wf", "e1");
    const lease: WorkflowCheckpointLease = {
      workflowId: "wf",
      executionId: "e1",
      ownerId: "a",
      fencingToken: 1,
      expiresAt: 1,
    };
    await store.close();
    const readsBefore = store.calls.read;
    const attempts: Array<Promise<unknown>> = [
      store.load({ workflowId: "wf", executionId: "e1", context }),
      store.save({ context, checkpoint }),
      store.get({ workflowId: "wf", executionId: "e1" }),
      store.put({ checkpoint }),
      store.list(),
      store.delete({ workflowId: "wf", executionId: "e1" }),
      store.prune({ updatedBefore: 1 }),
      store.acquireLease({
        workflowId: "wf",
        executionId: "e1",
        ownerId: "a",
        ttlMs: 10,
      }),
      store.renewLease(lease, 10),
      store.releaseLease(lease),
    ];
    for (const attempt of attempts) {
      expectStorageCode(await reject(attempt), "WORKFLOW_STORAGE_CLOSED");
    }
    expect(store.calls.read).toBe(readsBefore);
    expect(store.calls.write).toBe(0);
  });

  test("closing twice does nothing and releases storage once", async () => {
    const store = new FaultStore();
    await store.close();
    await store.close();
    expect(store.calls.close).toBe(1);
  });

  test("healthCheck after close resolves with ok false", async () => {
    const store = new FaultStore();
    await store.close();
    const health = await store.healthCheck();
    expect(health.ok).toBe(false);
  });
});

describe("BaseWorkflowCheckpointStore metrics", () => {
  const SECRET_WORKFLOW = "wf-secret-workflow";
  const SECRET_EXECUTION = "exec-secret-0042";
  const SECRET_TEXT = "payload-secret-text-xyz";

  function observed(
    capabilities: Partial<WorkflowCheckpointStoreCapabilities> = {},
    options: BaseWorkflowCheckpointStoreOptions = {},
  ): { store: FaultStore; metrics: WorkflowStorageOperationMetric[] } {
    const collected: WorkflowStorageOperationMetric[] = [];
    const store = new FaultStore(capabilities, {
      ...options,
      onOperation: (metric) => collected.push(metric),
    });
    return { store, metrics: collected };
  }

  async function secretCheckpoint(now = 1): Promise<WorkflowCheckpointV1> {
    return withWorkflowCompleted(
      await makeCheckpoint(SECRET_WORKFLOW, SECRET_EXECUTION, now),
      SECRET_TEXT,
      now + 1,
    );
  }

  test("each public operation reports exactly one metric", async () => {
    const { store, metrics } = observed();
    const checkpoint = await secretCheckpoint();
    const locator = {
      workflowId: SECRET_WORKFLOW,
      executionId: SECRET_EXECUTION,
    };
    await store.save({ context, checkpoint });
    expect(metrics).toHaveLength(1);
    await store.load({ ...locator, context });
    expect(metrics).toHaveLength(2);
    await store.get(locator);
    expect(metrics).toHaveLength(3);
    await store.put({ checkpoint });
    expect(metrics).toHaveLength(4);
    await store.list();
    expect(metrics).toHaveLength(5);
    await store.delete(locator);
    expect(metrics).toHaveLength(6);
    await store.prune({ updatedBefore: 1 });
    expect(metrics).toHaveLength(7);
    const lease = await store.acquireLease({
      ...locator,
      ownerId: "a",
      ttlMs: 100,
    });
    await store.renewLease(lease, 100);
    await store.releaseLease(lease);
    expect(metrics).toHaveLength(10);
    for (const metric of metrics) {
      expect(metric.capability).toBe("checkpoints");
      expect(metric.provider).toBe("fault");
      expect(metric.durationMs).toBeGreaterThanOrEqual(0);
      expect(metric.outcome).toBe("ok");
    }
    expect(metrics.map((metric) => metric.operation).slice(0, 2)).toEqual([
      "save",
      "load",
    ]);
    expect(new Set(metrics.map((m) => m.operation)).size).toBe(10);
  });

  test("a save reports its byte size", async () => {
    const { store, metrics } = observed();
    const checkpoint = await secretCheckpoint();
    await store.put({ checkpoint });
    expect(metrics[0]?.bytes).toBe(
      new TextEncoder().encode(JSON.stringify(checkpoint)).byteLength,
    );
  });

  test("a retried operation still reports one metric", async () => {
    const { store, metrics } = observed();
    await store.put({ checkpoint: await secretCheckpoint() });
    metrics.length = 0;
    store.beforeRead = (call) => {
      if (call <= 2) {
        throw new WorkflowStorageError("WORKFLOW_STORAGE_UNAVAILABLE", "busy");
      }
    };
    await store.get({
      workflowId: SECRET_WORKFLOW,
      executionId: SECRET_EXECUTION,
    });
    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.outcome).toBe("ok");
  });

  test("a conflict reports outcome conflict and a failure reports outcome error with its code", async () => {
    const { store, metrics } = observed();
    await store.put({ checkpoint: await secretCheckpoint(1) });
    metrics.length = 0;
    await reject(
      store.put({
        checkpoint: await secretCheckpoint(5),
        expectedRevision: null,
      }),
    );
    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.outcome).toBe("conflict");
    store.beforeRead = () => {
      throw new WorkflowStorageError("WORKFLOW_STORAGE_CORRUPT", "bad");
    };
    metrics.length = 0;
    await reject(
      store.get({ workflowId: SECRET_WORKFLOW, executionId: SECRET_EXECUTION }),
    );
    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.outcome).toBe("error");
    expect(metrics[0]?.errorCode).toBe("WORKFLOW_STORAGE_CORRUPT");
  });

  test("an unsupported or closed operation is also reported once", async () => {
    const { store, metrics } = observed({ listing: false });
    await reject(store.list());
    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.errorCode).toBe("WORKFLOW_STORAGE_UNSUPPORTED");
    await store.close();
    metrics.length = 0;
    await reject(store.get({ workflowId: "wf", executionId: "e" }));
    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.errorCode).toBe("WORKFLOW_STORAGE_CLOSED");
  });

  test("metrics carry no execution id, workflow id, key or payload text", async () => {
    const { store, metrics } = observed();
    const checkpoint = await secretCheckpoint();
    const locator = {
      workflowId: SECRET_WORKFLOW,
      executionId: SECRET_EXECUTION,
    };
    await store.save({ context, checkpoint });
    await store.load({ ...locator, context });
    await reject(
      store.put({
        checkpoint: await secretCheckpoint(9),
        expectedRevision: null,
      }),
    );
    await store.acquireLease({
      ...locator,
      ownerId: "owner-secret",
      ttlMs: 10,
    });
    await store.delete(locator);
    store.beforeRead = () => {
      throw new WorkflowStorageError(
        "WORKFLOW_STORAGE_UNAVAILABLE",
        `backend failed for ${SECRET_EXECUTION} ${SECRET_TEXT}`,
      );
    };
    await reject(store.get(locator));
    const dump = JSON.stringify(metrics);
    expect(metrics.length).toBeGreaterThan(5);
    for (const secret of [
      SECRET_WORKFLOW,
      SECRET_EXECUTION,
      SECRET_TEXT,
      "owner-secret",
      workflowCheckpointKey(SECRET_WORKFLOW, SECRET_EXECUTION),
    ]) {
      expect(dump.includes(secret)).toBe(false);
    }
  });

  test("an observer that throws never fails the operation", async () => {
    const store = new FaultStore(
      {},
      {
        onOperation: () => {
          throw new Error("observer bug");
        },
      },
    );
    const checkpoint = await makeCheckpoint("wf", "e1");
    await store.put({ checkpoint });
    expect(
      await store.load({ workflowId: "wf", executionId: "e1", context }),
    ).toEqual(checkpoint);
  });
});

describe("BaseWorkflowCheckpointStore declared size limit and timeout scope", () => {
  test("the size limit is the smaller of the option and the declared capability", async () => {
    const store = new FaultStore({ maxCheckpointBytes: 2048 });
    const big = withWorkflowCompleted(
      await makeCheckpoint("wf", "e1"),
      "x".repeat(5000),
      2,
    );
    const error = await reject(store.put({ checkpoint: big }));
    expect(error).toMatchObject({
      details: { reason: "checkpoint_size_limit_exceeded" },
    });
    expect(store.calls.write).toBe(0);
  });

  test("a stored value over the declared capability is never returned", async () => {
    const store = new FaultStore({ maxCheckpointBytes: 2048 });
    const big = withWorkflowCompleted(
      await makeCheckpoint("wf", "e1"),
      "y".repeat(5000),
      2,
    );
    store.data.set(workflowCheckpointKey("wf", "e1"), {
      checkpoint: big,
      revision: await workflowCheckpointRevision(big),
      updatedAt: 5,
    });
    await reject(store.get({ workflowId: "wf", executionId: "e1" }));
  });

  test("operationTimeoutMs limits each try: the default retry policy tries a hung backend four times", async () => {
    const store = new FaultStore(
      {},
      { operationTimeoutMs: 20, retry: undefined },
    );
    store.beforeRead = () => new Promise<void>(() => {});
    const error = await reject(
      store.get({ workflowId: "wf", executionId: "e1" }),
    );
    expectStorageCode(error, "WORKFLOW_STORAGE_TIMEOUT");
    expect(store.calls.read).toBe(4);
  });

  test("a second close does nothing and does not rethrow when the first close failed", async () => {
    class FailingClose extends FaultStore {
      protected override async closeStore(): Promise<void> {
        throw new Error("close failed");
      }
    }
    const store = new FailingClose();
    await reject(store.close());
    await store.close();
  });
});
