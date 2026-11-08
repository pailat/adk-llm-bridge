/**
 * Contract test: ADK 2.x plugins observing a real `OpenAICompatibleLlm` through
 * a real `InMemoryRunner` (no network; the OpenAI SDK call is replaced).
 *
 * Default `errorMode: "throw"`: provider failures reach `onModelErrorCallback`
 * and the event keeps the provider `errorCode`. With `errorMode: "response"` the
 * failure is an `LlmResponse` seen by `afterModelCallback` instead.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  BasePlugin,
  type CallbackContext,
  InMemoryRunner,
  LlmAgent,
  type LlmRequest,
  type LlmResponse,
  LoggingPlugin,
  LogLevel,
  ReflectAndRetryModelPlugin,
  setLogLevel,
} from "@google/adk";
import { OpenAICompatibleLlm } from "../../src/core/openai-compatible-llm.js";
import { ProviderLlmError } from "../../src/core/provider-llm-error.js";
import { OPENAI_DEFINITION } from "../../src/providers/openai/definition.js";

type Create = (params: Record<string, unknown>) => unknown;

function makeLlm(
  create: Create,
  extra: { errorMode?: "throw" | "response" } = {},
): OpenAICompatibleLlm {
  const llm = new OpenAICompatibleLlm(OPENAI_DEFINITION, {
    model: "gpt-4o",
    apiKey: "test-key",
    ...extra,
  });
  // biome-ignore lint/suspicious/noExplicitAny: test access to private client
  (llm as any).client.chat.completions.create = async (
    params: Record<string, unknown>,
  ) => create(params);
  return llm;
}

class SpyPlugin extends BasePlugin {
  readonly before: LlmRequest[] = [];
  readonly after: LlmResponse[] = [];
  readonly errors: Error[] = [];

  constructor() {
    super("spy");
  }

  override async beforeModelCallback(params: {
    callbackContext: CallbackContext;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    this.before.push(params.llmRequest);
    return undefined;
  }

  override async afterModelCallback(params: {
    callbackContext: CallbackContext;
    llmResponse: LlmResponse;
  }): Promise<LlmResponse | undefined> {
    this.after.push(params.llmResponse);
    return undefined;
  }

  override async onModelErrorCallback(params: {
    callbackContext: CallbackContext;
    llmRequest: LlmRequest;
    error: Error;
  }): Promise<LlmResponse | undefined> {
    this.errors.push(params.error);
    return undefined;
  }
}

async function run(llm: OpenAICompatibleLlm, spy: SpyPlugin) {
  const agent = new LlmAgent({
    name: "root",
    model: llm,
    instruction: "Be brief.",
  });
  const runner = new InMemoryRunner({
    agent,
    appName: "app",
    plugins: [new LoggingPlugin(), spy],
  });
  const session = await runner.sessionService.createSession({
    appName: "app",
    userId: "u",
  });
  const events = [];
  for await (const event of runner.runAsync({
    userId: "u",
    sessionId: session.id,
    newMessage: { role: "user", parts: [{ text: "hello" }] },
  })) {
    events.push(event);
  }
  return events;
}

describe("OpenAICompatibleLlm with ADK plugins", () => {
  // LoggingPlugin is chatty at INFO; keep the test output readable.
  beforeAll(() => setLogLevel(LogLevel.ERROR));
  afterAll(() => setLogLevel(LogLevel.INFO));

  it("runs before/afterModelCallback around a successful completion", async () => {
    const spy = new SpyPlugin();
    const llm = makeLlm(() => ({
      id: "cmpl-1",
      object: "chat.completion",
      created: 0,
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "hi there" },
        },
      ],
      usage: {
        prompt_tokens: 7,
        completion_tokens: 2,
        total_tokens: 9,
        prompt_tokens_details: { cached_tokens: 4 },
      },
    }));

    const events = await run(llm, spy);

    expect(spy.before).toHaveLength(1);
    expect(spy.before[0]?.contents.at(-1)?.parts?.[0]?.text).toBe("hello");
    expect(spy.after).toHaveLength(1);
    expect(spy.after[0]?.content?.parts?.[0]?.text).toBe("hi there");
    expect(spy.after[0]?.usageMetadata).toMatchObject({
      promptTokenCount: 7,
      cachedContentTokenCount: 4,
    });
    expect(spy.errors).toHaveLength(0);
    const final = events.at(-1);
    expect(final?.content?.parts?.[0]?.text).toBe("hi there");
    expect(final?.usageMetadata?.promptTokenCount).toBe(7);
  });

  it("reports provider failures to onModelErrorCallback in the default throw mode, keeping the event errorCode", async () => {
    const spy = new SpyPlugin();
    const llm = makeLlm(() => {
      throw Object.assign(new Error("rate limited"), { status: 429 });
    });

    const events = await run(llm, spy);

    expect(spy.errors).toHaveLength(1);
    expect(spy.errors[0]).toBeInstanceOf(ProviderLlmError);
    expect((spy.errors[0] as ProviderLlmError).code).toBe("API_ERROR_429");
    expect(spy.after).toHaveLength(0);
    // ADK parses the JSON message: the event keeps the provider errorCode.
    expect(events.at(-1)?.errorCode).toBe("API_ERROR_429");
    expect(events.at(-1)?.errorMessage).toBe("rate limited");
  });

  it('surfaces provider failures via afterModelCallback with errorMode "response"', async () => {
    const spy = new SpyPlugin();
    const llm = makeLlm(
      () => {
        throw Object.assign(new Error("rate limited"), { status: 429 });
      },
      { errorMode: "response" },
    );

    const events = await run(llm, spy);

    expect(spy.errors).toHaveLength(0);
    expect(spy.after).toHaveLength(1);
    expect(spy.after[0]?.errorCode).toBe("API_ERROR_429");
    expect(spy.after[0]?.errorMessage).toBe("rate limited");
    expect(events.at(-1)?.errorCode).toBe("API_ERROR_429");
  });

  it("lets beforeModelCallback short-circuit without calling the provider", async () => {
    let providerCalls = 0;
    const llm = makeLlm(() => {
      providerCalls++;
      throw new Error("must not be called");
    });
    class Cache extends SpyPlugin {
      override async beforeModelCallback(): Promise<LlmResponse | undefined> {
        return { content: { role: "model", parts: [{ text: "cached" }] } };
      }
    }
    const events = await run(llm, new Cache());
    expect(providerCalls).toBe(0);
    expect(events.at(-1)?.content?.parts?.[0]?.text).toBe("cached");
  });

  it("lets ReflectAndRetryModelPlugin retry a tool call truncated by max_tokens", async () => {
    const requests: Record<string, unknown>[] = [];
    const llm = makeLlm((params) => {
      requests.push(params);
      if (requests.length === 1) {
        return {
          id: "c1",
          object: "chat.completion",
          created: 0,
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              finish_reason: "length",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_a",
                    type: "function",
                    function: { name: "get_weather", arguments: '{"city":"Pa' },
                  },
                ],
              },
            },
          ],
        };
      }
      return {
        id: "c2",
        object: "chat.completion",
        created: 0,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "recovered" },
          },
        ],
      };
    });
    const agent = new LlmAgent({ name: "root", model: llm });
    const runner = new InMemoryRunner({
      agent,
      appName: "app",
      plugins: [new ReflectAndRetryModelPlugin({ maxRetries: 2 })],
    });
    const session = await runner.sessionService.createSession({
      appName: "app",
      userId: "u",
    });
    const events = [];
    for await (const event of runner.runAsync({
      userId: "u",
      sessionId: session.id,
      newMessage: { role: "user", parts: [{ text: "weather?" }] },
    })) {
      events.push(event);
    }

    expect(requests).toHaveLength(2);
    expect(events.at(-1)?.content?.parts?.[0]?.text).toBe("recovered");
    // The retry request replays the reflection tool call and its guidance.
    const second = JSON.stringify(requests[1]?.messages);
    expect(second).toContain("adk_handle_model_error");
    expect(second).toContain("reflection_guidance");
    // The broken call was never forwarded as a call (only named in the guidance).
    expect(second).not.toContain('\\"name\\":\\"get_weather\\"');
    expect(second).not.toContain('"name":"get_weather"');
  });

  it("surfaces a truncated tool call as a visible error event when no retry plugin is installed", async () => {
    const llm = makeLlm(() => ({
      id: "c1",
      object: "chat.completion",
      created: 0,
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          finish_reason: "length",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_a",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Pa' },
              },
            ],
          },
        },
      ],
    }));

    const events = await run(llm, new SpyPlugin());

    // Without an errorCode ADK would drop the response and emit nothing.
    expect(events).toHaveLength(1);
    expect(events[0]?.errorCode).toBe("MALFORMED_FUNCTION_CALL");
    expect(events[0]?.errorMessage).toContain("get_weather (invalid-json)");
    expect(events[0]?.content?.parts?.some((p) => p.functionCall)).toBeFalsy();
  });
});
