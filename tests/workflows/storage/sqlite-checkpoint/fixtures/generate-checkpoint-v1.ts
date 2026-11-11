/**
 * Generates `checkpoint-v1.db`, a database written by the first release of
 * `SqliteWorkflowCheckpointStore` (schema version 1).
 *
 * Run it once, with the provider still at schema version 1:
 *
 *     bun tests/workflows/storage/sqlite-checkpoint/fixtures/generate-checkpoint-v1.ts [output path]
 *
 * It replaces the output file, which defaults to `checkpoint-v1.db` next to
 * this script. Do not run it after the schema moves past version 1: the
 * committed file must stay a version 1 database so the migration path keeps
 * being tested.
 */

import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SqliteWorkflowCheckpointStore } from "../../../../../src/workflows/checkpoint/sqlite/index.js";
import { buildCheckpoint } from "./checkpoint-worker.js";

const output =
  process.argv[2] ??
  fileURLToPath(new URL("checkpoint-v1.db", import.meta.url));

for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(output + suffix, { force: true });
}

const store = new SqliteWorkflowCheckpointStore({ path: output });
try {
  await store.put({
    checkpoint: await buildCheckpoint("compat-flow", "exec-1", 0),
  });
  await store.put({
    checkpoint: await buildCheckpoint("compat-flow", "exec-2", 1),
  });
  await store.put({
    checkpoint: await buildCheckpoint("other-flow", "exec-1", 0),
  });
} finally {
  await store.close();
}
console.log(`wrote ${output}`);
