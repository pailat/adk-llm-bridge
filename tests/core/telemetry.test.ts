import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  annotateLlmSpan,
  genAiProviderName,
  recordLlmError,
  serverAddress,
  shouldCaptureMessageContent,
} from "../../src/core/telemetry.js";
import { useCleanEnv } from "../helpers/env.js";

const CAPTURE_ENV = [
  "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT",
  "ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS",
] as const;

function fakeSpan() {
  const record = {
    attributes: {} as Record<string, unknown>,
    exceptions: [] as unknown[],
    status: undefined as { code: SpanStatusCode; message?: string } | undefined,
  };
  const span = {
    setAttributes(attrs: Record<string, unknown>) {
      Object.assign(record.attributes, attrs);
      return this;
    },
    setAttribute(key: string, value: unknown) {
      record.attributes[key] = value;
      return this;
    },
    recordException(e: unknown) {
      record.exceptions.push(e);
    },
    setStatus(status: { code: SpanStatusCode; message?: string }) {
      record.status = status;
      return this;
    },
  } as unknown as Span;
  return { span, record };
}

afterEach(() => {
  // restore any spy installed on the global trace API
  (
    trace.getActiveSpan as unknown as { mockRestore?: () => void }
  ).mockRestore?.();
});

describe("serverAddress", () => {
  it("returns host and port only, never credentials or path", () => {
    expect(
      serverAddress("https://user:secret@api.example.com:8443/v1?key=abc"),
    ).toEqual({ address: "api.example.com", port: 8443 });
  });

  it("omits the port when the URL uses the default one", () => {
    expect(serverAddress("https://api.openai.com/v1")).toEqual({
      address: "api.openai.com",
      port: undefined,
    });
  });

  it("returns {} for missing or invalid URLs", () => {
    expect(serverAddress(undefined)).toEqual({});
    expect(serverAddress("not a url")).toEqual({});
  });
});

describe("annotateLlmSpan", () => {
  it("sets GenAI provider/response/server attributes without credentials", () => {
    const { span, record } = fakeSpan();
    annotateLlmSpan(
      {
        provider: "openai",
        model: "gpt-4o-2024",
        responseId: "chatcmpl-1",
        baseURL: "https://u:p@api.openai.com:444/v1",
      },
      span,
    );
    expect(record.attributes).toEqual({
      "gen_ai.provider.name": "openai",
      "gen_ai.response.model": "gpt-4o-2024",
      "gen_ai.response.id": "chatcmpl-1",
      "server.address": "api.openai.com",
      "server.port": 444,
    });
    expect(JSON.stringify(record.attributes)).not.toContain("p@");
  });

  it("skips undefined values", () => {
    const { span, record } = fakeSpan();
    annotateLlmSpan({ provider: "openai" }, span);
    expect(record.attributes).toEqual({ "gen_ai.provider.name": "openai" });
  });

  it("uses the OTel GenAI semconv provider name where one exists", () => {
    const cases: [string, string][] = [
      ["openai", "openai"],
      ["anthropic", "anthropic"],
      ["xai", "x_ai"],
      // No semconv value: the bridge id is kept (semconv allows custom values).
      ["openrouter", "openrouter"],
      ["ai-gateway", "ai-gateway"],
      ["custom", "custom"],
      ["my-local-llm", "my-local-llm"],
    ];
    for (const [provider, expected] of cases) {
      const { span, record } = fakeSpan();
      annotateLlmSpan({ provider }, span);
      expect(record.attributes["gen_ai.provider.name"]).toBe(expected);
      expect(genAiProviderName(provider)).toBe(expected);
    }
  });

  it("does not map inherited object keys", () => {
    expect(genAiProviderName("constructor")).toBe("constructor");
    expect(genAiProviderName("__proto__")).toBe("__proto__");
  });

  it("uses the active span by default and is a no-op without one", () => {
    expect(() => annotateLlmSpan({ provider: "openai" })).not.toThrow();
    const { span, record } = fakeSpan();
    spyOn(trace, "getActiveSpan").mockReturnValue(span);
    annotateLlmSpan({ provider: "openai" });
    expect(record.attributes["gen_ai.provider.name"]).toBe("openai");
  });
});

describe("recordLlmError", () => {
  it("records the exception, HTTP status as error.type and ERROR status", () => {
    const { span, record } = fakeSpan();
    const error = Object.assign(new Error("secret detail"), { status: 429 });
    recordLlmError(error, span);
    expect(record.exceptions).toEqual([error]);
    expect(record.attributes["error.type"]).toBe("429");
    expect(record.status).toEqual({ code: SpanStatusCode.ERROR });
  });

  it("falls back to the error class name, then _OTHER", () => {
    const a = fakeSpan();
    recordLlmError(new TypeError("x"), a.span);
    expect(a.record.attributes["error.type"]).toBe("TypeError");

    const b = fakeSpan();
    recordLlmError("boom", b.span);
    expect(b.record.attributes["error.type"]).toBe("_OTHER");
    expect(b.record.exceptions).toEqual(["boom"]);
  });

  it("is a no-op without an active span", () => {
    expect(() => recordLlmError(new Error("x"))).not.toThrow();
  });
});

describe("message-content capture gating", () => {
  useCleanEnv(CAPTURE_ENV);

  const secret = "user asked: summarize my diagnosis for Jane Roe";

  it("matches the agents telemetry precedence rules", () => {
    expect(shouldCaptureMessageContent()).toBe(true);
    process.env.ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS = "false";
    expect(shouldCaptureMessageContent()).toBe(false);
    process.env.ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS = "1";
    expect(shouldCaptureMessageContent()).toBe(true);
    // The OTel variable wins when set.
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT =
      "NO_CONTENT";
    expect(shouldCaptureMessageContent()).toBe(false);
    for (const mode of ["SPAN_ONLY", "span_and_event", " SPAN_ONLY "]) {
      process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = mode;
      expect(shouldCaptureMessageContent()).toBe(true);
    }
    // As on ADK main, the old boolean form means EVENT_ONLY: content goes to
    // log records, never to spans.
    for (const mode of ["true", "TRUE", " 1 ", "false", "0", "yes"]) {
      process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = mode;
      expect(shouldCaptureMessageContent()).toBe(false);
    }
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT =
      "EVENT_ONLY";
    expect(shouldCaptureMessageContent()).toBe(false);
  });

  it("records only the error class, never the message, when capture is off", () => {
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT =
      "NO_CONTENT";
    const { span, record } = fakeSpan();
    const error = Object.assign(new Error(secret), { status: 400 });
    recordLlmError(error, span);
    expect(JSON.stringify(record)).not.toContain("Jane Roe");
    expect(record.exceptions).toEqual([{ name: "400" }]);
    expect(record.attributes["error.type"]).toBe("400");
    expect(record.status).toEqual({ code: SpanStatusCode.ERROR });
  });

  it("does the same for non-Error values", () => {
    process.env.ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS = "false";
    const { span, record } = fakeSpan();
    recordLlmError(secret, span);
    expect(JSON.stringify(record)).not.toContain("Jane Roe");
    expect(record.exceptions).toEqual([{ name: "_OTHER" }]);
  });

  it("keeps the message when capture is on", () => {
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT =
      "SPAN_ONLY";
    const { span, record } = fakeSpan();
    const error = new Error("rate limited");
    recordLlmError(error, span);
    expect(record.exceptions).toEqual([error]);
  });

  it("annotateLlmSpan never writes anything but identity attributes", () => {
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT =
      "NO_CONTENT";
    const { span, record } = fakeSpan();
    annotateLlmSpan(
      {
        provider: "openai",
        model: "gpt-4o",
        responseId: "cmpl-1",
        baseURL: "https://api.openai.com/v1",
      },
      span,
    );
    expect(Object.keys(record.attributes).sort()).toEqual([
      "gen_ai.provider.name",
      "gen_ai.response.id",
      "gen_ai.response.model",
      "server.address",
    ]);
  });
});
