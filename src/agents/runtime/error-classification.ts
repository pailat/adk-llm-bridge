/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Shared error-classification helper for external-agent drivers.
 *
 * Both the Codex (`@openai/codex-sdk`) and Claude
 * (`@anthropic-ai/claude-agent-sdk`) drivers historically labelled every error
 * `recoverable: true`, which causes upstream retry loops to spin on unfixable
 * conditions (auth/billing/missing-binary/quota). This module centralizes the
 * recoverable-vs-non-recoverable decision so both drivers share ONE contract.
 *
 * Classification is heuristic: the underlying SDKs frequently expose only a
 * free-form message string, so callers may pass a known typed subtype (when
 * available) and/or the raw message text. A known subtype always wins over the
 * message heuristic.
 */

/** Result of classifying an error condition. */
export interface RecoverableClassification {
  /** Whether retrying the operation could plausibly succeed. */
  recoverable: boolean;
  /** Stable, machine-readable code describing the classified condition. */
  code: string;
}

/** Input to {@link classifyRecoverable}. */
export interface ClassifyRecoverableInput {
  /**
   * A known typed subtype from the SDK (e.g. Claude's
   * `SDKAssistantMessageError` / `SDKResultError` subtypes, or a synthetic
   * Codex subtype). Takes precedence over the message heuristic.
   */
  subtype?: string | null;
  /** Free-form error message text used for heuristic classification. */
  message?: string | null;
  /**
   * Fallback code to emit when no subtype or message signal matches. Defaults
   * to `UNKNOWN_ERROR`.
   */
  fallbackCode?: string;
  /**
   * Default recoverability when no signal matches. Defaults to `true`
   * (preserve the historical "assume transient" behavior for truly unknown
   * errors).
   */
  defaultRecoverable?: boolean;
}

/**
 * Known typed subtypes that map to a deterministic classification.
 *
 * Codex contributes synthetic subtypes (the SDK only exposes a message
 * string); Claude contributes its real `SDKAssistantMessageError` /
 * `SDKResultError` subtypes plus driver-level status codes.
 */
const SUBTYPE_TABLE: Record<string, RecoverableClassification> = {
  // --- Non-recoverable: credential / authorization ---
  authentication_failed: { recoverable: false, code: "CLAUDE_AUTH_ERROR" },
  oauth_org_not_allowed: { recoverable: false, code: "CLAUDE_AUTH_ERROR" },
  CLAUDE_AUTH_STATUS: { recoverable: false, code: "CLAUDE_AUTH_STATUS" },
  CODEX_AUTH_ERROR: { recoverable: false, code: "CODEX_AUTH_ERROR" },

  // --- Non-recoverable: billing / quota ---
  billing_error: { recoverable: false, code: "CLAUDE_BILLING_ERROR" },
  error_max_budget_usd: { recoverable: false, code: "error_max_budget_usd" },
  quota_exhausted: { recoverable: false, code: "CODEX_QUOTA_EXHAUSTED" },

  // --- Non-recoverable: client/config errors that won't fix on retry ---
  invalid_request: { recoverable: false, code: "CLAUDE_INVALID_REQUEST" },
  error_max_turns: { recoverable: false, code: "error_max_turns" },
  error_max_structured_output_retries: {
    recoverable: false,
    code: "error_max_structured_output_retries",
  },
  max_output_tokens: { recoverable: false, code: "max_output_tokens" },

  // --- Non-recoverable: environment (missing binary) ---
  missing_binary: { recoverable: false, code: "CODEX_MISSING_BINARY" },

  // --- Recoverable: transient / transport / rate-limit ---
  rate_limit: { recoverable: true, code: "CLAUDE_RATE_LIMIT" },
  server_error: { recoverable: true, code: "CLAUDE_SERVER_ERROR" },
  transient: { recoverable: true, code: "TRANSIENT_ERROR" },
  transport: { recoverable: true, code: "TRANSPORT_ERROR" },
};

interface MessageRule {
  readonly test: RegExp;
  readonly result: RecoverableClassification;
}

/**
 * Heuristic message rules, evaluated in order. The first match wins. Tuned so
 * that auth/billing/missing-binary/quota are non-recoverable and
 * transport/rate-limit are recoverable.
 *
 * Order matters: rate-limit (recoverable) is checked before the generic
 * "quota" non-recoverable rule so a "rate limit" message is not mis-bucketed.
 */
const MESSAGE_RULES: readonly MessageRule[] = [
  {
    test: /\b(rate[\s_-]?limit|429|too many requests)\b/i,
    result: { recoverable: true, code: "RATE_LIMIT" },
  },
  {
    test: /\b(unauthor|authentication|invalid api key|invalid_api_key|401|403|forbidden|oauth)\b/i,
    result: { recoverable: false, code: "AUTH_ERROR" },
  },
  {
    test: /\b(billing|payment|insufficient (?:funds|credit)|quota\b.*\bexhaust|exhaust\w*\b.*\bquota|over quota|out of credit)/i,
    result: { recoverable: false, code: "BILLING_ERROR" },
  },
  {
    test: /\b(unable to locate|not found on path|missing binary|no such file|enoent|executable not found)\b/i,
    result: { recoverable: false, code: "MISSING_BINARY" },
  },
  {
    test: /\b(timed?\s?out|timeout|econnreset|econnrefused|enetunreach|socket hang up|network|transport|temporarily unavailable|503|502|504)\b/i,
    result: { recoverable: true, code: "TRANSPORT_ERROR" },
  },
];

/**
 * Classify an error as recoverable (retry may succeed) or non-recoverable
 * (retrying is futile until the operator fixes the underlying condition).
 *
 * Precedence: known {@link ClassifyRecoverableInput.subtype} > message
 * heuristic > configured fallback.
 */
export function classifyRecoverable(
  input: ClassifyRecoverableInput,
): RecoverableClassification {
  const subtype = input.subtype?.trim();
  if (subtype && subtype in SUBTYPE_TABLE) {
    return SUBTYPE_TABLE[subtype];
  }

  const message = input.message ?? "";
  if (message) {
    for (const rule of MESSAGE_RULES) {
      if (rule.test.test(message)) {
        return rule.result;
      }
    }
  }

  return {
    recoverable: input.defaultRecoverable ?? true,
    code: input.fallbackCode ?? "UNKNOWN_ERROR",
  };
}
