import { describe, expect, test } from "bun:test";
import {
  DEFAULT_BASE_URL,
  getProviderConfig,
  MODEL_PATTERNS,
  OPENROUTER_BASE_URL,
  OPENROUTER_MODEL_PATTERNS,
  PROVIDER_IDS,
  resetProviderConfig,
  setProviderConfig,
} from "../../src/index.js";
import { AI_GATEWAY_DEFINITION } from "../../src/providers/ai-gateway/definition.js";
import { OPENAI_DEFINITION } from "../../src/providers/openai/definition.js";
import { OPENROUTER_DEFINITION } from "../../src/providers/openrouter/definition.js";
import { XAI_DEFINITION } from "../../src/providers/xai/definition.js";

describe("public constants", () => {
  test("keep their values", () => {
    expect(DEFAULT_BASE_URL).toBe("https://ai-gateway.vercel.sh/v1");
    expect(OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api/v1");
    expect(MODEL_PATTERNS).toEqual([/.+\/.+/]);
    expect(OPENROUTER_MODEL_PATTERNS).toEqual([/.+\/.+/]);
  });

  test("keep their literal types", () => {
    const gateway: "https://ai-gateway.vercel.sh/v1" = DEFAULT_BASE_URL;
    const openRouter: "https://openrouter.ai/api/v1" = OPENROUTER_BASE_URL;
    expect([gateway, openRouter]).toHaveLength(2);
  });

  test("match the provider definitions", () => {
    expect(DEFAULT_BASE_URL).toBe(AI_GATEWAY_DEFINITION.defaultBaseURL);
    expect(OPENROUTER_BASE_URL).toBe(OPENROUTER_DEFINITION.defaultBaseURL);
    expect(MODEL_PATTERNS).toEqual(AI_GATEWAY_DEFINITION.modelPatterns);
    expect(OPENROUTER_MODEL_PATTERNS).toEqual(
      OPENROUTER_DEFINITION.modelPatterns,
    );
  });

  test("pattern arrays are copies: changing one does not change the registry patterns", () => {
    expect(MODEL_PATTERNS).not.toBe(AI_GATEWAY_DEFINITION.modelPatterns);
    expect(OPENROUTER_MODEL_PATTERNS).not.toBe(
      OPENROUTER_DEFINITION.modelPatterns,
    );
  });

  test("PROVIDER_IDS lists every built-in provider", () => {
    expect<string[]>(Object.values(PROVIDER_IDS).sort()).toEqual(
      [
        AI_GATEWAY_DEFINITION.id,
        OPENROUTER_DEFINITION.id,
        OPENAI_DEFINITION.id,
        XAI_DEFINITION.id,
        "anthropic",
      ].sort(),
    );
    for (const id of Object.values(PROVIDER_IDS)) {
      setProviderConfig(id, { apiKey: "k" });
      expect(getProviderConfig(id)?.apiKey).toBe("k");
      resetProviderConfig(id);
    }
  });
});
