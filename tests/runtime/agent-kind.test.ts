import { describe, expect, test } from "bun:test";
import {
  BaseAgent,
  createEvent,
  LlmAgent,
  LoopAgent,
  ParallelAgent,
  RoutedAgent,
  SequentialAgent,
} from "@google/adk";
import { ExternalAgent } from "../../src/agents/external-agent.js";
import type { ExternalAgentDriver } from "../../src/agents/index.js";
import { CODEX_PROVIDER } from "../../src/agents/provider/schema.js";
import { describeAgentKind } from "../../src/runtime/agent-kind.js";
import { defineWorkflow } from "../../src/workflows/definition.js";
import { WorkflowAgent } from "../../src/workflows/workflow-agent.js";

class CustomAgent extends BaseAgent {
  protected async *runAsyncImpl() {
    yield createEvent({ author: this.name });
  }
  protected async *runLiveImpl() {}
}

class SubLlm extends LlmAgent {}
class SubExternal extends ExternalAgent {}

function external(name: string): ExternalAgent {
  const driver: ExternalAgentDriver = {
    providerId: CODEX_PROVIDER.id,
    async *run() {},
  };
  return new ExternalAgent({ name, provider: CODEX_PROVIDER, driver });
}

describe("describeAgentKind", () => {
  test("an ExternalAgent is external", () => {
    expect(describeAgentKind(external("e"))).toBe("external");
  });

  test("a subclass of ExternalAgent is external", () => {
    const driver: ExternalAgentDriver = {
      providerId: CODEX_PROVIDER.id,
      async *run() {},
    };
    const agent = new SubExternal({
      name: "e",
      provider: CODEX_PROVIDER,
      driver,
    });
    expect(describeAgentKind(agent)).toBe("external");
  });

  test("a brand inherited from an external prototype is not external", () => {
    const inheriting: BaseAgent = Object.create(external("proto"));
    expect(
      Symbol.for("adk-llm-bridge.agents.external-agent.v1") in inheriting,
    ).toBe(true);
    expect(describeAgentKind(inheriting)).not.toBe("external");
  });

  test("an LlmAgent is llm", () => {
    expect(describeAgentKind(new LlmAgent({ name: "l", model: "m" }))).toBe(
      "llm",
    );
  });

  test("a subclass of LlmAgent is llm", () => {
    expect(describeAgentKind(new SubLlm({ name: "l", model: "m" }))).toBe(
      "llm",
    );
  });

  test("the bridge's WorkflowAgent is workflow", () => {
    const agent = new WorkflowAgent({
      name: "w",
      definition: defineWorkflow({
        id: "k",
        version: "1",
        handler: async () => undefined,
      }),
    });
    expect(describeAgentKind(agent)).toBe("workflow");
  });

  test("ADK Sequential, Parallel and Loop agents are workflow", () => {
    expect(describeAgentKind(new SequentialAgent({ name: "s" }))).toBe(
      "workflow",
    );
    expect(describeAgentKind(new ParallelAgent({ name: "p" }))).toBe(
      "workflow",
    );
    expect(describeAgentKind(new LoopAgent({ name: "lp" }))).toBe("workflow");
  });

  test("any other BaseAgent is host, not llm", () => {
    expect(describeAgentKind(new CustomAgent({ name: "c" }))).toBe("host");
  });

  test("a RoutedAgent that routes an external agent is host", () => {
    const routed = new RoutedAgent({
      name: "r",
      agents: { a: external("inner") },
      router: () => "a",
    });
    expect(describeAgentKind(routed)).toBe("host");
  });

  test("an LlmAgent wrapping an external sub-agent is still llm", () => {
    const parent = new LlmAgent({
      name: "parent",
      model: "m",
      subAgents: [external("inner")],
    });
    expect(describeAgentKind(parent)).toBe("llm");
  });

  test("a branded agent from another copy is recognized without instanceof", () => {
    const copy = new CustomAgent({ name: "copy" });
    Object.defineProperty(
      copy,
      Symbol.for("adk-llm-bridge.agents.external-agent.v1"),
      {
        value: () => undefined,
      },
    );
    expect(describeAgentKind(copy)).toBe("external");
    const workflowCopy = new CustomAgent({ name: "wcopy" });
    Object.defineProperty(
      workflowCopy,
      Symbol.for("adk-llm-bridge.workflow-agent"),
      {
        value: true,
      },
    );
    expect(describeAgentKind(workflowCopy)).toBe("workflow");
  });
});
