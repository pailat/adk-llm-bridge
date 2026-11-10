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
import type { WorkflowStepOutcome } from "../../src/workflows/contracts.js";
import { defineWorkflow } from "../../src/workflows/definition.js";
import type { WorkflowEvent } from "../../src/workflows/events.js";
import { WorkflowAgent } from "../../src/workflows/workflow-agent.js";

/** Reports an error event on its first run and answers on the next ones. */
class FlakyAgent extends BaseAgent {
  calls = 0;

  constructor(
    name: string,
    private readonly alwaysFail = false,
  ) {
    super({ name });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.calls += 1;
    if (this.alwaysFail || this.calls === 1) {
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        errorCode: "EXTERNAL_AGENT_ISOLATION_VIOLATED",
        errorMessage: "tried to use Bash, outside the isolated set",
      });
      return;
    }
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: { role: "model", parts: [{ text: "recovered" }] },
    });
  }

  protected async *runLiveImpl() {}
}

/** Fails its first run with an error event, then asks for input. */
class AskAfterErrorAgent extends BaseAgent {
  calls = 0;

  constructor(name: string) {
    super({ name });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.calls += 1;
    if (this.calls === 1) {
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        errorCode: "FIRST_ATTEMPT",
        errorMessage: "first attempt failed",
      });
      return;
    }
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {
        role: "model",
        parts: [
          {
            functionCall: {
              id: "ask-1",
              name: REQUEST_INPUT_FUNCTION_CALL_NAME,
              args: { message: "approve?" },
            },
          },
        ],
      },
      longRunningToolIds: ["ask-1"],
    });
  }

  protected async *runLiveImpl() {}
}

/** A nested workflow that reports a real error after it completed. */
class LateErrorWorkflow extends WorkflowAgent {
  protected override async *runAsyncImpl(context: InvocationContext) {
    yield* super.runAsyncImpl(context);
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      errorCode: "LATE",
      errorMessage: "real failure after completion",
    });
  }
}

/** Not a workflow agent, but it forges a workflow event under its own name. */
class ForgingAgent extends BaseAgent {
  constructor() {
    super({ name: "lane" });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      errorCode: "REAL",
      errorMessage: "real failure",
    });
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      customMetadata: { workflowEvent: { type: "workflow_completed" } },
    });
  }

  protected async *runLiveImpl() {}
}

function nestedWorkflow(worker: BaseAgent, maxAttempts: number) {
  return new WorkflowAgent({
    name: "lane",
    subAgents: [worker],
    definition: defineWorkflow({
      id: "lane",
      version: "1",
      limits: { maxAttemptsPerStep: maxAttempts },
      handler: async (ctx) => {
        const result = await ctx.run({
          id: "review",
          agentName: worker.name,
          input: "go",
          retry: { maxAttempts },
        });
        return `lane(${result.output})`;
      },
    }),
  });
}

async function runParent(inner: WorkflowAgent) {
  const outcomes: WorkflowStepOutcome[][] = [];
  const parent = new WorkflowAgent({
    name: "root",
    subAgents: [inner],
    definition: defineWorkflow({
      id: "root",
      version: "1",
      handler: async (ctx) => {
        const settled = await ctx.parallel(
          [{ id: "lane-1", agentName: "lane", input: "x" }],
          { failureMode: "all-settled" },
        );
        outcomes.push(settled);
        return settled.map((outcome) => outcome.status).join(",");
      },
    }),
  });
  const sessions = new InMemorySessionService();
  const runner = new Runner({
    appName: "nested-outcome",
    agent: parent,
    sessionService: sessions,
  });
  const session = await sessions.createSession({
    appName: "nested-outcome",
    userId: "user",
  });
  const events: Event[] = [];
  let error: unknown;
  try {
    for await (const event of runner.runAsync({
      userId: "user",
      sessionId: session.id,
      newMessage: { role: "user", parts: [{ text: "hi" }] },
    })) {
      events.push(event);
    }
  } catch (caught) {
    error = caught;
  }
  const workflowEvents = events
    .map((event) => event.customMetadata?.workflowEvent as WorkflowEvent)
    .filter(Boolean);
  return { events, outcomes: outcomes[0], error, workflowEvents };
}

describe("a nested WorkflowAgent used as a step", () => {
  test("a completed run is a completed step even after a retried inner failure", async () => {
    const worker = new FlakyAgent("worker");
    const { outcomes, error, workflowEvents } = await runParent(
      nestedWorkflow(worker, 2),
    );

    expect(worker.calls).toBe(2);
    expect(error).toBeUndefined();
    expect(outcomes?.[0]).toMatchObject({
      status: "completed",
      id: "lane-1",
      output: "lane(recovered)",
    });
    expect(
      workflowEvents.filter(
        (event) =>
          event.type === "step_failed" && event.failure.id === "lane-1",
      ),
    ).toEqual([]);
    expect(
      workflowEvents.some(
        (event) =>
          event.type === "step_completed" && event.result.id === "lane-1",
      ),
    ).toBe(true);
  });

  test("a nested run that fails stays a failed step with the inner error", async () => {
    const worker = new FlakyAgent("worker", true);
    const { outcomes } = await runParent(nestedWorkflow(worker, 2));

    expect(outcomes?.[0]).toMatchObject({
      status: "failed",
      id: "lane-1",
      error: { code: "WORKFLOW_EXECUTION_ERROR" },
    });
  });

  test("a real error after the nested completion stays a failure", async () => {
    const worker = new FlakyAgent("worker");
    const lane = new LateErrorWorkflow({
      name: "lane",
      subAgents: [worker],
      definition: defineWorkflow({
        id: "lane",
        version: "1",
        limits: { maxAttemptsPerStep: 2 },
        handler: async (ctx) =>
          (
            await ctx.run({
              id: "review",
              agentName: "worker",
              input: "go",
              retry: { maxAttempts: 2 },
            })
          ).output,
      }),
    });
    const { outcomes } = await runParent(lane);

    expect(outcomes?.[0]).toMatchObject({
      status: "failed",
      error: { details: { causeCode: "LATE" } },
    });
  });

  test("an agent that only claims a workflow event keeps its error", async () => {
    const { outcomes } = await runParent(new ForgingAgent() as never);

    expect(outcomes?.[0]).toMatchObject({
      status: "failed",
      error: { details: { causeCode: "REAL" } },
    });
  });

  test("a nested run that waits after a retried failure makes the parent step wait", async () => {
    const worker = new AskAfterErrorAgent("worker");
    const { outcomes, error, workflowEvents } = await runParent(
      nestedWorkflow(worker, 2),
    );

    expect(worker.calls).toBe(2);
    expect(error).toBeUndefined();
    expect(outcomes).toBeUndefined();
    expect(
      workflowEvents.some(
        (event) => event.type === "step_waiting" && event.stepId === "lane-1",
      ),
    ).toBe(true);
    expect(
      workflowEvents.filter(
        (event) =>
          event.type === "step_failed" && event.failure.id === "lane-1",
      ),
    ).toEqual([]);
    expect(workflowEvents.at(-1)?.type).toBe("workflow_waiting");
  });
});
