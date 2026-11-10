import { describe, expect, test } from "bun:test";
import {
  BaseAgent,
  type BaseAgentConfig,
  type Context,
  createEvent,
  type Event,
  InvocationContext,
  PluginManager,
} from "@google/adk";
import {
  defineScriptWorkflow,
  defineWorkflow,
} from "../../src/workflows/definition.js";
import { ScriptWorkflowAgent } from "../../src/workflows/script-workflow-agent.js";
import { WorkflowAgent } from "../../src/workflows/workflow-agent.js";

class ReplyAgent extends BaseAgent {
  calls = 0;
  constructor(config: string | BaseAgentConfig) {
    // clone() passes a config object.
    super(typeof config === "string" ? { name: config } : config);
  }
  protected async *runAsyncImpl(context: InvocationContext) {
    this.calls++;
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: { role: "model", parts: [{ text: "done" }] },
    });
  }
  protected async *runLiveImpl() {}
}

function invocation(agent: BaseAgent): InvocationContext {
  return new InvocationContext({
    pluginManager: new PluginManager(),
    invocationId: "inv-config",
    branch: "root",
    agent,
    userContent: { role: "user", parts: [{ text: "go" }] },
    session: {
      id: "session-config",
      appName: "app",
      userId: "user",
      state: {},
      events: [],
      lastUpdateTime: 1,
    },
  });
}

async function collect(agent: BaseAgent): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of agent.runAsync(invocation(agent))) {
    events.push(event);
  }
  return events;
}

const textOf = (events: readonly Event[]) =>
  events.flatMap((e) => e.content?.parts?.map((p) => p.text ?? "") ?? []);

function trusted(worker: BaseAgent) {
  return defineWorkflow({
    id: "config",
    version: "1",
    handler: async (ctx) =>
      (await ctx.run({ id: "s1", agentName: worker.name, input: "x" })).output,
  });
}

const script = () =>
  defineScriptWorkflow({ id: "config-script", version: "1", source: "1" });

describe("WorkflowAgent ADK agent config", () => {
  test("forwards waitForOutput (default false, like ADK)", () => {
    const worker = new ReplyAgent("worker");
    expect(
      new WorkflowAgent({ name: "wf", definition: trusted(worker) })
        .waitForOutput,
    ).toBe(false);
    expect(
      new WorkflowAgent({
        name: "wf",
        definition: trusted(worker),
        waitForOutput: true,
      }).waitForOutput,
    ).toBe(true);
    expect(
      new ScriptWorkflowAgent({
        name: "swf",
        definition: script(),
        waitForOutput: true,
      }).waitForOutput,
    ).toBe(true);
  });

  test("runs beforeAgentCallback and afterAgentCallback around the workflow", async () => {
    const worker = new ReplyAgent("worker");
    const seen: string[] = [];
    const agent = new WorkflowAgent({
      name: "wf",
      definition: trusted(worker),
      subAgents: [worker],
      beforeAgentCallback: (context: Context) => {
        seen.push(`before:${context.agentName}`);
        return undefined;
      },
      afterAgentCallback: [
        () => {
          seen.push("after");
          return { role: "model", parts: [{ text: "after-note" }] };
        },
      ],
    });
    const events = await collect(agent);
    expect(seen).toEqual(["before:wf", "after"]);
    expect(worker.calls).toBe(1);
    expect(textOf(events).at(-1)).toBe("after-note");
  });

  test("a beforeAgentCallback that returns content skips the workflow", async () => {
    const worker = new ReplyAgent("worker");
    const agent = new WorkflowAgent({
      name: "wf",
      definition: trusted(worker),
      subAgents: [worker],
      beforeAgentCallback: () => ({
        role: "model",
        parts: [{ text: "skipped" }],
      }),
    });
    const events = await collect(agent);
    expect(worker.calls).toBe(0);
    expect(textOf(events)).toEqual(["skipped"]);
  });

  test("ScriptWorkflowAgent accepts the agent callbacks too", async () => {
    let before = 0;
    const agent = new ScriptWorkflowAgent({
      name: "swf",
      definition: script(),
      beforeAgentCallback: () => {
        before++;
        return { role: "model", parts: [{ text: "short-circuit" }] };
      },
    });
    const events = await collect(agent);
    expect(before).toBe(1);
    expect(textOf(events)).toEqual(["short-circuit"]);
  });

  test("wires parentAgent from config", () => {
    const worker = new ReplyAgent("worker");
    const parent = new ReplyAgent("parent");
    const explicit = new WorkflowAgent({
      name: "wf",
      definition: trusted(worker),
      parentAgent: parent,
    });
    expect(explicit.parentAgent).toBe(parent);
    expect(explicit.rootAgent).toBe(parent);

    const script = new ScriptWorkflowAgent({
      name: "swf",
      definition: defineScriptWorkflow({ id: "p", version: "1", source: "1" }),
      parentAgent: parent,
    });
    expect(script.parentAgent).toBe(parent);
  });

  test("a parent agent built with a workflow agent as sub-agent becomes its parent", () => {
    const worker = new ReplyAgent("worker");
    const wf = new WorkflowAgent({ name: "wf", definition: trusted(worker) });
    const parent = new (class extends BaseAgent {
      protected async *runAsyncImpl() {}
      protected async *runLiveImpl() {}
    })({ name: "parent", subAgents: [wf] });
    expect(wf.parentAgent).toBe(parent);
  });
});

describe("workflow agent description", () => {
  test("defaults to the definition's description; an explicit one wins", () => {
    const definition = defineWorkflow({
      id: "described",
      version: "1",
      description: "from the definition",
      handler: async () => "ok",
    });
    expect(new WorkflowAgent({ name: "wf", definition }).description).toBe(
      "from the definition",
    );
    expect(
      new WorkflowAgent({ name: "wf", definition, description: "explicit" })
        .description,
    ).toBe("explicit");
    const scriptDefinition = defineScriptWorkflow({
      id: "described-script",
      version: "1",
      description: "script description",
      source: "1",
    });
    expect(
      new ScriptWorkflowAgent({ name: "swf", definition: scriptDefinition })
        .description,
    ).toBe("script description");
  });
});

describe("workflow agent clone()", () => {
  test("WorkflowAgent.clone() rebuilds the agent with its definition and config", async () => {
    const worker = new ReplyAgent("worker");
    const seen: string[] = [];
    const agent = new WorkflowAgent({
      name: "wf",
      definition: trusted(worker),
      subAgents: [worker],
      timeout: 5,
      retryFailedSteps: true,
      waitForOutput: true,
      beforeAgentCallback: () => {
        seen.push("before");
        return undefined;
      },
    });
    const copy = agent.clone({ name: "wf_copy" }) as WorkflowAgent;
    expect(copy).toBeInstanceOf(WorkflowAgent);
    expect(copy.name).toBe("wf_copy");
    expect(copy.definition).toBe(agent.definition);
    expect(copy.timeout).toBe(5);
    expect(copy.waitForOutput).toBe(true);
    expect(copy.rerunOnResume).toBe(true);
    expect(copy.parentAgent).toBeUndefined();
    expect(copy.subAgents.map((a) => a.name)).toEqual(["worker"]);
    expect(copy.subAgents[0]).not.toBe(worker);

    const events = await collect(copy);
    expect(seen).toEqual(["before"]);
    expect(textOf(events)).toContain("done");
    // The clone runs its own copy of the sub-agent.
    expect(worker.calls).toBe(0);
  });

  test("ScriptWorkflowAgent.clone() rebuilds the agent with its definition", () => {
    const definition = script();
    const agent = new ScriptWorkflowAgent({
      name: "swf",
      definition,
      timeout: 2,
    });
    const copy = agent.clone({ name: "swf_copy" }) as ScriptWorkflowAgent;
    expect(copy).toBeInstanceOf(ScriptWorkflowAgent);
    expect(copy.name).toBe("swf_copy");
    expect(copy.definition).toBe(definition);
    expect(copy.timeout).toBe(2);
  });
});
