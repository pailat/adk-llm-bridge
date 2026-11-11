import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AppendEventRequest,
  type BaseSessionService,
  DatabaseSessionService,
  type DeleteSessionRequest,
  type Event,
  type GetSessionRequest,
  InMemorySessionService,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type Session,
  StaleSessionError,
  VertexAiSessionService,
} from "@google/adk";
import { createWorkflowCheckpoint } from "../../../src/workflows/checkpoint/checkpoint.js";
import type { WorkflowCheckpointV1 } from "../../../src/workflows/checkpoint/schema.js";
import {
  WorkflowCheckpointConflictError,
  workflowCheckpointRevision,
} from "../../../src/workflows/checkpoint/store.js";
import { defineWorkflow } from "../../../src/workflows/definition.js";
import {
  AdkSessionServiceWorkflowCheckpointStore,
  type AdkSessionServiceWorkflowCheckpointStoreOptions,
  DEFAULT_WORKFLOW_CHECKPOINT_APP_NAME,
} from "../../../src/workflows/storage/adk-session-checkpoint-store.js";
import type { BaseWorkflowCheckpointStore } from "../../../src/workflows/storage/checkpoint-store.js";
import {
  defineWorkflowStorageConformanceTests,
  type WorkflowStorageConformanceCase,
  workflowCheckpointStoreConformanceCases,
} from "../../../src/workflows/storage/conformance/index.js";

// The conformance suite may build a store while the cases are registered, so
// directories live until the whole file has run.
const dirs: string[] = [];
// A file-backed service keeps its database file open until its ORM closes;
// Windows cannot delete an open file, so they are closed before the rm.
const fileServices: DatabaseSessionService[] = [];
function fileService(url: string): DatabaseSessionService {
  const service = new DatabaseSessionService(url);
  fileServices.push(service);
  return service;
}
afterAll(async () => {
  for (const service of fileServices.splice(0)) {
    const orm = (service as unknown as { orm?: { close(): Promise<void> } })
      .orm;
    await orm?.close().catch(() => undefined);
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeCheckpoint(
  workflowId: string,
  executionId: string,
  input = "input",
  now = 1_700_000_000_000,
): Promise<WorkflowCheckpointV1> {
  return await createWorkflowCheckpoint({
    definition: defineWorkflow({
      id: workflowId,
      version: "1",
      handler: () => "done",
    }),
    executionId,
    input,
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

/** An in-memory session service that records calls and can inject faults. */
class SpyService extends InMemorySessionService {
  readonly calls: string[] = [];
  readonly appended: Array<{ timestamp: number; lastUpdateTime: number }> = [];
  readonly appendedEvents: Event[] = [];
  readonly deleted: DeleteSessionRequest[] = [];
  /** Added to the `lastUpdateTime` of every session `getSession` returns. */
  skewSeconds = 0;
  /** Runs once, inside the next `appendEvent`, before it throws a stale error. */
  competeThenStale: (() => Promise<void>) | undefined;
  /** Runs once after the next `listSessions` call returns its page. */
  afterListSessions: (() => Promise<void>) | undefined;
  /** When set, `getSession` rejects with it. */
  getSessionError: Error | undefined;

  override async getSession(
    request: GetSessionRequest,
  ): Promise<Session | undefined> {
    this.calls.push("getSession");
    if (this.getSessionError) throw this.getSessionError;
    const session = await super.getSession(request);
    if (session && this.skewSeconds !== 0) {
      session.lastUpdateTime += this.skewSeconds;
    }
    return session;
  }

  override async listSessions(
    request: ListSessionsRequest,
  ): Promise<ListSessionsResponse> {
    const result = await super.listSessions(request);
    const hook = this.afterListSessions;
    if (hook) {
      this.afterListSessions = undefined;
      await hook();
    }
    return result;
  }

  override async appendEvent(request: AppendEventRequest): Promise<Event> {
    this.calls.push("appendEvent");
    const hook = this.competeThenStale;
    if (hook) {
      this.competeThenStale = undefined;
      await hook();
      throw new StaleSessionError("the session was updated by another writer");
    }
    this.appended.push({
      timestamp: request.event.timestamp,
      lastUpdateTime: request.session.lastUpdateTime,
    });
    this.appendedEvents.push(request.event);
    return await super.appendEvent(request);
  }

  override async deleteSession(request: DeleteSessionRequest): Promise<void> {
    this.calls.push("deleteSession");
    this.deleted.push(request);
    await super.deleteSession(request);
  }

  count(name: string): number {
    return this.calls.filter((call) => call === name).length;
  }
}

function store(
  sessionService: BaseSessionService,
  extra: Partial<AdkSessionServiceWorkflowCheckpointStoreOptions> = {},
) {
  return new AdkSessionServiceWorkflowCheckpointStore({
    sessionService,
    ...extra,
  });
}

// --- Conformance runs --------------------------------------------------------

function register(
  label: string,
  cases: readonly WorkflowStorageConformanceCase[],
  expectedSkips: RegExp | undefined,
  minimumRun: number,
): void {
  describe(label, () => {
    test("the conformance run executes the expected cases", () => {
      const run = cases.filter((c) => c.skip === undefined);
      expect(run.length).toBeGreaterThanOrEqual(minimumRun);
      for (const c of cases) {
        if (c.skip === undefined) continue;
        if (expectedSkips === undefined) {
          throw new Error(`no case may be skipped, but one was: ${c.skip}`);
        }
        expect(c.skip).toMatch(expectedSkips);
      }
    });
    defineWorkflowStorageConformanceTests(cases, { test, skip: test.skip });
  });
}

// ADK's in-memory service has no stale-session check: advisory, no leases.
const memoryServices = new WeakMap<
  BaseWorkflowCheckpointStore,
  BaseSessionService
>();
const inMemoryCases = await workflowCheckpointStoreConformanceCases({
  createStore: () => {
    const service = new InMemorySessionService();
    const created = store(service);
    memoryServices.set(created, service);
    return created;
  },
  reopenStore: (existing) =>
    store(memoryServices.get(existing) as BaseSessionService),
});
register(
  "AdkSessionServiceWorkflowCheckpointStore conformance over InMemorySessionService",
  inMemoryCases,
  /advisory|leases is false|durable is false|pruning is false/,
  15,
);

/** True when `@mikro-orm/sqlite` resolves from this repository. */
function mikroOrmSqliteResolves(): boolean {
  try {
    Bun.resolveSync("@mikro-orm/sqlite", import.meta.dir);
    return true;
  } catch {
    return false;
  }
}
const hasSqliteDriver = mikroOrmSqliteResolves();
const SKIP_NAME =
  "AdkSessionServiceWorkflowCheckpointStore over DatabaseSessionService (skipped: @mikro-orm/sqlite does not resolve)";

if (hasSqliteDriver) {
  // The first DatabaseSessionService of a process loads the optional driver and
  // builds the schema (about 1 s idle, far more on a busy host). It is paid here,
  // under its own generous limit, so that no conformance case carries it
  // against the 5 s limit of a single test.
  beforeAll(async () => {
    const warm = new DatabaseSessionService("sqlite://:memory:");
    await warm.getSession({ appName: "warm-up", userId: "u", sessionId: "s" });
    await (warm as unknown as { orm?: { close(): Promise<void> } }).orm
      ?.close()
      .catch(() => undefined);
  }, 120_000);

  const memoryDatabases = new WeakMap<
    BaseWorkflowCheckpointStore,
    DatabaseSessionService
  >();
  // One `sqlite://:memory:` database lives inside one service instance, so a
  // reopen shares the instance; `durable` is then judged by the store flags.
  const databaseMemoryCases = await workflowCheckpointStoreConformanceCases({
    createStore: () => {
      const service = new DatabaseSessionService("sqlite://:memory:");
      const created = store(service);
      memoryDatabases.set(created, service);
      return created;
    },
    reopenStore: (existing) =>
      store(memoryDatabases.get(existing) as DatabaseSessionService),
  });
  register(
    "AdkSessionServiceWorkflowCheckpointStore conformance over DatabaseSessionService sqlite in memory",
    databaseMemoryCases,
    undefined,
    35,
  );

  const files = new WeakMap<BaseWorkflowCheckpointStore, string>();
  const databaseFileCases = await workflowCheckpointStoreConformanceCases({
    createStore: async () => {
      const dir = await mkdtemp(join(tmpdir(), "adk-session-sqlite-"));
      dirs.push(dir);
      const file = join(dir, "checkpoints.sqlite");
      const created = store(fileService(`sqlite://${file}`));
      files.set(created, file);
      return created;
    },
    reopenStore: (existing) =>
      store(fileService(`sqlite://${files.get(existing) as string}`)),
  });
  register(
    "AdkSessionServiceWorkflowCheckpointStore conformance over DatabaseSessionService sqlite file with reopen",
    databaseFileCases,
    undefined,
    35,
  );

  describe("AdkSessionServiceWorkflowCheckpointStore database durability", () => {
    test("a sqlite file store reports atomic, leases, multi-process and durable", () => {
      const created = store(new DatabaseSessionService("sqlite://:memory:"));
      expect(created.capabilities).toMatchObject({
        compareAndSet: "atomic",
        leases: true,
        multiProcess: true,
        durable: true,
        listing: true,
        pruning: true,
      });
    });

    test("a checkpoint written through one DatabaseSessionService is read after reopening the file", async () => {
      const dir = await mkdtemp(join(tmpdir(), "adk-session-sqlite-"));
      dirs.push(dir);
      const url = `sqlite://${join(dir, "reopen.sqlite")}`;
      const first = store(fileService(url));
      const checkpoint = await makeCheckpoint("flow", "exec");
      await first.put({ checkpoint, expectedRevision: null });
      const second = store(fileService(url));
      const stored = await second.get({
        workflowId: "flow",
        executionId: "exec",
      });
      expect(stored?.checkpoint).toEqual(checkpoint);
      expect(stored?.revision).toBe(
        await workflowCheckpointRevision(checkpoint),
      );
    });

    test("two stores over one sqlite file leave exactly one winner from the same revision", async () => {
      const dir = await mkdtemp(join(tmpdir(), "adk-session-sqlite-"));
      dirs.push(dir);
      const url = `sqlite://${join(dir, "race.sqlite")}`;
      const writers = [
        store(fileService(url)),
        store(fileService(url)),
        store(fileService(url)),
      ];
      const base = await writers[0]?.put({
        checkpoint: await makeCheckpoint("flow", "exec", "base"),
        expectedRevision: null,
      });
      const outcomes = await Promise.allSettled(
        writers.map(async (writer, index) =>
          writer.put({
            checkpoint: await makeCheckpoint("flow", "exec", `w${index}`),
            expectedRevision: base?.revision,
          }),
        ),
      );
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          expect(outcome.reason).toBeInstanceOf(
            WorkflowCheckpointConflictError,
          );
        }
      }
    });
  });
} else {
  test.skip(SKIP_NAME, () => {});
}

// --- Behaviour proven with a recording service --------------------------------

describe("AdkSessionServiceWorkflowCheckpointStore options and capabilities", () => {
  test("over InMemorySessionService it reports advisory, no leases, not multi-process and not durable", () => {
    expect(store(new InMemorySessionService()).capabilities).toMatchObject({
      compareAndSet: "advisory",
      leases: false,
      multiProcess: false,
      durable: false,
      listing: true,
      pruning: true,
    });
  });

  test("concurrency stale-session-reject is what makes it report atomic, with leases and multi-process", () => {
    // A subclass of ADK's in-memory service may reject stale sessions, as
    // this spy does; the host asserts it with the option.
    const atomic = store(new SpyService(), {
      concurrency: "stale-session-reject",
    });
    expect(atomic.capabilities).toMatchObject({
      compareAndSet: "atomic",
      leases: true,
      multiProcess: true,
    });
    const none = store(new InMemorySessionService(), { concurrency: "none" });
    expect(none.capabilities.compareAndSet).toBe("advisory");
  });

  test("the default concurrency is stale-session-reject only for a DatabaseSessionService that rejects stale sessions", () => {
    expect(
      store(new DatabaseSessionService("sqlite://:memory:")).capabilities
        .compareAndSet,
    ).toBe("atomic");
    expect(
      store(
        new DatabaseSessionService("sqlite://:memory:", {
          staleSession: "reload",
        }),
      ).capabilities.compareAndSet,
    ).toBe("advisory");
    expect(
      store(
        new DatabaseSessionService("sqlite://:memory:", {
          staleSession: "reject",
        }),
      ).capabilities.compareAndSet,
    ).toBe("atomic");
  });

  test("concurrency stale-session-reject is refused over an ADK service that does not reject stale sessions", () => {
    const refused = (
      sessionService: BaseSessionService,
    ): string | undefined => {
      try {
        store(sessionService, { concurrency: "stale-session-reject" });
      } catch (error) {
        return (error as { code?: string }).code;
      }
      return undefined;
    };
    expect(refused(new InMemorySessionService())).toBe(
      "WORKFLOW_STORAGE_INVALID_OPTION",
    );
    expect(
      refused(
        Object.create(VertexAiSessionService.prototype) as BaseSessionService,
      ),
    ).toBe("WORKFLOW_STORAGE_INVALID_OPTION");
    expect(
      refused(
        new DatabaseSessionService("sqlite://:memory:", {
          staleSession: "reload",
        }),
      ),
    ).toBe("WORKFLOW_STORAGE_INVALID_OPTION");
    expect(refused(new DatabaseSessionService("sqlite://:memory:"))).toBe(
      undefined,
    );
  });

  test("the default concurrency falls back to none, so advisory, when ADK's stale-session setting cannot be read", () => {
    // ADK keeps the setting in a field that is private in its types; if a
    // release renames it, the provider must claim less, not more.
    const renamed = Object.create(
      DatabaseSessionService.prototype,
    ) as DatabaseSessionService;
    expect(renamed).toBeInstanceOf(DatabaseSessionService);
    expect(store(renamed).capabilities).toMatchObject({
      compareAndSet: "advisory",
      leases: false,
      multiProcess: false,
    });
    // The same object with the field ADK 2.4 sets is trusted.
    Object.assign(renamed, { staleSession: "reject" });
    expect(store(renamed).capabilities.compareAndSet).toBe("atomic");
  });

  test("an explicit concurrency none wins over a DatabaseSessionService", () => {
    expect(
      store(new DatabaseSessionService("sqlite://:memory:"), {
        concurrency: "none",
      }).capabilities,
    ).toMatchObject({ compareAndSet: "advisory", leases: false });
  });

  test("durable defaults to false for InMemorySessionService and true otherwise, and can be set", () => {
    expect(store(new InMemorySessionService()).capabilities.durable).toBe(
      false,
    );
    expect(
      store(new DatabaseSessionService("sqlite://:memory:")).capabilities
        .durable,
    ).toBe(true);
    expect(
      store(new InMemorySessionService(), { durable: true }).capabilities
        .durable,
    ).toBe(true);
  });

  test("an empty appName is rejected with WORKFLOW_STORAGE_INVALID_OPTION", () => {
    let thrown: { code?: string } | undefined;
    try {
      store(new InMemorySessionService(), { appName: "" });
    } catch (error) {
      thrown = error as { code?: string };
    }
    expect(thrown?.code).toBe("WORKFLOW_STORAGE_INVALID_OPTION");
  });
});

describe("AdkSessionServiceWorkflowCheckpointStore session layout", () => {
  test("each execution is one session in the default app, and another app is untouched", async () => {
    const service = new SpyService();
    const provider = store(service);
    await provider.put({ checkpoint: await makeCheckpoint("flow", "exec-1") });
    await provider.put({ checkpoint: await makeCheckpoint("flow", "exec-2") });
    const mine = await service.listSessions({
      appName: DEFAULT_WORKFLOW_CHECKPOINT_APP_NAME,
    });
    expect(mine.sessions).toHaveLength(2);
    expect(
      (await service.listSessions({ appName: "somewhere-else" })).sessions,
    ).toHaveLength(0);
    // A second save of one execution adds an event, not a session.
    const stored = await provider.get({
      workflowId: "flow",
      executionId: "exec-1",
    });
    await provider.put({
      checkpoint: await makeCheckpoint("flow", "exec-1", "again"),
      expectedRevision: stored?.revision,
    });
    expect(
      (
        await service.listSessions({
          appName: DEFAULT_WORKFLOW_CHECKPOINT_APP_NAME,
        })
      ).sessions,
    ).toHaveLength(2);
  });

  test("a custom appName holds the sessions", async () => {
    const service = new SpyService();
    await store(service, { appName: "my-checkpoints" }).put({
      checkpoint: await makeCheckpoint("flow", "exec"),
    });
    expect(
      (await service.listSessions({ appName: "my-checkpoints" })).sessions,
    ).toHaveLength(1);
    expect(
      (
        await service.listSessions({
          appName: DEFAULT_WORKFLOW_CHECKPOINT_APP_NAME,
        })
      ).sessions,
    ).toHaveLength(0);
  });

  test("user and session ids stay within ADK id rules and distinct ids never collide", async () => {
    const service = new SpyService();
    const provider = store(service);
    const ids = [
      ["a/b", "exec"],
      ["a_b", "exec"],
      ["a+2Fb", "exec"],
      ["flow:1", "exec ü é #1/2"],
      ["flow", "exec:1_2"],
      ["flow", "exec:1/2"],
    ] as const;
    for (const [workflowId, executionId] of ids) {
      await provider.put({
        checkpoint: await makeCheckpoint(workflowId, executionId, "x"),
        expectedRevision: null,
      });
    }
    const sessions = (
      await service.listSessions({
        appName: DEFAULT_WORKFLOW_CHECKPOINT_APP_NAME,
      })
    ).sessions;
    expect(sessions).toHaveLength(ids.length);
    for (const session of sessions) {
      expect(session.userId).toMatch(/^[A-Za-z0-9._~-]+$/);
      expect(session.id).toMatch(/^[A-Za-z0-9._~-]+$/);
      expect(session.userId.length).toBeLessThanOrEqual(191);
      expect(session.id.length).toBeLessThanOrEqual(191);
    }
    // Reversible: listing gives back the original ids.
    const listed = (await provider.list({ limit: 100 })).items.map(
      (item) => `${item.workflowId}|${item.executionId}`,
    );
    expect(listed.sort()).toEqual(ids.map(([w, e]) => `${w}|${e}`).sort());
    for (const [workflowId, executionId] of ids) {
      const stored = await provider.get({ workflowId, executionId });
      expect(stored?.checkpoint.workflowId).toBe(workflowId);
      expect(stored?.checkpoint.executionId).toBe(executionId);
    }
  });
});

describe("AdkSessionServiceWorkflowCheckpointStore save", () => {
  test("a save reads the session, then appends one event whose stateDelta holds the checkpoint", async () => {
    const service = new SpyService();
    const provider = store(service);
    const checkpoint = await makeCheckpoint("flow", "exec");
    const written = await provider.put({ checkpoint, expectedRevision: null });
    const first = service.calls.indexOf("getSession");
    const append = service.calls.indexOf("appendEvent");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(append).toBeGreaterThan(first);
    expect(service.count("appendEvent")).toBe(1);
    const delta = service.appendedEvents[0]?.actions.stateDelta ?? {};
    expect(Object.keys(delta).length).toBeGreaterThan(0);
    expect(JSON.stringify(delta)).toContain(written.revision);
  });

  test("the event timestamp is strictly greater than session.lastUpdateTime, even when that is in the future", async () => {
    const service = new SpyService();
    const provider = store(service);
    const first = await provider.put({
      checkpoint: await makeCheckpoint("flow", "exec"),
      expectedRevision: null,
    });
    service.skewSeconds = 1_000_000;
    await provider.put({
      checkpoint: await makeCheckpoint("flow", "exec", "next"),
      expectedRevision: first.revision,
    });
    for (const append of service.appended) {
      expect(append.timestamp).toBeGreaterThan(append.lastUpdateTime);
    }
    const skewed = service.appended[service.appended.length - 1];
    expect(skewed?.lastUpdateTime).toBeGreaterThan(
      service.appended[0]?.lastUpdateTime ?? 0,
    );
  });

  test("a stale expectedRevision is rejected before anything is appended", async () => {
    const service = new SpyService();
    const provider = store(service);
    await provider.put({
      checkpoint: await makeCheckpoint("flow", "exec"),
      expectedRevision: null,
    });
    const appends = service.count("appendEvent");
    const error = await reject(
      provider.put({
        checkpoint: await makeCheckpoint("flow", "exec", "next"),
        expectedRevision: "sha256:not-the-stored-revision",
      }),
    );
    expect(error).toBeInstanceOf(WorkflowCheckpointConflictError);
    expect(service.count("appendEvent")).toBe(appends);
  });

  test("a fencing token older than the stored one is rejected before anything is appended", async () => {
    const service = new SpyService();
    const provider = store(service, { concurrency: "stale-session-reject" });
    const locator = { workflowId: "flow", executionId: "exec" };
    const old = await provider.acquireLease({
      ...locator,
      ownerId: "owner-a",
      ttlMs: 5,
    });
    await new Promise((r) => setTimeout(r, 30));
    const current = await provider.acquireLease({
      ...locator,
      ownerId: "owner-b",
      ttlMs: 60_000,
    });
    expect(current.fencingToken).toBeGreaterThan(old.fencingToken);
    const appends = service.count("appendEvent");
    const error = (await reject(
      provider.put({
        checkpoint: await makeCheckpoint("flow", "exec"),
        fencingToken: old.fencingToken,
      }),
    )) as { code?: string };
    expect(error.code).toBe("WORKFLOW_STORAGE_LEASE_LOST");
    expect(service.count("appendEvent")).toBe(appends);
    await provider.put({
      checkpoint: await makeCheckpoint("flow", "exec"),
      fencingToken: current.fencingToken,
    });
    expect(service.count("appendEvent")).toBeGreaterThan(appends);
  });

  test("a stale-session rejection becomes a conflict carrying the revision actually stored", async () => {
    const service = new SpyService();
    const provider = store(service, { concurrency: "stale-session-reject" });
    const rival = store(service, { concurrency: "stale-session-reject" });
    const base = await provider.put({
      checkpoint: await makeCheckpoint("flow", "exec", "base"),
      expectedRevision: null,
    });
    const rivalCheckpoint = await makeCheckpoint("flow", "exec", "rival");
    service.competeThenStale = async () => {
      await rival.put({
        checkpoint: rivalCheckpoint,
        expectedRevision: base.revision,
      });
    };
    const error = await reject(
      provider.put({
        checkpoint: await makeCheckpoint("flow", "exec", "mine"),
        expectedRevision: base.revision,
      }),
    );
    expect(error).toBeInstanceOf(WorkflowCheckpointConflictError);
    const conflict = error as WorkflowCheckpointConflictError;
    expect(conflict.conflict.expectedRevision).toBe(base.revision);
    expect(conflict.conflict.actualRevision).toBe(
      await workflowCheckpointRevision(rivalCheckpoint),
    );
    // The rival's checkpoint is what is stored.
    const stored = await provider.get({
      workflowId: "flow",
      executionId: "exec",
    });
    expect(stored?.revision).toBe(conflict.conflict.actualRevision as string);
  });

  test("a stale-session rejection on the last allowed try is still a conflict when the checkpoint changed", async () => {
    // The provider tries a save eight times. The first seven rejections come
    // from changes that leave the checkpoint alone (as a lease renewal
    // would) and are retried; before the eighth, a rival saves a checkpoint.
    // One outer attempt, so the answer is the provider's own and not that of
    // a retry by the base class.
    const tries = 8;
    const service = new SpyService();
    const provider = store(service, {
      concurrency: "stale-session-reject",
      retry: { maxAttempts: 1 },
    });
    const rival = store(service, { concurrency: "stale-session-reject" });
    const base = await provider.put({
      checkpoint: await makeCheckpoint("flow", "exec", "base"),
      expectedRevision: null,
    });
    const rivalCheckpoint = await makeCheckpoint("flow", "exec", "rival");
    let rejected = 0;
    const rejectAgain = async (): Promise<void> => {
      rejected += 1;
      if (rejected < tries) {
        service.competeThenStale = rejectAgain;
        return;
      }
      await rival.put({
        checkpoint: rivalCheckpoint,
        expectedRevision: base.revision,
      });
    };
    service.competeThenStale = rejectAgain;
    const appendsBefore = service.count("appendEvent");
    const error = await reject(
      provider.put({
        checkpoint: await makeCheckpoint("flow", "exec", "mine"),
        expectedRevision: base.revision,
      }),
    );
    expect(rejected).toBe(tries);
    // Eight tries of this save, plus the rival's one append.
    expect(service.count("appendEvent") - appendsBefore).toBe(tries + 1);
    expect(error).toBeInstanceOf(WorkflowCheckpointConflictError);
    const conflict = error as WorkflowCheckpointConflictError;
    expect(conflict.conflict.expectedRevision).toBe(base.revision);
    expect(conflict.conflict.actualRevision).toBe(
      await workflowCheckpointRevision(rivalCheckpoint),
    );
  });
});

describe("AdkSessionServiceWorkflowCheckpointStore driver errors", () => {
  function missingDriver(): Error {
    return new Error(
      'DatabaseSessionService with a "sqlite" connection string requires the optional peer dependency "@mikro-orm/sqlite", which is not installed. Install it with:\n\n  npm install @mikro-orm/sqlite\n',
      {
        cause: Object.assign(
          new Error("Cannot find module '@mikro-orm/sqlite'"),
          {
            code: "MODULE_NOT_FOUND",
          },
        ),
      },
    );
  }

  test("a missing MikroORM driver surfaces as WORKFLOW_STORAGE_DRIVER_MISSING on read and write", async () => {
    const service = new SpyService();
    service.getSessionError = missingDriver();
    const provider = store(service);
    const read = (await reject(
      provider.get({ workflowId: "flow", executionId: "exec" }),
    )) as { code?: string; message?: string };
    expect(read.code).toBe("WORKFLOW_STORAGE_DRIVER_MISSING");
    expect(read.message).toContain("@mikro-orm/sqlite");
    const write = (await reject(
      provider.put({ checkpoint: await makeCheckpoint("flow", "exec") }),
    )) as { code?: string };
    expect(write.code).toBe("WORKFLOW_STORAGE_DRIVER_MISSING");
  });

  test("an unrelated service error is not reported as a missing driver", async () => {
    const service = new SpyService();
    service.getSessionError = new Error("disk on fire");
    const error = (await reject(
      store(service).get({ workflowId: "flow", executionId: "exec" }),
    )) as { code?: string };
    expect(error.code).not.toBe("WORKFLOW_STORAGE_DRIVER_MISSING");
  });
});

describe("AdkSessionServiceWorkflowCheckpointStore list, delete and prune", () => {
  async function seeded(count: number) {
    const service = new SpyService();
    const provider = store(service);
    for (let index = 0; index < count; index++) {
      await provider.put({
        checkpoint: await makeCheckpoint(
          "flow",
          `exec-${index}`,
          "x",
          1_700_000_000_000 + index,
        ),
        expectedRevision: null,
      });
    }
    // A session of another application in the same service is never listed.
    await service.createSession({
      appName: "an-agent-app",
      userId: "user",
      sessionId: "chat",
    });
    return { service, provider };
  }

  test("list pages through listSessions and reads one session per row", async () => {
    const { service, provider } = await seeded(5);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const before = service.count("getSession");
      const page = await provider.list({
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      const reads = service.count("getSession") - before;
      expect(reads).toBe(page.items.length);
      for (const item of page.items) seen.push(item.executionId);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined && pages < 10);
    expect(pages).toBeGreaterThan(1);
    expect([...seen].sort()).toEqual([
      "exec-0",
      "exec-1",
      "exec-2",
      "exec-3",
      "exec-4",
    ]);
    expect(new Set(seen).size).toBe(5);
  });

  test("a save during a multi-page scan neither repeats nor drops an execution", async () => {
    const service = new SpyService();
    const provider = store(service);
    const count = 120;
    const revisions: string[] = [];
    for (let index = 0; index < count; index++) {
      const written = await provider.put({
        checkpoint: await makeCheckpoint(
          "flow",
          `exec-${String(index).padStart(3, "0")}`,
        ),
        expectedRevision: null,
      });
      revisions.push(written.revision);
    }
    // After the first page of the scan, a save moves the oldest session to the
    // front of the service's update-time order.
    service.afterListSessions = async () => {
      await provider.put({
        checkpoint: await makeCheckpoint("flow", "exec-000", "again"),
        expectedRevision: revisions[0] as string,
      });
    };
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await provider.list({
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      for (const item of page.items) seen.push(item.executionId);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(seen).toHaveLength(count);
    expect(new Set(seen).size).toBe(count);
    expect(seen).toEqual([...seen].sort());
  });

  test("delete removes the execution's whole session through deleteSession", async () => {
    const { service, provider } = await seeded(2);
    const locator = { workflowId: "flow", executionId: "exec-0" };
    expect(await provider.delete(locator)).toBe(true);
    expect(service.count("deleteSession")).toBe(1);
    expect(service.deleted[0]?.appName).toBe(
      DEFAULT_WORKFLOW_CHECKPOINT_APP_NAME,
    );
    expect(await provider.get(locator)).toBeUndefined();
    expect(await provider.delete(locator)).toBe(false);
    expect(
      (await service.listSessions({ appName: "an-agent-app" })).sessions,
    ).toHaveLength(1);
  });

  test("prune deletes sessions older than the cutoff through deleteSession and leaves the other app alone", async () => {
    const { service, provider } = await seeded(3);
    const result = await provider.prune({
      updatedBefore: Date.now() + 60_000,
      statuses: ["running"],
    });
    expect(result.deleted).toBe(3);
    expect(result.hasMore).toBe(false);
    expect(service.count("deleteSession")).toBe(3);
    expect((await provider.list({})).items).toHaveLength(0);
    expect(
      (await service.listSessions({ appName: "an-agent-app" })).sessions,
    ).toHaveLength(1);
  });
});
