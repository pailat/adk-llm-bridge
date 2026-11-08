import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  annotateLlmSpan,
  recordLlmError,
  serverAddress,
} from "../../src/core/telemetry.js";

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
    annotateLlmSpan({ provider: "xai" }, span);
    expect(record.attributes).toEqual({ "gen_ai.provider.name": "xai" });
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
