import { describe, expect, test } from "bun:test";
import * as sqliteCheckpoints from "../../../src/workflows/checkpoint/sqlite/index.js";
import type { WorkflowCheckpointLocator } from "../../../src/workflows/checkpoint/store.js";
import * as sqliteEvents from "../../../src/workflows/events/sqlite/index.js";
import * as workflows from "../../../src/workflows/index.js";
import {
  type AppendWorkflowEventRecordsResult,
  BaseWorkflowCheckpointStore,
  BaseWorkflowEventExporter,
  isWorkflowCheckpointProvider,
  isWorkflowStorageError,
  type ReadWorkflowEventRecordsResult,
  type StoredWorkflowCheckpoint,
  type WorkflowCheckpointStore,
  type WorkflowCheckpointStoreCapabilities,
  type WorkflowCheckpointWriteRequest,
  type WorkflowEventExporterCapabilities,
  WorkflowStorageError,
} from "../../../src/workflows/index.js";
import * as conformance from "../../../src/workflows/storage/conformance/index.js";
import * as storageSupport from "../../../src/workflows/storage/support.js";

// A provider written outside the package needs only the two storage
// primitives; this class must keep compiling against the public contract.
class ThirdPartyCheckpointStore extends BaseWorkflowCheckpointStore {
  readonly providerName = "third-party";
  readonly capabilities: WorkflowCheckpointStoreCapabilities = {
    compareAndSet: "advisory",
    leases: false,
    durable: false,
    multiProcess: false,
    listing: false,
    pruning: false,
    maxCheckpointBytes: 1024,
  };

  protected async readCheckpoint(
    _locator: WorkflowCheckpointLocator,
  ): Promise<StoredWorkflowCheckpoint | undefined> {
    return undefined;
  }

  protected async writeCheckpoint(
    _request: WorkflowCheckpointWriteRequest,
  ): Promise<number> {
    return 0;
  }
}

class ThirdPartyEventExporter extends BaseWorkflowEventExporter {
  readonly providerName = "third-party";
  readonly capabilities: WorkflowEventExporterCapabilities = {
    durable: false,
    multiProcess: false,
    listing: false,
    pruning: false,
    maxRecordBytes: 1024,
  };

  protected async appendRecords(): Promise<AppendWorkflowEventRecordsResult> {
    return { records: [], lastSequence: 0 };
  }

  protected async readRecords(): Promise<ReadWorkflowEventRecordsResult> {
    return { records: [], nextAfterSequence: 0, hasMore: false };
  }
}

describe("workflow storage provider contract surface", () => {
  test("a third-party checkpoint provider is a checkpoint store the runtime accepts", () => {
    const store: WorkflowCheckpointStore = new ThirdPartyCheckpointStore();
    expect(isWorkflowCheckpointProvider(store)).toBe(true);
    expect(new ThirdPartyCheckpointStore().contractVersion).toBe(
      workflows.WORKFLOW_CHECKPOINT_STORE_CONTRACT_VERSION,
    );
  });

  test("a third-party event exporter carries the contract version", () => {
    expect(new ThirdPartyEventExporter().contractVersion).toBe(
      workflows.WORKFLOW_EVENT_EXPORTER_CONTRACT_VERSION,
    );
  });

  test("only transient storage errors are retryable by default", () => {
    expect(
      new WorkflowStorageError("WORKFLOW_STORAGE_UNAVAILABLE", "busy")
        .retryable,
    ).toBe(true);
    expect(
      new WorkflowStorageError("WORKFLOW_STORAGE_TIMEOUT", "slow").retryable,
    ).toBe(true);
    const corrupt = new WorkflowStorageError(
      "WORKFLOW_STORAGE_CORRUPT",
      "bad row",
      { details: { provider: "sqlite" } },
    );
    expect(corrupt.retryable).toBe(false);
    expect(corrupt.details).toEqual({ provider: "sqlite" });
    expect(isWorkflowStorageError(corrupt, "WORKFLOW_STORAGE_CORRUPT")).toBe(
      true,
    );
    expect(isWorkflowStorageError(corrupt, "WORKFLOW_STORAGE_TIMEOUT")).toBe(
      false,
    );
    expect(isWorkflowStorageError(new Error("other"))).toBe(false);
  });

  test("the workflows entry exposes the provider model", () => {
    for (const value of [
      workflows.BaseWorkflowCheckpointStore,
      workflows.InMemoryWorkflowCheckpointStore,
      workflows.FileSystemWorkflowCheckpointProvider,
      workflows.AdkSessionServiceWorkflowCheckpointStore,
      workflows.LeasedWorkflowCheckpointStore,
      workflows.BaseWorkflowEventExporter,
      workflows.InMemoryWorkflowEventExporter,
      workflows.JsonlWorkflowEventExporter,
      workflows.WorkflowEventExportPipeline,
      workflows.WorkflowEventExportPlugin,
      workflows.WorkflowSpanExportProcessor,
      workflows.registerWorkflowStorageProvider,
      workflows.getWorkflowCheckpointStoreFromUri,
      workflows.getWorkflowEventExporterFromUri,
      workflows.retryWorkflowStorageOperation,
    ]) {
      expect(value).toBeFunction();
    }
  });

  test("the SQLite providers and the conformance suite live in their own entries", () => {
    expect("SqliteWorkflowCheckpointStore" in workflows).toBe(false);
    expect("SqliteWorkflowEventExporter" in workflows).toBe(false);
    expect("workflowCheckpointStoreConformanceCases" in workflows).toBe(false);
    expect(sqliteCheckpoints.SqliteWorkflowCheckpointStore).toBeFunction();
    expect(sqliteEvents.SqliteWorkflowEventExporter).toBeFunction();
    expect(conformance.workflowCheckpointStoreConformanceCases).toBeFunction();
    expect(conformance.workflowEventExporterConformanceCases).toBeFunction();
    expect(conformance.defineWorkflowStorageConformanceTests).toBeFunction();
  });

  test("the support module exports the capability guard and the metric recorder", () => {
    expect(storageSupport.requireWorkflowCheckpointCapability).toBeFunction();
    expect(storageSupport.recordWorkflowStorageOperation).toBeFunction();
    expect(storageSupport.retryWorkflowStorageOperation).toBeFunction();
  });

  test("the capability guard refuses a third-party provider that is only advisory, and nothing is written", () => {
    const store = new ThirdPartyCheckpointStore();
    let thrown: unknown;
    try {
      storageSupport.requireWorkflowCheckpointCapability(
        store,
        "compareAndSet",
      );
    } catch (error) {
      thrown = error;
    }
    expect(isWorkflowStorageError(thrown, "WORKFLOW_STORAGE_UNSUPPORTED")).toBe(
      true,
    );
  });
});
