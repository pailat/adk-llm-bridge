import { afterEach, describe, expect, it } from "bun:test";
import {
  BaseLlm,
  InMemoryRunner,
  InputValidationError,
  LlmAgent,
  type LlmRequest,
  type LlmResponse,
  LogLevel,
  RoutedLlm,
  setLogLevel,
} from "@google/adk";
import {
  resetAllConfigs,
  resetProviderConfig,
  setProviderConfig,
} from "../../src/config.js";
import { OpenAICompatibleLlm } from "../../src/core/openai-compatible-llm.js";
import {
  PROVIDER_ERROR_INCOMPLETE_STREAM,
  PROVIDER_ERROR_NO_CHOICE,
  ProviderLlmError,
} from "../../src/core/provider-llm-error.js";
import * as root from "../../src/index.js";
import { createCustomLlm } from "../../src/providers/custom/index.js";
import { OPENAI_DEFINITION } from "../../src/providers/openai/definition.js";

type Create = () => unknown;

function req(): LlmRequest {
  return {
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    liveConnectConfig: {},
    toolsDict: {},
  } as LlmRequest;
}

function llmWith(
  create: Create,
  config: { errorMode?: "throw" | "response" } = {},
): OpenAICompatibleLlm {
  const llm = new OpenAICompatibleLlm(OPENAI_DEFINITION, {
    model: "gpt-4o",
    apiKey: "k",
    ...config,
  });
  // biome-ignore lint/suspicious/noExplicitAny: test access to private client
  (llm as any).client.chat.completions.create = async () => create();
  return llm;
}

async function drain(gen: AsyncGenerator<LlmResponse, void>) {
  const out: LlmResponse[] = [];
  for await (const r of gen) out.push(r);
  return out;
}

const apiError = () =>
  Object.assign(new Error("rate limited"), { status: 429 });

afterEach(() => {
  resetAllConfigs();
});

describe("errorMode", () => {
  it("defaults to throwing a ProviderLlmError with a JSON message ADK can parse", async () => {
    const llm = llmWith(() => {
      throw apiError();
    });
    const error = await drain(llm.generateContentAsync(req())).catch(
      (e) => e as ProviderLlmError,
    );
    expect(error).toBeInstanceOf(ProviderLlmError);
    const e = error as ProviderLlmError;
    expect(e.code).toBe("API_ERROR_429");
    expect(e.status).toBe(429);
    expect(e.provider).toBe("openai");
    expect(e.detail).toBe("rate limited");
    expect(e.cause).toBeInstanceOf(Error);
    expect(JSON.parse(e.message)).toEqual({
      error: { code: "API_ERROR_429", message: "rate limited" },
    });
  });

  it("uses the <PREFIX>_ERROR code for errors without a status", async () => {
    const llm = llmWith(() => {
      throw new Error("socket hang up");
    });
    const e = (await drain(llm.generateContentAsync(req())).catch(
      (x) => x,
    )) as ProviderLlmError;
    expect(e.code).toBe("OPENAI_ERROR");
    expect(e.status).toBeUndefined();
  });

  it('keeps the previous response contract with errorMode "response"', async () => {
    const llm = llmWith(
      () => {
        throw apiError();
      },
      { errorMode: "response" },
    );
    expect(await drain(llm.generateContentAsync(req()))).toEqual([
      {
        errorCode: "API_ERROR_429",
        errorMessage: "rate limited",
        turnComplete: true,
      },
    ]);
  });

  it("applies to streaming failures too", async () => {
    const llm = llmWith(() => {
      throw apiError();
    });
    await expect(
      drain(llm.generateContentAsync(req(), true)),
    ).rejects.toBeInstanceOf(ProviderLlmError);
  });

  it("never reports caller aborts, in either mode", async () => {
    for (const errorMode of ["throw", "response"] as const) {
      const controller = new AbortController();
      const llm = llmWith(
        () => {
          controller.abort();
          throw new Error("aborted");
        },
        { errorMode },
      );
      expect(
        await drain(llm.generateContentAsync(req(), false, controller.signal)),
      ).toEqual([]);
    }
  });

  it("resolves instance > global (setProviderConfig) > default", async () => {
    setProviderConfig("openai", { errorMode: "response" });
    const fail = () => {
      throw apiError();
    };
    // global applies
    expect(await drain(llmWith(fail).generateContentAsync(req()))).toHaveLength(
      1,
    );
    // instance wins over global
    await expect(
      drain(llmWith(fail, { errorMode: "throw" }).generateContentAsync(req())),
    ).rejects.toBeInstanceOf(ProviderLlmError);
    // reset -> default throw
    resetProviderConfig("openai");
    await expect(
      drain(llmWith(fail).generateContentAsync(req())),
    ).rejects.toBeInstanceOf(ProviderLlmError);
  });

  it("is available on the custom provider (instance config)", async () => {
    const llm = createCustomLlm({
      name: "local",
      model: "m",
      baseURL: "http://127.0.0.1:1/v1",
      maxRetries: 0,
      timeout: 1000,
    });
    const e = (await drain(llm.generateContentAsync(req())).catch(
      (x) => x,
    )) as ProviderLlmError;
    expect(e).toBeInstanceOf(ProviderLlmError);
    expect(e.code).toBe("LOCAL_ERROR");

    const asResponse = createCustomLlm({
      name: "local",
      model: "m",
      baseURL: "http://127.0.0.1:1/v1",
      maxRetries: 0,
      timeout: 1000,
      errorMode: "response",
    });
    const out = await drain(asResponse.generateContentAsync(req()));
    expect(out[0]?.errorCode).toBe("LOCAL_ERROR");
  });

  it("reports the provider id, not the name-derived prefix, on error.provider", async () => {
    const llm = createCustomLlm({
      name: "openai",
      model: "m",
      baseURL: "http://127.0.0.1:1/v1",
      maxRetries: 0,
      timeout: 1000,
    });
    const e = (await drain(llm.generateContentAsync(req())).catch(
      (x) => x,
    )) as ProviderLlmError;
    expect(e.code).toBe("OPENAI_ERROR");
    expect(e.provider).toBe("custom");
  });
});

describe("manual constructor error identity", () => {
  const clientConfig = {
    baseURL: "http://127.0.0.1:1/v1",
    apiKey: "k",
    timeout: 1000,
    maxRetries: 0,
  };

  async function failure(llm: OpenAICompatibleLlm): Promise<ProviderLlmError> {
    // The client is protected; the test replaces its create call.
    const client = (
      llm as unknown as {
        client: { chat: { completions: { create: () => Promise<never> } } };
      }
    ).client;
    client.chat.completions.create = async () => {
      throw new Error("socket hang up");
    };
    return (await drain(llm.generateContentAsync(req())).catch(
      (e) => e,
    )) as ProviderLlmError;
  }

  it("defaults to provider custom and prefix CUSTOM", async () => {
    const e = await failure(
      new OpenAICompatibleLlm({ model: "m" }, clientConfig),
    );
    expect(e.code).toBe("CUSTOM_ERROR");
    expect(e.provider).toBe("custom");
  });

  it("uses the providerId and errorPrefix a subclass passes", async () => {
    class AcmeLlm extends OpenAICompatibleLlm {
      constructor() {
        super(
          { model: "m" },
          { ...clientConfig, providerId: "acme", errorPrefix: "ACME" },
        );
      }
    }
    const e = await failure(new AcmeLlm());
    expect(e.code).toBe("ACME_ERROR");
    expect(e.provider).toBe("acme");
  });

  it.each([
    ["", "errorPrefix"],
    ["my provider", "errorPrefix"],
    ["acme", "errorPrefix"],
    ["CAFÉ", "errorPrefix"],
    ["___", "errorPrefix"],
  ])("rejects the error prefix %p", (errorPrefix) => {
    const create = () =>
      new OpenAICompatibleLlm({ model: "m" }, { ...clientConfig, errorPrefix });
    expect(create).toThrow(InputValidationError);
    expect(create).toThrow("errorPrefix must be UPPER_SNAKE");
  });

  it.each(["", "  "])("rejects the blank provider id %p", (providerId) => {
    const create = () =>
      new OpenAICompatibleLlm({ model: "m" }, { ...clientConfig, providerId });
    expect(create).toThrow(InputValidationError);
    expect(create).toThrow("providerId must not be blank");
  });

  it("gives CustomLlm the sanitized name as prefix", async () => {
    const e = await failure(
      createCustomLlm({
        name: "my-provider",
        model: "m",
        baseURL: "http://127.0.0.1:1/v1",
      }),
    );
    expect(e.code).toBe("MY_PROVIDER_ERROR");
    expect(e.provider).toBe("custom");
  });

  it.each([
    ["9lives", "9LIVES_ERROR"],
    ["café", "CAF__ERROR"],
    ["---", "CUSTOM_ERROR"],
  ])("CustomLlm named %p reports %p", async (name, code) => {
    const e = await failure(
      createCustomLlm({ name, model: "m", baseURL: "http://127.0.0.1:1/v1" }),
    );
    expect(e.code).toBe(code);
  });
});

describe("a reply without choices", () => {
  const empty = () => ({
    id: "c1",
    model: "gpt-4o",
    object: "chat.completion",
    created: 0,
    choices: [],
  });

  it("throws a ProviderLlmError with code NO_CHOICE by default", async () => {
    const error = (await drain(
      llmWith(empty).generateContentAsync(req()),
    ).catch((e) => e)) as ProviderLlmError;
    expect(error).toBeInstanceOf(ProviderLlmError);
    expect(error.code).toBe(PROVIDER_ERROR_NO_CHOICE);
    expect(error.provider).toBe("openai");
    expect(JSON.parse(error.message)).toEqual({
      error: { code: "NO_CHOICE", message: "No response choice" },
    });
  });

  it('yields the NO_CHOICE response with errorMode "response"', async () => {
    const responses = await drain(
      llmWith(empty, { errorMode: "response" }).generateContentAsync(req()),
    );
    expect(responses).toEqual([
      {
        errorCode: "NO_CHOICE",
        errorMessage: "No response choice",
        turnComplete: true,
      },
    ]);
  });

  it("a 200 body with no choices field (an error object) is NO_CHOICE too", async () => {
    const errorBody = () => ({
      error: { message: "upstream overloaded", code: 502 },
    });
    const error = (await drain(
      llmWith(errorBody).generateContentAsync(req()),
    ).catch((e) => e)) as ProviderLlmError;
    expect(error).toBeInstanceOf(ProviderLlmError);
    expect(error.code).toBe(PROVIDER_ERROR_NO_CHOICE);

    const responses = await drain(
      llmWith(errorBody, { errorMode: "response" }).generateContentAsync(req()),
    );
    expect(responses[0]?.errorCode).toBe("NO_CHOICE");
  });
});

describe("a stream that ends without a finish chunk", () => {
  const chunk = (content: string, finish: string | null = null) => ({
    id: "s1",
    model: "gpt-4o",
    object: "chat.completion.chunk",
    created: 0,
    choices: [{ index: 0, delta: { content }, finish_reason: finish }],
  });
  const truncated = () =>
    (async function* () {
      yield chunk("Hel");
      yield chunk("lo");
    })();

  it("throws a ProviderLlmError with code INCOMPLETE_STREAM by default", async () => {
    const seen: LlmResponse[] = [];
    const error = await (async () => {
      for await (const r of llmWith(truncated).generateContentAsync(
        req(),
        true,
      )) {
        seen.push(r);
      }
    })().catch((e) => e as ProviderLlmError);
    expect(seen.every((r) => r.partial === true)).toBe(true);
    expect(seen).toHaveLength(2);
    expect(error).toBeInstanceOf(ProviderLlmError);
    expect((error as ProviderLlmError).code).toBe(
      PROVIDER_ERROR_INCOMPLETE_STREAM,
    );
    expect((error as ProviderLlmError).provider).toBe("openai");
  });

  it('yields the partials then a terminal INCOMPLETE_STREAM response with errorMode "response"', async () => {
    const responses = await drain(
      llmWith(truncated, { errorMode: "response" }).generateContentAsync(
        req(),
        true,
      ),
    );
    expect(responses.slice(0, -1).every((r) => r.partial === true)).toBe(true);
    expect(responses.at(-1)).toEqual({
      errorCode: "INCOMPLETE_STREAM",
      errorMessage: "Stream ended before the final chunk",
      turnComplete: true,
    });
  });

  it("is not reported after a caller abort", async () => {
    const controller = new AbortController();
    const llm = llmWith(() =>
      (async function* () {
        yield chunk("Hel");
        controller.abort();
        yield chunk("lo");
      })(),
    );
    const responses = await drain(
      llm.generateContentAsync(req(), true, controller.signal),
    );
    expect(responses).toHaveLength(1);
  });

  it("keeps the final response when the connection drops after the finish chunk", async () => {
    for (const errorMode of ["throw", "response"] as const) {
      const llm = llmWith(
        () =>
          (async function* () {
            yield chunk("Hel");
            yield chunk("lo", "stop");
            throw Object.assign(new Error("socket hang up"), {
              code: "ECONNRESET",
            });
          })(),
        { errorMode },
      );
      const responses = await drain(llm.generateContentAsync(req(), true));
      expect(responses.at(-1)?.turnComplete).toBe(true);
      expect(responses.at(-1)?.partial).not.toBe(true);
      expect(responses.some((r) => r.errorCode)).toBe(false);
    }
  });

  it("still reports a drop before the finish chunk as a provider error", async () => {
    const llm = llmWith(() =>
      (async function* () {
        yield chunk("Hel");
        throw new Error("socket hang up");
      })(),
    );
    const error = await drain(llm.generateContentAsync(req(), true)).catch(
      (e) => e as ProviderLlmError,
    );
    expect((error as ProviderLlmError).code).toBe("OPENAI_ERROR");
  });

  it("is not reported when the finish chunk arrives", async () => {
    const llm = llmWith(() =>
      (async function* () {
        yield chunk("Hel");
        yield chunk("lo", "stop");
      })(),
    );
    const responses = await drain(llm.generateContentAsync(req(), true));
    expect(responses.at(-1)?.turnComplete).toBe(true);
    expect(responses.some((r) => r.errorCode)).toBe(false);
  });
});

describe("provider error codes", () => {
  it("are exported from the package root", () => {
    expect(root.PROVIDER_ERROR_NO_CHOICE).toBe("NO_CHOICE");
    expect(root.PROVIDER_ERROR_MALFORMED_FUNCTION_CALL).toBe(
      "MALFORMED_FUNCTION_CALL",
    );
    expect(root.PROVIDER_ERROR_INCOMPLETE_STREAM).toBe("INCOMPLETE_STREAM");
    const codes: root.ProviderErrorCode[] = [
      "API_ERROR_429",
      "OPENAI_ERROR",
      root.PROVIDER_ERROR_NO_CHOICE,
      root.PROVIDER_ERROR_INCOMPLETE_STREAM,
    ];
    expect(codes).toHaveLength(4);
  });
});

describe("errorMode with ADK", () => {
  class Good extends BaseLlm {
    async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
      yield {
        content: { role: "model", parts: [{ text: "from fallback" }] },
        turnComplete: true,
      };
    }
    async connect(): Promise<never> {
      throw new Error("n/a");
    }
  }

  it("lets RoutedLlm fail over to the next model", async () => {
    setLogLevel(LogLevel.ERROR);
    const bad = llmWith(() => {
      throw apiError();
    });
    const good = new Good({ model: "good" });
    const seen: unknown[] = [];
    const routed = new RoutedLlm({
      models: { bad, good },
      router: (_models, _request, errorContext) => {
        seen.push(errorContext?.lastError);
        if (!errorContext) return "bad";
        return errorContext.failedKeys.has("good") ? undefined : "good";
      },
    });
    const out = await drain(routed.generateContentAsync(req(), false));
    expect(out).toHaveLength(1);
    expect(out[0]?.content?.parts?.[0]?.text).toBe("from fallback");
    expect(seen[1]).toBeInstanceOf(ProviderLlmError);
  });

  it("does not fail over with errorMode response (documented difference)", async () => {
    setLogLevel(LogLevel.ERROR);
    const bad = llmWith(
      () => {
        throw apiError();
      },
      { errorMode: "response" },
    );
    const routed = new RoutedLlm({
      models: { bad, good: new Good({ model: "good" }) },
      router: (_m, _r, errorContext) => (errorContext ? "good" : "bad"),
    });
    const out = await drain(routed.generateContentAsync(req(), false));
    expect(out[0]?.errorCode).toBe("API_ERROR_429");
  });

  it("keeps the event errorCode inside an LlmAgent run", async () => {
    setLogLevel(LogLevel.ERROR);
    const llm = llmWith(() => {
      throw apiError();
    });
    const agent = new LlmAgent({ name: "root", model: llm });
    const runner = new InMemoryRunner({ agent, appName: "app" });
    const session = await runner.sessionService.createSession({
      appName: "app",
      userId: "u",
    });
    const events = [];
    for await (const event of runner.runAsync({
      userId: "u",
      sessionId: session.id,
      newMessage: { role: "user", parts: [{ text: "hi" }] },
    })) {
      events.push(event);
    }
    expect(events.at(-1)?.errorCode).toBe("API_ERROR_429");
    expect(events.at(-1)?.errorMessage).toBe("rate limited");
  });
});
