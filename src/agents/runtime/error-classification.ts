/**
 * Shared error-classification helper for external-agent drivers.
 *
 * Every driver (Codex SDK and CLI, Claude Agent SDK and CLI, Gemini CLI)
 * shares this one contract for the recoverable-vs-non-recoverable
 * decision. Labelling every error `recoverable: true` would make upstream retry
 * loops spin on unfixable conditions (auth, billing, missing binary, quota).
 *
 * Classification is heuristic: the underlying SDKs frequently expose only a
 * free-form message string, so callers may pass a known typed subtype (when
 * available) and/or the raw message text. A known subtype always wins over the
 * message heuristic.
 */

/**
 * Codes {@link classifyRecoverable} reports for a recognized failure. They are
 * the same for every provider: a usage cap is `QUOTA_EXHAUSTED` whether Codex,
 * Claude or the Gemini CLI hit it.
 *
 * - `AUTH_ERROR`: the credential was rejected. Not recoverable.
 * - `BILLING_ERROR`: billing or credit problem. Not recoverable.
 * - `QUOTA_EXHAUSTED`: a plan usage cap; it resets in hours or days. Not
 *   recoverable.
 * - `MAX_BUDGET_EXCEEDED`, `MAX_TURNS_EXCEEDED`,
 *   `MAX_STRUCTURED_OUTPUT_RETRIES`, `MAX_OUTPUT_TOKENS`: a configured limit
 *   of the run was reached. Not recoverable.
 * - `INVALID_REQUEST`: the request was rejected as malformed. Not recoverable.
 * - `MISSING_BINARY`: the runtime's binary was not found. Not recoverable.
 * - `RATE_LIMIT`: throttled. Recoverable.
 * - `SERVER_ERROR`: the provider failed. Recoverable.
 * - `TRANSPORT_ERROR`: timeout, connection or gateway failure. Recoverable.
 * - `UNKNOWN_ERROR`: nothing matched and no fallback code was given.
 *   Recoverable unless the caller says otherwise.
 */
export type RecoverableErrorCode =
  | "AUTH_ERROR"
  | "BILLING_ERROR"
  | "QUOTA_EXHAUSTED"
  | "MAX_BUDGET_EXCEEDED"
  | "MAX_TURNS_EXCEEDED"
  | "MAX_STRUCTURED_OUTPUT_RETRIES"
  | "MAX_OUTPUT_TOKENS"
  | "INVALID_REQUEST"
  | "MISSING_BINARY"
  | "RATE_LIMIT"
  | "SERVER_ERROR"
  | "TRANSPORT_ERROR"
  | "UNKNOWN_ERROR";

/** Result of classifying an error condition. */
export interface RecoverableClassification {
  /** Whether retrying the operation could plausibly succeed. */
  recoverable: boolean;
  /**
   * Stable, machine-readable code: a {@link RecoverableErrorCode}, or the
   * caller's `fallbackCode` when nothing matched.
   */
  code: RecoverableErrorCode | (string & {});
}

/** Input to {@link classifyRecoverable}. */
export interface ClassifyRecoverableInput {
  /**
   * A known typed subtype from the runtime (Claude's
   * `SDKAssistantMessageError` and `SDKResultError` subtypes, or a Codex
   * error `code`). Takes precedence over the message heuristic.
   */
  subtype?: string | null;
  /** Free-form error message text used for heuristic classification. */
  message?: string | null;
  /**
   * Fallback code to emit when no subtype or message signal matches.
   *
   * @defaultValue `"UNKNOWN_ERROR"`
   */
  fallbackCode?: string;
  /**
   * Default recoverability when no signal matches. Unknown errors are assumed
   * transient unless the caller says otherwise.
   *
   * @defaultValue `true`
   */
  defaultRecoverable?: boolean;
}

const NOT_RECOVERABLE = (code: RecoverableErrorCode) =>
  Object.freeze({ recoverable: false, code });
const RECOVERABLE = (code: RecoverableErrorCode) =>
  Object.freeze({ recoverable: true, code });

/** Every recognized code with its recoverability. */
const CODES: Readonly<
  Record<
    Exclude<RecoverableErrorCode, "UNKNOWN_ERROR">,
    RecoverableClassification
  >
> = {
  AUTH_ERROR: NOT_RECOVERABLE("AUTH_ERROR"),
  BILLING_ERROR: NOT_RECOVERABLE("BILLING_ERROR"),
  QUOTA_EXHAUSTED: NOT_RECOVERABLE("QUOTA_EXHAUSTED"),
  MAX_BUDGET_EXCEEDED: NOT_RECOVERABLE("MAX_BUDGET_EXCEEDED"),
  MAX_TURNS_EXCEEDED: NOT_RECOVERABLE("MAX_TURNS_EXCEEDED"),
  MAX_STRUCTURED_OUTPUT_RETRIES: NOT_RECOVERABLE(
    "MAX_STRUCTURED_OUTPUT_RETRIES",
  ),
  MAX_OUTPUT_TOKENS: NOT_RECOVERABLE("MAX_OUTPUT_TOKENS"),
  INVALID_REQUEST: NOT_RECOVERABLE("INVALID_REQUEST"),
  MISSING_BINARY: NOT_RECOVERABLE("MISSING_BINARY"),
  RATE_LIMIT: RECOVERABLE("RATE_LIMIT"),
  SERVER_ERROR: RECOVERABLE("SERVER_ERROR"),
  TRANSPORT_ERROR: RECOVERABLE("TRANSPORT_ERROR"),
};

/**
 * Codes reported before 0.7, each with the {@link RecoverableErrorCode} that
 * replaces it.
 *
 * @remarks
 * The classifier does not report these codes. Pass a stored or compared code
 * through {@link normalizeRecoverableErrorCode} to match old and new codes
 * alike. As a `subtype`, an old code still classifies as its replacement.
 *
 * @deprecated Use {@link normalizeRecoverableErrorCode}, which maps every code
 * in this table to its replacement. The table stays exported until the next
 * major version.
 */
export const LEGACY_RECOVERABLE_ERROR_CODES: Readonly<
  Record<string, RecoverableErrorCode>
> = Object.freeze({
  CLAUDE_AUTH_ERROR: "AUTH_ERROR",
  CLAUDE_AUTH_STATUS: "AUTH_ERROR",
  CODEX_AUTH_ERROR: "AUTH_ERROR",
  CLAUDE_BILLING_ERROR: "BILLING_ERROR",
  CODEX_QUOTA_EXHAUSTED: "QUOTA_EXHAUSTED",
  error_max_budget_usd: "MAX_BUDGET_EXCEEDED",
  error_max_turns: "MAX_TURNS_EXCEEDED",
  error_max_structured_output_retries: "MAX_STRUCTURED_OUTPUT_RETRIES",
  max_output_tokens: "MAX_OUTPUT_TOKENS",
  CLAUDE_INVALID_REQUEST: "INVALID_REQUEST",
  CODEX_MISSING_BINARY: "MISSING_BINARY",
  CLAUDE_RATE_LIMIT: "RATE_LIMIT",
  CLAUDE_SERVER_ERROR: "SERVER_ERROR",
  TRANSIENT_ERROR: "TRANSPORT_ERROR",
});

/**
 * Maps a code reported before 0.7 to the code that replaces it.
 *
 * @example
 * ```ts
 * normalizeRecoverableErrorCode("CODEX_QUOTA_EXHAUSTED"); // "QUOTA_EXHAUSTED"
 * normalizeRecoverableErrorCode("QUOTA_EXHAUSTED"); // "QUOTA_EXHAUSTED"
 * ```
 *
 * @param code - An error code, old or new.
 * @returns The replacement for a code in {@link LEGACY_RECOVERABLE_ERROR_CODES},
 * otherwise `code` unchanged.
 */
export function normalizeRecoverableErrorCode(code: string): string {
  return Object.hasOwn(LEGACY_RECOVERABLE_ERROR_CODES, code)
    ? (LEGACY_RECOVERABLE_ERROR_CODES[code] as string)
    : code;
}

/**
 * Subtypes that map to a fixed classification: the runtimes' own subtypes,
 * the codes themselves, and the old codes.
 *
 * Runtime subtypes come from Claude's `SDKAssistantMessageError`: every
 * member except `unknown`. Account problems (`account_on_hold`,
 * `verification_required`, `cloud_credential_error`) are `AUTH_ERROR`, a bad
 * model id (`model_not_found`) is `INVALID_REQUEST`, and `overloaded` is a
 * recoverable `SERVER_ERROR`. They also come from
 * `SDKResultError` (`error_max_turns`, `error_max_budget_usd`,
 * `error_max_structured_output_retries`), and from the `code` of a Codex
 * error line (`quota_exhausted`, `usage_limit_reached`,
 * `usage_limit_exceeded`, `rate_limit`, `server_error`, `invalid_request`).
 */
const SUBTYPE_TABLE: Readonly<Record<string, RecoverableClassification>> =
  Object.freeze({
    authentication_failed: CODES.AUTH_ERROR,
    oauth_org_not_allowed: CODES.AUTH_ERROR,
    account_on_hold: CODES.AUTH_ERROR,
    verification_required: CODES.AUTH_ERROR,
    cloud_credential_error: CODES.AUTH_ERROR,
    model_not_found: CODES.INVALID_REQUEST,
    overloaded: CODES.SERVER_ERROR,
    billing_error: CODES.BILLING_ERROR,
    quota_exhausted: CODES.QUOTA_EXHAUSTED,
    usage_limit_reached: CODES.QUOTA_EXHAUSTED,
    usage_limit_exceeded: CODES.QUOTA_EXHAUSTED,
    invalid_request: CODES.INVALID_REQUEST,
    rate_limit: CODES.RATE_LIMIT,
    server_error: CODES.SERVER_ERROR,
    ...CODES,
    ...Object.fromEntries(
      Object.entries(LEGACY_RECOVERABLE_ERROR_CODES).map(([legacy, code]) => [
        legacy,
        CODES[code as keyof typeof CODES],
      ]),
    ),
  });

/**
 * Lookbehind: "usage limit" right after a resource word is a resource cap,
 * not a plan usage cap.
 */
const RESOURCE_WORDS =
  "memory|disk|cpu|gpu|storage|ram|heap|stack|bandwidth|resource|file|process|container|pod|rate";
const NOT_A_RESOURCE = String.raw`(?<!\b(?:${RESOURCE_WORDS})[\s_-])`;

interface MessageRule {
  readonly test: RegExp;
  readonly result: RecoverableClassification;
}

/**
 * Heuristic message rules, evaluated in order. The first match wins. Tuned so
 * that auth/billing/missing-binary/quota are non-recoverable and
 * transport/rate-limit are recoverable.
 *
 * Order matters:
 * - a plan usage cap comes first: it resets in hours or days, so it is not
 *   transient throttling even when the message also carries a 429;
 * - rate-limit (recoverable) is checked before the generic "quota"
 *   non-recoverable rule so a "rate limit" message is not mis-bucketed.
 */
const MESSAGE_RULES: readonly MessageRule[] = [
  {
    // Subscription/usage caps (Codex: "You've hit your usage limit ... try
    // again at <time>"). Shared by every driver. Matches:
    // - "hit/reached/exceeded your <word> limit" ("your rate limit" stays a
    //   recoverable rate limit; "your memory limit" is a resource cap);
    // - "usage limit reached/exceeded/hit";
    // - "usage limit" followed later by a plan/reset hint (try again, resets,
    //   upgrade, plan, subscription, credits).
    // A resource word right before "usage limit" ("memory usage limit
    // exceeded", "disk usage limit") is not a plan cap and does not match.
    test: new RegExp(
      [
        String.raw`\b(?:hit|reached|exceeded) your (?:(?!(?:${RESOURCE_WORDS})\b)[\w-]+ )?limit\b`,
        String.raw`${NOT_A_RESOURCE}\busage[\s_-]limit[\s_-](?:reached|exceeded|hit)\b`,
        String.raw`${NOT_A_RESOURCE}\busage limit\b.*?\b(?:try again|resets?|upgrade|plan|subscription|credits?)\b`,
      ].join("|"),
      "i",
    ),
    result: CODES.QUOTA_EXHAUSTED,
  },
  {
    test: /\b(rate[\s_-]?limit|429|too many requests)\b/i,
    result: CODES.RATE_LIMIT,
  },
  {
    test: /\b(unauthor|authentication|invalid api key|invalid_api_key|401|403|forbidden|oauth)\b/i,
    result: CODES.AUTH_ERROR,
  },
  {
    test: /\b(billing|payment|insufficient (?:funds|credit)|quota\b.*\bexhaust|exhaust\w*\b.*\bquota|over quota|out of credit)/i,
    result: CODES.BILLING_ERROR,
  },
  {
    test: /\b(unable to locate|not found on path|missing binary|no such file|enoent|executable not found)\b/i,
    result: CODES.MISSING_BINARY,
  },
  {
    test: /\b(timed?\s?out|timeout|econnreset|econnrefused|enetunreach|socket hang up|network|transport|temporarily unavailable|503|502|504)\b/i,
    result: CODES.TRANSPORT_ERROR,
  },
];

/**
 * Classify an error as recoverable (retry may succeed) or non-recoverable
 * (retrying is futile until the operator fixes the underlying condition).
 *
 * Precedence: a known {@link ClassifyRecoverableInput.subtype} first, then
 * the message heuristic, then the configured fallback.
 *
 * @param input - Subtype and/or message text, plus fallback settings.
 * @returns The classification: whether a retry may help, and a stable code.
 */
export function classifyRecoverable(
  input: ClassifyRecoverableInput,
): RecoverableClassification {
  const subtype = input.subtype?.trim();
  if (subtype && isKnownSubtype(subtype)) {
    return { ...(SUBTYPE_TABLE[subtype] as RecoverableClassification) };
  }

  const message = input.message ?? "";
  if (message) {
    for (const rule of MESSAGE_RULES) {
      if (rule.test.test(message)) {
        return { ...rule.result };
      }
    }
  }

  return {
    recoverable: input.defaultRecoverable ?? true,
    code: input.fallbackCode ?? "UNKNOWN_ERROR",
  };
}

/**
 * True when `value` is a key of the subtype table that
 * {@link classifyRecoverable} maps to a fixed classification.
 *
 * @remarks Only own keys count, so inherited names such as `toString` are
 * not subtypes. Surrounding white space is ignored.
 * @param value - A code or subtype reported by a runtime.
 * @returns Whether {@link classifyRecoverable} classifies it by table.
 */
export function isKnownSubtype(value: string | null | undefined): boolean {
  return (
    typeof value === "string" && Object.hasOwn(SUBTYPE_TABLE, value.trim())
  );
}
