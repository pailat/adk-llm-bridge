/**
 * adk-devtools entry point for the native-features showcase.
 *
 * The `src/` CLI demos exercise each native passthrough capability
 * programmatically (reading `part.thought`, `usageMetadata`, streaming
 * partials, etc.). This file exposes a single interactive agent so the same
 * features can be explored from the **adk-devtools web UI**:
 *
 *   bun run web   # then chat at http://localhost:8000/dev-ui
 *
 * It uses the recommended factory form (`Anthropic(...)` from adk-llm-bridge)
 * — no `LLMRegistry.register` needed. The agent is configured with the native
 * ADK model knobs that adk-llm-bridge now passes through:
 *   - extended thinking via `generateContentConfig.thinkingConfig`
 *     (the model's reasoning is shown in the UI before the answer)
 *   - a real `FunctionTool` (tool calling)
 *   - vision: attach an image in the UI to exercise multimodal input
 *
 * Requires `ANTHROPIC_API_KEY` in `.env` (Bun loads it from the cwd).
 */
import { FunctionTool, LlmAgent } from "@google/adk";
import type { Context } from "@google/adk";
import { Anthropic } from "adk-llm-bridge";
import { z } from "zod";

// A real tool so tool calling is demonstrable from the chat UI.
const getWeather = new FunctionTool({
  name: "get_weather",
  description: "Get the current weather for a city.",
  parameters: z.object({
    city: z.string().describe("City to look up the weather for"),
    unit: z
      .enum(["celsius", "fahrenheit"])
      .optional()
      .describe("Temperature unit (defaults to celsius)"),
  }),
  execute: ({ city, unit = "celsius" }, _context?: Context) => ({
    status: "success",
    city,
    unit,
    temperature: unit === "celsius" ? 21 : 70,
    condition: "partly cloudy",
  }),
});

export const rootAgent = new LlmAgent({
  name: "native_features_assistant",
  // Factory form — passes a BaseLlm instance straight to the agent.
  model: Anthropic("claude-sonnet-4-6"),
  description:
    "Showcase assistant: extended thinking, tool calling and multimodal vision.",
  instruction: `You are a helpful assistant that thinks step by step.
Use the get_weather tool when asked about weather.
If the user attaches an image, describe what you see.`,
  tools: [getWeather],
  // Native passthrough: ADK's thinkingConfig now reaches the provider.
  // (With thinking enabled the bridge omits temperature/top_p/top_k, which
  // Anthropic disallows alongside extended thinking.)
  generateContentConfig: {
    maxOutputTokens: 4096,
    thinkingConfig: {
      includeThoughts: true,
      thinkingBudget: 2048,
    },
  },
});
