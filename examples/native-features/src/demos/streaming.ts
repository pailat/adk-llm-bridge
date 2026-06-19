/**
 * Feature 6 — streaming + token usage.
 *
 * Runs a plain agent with `opts.streaming = true`, which sets
 * `RunConfig.streamingMode = StreamingMode.SSE` in the harness. Partial events
 * arrive incrementally; the harness writes their text to `out.stream()` live
 * and counts them. The final, non-partial event carries `usageMetadata`, which
 * the harness captures and we print at the end.
 */
import { LlmAgent } from "@google/adk";
import { makeModel } from "../providers";
import { buildMessage } from "../runner";
import type { Demo } from "../types";

export const streamingDemo: Demo = {
  name: "streaming",
  description: "token streaming (StreamingMode.SSE) + final usageMetadata",

  async run({ harness, out, config }) {
    out.header(streamingDemo, config);

    const agent = new LlmAgent({
      name: "storyteller",
      model: makeModel(config),
      instruction: "You are a vivid, concise storyteller.",
    });

    out.section("streamed output");

    const result = await harness.run(
      agent,
      buildMessage("Tell me a three-sentence story about a lighthouse keeper."),
      { streaming: true },
    );

    out.stream("\n"); // terminate the streamed line
    out.section("summary");
    out.label("partial events", result.partials);
    out.label("final length (chars)", result.finalText.trim().length);

    out.section("usage");
    out.usage(result.usage);
  },
};
