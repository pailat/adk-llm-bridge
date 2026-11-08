/**
 * Pins the ADK 2.4 `LLMRegistry` behavior that adk-llm-bridge's registration
 * model depends on (see the warning on `registerCustomProvider`). If an ADK
 * upgrade changes any of these, provider routing changes with it.
 *
 * All patterns use a unique, slash-free `zz-contract-` namespace: other test
 * files in the same process register the broad `.+/.+` AI Gateway/OpenRouter
 * patterns, which would (correctly, first wins) capture any name with a slash.
 */

import { describe, expect, it } from "bun:test";
import {
  ApigeeLlm,
  BaseLlm,
  ChromeBuiltInLlm,
  Gemini,
  LLMRegistry,
} from "@google/adk";

function makeClass(patterns: (string | RegExp)[]) {
  return class TestLlm extends BaseLlm {
    static readonly supportedModels = patterns;
    // biome-ignore lint/correctness/useYield: never invoked
    async *generateContentAsync(): AsyncGenerator<never, void> {
      throw new Error("not used");
    }
    async connect(): Promise<never> {
      throw new Error("not used");
    }
  };
}

describe("ADK LLMRegistry contract", () => {
  it("requires the pattern to match the whole model name", () => {
    const Cls = makeClass([/zz-contract-full-.+/]);
    LLMRegistry.register(Cls);
    expect(LLMRegistry.resolve("zz-contract-full-a")).toBe(Cls);
    expect(() => LLMRegistry.resolve("x-zz-contract-full-a")).toThrow(
      "not found",
    );
    expect(() => LLMRegistry.resolve("zz-contract-full-a\n")).toThrow(
      "not found",
    );
  });

  it("anchors a top-level alternation as a whole (^(?:a|b)$)", () => {
    const Cls = makeClass([/zz-contract-alt-a|zz-contract-alt-b/]);
    LLMRegistry.register(Cls);
    expect(LLMRegistry.resolve("zz-contract-alt-a")).toBe(Cls);
    expect(LLMRegistry.resolve("zz-contract-alt-b")).toBe(Cls);
    expect(() => LLMRegistry.resolve("zz-contract-alt-bX")).toThrow(
      "not found",
    );
    expect(() => LLMRegistry.resolve("Xzz-contract-alt-a")).toThrow(
      "not found",
    );
  });

  it("lets the first registered matching pattern win", () => {
    const First = makeClass([/zz-contract-order-.+/]);
    const Second = makeClass([/zz-contract-order-.+/, /.+-zz-contract-x/]);
    LLMRegistry.register(First);
    LLMRegistry.register(Second);
    // Distinct RegExp objects are distinct keys, so both stay registered, and
    // the earlier one keeps winning for the overlap.
    expect(LLMRegistry.resolve("zz-contract-order-m")).toBe(First);
    expect(LLMRegistry.resolve("q-zz-contract-x")).toBe(Second);
  });

  it("keeps serving a cached resolution after the registry entry is replaced", () => {
    // Registering the SAME key (same RegExp object) replaces the class in the
    // Map, independent of insertion order. Only the resolve cache can keep the
    // old class alive for a model that already resolved.
    const key = /zz-contract-cache-.+/;
    const Old = makeClass([key]);
    const Replacement = makeClass([key]);
    LLMRegistry.register(Old);
    expect(LLMRegistry.resolve("zz-contract-cache-first")).toBe(Old);

    LLMRegistry.register(Replacement);

    // A model name that was never resolved sees the replacement...
    expect(LLMRegistry.resolve("zz-contract-cache-fresh")).toBe(Replacement);
    // ...while the already-resolved name is still served from the cache.
    expect(LLMRegistry.resolve("zz-contract-cache-first")).toBe(Old);
  });

  it("replaces a class in place only for the same key, not for an equal RegExp", () => {
    const shared = /zz-contract-key-shared-.+/;
    const A = makeClass([shared]);
    const B = makeClass([shared]);
    LLMRegistry.register(A);
    LLMRegistry.register(B);
    expect(LLMRegistry.resolve("zz-contract-key-shared-1")).toBe(B);

    const C = makeClass([/zz-contract-key-equal-.+/]);
    const D = makeClass([/zz-contract-key-equal-.+/]);
    LLMRegistry.register(C);
    LLMRegistry.register(D);
    expect(LLMRegistry.resolve("zz-contract-key-equal-1")).toBe(C);
  });

  it("exposes no way to unregister a class", () => {
    expect("unregister" in LLMRegistry).toBe(false);
  });

  it("keeps ADK's own patterns ahead of ours for their namespaces", () => {
    expect(LLMRegistry.resolve("gemini-2.5-flash")).toBe(Gemini);
    expect(LLMRegistry.resolve("apigee/gemini/gemini-2.5-flash")).toBe(
      ApigeeLlm,
    );
    expect(LLMRegistry.resolve("chrome/on-device")).toBe(ChromeBuiltInLlm);
  });
});
