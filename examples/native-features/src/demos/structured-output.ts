/**
 * Feature 3 — structured output.
 *
 * Uses `LlmAgent.outputSchema` with a zod (v4) object. ADK 1.2 maps this to the
 * provider's native `responseSchema` / structured-output mode. Do NOT set
 * `generateContentConfig.responseSchema` directly — ADK 1.2 rejects that at
 * construction time.
 *
 * Setting `outputSchema` also forces `disallowTransferToParent/Peers`, so the
 * agent is standalone (it cannot route to sub-agents). `outputKey` makes ADK
 * auto-parse the JSON answer into `session.state`.
 */
import { LlmAgent } from "@google/adk";
import { z } from "zod";
import { makeModel } from "../providers";
import { buildMessage } from "../runner";
import type { Demo } from "../types";

/** Parse JSON text, returning undefined instead of throwing. */
function safeParse(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return undefined;
  }
}

const CityFact = z.object({
  city: z.string().describe("City name"),
  country: z.string().describe("Country the city is in"),
  populationMillions: z.number().describe("Approximate population in millions"),
  summary: z.string().describe("One-sentence summary of the city"),
});

export const structuredOutputDemo: Demo = {
  name: "structured-output",
  description: "JSON output enforced via LlmAgent.outputSchema (zod v4)",

  async run({ harness, out, config }) {
    out.header(structuredOutputDemo, config);

    const agent = new LlmAgent({
      name: "city_facts",
      model: makeModel(config),
      instruction:
        "Return facts about the requested city as structured data only.",
      // outputSchema → ADK maps to native responseSchema. Never set
      // generateContentConfig.responseSchema directly (it throws in ADK 1.2).
      outputSchema: CityFact,
      // Auto-parse + store the JSON answer in session.state under this key.
      outputKey: "cityFact",
    });

    out.label("outputSchema", "z.object({ city, country, populationMillions, summary })");
    out.section("response");

    const result = await harness.run(
      agent,
      buildMessage("Give me facts about Kyoto."),
      // Lets the harness read the auto-parsed object from session.state when ADK
      // returns it as JSON text (the Anthropic path returns a json_output call
      // instead — the harness normalizes both into result.structured).
      { outputKey: "cityFact" },
    );

    // `result.structured` is the normalized object (from the json_output tool
    // call, session.state[outputKey], or JSON text — whichever ADK produced).
    const raw = result.structured ?? safeParse(result.finalText);

    if (raw === undefined) {
      out.label("note", "no structured output captured");
    } else {
      // Re-validate with the same schema to prove it matches the contract.
      const parsed = CityFact.parse(raw);
      out.label("raw JSON", JSON.stringify(parsed));
      out.section("parsed object");
      out.label("city", parsed.city);
      out.label("country", parsed.country);
      out.label("populationMillions", parsed.populationMillions);
      out.label("summary", parsed.summary);
    }

    out.section("usage");
    out.usage(result.usage);
  },
};
