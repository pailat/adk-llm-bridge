/**
 * Feature 4 — multimodal image input.
 *
 * Reads the checked-in PNG, base64-encodes it, and sends it as an `inlineData`
 * part alongside a text instruction in the user message. The bridge passes the
 * image through to the model's native vision input.
 *
 * Alternative (documented, not used here to keep the demo offline): instead of
 * inline base64 you can reference a public URL with a `fileData` part:
 *
 *   { fileData: { fileUri: "https://example.com/cat.png", mimeType: "image/png" } }
 *
 * RunConfig.saveInputBlobsAsArtifacts is left at its default (false) so the
 * image reaches the model rather than being swapped for an artifact reference.
 */
import { LlmAgent } from "@google/adk";
import type { Part } from "@google/genai";
import { makeModel } from "../providers";
import { buildMessage } from "../runner";
import type { Demo } from "../types";

async function loadImageBase64(): Promise<string> {
  // Bun.file + import.meta.url resolves the asset relative to this module.
  const url = new URL("../../assets/sample-image.png", import.meta.url);
  const bytes = await Bun.file(url).bytes();
  return Buffer.from(bytes).toString("base64");
}

export const multimodalDemo: Demo = {
  name: "multimodal",
  description: "image input via Content inlineData { mimeType, data: base64 }",

  async run({ harness, out, config }) {
    out.header(multimodalDemo, config);

    const base64 = await loadImageBase64();
    const imagePart: Part = {
      inlineData: { mimeType: "image/png", data: base64 },
    };

    out.label("image", `assets/sample-image.png (${base64.length} b64 chars)`);
    out.section("response");

    const agent = new LlmAgent({
      name: "vision",
      model: makeModel(config),
      instruction: "Describe the image you are given succinctly.",
    });

    const result = await harness.run(
      agent,
      buildMessage(
        "What is the dominant color of this image? Answer in one short sentence.",
        [imagePart],
      ),
    );

    out.label("final", result.finalText.trim());
    out.section("usage");
    out.usage(result.usage);
  },
};
