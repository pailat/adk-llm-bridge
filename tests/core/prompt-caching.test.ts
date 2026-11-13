/**
 * Prompt caching request shape for the OpenAI-compatible providers: AI Gateway
 * (`providerOptions.gateway.caching = "auto"`), OpenRouter (opt-in top-level
 * `cache_control`) and the providers that never get a marker.
 */

import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  type LlmRequest,
  RoutedLlm,
} from "@google/adk";
import { type Span, trace } from "@opentelemetry/api";
import { resetAllConfigs, setProviderConfig } from "../../src/config.js";
import { OpenAICompatibleLlm } from "../../src/core/openai-compatible-llm.js";
import { AI_GATEWAY_DEFINITION } from "../../src/providers/ai-gateway/definition.js";
import { OPENAI_DEFINITION } from "../../src/providers/openai/definition.js";
import { OPENROUTER_DEFINITION } from "../../src/providers/openrouter/definition.js";
import { XAI_DEFINITION } from "../../src/providers/xai/definition.js";
import { LogCode, resetWarnOnce } from "../../src/utils/log.js";
import { captureWarnings } from "../helpers/fake-logger.js";

const COMPLETION = {
  id: "c1",
  object: "chat.completion",
  created: 0,
  model: "served",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "ok", refusal: null },
      finish_reason: "stop",
      logprobs: null,
    },
  ],
};

async function* oneChunkStream() {
  yield {
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model: "served",
    choices: [{ index: 0, delta: { content: "ok" } }],
  };
  yield {
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model: "served",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
}

type Body = Record<string, unknown> & { messages: unknown[]; model: string };

function bodies(llm: OpenAICompatibleLlm): Body[] {
  const seen: Body[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: test access to private client
  (llm as any).client.chat.completions.create = async (params: Body) => {
    seen.push(params);
    return params.stream ? oneChunkStream() : COMPLETION;
  };
  return seen;
}

function request(model?: string): LlmRequest {
  return {
    ...(model === undefined ? {} : { model }),
    contents: [{ role: "user", parts: [{ text: "Hi" }] }],
    liveConnectConfig: {},
    toolsDict: {},
  } as LlmRequest;
}

function toolRequest(model?: string): LlmRequest {
  return {
    ...request(model),
    config: {
      tools: [
        {
          functionDeclarations: [
            { name: "read_file", description: "read", parameters: undefined },
          ],
        },
      ],
    },
  } as unknown as LlmRequest;
}

function historyRequest(withText = true): LlmRequest {
  return {
    contents: [
      { role: "user", parts: [{ text: "Hi" }] },
      {
        role: "model",
        parts: withText
          ? [{ text: "Hello" }]
          : [{ functionCall: { name: "read_file", args: {}, id: "c1" } }],
      },
      { role: "user", parts: [{ text: "More" }] },
    ],
    liveConnectConfig: {},
    toolsDict: {},
  } as unknown as LlmRequest;
}

async function run(llm: OpenAICompatibleLlm, stream: boolean, req = request()) {
  for await (const _ of llm.generateContentAsync(req, stream)) {
    // drain
  }
}

type CachingConfig = { promptCaching?: unknown; provider?: unknown };

function gateway(model: string, extra: CachingConfig = {}) {
  return new OpenAICompatibleLlm(AI_GATEWAY_DEFINITION, {
    model,
    apiKey: "k",
    ...extra,
  });
}

function openrouter(model: string, extra: CachingConfig = {}) {
  return new OpenAICompatibleLlm(OPENROUTER_DEFINITION, {
    model,
    apiKey: "k",
    ...extra,
  });
}

beforeEach(() => {
  resetAllConfigs();
  resetWarnOnce();
});

describe("AI Gateway prompt caching", () => {
  for (const stream of [false, true]) {
    const mode = stream ? "streaming" : "non-streaming";

    it(`sends no providerOptions for a one-shot anthropic/* request with promptCaching unset (${mode})`, async () => {
      const llm = gateway("anthropic/claude-haiku-5.5");
      const seen = bodies(llm);
      await run(llm, stream);
      expect("providerOptions" in seen[0]).toBe(false);
    });

    it(`caches anthropic/* by default when a tool is declared (${mode})`, async () => {
      const llm = gateway("anthropic/claude-haiku-5.5");
      const seen = bodies(llm);
      await run(llm, stream, toolRequest());
      expect(seen[0].providerOptions).toEqual({ gateway: { caching: "auto" } });
    });

    it(`caches anthropic/* by default when an earlier model turn exists (${mode})`, async () => {
      const llm = gateway("anthropic/claude-haiku-5.5");
      const seen = bodies(llm);
      await run(llm, stream, historyRequest());
      expect(seen[0].providerOptions).toEqual({ gateway: { caching: "auto" } });
    });

    it(`caches by default when the earlier model turn only carries tool calls (${mode})`, async () => {
      const llm = gateway("anthropic/claude-haiku-5.5");
      const seen = bodies(llm);
      await run(llm, stream, historyRequest(false));
      expect(seen[0].providerOptions).toEqual({ gateway: { caching: "auto" } });
    });

    it(`promptCaching: true forces it on for a one-shot request (${mode})`, async () => {
      const llm = gateway("anthropic/claude-haiku-5.5", {
        promptCaching: true,
      });
      const seen = bodies(llm);
      await run(llm, stream);
      expect(seen[0].providerOptions).toEqual({ gateway: { caching: "auto" } });
    });

    it(`promptCaching: false sends nothing even with tools (${mode})`, async () => {
      const llm = gateway("anthropic/claude-haiku-5.5", {
        promptCaching: false,
      });
      const seen = bodies(llm);
      await run(llm, stream, toolRequest());
      expect("providerOptions" in seen[0]).toBe(false);
    });

    it(`keeps the model gate with tools for a non-anthropic model (${mode})`, async () => {
      const llm = gateway("openai/gpt-5");
      const seen = bodies(llm);
      await run(llm, stream, toolRequest());
      expect("providerOptions" in seen[0]).toBe(false);
    });

    it(`sends no providerOptions for a non-anthropic model by default (${mode})`, async () => {
      const llm = gateway("openai/gpt-5");
      const seen = bodies(llm);
      await run(llm, stream);
      expect("providerOptions" in seen[0]).toBe(false);
    });

    it(`promptCaching: false sends nothing (${mode})`, async () => {
      const llm = gateway("anthropic/claude-haiku-5.5", {
        promptCaching: false,
      });
      const seen = bodies(llm);
      await run(llm, stream);
      expect("providerOptions" in seen[0]).toBe(false);
    });

    it(`promptCaching: true turns it on for other models (${mode})`, async () => {
      const llm = gateway("openai/gpt-5", { promptCaching: true });
      const seen = bodies(llm);
      await run(llm, stream);
      expect(seen[0].providerOptions).toEqual({ gateway: { caching: "auto" } });
    });
  }

  it("decides per call on one instance", async () => {
    const llm = gateway("anthropic/claude-haiku-5.5");
    const seen = bodies(llm);
    await run(llm, false);
    await run(llm, false, toolRequest());
    expect("providerOptions" in seen[0]).toBe(false);
    expect(seen[1].providerOptions).toEqual({ gateway: { caching: "auto" } });
  });

  it("applies the automatic rule to a per-request model override", async () => {
    const llm = gateway("openai/gpt-5");
    const seen = bodies(llm);
    await run(llm, false, request("anthropic/claude-sonnet-5.5"));
    await run(llm, false, toolRequest("anthropic/claude-sonnet-5.5"));
    expect("providerOptions" in seen[0]).toBe(false);
    expect(seen[1].providerOptions).toEqual({ gateway: { caching: "auto" } });
  });

  it("never hand-places cache_control in the body", async () => {
    const llm = gateway("anthropic/claude-haiku-5.5");
    const seen = bodies(llm);
    await run(llm, false, toolRequest());
    expect(JSON.stringify(seen[0])).not.toContain("cache_control");
  });

  it("ttl: '1h' still sends auto and warns once", async () => {
    const warnings = captureWarnings();
    try {
      const llm = gateway("anthropic/claude-haiku-5.5", {
        promptCaching: { ttl: "1h" },
      });
      const seen = bodies(llm);
      await run(llm, false);
      await run(llm, false);
      expect(seen[0].providerOptions).toEqual({ gateway: { caching: "auto" } });
      expect(
        warnings.codes.filter((c) => c === LogCode.PROMPT_CACHE_TTL_IGNORED),
      ).toHaveLength(1);
    } finally {
      warnings.mockRestore();
    }
  });

  it("resolves instance over global over default", async () => {
    setProviderConfig("ai-gateway", { promptCaching: false });
    const fromGlobal = gateway("anthropic/claude-haiku-5.5");
    const globalSeen = bodies(fromGlobal);
    await run(fromGlobal, false);
    expect("providerOptions" in globalSeen[0]).toBe(false);

    const instance = gateway("anthropic/claude-haiku-5.5", {
      promptCaching: true,
    });
    const instanceSeen = bodies(instance);
    await run(instance, false);
    expect(instanceSeen[0].providerOptions).toEqual({
      gateway: { caching: "auto" },
    });
  });

  it("judges the model of each call: llmRequest.model override", async () => {
    const llm = gateway("openai/gpt-5");
    const seen = bodies(llm);
    await run(llm, false, toolRequest("anthropic/claude-sonnet-5.5"));
    await run(llm, false, toolRequest("openai/gpt-5"));
    expect(seen[0].providerOptions).toEqual({ gateway: { caching: "auto" } });
    expect("providerOptions" in seen[1]).toBe(false);
  });

  it("is gated per routed model under RoutedLlm", async () => {
    const claude = gateway("anthropic/claude-haiku-5.5");
    const gpt = gateway("openai/gpt-5");
    const claudeSeen = bodies(claude);
    const gptSeen = bodies(gpt);
    let call = 0;
    const routed = new RoutedLlm({
      models: { claude, gpt },
      router: () => (call++ === 0 ? "claude" : "gpt"),
    });
    for (let i = 0; i < 2; i++) {
      for await (const _ of routed.generateContentAsync(toolRequest(), false)) {
        // drain
      }
    }
    expect(claudeSeen[0].providerOptions).toEqual({
      gateway: { caching: "auto" },
    });
    expect("providerOptions" in gptSeen[0]).toBe(false);
  });

  it("caches every call of a 3-turn tool loop, the first included", async () => {
    const llm = gateway("anthropic/claude-haiku-5.5");
    const seen: Body[] = [];
    const toolCall = (id: string) => ({
      ...COMPLETION,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            refusal: null,
            tool_calls: [
              {
                id,
                type: "function",
                function: { name: "read_file", arguments: "{}" },
              },
            ],
          },
          finish_reason: "tool_calls",
          logprobs: null,
        },
      ],
    });
    const replies = [toolCall("c1"), toolCall("c2"), COMPLETION];
    // biome-ignore lint/suspicious/noExplicitAny: test access to private client
    (llm as any).client.chat.completions.create = async (params: Body) => {
      seen.push(params);
      return replies[seen.length - 1];
    };
    const agent = new LlmAgent({
      name: "loop",
      model: llm,
      instruction: "Read the files.",
      tools: [
        new FunctionTool({
          name: "read_file",
          description: "Reads a file.",
          execute: () => ({ text: "contents" }),
        }),
      ],
    });
    const runner = new InMemoryRunner({ agent, appName: "app" });
    const session = await runner.sessionService.createSession({
      appName: "app",
      userId: "u",
    });
    for await (const _ of runner.runAsync({
      userId: "u",
      sessionId: session.id,
      newMessage: { role: "user", parts: [{ text: "go" }] },
    })) {
      // drain
    }
    expect(seen).toHaveLength(3);
    for (const body of seen) {
      expect(body.providerOptions).toEqual({ gateway: { caching: "auto" } });
    }
  });
});

describe("OpenRouter prompt caching (opt-in)", () => {
  it("is OFF by default, even for anthropic/* with tools", async () => {
    const llm = openrouter("anthropic/claude-sonnet-5.5");
    const seen = bodies(llm);
    await run(llm, false, toolRequest());
    expect("cache_control" in seen[0]).toBe(false);
  });

  for (const stream of [false, true]) {
    it(`true sends top-level cache_control for anthropic/* (${stream ? "stream" : "single"})`, async () => {
      const llm = openrouter("anthropic/claude-sonnet-5.5", {
        promptCaching: true,
      });
      const seen = bodies(llm);
      await run(llm, stream);
      expect(seen[0].cache_control).toEqual({ type: "ephemeral" });
    });
  }

  it("true sends cache_control even for a one-shot request", async () => {
    const llm = openrouter("anthropic/claude-sonnet-5.5", {
      promptCaching: true,
    });
    const seen = bodies(llm);
    await run(llm, false);
    expect(seen[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("{ttl:'1h'} adds ttl", async () => {
    const llm = openrouter("anthropic/claude-sonnet-5.5", {
      promptCaching: { ttl: "1h" },
    });
    const seen = bodies(llm);
    await run(llm, false);
    expect(seen[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("{ttl:'5m'} leaves the API default", async () => {
    const llm = openrouter("anthropic/claude-sonnet-5.5", {
      promptCaching: { ttl: "5m" },
    });
    const seen = bodies(llm);
    await run(llm, false);
    expect(seen[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("false sends none", async () => {
    const llm = openrouter("anthropic/claude-sonnet-5.5", {
      promptCaching: false,
    });
    const seen = bodies(llm);
    await run(llm, false);
    expect("cache_control" in seen[0]).toBe(false);
  });

  it("keeps the provider routing option and leaves messages identical", async () => {
    const off = openrouter("anthropic/claude-sonnet-5.5", {
      promptCaching: false,
      provider: { order: ["Anthropic"] },
    });
    const on = openrouter("anthropic/claude-sonnet-5.5", {
      promptCaching: true,
      provider: { order: ["Anthropic"] },
    });
    const offSeen = bodies(off);
    const onSeen = bodies(on);
    await run(off, false);
    await run(on, false);
    expect(onSeen[0].provider).toEqual({ order: ["Anthropic"] });
    expect(onSeen[0].messages).toEqual(offSeen[0].messages);
  });

  it("global promptCaching: true turns it on", async () => {
    setProviderConfig("openrouter", { promptCaching: true });
    const llm = openrouter("anthropic/claude-sonnet-5.5");
    const seen = bodies(llm);
    await run(llm, false);
    expect(seen[0].cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("providers without a caching marker", () => {
  for (const [name, definition, model] of [
    ["openai", OPENAI_DEFINITION, "gpt-5"],
    ["xai", XAI_DEFINITION, "grok-4"],
  ] as const) {
    it(`${name} never gains cache_control or providerOptions`, async () => {
      const llm = new OpenAICompatibleLlm(definition, {
        model,
        apiKey: "k",
        promptCaching: true,
      } as never);
      const seen = bodies(llm);
      await run(llm, false);
      expect("cache_control" in seen[0]).toBe(false);
      expect("providerOptions" in seen[0]).toBe(false);
    });
  }
});

describe("streamed cache usage", () => {
  it("merges the trailing usage chunk's cache write into customMetadata", async () => {
    const llm = openrouter("anthropic/claude-sonnet-5.5");
    // biome-ignore lint/suspicious/noExplicitAny: test access to private client
    (llm as any).client.chat.completions.create = async () =>
      (async function* () {
        yield* oneChunkStream();
        yield {
          id: "c1",
          object: "chat.completion.chunk",
          created: 0,
          model: "served",
          choices: [],
          usage: {
            prompt_tokens: 50,
            completion_tokens: 2,
            total_tokens: 52,
            prompt_tokens_details: {
              cached_tokens: 20,
              cache_write_tokens: 15,
            },
          },
        };
      })();
    const out = [];
    for await (const r of llm.generateContentAsync(request(), true))
      out.push(r);
    const final = out[out.length - 1];
    expect(final.usageMetadata?.cachedContentTokenCount).toBe(20);
    expect(final.customMetadata).toEqual({ cacheCreationTokenCount: 15 });
  });
});

describe("streamed cost", () => {
  it("puts the trailing usage chunk's cost on the final response", async () => {
    const llm = openrouter("anthropic/claude-sonnet-5.5");
    // biome-ignore lint/suspicious/noExplicitAny: test access to private client
    (llm as any).client.chat.completions.create = async () =>
      (async function* () {
        yield* oneChunkStream();
        yield {
          id: "c1",
          object: "chat.completion.chunk",
          created: 0,
          model: "served",
          choices: [],
          usage: {
            prompt_tokens: 50,
            completion_tokens: 2,
            total_tokens: 52,
            cost: 0.0042,
          },
        };
      })();
    const out = [];
    for await (const r of llm.generateContentAsync(request(), true))
      out.push(r);
    expect(out[out.length - 1].customMetadata).toEqual({
      costUsd: 0.0042,
      costSource: "cost",
    });
  });
});

describe("cache usage on the model-call span", () => {
  it("records cache read and write tokens on the active span", async () => {
    const attributes: Record<string, unknown> = {};
    const span = {
      setAttributes: (a: Record<string, unknown>) =>
        Object.assign(attributes, a),
    } as unknown as Span;
    const spy = spyOn(trace, "getActiveSpan").mockReturnValue(span);
    try {
      const llm = openrouter("anthropic/claude-sonnet-5.5");
      // biome-ignore lint/suspicious/noExplicitAny: test access to private client
      (llm as any).client.chat.completions.create = async () => ({
        ...COMPLETION,
        usage: {
          prompt_tokens: 50,
          completion_tokens: 2,
          total_tokens: 52,
          prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 15 },
        },
      });
      await run(llm, false);
    } finally {
      spy.mockRestore();
    }
    expect(attributes["gen_ai.usage.cache_read.input_tokens"]).toBe(20);
    expect(attributes["gen_ai.usage.cache_creation.input_tokens"]).toBe(15);
  });

  it("records the reported cost, 0 included, and only then", async () => {
    for (const [cost, expected] of [
      [0.0042, 0.0042],
      [0, 0],
      [undefined, undefined],
    ] as const) {
      const attributes: Record<string, unknown> = {};
      const span = {
        setAttributes: (a: Record<string, unknown>) =>
          Object.assign(attributes, a),
      } as unknown as Span;
      const spy = spyOn(trace, "getActiveSpan").mockReturnValue(span);
      try {
        const llm = openrouter("anthropic/claude-sonnet-5.5");
        // biome-ignore lint/suspicious/noExplicitAny: test access to private client
        (llm as any).client.chat.completions.create = async () => ({
          ...COMPLETION,
          usage: {
            prompt_tokens: 50,
            completion_tokens: 2,
            total_tokens: 52,
            ...(cost === undefined ? {} : { cost }),
          },
        });
        await run(llm, false);
      } finally {
        spy.mockRestore();
      }
      expect(attributes["adk_llm_bridge.usage.cost_usd"]).toBe(expected);
    }
  });
});
