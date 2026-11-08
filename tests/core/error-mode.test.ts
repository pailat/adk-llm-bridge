import { afterEach, describe, expect, it } from "bun:test";
import {
  BaseLlm,
  InMemoryRunner,
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
import { ProviderLlmError } from "../../src/core/provider-llm-error.js";
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
    expect(e.provider).toBe("OPENAI");
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
