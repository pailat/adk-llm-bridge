// Runs the storage conformance cases under Node's own test runner, from dist:
//   bun run build && node --test scripts/node-storage-conformance.mjs
// The cases come from the runner-agnostic harness, so another suite can reuse
// this file as a template: add a `defineCases` call for its provider.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { SqliteWorkflowCheckpointStore } from "../dist/workflows/checkpoint/sqlite/index.js";
import { SqliteWorkflowEventExporter } from "../dist/workflows/events/sqlite/index.js";
import { JsonlWorkflowEventExporter } from "../dist/workflows/index.js";
import {
  defineWorkflowStorageConformanceTests,
  workflowCheckpointStoreConformanceCases,
  workflowEventExporterConformanceCases,
} from "../dist/workflows/storage/conformance/index.js";

const directories = new Map();

function newDirectory() {
  return mkdtempSync(join(tmpdir(), "storage-conformance-"));
}

function removeDirectory(provider) {
  const directory = directories.get(provider);
  if (directory) rmSync(directory, { recursive: true, force: true });
}

/** Registers `cases` under `name` with node:test. */
function defineCases(name, cases) {
  describe(name, () => {
    defineWorkflowStorageConformanceTests(cases, { test, skip: test.skip });
  });
}

function sqliteCheckpointStore(directory) {
  return new SqliteWorkflowCheckpointStore({
    path: join(directory, "conformance.db"),
  });
}

function sqliteEventExporter(directory) {
  return new SqliteWorkflowEventExporter({
    path: join(directory, "conformance.db"),
  });
}

function jsonlEventExporter(directory) {
  return new JsonlWorkflowEventExporter({ directory });
}

function exporterOptions(make) {
  return {
    createExporter: () => {
      const directory = newDirectory();
      const exporter = make(directory);
      directories.set(exporter, directory);
      return exporter;
    },
    reopenExporter: (exporter) => {
      const directory = directories.get(exporter);
      const reopened = make(directory);
      directories.set(reopened, directory);
      return reopened;
    },
    destroyExporter: removeDirectory,
  };
}

defineCases(
  "SQLite checkpoint store conformance",
  await workflowCheckpointStoreConformanceCases({
    createStore: () => {
      const directory = newDirectory();
      const store = sqliteCheckpointStore(directory);
      directories.set(store, directory);
      return store;
    },
    reopenStore: (store) => {
      const directory = directories.get(store);
      const reopened = sqliteCheckpointStore(directory);
      directories.set(reopened, directory);
      return reopened;
    },
    destroyStore: removeDirectory,
  }),
);

defineCases(
  "SQLite event exporter conformance",
  await workflowEventExporterConformanceCases(
    exporterOptions(sqliteEventExporter),
  ),
);

defineCases(
  "JSONL event exporter conformance",
  await workflowEventExporterConformanceCases(
    exporterOptions(jsonlEventExporter),
  ),
);
