import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BaseAgent, type BaseAgentConfig } from "@google/adk";
import { ClaudeAgentSdkDriver } from "../../src/agents/driver/claude-agent-sdk.js";
import { ClaudeCliDriver } from "../../src/agents/driver/claude-cli.js";
import { CodexCliDriver } from "../../src/agents/driver/codex-cli.js";
import { CodexSdkDriver } from "../../src/agents/driver/codex-sdk.js";
import { GeminiCliDriver } from "../../src/agents/driver/gemini-cli.js";
import * as agentsApi from "../../src/agents/index.js";
import {
  ClaudeAgent,
  CodexAgent,
  ExternalAgent,
  type ExternalAgentDriver,
  GeminiCliAgent,
} from "../../src/agents/index.js";
import { CLAUDE_PROVIDER } from "../../src/agents/provider/schema.js";

function codeOf(fn: () => unknown): { code?: string; message: string } {
  try {
    fn();
  } catch (e) {
    return e as { code?: string; message: string };
  }
  throw new Error("did not throw");
}

class Child extends BaseAgent {
  // ADK's clone() rebuilds sub-agents from their config object.
  constructor(config: BaseAgentConfig) {
    super(config);
  }
  protected async *runAsyncImpl() {}
  protected async *runLiveImpl() {}
}

const child = () => new Child({ name: "child" });

const withDriver = (driver: ExternalAgentDriver, subAgents?: BaseAgent[]) =>
  new ExternalAgent({
    name: "x",
    provider: CLAUDE_PROVIDER,
    driver,
    ...(subAgents ? { subAgents } : {}),
  });

const NO_SUBAGENTS: Array<[string, () => ExternalAgentDriver]> = [
  ["ClaudeCliDriver", () => new ClaudeCliDriver()],
  ["CodexCliDriver", () => new CodexCliDriver()],
  ["CodexSdkDriver", () => new CodexSdkDriver()],
  ["GeminiCliDriver", () => new GeminiCliDriver()],
];

describe("subagents capability", () => {
  test("subAgents on a driver that never exposes them is refused, naming the driver", () => {
    for (const [name, make] of NO_SUBAGENTS) {
      const error = codeOf(() => withDriver(make(), [child()]));
      expect(error.code).toBe("EXTERNAL_AGENT_SUBAGENTS_UNSUPPORTED");
      expect(error.message).toContain(name);
      expect(error.message).toContain("ClaudeAgent");
    }
  });

  test("the agent classes refuse it too", () => {
    expect(
      codeOf(() => new CodexAgent({ name: "c", subAgents: [child()] })).code,
    ).toBe("EXTERNAL_AGENT_SUBAGENTS_UNSUPPORTED");
    expect(
      codeOf(() => new GeminiCliAgent({ name: "g", subAgents: [child()] }))
        .code,
    ).toBe("EXTERNAL_AGENT_SUBAGENTS_UNSUPPORTED");
  });

  test("the Claude Agent SDK driver accepts sub-agents", () => {
    expect(
      () => new ClaudeAgent({ name: "k", subAgents: [child()] }),
    ).not.toThrow();
    expect(() =>
      withDriver(new ClaudeAgentSdkDriver(), [child()]),
    ).not.toThrow();
  });

  test("an empty or absent subAgents list means nothing to refuse", () => {
    for (const [, make] of NO_SUBAGENTS) {
      expect(() => withDriver(make())).not.toThrow();
      expect(() => withDriver(make(), [])).not.toThrow();
    }
  });

  test("a custom driver without capabilities() is not checked; subagents:false is refused; subagents:true is accepted", () => {
    const base = { providerId: CLAUDE_PROVIDER.id, async *run() {} };
    expect(() => withDriver(base, [child()])).not.toThrow();
    expect(
      codeOf(() =>
        withDriver({ ...base, capabilities: () => ({ subagents: false }) }, [
          child(),
        ]),
      ).code,
    ).toBe("EXTERNAL_AGENT_SUBAGENTS_UNSUPPORTED");
    expect(
      codeOf(() =>
        withDriver({ ...base, capabilities: () => ({ tools: true }) }, [
          child(),
        ]),
      ).code,
    ).toBe("EXTERNAL_AGENT_SUBAGENTS_UNSUPPORTED");
    expect(() =>
      withDriver({ ...base, capabilities: () => ({ subagents: true }) }, [
        child(),
      ]),
    ).not.toThrow();
  });

  test("the guard reads the subagents flag, not the tools flag", () => {
    const base = { providerId: CLAUDE_PROVIDER.id, async *run() {} };
    expect(() =>
      withDriver(
        { ...base, capabilities: () => ({ tools: true, subagents: false }) },
        [child()],
      ),
    ).toThrow();
    expect(() =>
      withDriver(
        { ...base, capabilities: () => ({ tools: false, subagents: true }) },
        [child()],
      ),
    ).not.toThrow();
  });

  test("clone onto a driver that cannot expose sub-agents throws", () => {
    const agent = new ClaudeAgent({ name: "k", subAgents: [child()] });
    expect(
      codeOf(() => agent.clone({ driver: new CodexCliDriver() } as never)).code,
    ).toBe("EXTERNAL_AGENT_SUBAGENTS_UNSUPPORTED");
  });

  test("the code is exported from adk-llm-bridge/agents", () => {
    expect(
      (agentsApi as Record<string, unknown>)
        .EXTERNAL_AGENT_SUBAGENTS_UNSUPPORTED,
    ).toBe("EXTERNAL_AGENT_SUBAGENTS_UNSUPPORTED");
  });

  test("capabilities().subagents is true exactly for the driver that reads the tool gateway", () => {
    const drivers: Array<[string, ExternalAgentDriver, string]> = [
      ["claude-agent-sdk", new ClaudeAgentSdkDriver(), "claude-agent-sdk.ts"],
      ["claude-cli", new ClaudeCliDriver(), "claude-cli.ts"],
      ["codex-cli", new CodexCliDriver(), "codex-cli.ts"],
      ["codex-sdk", new CodexSdkDriver(), "codex-sdk.ts"],
      ["gemini-cli", new GeminiCliDriver(), "gemini-cli.ts"],
    ];
    for (const [name, driver, file] of drivers) {
      const source = readFileSync(
        join(import.meta.dir, "../../src/agents/driver", file),
        "utf8",
      );
      const reads = /request\.toolGateway|request\.subAgents/.test(source);
      expect({
        name,
        subagents: driver.capabilities?.().subagents === true,
      }).toEqual({ name, subagents: reads });
    }
  });
});
