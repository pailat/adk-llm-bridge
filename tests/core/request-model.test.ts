/**
 * `llmRequest.model` handling: a `beforeModelCallback` (or ADK itself) may set
 * the model on the request. The provider sends it only when it is a model id
 * this provider accepts (its registered patterns, matched on the whole name as
 * `LLMRegistry` does); otherwise it sends its own model and warns once.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
  type CallbackContext,
  InMemoryRunner,
  LlmAgent,
  type LlmRequest,
  type LlmResponse,
} from "@google/adk";
import { OpenAICompatibleLlm } from "../../src/core/openai-compatible-llm.js";
import { AnthropicLlm } from "../../src/providers/anthropic/anthropic-llm.js";
import { CustomLlm } from "../../src/providers/custom/custom-llm.js";
import { OPENAI_DEFINITION } from "../../src/providers/openai/definition.js";
import { OPENROUTER_DEFINITION } from "../../src/providers/openrouter/definition.js";
import { LogCode, resetWarnOnce } from "../../src/utils/log.js";
import { captureWarnings } from "../helpers/fake-logger.js";

const COMPLETION = {
  id: "c1",
  object: "chat.completion",
  created: 0,
  model: "served-model",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "ok", refusal: null },
      finish_reason: "stop",
      logprobs: null,
    },
  ],
};

function chunk(extra: Record<string, unknown>) {
  return {
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model: "served-model",
    ...extra,
  };
}

async function* openAIStream() {
  yield chunk({ choices: [{ index: 0, delta: { content: "ok" } }] });
  yield chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
}

function request(model?: string): LlmRequest {
  return {
    ...(model === undefined ? {} : { model }),
    contents: [{ role: "user", parts: [{ text: "Hi" }] }],
    liveConnectConfig: {},
    toolsDict: {},
  } as LlmRequest;
}

/** Replaces the OpenAI SDK call and records the model of each request. */
function recordOpenAIModels(llm: OpenAICompatibleLlm): string[] {
  const models: string[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: test access to private client
  (llm as any).client.chat.completions.create = async (params: {
    model: string;
    stream?: boolean;
  }) => {
    models.push(params.model);
    return params.stream ? openAIStream() : COMPLETION;
  };
  return models;
}

const ANTHROPIC_MESSAGE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-served",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

async function* anthropicStream() {
  yield {
    type: "message_start",
    message: { ...ANTHROPIC_MESSAGE, content: [] },
  };
  yield {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  };
  yield {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "ok" },
  };
  yield { type: "content_block_stop", index: 0 };
  yield {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 1 },
  };
  yield { type: "message_stop" };
}

/** Replaces the Anthropic SDK calls and records the model of each request. */
function recordAnthropicModels(llm: AnthropicLlm): string[] {
  const models: string[] = [];
  const messages = (
    llm as unknown as {
      client: {
        messages: {
          create: (body: { model: string }) => unknown;
          stream: (body: { model: string }) => unknown;
        };
      };
    }
  ).client.messages;
  messages.create = (body) => {
    models.push(body.model);
    return {
      asResponse: async () => new Response(JSON.stringify(ANTHROPIC_MESSAGE)),
    };
  };
  messages.stream = (body) => {
    models.push(body.model);
    return anthropicStream();
  };
  return models;
}

async function drain(
  gen: AsyncGenerator<LlmResponse, void>,
): Promise<LlmResponse[]> {
  const out: LlmResponse[] = [];
  for await (const response of gen) out.push(response);
  return out;
}

function openAI(model = "gpt-4o"): OpenAICompatibleLlm {
  return new OpenAICompatibleLlm(OPENAI_DEFINITION, { model, apiKey: "k" });
}

function anthropic(model = "claude-sonnet-4-5"): AnthropicLlm {
  return new AnthropicLlm({ model, apiKey: "k" });
}

describe("llmRequest.model", () => {
  beforeEach(() => {
    resetWarnOnce();
  });

  describe("OpenAI-compatible", () => {
    for (const stream of [false, true]) {
      const mode = stream ? "streaming" : "non-streaming";

      it(`sends its own model when the request has none (${mode})`, async () => {
        const llm = openAI();
        const models = recordOpenAIModels(llm);
        await drain(llm.generateContentAsync(request(), stream));
        expect(models).toEqual(["gpt-4o"]);
      });

      it(`sends a rewritten model that matches its patterns (${mode})`, async () => {
        const llm = openAI();
        const models = recordOpenAIModels(llm);
        const spy = captureWarnings();
        try {
          await drain(llm.generateContentAsync(request("gpt-5-mini"), stream));
        } finally {
          spy.mockRestore();
        }
        expect(models).toEqual(["gpt-5-mini"]);
        expect(spy.codes).not.toContain(LogCode.REQUEST_MODEL_IGNORED);
      });

      it(`never sends a prefixed or foreign model id (${mode})`, async () => {
        for (const foreign of [
          "openai/gpt-4o",
          "claude-sonnet-4-5",
          "  ",
          "gpt-4o\nx",
        ]) {
          resetWarnOnce();
          const llm = openAI();
          const models = recordOpenAIModels(llm);
          const spy = captureWarnings();
          try {
            await drain(llm.generateContentAsync(request(foreign), stream));
          } finally {
            spy.mockRestore();
          }
          expect(models).toEqual(["gpt-4o"]);
          if (foreign.trim()) {
            expect(spy.codes).toEqual([LogCode.REQUEST_MODEL_IGNORED]);
          }
        }
      });
    }

    it("warns once per process, however many requests are ignored", async () => {
      const llm = openAI();
      recordOpenAIModels(llm);
      const spy = captureWarnings();
      try {
        await drain(llm.generateContentAsync(request("grok-4")));
        await drain(llm.generateContentAsync(request("grok-4")));
      } finally {
        spy.mockRestore();
      }
      expect(
        spy.codes.filter((c) => c === LogCode.REQUEST_MODEL_IGNORED),
      ).toHaveLength(1);
    });

    it("uses the effective model for the token-limit parameter", async () => {
      // A custom endpoint picks the parameter by model id: llama3 takes
      // max_tokens, an o-series reasoning id takes max_completion_tokens.
      const llm = new CustomLlm({
        model: "llama3",
        baseURL: "http://127.0.0.1:1/v1",
      });
      const bodies: Record<string, unknown>[] = [];
      // biome-ignore lint/suspicious/noExplicitAny: test access to private client
      (llm as any).client.chat.completions.create = async (
        params: Record<string, unknown>,
      ) => {
        bodies.push(params);
        return COMPLETION;
      };
      await drain(
        llm.generateContentAsync({
          ...request("o4-mini"),
          config: { maxOutputTokens: 50 },
        } as LlmRequest),
      );
      await drain(
        llm.generateContentAsync({
          ...request(),
          config: { maxOutputTokens: 50 },
        } as LlmRequest),
      );
      expect(bodies[0]?.model).toBe("o4-mini");
      expect(bodies[0]?.max_completion_tokens).toBe(50);
      expect(bodies[0]?.max_tokens).toBeUndefined();
      expect(bodies[1]?.model).toBe("llama3");
      expect(bodies[1]?.max_tokens).toBe(50);
      expect(bodies[1]?.max_completion_tokens).toBeUndefined();
    });

    it("a gateway accepts vendor/model ids and refuses bare ones", async () => {
      const llm = new OpenAICompatibleLlm(OPENROUTER_DEFINITION, {
        model: "openai/gpt-4o",
        apiKey: "k",
      });
      const models = recordOpenAIModels(llm);
      await drain(llm.generateContentAsync(request("anthropic/claude-x")));
      await drain(llm.generateContentAsync(request("gpt-4o")));
      expect(models).toEqual(["anthropic/claude-x", "openai/gpt-4o"]);
    });

    it("a custom provider accepts any non-blank model", async () => {
      const llm = new CustomLlm({
        model: "llama3",
        baseURL: "http://127.0.0.1:1/v1",
      });
      const models = recordOpenAIModels(llm);
      await drain(llm.generateContentAsync(request("qwen2.5:7b")));
      await drain(llm.generateContentAsync(request("")));
      expect(models).toEqual(["qwen2.5:7b", "llama3"]);
    });
  });

  describe("Anthropic", () => {
    for (const stream of [false, true]) {
      const mode = stream ? "streaming" : "non-streaming";

      it(`sends a rewritten claude-* model (${mode})`, async () => {
        const llm = anthropic();
        const models = recordAnthropicModels(llm);
        await drain(
          llm.generateContentAsync(request("claude-opus-4-1"), stream),
        );
        expect(models).toEqual(["claude-opus-4-1"]);
      });

      it(`never sends a prefixed or foreign model id (${mode})`, async () => {
        const llm = anthropic();
        const models = recordAnthropicModels(llm);
        const spy = captureWarnings();
        try {
          await drain(
            llm.generateContentAsync(request("anthropic/claude-x"), stream),
          );
          await drain(llm.generateContentAsync(request("gpt-4o"), stream));
        } finally {
          spy.mockRestore();
        }
        expect(models).toEqual(["claude-sonnet-4-5", "claude-sonnet-4-5"]);
        expect(spy.codes).toContain(LogCode.REQUEST_MODEL_IGNORED);
      });
    }
  });

  describe("through ADK 2.4 LlmAgent", () => {
    async function runAgent(
      llm: OpenAICompatibleLlm,
      beforeModelCallback?: (params: {
        context: CallbackContext;
        request: LlmRequest;
      }) => undefined,
    ): Promise<void> {
      const agent = new LlmAgent({
        name: "root",
        model: llm,
        instruction: "Be brief.",
        ...(beforeModelCallback ? { beforeModelCallback } : {}),
      });
      const runner = new InMemoryRunner({ agent, appName: "app" });
      const session = await runner.sessionService.createSession({
        appName: "app",
        userId: "u",
      });
      for await (const _ of runner.runAsync({
        userId: "u",
        sessionId: session.id,
        newMessage: { role: "user", parts: [{ text: "hi" }] },
      })) {
        // drain
      }
    }

    it("ADK puts the agent's own model id on the request", async () => {
      const llm = openAI();
      const models = recordOpenAIModels(llm);
      let seen: string | undefined;
      await runAgent(llm, ({ request }) => {
        seen = request.model;
        return undefined;
      });
      expect(seen).toBe("gpt-4o");
      expect(models).toEqual(["gpt-4o"]);
    });

    it("a beforeModelCallback rewrite reaches the provider", async () => {
      const llm = openAI();
      const models = recordOpenAIModels(llm);
      await runAgent(llm, ({ request }) => {
        request.model = "gpt-5-mini";
        return undefined;
      });
      expect(models).toEqual(["gpt-5-mini"]);
    });
  });
});
