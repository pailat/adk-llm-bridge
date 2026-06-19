/**
 * Feature 1 — sampling config.
 *
 * Sets `generateContentConfig.{ temperature, maxOutputTokens, stopSequences }`
 * via `LlmAgent`. These map through the bridge to the provider's native
 * sampling controls.
 *
 * topP note: on Anthropic the converter drops `top_p` when it is paired with a
 * `temperature` (the API rejects both together), so we demonstrate `topP` only
 * when running on OpenAI. This is why sampling and reasoning are SEPARATE demos
 * — see README "Provider Constraints".
 */
import { LlmAgent } from "@google/adk";
import type { GenerateContentConfig } from "@google/genai";
import { makeModel } from "../providers";
import { buildMessage } from "../runner";
import type { Demo } from "../types";

export const samplingDemo: Demo = {
  name: "sampling",
  description:
    "temperature / maxOutputTokens / stopSequences via generateContentConfig",

  async run({ harness, out, config }) {
    out.header(samplingDemo, config);

    const generateContentConfig: GenerateContentConfig = {
      temperature: 0.2, // low → more deterministic
      maxOutputTokens: 120, // cap the response length
      stopSequences: ["END"], // model stops if it emits this token
    };

    // topP is only safe to pair with temperature on OpenAI (see note above).
    if (config.provider === "openai") {
      generateContentConfig.topP = 0.9;
    }

    const agent = new LlmAgent({
      name: "sampler",
      model: makeModel(config),
      instruction:
        "You are concise. Answer in at most two short sentences. " +
        'Append the literal token "END" after your answer.',
      generateContentConfig,
    });

    out.label("generateContentConfig", generateContentConfig);
    out.section("response");

    const result = await harness.run(
      agent,
      buildMessage("In one line, what makes a good cup of coffee?"),
    );

    out.label("final", result.finalText.trim());
    out.section("usage");
    out.usage(result.usage);
  },
};
