import { describe, expect, test } from "bun:test";
import {
  BaseAgent,
  createEvent,
  InvocationContext,
  PluginManager,
} from "@google/adk";
import { defineWorkflow } from "../../../src/workflows/definition.js";
import type { WorkflowEvent } from "../../../src/workflows/events.js";
import { WorkflowAgent } from "../../../src/workflows/workflow-agent.js";

/** Records when it starts; does its work synchronously or after a timer. */
class Worker extends BaseAgent {
  constructor(
    private readonly log: string[],
    private readonly mode: "sync" | "async",
  ) {
    super({ name: "worker" });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.log.push("child-start");
    if (this.mode === "sync") {
      const end = Date.now() + 20;
      while (Date.now() < end) {
        // Blocking work, as a host agent that calls a synchronous API.
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: { role: "model", parts: [{ text: "ok" }] },
    });
  }

  protected async *runLiveImpl() {}
}

function workflowFor(worker: BaseAgent) {
  return new WorkflowAgent({
    name: "workflow",
    subAgents: [worker],
    definition: defineWorkflow({
      id: "backpressure",
      version: "1",
      handler: async (ctx) =>
        (await ctx.run({ id: "s", agentName: "worker", input: "x" })).output,
    }),
  });
}

function context(agent: BaseAgent) {
  return new InvocationContext({
    pluginManager: new PluginManager(),
    invocationId: "inv",
    agent,
    userContent: { role: "user", parts: [{ text: "go" }] },
    session: {
      id: "s",
      appName: "a",
      userId: "u",
      state: {},
      events: [],
      lastUpdateTime: 1,
    },
  });
}

describe("workflow event delivery", () => {
  for (const mode of ["sync", "async"] as const) {
    test(`a consumer that does I/O per event sees step_started before a ${mode} step starts`, async () => {
      const log: string[] = [];
      const agent = workflowFor(new Worker(log, mode));

      for await (const event of agent.runAsync(context(agent))) {
        // A session service or logger that awaits I/O for each event.
        await new Promise((resolve) => setTimeout(resolve, 0));
        const type = (event.customMetadata?.workflowEvent as WorkflowEvent)
          ?.type;
        if (type) log.push(type);
      }

      expect(log.indexOf("step_started")).toBeGreaterThanOrEqual(0);
      expect(log.indexOf("step_started")).toBeLessThan(
        log.indexOf("child-start"),
      );
      expect(log.indexOf("workflow_started")).toBeLessThan(
        log.indexOf("child-start"),
      );
      expect(log.at(-1)).toBe("workflow_completed");
    });
  }

  test("closing the stream early does not leave the run waiting on the consumer", async () => {
    const log: string[] = [];
    const agent = workflowFor(new Worker(log, "async"));

    const closed = (async () => {
      for await (const _ of agent.runAsync(context(agent))) {
        break;
      }
    })();

    await expect(
      Promise.race([
        closed.then(() => "closed"),
        new Promise((resolve) => setTimeout(() => resolve("hung"), 1000)),
      ]),
    ).resolves.toBe("closed");
    expect(log).not.toContain("child-start");
  });
});
