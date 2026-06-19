/**
 * Provider-selection abstraction over the library's Factory functions.
 *
 * `Anthropic()` / `OpenAI()` from adk-llm-bridge construct a `BaseLlm` that is
 * passed straight to `LlmAgent.model` — the factory form needs NO
 * `LLMRegistry.register` (only the string-model path does). This module is the
 * single switch point for adding more providers later.
 */
import {
  AIGateway,
  Anthropic,
  OpenAI,
  OpenRouter,
  XAI,
  type BaseLlm,
} from "adk-llm-bridge";
import type { AppConfig } from "./types";

export function makeModel(config: AppConfig): BaseLlm {
  switch (config.provider) {
    case "anthropic":
      return Anthropic(config.model);
    case "openai":
      return OpenAI(config.model);
    case "ai-gateway":
      return AIGateway(config.model);
    case "openrouter":
      return OpenRouter(config.model);
    case "xai":
      return XAI(config.model);
  }
}
