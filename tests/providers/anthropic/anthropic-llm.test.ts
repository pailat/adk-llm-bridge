import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { LlmRequest, LlmResponse } from "@google/adk";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { resetAllConfigs, setProviderConfig } from "../../../src/config.js";
import { _resetAnthropicWarningState } from "../../../src/providers/anthropic/anthropic-llm.js";
import {
  ANTHROPIC_MODEL_PATTERNS,
  AnthropicLlm,
} from "../../../src/providers/anthropic/index.js";
import { useCleanEnv } from "../../helpers/env.js";
import {
  describeConnectError,
  describeModelPatterns,
} from "../../helpers/provider-test-helpers.js";

type AnthropicRequestOptions = { signal?: AbortSignal | null };

function userRequest(): LlmRequest {
  return {
    contents: [{ role: "user", parts: [{ text: "Hi" }] }],
    liveConnectConfig: {},
    toolsDict: {},
  } as LlmRequest;
}

function makeLlm(): AnthropicLlm {
  return new AnthropicLlm({
    model: "claude-sonnet-4-5-20250929",
    apiKey: "sk-ant-test",
  });
}

function messagesClient(llm: AnthropicLlm): {
  create: (body: unknown, options?: AnthropicRequestOptions) => unknown;
  stream: (body: unknown, options?: AnthropicRequestOptions) => unknown;
} {
  return (
    llm as unknown as {
      client: {
        messages: {
          create: (body: unknown, options?: AnthropicRequestOptions) => unknown;
          stream: (body: unknown, options?: AnthropicRequestOptions) => unknown;
        };
      };
    }
  ).client.messages;
}

async function drain(
  gen: AsyncGenerator<LlmResponse, void>,
): Promise<LlmResponse[]> {
  const out: LlmResponse[] = [];
  for await (const response of gen) out.push(response);
  return out;
}

function abortableNever(signal?: AbortSignal | null): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return;

    const abort = () => {
      signal.removeEventListener("abort", abort);
      const error = new Error("Request was aborted");
      error.name = "AbortError";
      reject(error);
    };

    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

describe("AnthropicLlm", () => {
  useCleanEnv(["ANTHROPIC_API_KEY"]);
  beforeEach(() => {
    resetAllConfigs();
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

      // Counts warn calls whose first arg mentions the downgrade. The
      // module-level one-time flag is reset before each test so absolute
      // counts are deterministic.
      beforeEach(() => {
        _resetAnthropicWarningState();
      });

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
            {
              tools: [tool],
              toolChoice: { type: "tool", name: "json_output" },
            },
          );
          expect(first.tool_choice).toEqual({ type: "auto" });
          // The first downgrade emits exactly one warning.
          expect(downgradeWarnCount(warnSpy)).toBe(1);

          // A second identical call must NOT add another downgrade warning.
          const second = llm.callBuild(
            { thinking: { type: "enabled", budget_tokens: 2048 } },
            {
              tools: [tool],
              toolChoice: { type: "tool", name: "json_output" },
            },
          );
          expect(second.tool_choice).toEqual({ type: "auto" });
          expect(downgradeWarnCount(warnSpy)).toBe(1);
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
            {
              tools: [tool],
              toolChoice: { type: "tool", name: "json_output" },
            },
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

  describe("request fix-ups (LLM-4)", () => {
    function captureBody(llm: AnthropicLlm): { body?: unknown } {
      const captured: { body?: unknown } = {};
      messagesClient(llm).create = (body) => {
        captured.body = body;
        return Promise.resolve({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "ok", citations: null }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      };
      return captured;
    }

    it("sends a user message when contents is empty, without mutating the request", async () => {
      const llm = makeLlm();
      const captured = captureBody(llm);
      const request = {
        contents: [],
        config: { systemInstruction: "Be brief." },
        liveConnectConfig: {},
        toolsDict: {},
      } as unknown as LlmRequest;

      await drain(llm.generateContentAsync(request));

      const messages = (captured.body as { messages: { role: string }[] })
        .messages;
      expect(messages).toHaveLength(1);
      expect(messages[0]?.role).toBe("user");
      expect(request.contents).toEqual([]);
    });

    it("appends a user turn when the history ends with the model", async () => {
      const llm = makeLlm();
      const captured = captureBody(llm);
      const request = {
        contents: [
          { role: "user", parts: [{ text: "Hi" }] },
          { role: "model", parts: [{ text: "Hello" }] },
        ],
        liveConnectConfig: {},
        toolsDict: {},
      } as unknown as LlmRequest;

      await drain(llm.generateContentAsync(request));

      const messages = (captured.body as { messages: { role: string }[] })
        .messages;
      expect(messages.map((m) => m.role)).toEqual([
        "user",
        "assistant",
        "user",
      ]);
      expect(request.contents).toHaveLength(2);
    });

    it("leaves a history that already ends with a user turn untouched", async () => {
      const llm = makeLlm();
      const captured = captureBody(llm);

      await drain(llm.generateContentAsync(userRequest()));

      expect((captured.body as { messages: unknown[] }).messages).toHaveLength(
        1,
      );
    });
  });

  describe("global transport config (LLM-7)", () => {
    function clientOptions(llm: AnthropicLlm): {
      timeout: number;
      maxRetries: number;
    } {
      return (
        llm as unknown as { client: { timeout: number; maxRetries: number } }
      ).client;
    }

    it("applies global timeout and maxRetries", () => {
      setProviderConfig("anthropic", {
        apiKey: "sk-ant-test",
        timeout: 12_345,
        maxRetries: 7,
      } as Parameters<typeof setProviderConfig<"anthropic">>[1]);

      const llm = new AnthropicLlm({ model: "claude-sonnet-4-5-20250929" });

      expect(clientOptions(llm)).toMatchObject({
        timeout: 12_345,
        maxRetries: 7,
      });
    });

    it("lets the instance config override the global config", () => {
      setProviderConfig("anthropic", {
        apiKey: "sk-ant-test",
        timeout: 12_345,
        maxRetries: 7,
      } as Parameters<typeof setProviderConfig<"anthropic">>[1]);

      const llm = new AnthropicLlm({
        model: "claude-sonnet-4-5-20250929",
        timeout: 5_000,
        maxRetries: 1,
      });

      expect(clientOptions(llm)).toMatchObject({
        timeout: 5_000,
        maxRetries: 1,
      });
    });

    it("stops consuming a stream once the signal is aborted", async () => {
      const llm = makeLlm();
      const controller = new AbortController();
      let pulled = 0;
      messagesClient(llm).stream = () =>
        (async function* () {
          for (let i = 0; i < 5; i++) {
            pulled++;
            if (i === 1) controller.abort();
            yield {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: `chunk${i}` },
            };
          }
        })();

      const responses = await drain(
        llm.generateContentAsync(userRequest(), true, controller.signal),
      );

      expect(pulled).toBe(2);
      // The chunk that arrives after the abort is not converted or emitted.
      expect(responses).toHaveLength(1);
    });
  });

  describe("ADK Claude marker (LLM-9)", () => {
    it("marks instances so ADK keeps adk-* function call ids", () => {
      expect(
        (makeLlm() as unknown as Record<symbol, unknown>)[
          Symbol.for("google.adk.claudeModel")
        ],
      ).toBe(true);
    });
  });

  describe("span annotations (OBS-3)", () => {
    type FakeSpan = {
      attributes: Record<string, unknown>;
      status?: { code: number };
      exceptions: unknown[];
      setAttributes(attrs: Record<string, unknown>): FakeSpan;
      setAttribute(key: string, value: unknown): FakeSpan;
      setStatus(status: { code: number }): FakeSpan;
      recordException(error: unknown): void;
    };

    function fakeSpan(): FakeSpan {
      const span: FakeSpan = {
        attributes: {},
        exceptions: [],
        setAttributes(attrs) {
          Object.assign(span.attributes, attrs);
          return span;
        },
        setAttribute(key, value) {
          span.attributes[key] = value;
          return span;
        },
        setStatus(status) {
          span.status = status;
          return span;
        },
        recordException(error) {
          span.exceptions.push(error);
        },
      };
      return span;
    }

    it("annotates the active span with provider and response info (non-stream)", async () => {
      const span = fakeSpan();
      const spy = spyOn(trace, "getActiveSpan").mockReturnValue(span as never);
      try {
        const llm = makeLlm();
        messagesClient(llm).create = () =>
          Promise.resolve({
            id: "msg_abc",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-5-20250929",
            content: [{ type: "text", text: "ok", citations: null }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          });

        await drain(llm.generateContentAsync(userRequest()));

        expect(span.attributes).toMatchObject({
          "gen_ai.provider.name": "anthropic",
          "gen_ai.response.id": "msg_abc",
          "gen_ai.response.model": "claude-sonnet-4-5-20250929",
          "server.address": "api.anthropic.com",
        });
        expect(span.status).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
    });

    it("annotates the span from message_start when streaming", async () => {
      const span = fakeSpan();
      const spy = spyOn(trace, "getActiveSpan").mockReturnValue(span as never);
      try {
        const llm = makeLlm();
        messagesClient(llm).stream = () =>
          (async function* () {
            yield {
              type: "message_start",
              message: {
                id: "msg_stream",
                model: "claude-sonnet-4-5-20250929",
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            };
            yield { type: "message_stop" };
          })();

        await drain(llm.generateContentAsync(userRequest(), true));

        expect(span.attributes["gen_ai.response.id"]).toBe("msg_stream");
      } finally {
        spy.mockRestore();
      }
    });

    it("marks the span as failed when the provider call throws", async () => {
      const span = fakeSpan();
      const spy = spyOn(trace, "getActiveSpan").mockReturnValue(span as never);
      try {
        const llm = makeLlm();
        messagesClient(llm).create = () =>
          Promise.reject(
            Object.assign(new Error("rate limited"), { status: 429 }),
          );

        const responses = await drain(llm.generateContentAsync(userRequest()));

        expect(responses[0]?.errorCode).toBe("API_ERROR_429");
        expect(span.attributes["error.type"]).toBe("429");
        expect(span.status?.code).toBe(SpanStatusCode.ERROR);
        expect(span.exceptions).toHaveLength(1);
      } finally {
        spy.mockRestore();
      }
    });

    it("does not mark the span as failed on a caller abort", async () => {
      const span = fakeSpan();
      const spy = spyOn(trace, "getActiveSpan").mockReturnValue(span as never);
      try {
        const llm = makeLlm();
        const controller = new AbortController();
        controller.abort();
        messagesClient(llm).create = (_body, options) =>
          abortableNever(options?.signal);

        await drain(
          llm.generateContentAsync(userRequest(), false, controller.signal),
        );

        expect(span.status).toBeUndefined();
        expect(span.exceptions).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("cancellation", () => {
    it("passes a pre-aborted signal without yielding a provider error", async () => {
      const llm = makeLlm();
      const controller = new AbortController();
      controller.abort();
      let capturedSignal: AbortSignal | null | undefined;
      messagesClient(llm).create = (_body, options) => {
        capturedSignal = options?.signal;
        return abortableNever(options?.signal);
      };

      const responses = await drain(
        llm.generateContentAsync(userRequest(), false, controller.signal),
      );

      expect(capturedSignal).toBe(controller.signal);
      expect(responses).toEqual([]);
    });

    it("cancels an active non-streaming request without yielding a provider error", async () => {
      const llm = makeLlm();
      const controller = new AbortController();
      let capturedSignal: AbortSignal | null | undefined;
      let markStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      messagesClient(llm).create = (_body, options) => {
        capturedSignal = options?.signal;
        markStarted();
        return abortableNever(options?.signal);
      };

      const pending = drain(
        llm.generateContentAsync(userRequest(), false, controller.signal),
      );
      await started;
      controller.abort();

      expect(capturedSignal).toBe(controller.signal);
      expect(await pending).toEqual([]);
    });

    it("cancels an active stream without turning the abort into a provider error", async () => {
      const llm = makeLlm();
      const controller = new AbortController();
      let capturedSignal: AbortSignal | null | undefined;
      messagesClient(llm).stream = (_body, options) => {
        capturedSignal = options?.signal;
        return (async function* () {
          yield {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Hello" },
          };
          await abortableNever(options?.signal);
        })();
      };

      const responses = llm.generateContentAsync(
        userRequest(),
        true,
        controller.signal,
      );
      const first = await responses.next();
      controller.abort();
      const final = await responses.next();

      expect(capturedSignal).toBe(controller.signal);
      expect(first.value).toMatchObject({ partial: true });
      expect(final).toEqual({ value: undefined, done: true });
    });
  });

  describeConnectError(AnthropicLlm, "claude-sonnet-4-5-20250929");
});
