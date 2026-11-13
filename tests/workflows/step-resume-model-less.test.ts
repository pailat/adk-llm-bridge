import { describe, expect, test } from "bun:test";
import {
  type BaseAgent,
  type Event,
  InvocationContext,
  PluginManager,
} from "@google/adk";
import { ClaudeAgentSdkDriver } from "../../src/agents/driver/claude-agent-sdk.js";
import { EXTERNAL_AGENT_NO_TURN } from "../../src/agents/driver/policy-errors.js";
import { ExternalAgent } from "../../src/agents/external-agent.js";
import { CLAUDE_PROVIDER } from "../../src/agents/provider/schema.js";
import { defineWorkflow } from "../../src/workflows/definition.js";
import type {
  WorkflowEvent,
  WorkflowStepCompletedEvent,
} from "../../src/workflows/events.js";
import { WorkflowAgent } from "../../src/workflows/workflow-agent.js";

// The second step of one Claude agent in one process resumes the first
// step's SDK session. When Claude Code writes a model-less result (success,
// num_turns 0, result "") before the turn that runs the new input, the step
// must still run that input, or fail; never complete with empty output.

const MODEL = "claude-haiku-5-5";
type Message = Record<string, unknown>;

const init = (id: string): Message => ({
  type: "system",
  subtype: "init",
  model: MODEL,
  session_id: id,
  tools: [],
  mcp_servers: [],
});
const modelLess = (id: string): Message => ({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 0,
  result: "",
  session_id: id,
  total_cost_usd: 0.25,
});
const assistant = (id: string, text: string): Message => ({
  type: "assistant",
  session_id: id,
  parent_tool_use_id: null,
  message: {
    role: "assistant",
    model: MODEL,
    content: [{ type: "text", text }],
  },
});
const result = (id: string, text: string, cost: number): Message => ({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 1,
  result: text,
  session_id: id,
  total_cost_usd: cost,
});

function fakeSdk(scripts: Message[][], resumes: Array<string | undefined>) {
  return {
    query: ({ options }: { options: Record<string, unknown> }) => {
      resumes.push(
        typeof options.resume === "string" ? options.resume : undefined,
      );
      const messages = scripts.shift() ?? [];
      const iterator = (async function* () {
        yield* messages;
      })();
      return Object.assign(iterator, {
        interrupt: async () => {},
        close: () => {},
      });
    },
    tool: (name: string) => ({ name }),
    createSdkMcpServer: (config: Record<string, unknown>) => config,
  };
}

function workflowWith(agent: ExternalAgent): WorkflowAgent {
  return new WorkflowAgent({
    name: "wf",
    definition: defineWorkflow({
      id: "resume-model-less",
      version: "1",
      handler: async (ctx) => {
        await ctx.run({ id: "s1", agentName: agent.name, input: "first task" });
        await ctx.run({
          id: "s2",
          agentName: agent.name,
          input: "second task",
        });
      },
    }),
    subAgents: [agent],
  });
}

function invocation(agent: BaseAgent): InvocationContext {
  return new InvocationContext({
    pluginManager: new PluginManager(),
    invocationId: "inv-resume",
    branch: "root",
    agent,
    userContent: { role: "user", parts: [{ text: "go" }] },
    session: {
      id: "s",
      appName: "app",
      userId: "u",
      state: {},
      events: [],
      lastUpdateTime: 1,
    },
  });
}

async function completedSteps(scripts: Message[][]) {
  const resumes: Array<string | undefined> = [];
  const driver = new ClaudeAgentSdkDriver({
    sdk: fakeSdk(scripts, resumes) as never,
    model: MODEL,
  });
  const agent = new ExternalAgent({
    name: "fixer",
    provider: CLAUDE_PROVIDER,
    driver,
  });
  const wf = workflowWith(agent);
  const events: Event[] = [];
  let thrown: unknown;
  try {
    for await (const event of wf.runAsync(invocation(wf))) events.push(event);
  } catch (error) {
    thrown = error;
  }
  const completed = events
    .map((e) => e.customMetadata?.workflowEvent as WorkflowEvent | undefined)
    .filter(
      (e): e is WorkflowStepCompletedEvent => e?.type === "step_completed",
    );
  return { completed, resumes, thrown, events };
}

describe("a workflow step on a resumed Claude session", () => {
  test("the second step resumes the first step's session and runs its input past a model-less result", async () => {
    const { completed, resumes } = await completedSteps([
      [
        init("sdk-1"),
        assistant("sdk-1", "did one"),
        result("sdk-1", "did one", 0.25),
      ],
      [
        init("sdk-1"),
        modelLess("sdk-1"),
        assistant("sdk-1", "did two"),
        result("sdk-1", "did two", 0.5),
      ],
    ]);
    expect(resumes).toEqual([undefined, "sdk-1"]);
    expect(completed.map((e) => [e.result.id, e.result.status])).toEqual([
      ["s1", "completed"],
      ["s2", "completed"],
    ]);
    expect(completed[1].result.output).toBe("did two");
  });

  test("a second step that gets only a model-less result fails, typed; it never completes empty", async () => {
    const { completed, resumes, events } = await completedSteps([
      [
        init("sdk-1"),
        assistant("sdk-1", "did one"),
        result("sdk-1", "did one", 0.25),
      ],
      [init("sdk-1"), modelLess("sdk-1")],
    ]);
    expect(resumes).toEqual([undefined, "sdk-1"]);
    const s2 = completed.filter((e) => e.result.id === "s2");
    for (const e of s2) expect(e.result.status).not.toBe("completed");
    const failed = events
      .map((e) => e.customMetadata?.workflowEvent as WorkflowEvent | undefined)
      .filter((e) => e?.type === "step_failed");
    expect(failed).toHaveLength(1);
    expect(JSON.stringify(failed[0])).toContain(EXTERNAL_AGENT_NO_TURN);
  });
});
