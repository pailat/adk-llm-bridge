import { describe, expect, it } from "bun:test";
import type {
  ExternalAgentModelUsage,
  ExternalAgentUsage,
} from "../../src/agents/index.js";

describe("ExternalAgentUsage.byModel", () => {
  it("holds counters only: scope belongs to the whole usage", () => {
    const perModel: ExternalAgentModelUsage = {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 4,
      totalCostUsd: 0.5,
    };
    const usage: ExternalAgentUsage = {
      scope: "run",
      byModel: { "claude-haiku": perModel },
    };
    const withScope: ExternalAgentUsage = {
      // @ts-expect-error a per-model entry has no scope of its own
      byModel: { "claude-haiku": { inputTokens: 1, scope: "session" } },
    };
    const nested: ExternalAgentUsage = {
      // @ts-expect-error a per-model entry has no nested breakdown
      byModel: { "claude-haiku": { byModel: {} } },
    };
    expect(usage.byModel?.["claude-haiku"]).toBe(perModel);
    expect(withScope).toBeDefined();
    expect(nested).toBeDefined();
  });
});
