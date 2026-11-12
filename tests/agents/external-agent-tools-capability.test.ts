import { describe, expect, test } from "bun:test";
import { FunctionTool } from "@google/adk";
import { z } from "zod";
import { ClaudeAgentSdkDriver } from "../../src/agents/driver/claude-agent-sdk.js";
import { ClaudeCliDriver } from "../../src/agents/driver/claude-cli.js";
import { CodexCliDriver } from "../../src/agents/driver/codex-cli.js";
import { CodexSdkDriver } from "../../src/agents/driver/codex-sdk.js";
import {
  ClaudeAgent,
  CodexAgent,
  ExternalAgent,
  FxAgent,
} from "../../src/agents/index.js";
import { CLAUDE_PROVIDER } from "../../src/agents/provider/schema.js";

const weather = new FunctionTool({
  name: "get_weather",
  description: "Weather.",
  parameters: z.object({}),
  execute: () => ({}),
});

function codeOf(fn: () => unknown): { code?: string; message: string } {
  try {
    fn();
  } catch (e) {
    return e as { code?: string; message: string };
  }
  throw new Error("did not throw");
}

describe("tools on a driver that cannot host them", () => {
  test("CodexAgent, FxAgent, a Claude CLI agent and a Codex SDK agent refuse tools", () => {
    const cases: Array<[string, () => unknown]> = [
      ["CodexSdkDriver", () => new CodexAgent({ name: "c", tools: [weather] })],
      [
        "FxCliDriver",
        () =>
          new FxAgent({
            name: "g",
            driverOptions: { model: "anthropic/claude-haiku-4-5" },
            tools: [weather],
            permissions: { mode: "ask", allowNetwork: true },
          }),
      ],
      [
        "ClaudeCliDriver",
        () =>
          new ExternalAgent({
            name: "x",
            provider: CLAUDE_PROVIDER,
            driver: new ClaudeCliDriver(),
            tools: [weather],
          }),
      ],
      [
        "CodexSdkDriver",
        () =>
          new ExternalAgent({
            name: "y",
            provider: CLAUDE_PROVIDER,
            driver: new CodexSdkDriver(),
            tools: [weather],
          }),
      ],
      [
        "CodexCliDriver",
        () =>
          new ExternalAgent({
            name: "z",
            provider: CLAUDE_PROVIDER,
            driver: new CodexCliDriver(),
            tools: [weather],
          }),
      ],
    ];
    for (const [driverName, make] of cases) {
      const error = codeOf(make);
      expect(error.code).toBe("EXTERNAL_AGENT_TOOLS_UNSUPPORTED");
      expect(error.message).toContain(driverName);
      expect(error.message).toContain("ClaudeAgent");
    }
  });

  test("a custom driver without capabilities() constructs; one that says tools:false throws", () => {
    expect(
      () =>
        new ExternalAgent({
          name: "custom",
          provider: CLAUDE_PROVIDER,
          driver: { providerId: CLAUDE_PROVIDER.id, async *run() {} },
          tools: [weather],
        }),
    ).not.toThrow();
    const error = codeOf(
      () =>
        new ExternalAgent({
          name: "custom",
          provider: CLAUDE_PROVIDER,
          driver: {
            providerId: CLAUDE_PROVIDER.id,
            capabilities: () => ({ tools: false }),
            async *run() {},
          },
          tools: [weather],
        }),
    );
    expect(error.code).toBe("EXTERNAL_AGENT_TOOLS_UNSUPPORTED");
  });

  test("no tools: every driver constructs; ClaudeAgent with tools constructs", () => {
    expect(() => new CodexAgent({ name: "c" })).not.toThrow();
    expect(
      () => new ClaudeAgent({ name: "k", tools: [weather] }),
    ).not.toThrow();
    expect(
      () =>
        new ExternalAgent({
          name: "x",
          provider: CLAUDE_PROVIDER,
          driver: new ClaudeAgentSdkDriver(),
          tools: [weather],
        }),
    ).not.toThrow();
  });

  test("clone with a driver that cannot host the tools throws", () => {
    const agent = new ClaudeAgent({ name: "k", tools: [weather] });
    const error = codeOf(() =>
      agent.clone({ driver: new CodexCliDriver() } as never),
    );
    expect(error.code).toBe("EXTERNAL_AGENT_TOOLS_UNSUPPORTED");
  });

  test("the check runs before the readOnlyTools checks", () => {
    const error = codeOf(
      () =>
        new CodexAgent({
          name: "c",
          tools: [weather],
          readOnlyTools: ["nope"],
          permissions: { mode: "read-only" },
        }),
    );
    expect(error.code).toBe("EXTERNAL_AGENT_TOOLS_UNSUPPORTED");
  });
});
