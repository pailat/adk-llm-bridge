/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import {
  CLAUDE_AGENT_DEFINITION,
  CLAUDE_PROVIDER,
  CODEX_AGENT_DEFINITION,
  CODEX_PROVIDER,
  createDefaultExternalAgentDefinitionRegistry,
  createDefaultExternalAgentProviderRegistry,
  ExternalAgent,
  ExternalAgentDefinitionRegistry,
  ExternalAgentProviderRegistry,
  GEMINI_CLI_AGENT_DEFINITION,
  GEMINI_CLI_PROVIDER,
} from "../../src/agents/index.js";

describe("ExternalAgentProviderRegistry", () => {
  test("registers and looks up providers", () => {
    const registry = new ExternalAgentProviderRegistry();
    registry.register(CODEX_PROVIDER);

    expect(registry.has("codex")).toBe(true);
    expect(registry.get("codex")).toEqual(CODEX_PROVIDER);
    expect(registry.list()).toEqual([CODEX_PROVIDER]);
  });

  test("default registry contains built-in placeholders", () => {
    const registry = createDefaultExternalAgentProviderRegistry();

    expect(registry.get("codex")).toEqual(CODEX_PROVIDER);
    expect(registry.get("claude")).toEqual(CLAUDE_PROVIDER);
    expect(registry.get("gemini-cli")).toEqual(GEMINI_CLI_PROVIDER);
  });
});

describe("ExternalAgentDefinitionRegistry", () => {
  test("registers and looks up agent definitions", () => {
    const registry = new ExternalAgentDefinitionRegistry();
    registry.register(CODEX_AGENT_DEFINITION);

    expect(registry.has("codex")).toBe(true);
    expect(registry.get("codex")).toEqual(CODEX_AGENT_DEFINITION);
    expect(registry.list()).toEqual([CODEX_AGENT_DEFINITION]);
  });

  test("default definition registry contains built-in agents", () => {
    const registry = createDefaultExternalAgentDefinitionRegistry();

    expect(registry.get("codex")).toEqual(CODEX_AGENT_DEFINITION);
    expect(registry.get("claude")).toEqual(CLAUDE_AGENT_DEFINITION);
    expect(registry.get("gemini-cli")).toEqual(GEMINI_CLI_AGENT_DEFINITION);
  });

  test("creates agents through the shared definition schema", () => {
    const registry = createDefaultExternalAgentDefinitionRegistry();
    const agent = registry.create("codex", { name: "codex" });

    expect(agent).toBeInstanceOf(ExternalAgent);
    expect(agent.provider).toEqual(CODEX_PROVIDER);
    expect(agent.driver.providerId).toBe("codex");
  });
});
