import { describe, expect, it } from "bun:test";
import { FinishReason } from "@google/genai";
import {
  malformedToolCallResponse,
  parseToolArguments,
} from "../../src/converters/tool-arguments.js";

describe("parseToolArguments", () => {
  it("parses objects, keeps exact large integers, treats empty as no args", () => {
    expect(parseToolArguments('{"a":1}', "f")).toEqual({
      ok: true,
      args: { a: 1 },
    });
    expect(parseToolArguments('{"id":12345678901234567890}', "f")).toEqual({
      ok: true,
      args: { id: "12345678901234567890" },
    });
    expect(parseToolArguments("", "f")).toEqual({ ok: true, args: {} });
    expect(parseToolArguments("  ", "f")).toEqual({ ok: true, args: {} });
  });

  it("reports truncated and non-object arguments", () => {
    expect(parseToolArguments('{"city":"Par', "get_weather")).toEqual({
      ok: false,
      failure: { name: "get_weather", reason: "invalid-json" },
    });
    expect(parseToolArguments("[1]", "f")).toEqual({
      ok: false,
      failure: { name: "f", reason: "not-an-object" },
    });
  });
});

describe("malformedToolCallResponse", () => {
  it("sets MALFORMED_FUNCTION_CALL with a matching errorCode, drops functionCalls, keeps text", () => {
    const response = malformedToolCallResponse(
      [
        { text: "thinking", thought: true },
        { text: "calling" },
        { functionCall: { id: "1", name: "ok", args: {} } },
      ],
      [{ name: "bad", reason: "invalid-json" }],
      { usageMetadata: { promptTokenCount: 3 } },
    );
    expect(response.finishReason).toBe(FinishReason.MALFORMED_FUNCTION_CALL);
    expect(response.errorCode).toBe("MALFORMED_FUNCTION_CALL");
    expect(response.turnComplete).toBe(true);
    expect(response.errorMessage).toContain("bad (invalid-json)");
    expect(response.content?.parts).toEqual([
      { text: "thinking", thought: true },
      { text: "calling" },
    ]);
    expect(response.usageMetadata).toEqual({ promptTokenCount: 3 });
  });

  it("has no content when nothing but calls was produced", () => {
    const response = malformedToolCallResponse(
      [{ functionCall: { name: "x", args: {} } }],
      [{ name: "", reason: "not-an-object" }],
    );
    expect(response.content).toBeUndefined();
    expect(response.errorMessage).toContain("(unnamed)");
  });
});
