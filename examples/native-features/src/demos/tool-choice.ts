/**
 * Feature 5 — tool_choice (forced function calling).
 *
 * Defines a real `FunctionTool` and forces the model to call it via
 * `generateContentConfig.toolConfig.functionCallingConfig`:
 *
 *   { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: ["get_weather"] }
 *
 * ANY constrains the model to emit a function call (restricted to the allowed
 * names) rather than a free-text answer. The harness surfaces the captured
 * function call(s) in `result.toolCalls`.
 *
 * Loop guard: because `mode: ANY` forces a function call on EVERY turn, once
 * the tool returns its result the model is forced to call a tool again — an
 * unbounded loop. We bound the run with `maxLlmCalls: 1` so the single forced
 * call fires and ADK then stops (the harness treats the limit as the expected
 * stop signal). This is the idiomatic ADK way to demonstrate a one-shot forced
 * tool call.
 */
import { FunctionTool, LlmAgent } from "@google/adk";
import type { Context } from "@google/adk";
import { FunctionCallingConfigMode } from "@google/genai";
import { z } from "zod";
import { makeModel } from "../providers";
import { buildMessage } from "../runner";
import type { Demo } from "../types";

const getWeather = new FunctionTool({
  name: "get_weather",
  description: "Get the current weather for a city.",
  parameters: z.object({
    city: z.string().describe("City to look up the weather for"),
    unit: z
      .enum(["celsius", "fahrenheit"])
      .optional()
      .describe("Temperature unit"),
  }),
  execute: ({ city, unit = "celsius" }, _context?: Context) => {
    return {
      status: "success",
      city,
      unit,
      temperature: unit === "celsius" ? 21 : 70,
      condition: "partly cloudy",
    };
  },
});

export const toolChoiceDemo: Demo = {
  name: "tool-choice",
  description:
    "force a tool via toolConfig.functionCallingConfig { mode: ANY, allowedFunctionNames }",

  async run({ harness, out, config }) {
    out.header(toolChoiceDemo, config);

    const agent = new LlmAgent({
      name: "weather_bot",
      model: makeModel(config),
      instruction: "Help the user with weather questions using your tools.",
      tools: [getWeather],
      generateContentConfig: {
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.ANY,
            allowedFunctionNames: ["get_weather"],
          },
        },
      },
    });

    out.label("functionCallingConfig", {
      mode: "ANY",
      allowedFunctionNames: ["get_weather"],
    });
    out.section("forced tool call");

    const result = await harness.run(
      agent,
      buildMessage("Tell me about Tokyo's weather."),
      // Cap LLM calls so the forced (mode: ANY) loop stops after one call.
      { maxLlmCalls: 1 },
    );

    if (result.toolCalls.length > 0) {
      for (const call of result.toolCalls) {
        out.label(`call → ${call.name}`, call.args);
      }
    } else {
      out.label("note", "no function call captured (provider may not support ANY)");
    }

    out.section("final answer");
    out.label("final", result.finalText.trim() || "(model returned tool call only)");
    if (result.stoppedByLlmCallLimit) {
      out.label(
        "note",
        "run stopped at maxLlmCalls=1 — expected: mode=ANY forces a call every turn",
      );
    }

    out.section("usage");
    out.usage(result.usage);
  },
};
