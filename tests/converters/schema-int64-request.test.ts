import { describe, expect, it } from "bun:test";
import { type LlmRequest, zodObjectToSchema } from "@google/adk";
import type { Schema } from "@google/genai";
import { z } from "zod";
import {
  convertRequest,
  convertStructuredOutput,
} from "../../src/converters/request.js";
import {
  convertAnthropicRequest,
  convertAnthropicStructuredOutput,
} from "../../src/providers/anthropic/converters/request.js";

// e2e-llm F2: ADK turns zod `.min(2)` into a Gemini Schema whose int64 count
// fields are strings ("2"). OpenAI and xAI answered 400 when they reached the
// wire verbatim. Every provider path must send integers.

const zodShape = z.object({
  landmarks: z.array(z.string()).min(2).max(4),
  name: z.string().min(1).max(40),
  n: z.number().int().max(5),
});

/** The Gemini schema ADK builds from the zod object (public ADK API). */
const geminiSchema = zodObjectToSchema(zodShape) as Schema;

const expectedSchema = {
  type: "object",
  properties: {
    landmarks: {
      type: "array",
      minItems: 2,
      maxItems: 4,
      items: { type: "string" },
    },
    name: { type: "string", minLength: 1, maxLength: 40 },
    n: { type: "integer", minimum: -9007199254740991, maximum: 5 },
  },
  required: ["landmarks", "name", "n"],
};

function request(config: LlmRequest["config"]): LlmRequest {
  return {
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    config,
    liveConnectConfig: {},
    toolsDict: {},
  } as LlmRequest;
}

function toolRequest(): LlmRequest {
  return request({
    tools: [
      {
        functionDeclarations: [
          { name: "pick", description: "Pick", parameters: geminiSchema },
        ],
      },
    ],
  });
}

describe("int64 schema counts reach providers as integers (F2)", () => {
  it("ADK's public zod conversion emits string counts (precondition)", () => {
    const landmarks = geminiSchema.properties?.landmarks;
    expect(landmarks?.minItems).toBe("2");
    expect(landmarks?.maxItems).toBe("4");
    expect(geminiSchema.properties?.name?.minLength).toBe("1");
  });

  it("OpenAI-compatible response_format carries integers", () => {
    const params = convertStructuredOutput(
      request({ responseSchema: geminiSchema }),
    ) as {
      response_format: { json_schema: { schema: Record<string, unknown> } };
    };
    expect(params.response_format.json_schema.schema).toEqual(expectedSchema);
  });

  it("OpenAI-compatible tool parameters carry integers", () => {
    const { tools } = convertRequest(toolRequest(), "gpt-4.1-nano");
    const tool = tools?.[0] as { function: { parameters: unknown } };
    expect(tool.function.parameters).toEqual(expectedSchema);
  });

  it("Anthropic tool input_schema carries integers", () => {
    const { tools } = convertAnthropicRequest(toolRequest());
    expect(tools?.[0]?.input_schema as unknown).toEqual(expectedSchema);
  });

  it("Anthropic structured-output tool carries integers", () => {
    const out = convertAnthropicStructuredOutput(
      request({ responseSchema: geminiSchema }),
    );
    expect(out?.tool.input_schema as unknown).toEqual(expectedSchema);
  });

  it("JSON on the wire has no quoted counts", () => {
    const params = convertStructuredOutput(
      request({ responseSchema: geminiSchema }),
    );
    expect(JSON.stringify(params)).not.toMatch(
      /"(?:min|max)(?:Items|Length|Properties)":"/,
    );
  });
});
