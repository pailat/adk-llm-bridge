/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import {
  CLAUDE_PROVIDER,
  CODEX_PROVIDER,
  createDefaultExternalAgentProviderRegistry,
  ExternalAgentProviderRegistry,
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
