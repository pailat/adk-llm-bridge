/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import * as root from "../../src/index";
import * as agents from "../../src/agents";
import packageJson from "../../package.json";

describe("agents public exports", () => {
  test("root export behavior remains LLM-focused", () => {
    expect(root.AIGateway).toBeFunction();
    expect(root.OpenRouter).toBeFunction();
    expect("CodexAgent" in root).toBe(false);
    expect("ClaudeAgent" in root).toBe(false);
    expect("GeminiCliAgent" in root).toBe(false);
  });

  test("./agents exposes external agent symbols", () => {
    expect(agents.ExternalAgent).toBeFunction();
    expect(agents.CodexAgent).toBeFunction();
    expect(agents.ClaudeAgent).toBeFunction();
    expect(agents.GeminiCliAgent).toBeFunction();
    expect(agents.ExternalAgentProviderRegistry).toBeFunction();
    expect(agents.readAllowedEnv).toBeFunction();
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
