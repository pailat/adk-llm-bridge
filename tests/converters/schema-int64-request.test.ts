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

// ADK turns zod `.min(2)` into a Gemini Schema whose int64 count
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

describe("int64 schema counts reach providers as integers", () => {
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

/** A JSON Schema with string counts at the root and in nested positions. */
function jsonSchemaWithStringCounts(): Record<string, unknown> {
  return {
    type: "object",
    minProperties: "1",
    properties: {
      tags: {
        type: "array",
        minItems: "2",
        maxItems: "4",
        items: { type: "string", maxLength: "8" },
      },
      pick: { anyOf: [{ $ref: "#/$defs/word" }, { type: "null" }] },
      "x-note": { type: "string", default: "minItems: 2" },
    },
    additionalProperties: { type: "string", minLength: "1" },
    $defs: { word: { type: "string", minLength: "3", pattern: "^[a-z]+$" } },
    required: ["tags"],
  };
}

const expectedJsonSchema = {
  type: "object",
  minProperties: 1,
  properties: {
    tags: {
      type: "array",
      minItems: 2,
      maxItems: 4,
      items: { type: "string", maxLength: 8 },
    },
    pick: { anyOf: [{ $ref: "#/$defs/word" }, { type: "null" }] },
    "x-note": { type: "string", default: "minItems: 2" },
  },
  additionalProperties: { type: "string", minLength: 1 },
  $defs: { word: { type: "string", minLength: 3, pattern: "^[a-z]+$" } },
  required: ["tags"],
};

function jsonToolRequest(parametersJsonSchema: unknown): LlmRequest {
  return request({
    tools: [
      {
        functionDeclarations: [
          { name: "pick", description: "Pick", parametersJsonSchema },
        ],
      },
    ],
  });
}

describe("int64 counts in JSON Schema fields reach providers as integers", () => {
  it("OpenAI-compatible responseJsonSchema carries integers", () => {
    const input = jsonSchemaWithStringCounts();
    const params = convertStructuredOutput(
      request({ responseJsonSchema: input }),
    ) as {
      response_format: { json_schema: { schema: Record<string, unknown> } };
    };
    expect(params.response_format.json_schema.schema).toEqual(
      expectedJsonSchema,
    );
    expect(input).toEqual(jsonSchemaWithStringCounts());
  });

  it("OpenAI-compatible parametersJsonSchema carries integers", () => {
    const input = jsonSchemaWithStringCounts();
    const { tools } = convertRequest(jsonToolRequest(input), "gpt-4.1-nano");
    const tool = tools?.[0] as { function: { parameters: unknown } };
    expect(tool.function.parameters).toEqual(expectedJsonSchema);
    expect(input).toEqual(jsonSchemaWithStringCounts());
  });

  it("Anthropic responseJsonSchema carries integers", () => {
    const input = jsonSchemaWithStringCounts();
    const out = convertAnthropicStructuredOutput(
      request({ responseJsonSchema: input }),
    );
    expect(out?.tool.input_schema as unknown).toEqual(expectedJsonSchema);
    expect(input).toEqual(jsonSchemaWithStringCounts());
  });

  it("Anthropic parametersJsonSchema carries integers", () => {
    const input = jsonSchemaWithStringCounts();
    const { tools } = convertAnthropicRequest(jsonToolRequest(input));
    expect(tools?.[0]?.input_schema as unknown).toEqual(expectedJsonSchema);
    expect(input).toEqual(jsonSchemaWithStringCounts());
  });

  it("keeps type-name case and unknown keywords in JSON Schema fields", () => {
    const input = {
      type: "OBJECT",
      "x-vendor": true,
      minimum: "1",
      maxItems: "two",
    };
    const params = convertStructuredOutput(
      request({ responseJsonSchema: input }),
    ) as {
      response_format: { json_schema: { schema: Record<string, unknown> } };
    };
    expect(params.response_format.json_schema.schema).toEqual(input);
    const { tools } = convertAnthropicRequest(jsonToolRequest(input));
    expect(tools?.[0]?.input_schema as unknown).toEqual(input);
  });

  it("JSON on the wire has no quoted counts for JSON Schema fields", () => {
    const params = convertStructuredOutput(
      request({ responseJsonSchema: jsonSchemaWithStringCounts() }),
    );
    const { tools } = convertAnthropicRequest(
      jsonToolRequest(jsonSchemaWithStringCounts()),
    );
    for (const wire of [JSON.stringify(params), JSON.stringify(tools)]) {
      expect(wire).not.toMatch(/"(?:min|max)(?:Items|Length|Properties)":"/);
    }
  });
});

describe("__proto__ tool arguments in parametersJsonSchema", () => {
  const raw =
    '{"type":"object","properties":{"__proto__":{"type":"string","minLength":"1"},"name":{"type":"string"}},"required":["__proto__"]}';
  const expected =
    '{"type":"object","properties":{"__proto__":{"type":"string","minLength":1},"name":{"type":"string"}},"required":["__proto__"]}';

  it("OpenAI-compatible keeps the property", () => {
    const { tools } = convertRequest(
      jsonToolRequest(JSON.parse(raw)),
      "gpt-4.1-nano",
    );
    const tool = tools?.[0] as { function: { parameters: unknown } };
    expect(JSON.stringify(tool.function.parameters)).toBe(expected);
  });

  it("Anthropic keeps the property", () => {
    const { tools } = convertAnthropicRequest(jsonToolRequest(JSON.parse(raw)));
    expect(JSON.stringify(tools?.[0]?.input_schema)).toBe(expected);
  });
});
