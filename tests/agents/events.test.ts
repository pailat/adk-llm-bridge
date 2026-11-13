import { describe, expect, test } from "bun:test";
import { isExternalAgentEvent } from "../../src/agents/events.js";

describe("isExternalAgentEvent", () => {
  test("accepts every known event type", () => {
    for (const type of [
      "started",
      "output",
      "tool_call",
      "tool_result",
      "error",
      "state_delta",
      "completed",
    ]) {
      expect(isExternalAgentEvent({ type })).toBe(true);
    }
  });

  test("rejects null, primitives, and unknown or missing types", () => {
    expect(isExternalAgentEvent(null)).toBe(false);
    expect(isExternalAgentEvent("started")).toBe(false);
    expect(isExternalAgentEvent({ type: "nope" })).toBe(false);
    expect(isExternalAgentEvent({})).toBe(false);
  });
});
