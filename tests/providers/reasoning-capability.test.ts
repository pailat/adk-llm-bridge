/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Asserts the declarative reasoning capability wired onto each provider
 * definition. This is the provider-aware switch that lets OpenRouter / AI
 * Gateway honor thinkingConfig while OpenAI / xAI keep their strict,
 * model-name-gated reasoning_effort path.
 */

import { describe, expect, it } from "bun:test";
import { AI_GATEWAY_DEFINITION } from "../../src/providers/ai-gateway/definition.js";
import { OPENAI_DEFINITION } from "../../src/providers/openai/definition.js";
import { OPENROUTER_DEFINITION } from "../../src/providers/openrouter/definition.js";
import { XAI_DEFINITION } from "../../src/providers/xai/definition.js";

describe("provider reasoning capability", () => {
  it("OpenRouter uses the permissive openrouter style", () => {
    expect(OPENROUTER_DEFINITION.reasoning?.style).toBe("openrouter");
  });

  it("AI Gateway uses the permissive openrouter style", () => {
    expect(AI_GATEWAY_DEFINITION.reasoning?.style).toBe("openrouter");
  });

  it("OpenAI stays on the strict openai-effort style (not openrouter)", () => {
    expect(OPENAI_DEFINITION.reasoning?.style).toBe("openai-effort");
    expect(OPENAI_DEFINITION.reasoning?.style).not.toBe("openrouter");
  });

  it("xAI stays on the strict openai-effort style (not openrouter)", () => {
    expect(XAI_DEFINITION.reasoning?.style).toBe("openai-effort");
    expect(XAI_DEFINITION.reasoning?.style).not.toBe("openrouter");
  });
});
