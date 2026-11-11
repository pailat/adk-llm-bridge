import {
  createWorkflowCheckpoint,
  withWorkflowCompleted,
  withWorkflowFailed,
} from "../../checkpoint/checkpoint.js";
import { MAX_STEP_ACCEPTANCES } from "../../checkpoint/replay-acceptance.js";
import type { WorkflowCheckpointV1 } from "../../checkpoint/schema.js";
import {
  MAX_INPUT_CHUNKS,
  MIN_INPUT_CHUNK_SIZE,
} from "../../checkpoint/step-record.js";
import {
  type WorkflowCheckpointLocator,
  workflowCheckpointKey,
  workflowCheckpointRevision,
} from "../../checkpoint/store.js";
import { defineWorkflow } from "../../definition.js";
import {
  BaseWorkflowCheckpointStore,
  type StoredWorkflowCheckpoint,
  WORKFLOW_CHECKPOINT_STORE_CONTRACT_VERSION,
  type WorkflowCheckpointLease,
  type WorkflowCheckpointStoreCapabilities,
} from "../checkpoint-store.js";
import type { WorkflowStorageOperationMetric } from "../support.js";
import {
  type WorkflowStorageConformanceCase,
  WorkflowStorageConformanceFailure,
} from "./harness.js";

/**
 * Options of {@link workflowCheckpointStoreConformanceCases}.
 *
 * @experimental
 */
export interface WorkflowCheckpointStoreConformanceOptions {
  /** Creates a provider over new, empty storage. Called once per case. */
  createStore: () =>
    | BaseWorkflowCheckpointStore
    | Promise<BaseWorkflowCheckpointStore>;
  /**
   * Creates a second provider instance over the storage of `store`. Needed
   * for the durability and multi-writer cases; without it they are skipped.
   */
  reopenStore?: (
    store: BaseWorkflowCheckpointStore,
  ) => BaseWorkflowCheckpointStore | Promise<BaseWorkflowCheckpointStore>;
  /**
   * Removes the storage of a provider after its case. The suite closes the
   * provider first.
   */
  destroyStore?: (store: BaseWorkflowCheckpointStore) => void | Promise<void>;
  /**
   * Number of concurrent writers in the compare-and-set and lease cases.
   *
   * @defaultValue 8
   */
  workers?: number;
}

/**
 * Builds the conformance cases of the checkpoint provider contract, version
 * `WORKFLOW_CHECKPOINT_STORE_CONTRACT_VERSION`.
 *
 * @remarks
 * The cases cover: load of a missing checkpoint; save then load; `get` and
 * `put` without an invocation context; the returned `stateDelta`; rejection
 * of an invalid checkpoint, of an oversized one before any write, and of a
 * supplied revision that does not match; compare-and-set with a present, an
 * absent and a stale expected revision; exactly one winner among N
 * concurrent writers (`compareAndSet: "atomic"`); the idempotent repeat of a
 * stored revision; isolation between executions and between workflows;
 * leases (one holder among N, takeover after expiry with a higher token, a
 * fenced save writes nothing, renew and release) when `leases` is `true`;
 * cursor pagination that visits every checkpoint once, in order, when
 * `listing` is `true`; delete and prune when `pruning` is `true`; rejection
 * with `WORKFLOW_STORAGE_UNSUPPORTED` of every operation whose flag is
 * `false`; survival of a reopen when `durable` is `true`; the health check;
 * `WORKFLOW_STORAGE_CLOSED` after `close`; and one metric per operation
 * without ids or payloads.
 *
 * One provider is created up front to read its capability flags.
 *
 * @param options - How to create, reopen and destroy the provider.
 * @returns The cases, with `skip` set on those the flags exclude.
 *
 * @experimental
 */
export async function workflowCheckpointStoreConformanceCases(
  options: WorkflowCheckpointStoreConformanceOptions,
): Promise<WorkflowStorageConformanceCase[]> {
  const workers = options.workers ?? 8;
  // The probe is handed to the first case that asks for a provider, so no
  // storage is created only to be thrown away.
  let spare: BaseWorkflowCheckpointStore | undefined =
    await options.createStore();
  const capabilities = spare.capabilities;
  const reopenStore = options.reopenStore;

  const fresh = async (): Promise<BaseWorkflowCheckpointStore> => {
    if (spare) {
      const store = spare;
      spare = undefined;
      return store;
    }
    return await options.createStore();
  };

  /** Runs a case against a fresh provider, closes it, then destroys it. */
  const withStore =
    (
      body: (
        store: BaseWorkflowCheckpointStore,
        track: (extra: BaseWorkflowCheckpointStore) => void,
      ) => Promise<void>,
    ) =>
    async (): Promise<void> => {
      const store = await fresh();
      const extras: BaseWorkflowCheckpointStore[] = [];
      try {
        await body(store, (extra) => {
          if (extra !== store) extras.push(extra);
        });
      } finally {
        for (const extra of extras) await extra.close().catch(() => undefined);
        await store.close().catch(() => undefined);
        await options.destroyStore?.(store);
      }
    };

  const cases: WorkflowStorageConformanceCase[] = [];
  const add = (
    name: string,
    run: () => Promise<void>,
    skip?: string | undefined,
  ): void => {
    cases.push(skip === undefined ? { name, run } : { name, run, skip });
  };

  const atomic = capabilities.compareAndSet === "atomic";
  const noAtomic = atomic
    ? undefined
    : 'compareAndSet is "advisory": the provider does not promise a single winner';
  const noLeases = capabilities.leases ? undefined : "leases is false";
  const noListing = capabilities.listing ? undefined : "listing is false";
  const noPruning = capabilities.pruning ? undefined : "pruning is false";
  const noReopen =
    reopenStore === undefined ? "reopenStore was not given" : undefined;

  // --- Reads, writes and the returned stateDelta ---------------------------

  add(
    "load of a missing checkpoint resolves undefined",
    withStore(async (store) => {
      const loaded = await store.load({ ...LOCATOR, context: NO_CONTEXT });
      check(
        loaded === undefined,
        "load of a missing checkpoint returned a value",
      );
      check(
        (await store.get(LOCATOR)) === undefined,
        "get of a missing checkpoint returned a value",
      );
    }),
  );

  add(
    "save then load returns the saved checkpoint (round trip)",
    withStore(async (store) => {
      const checkpoint = await makeCheckpoint(LOCATOR);
      await store.save({ context: NO_CONTEXT, checkpoint });
      const loaded = await store.load({ ...LOCATOR, context: NO_CONTEXT });
      checkEqual(loaded, checkpoint, "the loaded checkpoint");
    }),
  );

  add(
    "get and put need no invocation context and return the stored revision",
    withStore(async (store) => {
      const checkpoint = await makeCheckpoint(LOCATOR);
      const revision = await workflowCheckpointRevision(checkpoint);
      const put = await store.put({ checkpoint, expectedRevision: null });
      checkEqual(put.checkpoint, checkpoint, "the checkpoint put returned");
      checkEqual(put.revision, revision, "the revision put returned");
      check(typeof put.updatedAt === "number", "put returned no save time");
      const got = await store.get(LOCATOR);
      checkEqual(got?.checkpoint, checkpoint, "the checkpoint get returned");
      checkEqual(got?.revision, revision, "the revision get returned");
      check(typeof got?.updatedAt === "number", "get returned no save time");
    }),
  );

  add(
    "save returns the checkpoint key and a stateDelta holding the durable checkpoint",
    withStore(async (store) => {
      const checkpoint = await makeCheckpoint(LOCATOR);
      const write = await store.save({ context: NO_CONTEXT, checkpoint });
      const key = workflowCheckpointKey(
        LOCATOR.workflowId,
        LOCATOR.executionId,
      );
      checkEqual(write.checkpointKey, key, "the checkpoint key");
      checkEqual(write.stateDelta, { [key]: checkpoint }, "the stateDelta");
    }),
  );

  add(
    "an invalid checkpoint is rejected and nothing is stored",
    withStore(async (store) => {
      const valid = await makeCheckpoint(LOCATOR);
      const invalid = {
        ...valid,
        status: "bogus",
      } as unknown as WorkflowCheckpointV1;
      const error = await rejection(store.put({ checkpoint: invalid }));
      checkEqual(
        reasonOf(error),
        "checkpoint_schema_invalid",
        "the failure reason",
      );
      check(
        (await store.get(LOCATOR)) === undefined,
        "an invalid checkpoint was stored",
      );
    }),
  );

  add(
    "an oversized checkpoint is rejected before any write and the stored one stays",
    withStore(async (store) => {
      const base = await makeCheckpoint(LOCATOR);
      await store.put({ checkpoint: base });
      const big = withWorkflowCompleted(
        base,
        "x".repeat(capabilities.maxCheckpointBytes + 1),
        2,
      );
      const error = await rejection(store.put({ checkpoint: big }));
      checkEqual(
        reasonOf(error),
        "checkpoint_size_limit_exceeded",
        "the failure reason",
      );
      checkEqual(
        (await store.get(LOCATOR))?.checkpoint,
        base,
        "the stored checkpoint",
      );
    }),
  );

  add(
    "a supplied revision that does not match the checkpoint is rejected before any write",
    withStore(async (store) => {
      const checkpoint = await makeCheckpoint(LOCATOR);
      const error = await rejection(
        store.save({
          context: NO_CONTEXT,
          checkpoint,
          revision: "sha256:wrong",
        }),
      );
      checkEqual(
        reasonOf(error),
        "checkpoint_revision_invalid",
        "the failure reason",
      );
      check(
        (await store.get(LOCATOR)) === undefined,
        "a mismatched save was stored",
      );
      const matching = await workflowCheckpointRevision(checkpoint);
      await store.save({ context: NO_CONTEXT, checkpoint, revision: matching });
      checkEqual(
        (await store.get(LOCATOR))?.revision,
        matching,
        "the stored revision",
      );
    }),
  );

  // --- Compare-and-set -------------------------------------------------------

  add(
    "compare-and-set rejects a stale expectedRevision with a conflict and writes nothing",
    withStore(async (store) => {
      const first = await makeCheckpoint(LOCATOR, 1);
      const second = await makeCheckpoint(LOCATOR, 2);
      const third = await makeCheckpoint(LOCATOR, 3);
      const firstRevision = await workflowCheckpointRevision(first);
      await store.put({ checkpoint: first, expectedRevision: null });
      await store.put({ checkpoint: second, expectedRevision: firstRevision });
      const error = await rejection(
        store.put({ checkpoint: third, expectedRevision: firstRevision }),
      );
      check(isConflict(error), "a stale expectedRevision did not conflict");
      checkEqual(
        (await store.get(LOCATOR))?.checkpoint,
        second,
        "the stored checkpoint",
      );
    }),
  );

  add(
    "a rejected save leaves the previous checkpoint in place (atomic write)",
    withStore(async (store) => {
      const first = await makeCheckpoint(LOCATOR, 1);
      await store.put({ checkpoint: first });
      await rejection(
        store.put({
          checkpoint: await makeCheckpoint(LOCATOR, 2),
          expectedRevision: "sha256:stale",
        }),
      );
      checkEqual(
        (await store.get(LOCATOR))?.checkpoint,
        first,
        "the stored checkpoint",
      );
      checkEqual(
        await store.load({ ...LOCATOR, context: NO_CONTEXT }),
        first,
        "the loaded checkpoint",
      );
    }),
  );

  add(
    "expectedRevision null succeeds when nothing is stored and rejects when a checkpoint exists",
    withStore(async (store) => {
      const first = await makeCheckpoint(LOCATOR, 1);
      await store.put({ checkpoint: first, expectedRevision: null });
      const error = await rejection(
        store.put({
          checkpoint: await makeCheckpoint(LOCATOR, 2),
          expectedRevision: null,
        }),
      );
      check(isConflict(error), "expectedRevision null did not conflict");
      checkEqual(
        (await store.get(LOCATOR))?.checkpoint,
        first,
        "the stored checkpoint",
      );
    }),
  );

  add(
    "a matching expectedRevision replaces the stored checkpoint",
    withStore(async (store) => {
      const first = await makeCheckpoint(LOCATOR, 1);
      const second = await makeCheckpoint(LOCATOR, 2);
      await store.put({ checkpoint: first });
      await store.put({
        checkpoint: second,
        expectedRevision: await workflowCheckpointRevision(first),
      });
      checkEqual(
        (await store.get(LOCATOR))?.checkpoint,
        second,
        "the stored checkpoint",
      );
    }),
  );

  add(
    `exactly one of ${workers} concurrent writers with the same expectedRevision wins`,
    withStore(async (store) => {
      const base = await makeCheckpoint(LOCATOR, 1);
      await store.put({ checkpoint: base });
      const expectedRevision = await workflowCheckpointRevision(base);
      const candidates = await Promise.all(
        Array.from({ length: workers }, (_, i) =>
          makeCheckpoint(LOCATOR, 10 + i),
        ),
      );
      const results = await Promise.allSettled(
        candidates.map((checkpoint) =>
          store.put({ checkpoint, expectedRevision }),
        ),
      );
      const winners = results.filter(
        (result): result is PromiseFulfilledResult<StoredWorkflowCheckpoint> =>
          result.status === "fulfilled",
      );
      checkEqual(winners.length, 1, "the number of winning writers");
      for (const result of results) {
        if (result.status === "rejected") {
          check(
            isConflict(result.reason),
            "a losing writer failed without a conflict",
          );
        }
      }
      checkEqual(
        (await store.get(LOCATOR))?.revision,
        winners[0]?.value.revision,
        "the stored revision",
      );
    }),
    noAtomic,
  );

  add(
    `exactly one of ${workers} concurrent creators with expectedRevision null wins`,
    withStore(async (store) => {
      const candidates = await Promise.all(
        Array.from({ length: workers }, (_, i) =>
          makeCheckpoint(LOCATOR, i + 1),
        ),
      );
      const results = await Promise.allSettled(
        candidates.map((checkpoint) =>
          store.put({ checkpoint, expectedRevision: null }),
        ),
      );
      checkEqual(
        results.filter((result) => result.status === "fulfilled").length,
        1,
        "the number of winning creators",
      );
    }),
    noAtomic,
  );

  add(
    "repeating a save whose revision is already stored is idempotent and resolves without a conflict",
    withStore(async (store) => {
      const first = await makeCheckpoint(LOCATOR, 1);
      const second = await makeCheckpoint(LOCATOR, 2);
      const firstRevision = await workflowCheckpointRevision(first);
      await store.put({ checkpoint: first, expectedRevision: null });
      await store.put({ checkpoint: second, expectedRevision: firstRevision });
      const repeated = await store.put({
        checkpoint: second,
        expectedRevision: firstRevision,
      });
      checkEqual(
        repeated.revision,
        await workflowCheckpointRevision(second),
        "the repeated save revision",
      );
      const again = await store
        .save({
          context: NO_CONTEXT,
          checkpoint: first,
          expectedRevision: null,
        })
        .then(
          () => "resolved",
          () => "rejected",
        );
      // The first checkpoint is no longer the stored one: this is a real
      // conflict, not a repeat, and must not be hidden.
      checkEqual(again, "rejected", "a save of a replaced revision");
      checkEqual(
        (await store.get(LOCATOR))?.checkpoint,
        second,
        "the stored checkpoint",
      );
    }),
  );

  add(
    "executions and workflows that share an id are isolated from each other",
    withStore(async (store) => {
      const a = { workflowId: "wf-a", executionId: "same" };
      const b = { workflowId: "wf-b", executionId: "same" };
      const c = { workflowId: "wf-a", executionId: "other" };
      await store.put({
        checkpoint: await makeCheckpoint(a, 1),
        expectedRevision: null,
      });
      await store.put({
        checkpoint: await makeCheckpoint(b, 2),
        expectedRevision: null,
      });
      checkEqual(
        (await store.get(a))?.checkpoint.workflowId,
        "wf-a",
        "workflow of a",
      );
      checkEqual(
        (await store.get(b))?.checkpoint.workflowId,
        "wf-b",
        "workflow of b",
      );
      check(
        (await store.get(c)) === undefined,
        "an unrelated execution has a checkpoint",
      );
    }),
  );

  add(
    "a stored value that does not match its revision is never returned (integrity)",
    withStore(async (store) => {
      await store.put({ checkpoint: await makeCheckpoint(LOCATOR, 1) });
      const tampered = tamperedView(store, (stored) => ({
        ...stored,
        checkpoint: { ...stored.checkpoint, status: "failed" },
      }));
      const viaGet = await rejection(tampered.get(LOCATOR));
      const viaLoad = await rejection(
        tampered.load({ ...LOCATOR, context: NO_CONTEXT }),
      );
      for (const error of [viaGet, viaLoad]) {
        check(
          hasCode(error, "WORKFLOW_STORAGE_CORRUPT") ||
            hasCode(error, "WORKFLOW_EXECUTION_ERROR"),
          "a tampered value was returned or failed with an unexpected error",
        );
      }
    }),
  );

  // --- Step results, step records and acceptances ---------------------------

  const roundTrips = (
    name: string,
    build: (base: WorkflowCheckpointV1) => WorkflowCheckpointV1,
  ): void => {
    add(
      name,
      withStore(async (store) => {
        const checkpoint = build(await makeCheckpoint(LOCATOR));
        await store.save({ context: NO_CONTEXT, checkpoint });
        checkEqual(
          await store.load({ ...LOCATOR, context: NO_CONTEXT }),
          checkpoint,
          "the loaded checkpoint",
        );
        checkEqual(
          (await store.get(LOCATOR))?.checkpoint,
          checkpoint,
          "the checkpoint get returned",
        );
      }),
    );
  };

  roundTrips("a step result with models loads back equal", (base) =>
    withSteps(base, {
      a: completedStep("a", {
        models: {
          requested: ["model-a"],
          resolved: ["model-a-2026-01"],
          unknown: false,
        },
      }),
      b: completedStep("b", {
        models: { requested: [], resolved: [], unknown: true },
      }),
    }),
  );

  roundTrips(
    "a step record with the requested model and the input fingerprint at its limits loads back equal",
    (base) =>
      withSteps(base, {
        small: {
          ...completedStep("small"),
          model: { requested: "model-a" },
          inputLength: MIN_INPUT_CHUNK_SIZE + 1,
          inputDigest: {
            chunkSize: MIN_INPUT_CHUNK_SIZE,
            chunks: digests(2),
          },
        },
        large: {
          ...completedStep("large"),
          model: {},
          inputLength: MIN_INPUT_CHUNK_SIZE * MAX_INPUT_CHUNKS,
          inputDigest: {
            chunkSize: MIN_INPUT_CHUNK_SIZE,
            chunks: digests(MAX_INPUT_CHUNKS),
          },
        },
        short: { ...completedStep("short"), inputLength: 10 },
      }),
  );

  for (const count of [1, MAX_STEP_ACCEPTANCES]) {
    roundTrips(
      `a completed step with ${count} acceptance${count === 1 ? "" : "s"} loads back equal and in order`,
      (base) =>
        withSteps(base, {
          a: {
            ...completedStep("a"),
            acceptances: Array.from({ length: count }, (_, i) => ({
              kind: "model" as const,
              from: `model-${i}`,
              to: `model-${i + 1}`,
              reason: `reason ${i}`,
              ...(i % 2 === 0 ? { approvedBy: "operator" } : {}),
              acceptedAt: 1000 + i,
            })),
          },
        }),
    );
  }

  roundTrips(
    "a checkpoint without models or step records still loads",
    (base) => withSteps(base, { a: completedStep("a") }),
  );

  const malformed: [string, Record<string, unknown>][] = [
    ["models with a missing field", { result: { models: { requested: [] } } }],
    [
      "models with a non-boolean unknown",
      { result: { models: { requested: [], resolved: [], unknown: "no" } } },
    ],
    ["a model with an empty requested id", { model: { requested: "" } }],
    [
      "an input fingerprint without a length",
      {
        inputDigest: { chunkSize: MIN_INPUT_CHUNK_SIZE, chunks: digests(2) },
      },
    ],
    [
      "an input fingerprint with a chunk count that does not match",
      {
        inputLength: MIN_INPUT_CHUNK_SIZE * 3,
        inputDigest: { chunkSize: MIN_INPUT_CHUNK_SIZE, chunks: digests(2) },
      },
    ],
    [
      "more acceptances than a step may hold",
      {
        acceptances: Array.from(
          { length: MAX_STEP_ACCEPTANCES + 1 },
          (_, i) => ({
            kind: "model",
            from: `m${i}`,
            to: `m${i + 1}`,
            reason: "r",
            acceptedAt: 1,
          }),
        ),
      },
    ],
    ["an empty acceptances list", { acceptances: [] }],
  ];
  for (const [what, patch] of malformed) {
    add(
      `a stored checkpoint with ${what} is rejected as corrupt, and put refuses it`,
      withStore(async (store) => {
        const good = withSteps(await makeCheckpoint(LOCATOR), {
          a: completedStep("a"),
        });
        await store.put({ checkpoint: good });
        const bad = withSteps(await makeCheckpoint(LOCATOR), {
          a: mergeStep(completedStep("a"), patch),
        });
        const refused = await rejection(store.put({ checkpoint: bad }));
        checkEqual(
          reasonOf(refused),
          "checkpoint_schema_invalid",
          "the failure reason of put",
        );
        const tampered = tamperedView(store, (stored) => ({
          ...stored,
          checkpoint: bad,
        }));
        const viaLoad = await rejection(
          tampered.load({ ...LOCATOR, context: NO_CONTEXT }),
        );
        check(
          hasCode(viaLoad, "WORKFLOW_STORAGE_CORRUPT"),
          "a malformed stored step was returned or failed with another error",
        );
        checkEqual(
          (await store.get(LOCATOR))?.checkpoint,
          good,
          "the stored checkpoint",
        );
      }),
    );
  }

  // --- Capability flags ---------------------------------------------------

  add(
    "the declared capability flags are well formed",
    withStore(async (store) => {
      const flags = store.capabilities;
      check(
        flags.compareAndSet === "atomic" || flags.compareAndSet === "advisory",
        "compareAndSet is neither atomic nor advisory",
      );
      for (const flag of [
        "leases",
        "durable",
        "multiProcess",
        "listing",
        "pruning",
      ] as const) {
        check(typeof flags[flag] === "boolean", `${flag} is not a boolean`);
      }
      check(
        Number.isSafeInteger(flags.maxCheckpointBytes) &&
          flags.maxCheckpointBytes > 0,
        "maxCheckpointBytes is not a positive safe integer",
      );
      check(
        typeof store.providerName === "string" && store.providerName.length > 0,
        "providerName is empty",
      );
      checkEqual(
        store.contractVersion,
        WORKFLOW_CHECKPOINT_STORE_CONTRACT_VERSION,
        "the contract version",
      );
    }),
  );

  add(
    "a provider without leases rejects lease operations and fenced saves with WORKFLOW_STORAGE_UNSUPPORTED",
    withStore(async (store) => {
      if (store.capabilities.leases) return;
      const lease = fakeLease(LOCATOR);
      const fenced = await makeCheckpoint(LOCATOR);
      for (const attempt of [
        () => store.acquireLease({ ...LOCATOR, ownerId: "a", ttlMs: 1000 }),
        () => store.renewLease(lease, 1000),
        () => store.releaseLease(lease),
        () => store.put({ checkpoint: fenced, fencingToken: 1 }),
      ]) {
        check(
          hasCode(await rejection(attempt()), "WORKFLOW_STORAGE_UNSUPPORTED"),
          "an undeclared lease operation did not reject as unsupported",
        );
      }
      check(
        (await store.get(LOCATOR)) === undefined,
        "a fenced save wrote anyway",
      );
    }),
  );

  add(
    "a provider without listing rejects list with WORKFLOW_STORAGE_UNSUPPORTED",
    withStore(async (store) => {
      if (store.capabilities.listing) return;
      check(
        hasCode(await rejection(store.list()), "WORKFLOW_STORAGE_UNSUPPORTED"),
        "list did not reject as unsupported",
      );
    }),
  );

  add(
    "a provider without pruning rejects delete and prune with WORKFLOW_STORAGE_UNSUPPORTED",
    withStore(async (store) => {
      if (store.capabilities.pruning) return;
      for (const attempt of [
        () => store.delete(LOCATOR),
        () => store.prune({ updatedBefore: Date.now() }),
      ]) {
        check(
          hasCode(await rejection(attempt()), "WORKFLOW_STORAGE_UNSUPPORTED"),
          "an undeclared pruning operation did not reject as unsupported",
        );
      }
    }),
  );

  // --- Leases -------------------------------------------------------------

  add(
    `only one of ${workers} owners acquires an unexpired lease`,
    withStore(async (store) => {
      const results = await Promise.allSettled(
        Array.from({ length: workers }, (_, i) =>
          store.acquireLease({
            ...LOCATOR,
            ownerId: `owner-${i}`,
            ttlMs: 60_000,
          }),
        ),
      );
      checkEqual(
        results.filter((result) => result.status === "fulfilled").length,
        1,
        "the number of owners that got the lease",
      );
      for (const result of results) {
        if (result.status === "rejected") {
          check(
            hasCode(result.reason, "WORKFLOW_STORAGE_LEASE_HELD"),
            "a refused owner did not get WORKFLOW_STORAGE_LEASE_HELD",
          );
        }
      }
    }),
    noLeases,
  );

  add(
    "a lease held by another owner is refused with WORKFLOW_STORAGE_LEASE_HELD and its expiry",
    withStore(async (store) => {
      const first = await store.acquireLease({
        ...LOCATOR,
        ownerId: "a",
        ttlMs: 60_000,
      });
      checkEqual(first.fencingToken, 1, "the first fencing token");
      const error = await rejection(
        store.acquireLease({ ...LOCATOR, ownerId: "b", ttlMs: 60_000 }),
      );
      check(
        hasCode(error, "WORKFLOW_STORAGE_LEASE_HELD"),
        "no WORKFLOW_STORAGE_LEASE_HELD",
      );
      check(
        typeof (error as { details?: { expiresAt?: unknown } }).details
          ?.expiresAt === "number",
        "the error has no expiresAt",
      );
    }),
    noLeases,
  );

  add(
    "a takeover after expiry raises the fencing token by one",
    withStore(async (store) => {
      const first = await store.acquireLease({
        ...LOCATOR,
        ownerId: "a",
        ttlMs: 20,
      });
      const second = await acquireAfterExpiry(store, LOCATOR, "b");
      checkEqual(
        second.fencingToken,
        first.fencingToken + 1,
        "the takeover token",
      );
      checkEqual(second.ownerId, "b", "the new owner");
    }),
    noLeases,
  );

  add(
    "a save with a fencing token lower than the current one rejects with WORKFLOW_STORAGE_LEASE_LOST and writes nothing (fenced save)",
    withStore(async (store) => {
      const first = await store.acquireLease({
        ...LOCATOR,
        ownerId: "a",
        ttlMs: 20,
      });
      const second = await acquireAfterExpiry(store, LOCATOR, "b");
      const accepted = await makeCheckpoint(LOCATOR, 1);
      await store.put({
        checkpoint: accepted,
        fencingToken: second.fencingToken,
      });
      const error = await rejection(
        store.put({
          checkpoint: await makeCheckpoint(LOCATOR, 2),
          fencingToken: first.fencingToken,
        }),
      );
      check(
        hasCode(error, "WORKFLOW_STORAGE_LEASE_LOST"),
        "no WORKFLOW_STORAGE_LEASE_LOST",
      );
      checkEqual(
        (await store.get(LOCATOR))?.checkpoint,
        accepted,
        "the stored checkpoint",
      );
    }),
    noLeases,
  );

  add(
    "renewing a lease keeps its token, and a replaced lease cannot renew",
    withStore(async (store) => {
      const first = await store.acquireLease({
        ...LOCATOR,
        ownerId: "a",
        ttlMs: 5000,
      });
      const renewed = await store.renewLease(first, 60_000);
      checkEqual(renewed.fencingToken, first.fencingToken, "the renewed token");
      check(
        renewed.expiresAt > first.expiresAt,
        "renewing did not extend the expiry",
      );
      const other = { workflowId: "wf", executionId: "renew-other" };
      const short = await store.acquireLease({
        ...other,
        ownerId: "a",
        ttlMs: 20,
      });
      await acquireAfterExpiry(store, other, "b");
      const error = await rejection(store.renewLease(short, 1000));
      check(
        hasCode(error, "WORKFLOW_STORAGE_LEASE_LOST"),
        "no WORKFLOW_STORAGE_LEASE_LOST",
      );
    }),
    noLeases,
  );

  add(
    "releasing a lease frees it at once and a stale release does nothing",
    withStore(async (store) => {
      const first = await store.acquireLease({
        ...LOCATOR,
        ownerId: "a",
        ttlMs: 60_000,
      });
      await store.releaseLease(first);
      const second = await store.acquireLease({
        ...LOCATOR,
        ownerId: "b",
        ttlMs: 60_000,
      });
      checkEqual(second.fencingToken, first.fencingToken + 1, "the next token");
      await store.releaseLease(first);
      const error = await rejection(
        store.acquireLease({ ...LOCATOR, ownerId: "c", ttlMs: 1000 }),
      );
      check(
        hasCode(error, "WORKFLOW_STORAGE_LEASE_HELD"),
        "the stale release freed the lease",
      );
    }),
    noLeases,
  );

  add(
    "a save with the current fencing token is accepted, and leases of different executions are independent",
    withStore(async (store) => {
      const a = await store.acquireLease({
        ...LOCATOR,
        ownerId: "a",
        ttlMs: 60_000,
      });
      const other = { workflowId: "wf", executionId: "independent" };
      const b = await store.acquireLease({
        ...other,
        ownerId: "b",
        ttlMs: 60_000,
      });
      checkEqual(a.fencingToken, 1, "token of the first execution");
      checkEqual(b.fencingToken, 1, "token of the second execution");
      const checkpoint = await makeCheckpoint(LOCATOR);
      await store.put({ checkpoint, fencingToken: a.fencingToken });
      checkEqual(
        (await store.get(LOCATOR))?.checkpoint,
        checkpoint,
        "the stored checkpoint",
      );
    }),
    noLeases,
  );

  // --- Listing --------------------------------------------------------------

  add(
    "cursor pagination visits every checkpoint once, in workflow and execution order",
    withStore(async (store) => {
      const expected: string[] = [];
      for (let i = 0; i < 7; i += 1) {
        const locator = {
          workflowId: i % 2 === 0 ? "wf-a" : "wf-b",
          executionId: `e${String(i).padStart(2, "0")}`,
        };
        expected.push(`${locator.workflowId}/${locator.executionId}`);
        await store.put({ checkpoint: await makeCheckpoint(locator, i + 1) });
      }
      expected.sort();
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await store.list({ limit: 3, cursor });
        check(page.items.length <= 3, "a page is larger than its limit");
        for (const item of page.items)
          seen.push(`${item.workflowId}/${item.executionId}`);
        cursor = page.nextCursor;
        pages += 1;
        check(pages <= 10, "pagination does not end");
      } while (cursor !== undefined);
      checkEqual(seen, expected, "the listed checkpoints");
      checkEqual(pages, 3, "the number of pages");
    }),
    noListing,
  );

  add(
    "listing returns summaries without step data and filters by workflow id and status",
    withStore(async (store) => {
      const a = { workflowId: "wf-a", executionId: "e1" };
      const b = { workflowId: "wf-b", executionId: "e2" };
      await store.put({ checkpoint: await makeCheckpoint(a, 1) });
      const done = withWorkflowCompleted(await makeCheckpoint(b, 2), "out", 3);
      await store.put({ checkpoint: done });
      const all = await store.list();
      checkEqual(all.items.length, 2, "the number of summaries");
      const summary = all.items.find((item) => item.executionId === "e2");
      const stored = await store.get(b);
      checkEqual(summary?.revision, stored?.revision, "the summary revision");
      checkEqual(summary?.status, "completed", "the summary status");
      checkEqual(
        summary?.bytes,
        new TextEncoder().encode(JSON.stringify(stored?.checkpoint)).byteLength,
        "the summary size",
      );
      check(
        summary !== undefined &&
          !("steps" in summary) &&
          !("checkpoint" in summary),
        "a summary carries step data",
      );
      checkEqual(
        (await store.list({ workflowId: "wf-a" })).items.map(
          (i) => i.executionId,
        ),
        ["e1"],
        "the workflow filter",
      );
      checkEqual(
        (await store.list({ status: "completed" })).items.map(
          (i) => i.executionId,
        ),
        ["e2"],
        "the status filter",
      );
    }),
    noListing,
  );

  add(
    "a malformed list cursor is rejected with WORKFLOW_STORAGE_INVALID_OPTION",
    withStore(async (store) => {
      const error = await rejection(store.list({ cursor: "!!not-a-cursor!!" }));
      check(
        hasCode(error, "WORKFLOW_STORAGE_INVALID_OPTION"),
        "no WORKFLOW_STORAGE_INVALID_OPTION",
      );
    }),
    noListing,
  );

  // --- Delete and prune -------------------------------------------------------

  add(
    "delete removes a checkpoint and reports whether one existed",
    withStore(async (store) => {
      await store.put({ checkpoint: await makeCheckpoint(LOCATOR) });
      checkEqual(await store.delete(LOCATOR), true, "the first delete");
      check(
        (await store.get(LOCATOR)) === undefined,
        "a deleted checkpoint is still stored",
      );
      checkEqual(await store.delete(LOCATOR), false, "the second delete");
      if (store.capabilities.leases) {
        await store.acquireLease({ ...LOCATOR, ownerId: "a", ttlMs: 60_000 });
        await store.put({ checkpoint: await makeCheckpoint(LOCATOR) });
        await store.delete(LOCATOR);
        const lease = await store.acquireLease({
          ...LOCATOR,
          ownerId: "b",
          ttlMs: 60_000,
        });
        checkEqual(lease.ownerId, "b", "delete did not remove the lease");
      }
    }),
    noPruning,
  );

  add(
    "delete with a stale expectedRevision rejects with a conflict and keeps the checkpoint",
    withStore(async (store) => {
      const checkpoint = await makeCheckpoint(LOCATOR);
      await store.put({ checkpoint });
      const error = await rejection(
        store.delete({ ...LOCATOR, expectedRevision: "sha256:stale" }),
      );
      check(isConflict(error), "a stale delete did not conflict");
      check(
        (await store.get(LOCATOR)) !== undefined,
        "a stale delete removed the checkpoint",
      );
      checkEqual(
        await store.delete({
          ...LOCATOR,
          expectedRevision: await workflowCheckpointRevision(checkpoint),
        }),
        true,
        "the matching delete",
      );
    }),
    noPruning,
  );

  add(
    "prune deletes old completed and failed checkpoints and keeps running and recent ones",
    withStore(async (store) => {
      const at = (executionId: string) => ({ workflowId: "wf", executionId });
      const base = (executionId: string) => makeCheckpoint(at(executionId), 1);
      await store.put({
        checkpoint: withWorkflowCompleted(await base("completed"), "x", 2),
      });
      await store.put({
        checkpoint: withWorkflowFailed(
          await base("failed"),
          { code: "WORKFLOW_EXECUTION_ERROR", message: "failed" },
          "failed",
          2,
        ),
      });
      await store.put({ checkpoint: await base("running") });
      const none = await store.prune({ updatedBefore: Date.now() - 3_600_000 });
      checkEqual(none, { deleted: 0, hasMore: false }, "pruning nothing old");
      const result = await store.prune({
        updatedBefore: Date.now() + 3_600_000,
      });
      checkEqual(result, { deleted: 2, hasMore: false }, "the prune result");
      check(
        (await store.get(at("running"))) !== undefined,
        "prune removed a running checkpoint",
      );
      check(
        (await store.get(at("completed"))) === undefined,
        "prune kept a completed checkpoint",
      );
    }),
    noPruning,
  );

  add(
    "prune honors statuses, the workflow filter and its limit with hasMore",
    withStore(async (store) => {
      for (let i = 0; i < 5; i += 1) {
        await store.put({
          checkpoint: withWorkflowCompleted(
            await makeCheckpoint(
              { workflowId: "wf-a", executionId: `e${i}` },
              1,
            ),
            "x",
            2,
          ),
        });
      }
      await store.put({
        checkpoint: await makeCheckpoint(
          { workflowId: "wf-b", executionId: "r" },
          1,
        ),
      });
      const future = Date.now() + 3_600_000;
      checkEqual(
        await store.prune({ updatedBefore: future, workflowId: "wf-b" }),
        { deleted: 0, hasMore: false },
        "pruning another workflow by default statuses",
      );
      checkEqual(
        await store.prune({ updatedBefore: future, limit: 2 }),
        { deleted: 2, hasMore: true },
        "the first batch",
      );
      checkEqual(
        await store.prune({ updatedBefore: future, limit: 10 }),
        { deleted: 3, hasMore: false },
        "the second batch",
      );
      checkEqual(
        (
          await store.prune({
            updatedBefore: future,
            statuses: ["running"],
            workflowId: "wf-b",
          })
        ).deleted,
        1,
        "the running checkpoint",
      );
    }),
    noPruning,
  );

  // --- Durability and several instances ---------------------------------------

  add(
    "a durable provider keeps its checkpoints across a reopen",
    async () => {
      const store = await fresh();
      const reopened: BaseWorkflowCheckpointStore[] = [];
      try {
        const checkpoint = await makeCheckpoint(LOCATOR, 1);
        await store.put({ checkpoint, expectedRevision: null });
        if (!store.capabilities.durable || !reopenStore) return;
        const second = await reopenStore(store);
        if (second !== store) {
          reopened.push(second);
          await store.close();
        }
        const stored = await second.get(LOCATOR);
        checkEqual(
          stored?.checkpoint,
          checkpoint,
          "the checkpoint after the reopen",
        );
        checkEqual(
          stored?.revision,
          await workflowCheckpointRevision(checkpoint),
          "the revision after the reopen",
        );
      } finally {
        for (const extra of reopened)
          await extra.close().catch(() => undefined);
        await store.close().catch(() => undefined);
        await options.destroyStore?.(store);
      }
    },
    noReopen,
  );

  add(
    `exactly one of ${workers} writers wins when they use separate provider instances over one storage`,
    async () => {
      const store = await fresh();
      const extras: BaseWorkflowCheckpointStore[] = [];
      try {
        const instances: BaseWorkflowCheckpointStore[] = [store];
        if (store.capabilities.multiProcess && reopenStore) {
          const second = await reopenStore(store);
          if (second !== store) {
            extras.push(second);
            instances.push(second);
          }
        }
        const base = await makeCheckpoint(LOCATOR, 1);
        await store.put({ checkpoint: base });
        const expectedRevision = await workflowCheckpointRevision(base);
        const candidates = await Promise.all(
          Array.from({ length: workers }, (_, i) =>
            makeCheckpoint(LOCATOR, 10 + i),
          ),
        );
        const results = await Promise.allSettled(
          candidates.map((checkpoint, i) =>
            (instances[i % instances.length] ?? store).put({
              checkpoint,
              expectedRevision,
            }),
          ),
        );
        checkEqual(
          results.filter((result) => result.status === "fulfilled").length,
          1,
          "the number of winning writers",
        );
      } finally {
        for (const extra of extras) await extra.close().catch(() => undefined);
        await store.close().catch(() => undefined);
        await options.destroyStore?.(store);
      }
    },
    noReopen ?? noAtomic,
  );

  // --- Health, close and metrics ------------------------------------------------

  add(
    "the health check resolves ok with the provider name and never throws",
    withStore(async (store) => {
      const health = await store.healthCheck();
      checkEqual(health.ok, true, "the health result");
      checkEqual(health.provider, store.providerName, "the health provider");
      check(
        typeof health.latencyMs === "number" && health.latencyMs >= 0,
        "the health latency is not a duration",
      );
    }),
  );

  add(
    "every operation rejects with WORKFLOW_STORAGE_CLOSED after close and closing twice does nothing",
    withStore(async (store) => {
      const checkpoint = await makeCheckpoint(LOCATOR);
      await store.close();
      await store.close();
      const lease = fakeLease(LOCATOR);
      const attempts: Array<[string, () => Promise<unknown>]> = [
        ["load", () => store.load({ ...LOCATOR, context: NO_CONTEXT })],
        ["save", () => store.save({ context: NO_CONTEXT, checkpoint })],
        ["get", () => store.get(LOCATOR)],
        ["put", () => store.put({ checkpoint })],
        ["list", () => store.list()],
        ["delete", () => store.delete(LOCATOR)],
        ["prune", () => store.prune({ updatedBefore: 1 })],
        [
          "acquireLease",
          () => store.acquireLease({ ...LOCATOR, ownerId: "a", ttlMs: 10 }),
        ],
        ["renewLease", () => store.renewLease(lease, 10)],
        ["releaseLease", () => store.releaseLease(lease)],
      ];
      for (const [name, attempt] of attempts) {
        check(
          hasCode(await rejection(attempt()), "WORKFLOW_STORAGE_CLOSED"),
          `${name} after close did not reject with WORKFLOW_STORAGE_CLOSED`,
        );
      }
      const health = await store.healthCheck();
      checkEqual(health.ok, false, "the health result after close");
    }),
  );

  add(
    "each operation reports one metric without ids, keys or payloads",
    withStore(async (store) => {
      const secrets = {
        workflowId: "wf-secret-workflow",
        executionId: "exec-secret-0042",
      };
      const secretText = "payload-secret-text-xyz";
      const metrics: WorkflowStorageOperationMetric[] = [];
      // The observer goes onto the provider's shared options, so the suite
      // needs no constructor option from the provider under test.
      Reflect.set(store, "baseOptions", {
        ...Reflect.get(store, "baseOptions"),
        onOperation: (metric: WorkflowStorageOperationMetric) => {
          metrics.push(metric);
        },
      });
      const expectOne = async (name: string, run: () => Promise<unknown>) => {
        const before = metrics.length;
        await run().catch(() => undefined);
        checkEqual(
          metrics.length - before,
          1,
          `the number of metrics of ${name}`,
        );
      };
      const checkpoint = withWorkflowCompleted(
        await makeCheckpoint(secrets, 1),
        secretText,
        2,
      );
      await expectOne("save", () =>
        store.save({ context: NO_CONTEXT, checkpoint }),
      );
      await expectOne("load", () =>
        store.load({ ...secrets, context: NO_CONTEXT }),
      );
      await expectOne("get", () => store.get(secrets));
      await expectOne("put", () => store.put({ checkpoint }));
      await expectOne("a conflicting put", () =>
        store.put({
          checkpoint: withWorkflowCompleted(checkpoint, secretText, 9),
          expectedRevision: null,
        }),
      );
      if (store.capabilities.listing)
        await expectOne("list", () => store.list());
      if (store.capabilities.leases) {
        let lease: WorkflowCheckpointLease | undefined;
        await expectOne("acquireLease", async () => {
          lease = await store.acquireLease({
            ...secrets,
            ownerId: "owner-secret",
            ttlMs: 60_000,
          });
        });
        if (lease) {
          const held = lease;
          await expectOne("renewLease", () => store.renewLease(held, 60_000));
          await expectOne("releaseLease", () => store.releaseLease(held));
        }
      }
      if (store.capabilities.pruning) {
        await expectOne("prune", () => store.prune({ updatedBefore: 1 }));
        await expectOne("delete", () => store.delete(secrets));
      }
      for (const metric of metrics) {
        checkEqual(metric.capability, "checkpoints", "the metric capability");
        checkEqual(metric.provider, store.providerName, "the metric provider");
        check(metric.durationMs >= 0, "a metric has a negative duration");
      }
      check(
        metrics.some((metric) => metric.outcome === "conflict"),
        "the conflicting put was not reported as a conflict",
      );
      const dump = JSON.stringify(metrics);
      for (const secret of [
        secrets.workflowId,
        secrets.executionId,
        secretText,
        "owner-secret",
        workflowCheckpointKey(secrets.workflowId, secrets.executionId),
      ]) {
        check(
          !dump.includes(secret),
          "a metric carries an id, a key or payload text",
        );
      }
    }),
  );

  return cases;
}

const LOCATOR: WorkflowCheckpointLocator = {
  workflowId: "wf",
  executionId: "exec-1",
};

const NO_CONTEXT = {} as never;

const definitions = new Map<string, ReturnType<typeof defineWorkflow>>();

async function makeCheckpoint(
  locator: WorkflowCheckpointLocator,
  now = 1,
): Promise<WorkflowCheckpointV1> {
  let definition = definitions.get(locator.workflowId);
  if (!definition) {
    definition = defineWorkflow({
      id: locator.workflowId,
      version: "1",
      handler: () => "done",
    });
    definitions.set(locator.workflowId, definition);
  }
  return await createWorkflowCheckpoint({
    definition,
    executionId: locator.executionId,
    input: "input",
    now,
  });
}

function digests(count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    i.toString(16).padStart(12, "0"),
  );
}

function completedStep(
  id: string,
  result: Record<string, unknown> = {},
): WorkflowCheckpointV1["steps"][string] {
  return {
    id,
    agentName: "agent",
    inputHash: `sha256:${"a".repeat(64)}`,
    status: "completed",
    attempts: 1,
    startedAt: 1,
    updatedAt: 2,
    completedAt: 2,
    result: {
      status: "completed",
      id,
      agentName: "agent",
      output: "out",
      attempts: 1,
      startedAt: 1,
      completedAt: 2,
      ...result,
    },
  } as WorkflowCheckpointV1["steps"][string];
}

function withSteps(
  base: WorkflowCheckpointV1,
  steps: Record<string, WorkflowCheckpointV1["steps"][string]>,
): WorkflowCheckpointV1 {
  return { ...base, steps };
}

function mergeStep(
  step: WorkflowCheckpointV1["steps"][string],
  patch: Record<string, unknown>,
): WorkflowCheckpointV1["steps"][string] {
  const { result, ...rest } = patch;
  return {
    ...step,
    ...rest,
    ...(result === undefined
      ? {}
      : { result: { ...step.result, ...(result as object) } }),
  } as WorkflowCheckpointV1["steps"][string];
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new WorkflowStorageConformanceFailure(message);
}

function checkEqual(actual: unknown, expected: unknown, what: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new WorkflowStorageConformanceFailure(
      `${what} was ${JSON.stringify(actual)?.slice(0, 200)}, expected ${JSON.stringify(expected)?.slice(0, 200)}`,
    );
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new WorkflowStorageConformanceFailure(
    "the operation resolved, but it should have rejected",
  );
}

function hasCode(error: unknown, code: string): boolean {
  return (error as { code?: unknown } | null)?.code === code;
}

function isConflict(error: unknown): boolean {
  return (
    (error as { conflict?: { reason?: unknown } } | null)?.conflict?.reason ===
    "checkpoint_revision_conflict"
  );
}

function reasonOf(error: unknown): unknown {
  return (error as { details?: { reason?: unknown } } | null)?.details?.reason;
}

function fakeLease(
  locator: WorkflowCheckpointLocator,
): WorkflowCheckpointLease {
  return { ...locator, ownerId: "a", fencingToken: 1, expiresAt: 1 };
}

/** Takes a lease once the previous one expired, polling until it does. */
async function acquireAfterExpiry(
  store: BaseWorkflowCheckpointStore,
  locator: WorkflowCheckpointLocator,
  ownerId: string,
): Promise<WorkflowCheckpointLease> {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      return await store.acquireLease({ ...locator, ownerId, ttlMs: 60_000 });
    } catch (error) {
      if (
        !hasCode(error, "WORKFLOW_STORAGE_LEASE_HELD") ||
        Date.now() > deadline
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

/**
 * A provider that reads through `inner` but changes what it returns, to
 * prove that a stored value which is not what its revision names never
 * reaches the caller.
 */
function tamperedView(
  inner: BaseWorkflowCheckpointStore,
  tamper: (stored: StoredWorkflowCheckpoint) => StoredWorkflowCheckpoint,
): BaseWorkflowCheckpointStore {
  class TamperedView extends BaseWorkflowCheckpointStore {
    readonly providerName = inner.providerName;
    readonly capabilities: WorkflowCheckpointStoreCapabilities =
      inner.capabilities;

    protected async readCheckpoint(
      locator: WorkflowCheckpointLocator,
    ): Promise<StoredWorkflowCheckpoint | undefined> {
      const read = Reflect.get(inner, "readCheckpoint") as (
        locator: WorkflowCheckpointLocator,
      ) => Promise<StoredWorkflowCheckpoint | undefined>;
      const stored = await read.call(inner, locator);
      return stored === undefined ? undefined : tamper(stored);
    }

    protected async writeCheckpoint(): Promise<number> {
      throw new WorkflowStorageConformanceFailure(
        "the tampered view must not write",
      );
    }
  }
  return new TamperedView();
}
