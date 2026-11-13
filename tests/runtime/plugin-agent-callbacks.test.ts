/**
 * ADK 2.5 runs a plugin's beforeAgentCallback and afterAgentCallback for every
 * agent, custom agents included. The bridge's ExternalAgent and WorkflowAgent
 * extend BaseAgent, so an application plugin sees them like any LlmAgent.
 */
import { describe, expect, test } from "bun:test";
import { type BaseAgent, BasePlugin, InMemoryRunner } from "@google/adk";
import {
  ExternalAgent,
  type ExternalAgentDriver,
  type ExternalAgentEvent,
} from "../../src/agents/index.js";
import { CODEX_PROVIDER } from "../../src/agents/provider/schema.js";
import { defineWorkflow } from "../../src/workflows/definition.js";
import { WorkflowAgent } from "../../src/workflows/workflow-agent.js";

class StaticDriver implements ExternalAgentDriver {
  readonly providerId = CODEX_PROVIDER.id;
  constructor(private readonly events: ExternalAgentEvent[]) {}
  async *run(): AsyncIterable<ExternalAgentEvent> {
    yield* this.events;
  }
}

class RecordingPlugin extends BasePlugin {
  readonly calls: string[] = [];
  constructor() {
    super("recording");
  }
  override async beforeAgentCallback(params: { agent: BaseAgent }) {
    this.calls.push(`before ${params.agent.name}`);
    return undefined;
  }
  override async afterAgentCallback(params: { agent: BaseAgent }) {
    this.calls.push(`after ${params.agent.name}`);
    return undefined;
  }
}

async function run(agent: BaseAgent, plugin: RecordingPlugin): Promise<void> {
  const runner = new InMemoryRunner({
    agent,
    appName: "app",
    plugins: [plugin],
  });
  const session = await runner.sessionService.createSession({
    appName: "app",
    userId: "user",
  });
  for await (const _event of runner.runAsync({
    userId: "user",
    sessionId: session.id,
    newMessage: { role: "user", parts: [{ text: "go" }] },
  })) {
    // drain
  }
}

function externalAgent(name: string): ExternalAgent {
  return new ExternalAgent({
    name,
    provider: CODEX_PROVIDER,
    driver: new StaticDriver([
      { type: "output", content: "done" },
      { type: "completed", exitCode: 0 },
    ]),
  });
}

describe("plugin agent callbacks", () => {
  test("fire around an ExternalAgent", async () => {
    const plugin = new RecordingPlugin();
    await run(externalAgent("coder"), plugin);
    expect(plugin.calls).toEqual(["before coder", "after coder"]);
  });

  test("fire around a WorkflowAgent and the agents its steps run", async () => {
    const plugin = new RecordingPlugin();
    const workflow = new WorkflowAgent({
      name: "flow",
      subAgents: [externalAgent("coder")],
      definition: defineWorkflow({
        id: "flow",
        version: "1",
        handler: async (ctx) => {
          const step = await ctx.run({
            id: "code",
            agentName: "coder",
            input: "x",
          });
          return step.status;
        },
      }),
    });
    await run(workflow, plugin);
    expect(plugin.calls).toEqual([
      "before flow",
      "before coder",
      "after coder",
      "after flow",
    ]);
  });
});
