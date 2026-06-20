/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import { classifyRecoverable } from "../../src/agents/runtime/error-classification.js";
import * as agents from "../../src/agents/index.js";

describe("classifyRecoverable", () => {
  test("is exported from the agents public surface", () => {
    expect(agents.classifyRecoverable).toBe(classifyRecoverable);
  });

  describe("known subtypes (table-driven)", () => {
    const cases: ReadonlyArray<[string, boolean, string]> = [
      // auth -> non-recoverable
      ["authentication_failed", false, "CLAUDE_AUTH_ERROR"],
      ["oauth_org_not_allowed", false, "CLAUDE_AUTH_ERROR"],
      ["CLAUDE_AUTH_STATUS", false, "CLAUDE_AUTH_STATUS"],
      ["CODEX_AUTH_ERROR", false, "CODEX_AUTH_ERROR"],
      // billing / quota -> non-recoverable
      ["billing_error", false, "CLAUDE_BILLING_ERROR"],
      ["error_max_budget_usd", false, "error_max_budget_usd"],
      ["quota_exhausted", false, "CODEX_QUOTA_EXHAUSTED"],
      // client/config -> non-recoverable
      ["invalid_request", false, "CLAUDE_INVALID_REQUEST"],
      ["error_max_turns", false, "error_max_turns"],
      [
        "error_max_structured_output_retries",
        false,
        "error_max_structured_output_retries",
      ],
      ["max_output_tokens", false, "max_output_tokens"],
      // missing binary -> non-recoverable
      ["missing_binary", false, "CODEX_MISSING_BINARY"],
      // transient / transport / rate-limit -> recoverable
      ["rate_limit", true, "CLAUDE_RATE_LIMIT"],
      ["server_error", true, "CLAUDE_SERVER_ERROR"],
      ["transient", true, "TRANSIENT_ERROR"],
      ["transport", true, "TRANSPORT_ERROR"],
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
    ).toEqual({ recoverable: false, code: "CLAUDE_AUTH_ERROR" });
  });

  test("rate-limit message is not mis-bucketed as quota/billing", () => {
    expect(classifyRecoverable({ message: "rate limit quota reached" })).toEqual({
      recoverable: true,
      code: "RATE_LIMIT",
    });
  });

  test("unknown input falls back to recoverable + UNKNOWN_ERROR by default", () => {
    expect(classifyRecoverable({ message: "something weird happened" })).toEqual({
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
