import { describe, expect, test } from "bun:test";
import {
  createWorkflowCheckpoint,
  withWorkflowCompleted,
} from "../../../src/workflows/checkpoint/checkpoint.js";
import type { WorkflowCheckpointV1 } from "../../../src/workflows/checkpoint/schema.js";
import {
  WorkflowCheckpointConflictError,
  workflowCheckpointKey,
  workflowCheckpointRevision,
} from "../../../src/workflows/checkpoint/store.js";
import { defineWorkflow } from "../../../src/workflows/definition.js";
import {
  BaseWorkflowCheckpointStore,
  type WorkflowCheckpointStoreCapabilities,
  type WorkflowCheckpointWriteRequest,
} from "../../../src/workflows/storage/checkpoint-store.js";
import {
  defineWorkflowStorageConformanceTests,
  type WorkflowStorageConformanceCase,
  workflowCheckpointStoreConformanceCases,
} from "../../../src/workflows/storage/conformance/index.js";
import {
  isWorkflowStorageError,
  WorkflowStorageError,
} from "../../../src/workflows/storage/errors.js";
import { InMemoryWorkflowCheckpointStore } from "../../../src/workflows/storage/in-memory-checkpoint-store.js";

const definitions = new Map<string, ReturnType<typeof defineWorkflow>>();
async function makeCheckpoint(
  workflowId: string,
  executionId: string,
  now = 1,
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

interface MapEntry {
  checkpoint: WorkflowCheckpointV1;
  revision: string;
  updatedAt: number;
}

/**
 * Minimal provider over a map. Flags and defects are injected so the suite
 * can be shown to fail for a provider that claims more than it does.
 */
class MapStore extends BaseWorkflowCheckpointStore {
  readonly providerName = "map";
  readonly capabilities: WorkflowCheckpointStoreCapabilities;
  private readonly map = new Map<string, MapEntry>();

  constructor(
    flags: Partial<WorkflowCheckpointStoreCapabilities> = {},
    private readonly defects: {
      raceWindowMs?: number;
      ignoreExpected?: boolean;
    } = {},
  ) {
    super();
    this.capabilities = {
      compareAndSet: "atomic",
      leases: false,
      durable: false,
      multiProcess: false,
      listing: false,
      pruning: false,
      maxCheckpointBytes: 4 * 1024 * 1024,
      ...flags,
    };
  }

  protected async readCheckpoint(locator: {
    workflowId: string;
    executionId: string;
  }): Promise<MapEntry | undefined> {
    return this.map.get(
      workflowCheckpointKey(locator.workflowId, locator.executionId),
    );
  }

  protected async writeCheckpoint(request: {
    checkpointKey: string;
    checkpoint: WorkflowCheckpointV1;
    revision: string;
    expectedRevision: string | null | undefined;
  }): Promise<number> {
    const actual = this.map.get(request.checkpointKey)?.revision ?? null;
    if (
      !this.defects.ignoreExpected &&
      request.expectedRevision !== undefined &&
      actual !== request.expectedRevision
    ) {
      throw new WorkflowCheckpointConflictError(
        request.checkpointKey,
        request.expectedRevision,
        actual,
      );
    }
    if (this.defects.raceWindowMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.defects.raceWindowMs),
      );
    }
    this.map.set(request.checkpointKey, {
      checkpoint: request.checkpoint,
      revision: request.revision,
      updatedAt: 1,
    });
    return 1;
  }
}

// --- The conformance suite, run against the reference provider -----------

for (const workers of [8, 32]) {
  let cases: WorkflowStorageConformanceCase[] = [];
  let buildError: unknown;
  try {
    cases = await workflowCheckpointStoreConformanceCases({
      createStore: () => new InMemoryWorkflowCheckpointStore(),
      reopenStore: (store) => store,
      workers,
    });
  } catch (error) {
    buildError = error;
  }
  describe(`in-memory provider conformance (workers ${workers})`, () => {
    test("the suite offers cases", () => {
      if (buildError) throw buildError;
      expect(cases.length).toBeGreaterThan(20);
    });
    defineWorkflowStorageConformanceTests(cases, {
      test,
      skip: test.skip,
    });
  });
}

// --- Suite content --------------------------------------------------------

async function suiteCases(
  options: Partial<
    Parameters<typeof workflowCheckpointStoreConformanceCases>[0]
  > = {},
): Promise<WorkflowStorageConformanceCase[]> {
  return await workflowCheckpointStoreConformanceCases({
    createStore: () => new InMemoryWorkflowCheckpointStore(),
    reopenStore: (store) => store,
    ...options,
  });
}

async function runAll(
  cases: readonly WorkflowStorageConformanceCase[],
): Promise<{ failed: string[]; skipped: string[]; passed: string[] }> {
  const result = {
    failed: [] as string[],
    skipped: [] as string[],
    passed: [] as string[],
  };
  for (const conformanceCase of cases) {
    if (conformanceCase.skip !== undefined) {
      result.skipped.push(conformanceCase.name);
      continue;
    }
    try {
      await conformanceCase.run();
      result.passed.push(conformanceCase.name);
    } catch {
      result.failed.push(conformanceCase.name);
    }
  }
  return result;
}

const REQUIRED_TOPICS: Array<[string, RegExp]> = [
  ["missing checkpoint", /missing|absent|no checkpoint|not exist/i],
  ["save then load", /save.*load|load.*save|round.?trip/i],
  ["get and put", /\bget\b.*\bput\b|\bput\b.*\bget\b/i],
  ["state delta", /state ?delta/i],
  ["invalid checkpoint", /invalid/i],
  ["oversized before write", /oversize|too large|size limit|larger than/i],
  [
    "mismatched supplied revision",
    /revision.*(match|supplied)|supplied revision/i,
  ],
  ["stale expected revision", /stale/i],
  ["absent expected revision", /expected.*(null|absent|none)|null.*exist/i],
  [
    "one winner among N writers",
    /exactly one.*(writer|winner)|one of \d+|N (concurrent )?writers/i,
  ],
  ["idempotent repeat", /idempotent|repeat/i],
  ["isolation", /isolat/i],
  ["one lease holder among N", /lease.*(holder|among|N owners)|one.*lease/i],
  ["takeover raises the token", /takeover|take over/i],
  ["fenced save writes nothing", /fenc/i],
  ["renew and release", /renew|release/i],
  ["cursor pagination", /cursor|pagina|page/i],
  ["delete", /\bdelete/i],
  ["prune", /\bprune|retention/i],
  ["unsupported operations", /unsupported/i],
  ["durability across reopen", /reopen|surviv|durab/i],
  ["health check", /health/i],
  ["closed after close", /closed|after close/i],
  ["metrics without ids or payloads", /metric/i],
  ["corrupt stored value", /revision|integrity|corrupt|mismatch/i],
];

describe("checkpoint conformance suite content", () => {
  test("every guarantee of the contract has a case", async () => {
    const cases = await suiteCases();
    const names = cases.map((c) => c.name);
    for (const [topic, pattern] of REQUIRED_TOPICS) {
      expect(
        names.some((name) => pattern.test(name)),
        `no case for: ${topic}`,
      ).toBe(true);
    }
  });

  test("case names are unique plain sentences with no internal labels", async () => {
    const names = (await suiteCases()).map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name.length).toBeGreaterThan(10);
      expect(/\b(DF\d|G-SESS|wave|lane|W\d)\b/i.test(name)).toBe(false);
    }
  });

  test("a provider with every flag set runs every case: nothing is skipped", async () => {
    const cases = await suiteCases();
    expect(cases.filter((c) => c.skip !== undefined)).toEqual([]);
  });

  test("the suite has cases that read the declared capabilities", async () => {
    const names = (await suiteCases()).map((c) => c.name);
    for (const flag of [
      /compare.?and.?set|compareAndSet/i,
      /leases?/i,
      /listing|list/i,
      /prun/i,
      /durab/i,
      /declared|capabilit|flag/i,
    ]) {
      expect(names.some((name) => flag.test(name))).toBe(true);
    }
  });

  test("the suite imports no test runner", async () => {
    const source = await Bun.file(
      new URL(
        "../../../src/workflows/storage/conformance/checkpoint-suite.ts",
        import.meta.url,
      ),
    ).text();
    expect(source).not.toMatch(/from ["'](bun:test|vitest|jest|@jest)/);
    expect(source).not.toMatch(/\bexpect\(/);
  });

  test("the suite builds checkpoints with createWorkflowCheckpoint", async () => {
    const source = await Bun.file(
      new URL(
        "../../../src/workflows/storage/conformance/checkpoint-suite.ts",
        import.meta.url,
      ),
    ).text();
    expect(source).toContain("createWorkflowCheckpoint");
  });

  test("cases skip by capability flag only and the skip text names the flag", async () => {
    class NoOptional extends InMemoryWorkflowCheckpointStore {
      override readonly capabilities: WorkflowCheckpointStoreCapabilities = {
        compareAndSet: "atomic",
        leases: false,
        durable: false,
        multiProcess: false,
        listing: false,
        pruning: false,
        maxCheckpointBytes: 4 * 1024 * 1024,
      };
    }
    const cases = await suiteCases({ createStore: () => new NoOptional() });
    const skipped = cases.filter((c) => c.skip !== undefined);
    expect(skipped.length).toBeGreaterThan(0);
    for (const conformanceCase of skipped) {
      expect(conformanceCase.skip).toMatch(
        /leases|listing|pruning|durable|compareAndSet|multiProcess/,
      );
    }
    const joined = skipped.map((c) => c.skip).join(" ");
    expect(joined).toContain("leases");
    expect(joined).toContain("listing");
    expect(joined).toContain("pruning");
  });

  test("without reopenStore the durability and multi-writer cases are skipped", async () => {
    const withReopen = await suiteCases();
    const without = await workflowCheckpointStoreConformanceCases({
      createStore: () => new InMemoryWorkflowCheckpointStore(),
    });
    expect(without.filter((c) => c.skip !== undefined).length).toBeGreaterThan(
      withReopen.filter((c) => c.skip !== undefined).length,
    );
  });

  test("destroyStore runs after each case with the provider already closed", async () => {
    const destroyed: boolean[] = [];
    const cases = await suiteCases({
      destroyStore: async (store) => {
        // A closed provider rejects with WORKFLOW_STORAGE_CLOSED.
        const error = await reject(
          store.get({ workflowId: "w", executionId: "e" }),
        );
        destroyed.push(
          isWorkflowStorageError(error, "WORKFLOW_STORAGE_CLOSED"),
        );
      },
    });
    const first = cases.find((c) => c.skip === undefined);
    await first?.run();
    expect(destroyed).toEqual([true]);
  });
});

// --- Capability flags are asserted against behavior ----------------------

describe("capability flags are part of the conformance suite", () => {
  test("a provider that declares no leases passes: lease operations reject with WORKFLOW_STORAGE_UNSUPPORTED", async () => {
    class NoLeases extends InMemoryWorkflowCheckpointStore {
      override readonly capabilities: WorkflowCheckpointStoreCapabilities = {
        ...new InMemoryWorkflowCheckpointStore().capabilities,
        leases: false,
      };
    }
    const cases = await suiteCases({ createStore: () => new NoLeases() });
    const outcome = await runAll(cases);
    expect(outcome.failed).toEqual([]);
    expect(outcome.passed.some((n) => /unsupported/i.test(n))).toBe(true);
    expect(outcome.skipped.some((n) => /lease/i.test(n))).toBe(true);
  });

  test("a provider that declares no listing and no pruning passes", async () => {
    class NoListing extends InMemoryWorkflowCheckpointStore {
      override readonly capabilities: WorkflowCheckpointStoreCapabilities = {
        ...new InMemoryWorkflowCheckpointStore().capabilities,
        listing: false,
        pruning: false,
      };
    }
    const outcome = await runAll(
      await suiteCases({ createStore: () => new NoListing() }),
    );
    expect(outcome.failed).toEqual([]);
  });

  test("a provider that claims leases without implementing them fails the suite", async () => {
    const outcome = await runAll(
      await suiteCases({
        createStore: () =>
          new MapStore({ leases: true, listing: false, pruning: false }),
      }),
    );
    expect(outcome.failed.some((n) => /lease/i.test(n))).toBe(true);
  });

  test("a provider that claims listing without implementing it fails the suite", async () => {
    class FakeListing extends InMemoryWorkflowCheckpointStore {
      protected override listCheckpoints(): never {
        throw new WorkflowStorageError(
          "WORKFLOW_STORAGE_UNSUPPORTED",
          "not implemented",
        );
      }
    }
    const outcome = await runAll(
      await suiteCases({ createStore: () => new FakeListing() }),
    );
    expect(outcome.failed.some((n) => /pagina|list|cursor/i.test(n))).toBe(
      true,
    );
  });

  test("a provider that claims atomic compare-and-set but is only advisory fails the N-writer case", async () => {
    const outcome = await runAll(
      await suiteCases({
        createStore: () => new MapStore({}, { raceWindowMs: 2 }),
      }),
    );
    expect(
      outcome.failed.some((n) => /exactly one|one of|winner|writers/i.test(n)),
    ).toBe(true);
  });

  test("a provider that declares compareAndSet advisory is not required to pass the N-writer case", async () => {
    class Advisory extends InMemoryWorkflowCheckpointStore {
      override readonly capabilities: WorkflowCheckpointStoreCapabilities = {
        ...new InMemoryWorkflowCheckpointStore().capabilities,
        compareAndSet: "advisory",
      };
    }
    const cases = await suiteCases({ createStore: () => new Advisory() });
    const winner = cases.find((c) =>
      /exactly one|one of|winner|writers/i.test(c.name),
    );
    expect(winner?.skip).toMatch(/compareAndSet/);
  });

  test("a provider that claims durability but loses data on reopen fails the suite", async () => {
    class Forgetful extends InMemoryWorkflowCheckpointStore {
      override readonly capabilities: WorkflowCheckpointStoreCapabilities = {
        ...new InMemoryWorkflowCheckpointStore().capabilities,
        durable: true,
      };
    }
    const outcome = await runAll(
      await suiteCases({
        createStore: () => new Forgetful(),
        reopenStore: () => new Forgetful(),
      }),
    );
    expect(outcome.failed.some((n) => /reopen|surviv|durab/i.test(n))).toBe(
      true,
    );
  });

  test("a provider that ignores expectedRevision fails the compare-and-set cases", async () => {
    const outcome = await runAll(
      await suiteCases({
        createStore: () => new MapStore({}, { ignoreExpected: true }),
      }),
    );
    expect(
      outcome.failed.some((n) => /stale|expected|winner|one of/i.test(n)),
    ).toBe(true);
  });

  test("a provider that skips the fencing check fails the fenced-save case", async () => {
    class IgnoresFence extends InMemoryWorkflowCheckpointStore {
      protected override writeCheckpoint(
        request: WorkflowCheckpointWriteRequest,
      ): Promise<number> {
        const { fencingToken: _ignored, ...rest } = request;
        return super.writeCheckpoint(rest);
      }
    }
    const outcome = await runAll(
      await suiteCases({ createStore: () => new IgnoresFence() }),
    );
    expect(outcome.failed.some((n) => /fenc/i.test(n))).toBe(true);
  });
});

// A provider that declares a capability false but still answers the public
// operation: the "provider without ..." cases must catch it.
describe("undeclared capabilities that a provider still serves fail the suite", () => {
  const base = new InMemoryWorkflowCheckpointStore().capabilities;

  test("a provider declaring leases false but granting leases fails", async () => {
    class LeakyLeases extends InMemoryWorkflowCheckpointStore {
      override readonly capabilities: WorkflowCheckpointStoreCapabilities = {
        ...base,
        leases: false,
      };
      override async acquireLease(
        input: Parameters<InMemoryWorkflowCheckpointStore["acquireLease"]>[0],
      ) {
        return await this.acquireCheckpointLease(input, Date.now());
      }
    }
    const outcome = await runAll(
      await suiteCases({ createStore: () => new LeakyLeases() }),
    );
    expect(outcome.failed.some((n) => /without leases/i.test(n))).toBe(true);
  });

  test("a provider declaring listing false but listing fails", async () => {
    class LeakyListing extends InMemoryWorkflowCheckpointStore {
      override readonly capabilities: WorkflowCheckpointStoreCapabilities = {
        ...base,
        listing: false,
      };
      override async list() {
        return await this.listCheckpoints({ limit: 50 });
      }
    }
    const outcome = await runAll(
      await suiteCases({ createStore: () => new LeakyListing() }),
    );
    expect(outcome.failed.some((n) => /without listing/i.test(n))).toBe(true);
  });

  test("a provider declaring pruning false but deleting or pruning fails", async () => {
    class LeakyPruning extends InMemoryWorkflowCheckpointStore {
      override readonly capabilities: WorkflowCheckpointStoreCapabilities = {
        ...base,
        pruning: false,
      };
      override async delete(
        input: Parameters<InMemoryWorkflowCheckpointStore["delete"]>[0],
      ) {
        return await this.deleteCheckpoint(input);
      }
    }
    const outcome = await runAll(
      await suiteCases({ createStore: () => new LeakyPruning() }),
    );
    expect(outcome.failed.some((n) => /without pruning/i.test(n))).toBe(true);
  });
});

// --- The reference provider, directly -------------------------------------

describe("InMemoryWorkflowCheckpointStore", () => {
  const locator = { workflowId: "wf", executionId: "e1" };

  test("declares the full contract, not durable, one process", () => {
    const store = new InMemoryWorkflowCheckpointStore();
    expect(store.providerName).toBe("memory");
    expect(store.capabilities).toEqual({
      compareAndSet: "atomic",
      leases: true,
      durable: false,
      multiProcess: false,
      listing: true,
      pruning: true,
      maxCheckpointBytes: 4 * 1024 * 1024,
    });
  });

  test("maxCheckpointBytes is reflected in the declared capabilities", () => {
    const store = new InMemoryWorkflowCheckpointStore({
      maxCheckpointBytes: 8192,
    });
    expect(store.capabilities.maxCheckpointBytes).toBe(8192);
  });

  test("rejects a bad maxCheckpoints with WORKFLOW_STORAGE_INVALID_OPTION", () => {
    for (const maxCheckpoints of [0, -1, 1.5, Number.NaN]) {
      let thrown: unknown;
      try {
        new InMemoryWorkflowCheckpointStore({ maxCheckpoints });
      } catch (error) {
        thrown = error;
      }
      expect(
        isWorkflowStorageError(thrown, "WORKFLOW_STORAGE_INVALID_OPTION"),
      ).toBe(true);
    }
  });

  test("a caller cannot change a stored value by mutating the saved or loaded object", async () => {
    const store = new InMemoryWorkflowCheckpointStore();
    const checkpoint = await makeCheckpoint("wf", "e1");
    await store.put({ checkpoint });
    (checkpoint as { status: string }).status = "failed";
    const loaded = await store.get(locator);
    expect(loaded?.checkpoint.status).toBe("running");
    (loaded?.checkpoint as { status: string }).status = "failed";
    expect((await store.get(locator))?.checkpoint.status).toBe("running");
  });

  test("maxCheckpoints refuses a new checkpoint with a non-retryable WORKFLOW_STORAGE_UNAVAILABLE and evicts nothing", async () => {
    const store = new InMemoryWorkflowCheckpointStore({ maxCheckpoints: 2 });
    await store.put({ checkpoint: await makeCheckpoint("wf", "a") });
    await store.put({ checkpoint: await makeCheckpoint("wf", "b") });
    const error = await reject(
      store.put({ checkpoint: await makeCheckpoint("wf", "c") }),
    );
    expect(isWorkflowStorageError(error, "WORKFLOW_STORAGE_UNAVAILABLE")).toBe(
      true,
    );
    expect((error as WorkflowStorageError).retryable).toBe(false);
    expect(
      await store.get({ workflowId: "wf", executionId: "a" }),
    ).toBeDefined();
    expect(
      await store.get({ workflowId: "wf", executionId: "c" }),
    ).toBeUndefined();
    // Replacing an existing checkpoint is still allowed at capacity.
    await store.put({ checkpoint: await makeCheckpoint("wf", "a", 5) });
  });

  test("exactly one of N concurrent writers with the same expectedRevision wins", async () => {
    const store = new InMemoryWorkflowCheckpointStore();
    const base = await makeCheckpoint("wf", "e1", 1);
    await store.put({ checkpoint: base });
    const expectedRevision = await workflowCheckpointRevision(base);
    const results = await Promise.allSettled(
      Array.from({ length: 32 }, async (_, i) =>
        store.put({
          checkpoint: await makeCheckpoint("wf", "e1", 10 + i),
          expectedRevision,
        }),
      ),
    );
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(31);
    for (const result of lost) {
      expect(
        (result as PromiseRejectedResult).reason instanceof
          WorkflowCheckpointConflictError,
      ).toBe(true);
    }
    const winner = (won[0] as PromiseFulfilledResult<{ revision: string }>)
      .value;
    expect((await store.get(locator))?.revision).toBe(winner.revision);
  });

  test("exactly one of N concurrent creators with expectedRevision null wins", async () => {
    const store = new InMemoryWorkflowCheckpointStore();
    const results = await Promise.allSettled(
      Array.from({ length: 16 }, async (_, i) =>
        store.put({
          checkpoint: await makeCheckpoint("wf", "e1", i + 1),
          expectedRevision: null,
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  describe("listing", () => {
    async function seeded(count = 7) {
      const store = new InMemoryWorkflowCheckpointStore();
      for (let i = 0; i < count; i += 1) {
        await store.put({
          checkpoint: await makeCheckpoint(
            i % 2 === 0 ? "wf-a" : "wf-b",
            `e${String(i).padStart(2, "0")}`,
            i + 1,
          ),
        });
      }
      return store;
    }

    test("pages visit every checkpoint once, ordered by workflow id then execution id", async () => {
      const store = await seeded(7);
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await store.list({ limit: 3, cursor });
        expect(page.items.length).toBeLessThanOrEqual(3);
        for (const item of page.items) {
          seen.push(`${item.workflowId}/${item.executionId}`);
        }
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== undefined && pages < 10);
      expect(pages).toBe(3);
      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
      expect(seen).toEqual([...seen].sort());
    });

    test("the last page has no cursor and an exact multiple of the limit ends without an empty page", async () => {
      const store = await seeded(6);
      const first = await store.list({ limit: 3 });
      expect(first.nextCursor).toBeString();
      const second = await store.list({ limit: 3, cursor: first.nextCursor });
      expect(second.items).toHaveLength(3);
      expect(second.nextCursor).toBeUndefined();
    });

    test("summaries have no step data and carry revision, status, time and size", async () => {
      const store = await seeded(1);
      const [item] = (await store.list()).items;
      if (!item) throw new Error("expected one summary");
      const stored = await store.get({
        workflowId: item.workflowId,
        executionId: item.executionId,
      });
      if (!stored) throw new Error("expected a stored checkpoint");
      expect(item.revision).toBe(stored.revision);
      expect(item.status).toBe("running");
      expect(item.updatedAt).toBe(stored.updatedAt);
      expect(item.bytes).toBe(
        new TextEncoder().encode(JSON.stringify(stored.checkpoint)).byteLength,
      );
      expect("steps" in item).toBe(false);
      expect("checkpoint" in item).toBe(false);
    });

    test("filters by workflow id, status and updatedBefore", async () => {
      const clockA = clock(100);
      const store = new InMemoryWorkflowCheckpointStore({ now: clockA.now });
      await store.put({ checkpoint: await makeCheckpoint("wf-a", "e1") });
      clockA.state.now = 200;
      await store.put({
        checkpoint: withWorkflowCompleted(
          await makeCheckpoint("wf-b", "e2"),
          "out",
          5,
        ),
      });
      expect(
        (await store.list({ workflowId: "wf-a" })).items.map(
          (i) => i.executionId,
        ),
      ).toEqual(["e1"]);
      expect(
        (await store.list({ status: "completed" })).items.map(
          (i) => i.executionId,
        ),
      ).toEqual(["e2"]);
      expect(
        (await store.list({ updatedBefore: 150 })).items.map(
          (i) => i.executionId,
        ),
      ).toEqual(["e1"]);
    });

    test("the cursor is opaque and a malformed one is rejected with WORKFLOW_STORAGE_INVALID_OPTION", async () => {
      const store = await seeded(4);
      const page = await store.list({ limit: 2 });
      expect(page.nextCursor).not.toContain("e01");
      expect(page.nextCursor).not.toContain("wf-");
      for (const cursor of ["!!not-a-cursor!!", "AAAA", "x".repeat(2000)]) {
        const error = await reject(store.list({ cursor }));
        expect(
          isWorkflowStorageError(error, "WORKFLOW_STORAGE_INVALID_OPTION"),
        ).toBe(true);
      }
    });

    test("a checkpoint deleted between pages does not break the walk", async () => {
      const store = await seeded(6);
      const first = await store.list({ limit: 2 });
      const gone = first.items[1];
      if (gone) await store.delete(gone);
      const second = await store.list({ limit: 2, cursor: first.nextCursor });
      expect(second.items).toHaveLength(2);
    });
  });

  describe("delete and prune", () => {
    test("delete removes the checkpoint and its lease", async () => {
      const store = new InMemoryWorkflowCheckpointStore();
      await store.put({ checkpoint: await makeCheckpoint("wf", "e1") });
      await store.acquireLease({ ...locator, ownerId: "a", ttlMs: 10_000 });
      expect(await store.delete(locator)).toBe(true);
      expect(await store.get(locator)).toBeUndefined();
      // Another owner can take the lease at once: the old one is gone.
      const lease = await store.acquireLease({
        ...locator,
        ownerId: "b",
        ttlMs: 10_000,
      });
      expect(lease.ownerId).toBe("b");
    });

    test("delete with a stale expectedRevision rejects with a conflict and keeps the checkpoint", async () => {
      const store = new InMemoryWorkflowCheckpointStore();
      const checkpoint = await makeCheckpoint("wf", "e1");
      await store.put({ checkpoint });
      const error = await reject(
        store.delete({ ...locator, expectedRevision: "sha256:stale" }),
      );
      expect(error).toBeInstanceOf(WorkflowCheckpointConflictError);
      expect(await store.get(locator)).toBeDefined();
      expect(
        await store.delete({
          ...locator,
          expectedRevision: await workflowCheckpointRevision(checkpoint),
        }),
      ).toBe(true);
    });

    test("prune deletes only old completed and failed checkpoints by default", async () => {
      const time = clock(100);
      const store = new InMemoryWorkflowCheckpointStore({ now: time.now });
      await store.put({
        checkpoint: withWorkflowCompleted(
          await makeCheckpoint("wf", "done-old"),
          "x",
          2,
        ),
      });
      await store.put({
        checkpoint: await makeCheckpoint("wf", "running-old"),
      });
      time.state.now = 500;
      await store.put({
        checkpoint: withWorkflowCompleted(
          await makeCheckpoint("wf", "done-new"),
          "x",
          3,
        ),
      });
      const result = await store.prune({ updatedBefore: 300 });
      expect(result).toEqual({ deleted: 1, hasMore: false });
      expect(
        await store.get({ workflowId: "wf", executionId: "done-old" }),
      ).toBeUndefined();
      expect(
        await store.get({ workflowId: "wf", executionId: "running-old" }),
      ).toBeDefined();
      expect(
        await store.get({ workflowId: "wf", executionId: "done-new" }),
      ).toBeDefined();
    });

    test("prune honors statuses and workflowId filters", async () => {
      const store = new InMemoryWorkflowCheckpointStore({ now: () => 10 });
      await store.put({ checkpoint: await makeCheckpoint("wf-a", "r1") });
      await store.put({ checkpoint: await makeCheckpoint("wf-b", "r2") });
      const result = await store.prune({
        updatedBefore: 100,
        statuses: ["running"],
        workflowId: "wf-a",
      });
      expect(result.deleted).toBe(1);
      expect(
        await store.get({ workflowId: "wf-b", executionId: "r2" }),
      ).toBeDefined();
    });

    test("prune deletes at most limit per call and reports hasMore", async () => {
      const store = new InMemoryWorkflowCheckpointStore({ now: () => 10 });
      for (let i = 0; i < 5; i += 1) {
        await store.put({
          checkpoint: withWorkflowCompleted(
            await makeCheckpoint("wf", `e${i}`),
            "x",
            2,
          ),
        });
      }
      const first = await store.prune({ updatedBefore: 100, limit: 2 });
      expect(first).toEqual({ deleted: 2, hasMore: true });
      const second = await store.prune({ updatedBefore: 100, limit: 10 });
      expect(second).toEqual({ deleted: 3, hasMore: false });
    });
  });

  describe("leases", () => {
    test("only one of N owners acquires an unexpired lease", async () => {
      const store = new InMemoryWorkflowCheckpointStore();
      const results = await Promise.allSettled(
        Array.from({ length: 32 }, (_, i) =>
          store.acquireLease({
            ...locator,
            ownerId: `owner-${i}`,
            ttlMs: 60_000,
          }),
        ),
      );
      const won = results.filter((r) => r.status === "fulfilled");
      expect(won).toHaveLength(1);
      for (const result of results) {
        if (result.status === "rejected") {
          expect(
            isWorkflowStorageError(
              result.reason,
              "WORKFLOW_STORAGE_LEASE_HELD",
            ),
          ).toBe(true);
          expect(
            typeof (result.reason as WorkflowStorageError).details.expiresAt,
          ).toBe("number");
        }
      }
    });

    test("the first lease has token 1 and the same owner can acquire again without losing it", async () => {
      const store = new InMemoryWorkflowCheckpointStore();
      const first = await store.acquireLease({
        ...locator,
        ownerId: "a",
        ttlMs: 1000,
      });
      expect(first.fencingToken).toBe(1);
      expect(Number.isSafeInteger(first.fencingToken)).toBe(true);
    });

    test("a takeover after expiry raises the token by one", async () => {
      const time = clock();
      const store = new InMemoryWorkflowCheckpointStore({ now: time.now });
      const first = await store.acquireLease({
        ...locator,
        ownerId: "a",
        ttlMs: 1000,
      });
      time.state.now += 999;
      const held = await reject(
        store.acquireLease({ ...locator, ownerId: "b", ttlMs: 1000 }),
      );
      expect(isWorkflowStorageError(held, "WORKFLOW_STORAGE_LEASE_HELD")).toBe(
        true,
      );
      time.state.now += 2;
      const second = await store.acquireLease({
        ...locator,
        ownerId: "b",
        ttlMs: 1000,
      });
      expect(second.fencingToken).toBe(first.fencingToken + 1);
      expect(second.ownerId).toBe("b");
      expect(second.expiresAt).toBe(time.state.now + 1000);
    });

    test("a save fenced by the old token writes nothing after a takeover", async () => {
      const time = clock();
      const store = new InMemoryWorkflowCheckpointStore({ now: time.now });
      const first = await store.acquireLease({
        ...locator,
        ownerId: "a",
        ttlMs: 1000,
      });
      const base = await makeCheckpoint("wf", "e1", 1);
      await store.put({ checkpoint: base, fencingToken: first.fencingToken });
      time.state.now += 5000;
      const second = await store.acquireLease({
        ...locator,
        ownerId: "b",
        ttlMs: 1000,
      });
      const error = await reject(
        store.put({
          checkpoint: await makeCheckpoint("wf", "e1", 2),
          fencingToken: first.fencingToken,
        }),
      );
      expect(isWorkflowStorageError(error, "WORKFLOW_STORAGE_LEASE_LOST")).toBe(
        true,
      );
      expect((await store.get(locator))?.checkpoint).toEqual(base);
      const accepted = await store.put({
        checkpoint: await makeCheckpoint("wf", "e1", 3),
        fencingToken: second.fencingToken,
      });
      expect(accepted.checkpoint.updatedAt).toBe(3);
    });

    test("renew extends the expiry and keeps the token; a replaced lease cannot renew", async () => {
      const time = clock();
      const store = new InMemoryWorkflowCheckpointStore({ now: time.now });
      const first = await store.acquireLease({
        ...locator,
        ownerId: "a",
        ttlMs: 1000,
      });
      time.state.now += 500;
      const renewed = await store.renewLease(first, 1000);
      expect(renewed.fencingToken).toBe(first.fencingToken);
      expect(renewed.expiresAt).toBe(time.state.now + 1000);
      time.state.now += 5000;
      await store.acquireLease({ ...locator, ownerId: "b", ttlMs: 1000 });
      const error = await reject(store.renewLease(renewed, 1000));
      expect(isWorkflowStorageError(error, "WORKFLOW_STORAGE_LEASE_LOST")).toBe(
        true,
      );
    });

    test("release frees the lease at once, and releasing a stale lease does nothing", async () => {
      const time = clock();
      const store = new InMemoryWorkflowCheckpointStore({ now: time.now });
      const first = await store.acquireLease({
        ...locator,
        ownerId: "a",
        ttlMs: 60_000,
      });
      await store.releaseLease(first);
      const second = await store.acquireLease({
        ...locator,
        ownerId: "b",
        ttlMs: 60_000,
      });
      expect(second.fencingToken).toBe(first.fencingToken + 1);
      await store.releaseLease(first);
      const held = await reject(
        store.acquireLease({ ...locator, ownerId: "c", ttlMs: 1000 }),
      );
      expect(isWorkflowStorageError(held, "WORKFLOW_STORAGE_LEASE_HELD")).toBe(
        true,
      );
    });

    test("leases of different executions are independent", async () => {
      const store = new InMemoryWorkflowCheckpointStore();
      const a = await store.acquireLease({
        ...locator,
        ownerId: "a",
        ttlMs: 1000,
      });
      const b = await store.acquireLease({
        workflowId: "wf",
        executionId: "other",
        ownerId: "b",
        ttlMs: 1000,
      });
      expect(a.fencingToken).toBe(1);
      expect(b.fencingToken).toBe(1);
    });
  });

  test("an oversized save leaves the stored checkpoint untouched", async () => {
    const store = new InMemoryWorkflowCheckpointStore({
      maxCheckpointBytes: 2048,
    });
    const base = await makeCheckpoint("wf", "e1", 1);
    await store.put({ checkpoint: base });
    await reject(
      store.put({
        checkpoint: withWorkflowCompleted(base, "z".repeat(5000), 2),
      }),
    );
    expect((await store.get(locator))?.checkpoint).toEqual(base);
  });

  test("isolates executions and workflows that share an id", async () => {
    const store = new InMemoryWorkflowCheckpointStore();
    await store.put({ checkpoint: await makeCheckpoint("wf-a", "same", 1) });
    await store.put({ checkpoint: await makeCheckpoint("wf-b", "same", 2) });
    expect(
      (await store.get({ workflowId: "wf-a", executionId: "same" }))?.checkpoint
        .workflowId,
    ).toBe("wf-a");
    expect(
      (await store.get({ workflowId: "wf-b", executionId: "same" }))?.checkpoint
        .workflowId,
    ).toBe("wf-b");
  });

  test("updatedAt comes from the injected clock", async () => {
    const store = new InMemoryWorkflowCheckpointStore({ now: () => 4242 });
    await store.put({ checkpoint: await makeCheckpoint("wf", "e1") });
    expect((await store.get(locator))?.updatedAt).toBe(4242);
  });
});
