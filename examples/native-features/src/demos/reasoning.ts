/**
 * Feature 2 — reasoning / extended thinking.
 *
 * Sets `generateContentConfig.thinkingConfig { includeThoughts, thinkingBudget }`
 * and NOTHING else sampling-related: with extended thinking on, the Anthropic
 * converter strips `top_p`/`top_k` and any `temperature !== 1` (the API forbids
 * them), so this demo is kept separate from `sampling`.
 *
 * The harness collects `part.thought === true` parts into `thoughtText`, and
 * `usageMetadata.thoughtsTokenCount` surfaces how many tokens were spent
 * thinking.
 */
import { LlmAgent } from "@google/adk";
import { makeModel } from "../providers";
import { buildMessage } from "../runner";
import type { Demo } from "../types";

export const reasoningDemo: Demo = {
  name: "reasoning",
  description:
    "extended thinking via thinkingConfig; reads thought parts + thoughtsTokenCount",

  async run({ harness, out, config }) {
    out.header(reasoningDemo, config);

    const agent = new LlmAgent({
      name: "reasoner",
      model: makeModel(config),
      instruction:
        "Think step by step, then give a single final numeric answer.",
      generateContentConfig: {
        thinkingConfig: {
          includeThoughts: true, // surface reasoning as thought parts
          thinkingBudget: 2048, // token budget for thinking
        },
        // NOTE: intentionally no temperature/topP here — they would be stripped.
      },
    });

    out.label("thinkingConfig", { includeThoughts: true, thinkingBudget: 2048 });
    out.section("reasoning (thought parts)");

    const result = await harness.run(
      agent,
      buildMessage(
        "A train leaves at 14:00 going 60 km/h. Another leaves the same " +
          "station at 14:30 going 90 km/h on the same track. At what time " +
          "does the second catch up?",
      ),
    );

    if (result.thoughtText.trim()) {
      out.thought(result.thoughtText.trim());
    } else {
      out.label("note", "no thought parts returned (model/provider may not emit them)");
    }

    out.section("final answer");
    out.label("final", result.finalText.trim());

    out.section("usage");
    out.usage(result.usage);
  },
};
