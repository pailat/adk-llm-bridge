import { describe, expect, it } from "bun:test";
import { BaseProviderLlm } from "../../src/core/base-provider-llm";
import type { LlmRequest, LlmResponse } from "@google/adk";

// Concrete subclass for testing the abstract base
class TestLlm extends BaseProviderLlm {
  async *generateContentAsync(
    _llmRequest: LlmRequest,
    _stream?: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    // no-op
  }
}

describe("BaseProviderLlm", () => {
  describe("constructor model validation", () => {
    it("accepts a valid model string", () => {
      const llm = new TestLlm({ model: "gpt-4" });
      expect(llm.model).toBe("gpt-4");
    });

    it("throws on empty model", () => {
      expect(() => new TestLlm({ model: "" })).toThrow(
        "[adk-llm-bridge] model is required and cannot be empty.",
      );
    });

    it("throws on whitespace-only model", () => {
      expect(() => new TestLlm({ model: "   " })).toThrow(
        "[adk-llm-bridge] model is required and cannot be empty.",
      );
    });
  });

  describe("createErrorResponse", () => {
    it("returns error response for standard errors", () => {
      const llm = new TestLlm({ model: "test-model" });
      // Access protected method via subclass for testing
      const response = (
        llm as unknown as {
          createErrorResponse: (e: unknown, p: string) => LlmResponse;
        }
      ).createErrorResponse(new Error("something broke"), "TEST");
      expect(response.errorCode).toBe("TEST_ERROR");
      expect(response.errorMessage).toBe("something broke");
      expect(response.turnComplete).toBe(true);
    });

    it("returns API error code for errors with status", () => {
      const llm = new TestLlm({ model: "test-model" });
      const apiError = Object.assign(new Error("rate limited"), {
        status: 429,
      });
      const response = (
        llm as unknown as {
          createErrorResponse: (e: unknown, p: string) => LlmResponse;
        }
      ).createErrorResponse(apiError, "TEST");
      expect(response.errorCode).toBe("API_ERROR_429");
      expect(response.errorMessage).toBe("rate limited");
    });
  });

  describe("connect", () => {
    it("throws not supported error", async () => {
      const llm = new TestLlm({ model: "test-model" });
      expect(llm.connect({} as LlmRequest)).rejects.toThrow(
        "does not support bidirectional streaming",
      );
    });
  });
});
