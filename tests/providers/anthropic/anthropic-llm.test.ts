import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { resetAllConfigs } from "../../../src/config.js";
import {
  ANTHROPIC_MODEL_PATTERNS,
  AnthropicLlm,
} from "../../../src/providers/anthropic/index.js";
import {
  describeConnectError,
  describeModelPatterns,
} from "../../helpers/provider-test-helpers.js";

describe("AnthropicLlm", () => {
  beforeEach(() => {
    resetAllConfigs();
    delete process.env.ANTHROPIC_API_KEY;
  });

  describeModelPatterns({
    llmClass: AnthropicLlm,
    patterns: ANTHROPIC_MODEL_PATTERNS,
    validModels: [
      "claude-sonnet-4-5-20250929",
      "claude-opus-4-5-20251101",
      "claude-haiku-4-5-20251001",
      "claude-3-5-haiku-latest",
      "claude-3-opus-20240229",
      "claude-3-haiku-20240307",
    ],
    invalidModels: ["gpt-4.1", "grok-4", "gemini-2.0-flash", "llama-3.1"],
  });

  describe("constructor", () => {
    it("creates instance with model and apiKey", () => {
      const llm = new AnthropicLlm({
        model: "claude-sonnet-4-5-20250929",
        apiKey: "sk-ant-test",
      });
      expect(llm.model).toBe("claude-sonnet-4-5-20250929");
    });

    it("uses ANTHROPIC_API_KEY env var", () => {
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

      const llm = new AnthropicLlm({ model: "claude-sonnet-4-5-20250929" });
      expect(llm.model).toBe("claude-sonnet-4-5-20250929");
    });

    it("accepts explicit apiKey", () => {
      const llm = new AnthropicLlm({
        model: "claude-sonnet-4-5-20250929",
        apiKey: "sk-ant-test-key",
      });
      expect(llm.model).toBe("claude-sonnet-4-5-20250929");
    });

    it("throws when no API key is provided", () => {
      expect(
        () => new AnthropicLlm({ model: "claude-sonnet-4-5-20250929" }),
      ).toThrow("[anthropic] API key is required");
    });

    it("accepts maxTokens option", () => {
      const llm = new AnthropicLlm({
        model: "claude-sonnet-4-5-20250929",
        apiKey: "sk-ant-test",
        maxTokens: 8192,
      });
      expect(llm.model).toBe("claude-sonnet-4-5-20250929");
    });

    it("accepts timeout option", () => {
      const llm = new AnthropicLlm({
        model: "claude-sonnet-4-5-20250929",
        apiKey: "sk-ant-test",
        timeout: 30000,
      });
      expect(llm.model).toBe("claude-sonnet-4-5-20250929");
    });

    it("accepts maxRetries option", () => {
      const llm = new AnthropicLlm({
        model: "claude-sonnet-4-5-20250929",
        apiKey: "sk-ant-test",
        maxRetries: 5,
      });
      expect(llm.model).toBe("claude-sonnet-4-5-20250929");
    });
  });

  describe("buildRequestParams (max_tokens override)", () => {
    // Expose the private buildRequestParams for assertions.
    type TestableParams = {
      max_tokens?: number;
      temperature?: number;
      top_p?: number;
      top_k?: number;
      thinking?: { type: "enabled"; budget_tokens: number };
    };
    type ToolChoice =
      | { type: "auto" }
      | { type: "none" }
      | { type: "any" }
      | { type: "tool"; name: string };
    type BuildResult = {
      max_tokens: number;
      thinking?: { type: "enabled"; budget_tokens: number };
      tool_choice?: ToolChoice;
      system?: unknown;
      tools?: Array<{ name: string; cache_control?: unknown }>;
    };
    class TestableAnthropicLlm extends AnthropicLlm {
      callBuild(
        params?: TestableParams,
        opts?: {
          system?: string;
          tools?: unknown;
          toolChoice?: ToolChoice;
        },
      ): BuildResult {
        return (
          this as unknown as {
            buildRequestParams: (
              messages: unknown[],
              system: string | undefined,
              tools: unknown,
              params?: TestableParams,
              toolChoice?: ToolChoice,
            ) => BuildResult;
          }
        ).buildRequestParams(
          [],
          opts?.system,
          opts?.tools,
          params,
          opts?.toolChoice,
        );
      }
    }

    it("uses per-request max_tokens over the instance default", () => {
      const llm = new TestableAnthropicLlm({
        model: "claude-sonnet-4-5-20250929",
        apiKey: "sk-ant-test",
        maxTokens: 4096,
      });

      expect(llm.callBuild({ max_tokens: 256 }).max_tokens).toBe(256);
    });

    it("falls back to the instance default when no per-request value", () => {
      const llm = new TestableAnthropicLlm({
        model: "claude-sonnet-4-5-20250929",
        apiKey: "sk-ant-test",
        maxTokens: 8192,
      });

      expect(llm.callBuild().max_tokens).toBe(8192);
    });

    it("raises max_tokens above the thinking budget when too small", () => {
      const llm = new TestableAnthropicLlm({
        model: "claude-sonnet-4-5-20250929",
        apiKey: "sk-ant-test",
        maxTokens: 1024,
      });

      const result = llm.callBuild({
        thinking: { type: "enabled", budget_tokens: 4096 },
      });
      expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
      expect(result.max_tokens).toBe(4097);
    });

    it("keeps max_tokens when already greater than the thinking budget", () => {
      const llm = new TestableAnthropicLlm({
        model: "claude-sonnet-4-5-20250929",
        apiKey: "sk-ant-test",
        maxTokens: 8192,
      });

      const result = llm.callBuild({
        thinking: { type: "enabled", budget_tokens: 4096 },
        max_tokens: 8192,
      });
      expect(result.max_tokens).toBe(8192);
    });

    describe("thinking + forced tool_choice reconciliation", () => {
      const tool = { name: "json_output", description: "", input_schema: {} };

      function newLlm() {
        return new TestableAnthropicLlm({
          model: "claude-sonnet-4-5-20250929",
          apiKey: "sk-ant-test",
          maxTokens: 8192,
        });
      }

      it("downgrades a forced {type:'tool'} choice to auto when thinking is on", () => {
        const result = newLlm().callBuild(
          { thinking: { type: "enabled", budget_tokens: 2048 } },
          { tools: [tool], toolChoice: { type: "tool", name: "json_output" } },
        );
        expect(result.tool_choice).toEqual({ type: "auto" });
      });

      it("downgrades a forced {type:'any'} choice to auto when thinking is on", () => {
        const result = newLlm().callBuild(
          { thinking: { type: "enabled", budget_tokens: 2048 } },
          { tools: [tool], toolChoice: { type: "any" } },
        );
        expect(result.tool_choice).toEqual({ type: "auto" });
      });

      it("preserves {type:'none'} when thinking is on", () => {
        const result = newLlm().callBuild(
          { thinking: { type: "enabled", budget_tokens: 2048 } },
          { tools: [tool], toolChoice: { type: "none" } },
        );
        expect(result.tool_choice).toEqual({ type: "none" });
      });

      it("keeps a forced {type:'tool'} choice when thinking is OFF", () => {
        const result = newLlm().callBuild(
          {},
          { tools: [tool], toolChoice: { type: "tool", name: "json_output" } },
        );
        expect(result.tool_choice).toEqual({
          type: "tool",
          name: "json_output",
        });
      });

      // Counts warn calls whose first arg mentions the downgrade. Insensitive
      // to the module-level one-time flag (which may already be tripped by an
      // earlier test) because it measures a DELTA around the action.
      const downgradeWarnCount = (
        spy: ReturnType<typeof spyOn<typeof console, "warn">>,
      ) =>
        spy.mock.calls.filter((c) =>
          String(c[0]).includes("downgrading tool_choice"),
        ).length;

      it("warns at most once when downgrading a forced tool_choice under thinking", () => {
        const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
        try {
          const llm = newLlm();
          const first = llm.callBuild(
            { thinking: { type: "enabled", budget_tokens: 2048 } },
            { tools: [tool], toolChoice: { type: "tool", name: "json_output" } },
          );
          expect(first.tool_choice).toEqual({ type: "auto" });

          // A second identical call must NOT add another downgrade warning.
          const before = downgradeWarnCount(warnSpy);
          const second = llm.callBuild(
            { thinking: { type: "enabled", budget_tokens: 2048 } },
            { tools: [tool], toolChoice: { type: "tool", name: "json_output" } },
          );
          expect(second.tool_choice).toEqual({ type: "auto" });
          expect(downgradeWarnCount(warnSpy)).toBe(before);
        } finally {
          warnSpy.mockRestore();
        }
      });

      it("does NOT warn when tool_choice is {type:'none'} under thinking", () => {
        const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
        try {
          const result = newLlm().callBuild(
            { thinking: { type: "enabled", budget_tokens: 2048 } },
            { tools: [tool], toolChoice: { type: "none" } },
          );
          expect(result.tool_choice).toEqual({ type: "none" });
          expect(downgradeWarnCount(warnSpy)).toBe(0);
        } finally {
          warnSpy.mockRestore();
        }
      });

      it("does NOT warn when thinking is OFF even with a forced tool_choice", () => {
        const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
        try {
          const result = newLlm().callBuild(
            {},
            { tools: [tool], toolChoice: { type: "tool", name: "json_output" } },
          );
          expect(result.tool_choice).toEqual({
            type: "tool",
            name: "json_output",
          });
          expect(downgradeWarnCount(warnSpy)).toBe(0);
        } finally {
          warnSpy.mockRestore();
        }
      });
    });

    describe("prompt caching wiring", () => {
      const tool = { name: "get_weather", description: "", input_schema: {} };

      it("applies cache_control only when promptCaching is enabled", () => {
        const enabled = new TestableAnthropicLlm({
          model: "claude-sonnet-4-5-20250929",
          apiKey: "sk-ant-test",
          promptCaching: true,
        });

        const result = enabled.callBuild({}, { system: "sys", tools: [tool] });
        // System widened to a cacheable text-block array.
        expect(result.system).toEqual([
          { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
        ]);
        // Last (only) tool carries cache_control.
        expect(result.tools?.[0].cache_control).toEqual({ type: "ephemeral" });
      });

      it("does not apply cache_control when promptCaching is disabled (default)", () => {
        const disabled = new TestableAnthropicLlm({
          model: "claude-sonnet-4-5-20250929",
          apiKey: "sk-ant-test",
        });

        const result = disabled.callBuild({}, { system: "sys", tools: [tool] });
        // System stays a plain string; tool carries no cache_control.
        expect(result.system).toBe("sys");
        expect(result.tools?.[0].cache_control).toBeUndefined();
      });
    });
  });

  describeConnectError(AnthropicLlm, "claude-sonnet-4-5-20250929");
});
