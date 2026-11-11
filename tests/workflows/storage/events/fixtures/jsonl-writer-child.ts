/**
 * Child process of jsonl-event-exporter-processes.test.ts.
 *
 * Usage: bun jsonl-writer-child.ts <mode> <directory> <executionId> [count]
 *
 * - `loop`: appends batches of three records without end and prints
 *   `acked <lastSequence>` after every append that resolved. The parent kills
 *   it with SIGKILL.
 * - `once`: appends one record and prints `ok <sequence>`, or
 *   `refused <code>` when the exporter rejects.
 * - `hold`: appends one record, prints `holding`, and keeps the exporter
 *   open until it is killed or its stdin closes.
 * - `hold-at`: like `hold`, but waits until the wall-clock time in `[count]`
 *   (milliseconds since the epoch) so that two children start together.
 */
import { JsonlWorkflowEventExporter } from "../../../../../src/workflows/storage/jsonl-event-exporter.js";

const [mode, directory, executionId, countArgument] = process.argv.slice(2);
if (!mode || !directory || !executionId) {
  console.error("usage: <mode> <directory> <executionId> [count]");
  process.exit(2);
}

const exporter = new JsonlWorkflowEventExporter({ directory, sync: "batch" });
const filler = "x".repeat(20_000);

function record(id: string) {
  return {
    id,
    executionId,
    kind: "workflow" as const,
    type: "custom",
    timestamp: Date.now(),
    payload: { filler },
  };
}

async function main(): Promise<void> {
  if (mode === "loop") {
    const limit = Number(countArgument ?? "1000000");
    for (let batch = 0; batch < limit; batch += 1) {
      const result = await exporter.append({
        executionId,
        records: [0, 1, 2].map((i) => record(`${process.pid}-${batch}-${i}`)),
      });
      console.log(`acked ${result.lastSequence}`);
    }
    return;
  }
  if (mode === "once" || mode === "hold" || mode === "hold-at") {
    if (mode === "hold-at") {
      const startAt = Number(countArgument);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, startAt - Date.now())),
      );
    }
    try {
      const result = await exporter.append({
        executionId,
        records: [record(`${process.pid}-once`)],
      });
      if (mode === "once") {
        console.log(`ok ${result.records[0]?.sequence}`);
        await exporter.close();
        return;
      }
      console.log("holding");
      await new Promise<void>((resolve) => {
        process.stdin.on("end", resolve);
        process.stdin.resume();
      });
      await exporter.close();
    } catch (error) {
      const code = (error as { code?: string }).code ?? "UNKNOWN";
      console.log(`refused ${code}`);
    }
    return;
  }
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}

await main();
