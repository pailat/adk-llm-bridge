import { describe, expect, test } from "bun:test";
import {
  EMPTY_THINKING_SIGNATURE_PREFIX,
  isNamespacedThinkingSignature,
  readThinking,
  readThinkingSignature,
  THINKING_SIGNATURE_PREFIX,
} from "../../../src/providers/anthropic/converters/thinking-signature.js";

describe("thinking-signature", () => {
  test("readThinking decodes namespaced, empty-marker and legacy signatures", () => {
    expect(
      readThinking({ thoughtSignature: `${THINKING_SIGNATURE_PREFIX}abc` }),
    ).toEqual({
      signature: "abc",
      emptyThinking: false,
    });
    expect(
      readThinking({
        thoughtSignature: `${EMPTY_THINKING_SIGNATURE_PREFIX}abc`,
      }),
    ).toEqual({
      signature: "abc",
      emptyThinking: true,
    });
    expect(readThinking({ thought: true, thoughtSignature: "legacy" })).toEqual(
      {
        signature: "legacy",
        emptyThinking: false,
      },
    );
  });

  test("readThinkingSignature ignores un-prefixed signatures without thought and empty payloads", () => {
    expect(
      readThinkingSignature({ thoughtSignature: "gemini" }),
    ).toBeUndefined();
    expect(
      readThinkingSignature({ thoughtSignature: THINKING_SIGNATURE_PREFIX }),
    ).toBeUndefined();
    expect(
      readThinkingSignature({
        thoughtSignature: `${THINKING_SIGNATURE_PREFIX}xyz`,
      }),
    ).toBe("xyz");
  });

  test("isNamespacedThinkingSignature requires a string with the prefix", () => {
    expect(isNamespacedThinkingSignature(`${THINKING_SIGNATURE_PREFIX}x`)).toBe(
      true,
    );
    expect(isNamespacedThinkingSignature("plain")).toBe(false);
    expect(isNamespacedThinkingSignature(42)).toBe(false);
  });
});
