import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowCheckpoint } from "../../../src/workflows/checkpoint/checkpoint.js";
import type { WorkflowCheckpointV1 } from "../../../src/workflows/checkpoint/schema.js";
import { SqliteWorkflowCheckpointStore } from "../../../src/workflows/checkpoint/sqlite/index.js";
import { defineWorkflow } from "../../../src/workflows/definition.js";
import { SqliteWorkflowEventExporter } from "../../../src/workflows/events/sqlite/index.js";
import { AdkSessionServiceWorkflowCheckpointStore } from "../../../src/workflows/storage/adk-session-checkpoint-store.js";
import type { BaseWorkflowCheckpointStore } from "../../../src/workflows/storage/checkpoint-store.js";
import {
  isWorkflowStorageError,
  type WorkflowStorageError,
  type WorkflowStorageErrorCode,
} from "../../../src/workflows/storage/errors.js";
import type { BaseWorkflowEventExporter } from "../../../src/workflows/storage/event-exporter.js";
import { FileSystemWorkflowCheckpointProvider } from "../../../src/workflows/storage/file-system-checkpoint-provider.js";
import { InMemoryWorkflowCheckpointStore } from "../../../src/workflows/storage/in-memory-checkpoint-store.js";
import { InMemoryWorkflowEventExporter } from "../../../src/workflows/storage/in-memory-event-exporter.js";
import { JsonlWorkflowEventExporter } from "../../../src/workflows/storage/jsonl-event-exporter.js";
import {
  getWorkflowCheckpointStoreFromUri,
  getWorkflowEventExporterFromUri,
  listWorkflowStorageSchemes,
  redactWorkflowStorageUri,
  registerWorkflowStorageProvider,
  WORKFLOW_CHECKPOINT_URI_SCHEMES,
  WORKFLOW_EVENT_URI_SCHEMES,
  type WorkflowStorageProviderFactory,
  type WorkflowStorageUri,
  windowsDrivePath,
} from "../../../src/workflows/storage/registry.js";
import { isBun } from "../../utils/fixtures/runtime.js";

const SECRET = "s3cr3t-p4ss";
const tempRoots: string[] = [];
const unregisters: Array<() => void> = [];
const opened: Array<{ close(): Promise<void> | void }> = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "workflow-registry-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  for (const unregister of unregisters.splice(0).reverse()) {
    try {
      unregister();
    } catch {
      // The registry may be missing while the tests run first.
    }
  }
  for (const resource of opened.splice(0)) {
    try {
      await resource.close();
    } catch {
      // Already closed.
    }
  }
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function reject(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

async function storageError(
  promise: Promise<unknown>,
  code: WorkflowStorageErrorCode,
): Promise<WorkflowStorageError> {
  const error = await reject(promise);
  if (!isWorkflowStorageError(error)) {
    throw new Error(
      `expected a WorkflowStorageError, got ${String((error as Error)?.message ?? error)}`,
    );
  }
  expect(error.code).toBe(code);
  return error;
}

function syncStorageError(
  action: () => unknown,
  code: WorkflowStorageErrorCode,
): WorkflowStorageError {
  try {
    action();
  } catch (error) {
    if (!isWorkflowStorageError(error)) {
      throw new Error(
        `expected a WorkflowStorageError, got ${String((error as Error)?.message ?? error)}`,
      );
    }
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error("expected the call to throw");
}

function register(
  scheme: string,
  factory: WorkflowStorageProviderFactory,
  options?: { replace?: boolean },
): () => void {
  const unregister = registerWorkflowStorageProvider(scheme, factory, options);
  unregisters.push(unregister);
  return unregister;
}

const definition = defineWorkflow({
  id: "registry-workflow",
  version: "1",
  handler: () => "done",
});

async function makeCheckpoint(
  executionId: string,
): Promise<WorkflowCheckpointV1> {
  return await createWorkflowCheckpoint({
    definition,
    executionId,
    input: "input",
    now: 1,
  });
}

async function checkpointFrom(
  uri: string,
  options?: Parameters<typeof getWorkflowCheckpointStoreFromUri>[1],
): Promise<BaseWorkflowCheckpointStore> {
  const store = await getWorkflowCheckpointStoreFromUri(uri, options);
  opened.push(store);
  return store;
}

async function exporterFrom(
  uri: string,
  options?: Parameters<typeof getWorkflowEventExporterFromUri>[1],
): Promise<BaseWorkflowEventExporter> {
  const exporter = await getWorkflowEventExporterFromUri(uri, options);
  opened.push(exporter);
  return exporter;
}

async function saveAndReadCheckpoint(
  store: BaseWorkflowCheckpointStore,
  executionId: string,
): Promise<void> {
  const checkpoint = await makeCheckpoint(executionId);
  await store.put({ checkpoint, expectedRevision: null });
  const stored = await store.get({
    workflowId: definition.id,
    executionId,
  });
  expect(stored?.checkpoint.executionId).toBe(executionId);
}

async function appendAndReadEvent(
  exporter: BaseWorkflowEventExporter,
  executionId: string,
): Promise<void> {
  const result = await exporter.append({
    executionId,
    records: [
      {
        id: "record-1",
        executionId,
        kind: "workflow",
        type: "custom",
        timestamp: 1,
        payload: { hello: "world" },
      },
    ],
  });
  expect(result.lastSequence).toBe(1);
  const page = await exporter.read({ executionId });
  expect(page.records.map((record) => record.id)).toEqual(["record-1"]);
  expect(page.records[0]?.sequence).toBe(1);
}

describe("redactWorkflowStorageUri", () => {
  test("replaces the password of a database URI with three asterisks", () => {
    const redacted = redactWorkflowStorageUri(
      `postgres://app:${SECRET}@db.example.com:5432/workflows`,
    );
    expect(redacted).toBe("postgres://app:***@db.example.com:5432/workflows");
    expect(redacted).not.toContain(SECRET);
  });

  test("redacts the password behind the adk-session+ prefix", () => {
    const redacted = redactWorkflowStorageUri(
      `adk-session+mysql://app:${SECRET}@db/w`,
    );
    expect(redacted).not.toContain(SECRET);
    expect(redacted).toContain("adk-session+mysql://app:***@db/w");
  });

  test("leaves a URI without a password unchanged", () => {
    expect(redactWorkflowStorageUri("memory://")).toBe("memory://");
    expect(redactWorkflowStorageUri("sqlite:///var/db/w.db?x=1")).toBe(
      "sqlite:///var/db/w.db?x=1",
    );
    expect(redactWorkflowStorageUri("postgres://app@db/w")).toBe(
      "postgres://app@db/w",
    );
  });

  test("returns a placeholder for a string that is not a URI", () => {
    expect(redactWorkflowStorageUri("not a uri")).toBe("<invalid uri>");
    expect(redactWorkflowStorageUri("")).toBe("<invalid uri>");
  });
});

describe("listWorkflowStorageSchemes", () => {
  test("lists every built-in scheme sorted, flagged built in", () => {
    const schemes = listWorkflowStorageSchemes();
    const names = schemes.map((entry) => entry.scheme);
    expect(names).toEqual([...names].sort());
    for (const scheme of WORKFLOW_CHECKPOINT_URI_SCHEMES) {
      expect(names).toContain(scheme);
    }
    for (const scheme of WORKFLOW_EVENT_URI_SCHEMES) {
      expect(names).toContain(scheme);
    }
    for (const entry of schemes) expect(entry.builtIn).toBe(true);
  });

  test("states the capabilities of each built-in scheme", () => {
    const byScheme = new Map(
      listWorkflowStorageSchemes().map((entry) => [entry.scheme, entry]),
    );
    for (const scheme of ["memory", "file", "sqlite"]) {
      expect([...(byScheme.get(scheme)?.capabilities ?? [])].sort()).toEqual([
        "checkpoints",
        "events",
      ]);
    }
    for (const scheme of [
      "adk-session+memory",
      "adk-session+sqlite",
      "postgres",
      "postgresql",
      "mysql",
      "mariadb",
      "mssql",
      "vertexai",
    ]) {
      expect([...(byScheme.get(scheme)?.capabilities ?? [])]).toEqual([
        "checkpoints",
      ]);
    }
  });

  test("lists a custom scheme as not built in", () => {
    register("custom-list", { checkpointStore: () => stubStore() });
    const entry = listWorkflowStorageSchemes().find(
      (candidate) => candidate.scheme === "custom-list",
    );
    expect(entry?.builtIn).toBe(false);
    expect([...(entry?.capabilities ?? [])]).toEqual(["checkpoints"]);
  });
});

function stubStore(): BaseWorkflowCheckpointStore {
  return new InMemoryWorkflowCheckpointStore();
}

describe("built-in schemes for checkpoints", () => {
  test("memory:// returns the in-memory store and saves a checkpoint", async () => {
    const store = await checkpointFrom("memory://");
    expect(store).toBeInstanceOf(InMemoryWorkflowCheckpointStore);
    await saveAndReadCheckpoint(store, "exec-memory");
  });

  test("file:///dir returns the file-system provider and saves a checkpoint", async () => {
    const root = tempDir();
    const store = await checkpointFrom(`file://${root}`);
    expect(store).toBeInstanceOf(FileSystemWorkflowCheckpointProvider);
    await saveAndReadCheckpoint(store, "exec-file");
  });

  test("a Windows drive path written as file:///C:/dir loses the slash before the drive letter", () => {
    expect(windowsDrivePath("/C:/Users/a b/data")).toBe("C:/Users/a b/data");
    expect(windowsDrivePath("/d:\\data")).toBe("d:\\data");
    expect(windowsDrivePath("/C:")).toBe("/C:");
    expect(windowsDrivePath("/var/db/C:/x")).toBe("/var/db/C:/x");
    expect(windowsDrivePath("C:/x")).toBe("C:/x");
  });

  // The URL form of a drive path only exists on Windows.
  test.skipIf(process.platform !== "win32")(
    "file:///C:/dir, the URL form of a Windows path, returns the file-system provider",
    async () => {
      const root = tempDir().replaceAll("\\", "/");
      const store = await checkpointFrom(`file:///${root}`);
      expect(store).toBeInstanceOf(FileSystemWorkflowCheckpointProvider);
    },
  );

  test("sqlite:///file.db returns the native SQLite store and saves a checkpoint", async () => {
    const path = join(tempDir(), "w.db");
    const store = await checkpointFrom(`sqlite://${path}`);
    expect(store).toBeInstanceOf(SqliteWorkflowCheckpointStore);
    await saveAndReadCheckpoint(store, "exec-sqlite");
    expect(existsSync(path)).toBe(true);
  });

  test("sqlite:// accepts its scalar options as query parameters", async () => {
    const path = join(tempDir(), "w.db");
    const store = await checkpointFrom(
      `sqlite://${path}?busyTimeoutMs=10000&synchronous=normal`,
    );
    expect(store).toBeInstanceOf(SqliteWorkflowCheckpointStore);
    await saveAndReadCheckpoint(store, "exec-sqlite-params");
  });

  test("adk-session+memory:// wraps ADK's in-memory session service and saves a checkpoint", async () => {
    const store = await checkpointFrom("adk-session+memory://");
    expect(store).toBeInstanceOf(AdkSessionServiceWorkflowCheckpointStore);
    await saveAndReadCheckpoint(store, "exec-adk-memory");
  });

  test("adk-session+memory:// refuses concurrency=stale-session-reject: the in-memory service cannot give it", async () => {
    await storageError(
      getWorkflowCheckpointStoreFromUri(
        "adk-session+memory://?concurrency=stale-session-reject",
      ),
      "WORKFLOW_STORAGE_INVALID_OPTION",
    );
    const store = await checkpointFrom(
      "adk-session+memory://?concurrency=none",
    );
    expect(store.capabilities.compareAndSet).toBe("advisory");
  });

  test("adk-session+sqlite:// wraps ADK's database session service", async () => {
    const path = join(tempDir(), "adk.db");
    const store = await checkpointFrom(`adk-session+sqlite://${path}`);
    expect(store).toBeInstanceOf(AdkSessionServiceWorkflowCheckpointStore);
  });

  test("bare database schemes delegate to ADK and wrap the service", async () => {
    for (const uri of [
      "postgres://app:pw@localhost:5432/w",
      "postgresql://app:pw@localhost:5432/w",
      "mysql://app:pw@localhost:3306/w",
      "mariadb://app:pw@localhost:3306/w",
      "mssql://app:pw@localhost:1433/w",
    ]) {
      const store = await checkpointFrom(uri);
      expect(store).toBeInstanceOf(AdkSessionServiceWorkflowCheckpointStore);
    }
  });

  test("shared options win over query parameters, and query parameters apply alone", async () => {
    const root = tempDir();
    const fromQuery = await checkpointFrom(
      `file://${root}?maxCheckpointBytes=1000000`,
    );
    expect(fromQuery.capabilities.maxCheckpointBytes).toBe(1_000_000);
    const fromOptions = await checkpointFrom(
      `file://${root}?maxCheckpointBytes=1000000`,
      { maxCheckpointBytes: 2_000_000 },
    );
    expect(fromOptions.capabilities.maxCheckpointBytes).toBe(2_000_000);
  });
});

describe("built-in schemes for event exporters", () => {
  test("memory:// returns the in-memory exporter and appends a record", async () => {
    const exporter = await exporterFrom("memory://");
    expect(exporter).toBeInstanceOf(InMemoryWorkflowEventExporter);
    await appendAndReadEvent(exporter, "exec-memory");
  });

  test("file:///dir returns the JSONL exporter and appends a record", async () => {
    const directory = tempDir();
    const exporter = await exporterFrom(`file://${directory}`);
    expect(exporter).toBeInstanceOf(JsonlWorkflowEventExporter);
    await appendAndReadEvent(exporter, "exec-file");
  });

  test("sqlite:///file.db returns the SQLite exporter and appends a record", async () => {
    const path = join(tempDir(), "events.db");
    const exporter = await exporterFrom(`sqlite://${path}`);
    expect(exporter).toBeInstanceOf(SqliteWorkflowEventExporter);
    await appendAndReadEvent(exporter, "exec-sqlite");
  });

  test("shared options win over query parameters", async () => {
    const fromQuery = await exporterFrom("memory://?maxRecordBytes=5000");
    expect(fromQuery.capabilities.maxRecordBytes).toBe(5000);
    const fromOptions = await exporterFrom("memory://?maxRecordBytes=5000", {
      maxRecordBytes: 7000,
    });
    expect(fromOptions.capabilities.maxRecordBytes).toBe(7000);
  });

  test("the adk-session+ prefix and database schemes serve no events", async () => {
    for (const uri of [
      "adk-session+memory://",
      "postgres://app:pw@localhost/w",
      "vertexai://project/location",
    ]) {
      await storageError(
        getWorkflowEventExporterFromUri(uri),
        "WORKFLOW_STORAGE_UNSUPPORTED",
      );
    }
  });
});

describe("custom schemes", () => {
  test("a registered scheme serves both capabilities and receives the parsed URI", async () => {
    const seen: WorkflowStorageUri[] = [];
    const seenOptions: unknown[] = [];
    register("memo", {
      checkpointStore: (uri, options) => {
        seen.push(uri);
        seenOptions.push(options);
        return stubStore();
      },
      eventExporter: (uri) => {
        seen.push(uri);
        return new InMemoryWorkflowEventExporter();
      },
    });
    const store = await checkpointFrom(
      `MEMO://user:${SECRET}@host/a%20b?x=1&y=two`,
      { maxCheckpointBytes: 123_456 },
    );
    expect(store).toBeInstanceOf(InMemoryWorkflowCheckpointStore);
    await exporterFrom("memo://other");
    const uri = seen[0];
    expect(uri?.scheme).toBe("memo");
    expect(uri?.uri).toContain(SECRET);
    expect(uri?.redacted).not.toContain(SECRET);
    expect(uri?.redacted).toContain(":***@");
    expect(uri?.params).toEqual({ x: "1", y: "two" });
    expect(uri?.path).toContain("a b");
    expect(seenOptions[0]).toEqual({ maxCheckpointBytes: 123_456 });
    expect(seen).toHaveLength(2);
  });

  test("an async factory is awaited", async () => {
    register("slow", {
      checkpointStore: async () => {
        await Promise.resolve();
        return stubStore();
      },
    });
    const store = await checkpointFrom("slow://x");
    expect(store).toBeInstanceOf(InMemoryWorkflowCheckpointStore);
  });

  test("registering a taken scheme without replace fails, with replace it takes over", async () => {
    register("dup", { checkpointStore: () => stubStore() });
    syncStorageError(
      () => registerWorkflowStorageProvider("dup", {}),
      "WORKFLOW_STORAGE_SCHEME_ALREADY_REGISTERED",
    );
    syncStorageError(
      () => registerWorkflowStorageProvider("memory", {}),
      "WORKFLOW_STORAGE_SCHEME_ALREADY_REGISTERED",
    );
    const marker = new InMemoryWorkflowCheckpointStore();
    register("DUP", { checkpointStore: () => marker }, { replace: true });
    expect(await checkpointFrom("dup://x")).toBe(marker);
  });

  test("unregistering restores the registration it replaced", async () => {
    const first = new InMemoryWorkflowCheckpointStore();
    const second = new InMemoryWorkflowCheckpointStore();
    register("swap", { checkpointStore: () => first });
    const restore = register(
      "swap",
      { checkpointStore: () => second },
      { replace: true },
    );
    expect(await checkpointFrom("swap://x")).toBe(second);
    restore();
    expect(await checkpointFrom("swap://x")).toBe(first);
  });

  test("replacing a built-in scheme is undone by unregistering", async () => {
    const marker = new InMemoryWorkflowCheckpointStore();
    const restore = register(
      "memory",
      { checkpointStore: () => marker },
      { replace: true },
    );
    expect(await checkpointFrom("memory://")).toBe(marker);
    const builtInEntry = listWorkflowStorageSchemes().find(
      (entry) => entry.scheme === "memory",
    );
    expect(builtInEntry?.builtIn).toBe(false);
    restore();
    const store = await checkpointFrom("memory://");
    expect(store).not.toBe(marker);
    expect(store).toBeInstanceOf(InMemoryWorkflowCheckpointStore);
    expect(
      listWorkflowStorageSchemes().find((entry) => entry.scheme === "memory")
        ?.builtIn,
    ).toBe(true);
    const exporter = await exporterFrom("memory://");
    expect(exporter).toBeInstanceOf(InMemoryWorkflowEventExporter);
  });

  test("unregistering a custom scheme removes it, and calling it twice is harmless", async () => {
    const unregister = register("gone", { checkpointStore: () => stubStore() });
    unregister();
    unregister();
    await storageError(
      getWorkflowCheckpointStoreFromUri("gone://x"),
      "WORKFLOW_STORAGE_UNKNOWN_SCHEME",
    );
    expect(
      listWorkflowStorageSchemes().some((entry) => entry.scheme === "gone"),
    ).toBe(false);
  });

  test("an old unregister function does not remove a newer registration", async () => {
    const first = register("stale", { checkpointStore: () => stubStore() });
    first();
    const marker = new InMemoryWorkflowCheckpointStore();
    register("stale", { checkpointStore: () => marker });
    first();
    expect(await checkpointFrom("stale://x")).toBe(marker);
  });

  test("a scheme must start with a letter and use letters, digits, + - .", () => {
    for (const scheme of ["", "1abc", "a b", "a://", "a_b", "-x", "a/b"]) {
      syncStorageError(
        () => registerWorkflowStorageProvider(scheme, {}),
        "WORKFLOW_STORAGE_INVALID_URI",
      );
    }
    register("a1+b-c.d", {});
  });

  test("a factory without the requested capability is unsupported", async () => {
    register("only-cp", { checkpointStore: () => stubStore() });
    register("only-ev", {
      eventExporter: () => new InMemoryWorkflowEventExporter(),
    });
    await storageError(
      getWorkflowEventExporterFromUri("only-cp://x"),
      "WORKFLOW_STORAGE_UNSUPPORTED",
    );
    await storageError(
      getWorkflowCheckpointStoreFromUri("only-ev://x"),
      "WORKFLOW_STORAGE_UNSUPPORTED",
    );
  });
});

describe("registry errors", () => {
  test("an unknown scheme is WORKFLOW_STORAGE_UNKNOWN_SCHEME for both capabilities", async () => {
    await storageError(
      getWorkflowCheckpointStoreFromUri("nosuch://host/x"),
      "WORKFLOW_STORAGE_UNKNOWN_SCHEME",
    );
    await storageError(
      getWorkflowEventExporterFromUri("nosuch://host/x"),
      "WORKFLOW_STORAGE_UNKNOWN_SCHEME",
    );
  });

  test("a malformed URI is WORKFLOW_STORAGE_INVALID_URI", async () => {
    for (const uri of ["", "not a uri", "://nohost", "memory:/", "1x://a"]) {
      await storageError(
        getWorkflowCheckpointStoreFromUri(uri),
        "WORKFLOW_STORAGE_INVALID_URI",
      );
      await storageError(
        getWorkflowEventExporterFromUri(uri),
        "WORKFLOW_STORAGE_INVALID_URI",
      );
    }
  });

  test("a relative path is WORKFLOW_STORAGE_INVALID_URI", async () => {
    for (const uri of [
      "file://relative/dir",
      "sqlite://relative.db",
      "sqlite://./w.db",
      "file://",
      "sqlite://",
    ]) {
      await storageError(
        getWorkflowCheckpointStoreFromUri(uri),
        "WORKFLOW_STORAGE_INVALID_URI",
      );
    }
    await storageError(
      getWorkflowEventExporterFromUri("file://relative/dir"),
      "WORKFLOW_STORAGE_INVALID_URI",
    );
    await storageError(
      getWorkflowEventExporterFromUri("sqlite://relative.db"),
      "WORKFLOW_STORAGE_INVALID_URI",
    );
  });

  test("an unknown query parameter is WORKFLOW_STORAGE_INVALID_URI and names the parameter", async () => {
    const dir = tempDir();
    const error = await storageError(
      getWorkflowCheckpointStoreFromUri(`sqlite://${dir}/w.db?bogus=1`),
      "WORKFLOW_STORAGE_INVALID_URI",
    );
    expect(error.message).toContain("bogus");
    await storageError(
      getWorkflowCheckpointStoreFromUri(`file://${dir}?bogus=1`),
      "WORKFLOW_STORAGE_INVALID_URI",
    );
    await storageError(
      getWorkflowCheckpointStoreFromUri("memory://?bogus=1"),
      "WORKFLOW_STORAGE_INVALID_URI",
    );
    await storageError(
      getWorkflowEventExporterFromUri(`sqlite://${dir}/e.db?bogus=1`),
      "WORKFLOW_STORAGE_INVALID_URI",
    );
    await storageError(
      getWorkflowEventExporterFromUri(`file://${dir}?bogus=1`),
      "WORKFLOW_STORAGE_INVALID_URI",
    );
  });

  test("a query parameter of the wrong type or value is WORKFLOW_STORAGE_INVALID_URI", async () => {
    const dir = tempDir();
    for (const query of [
      "busyTimeoutMs=abc",
      "busyTimeoutMs=1.5",
      "busyTimeoutMs=",
      "synchronous=off",
    ]) {
      await storageError(
        getWorkflowCheckpointStoreFromUri(`sqlite://${dir}/w.db?${query}`),
        "WORKFLOW_STORAGE_INVALID_URI",
      );
    }
    await storageError(
      getWorkflowEventExporterFromUri(`file://${dir}?sync=sometimes`),
      "WORKFLOW_STORAGE_INVALID_URI",
    );
    await storageError(
      getWorkflowCheckpointStoreFromUri(`file://${dir}?maxCheckpointBytes=big`),
      "WORKFLOW_STORAGE_INVALID_URI",
    );
  });

  test("a failed lookup never creates storage as a fallback", async () => {
    const dir = tempDir();
    const path = join(dir, "never.db");
    await storageError(
      getWorkflowCheckpointStoreFromUri(`sqlite://${path}?bogus=1`),
      "WORKFLOW_STORAGE_INVALID_URI",
    );
    await storageError(
      getWorkflowCheckpointStoreFromUri(`nosuch://${path}`),
      "WORKFLOW_STORAGE_UNKNOWN_SCHEME",
    );
    expect(existsSync(path)).toBe(false);
  });

  test("error messages and details carry the redacted URI, never the password", async () => {
    const cases: Array<[string, WorkflowStorageErrorCode]> = [
      [`nosuch://app:${SECRET}@db/w`, "WORKFLOW_STORAGE_UNKNOWN_SCHEME"],
      [`postgres://app:${SECRET}@db/w?bogus=1`, "WORKFLOW_STORAGE_INVALID_URI"],
      [`sqlite://app:${SECRET}@host/rel.db`, "WORKFLOW_STORAGE_INVALID_URI"],
    ];
    for (const [uri, code] of cases) {
      const error = await storageError(
        getWorkflowCheckpointStoreFromUri(uri),
        code,
      );
      expect(error.message).not.toContain(SECRET);
      expect(JSON.stringify(error.details)).not.toContain(SECRET);
      expect(error.message).toContain("***");
    }
    const unsupported = await storageError(
      getWorkflowEventExporterFromUri(`postgres://app:${SECRET}@db/w`),
      "WORKFLOW_STORAGE_UNSUPPORTED",
    );
    expect(unsupported.message).not.toContain(SECRET);
    expect(JSON.stringify(unsupported.details)).not.toContain(SECRET);
  });

  // Skipped under Node: the child test file uses `mock.module` of `bun:test`.
  test.skipIf(!isBun)(
    "a missing runtime module or peer is WORKFLOW_STORAGE_DRIVER_MISSING",
    async () => {
      const dir = tempDir();
      const root = join(import.meta.dir, "..", "..", "..");
      const script = join(dir, "driver-missing.test.ts");
      const registry = join(root, "src/workflows/storage/registry.ts");
      const sqliteCheckpoint = join(
        root,
        "src/workflows/checkpoint/sqlite/index.ts",
      );
      const sqliteEvents = join(root, "src/workflows/events/sqlite/index.ts");
      writeFileSync(
        script,
        `import { expect, mock, test } from "bun:test";
mock.module(${JSON.stringify(sqliteCheckpoint)}, () => {
  throw Object.assign(new Error("Cannot find module 'node:sqlite'"), { code: "ERR_MODULE_NOT_FOUND" });
});
mock.module(${JSON.stringify(sqliteEvents)}, () => {
  throw Object.assign(new Error("Cannot find module 'node:sqlite'"), { code: "ERR_MODULE_NOT_FOUND" });
});
mock.module("@google/adk", () => ({
  getSessionServiceFromUri: () => {
    throw Object.assign(new Error("Cannot find package '@mikro-orm/postgresql'"), { code: "ERR_MODULE_NOT_FOUND" });
  },
}));
const { getWorkflowCheckpointStoreFromUri, getWorkflowEventExporterFromUri } = await import(${JSON.stringify(registry)});
async function code(promise: Promise<unknown>) {
  try { await promise; } catch (error: any) { return { code: error.code, message: String(error.message) }; }
  return { code: "none", message: "" };
}
test("driver missing", async () => {
  const results = [
    await code(getWorkflowCheckpointStoreFromUri("sqlite:///tmp/x.db")),
    await code(getWorkflowEventExporterFromUri("sqlite:///tmp/x.db")),
    await code(getWorkflowCheckpointStoreFromUri("postgres://app:${SECRET}@db/w")),
  ];
  console.log("RESULT=" + JSON.stringify(results));
  expect(results.length).toBe(3);
});
`,
      );
      const child = Bun.spawn([process.execPath, "test", script], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
      const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      await child.exited;
      clearTimeout(timer);
      const line = `${stdout}\n${stderr}`
        .split("\n")
        .find((candidate) => candidate.startsWith("RESULT="));
      if (line === undefined)
        throw new Error(`no result: ${stdout}\n${stderr}`);
      const results = JSON.parse(line.slice("RESULT=".length)) as Array<{
        code: string;
        message: string;
      }>;
      for (const result of results) {
        expect(result.code).toBe("WORKFLOW_STORAGE_DRIVER_MISSING");
        expect(result.message).not.toContain(SECRET);
      }
    },
  );
});
