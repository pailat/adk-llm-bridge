import { describe, expect, test } from "bun:test";
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
import { defineWorkflow } from "../../../../src/workflows/definition.js";
import { WorkflowStorageError } from "../../../../src/workflows/storage/errors.js";
import type { WorkflowEventExportWarning } from "../../../../src/workflows/storage/event-export-pipeline.js";
import { WorkflowEventExportPlugin } from "../../../../src/workflows/storage/event-export-plugin.js";
import { InMemoryWorkflowEventExporter } from "../../../../src/workflows/storage/in-memory-event-exporter.js";
import { WorkflowAgent } from "../../../../src/workflows/workflow-agent.js";

class HangingExporter extends InMemoryWorkflowEventExporter {
  protected override appendRecords(): Promise<never> {
    return new Promise<never>(() => {});
  }
}

class ThrowingExporter extends InMemoryWorkflowEventExporter {
  protected override async appendRecords(): Promise<never> {
    throw new WorkflowStorageError("WORKFLOW_STORAGE_UNSUPPORTED", "boom", {
      retryable: false,
    });
  }
}

class TextAgent extends BaseAgent {
  constructor() {
    super({ name: "pre" });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: { role: "model", parts: [{ text: "pre done" }] },
    });
  }

  protected async *runLiveImpl() {}
}

class AskAgent extends BaseAgent {
  constructor() {
    super({ name: "ask" });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    const response = context.userContent?.parts?.find(
      (part) => part.functionResponse,
    )?.functionResponse;
    const part = response
      ? { text: `got ${JSON.stringify(response.response)}` }
      : {
          functionCall: {
            id: "ask-ask",
            name: REQUEST_INPUT_FUNCTION_CALL_NAME,
            args: { message: "?" },
          },
        };
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: { role: "model", parts: [part] },
      ...(response ? {} : { longRunningToolIds: ["ask-ask"] }),
    });
  }

  protected async *runLiveImpl() {}
}

const START: Content = { role: "user", parts: [{ text: "start" }] };
const ANSWER: Content = {
  role: "user",
  parts: [
    {
      functionResponse: {
        id: "ask-ask",
        name: REQUEST_INPUT_FUNCTION_CALL_NAME,
        response: { value: 1 },
      },
    },
  ],
};

function workflow() {
  return new WorkflowAgent({
    name: "wf",
    subAgents: [new TextAgent(), new AskAgent()],
    definition: defineWorkflow({
      id: "waiting",
      version: "1",
      handler: async (ctx) => {
        await ctx.run({ id: "pre", agentName: "pre", input: ctx.inputText });
        const asked = await ctx.run({
          id: "ask",
          agentName: "ask",
          input: ctx.inputText,
        });
        return asked.output;
      },
    }),
  });
}

interface Outcome {
  events: Event[][];
  errors: string[];
  durationMs: number;
}

/** Waiting turn, replay turn, then the answer, on one session. */
async function runScenario(
  plugin?: WorkflowEventExportPlugin,
): Promise<Outcome> {
  const sessions = new InMemorySessionService();
  const runner = new Runner({
    appName: "app",
    agent: workflow(),
    sessionService: sessions,
    ...(plugin ? { plugins: [plugin] } : {}),
  });
  const { id } = await sessions.createSession({ appName: "app", userId: "u" });
  const events: Event[][] = [];
  const errors: string[] = [];
  const started = performance.now();
  for (const newMessage of [START, START, ANSWER]) {
    const turn: Event[] = [];
    try {
      for await (const event of runner.runAsync({
        userId: "u",
        sessionId: id,
        newMessage,
      })) {
        turn.push(event);
      }
    } catch (error) {
      errors.push(String((error as Error)?.message ?? error));
    }
    events.push(turn);
  }
  return { events, errors, durationMs: performance.now() - started };
}

const VOLATILE_KEY = /(timestamp|At|Ms|elapsed)$/i;

/** The events as JSON with ids replaced by placeholders and times zeroed. */
function normalize(outcome: Outcome): unknown {
  const ids: string[] = [];
  const remember = (value: unknown) => {
    if (typeof value === "string" && value !== "" && !ids.includes(value)) {
      ids.push(value);
    }
  };
  for (const event of outcome.events.flat()) {
    remember(event.id);
    remember(event.invocationId);
    remember(
      (
        event.customMetadata?.workflowEvent as
          | { executionId?: string }
          | undefined
      )?.executionId,
    );
  }
  // Events nested in checkpoint state carry generated ids of the same shape.
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value !== null && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) {
        if (key === "id" && typeof inner === "string") {
          if (/^[A-Za-z0-9]{8}$/.test(inner)) remember(inner);
        } else collect(inner);
      }
    }
  };
  collect(JSON.parse(JSON.stringify(outcome.events)));
  const scrub = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(scrub);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, inner]) => [
          key,
          typeof inner === "number" && VOLATILE_KEY.test(key)
            ? 0
            : scrub(inner),
        ]),
      );
    }
    return value;
  };
  let text = JSON.stringify(scrub(JSON.parse(JSON.stringify(outcome.events))));
  for (const [index, id] of [...ids.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    text = text.split(id).join(`<id-${index}>`);
  }
  return { events: JSON.parse(text), errors: outcome.errors };
}

async function until(check: () => boolean, ms = 3_000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Deep copy that keeps the symbol keys `structuredClone` drops. */
function cloneEvent<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneEvent) as T;
  if (value === null || typeof value !== "object") return value;
  const copy: Record<string | symbol, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    copy[key] = cloneEvent((value as Record<string | symbol, unknown>)[key]);
  }
  return copy as T;
}

describe("a run with and without the event export plugin", () => {
  test("yields a deep-equal event stream with a working exporter", async () => {
    const bare = await runScenario();
    const exporter = new InMemoryWorkflowEventExporter();
    const exported = await runScenario(
      new WorkflowEventExportPlugin({ exporter }),
    );

    expect(bare.errors).toEqual([]);
    expect(bare.events.flat().length).toBeGreaterThan(5);
    expect(normalize(exported)).toEqual(normalize(bare));
    expect((await exporter.listExecutions({})).items).toHaveLength(1);
  });

  test("yields a deep-equal event stream when the exporter throws, and warns", async () => {
    const warnings: WorkflowEventExportWarning[] = [];
    const bare = await runScenario();

    const failing = await runScenario(
      new WorkflowEventExportPlugin({
        exporter: new ThrowingExporter(),
        retry: { maxAttempts: 1, initialDelayMs: 1 },
        onWarning: (warning) => warnings.push(warning),
      }),
    );
    await until(() => warnings.length > 0);

    expect(failing.errors).toEqual([]);
    expect(normalize(failing)).toEqual(normalize(bare));
    expect(warnings.map((warning) => warning.code)).toContain(
      "WORKFLOW_EVENT_EXPORT_DEGRADED",
    );
    expect(warnings[0]?.errorCode).toBe("WORKFLOW_STORAGE_UNSUPPORTED");
  });

  test("yields a deep-equal event stream when the exporter never answers, within the wait bound", async () => {
    const warnings: WorkflowEventExportWarning[] = [];
    const flushOnRunEndMs = 100;
    const bare = await runScenario();

    const hanging = await runScenario(
      new WorkflowEventExportPlugin({
        exporter: new HangingExporter(),
        appendTimeoutMs: 50,
        retry: { maxAttempts: 1, initialDelayMs: 1 },
        flushOnRunEndMs,
        onWarning: (warning) => warnings.push(warning),
      }),
    );
    await until(() => warnings.length > 0);

    expect(hanging.errors).toEqual([]);
    expect(normalize(hanging)).toEqual(normalize(bare));
    // Three runs may each wait once at the end; nothing else adds time.
    expect(hanging.durationMs).toBeLessThan(
      bare.durationMs + 3 * flushOnRunEndMs + 1_000,
    );
    expect(warnings.map((warning) => warning.code)).toContain(
      "WORKFLOW_EVENT_EXPORT_DEGRADED",
    );
  });

  test("a plugin with flushOnRunEndMs 0 adds no wait for a hanging exporter", async () => {
    const bare = await runScenario();

    const hanging = await runScenario(
      new WorkflowEventExportPlugin({
        exporter: new HangingExporter(),
        appendTimeoutMs: 60_000,
        flushOnRunEndMs: 0,
      }),
    );

    expect(normalize(hanging)).toEqual(normalize(bare));
    expect(hanging.durationMs).toBeLessThan(bare.durationMs + 500);
  });

  test("the plugin leaves every yielded event object unchanged", async () => {
    const exporter = new InMemoryWorkflowEventExporter();
    const plugin = new WorkflowEventExportPlugin({ exporter });

    const { events } = await runScenario(plugin);

    expect(events.flat().length).toBeGreaterThan(5);
    for (const event of events.flat()) {
      const before = cloneEvent(event);
      await plugin.onEventCallback({
        invocationContext: {
          invocationId: event.invocationId,
        } as InvocationContext,
        event,
      });
      expect(event).toEqual(before);
    }
  });
});
