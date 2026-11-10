import { describe, expect, test } from "bun:test";
import {
  type Event,
  InMemorySessionService,
  LongRunningFunctionTool,
  Runner,
} from "@google/adk";
import type { Content } from "@google/genai";
import { z } from "zod";
import {
  ExternalAgent,
  type ExternalAgentDriver,
  type ExternalAgentEvent,
  type ExternalAgentRunRequest,
} from "../../src/agents/index.js";
import { CLAUDE_PROVIDER } from "../../src/agents/provider/schema.js";
import { defineWorkflow } from "../../src/workflows/definition.js";
import type { WorkflowEvent } from "../../src/workflows/events.js";
import { WorkflowAgent } from "../../src/workflows/workflow-agent.js";

/**
 * First run: calls the bridged long-running tool the way the Claude SDK
 * driver does. Later runs: answer with the instruction they were given, so
 * the test sees what the resumed runtime was told.
 */
class JobDriver implements ExternalAgentDriver {
  readonly providerId = CLAUDE_PROVIDER.id;
  readonly requests: ExternalAgentRunRequest[] = [];
  readonly statuses: string[] = [];

  async *run(
    request: ExternalAgentRunRequest,
  ): AsyncGenerator<ExternalAgentEvent> {
    this.requests.push(request);
    if (this.requests.length > 1) {
      yield {
        type: "output",
        content: `resumed: ${request.instruction ?? ""}`,
      };
      return;
    }
    const bridge = request.adkTools;
    if (!bridge) throw new Error("no ADK tools");
    const exposed = "adk_tool__start_job";
    const runtimeName = `mcp__adk_bridge__${exposed}`;
    yield {
      type: "tool_call",
      name: runtimeName,
      input: {},
      callId: "toolu_1",
    };
    const result = await bridge.execute(exposed, {}, request.context, {
      functionCallId: "job-call-1",
    });
    this.statuses.push(result.status);
    if (request.abortSignal?.aborted) return;
    yield {
      type: "tool_result",
      name: runtimeName,
      callId: "toolu_1",
      result: JSON.stringify(result.response),
    };
    yield { type: "output", content: "finished without waiting" };
  }
}

const workflowEventOf = (event: Event) =>
  event.customMetadata?.workflowEvent as WorkflowEvent | undefined;
const types = (events: readonly Event[]) =>
  events.map((event) => workflowEventOf(event)?.type).filter(Boolean);

describe("WorkflowAgent step on an ExternalAgent with a long-running tool", () => {
  test("the pending call pauses the workflow and its functionResponse resumes it", async () => {
    const starts: string[] = [];
    const driver = new JobDriver();
    const worker = new ExternalAgent({
      name: "worker",
      provider: CLAUDE_PROVIDER,
      driver,
      tools: [
        new LongRunningFunctionTool({
          name: "start_job",
          description: "Starts a job.",
          parameters: z.object({}),
          execute: () => {
            starts.push("started");
            return undefined as never;
          },
        }),
      ],
    });
    const workflow = new WorkflowAgent({
      name: "workflow",
      subAgents: [worker],
      definition: defineWorkflow({
        id: "long-running-step",
        version: "1",
        handler: async (ctx) => {
          const result = await ctx.run({
            id: "job",
            agentName: "worker",
            input: ctx.inputText,
          });
          return `done(${result.output})`;
        },
      }),
    });
    const sessions = new InMemorySessionService();
    const runner = new Runner({
      appName: "jobs",
      agent: workflow,
      sessionService: sessions,
    });
    const session = await sessions.createSession({
      appName: "jobs",
      userId: "user",
    });
    const run = async (message: Content) => {
      const events: Event[] = [];
      for await (const event of runner.runAsync({
        userId: "user",
        sessionId: session.id,
        newMessage: message,
      })) {
        events.push(event);
      }
      return events;
    };

    const first = await run({ role: "user", parts: [{ text: "start" }] });

    expect(driver.statuses).toEqual(["pending"]);
    expect(types(first)).toContain("step_waiting");
    expect(types(first).at(-1)).toBe("workflow_waiting");
    expect(types(first)).not.toContain("workflow_completed");
    const pause = first.find((event) =>
      event.longRunningToolIds?.includes("job-call-1"),
    );
    expect(pause?.author).toBe("worker");
    expect(pause?.content?.parts?.[0]?.functionCall?.name).toBe("start_job");

    const second = await run({
      role: "user",
      parts: [
        {
          functionResponse: {
            id: "job-call-1",
            name: "start_job",
            response: { status: "done", report: "R-42" },
          },
        },
      ],
    });

    expect(types(second)).toContain("workflow_completed");
    // The workflow's own output is the last one (the step's comes first).
    const output = second.findLast(
      (event) => event.output !== undefined,
    )?.output;
    expect(String(output)).toStartWith("done(resumed: ");
    // The resumed step's runtime gets the result as user-side data, and only
    // a fixed note in its instruction.
    expect(String(output)).not.toContain("R-42");
    expect(driver.requests[1]?.instruction).not.toContain("R-42");
    expect(JSON.stringify(driver.requests[1]?.context.userContent)).toContain(
      "R-42",
    );
    expect(driver.requests).toHaveLength(2);
    // The tool is not run again: its result came from the answer.
    expect(starts).toEqual(["started"]);
  });
});
