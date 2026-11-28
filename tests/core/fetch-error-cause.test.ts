import { describe, expect, it } from "bun:test";
import type { LlmRequest, LlmResponse } from "@google/adk";
import { classifyRecoverable } from "../../src/agents/runtime/error-classification.js";
import { OpenAICompatibleLlm } from "../../src/core/openai-compatible-llm.js";
import { ProviderLlmError } from "../../src/core/provider-llm-error.js";
import { AnthropicLlm } from "../../src/providers/anthropic/anthropic-llm.js";

const API_KEY = "sk-acme-SECRETKEY123";
const HEADER_SECRET = "acme-header-SECRET456";
const QUERY_SECRET = "acme-query-SECRET789";
const SECRETS = [API_KEY, HEADER_SECRET, QUERY_SECRET, "Bearer", "token="];

function req(): LlmRequest {
  return {
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    liveConnectConfig: {},
    toolsDict: {},
  } as LlmRequest;
}

async function drain(gen: AsyncGenerator<LlmResponse, void>) {
  const out: LlmResponse[] = [];
  for await (const r of gen) out.push(r);
  return out;
}

type FakeFetch = (url: string, init?: RequestInit) => Promise<Response>;

function setFetch(llm: object, fetch: FakeFetch) {
  // biome-ignore lint/suspicious/noExplicitAny: test access to private client
  (llm as any).client.fetch = fetch;
}

function openAiWith(
  fetch: FakeFetch,
  options: { maxRetries?: number; errorMode?: "throw" | "response" } = {},
) {
  const llm = new OpenAICompatibleLlm(
    { model: "acme-model", errorMode: options.errorMode },
    {
      baseURL: `https://api.acme.test/v1?token=${QUERY_SECRET}`,
      apiKey: API_KEY,
      timeout: 5000,
      maxRetries: options.maxRetries ?? 0,
      defaultHeaders: { "x-acme-secret": HEADER_SECRET },
      providerId: "acme",
      errorPrefix: "ACME",
    },
  );
  setFetch(llm, fetch);
  return llm;
}

function anthropicWith(fetch: FakeFetch) {
  const llm = new AnthropicLlm({
    model: "claude-sonnet-5-5",
    apiKey: API_KEY,
    baseURL: "https://anthropic.acme.test",
    maxRetries: 0,
  });
  setFetch(llm, fetch);
  return llm;
}

async function thrown(
  llm: { generateContentAsync(r: LlmRequest, s?: boolean): unknown },
  stream = false,
): Promise<ProviderLlmError> {
  try {
    await drain(
      llm.generateContentAsync(req(), stream) as AsyncGenerator<
        LlmResponse,
        void
      >,
    );
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderLlmError);
    return error as ProviderLlmError;
  }
  throw new Error("expected the call to throw");
}

/** The chain of `cause`s below `error`, outermost first. */
function causes(error: unknown): unknown[] {
  const out: unknown[] = [];
  let current = (error as { cause?: unknown }).cause;
  while (current !== undefined && out.length < 10) {
    out.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return out;
}

function expectNoSecret(error: ProviderLlmError) {
  const surfaces = [
    error.message,
    error.detail,
    JSON.stringify(error),
    String(error),
  ];
  for (const surface of surfaces) {
    for (const secret of SECRETS) expect(surface).not.toContain(secret);
    expect(surface).not.toContain("?");
  }
}

function refused(): FakeFetch {
  return async () => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
        code: "ECONNREFUSED",
        errno: -111,
        syscall: "connect",
        address: "127.0.0.1",
        port: 443,
      }),
    });
  };
}

function notFound(): FakeFetch {
  return async () => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.acme.test"), {
        code: "ENOTFOUND",
        errno: -3008,
        syscall: "getaddrinfo",
        hostname: "api.acme.test",
      }),
    });
  };
}

class AcmeFetchError extends Error {
  readonly code = "ACME_PROXY_DOWN";
  constructor() {
    super(
      `proxy refused https://api.acme.test/v1?token=${QUERY_SECRET} with Bearer ${API_KEY}`,
    );
    this.name = "AcmeFetchError";
  }
}

describe("an error thrown inside fetch", () => {
  it("keeps an ECONNREFUSED cause and names its code and host", async () => {
    const original = refused();
    let thrownByFetch: unknown;
    const error = await thrown(
      openAiWith(async (url, init) => {
        try {
          return await original(url, init);
        } catch (e) {
          thrownByFetch = e;
          throw e;
        }
      }),
    );

    expect(error.code).toBe("ACME_ERROR");
    expect(error.status).toBeUndefined();
    expect(causes(error)).toContain(thrownByFetch);
    expect(error.detail).toContain("ECONNREFUSED");
    expect(error.detail).toContain("TypeError");
    expect(error.detail).toContain("api.acme.test");
    expect(JSON.parse(error.message).error.message).toBe(error.detail);
    expectNoSecret(error);
  });

  it("keeps an ENOTFOUND cause on a streamed call", async () => {
    const error = await thrown(openAiWith(notFound()), true);

    expect(error.code).toBe("ACME_ERROR");
    expect(causes(error).length).toBeGreaterThanOrEqual(2);
    expect(error.detail).toContain("ENOTFOUND");
    expect(error.detail).toContain("api.acme.test");
    expectNoSecret(error);
  });

  it("keeps an AbortError cause", async () => {
    const abort = new DOMException("The operation was aborted.", "AbortError");
    const error = await thrown(
      openAiWith(async () => {
        throw abort;
      }),
    );

    expect(error.code).toBe("ACME_ERROR");
    expect(causes(error)).toContain(abort);
    expect(error.detail).toContain("AbortError");
    expect(error.detail).toContain("api.acme.test");
    expectNoSecret(error);
  });

  it("keeps a custom error and leaves its secret-bearing message out", async () => {
    const custom = new AcmeFetchError();
    const error = await thrown(
      openAiWith(async () => {
        throw custom;
      }),
    );

    expect(causes(error)).toContain(custom);
    expect(error.detail).toContain("AcmeFetchError");
    expect(error.detail).toContain("ACME_PROXY_DOWN");
    expect(error.detail).not.toContain("proxy refused");
    expectNoSecret(error);
  });

  it("puts the same summary in errorMessage in response mode", async () => {
    const out = await drain(
      openAiWith(refused(), { errorMode: "response" }).generateContentAsync(
        req(),
        false,
      ),
    );

    expect(out).toHaveLength(1);
    expect(out[0]?.errorCode).toBe("ACME_ERROR");
    expect(out[0]?.errorMessage).toContain("ECONNREFUSED");
    for (const secret of SECRETS) {
      expect(out[0]?.errorMessage).not.toContain(secret);
    }
  });

  it("keeps the cause on Anthropic", async () => {
    const error = await thrown(anthropicWith(refused()));

    expect(error.code).toBe("ANTHROPIC_ERROR");
    expect(error.status).toBeUndefined();
    expect(causes(error).length).toBeGreaterThanOrEqual(2);
    expect(error.detail).toContain("ECONNREFUSED");
    expect(error.detail).toContain("anthropic.acme.test");
    expectNoSecret(error);
  });
});

describe("retry classification of a fetch failure", () => {
  it("still retries a connection error maxRetries times", async () => {
    let calls = 0;
    const fetch = refused();
    const error = await thrown(
      openAiWith(
        async (url, init) => {
          calls++;
          return fetch(url, init);
        },
        { maxRetries: 1 },
      ),
    );

    expect(calls).toBe(2);
    expect(error.code).toBe("ACME_ERROR");
  });

  it("stays recoverable for the shared classifier", async () => {
    for (const fetch of [refused(), notFound()]) {
      const error = await thrown(openAiWith(fetch));
      expect(classifyRecoverable({ message: error.detail }).recoverable).toBe(
        true,
      );
    }
  });

  it("does not change an HTTP error", async () => {
    const error = await thrown(
      openAiWith(
        async () =>
          new Response(JSON.stringify({ error: { message: "slow down" } }), {
            status: 429,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    expect(error.code).toBe("API_ERROR_429");
    expect(error.status).toBe(429);
    expect(error.detail).not.toContain("cause:");
  });
});
