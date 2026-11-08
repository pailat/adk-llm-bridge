/**
 * Contract test: ADK 2.x plugins observing a real `OpenAICompatibleLlm` through
 * a real `InMemoryRunner` (no network; the OpenAI SDK call is replaced).
 *
 * Fixes today's behavior: provider failures are returned as an `LlmResponse`
 * with `errorCode`, so `afterModelCallback` fires with that response and
 * `onModelErrorCallback` does NOT fire (it only runs when the model throws).
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
  setLogLevel,
} from "@google/adk";
import { OpenAICompatibleLlm } from "../../src/core/openai-compatible-llm.js";
import { OPENAI_DEFINITION } from "../../src/providers/openai/definition.js";

type Create = (params: Record<string, unknown>) => unknown;

function makeLlm(create: Create): OpenAICompatibleLlm {
  const llm = new OpenAICompatibleLlm(OPENAI_DEFINITION, {
    model: "gpt-4o",
    apiKey: "test-key",
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

  it("surfaces provider failures via afterModelCallback, not onModelErrorCallback", async () => {
    const spy = new SpyPlugin();
    const llm = makeLlm(() => {
      throw Object.assign(new Error("rate limited"), { status: 429 });
    });

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
});
