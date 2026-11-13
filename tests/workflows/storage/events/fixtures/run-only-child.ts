/**
 * Child process of event-export-shutdown-processes.test.ts. Its only work is
 * one workflow run: nothing else keeps the process alive, so it shows whether
 * an awaited flush or close holds the event loop until the export ends.
 *
 * Usage: bun run-only-child.ts <mode> <directory>
 *
 * - `plugin`: runs with `WorkflowEventExportPlugin` over a JSONL exporter in
 *   `<directory>`; the plugin's end-of-run flush is the only wait.
 * - `flush`: offers every event to a pipeline while iterating the run, then
 *   awaits `pipeline.flush()`.
 * - `close`: same, then awaits `pipeline.close()` over an exporter whose
 *   appends wait on an unreferenced timer, like a remote exporter whose socket
 *   does not hold the process.
 *
 * After the run loop it prints `after-run <json>` with the pipeline counters
 * and the number of records the exporter holds.
 */
import {
  BaseAgent,
  createEvent,
  InMemorySessionService,
  type InvocationContext,
  Runner,
} from "@google/adk";
import { defineWorkflow } from "../../../../../src/workflows/definition.js";
import { WorkflowEventExportPipeline } from "../../../../../src/workflows/storage/event-export-pipeline.js";
import { WorkflowEventExportPlugin } from "../../../../../src/workflows/storage/event-export-plugin.js";
import type {
  AppendWorkflowEventRecordsResult,
  BaseWorkflowEventExporter,
  WorkflowEventRecordInput,
} from "../../../../../src/workflows/storage/event-exporter.js";
import { InMemoryWorkflowEventExporter } from "../../../../../src/workflows/storage/in-memory-event-exporter.js";
import { JsonlWorkflowEventExporter } from "../../../../../src/workflows/storage/jsonl-event-exporter.js";
import { WorkflowAgent } from "../../../../../src/workflows/workflow-agent.js";

const [mode, directory] = process.argv.slice(2);
if (!mode || !directory) {
  console.error("usage: <plugin|flush|close> <directory>");
  process.exit(2);
}

const EXECUTION_ID = "run-only";
// Far longer than the run: a wait that is not released early shows as a slow exit.
const LONG_WAIT_MS = 20_000;

/** Exporter whose appends finish after an unreferenced timer. */
class RemoteLikeExporter extends InMemoryWorkflowEventExporter {
  protected override async appendRecords(
    executionId: string,
    records: readonly WorkflowEventRecordInput[],
  ): Promise<AppendWorkflowEventRecordsResult> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30).unref?.();
    });
    return super.appendRecords(executionId, records);
  }
}

/** Yields one text event. */
class TextAgent extends BaseAgent {
  constructor(name: string) {
    super({ name });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: { role: "model", parts: [{ text: `${this.name} done` }] },
    });
  }

  protected async *runLiveImpl() {}
}

const exporter: BaseWorkflowEventExporter =
  mode === "close"
    ? new RemoteLikeExporter()
    : new JsonlWorkflowEventExporter({ directory, sync: "batch" });
const plugin =
  mode === "plugin"
    ? new WorkflowEventExportPlugin({ exporter, flushOnRunEndMs: LONG_WAIT_MS })
    : undefined;
const pipeline =
  plugin?.pipeline ?? new WorkflowEventExportPipeline({ exporter });

const workflow = new WorkflowAgent({
  name: "run_only",
  subAgents: [new TextAgent("first"), new TextAgent("second")],
  resolveExecutionId: () => EXECUTION_ID,
  definition: defineWorkflow({
    id: "run-only",
    version: "1",
    handler: async (ctx) => {
      await ctx.run({ id: "first", agentName: "first", input: ctx.inputText });
      const second = await ctx.run({
        id: "second",
        agentName: "second",
        input: ctx.inputText,
      });
      return second.output;
    },
  }),
});

const sessions = new InMemorySessionService();
await sessions.createSession({
  appName: "app",
  userId: "user",
  sessionId: "session",
});
const runner = new Runner({
  appName: "app",
  agent: workflow,
  sessionService: sessions,
  ...(plugin ? { plugins: [plugin] } : {}),
});

for await (const event of runner.runAsync({
  userId: "user",
  sessionId: "session",
  newMessage: { role: "user", parts: [{ text: "go" }] },
})) {
  if (!plugin) pipeline.offerAdkEvent(event);
}
if (mode === "flush") await pipeline.flush(LONG_WAIT_MS);
if (mode === "close") await pipeline.close(LONG_WAIT_MS);

const stored = await exporter.read({
  executionId: EXECUTION_ID,
  limit: 1_000,
});
console.log(
  `after-run ${JSON.stringify({ ...pipeline.stats, stored: stored.records.length })}`,
);
await pipeline.close();
await exporter.close();
