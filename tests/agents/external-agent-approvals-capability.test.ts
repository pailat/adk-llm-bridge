import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FunctionTool } from "@google/adk";
import { z } from "zod";
import { ClaudeAgentSdkDriver } from "../../src/agents/driver/claude-agent-sdk.js";
import { ClaudeCliDriver } from "../../src/agents/driver/claude-cli.js";
import { CodexCliDriver } from "../../src/agents/driver/codex-cli.js";
import { CodexSdkDriver } from "../../src/agents/driver/codex-sdk.js";
import { GeminiCliDriver } from "../../src/agents/driver/gemini-cli.js";
import {
  ClaudeAgent,
  CodexAgent,
  ExternalAgent,
  type ExternalAgentConfirmationOptions,
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

const withDriver = (
  driver: ExternalAgentDriver,
  confirmation?: ExternalAgentConfirmationOptions,
) =>
  new ExternalAgent({
    name: "x",
    provider: CLAUDE_PROVIDER,
    driver,
    ...(confirmation ? { confirmation } : {}),
  });

const NON_APPROVING: Array<[string, () => ExternalAgentDriver]> = [
  ["ClaudeCliDriver", () => new ClaudeCliDriver()],
  ["CodexCliDriver", () => new CodexCliDriver()],
  ["CodexSdkDriver", () => new CodexSdkDriver()],
  ["GeminiCliDriver", () => new GeminiCliDriver()],
];

describe("approvals capability", () => {
  test("an approver on a driver that never asks it is refused, naming the driver", () => {
    for (const [name, make] of NON_APPROVING) {
      const error = codeOf(() => withDriver(make(), { approver: () => true }));
      expect(error.code).toBe("EXTERNAL_AGENT_APPROVALS_UNSUPPORTED");
      expect(error.message).toContain(name);
      expect(error.message).toContain("ClaudeAgent");
    }
  });

  test("ADK confirmation on those drivers is refused under the same code", () => {
    for (const [name, make] of NON_APPROVING) {
      const error = codeOf(() => withDriver(make(), { adk: true }));
      expect(error.code).toBe("EXTERNAL_AGENT_APPROVALS_UNSUPPORTED");
      expect(error.message).toContain(name);
    }
  });

  test("the agent classes refuse it too", () => {
    expect(
      codeOf(
        () =>
          new CodexAgent({ name: "c", confirmation: { approver: () => true } }),
      ).code,
    ).toBe("EXTERNAL_AGENT_APPROVALS_UNSUPPORTED");
    expect(
      codeOf(
        () =>
          new GeminiCliAgent({
            name: "g",
            confirmation: { adk: true },
            permissions: { mode: "ask", allowNetwork: true },
          }),
      ).code,
    ).toBe("EXTERNAL_AGENT_APPROVALS_UNSUPPORTED");
  });

  test("the Claude Agent SDK driver accepts both", () => {
    expect(
      () =>
        new ClaudeAgent({ name: "k", confirmation: { approver: () => true } }),
    ).not.toThrow();
    expect(
      () => new ClaudeAgent({ name: "k", confirmation: { adk: true } }),
    ).not.toThrow();
  });

  test("no approver and no ADK confirmation means nothing to refuse", () => {
    for (const [, make] of NON_APPROVING) {
      expect(() => withDriver(make())).not.toThrow();
      expect(() => withDriver(make(), {})).not.toThrow();
      expect(() => withDriver(make(), { adk: false })).not.toThrow();
      expect(() => withDriver(make(), { approver: undefined })).not.toThrow();
    }
  });

  test("a custom driver without capabilities() is not checked; approvals:false is refused; approvals:true is accepted", () => {
    const base = { providerId: CLAUDE_PROVIDER.id, async *run() {} };
    expect(() => withDriver(base, { approver: () => true })).not.toThrow();
    expect(
      codeOf(() =>
        withDriver(
          { ...base, capabilities: () => ({ approvals: false }) },
          { approver: () => true },
        ),
      ).code,
    ).toBe("EXTERNAL_AGENT_APPROVALS_UNSUPPORTED");
    expect(() =>
      withDriver(
        { ...base, capabilities: () => ({ approvals: true }) },
        { approver: () => true },
      ),
    ).not.toThrow();
  });

  test("clone onto a driver that cannot ask the approver throws", () => {
    const agent = new ClaudeAgent({
      name: "k",
      confirmation: { approver: () => true },
    });
    expect(
      codeOf(() => agent.clone({ driver: new CodexCliDriver() } as never)).code,
    ).toBe("EXTERNAL_AGENT_APPROVALS_UNSUPPORTED");
  });

  test("order: tools are refused before approvals", () => {
    const tool = new FunctionTool({
      name: "get_weather",
      description: "Weather.",
      parameters: z.object({}),
      execute: () => ({}),
    });
    expect(
      codeOf(
        () =>
          new CodexAgent({
            name: "c",
            tools: [tool],
            confirmation: { approver: () => true },
          }),
      ).code,
    ).toBe("EXTERNAL_AGENT_TOOLS_UNSUPPORTED");
  });

  test("order: approvals are refused before the readOnlyTools checks", () => {
    expect(
      codeOf(
        () =>
          new CodexAgent({
            name: "c",
            tools: [],
            confirmation: { approver: () => true },
            readOnlyTools: ["nope"],
          }),
      ).code,
    ).toBe("EXTERNAL_AGENT_APPROVALS_UNSUPPORTED");
  });

  test("capabilities().approvals is true exactly for the drivers that call requestPermission", () => {
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
      const calls = /request\.requestPermission|requestPermission\s*[=(?]/.test(
        source,
      );
      expect({
        name,
        approvals: driver.capabilities?.().approvals === true,
      }).toEqual({
        name,
        approvals: calls,
      });
    }
  });
});
