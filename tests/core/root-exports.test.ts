/**
 * Pins the runtime surface of the package root. Adding or removing a name is a
 * public API change: it must be deliberate, listed in the CHANGELOG, and
 * reflected here.
 */

import { describe, expect, it } from "bun:test";
import * as root from "../../src/index.js";

const ROOT_RUNTIME_EXPORTS = [
  "AIGateway",
  "AIGatewayLlm",
  "Anthropic",
  "AnthropicLlm",
  "BaseLlm",
  "BaseProviderLlm",
  "Custom",
  "CustomLlm",
  "DEFAULT_BASE_URL",
  "MODEL_PATTERNS",
  "OPENROUTER_BASE_URL",
  "OPENROUTER_MODEL_PATTERNS",
  "OpenAI",
  "OpenAICompatibleLlm",
  "OpenAILlm",
  "OpenRouter",
  "OpenRouterLlm",
  "PROVIDER_ERROR_INCOMPLETE_STREAM",
  "PROVIDER_ERROR_MALFORMED_FUNCTION_CALL",
  "PROVIDER_ERROR_NO_CHOICE",
  "PROVIDER_IDS",
  "ProviderLlmError",
  "XAI",
  "XAILlm",
  "convertGenerationConfig",
  "convertRequest",
  "convertResponse",
  "convertStreamChunk",
  "convertStructuredOutput",
  "convertToolChoice",
  "createCustomLlm",
  "createStreamAccumulator",
  "getConfig",
  "getProviderConfig",
  "isAIGatewayRegistered",
  "isAnthropicRegistered",
  "isOpenAIRegistered",
  "isOpenRouterRegistered",
  "isXAIRegistered",
  "normalizeSchema",
  "registerAIGateway",
  "registerAnthropic",
  "registerCustomProvider",
  "registerOpenAI",
  "registerOpenRouter",
  "registerXAI",
  "resetAllConfigs",
  "resetConfig",
  "resetProviderConfig",
  "setConfig",
  "setProviderConfig",
];

describe("package root exports", () => {
  it("exposes exactly the documented runtime names", () => {
    expect(Object.keys(root).sort()).toEqual(ROOT_RUNTIME_EXPORTS);
  });

  it.each([
    "httpStatusOf",
    "clampPositive",
    "resolveIntegerOption",
    "resolveConfig",
    "resolveEnvVar",
    "createProviderClass",
    "createProviderFactory",
    "createRegisterFunction",
    "parseJson",
    "tryParseJson",
    "annotateLlmSpan",
    "recordLlmError",
    "LogCode",
    "warnOnce",
    "adkModelNotFoundMessage",
    "ERROR_PREFIX_PATTERN",
    "MAX_TIMEOUT_MS",
    "checkIntegerOptions",
  ])("keeps the internal %s out of the root", (name) => {
    expect(name in root).toBe(false);
  });
});
