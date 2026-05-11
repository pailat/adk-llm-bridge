import { BaseAgent, createEvent, type InvocationContext } from "@google/adk";
import { describe, expect, test } from "bun:test";
import {
  ExternalAgent,
  type ExternalAgentDriver,
  type ExternalAgentRunRequest,
  ToolGateway,
} from "../../src/agents/index.js";
import { CODEX_PROVIDER } from "../../src/agents/provider/schema.js";

class CaptureDriver implements ExternalAgentDriver {
  readonly providerId = CODEX_PROVIDER.id;
  request?: ExternalAgentRunRequest;

  async *run(request: ExternalAgentRunRequest) {
    this.request = request;
    yield { type: "output" as const, content: "child" };
  }
}

class TextAgent extends BaseAgent {
  constructor(name = "worker") {
    super({ name });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    const task = context.userContent?.parts?.[0]?.text ?? "";
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: { role: "model", parts: [{ text: `OK: ${task}` }] },
    });
    yield createEvent({ invocationId: context.invocationId, author: this.name });
  }

  protected async *runLiveImpl() {}
}

function parentContext(agent: BaseAgent): InvocationContext {
  return {
    invocationId: "inv-1",
    agent,
    userContent: { role: "user", parts: [{ text: "parent" }] },
  } as InvocationContext;
}

describe("ToolGateway", () => {
  test("runs a named ADK subagent and returns visible text only", async () => {
    const worker = new TextAgent("worker");
    const root = new TextAgent("root");
    const gateway = new ToolGateway({
      rootAgent: root,
      subAgents: [worker],
      parentContext: parentContext(root),
    });

    const result = await gateway.runSubAgent({ agentName: "worker", task: "do it" });

    expect(result).toEqual({
      agentName: "worker",
      output: "OK: do it",
      events: 2,
    });
  });

  test("emits native function call, child, and function response events", async () => {
    const worker = new TextAgent("worker");
    const root = new TextAgent("root");
    const emitted = [];
    const gateway = new ToolGateway({
      rootAgent: root,
      subAgents: [worker],
      parentContext: parentContext(root),
      eventSink: (event) => emitted.push(event),
    });

    await gateway.runSubAgent({ agentName: "worker", task: "do it" });

    expect(emitted).toHaveLength(4);
    expect(emitted[0].content?.parts?.[0]?.functionCall).toMatchObject({
      name: "run_adk_subagent",
      args: { agentName: "worker", task: "do it" },
    });
    expect(emitted[1]).toMatchObject({
      author: "worker",
      content: { role: "model", parts: [{ text: "OK: do it" }] },
    });
    expect(emitted[3].content?.parts?.[0]?.functionResponse).toMatchObject({
      name: "run_adk_subagent",
      response: { agentName: "worker", output: "OK: do it", events: 2 },
    });
  });

  test("applies inherited permission override to ExternalAgent subagents", async () => {
    const driver = new CaptureDriver();
    const worker = new ExternalAgent({
      name: "worker",
      provider: CODEX_PROVIDER,
      driver,
      permissions: { mode: "full-access", allowNetwork: true },
    });
    const root = new TextAgent("root");
    const gateway = new ToolGateway({
      rootAgent: root,
      subAgents: [worker],
      parentContext: parentContext(root),
      parentPermissions: { mode: "read-only" },
    });

    await gateway.runSubAgent({ agentName: "worker", task: "do it" });

    expect(driver.request?.permissions).toEqual({
      mode: "read-only",
      allowNetwork: false,
    });
  });

  test("returns a controlled error for unknown subagents", async () => {
    const root = new TextAgent("root");
    const gateway = new ToolGateway({
      rootAgent: root,
      subAgents: [],
      parentContext: parentContext(root),
    });

    const result = await gateway.runSubAgent({ agentName: "missing", task: "do it" });

    expect(result.error).toBe("Unknown ADK subagent: missing");
    expect(result.output).toBe("");
    expect(result.events).toBe(0);
  });
});
