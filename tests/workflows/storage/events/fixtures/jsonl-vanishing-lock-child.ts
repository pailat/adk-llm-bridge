/**
 * Child process of jsonl-event-exporter-processes.test.ts in which the
 * directory lock always exists when the exporter tries to create it and is
 * always gone when the exporter tries to read it, as when other writers keep
 * taking and releasing it. The exporter must wait between tries instead of
 * looping without a pause until it gives up.
 *
 * Usage: `bun jsonl-vanishing-lock-child.ts <directory>`.
 *
 * Prints `reads <n> <code>`: how many times the exporter tried to read the
 * lock, and the error code of the append. The file system is replaced in
 * this process only, so the module mock cannot leak into other tests.
 */
import { mock } from "bun:test";
import { constants, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const [directory] = process.argv.slice(2);
if (!directory) {
  console.error("usage: <directory>");
  process.exit(2);
}
writeFileSync(join(directory, ".writer.lock"), "", { mode: 0o600 });

const real = { ...(await import("node:fs/promises")) };
const WRITES = constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT;
let reads = 0;

mock.module("node:fs/promises", () => ({
  ...real,
  open: async (...args: Parameters<typeof real.open>) => {
    const [path, flags] = args;
    const readOnly = typeof flags === "number" && (flags & WRITES) === 0;
    if (readOnly && basename(String(path)) === ".writer.lock") {
      reads += 1;
      throw Object.assign(new Error("ENOENT: lock released"), {
        code: "ENOENT",
      });
    }
    return await real.open(...args);
  },
}));

const { JsonlWorkflowEventExporter } = await import(
  "../../../../../src/workflows/storage/jsonl-event-exporter.js"
);

const exporter = new JsonlWorkflowEventExporter({ directory });
let code = "none";
try {
  await exporter.append({
    executionId: "vanishing-lock",
    records: [
      {
        id: "vanishing-lock-1",
        executionId: "vanishing-lock",
        kind: "workflow",
        type: "custom",
        timestamp: Date.now(),
        payload: {},
      },
    ],
  });
} catch (error) {
  code = (error as { code?: string }).code ?? "UNKNOWN";
}
console.log(`reads ${reads} ${code}`);
process.exit(0);
