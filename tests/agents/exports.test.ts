/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import { BaseAgent } from "@google/adk";
import * as root from "../../src/index.js";
import * as agents from "../../src/agents/index.js";
import packageJson from "../../package.json";

describe("agents public exports", () => {
  test("root export behavior remains LLM-focused", () => {
    expect(root.AIGateway).toBeFunction();
    expect(root.OpenRouter).toBeFunction();
    expect(root.OpenAI).toBeFunction();
    expect(root.Anthropic).toBeFunction();
    expect(root.XAI).toBeFunction();
    expect(root.Custom).toBeFunction();
    expect("CodexAgent" in root).toBe(false);
    expect("ClaudeAgent" in root).toBe(false);
    expect("GeminiCliAgent" in root).toBe(false);
    expect("ExternalAgent" in root).toBe(false);
    expect("EnvCredentialProvider" in root).toBe(false);
  });

  test("./agents exposes external agent symbols", () => {
    expect(agents.BaseAgent).toBe(BaseAgent);
    expect(agents.ExternalAgent).toBeFunction();
    expect(agents.CodexAgent).toBeFunction();
    expect(agents.ClaudeAgent).toBeFunction();
    expect(agents.GeminiCliAgent).toBeFunction();
    expect(agents.ExternalAgentProviderRegistry).toBeFunction();
    expect(agents.EnvCredentialProvider).toBeFunction();
    expect(agents.NoopCredentialProvider).toBeFunction();
    expect(agents.SubprocessJsonlDriver).toBeFunction();
    expect(agents.PlaceholderExternalAgentDriver).toBeFunction();
    expect(agents.readAllowedEnv).toBeFunction();
    expect(agents.mapPermissionModeToPolicy).toBeFunction();
    expect(agents.mapPermissionPolicyToFlags).toBeFunction();
    expect(agents.deriveSubAgentPermissionPolicy).toBeFunction();
    expect(agents.ToolGateway).toBeFunction();
  });

  test("provider-backed agents preserve expected public shape", () => {
    const codex = new agents.CodexAgent({ name: "codex" });
    const claude = new agents.ClaudeAgent({ name: "claude" });
    const gemini = new agents.GeminiCliAgent({ name: "gemini" });

    expect(codex).toBeInstanceOf(agents.ExternalAgent);
    expect(codex).toBeInstanceOf(BaseAgent);
    expect(codex.provider).toEqual(agents.CODEX_PROVIDER);
    expect(claude.provider).toEqual(agents.CLAUDE_PROVIDER);
    expect(gemini.provider).toEqual(agents.GEMINI_CLI_PROVIDER);

    const root = new agents.ClaudeAgent({ name: "root", subAgents: [codex, gemini] });
    expect(root.subAgents).toEqual([codex, gemini]);
  });

  test("package exports preserves root and adds agents subpath", () => {
    expect(packageJson.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    });
    expect(packageJson.exports["./agents"]).toEqual({
      types: "./dist/agents/index.d.ts",
      import: "./dist/agents/index.js",
    });
  });
});
