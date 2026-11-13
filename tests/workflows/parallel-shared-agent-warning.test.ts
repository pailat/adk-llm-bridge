import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  BaseAgent,
  createEvent,
  InvocationContext,
  logger,
  PluginManager,
} from "@google/adk";
import type { WorkflowParallelOptions } from "../../src/workflows/contracts.js";
import { defineWorkflow } from "../../src/workflows/definition.js";
import { WorkflowAgent } from "../../src/workflows/workflow-agent.js";

/** Answers with its name; records how many runs overlap. */
class EchoAgent extends BaseAgent {
  active = 0;
  maxActive = 0;

  constructor(name: string) {
    super({ name });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.active--;
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: { role: "model", parts: [{ text: this.name }] },
    });
  }

  protected async *runLiveImpl() {}
}

type Fanout = { agentNames: string[]; options?: WorkflowParallelOptions };

function workflow(agents: BaseAgent[], fanouts: Fanout[]) {
  return new WorkflowAgent({
    name: "fanout",
    subAgents: agents,
    definition: defineWorkflow({
      id: "fanout",
      version: "1",
      handler: async (ctx) => {
        for (const [round, fanout] of fanouts.entries()) {
          await ctx.parallel(
            fanout.agentNames.map((agentName, index) => ({
              id: `r${round}-s${index}`,
              agentName,
              input: "x",
            })),
            fanout.options,
          );
        }
        return "done";
      },
    }),
  });
}

async function run(agent: BaseAgent) {
  const context = new InvocationContext({
    pluginManager: new PluginManager(),
    invocationId: "inv-1",
    agent,
    userContent: { role: "user", parts: [{ text: "start" }] },
    session: {
      id: "s",
      appName: "a",
      userId: "u",
      state: {},
      events: [],
      lastUpdateTime: 1,
    },
  });
  for await (const _event of agent.runAsync(context)) {
    // drain
  }
}

const CODE = "[WORKFLOW_PARALLEL_STEPS_SHARE_AGENT]";

describe("parallel steps that share a sub-agent", () => {
  let warnings: string[];
  let restore: () => void;

  beforeEach(() => {
    warnings = [];
    const spy = spyOn(logger, "warn").mockImplementation((...args) => {
      warnings.push(args.map(String).join(" "));
    });
    restore = () => spy.mockRestore();
  });

  afterEach(() => restore());

  const shared = () => warnings.filter((line) => line.includes(CODE));

  test("warns once per run, naming the agent and the steps, and the steps still run one at a time", async () => {
    const reviewer = new EchoAgent("reviewer");
    const agent = workflow(
      [reviewer],
      [
        { agentNames: ["reviewer", "reviewer", "reviewer"] },
        { agentNames: ["reviewer", "reviewer"] },
      ],
    );

    await run(agent);

    expect(reviewer.maxActive).toBe(1);
    expect(shared()).toHaveLength(1);
    const [line] = shared();
    expect(line).toContain("[adk-llm-bridge]");
    expect(line).toContain('"reviewer"');
    expect(line).toContain('("r0-s0", "r0-s1", "r0-s2")');
    expect(line).toContain('"fanout"');

    // A new run warns again.
    await run(agent);
    expect(shared()).toHaveLength(2);
  });

  test("names each shared agent once, and lists at most five step ids", async () => {
    const agent = workflow(
      [new EchoAgent("a"), new EchoAgent("b")],
      [{ agentNames: ["a", "a", "a", "a", "a", "a", "a", "b", "b"] }],
    );

    await run(agent);

    expect(shared()).toHaveLength(2);
    const forA = shared().find((line) => line.includes('"a"')) ?? "";
    expect(forA).toContain("7 parallel steps");
    expect(forA).toContain('"r0-s0", "r0-s1", "r0-s2", "r0-s3", "r0-s4", ...');
    expect(shared().some((line) => line.includes('"b"'))).toBe(true);
  });

  test("does not warn when every parallel step has its own agent", async () => {
    const a = new EchoAgent("a");
    const b = new EchoAgent("b");

    await run(workflow([a, b], [{ agentNames: ["a", "b"] }]));

    expect(shared()).toEqual([]);
    expect(Math.max(a.maxActive, b.maxActive)).toBe(1);
  });

  test("does not warn when the parallel call asks for concurrency 1", async () => {
    await run(
      workflow(
        [new EchoAgent("a")],
        [{ agentNames: ["a", "a"], options: { concurrency: 1 } }],
      ),
    );

    expect(shared()).toEqual([]);
  });

  test("keeps the warning on one line and skips steps of an undeclared agent", async () => {
    const agent = new WorkflowAgent({
      name: "fanout",
      subAgents: [new EchoAgent("a")],
      definition: defineWorkflow({
        id: "fanout",
        version: "1",
        handler: async (ctx) => {
          await ctx.parallel(
            [
              { id: "one\ntwo", agentName: "a", input: "x" },
              { id: "three", agentName: "a", input: "x" },
              { id: "u1", agentName: "missing", input: "x" },
              { id: "u2", agentName: "missing", input: "x" },
            ],
            { failureMode: "all-settled" },
          );
          return "done";
        },
      }),
    });

    await run(agent);

    expect(shared()).toHaveLength(1);
    const [line] = shared();
    expect(line).not.toContain("\n");
    expect(line).toContain('"one\\ntwo"');
    expect(line).not.toContain("missing");
    expect(line).toContain("2 parallel steps");
    expect(line).not.toContain("u1");
  });
});
