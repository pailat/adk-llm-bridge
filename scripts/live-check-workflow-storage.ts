/**
 * Live check of the workflow storage providers. Run by hand with Claude
 * credentials; it is not part of CI.
 *
 *   bun scripts/live-check-workflow-storage.ts
 *
 * One SQLite file holds the checkpoints and the events. A child process runs
 * a three-step workflow and the parent kills it with SIGKILL as soon as step 2
 * has started. A second child resumes the execution and stops where step 3
 * asks for human input; a third child answers it. The parent then checks the
 * stored event log and the checkpoint, prints the sequence range it verified
 * and exits non-zero when any assertion fails.
 *
 * Needs: Claude credentials usable by the Claude Agent SDK, `node:sqlite`
 * (Bun or Node 22.13+), and `@opentelemetry/sdk-trace-base` for the span
 * records (`bun add -d @opentelemetry/sdk-trace-base`, not a dependency of
 * the package).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BaseAgent,
  createEvent,
  type Event,
  InMemorySessionService,
  type InvocationContext,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  Runner,
} from "@google/adk";
import type { Content } from "@google/genai";
import { context, trace } from "@opentelemetry/api";
import { ClaudeAgent } from "../src/agents/claude-agent.js";
import { SqliteWorkflowCheckpointStore } from "../src/workflows/checkpoint/sqlite/index.js";
import { defineWorkflow } from "../src/workflows/definition.js";
import { SqliteWorkflowEventExporter } from "../src/workflows/events/sqlite/index.js";
import type { WorkflowEvent } from "../src/workflows/events.js";
import type {
  AcquireWorkflowCheckpointLeaseInput,
  WorkflowCheckpointLease,
} from "../src/workflows/storage/checkpoint-store.js";
import { isWorkflowStorageError } from "../src/workflows/storage/errors.js";
import { WorkflowEventExportPlugin } from "../src/workflows/storage/event-export-plugin.js";
import type { WorkflowEventRecord } from "../src/workflows/storage/event-exporter.js";
import { LeasedWorkflowCheckpointStore } from "../src/workflows/storage/leased-checkpoint-store.js";
import {
  getWorkflowCheckpointStoreFromUri,
  getWorkflowEventExporterFromUri,
} from "../src/workflows/storage/registry.js";
import { WorkflowSpanExportProcessor } from "../src/workflows/storage/span-export-processor.js";
import { WorkflowAgent } from "../src/workflows/workflow-agent.js";

const SCRIPT = resolve(import.meta.path);
const APP_NAME = "live-check-workflow-storage";
const USER_ID = "live-check-user";
const WORKFLOW_ID = "live-check-workflow";
const MODEL = process.env.LIVE_CHECK_MODEL ?? "claude-haiku-4-5";
const LEASE_TTL_MS = 5_000;
const ASK_CALL_ID = "live-check-ask";
const STEP_TIMEOUT_MS = 5 * 60_000;

type Phase = "first" | "resume" | "answer";

interface ChildArgs {
  phase: Phase;
  database: string;
  sessionId: string;
  executionId: string;
}

function readChildArgs(): ChildArgs | undefined {
  const index = process.argv.indexOf("--child");
  if (index === -1) return undefined;
  const [phase, database, sessionId, executionId] = process.argv.slice(
    index + 1,
  );
  if (
    (phase !== "first" && phase !== "resume" && phase !== "answer") ||
    !database ||
    !sessionId ||
    !executionId
  ) {
    throw new Error("bad --child arguments");
  }
  return { phase, database, sessionId, executionId };
}

// ---------------------------------------------------------------------------
// Child: runs the workflow
// ---------------------------------------------------------------------------

/** Step 3: asks for human input until a turn answers it. */
class AskHumanAgent extends BaseAgent {
  constructor() {
    super({ name: "ask_human" });
  }

  protected async *runAsyncImpl(
    invocation: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const response = invocation.userContent?.parts?.find(
      (part) => part.functionResponse,
    )?.functionResponse;
    if (response) {
      yield createEvent({
        invocationId: invocation.invocationId,
        author: this.name,
        content: {
          role: "model",
          parts: [{ text: `human answered: ${JSON.stringify(response)}` }],
        },
      });
      return;
    }
    yield createEvent({
      invocationId: invocation.invocationId,
      author: this.name,
      content: {
        role: "model",
        parts: [
          {
            functionCall: {
              id: ASK_CALL_ID,
              name: REQUEST_INPUT_FUNCTION_CALL_NAME,
              args: { message: "Approve the release?" },
            },
          },
        ],
      },
      longRunningToolIds: [ASK_CALL_ID],
    });
  }

  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {}
}

/** Reports every lease the child takes, so the parent can compare tokens. */
class ReportingSqliteCheckpointStore extends SqliteWorkflowCheckpointStore {
  override async acquireLease(
    input: AcquireWorkflowCheckpointLeaseInput,
  ): Promise<WorkflowCheckpointLease> {
    const lease = await super.acquireLease(input);
    console.log(`LEASE ${lease.fencingToken}`);
    return lease;
  }
}

async function loadTracerProvider(): Promise<{
  provider: { shutdown(): Promise<void> };
  install(processor: WorkflowSpanExportProcessor): void;
}> {
  let sdk: {
    BasicTracerProvider: new (options: {
      spanProcessors: unknown[];
    }) => {
      shutdown(): Promise<void>;
    };
  };
  try {
    const name = "@opentelemetry/sdk-trace-base";
    sdk = (await import(name)) as typeof sdk;
  } catch {
    throw new Error(
      "@opentelemetry/sdk-trace-base is needed for the span records: bun add -d @opentelemetry/sdk-trace-base",
    );
  }
  try {
    const name = "@opentelemetry/context-async-hooks";
    const hooks = (await import(name)) as {
      AsyncLocalStorageContextManager: new () => { enable(): unknown };
    };
    const manager = new hooks.AsyncLocalStorageContextManager();
    manager.enable();
    context.setGlobalContextManager(manager as never);
  } catch {
    // Without a context manager spans still export; correlation is weaker.
  }
  let holder: { shutdown(): Promise<void> } | undefined;
  return {
    get provider() {
      return holder as { shutdown(): Promise<void> };
    },
    install(processor) {
      holder = new sdk.BasicTracerProvider({ spanProcessors: [processor] });
      trace.setGlobalTracerProvider(holder as never);
    },
  };
}

async function retryOnLeaseHeld<T>(action: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 4 * LEASE_TTL_MS;
  for (;;) {
    try {
      return await action();
    } catch (error) {
      const held =
        isWorkflowStorageError(error, "WORKFLOW_STORAGE_LEASE_HELD") ||
        ((error as { cause?: unknown })?.cause !== undefined &&
          isWorkflowStorageError(
            (error as { cause?: unknown }).cause,
            "WORKFLOW_STORAGE_LEASE_HELD",
          ));
      if (!held || Date.now() > deadline) throw error;
      await new Promise((done) => setTimeout(done, 500));
    }
  }
}

async function runChild(args: ChildArgs): Promise<void> {
  const checkpoints = new ReportingSqliteCheckpointStore({
    path: args.database,
  });
  const exporter = new SqliteWorkflowEventExporter({ path: args.database });
  const leased = new LeasedWorkflowCheckpointStore({
    store: checkpoints,
    ttlMs: LEASE_TTL_MS,
  });
  const plugin = new WorkflowEventExportPlugin({ exporter });
  const tracing = await loadTracerProvider();
  tracing.install(
    new WorkflowSpanExportProcessor({ pipeline: plugin.pipeline }),
  );

  const step1 = new ClaudeAgent({
    name: "step_one",
    description: "Answers a short prompt",
    instruction: "Answer in one short sentence.",
    driverOptions: { model: MODEL },
  });
  const step2 = new ClaudeAgent({
    name: "step_two",
    description: "Runs a long task",
    instruction: "Follow the task exactly and do not shorten it.",
    driverOptions: { model: MODEL },
  });
  const step3 = new AskHumanAgent();

  const workflow = new WorkflowAgent({
    name: "live_check",
    subAgents: [step1, step2, step3],
    checkpointStore: leased,
    resolveExecutionId: () => args.executionId,
    definition: defineWorkflow({
      id: WORKFLOW_ID,
      version: "1",
      handler: async (ctx) => {
        await ctx.run({
          id: "step1",
          agentName: "step_one",
          input: "Name one planet of the solar system.",
        });
        await ctx.run({
          id: "step2",
          agentName: "step_two",
          resumePolicy: "retry",
          input:
            "Write the numbers 1 to 150, each on its own line as 'N: a short sentence about N'. Then write a closing paragraph of about 120 words.",
        });
        const asked = await ctx.run({
          id: "step3",
          agentName: "ask_human",
          input: ctx.inputText,
        });
        return asked.output;
      },
    }),
  });

  const sessions = new InMemorySessionService();
  await sessions.createSession({
    appName: APP_NAME,
    userId: USER_ID,
    sessionId: args.sessionId,
  });
  const runner = new Runner({
    appName: APP_NAME,
    agent: workflow,
    sessionService: sessions,
    plugins: [plugin],
  });
  const message: Content =
    args.phase === "answer"
      ? {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: ASK_CALL_ID,
                name: REQUEST_INPUT_FUNCTION_CALL_NAME,
                response: { approved: true },
              },
            },
          ],
        }
      : { role: "user", parts: [{ text: "Run the live check workflow." }] };

  const types: string[] = [];
  await retryOnLeaseHeld(async () => {
    types.length = 0;
    for await (const event of runner.runAsync({
      userId: USER_ID,
      sessionId: args.sessionId,
      newMessage: message,
    })) {
      const workflowEvent = event.customMetadata?.workflowEvent as
        | WorkflowEvent
        | undefined;
      if (workflowEvent?.type && workflowEvent.type !== "checkpoint_saved") {
        types.push(workflowEvent.type);
      }
    }
  });
  await plugin.pipeline.flush(15_000);
  console.log(`RESULT ${JSON.stringify({ phase: args.phase, types })}`);
  await tracing.provider.shutdown();
  await plugin.pipeline.close(15_000);
  await leased.close();
  await exporter.close();
}

// ---------------------------------------------------------------------------
// Parent: orchestrates the children and asserts
// ---------------------------------------------------------------------------

const failures: string[] = [];

function check(condition: boolean, description: string): void {
  if (condition) {
    console.log(`  ok    ${description}`);
  } else {
    failures.push(description);
    console.log(`  FAIL  ${description}`);
  }
}

interface ChildHandle {
  child: ReturnType<typeof Bun.spawn>;
  output: Promise<{ stdout: string; stderr: string; code: number | null }>;
}

function spawnChild(args: ChildArgs): ChildHandle {
  const child = Bun.spawn(
    [
      process.execPath,
      SCRIPT,
      "--child",
      args.phase,
      args.database,
      args.sessionId,
      args.executionId,
    ],
    { stdout: "pipe", stderr: "pipe", env: process.env },
  );
  const output = (async () => {
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout as ReadableStream).text(),
      new Response(child.stderr as ReadableStream).text(),
    ]);
    const code = await child.exited;
    return { stdout, stderr, code };
  })();
  return { child, output };
}

function leaseTokens(stdout: string): number[] {
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("LEASE "))
    .map((line) => Number(line.slice("LEASE ".length)));
}

function resultTypes(stdout: string): string[] {
  const line = stdout.split("\n").find((entry) => entry.startsWith("RESULT "));
  if (line === undefined) return [];
  return (JSON.parse(line.slice("RESULT ".length)) as { types: string[] })
    .types;
}

async function readAll(
  exporter: Awaited<ReturnType<typeof getWorkflowEventExporterFromUri>>,
  executionId: string,
): Promise<WorkflowEventRecord[]> {
  const records: WorkflowEventRecord[] = [];
  let after = 0;
  for (;;) {
    const page = await exporter.read({
      executionId,
      afterSequence: after,
      limit: 200,
    });
    records.push(...page.records);
    if (!page.hasMore) return records;
    after = page.nextAfterSequence;
  }
}

function indexOfRecord(
  records: readonly WorkflowEventRecord[],
  from: number,
  predicate: (record: WorkflowEventRecord) => boolean,
): number {
  for (let index = from; index < records.length; index += 1) {
    const record = records[index];
    if (record !== undefined && predicate(record)) return index;
  }
  return -1;
}

async function runParent(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "live-check-storage-"));
  const database = join(directory, "workflows.db");
  const sessionId = `live-session-${Date.now()}`;
  const executionId = `live-exec-${Date.now()}`;
  const uri = `sqlite://${database}`;
  const base = { database, sessionId, executionId };
  const exporter = await getWorkflowEventExporterFromUri(uri);
  const store = await getWorkflowCheckpointStoreFromUri(uri);
  try {
    console.log(`database ${database}`);
    console.log("1. first child runs until step 2 starts");
    const first = spawnChild({ ...base, phase: "first" });
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    let started = false;
    let exited = false;
    void first.output.then(() => {
      exited = true;
    });
    while (!started && !exited && Date.now() < deadline) {
      const page = await exporter.read({
        executionId,
        types: ["step_started"],
        limit: 50,
      });
      started = page.records.some((record) => record.stepId === "step2");
      if (!started) await new Promise((done) => setTimeout(done, 200));
    }
    check(started, "step_started of step 2 was stored while the child ran");
    if (!started) {
      first.child.kill("SIGKILL");
      const output = await first.output;
      console.log(output.stderr.slice(-2000));
      return;
    }
    first.child.kill("SIGKILL");
    const killed = await first.output;
    check(
      killed.code !== 0,
      "the first child ended without finishing (SIGKILL)",
    );
    const firstTokens = leaseTokens(killed.stdout);
    check(firstTokens.length >= 1, "the first child took a lease");

    console.log("2. second child resumes the same session and execution");
    const resumed = await spawnChild({ ...base, phase: "resume" }).output;
    check(resumed.code === 0, "the resumed child exited 0");
    if (resumed.code !== 0) console.log(resumed.stderr.slice(-2000));
    const secondTokens = leaseTokens(resumed.stdout);
    check(
      secondTokens.length >= 1 &&
        secondTokens[0] !== undefined &&
        firstTokens[0] !== undefined &&
        secondTokens[0] > firstTokens[0],
      "the resumed child took the lease after expiry with a higher token",
    );
    const resumedTypes = resultTypes(resumed.stdout);
    check(
      resumedTypes.at(-1) === "workflow_waiting",
      "the resumed run ends with workflow_waiting",
    );

    console.log("3. third child answers the human input");
    const answered = await spawnChild({ ...base, phase: "answer" }).output;
    check(answered.code === 0, "the answering child exited 0");
    if (answered.code !== 0) console.log(answered.stderr.slice(-2000));
    check(
      resultTypes(answered.stdout).includes("workflow_completed"),
      "the answered run completes",
    );

    console.log("4. assertions on the stored log and checkpoint");
    const records = await readAll(exporter, executionId);
    const sequences = records.map((record) => record.sequence);
    check(
      records.length > 0 &&
        sequences.every((sequence, index) => sequence === index + 1),
      `sequences are exactly 1..${records.length}`,
    );
    check(
      new Set(records.map((record) => record.id)).size === records.length,
      "record ids are unique",
    );
    const type =
      (name: string, stepId?: string, attempt?: number) =>
      (record: WorkflowEventRecord): boolean =>
        record.type === name &&
        (stepId === undefined || record.stepId === stepId) &&
        (attempt === undefined || record.attempt === attempt);
    const order = [
      { label: "workflow_started", match: type("workflow_started") },
      {
        label: "step_completed(step1)",
        match: type("step_completed", "step1"),
      },
      {
        label: "step_started(step2, attempt 1)",
        match: type("step_started", "step2", 1),
      },
      { label: "workflow_started (resume)", match: type("workflow_started") },
      { label: "step_replayed(step1)", match: type("step_replayed", "step1") },
      {
        label: "step_started(step2, attempt 2)",
        match: type("step_started", "step2", 2),
      },
      {
        label: "step_completed(step2)",
        match: type("step_completed", "step2"),
      },
      { label: "step_waiting(step3)", match: type("step_waiting", "step3") },
      { label: "workflow_waiting", match: type("workflow_waiting") },
      {
        label: "step_completed(step3)",
        match: type("step_completed", "step3"),
      },
      { label: "workflow_completed", match: type("workflow_completed") },
    ];
    let cursor = 0;
    let previous = -1;
    let ordered = true;
    for (const entry of order) {
      const found = indexOfRecord(records, cursor, entry.match);
      if (found === -1 || found <= previous) {
        ordered = false;
        check(false, `order: ${entry.label} appears after the previous one`);
        break;
      }
      previous = found;
      cursor = found + 1;
    }
    if (ordered) check(true, "the record order matches the expected sequence");
    const attemptTwo = records.find(type("step_started", "step2", 2));
    check(
      attemptTwo?.payload.resumeReason === "interrupted",
      'step 2 attempt 2 carries resumeReason "interrupted"',
    );
    check(
      records.some((record) => record.kind === "agent_run"),
      "agent_run records exist",
    );
    check(
      records.some((record) => record.kind === "span"),
      "span records exist",
    );
    check(
      !records.some(
        (record) =>
          record.type === "WORKFLOW_EVENT_EXPORT_DROPPED" ||
          record.payload.code === "WORKFLOW_EVENT_EXPORT_DROPPED",
      ),
      "no WORKFLOW_EVENT_EXPORT_DROPPED record",
    );
    const stored = await store.get({ workflowId: WORKFLOW_ID, executionId });
    check(
      stored?.checkpoint.status === "completed",
      "the checkpoint status is completed",
    );
    check(
      stored?.checkpoint.steps.step2?.status === "completed",
      "step 2 is completed in the checkpoint",
    );
    const eventHealth = await exporter.healthCheck();
    const storeHealth = await store.healthCheck();
    check(eventHealth.ok, "the event exporter health check is ok");
    check(storeHealth.ok, "the checkpoint store health check is ok");
    if (sequences.length > 0) {
      console.log(
        `verified sequences ${sequences[0]}..${sequences.at(-1)} (${records.length} records) of ${executionId}`,
      );
    }
  } finally {
    await exporter.close();
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const childArgs = readChildArgs();
try {
  if (childArgs) {
    await runChild(childArgs);
  } else {
    await runParent();
    if (failures.length > 0) {
      console.error(`\n${failures.length} assertion(s) failed:`);
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exit(1);
    }
    console.log("\nlive check passed");
  }
} catch (error) {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exit(1);
}
