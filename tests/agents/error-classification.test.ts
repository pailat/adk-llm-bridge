import { describe, expect, test } from "bun:test";
import type { RecoverableErrorCode } from "../../src/agents/index.js";
import * as agents from "../../src/agents/index.js";
import {
  classifyRecoverable,
  isKnownSubtype,
} from "../../src/agents/runtime/error-classification.js";

describe("classifyRecoverable", () => {
  test("is exported from the agents public surface", () => {
    expect(agents.classifyRecoverable).toBe(classifyRecoverable);
  });

  describe("known subtypes (table-driven)", () => {
    const cases: ReadonlyArray<[string, boolean, string]> = [
      // Claude SDKAssistantMessageError subtypes
      ["authentication_failed", false, "AUTH_ERROR"],
      ["oauth_org_not_allowed", false, "AUTH_ERROR"],
      ["billing_error", false, "BILLING_ERROR"],
      ["invalid_request", false, "INVALID_REQUEST"],
      ["max_output_tokens", false, "MAX_OUTPUT_TOKENS"],
      ["rate_limit", true, "RATE_LIMIT"],
      ["server_error", true, "SERVER_ERROR"],
      // Claude SDKResultError subtypes
      ["error_max_budget_usd", false, "MAX_BUDGET_EXCEEDED"],
      ["error_max_turns", false, "MAX_TURNS_EXCEEDED"],
      [
        "error_max_structured_output_retries",
        false,
        "MAX_STRUCTURED_OUTPUT_RETRIES",
      ],
      // Codex error codes
      ["quota_exhausted", false, "QUOTA_EXHAUSTED"],
      ["usage_limit_reached", false, "QUOTA_EXHAUSTED"],
      ["usage_limit_exceeded", false, "QUOTA_EXHAUSTED"],
      // the codes themselves
      ["AUTH_ERROR", false, "AUTH_ERROR"],
      ["MISSING_BINARY", false, "MISSING_BINARY"],
      ["TRANSPORT_ERROR", true, "TRANSPORT_ERROR"],
    ];

    for (const [subtype, recoverable, code] of cases) {
      test(`${subtype} -> recoverable=${recoverable}, code=${code}`, () => {
        expect(classifyRecoverable({ subtype })).toEqual({ recoverable, code });
      });
    }
  });

  describe("message heuristics", () => {
    const cases: ReadonlyArray<[string, boolean, string]> = [
      ["Rate limit exceeded, retry after 5s", true, "RATE_LIMIT"],
      ["HTTP 429 Too Many Requests", true, "RATE_LIMIT"],
      ["401 Unauthorized: invalid API key", false, "AUTH_ERROR"],
      ["authentication failed for provider", false, "AUTH_ERROR"],
      ["billing error: insufficient credit", false, "BILLING_ERROR"],
      ["Your quota is exhausted", false, "BILLING_ERROR"],
      ["Unable to locate Codex CLI binaries", false, "MISSING_BINARY"],
      ["spawn codex ENOENT", false, "MISSING_BINARY"],
      ["request timed out after 30s", true, "TRANSPORT_ERROR"],
      ["ECONNRESET while streaming", true, "TRANSPORT_ERROR"],
      ["503 Service Unavailable", true, "TRANSPORT_ERROR"],
    ];

    for (const [message, recoverable, code] of cases) {
      test(`"${message}" -> recoverable=${recoverable}, code=${code}`, () => {
        expect(classifyRecoverable({ message })).toEqual({ recoverable, code });
      });
    }
  });

  test("known subtype takes precedence over message heuristic", () => {
    // subtype says auth (non-recoverable) even though message looks transient
    expect(
      classifyRecoverable({
        subtype: "authentication_failed",
        message: "connection timed out",
      }),
    ).toEqual({ recoverable: false, code: "AUTH_ERROR" });
  });

  test("rate-limit message is not mis-bucketed as quota/billing", () => {
    expect(
      classifyRecoverable({ message: "rate limit quota reached" }),
    ).toEqual({
      recoverable: true,
      code: "RATE_LIMIT",
    });
  });

  describe("plan usage caps", () => {
    const quotaMessages = [
      "You've hit your usage limit. Upgrade to Pro or try again at 3:45 PM.",
      "You hit your usage limit",
      "You've hit your weekly limit",
      "Usage limit reached for this plan",
      "429: You've hit your usage limit",
    ];
    for (const message of quotaMessages) {
      test(`"${message}" -> non-recoverable QUOTA_EXHAUSTED`, () => {
        const expected = { recoverable: false, code: "QUOTA_EXHAUSTED" };
        expect(classifyRecoverable({ message })).toEqual(expected);
        expect(
          classifyRecoverable({ message, fallbackCode: "CODEX_TURN_FAILED" }),
        ).toEqual(expected);
      });
    }

    const rateLimitMessages = [
      "429 rate limit exceeded",
      "rate limit quota reached",
      "You've hit your rate limit, retry in 20s",
    ];
    for (const message of rateLimitMessages) {
      test(`"${message}" stays a recoverable RATE_LIMIT`, () => {
        expect(classifyRecoverable({ message })).toEqual({
          recoverable: true,
          code: "RATE_LIMIT",
        });
      });
    }

    test("an unknown turn failure keeps the fallback", () => {
      expect(
        classifyRecoverable({
          message: "turn failed for an unknown reason",
          fallbackCode: "CODEX_TURN_FAILED",
        }),
      ).toEqual({ recoverable: true, code: "CODEX_TURN_FAILED" });
    });
  });

  test("unknown input falls back to recoverable + UNKNOWN_ERROR by default", () => {
    expect(
      classifyRecoverable({ message: "something weird happened" }),
    ).toEqual({
      recoverable: true,
      code: "UNKNOWN_ERROR",
    });
    expect(classifyRecoverable({})).toEqual({
      recoverable: true,
      code: "UNKNOWN_ERROR",
    });
  });

  test("fallbackCode and defaultRecoverable overrides are honored", () => {
    expect(
      classifyRecoverable({
        message: "totally novel failure",
        fallbackCode: "CODEX_SDK_ERROR",
        defaultRecoverable: false,
      }),
    ).toEqual({ recoverable: false, code: "CODEX_SDK_ERROR" });
  });

  test("unknown subtype falls through to message heuristic", () => {
    expect(
      classifyRecoverable({
        subtype: "some_unmapped_subtype",
        message: "401 unauthorized",
      }),
    ).toEqual({ recoverable: false, code: "AUTH_ERROR" });
  });
});

describe("usage cap matching", () => {
  const capMessages = [
    "Codex usage limit exceeded",
    "usage_limit_reached",
    "You have reached your monthly limit",
    "Your usage limit resets at 5 PM",
  ];
  for (const message of capMessages) {
    test(`"${message}" is a plan usage cap`, () => {
      expect(classifyRecoverable({ message }).code).toBe("QUOTA_EXHAUSTED");
    });
  }

  const resourceMessages = [
    "memory usage limit exceeded",
    "disk usage limit exceeded, try again later",
    "container usage limit hit",
    "You exceeded your memory limit",
    "The CPU usage limit will reset",
  ];
  for (const message of resourceMessages) {
    test(`"${message}" is not a plan usage cap`, () => {
      expect(classifyRecoverable({ message }).code).not.toBe("QUOTA_EXHAUSTED");
    });
  }
});

describe("subtype lookup", () => {
  test("inherited object keys are not subtypes", () => {
    for (const subtype of ["toString", "constructor", "__proto__"]) {
      expect(isKnownSubtype(subtype)).toBe(false);
      expect(classifyRecoverable({ subtype })).toEqual({
        recoverable: true,
        code: "UNKNOWN_ERROR",
      });
    }
  });

  test("table keys are subtypes, trimmed", () => {
    expect(isKnownSubtype("quota_exhausted")).toBe(true);
    expect(isKnownSubtype(" rate_limit ")).toBe(true);
    expect(isKnownSubtype("CODEX_QUOTA_EXHAUSTED")).toBe(true);
    expect(isKnownSubtype("UNKNOWN_ERROR")).toBe(false);
    expect(isKnownSubtype("missing_binary")).toBe(false);
    expect(isKnownSubtype(undefined)).toBe(false);
  });

  test("usage limit subtypes are non-recoverable caps", () => {
    for (const subtype of ["usage_limit_reached", "usage_limit_exceeded"]) {
      expect(classifyRecoverable({ subtype })).toEqual({
        recoverable: false,
        code: "QUOTA_EXHAUSTED",
      });
    }
  });
});

describe("provider-neutral codes", () => {
  test("a usage cap is QUOTA_EXHAUSTED whatever the provider", () => {
    for (const message of [
      "Claude AI usage limit reached|1700000000",
      "Gemini: You have reached your daily limit. Upgrade your plan.",
      "You've hit your usage limit. Try again at 3:45 PM.",
    ]) {
      expect(classifyRecoverable({ message })).toEqual({
        recoverable: false,
        code: "QUOTA_EXHAUSTED",
      });
    }
  });

  test("no recognized code names a provider and every code is UPPER_SNAKE", () => {
    const subtypes = [
      "authentication_failed",
      "billing_error",
      "invalid_request",
      "max_output_tokens",
      "rate_limit",
      "server_error",
      "error_max_budget_usd",
      "error_max_turns",
      "error_max_structured_output_retries",
      "quota_exhausted",
      ...Object.keys(agents.LEGACY_RECOVERABLE_ERROR_CODES),
    ];
    for (const subtype of subtypes) {
      const { code } = classifyRecoverable({ subtype });
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(code).not.toMatch(/CLAUDE|CODEX|GEMINI/);
    }
  });
});

describe("old codes", () => {
  const legacy: ReadonlyArray<[string, RecoverableErrorCode]> = [
    ["CLAUDE_AUTH_ERROR", "AUTH_ERROR"],
    ["CLAUDE_AUTH_STATUS", "AUTH_ERROR"],
    ["CODEX_AUTH_ERROR", "AUTH_ERROR"],
    ["CLAUDE_BILLING_ERROR", "BILLING_ERROR"],
    ["CODEX_QUOTA_EXHAUSTED", "QUOTA_EXHAUSTED"],
    ["error_max_budget_usd", "MAX_BUDGET_EXCEEDED"],
    ["error_max_turns", "MAX_TURNS_EXCEEDED"],
    ["error_max_structured_output_retries", "MAX_STRUCTURED_OUTPUT_RETRIES"],
    ["max_output_tokens", "MAX_OUTPUT_TOKENS"],
    ["CLAUDE_INVALID_REQUEST", "INVALID_REQUEST"],
    ["CODEX_MISSING_BINARY", "MISSING_BINARY"],
    ["CLAUDE_RATE_LIMIT", "RATE_LIMIT"],
    ["CLAUDE_SERVER_ERROR", "SERVER_ERROR"],
    ["TRANSIENT_ERROR", "TRANSPORT_ERROR"],
  ];

  test("the alias table lists every old code", () => {
    expect(agents.LEGACY_RECOVERABLE_ERROR_CODES).toEqual(
      Object.fromEntries(legacy),
    );
    expect(Object.isFrozen(agents.LEGACY_RECOVERABLE_ERROR_CODES)).toBe(true);
  });

  for (const [old, replacement] of legacy) {
    test(`${old} normalizes and classifies as ${replacement}`, () => {
      expect(agents.normalizeRecoverableErrorCode(old)).toBe(replacement);
      expect(classifyRecoverable({ subtype: old }).code).toBe(replacement);
    });
  }

  test("other codes pass through normalization unchanged", () => {
    for (const code of ["QUOTA_EXHAUSTED", "CODEX_TURN_FAILED", "toString"]) {
      expect(agents.normalizeRecoverableErrorCode(code)).toBe(code);
    }
  });

  test("a returned classification can be changed without affecting the next", () => {
    const first = classifyRecoverable({ subtype: "rate_limit" });
    first.recoverable = false;
    expect(classifyRecoverable({ subtype: "rate_limit" }).recoverable).toBe(
      true,
    );
  });
});
