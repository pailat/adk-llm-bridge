import { classifyRecoverable } from "../agents/runtime/error-classification.js";

/**
 * Code of a reply with no choice (an OpenAI-compatible response whose
 * `choices` is empty).
 */
export const PROVIDER_ERROR_NO_CHOICE = "NO_CHOICE";

/**
 * Code of a reply whose tool-call arguments are not valid JSON (often cut by
 * the output token limit). Also the response's `finishReason`.
 */
export const PROVIDER_ERROR_MALFORMED_FUNCTION_CALL = "MALFORMED_FUNCTION_CALL";

/**
 * Code of a streamed reply that ended before its final chunk (no
 * `finish_reason` from an OpenAI-compatible API, no `message_stop` from
 * Anthropic), for example when the connection closed early. The partial
 * responses already yielded are not a complete turn.
 */
export const PROVIDER_ERROR_INCOMPLETE_STREAM = "INCOMPLETE_STREAM";

/**
 * Codes a provider puts in `errorCode` (and in {@link ProviderLlmError.code}).
 *
 * - `API_ERROR_<status>`: the API answered with that HTTP status, for example
 *   `API_ERROR_429`.
 * - `<PREFIX>_ERROR`: any other failure, with the provider's prefix:
 *   `OPENAI_ERROR`, `OPENROUTER_ERROR`, `XAI_ERROR`, `AI_GATEWAY_ERROR`,
 *   `ANTHROPIC_ERROR`, or a custom provider's name in upper case.
 * - {@link PROVIDER_ERROR_NO_CHOICE},
 *   {@link PROVIDER_ERROR_MALFORMED_FUNCTION_CALL} and
 *   {@link PROVIDER_ERROR_INCOMPLETE_STREAM}.
 */
export type ProviderErrorCode =
  | `API_ERROR_${number}`
  | `${string}_ERROR`
  | typeof PROVIDER_ERROR_NO_CHOICE
  | typeof PROVIDER_ERROR_MALFORMED_FUNCTION_CALL
  | typeof PROVIDER_ERROR_INCOMPLETE_STREAM;

/** Fields describing a failed provider call. */
export interface ProviderLlmErrorInit {
  /** Stable error code, e.g. `API_ERROR_429` or `OPENAI_ERROR`; see {@link ProviderErrorCode}. */
  code: string;
  /** Human-readable message of the underlying failure. */
  detail: string;
  /**
   * Id of the provider that raised it, for example `openai`, `anthropic` or
   * `custom` (the prefix is in `code`).
   */
  provider: string;
  /** HTTP status when the failure was an API error. */
  status?: number;
  /** The original error. */
  cause?: unknown;
}

/**
 * Error thrown by providers when `errorMode` is `"throw"` (the default).
 *
 * @remarks
 * ADK's `LlmAgent` catches model errors, runs plugins' `onModelErrorCallback`,
 * and otherwise parses `error.message` as `{"error":{"code","message"}}` to
 * build the event's `errorCode`/`errorMessage`. The `message` is therefore that
 * JSON document, so the event keeps the provider-specific code (for example
 * `API_ERROR_429` or `OPENAI_ERROR`) instead of `UNKNOWN_ERROR`. The original
 * human-readable text is on {@link ProviderLlmError.detail}; the original error
 * on `cause`.
 */
export class ProviderLlmError extends Error {
  /**
   * Stable error code, the same value `errorMode: "response"` puts in
   * `errorCode`; see {@link ProviderErrorCode}.
   */
  readonly code: string;
  /** Human-readable message of the underlying failure. */
  readonly detail: string;
  /**
   * Id of the provider that raised it, for example `openai`, `anthropic` or
   * `custom` (the prefix is in `code`).
   */
  readonly provider: string;
  /** HTTP status when the failure was an API error. */
  readonly status?: number;

  constructor(init: ProviderLlmErrorInit) {
    super(
      JSON.stringify({ error: { code: init.code, message: init.detail } }),
      {
        cause: init.cause,
      },
    );
    this.name = "ProviderLlmError";
    this.code = init.code;
    this.detail = init.detail;
    this.provider = init.provider;
    this.status = init.status;
  }
}

/** Deepest `cause` read by {@link describeProviderFailure}. */
const MAX_CAUSE_DEPTH = 5;
/**
 * An error `name`: letters ending in `Error` or `Exception`, e.g. `TypeError`,
 * `AbortError` or `DOMException`. Any other name is reported as `Error`.
 */
const SAFE_NAME = /^[A-Z][A-Za-z]{0,48}(?:Error|Exception)$/;
/**
 * A system or library error `code`, by shape: an errno code (`ECONNREFUSED`),
 * upper snake case of two to eight words of at most 12 capitals each, a word
 * after the first ending in at most one digit (`UND_ERR_SOCKET`, `EAI_AGAIN`,
 * `ERR_HTTP2_STREAM_ERROR`), or capitalized words from Bun's own `fetch`
 * (`ConnectionRefused`, `FailedToOpenSocket`). A token-like value (a digit
 * inside or leading a word, a capital run longer than a word, lower-case
 * runs, no word breaks) is left out.
 */
const SAFE_CODE =
  /^(?:E[A-Z]{2,15}|[A-Z]{2,12}(?:_[A-Z]{1,12}[0-9]?){1,7}|[A-Z][a-z]+(?:[A-Z][a-z]+){1,5})$/;
/** Code `classifyRecoverable` gives a timeout or connection failure. */
const TRANSPORT_ERROR = "TRANSPORT_ERROR";

/**
 * Describes a caught provider failure without secrets.
 *
 * @remarks
 * An error thrown inside `fetch` (refused connection, DNS or TLS failure,
 * abort, a custom `fetch` that throws) reaches the provider as the SDK's
 * generic `Connection error.` or `Request timed out.`, with the original
 * error on `cause`. This appends what tells the failures apart: the `name` and
 * `code` of each error in the `cause` chain, and the host of the request. Cause
 * messages, URLs and headers are left out, since they can carry an API key, a
 * bearer token or a query string, and so is a name or code not shaped like
 * one (see `SAFE_NAME` and `SAFE_CODE`). A part that would make
 * `classifyRecoverable` give the message another code is left out too, except
 * `TRANSPORT_ERROR`, the code of what a fetch failure is. A `cause` that
 * throws when read ends the chain.
 *
 * @param error - A caught value.
 * @param host - Hostname the request was sent to, if known.
 * @returns The message of `error`, followed by the summary when `error` has no
 *   HTTP status and has a `cause`. Never throws.
 * @internal
 */
export function describeProviderFailure(error: unknown, host?: string): string {
  let message: string;
  try {
    message = error instanceof Error ? error.message : String(error);
    if (!(error instanceof Error) || httpStatusOf(error) !== undefined) {
      return message;
    }
  } catch {
    return "Unknown provider error";
  }
  const chain = causeChain(error);
  if (chain.length === 0) return message;

  // Callers classify the text with `classifyRecoverable`, so a part is kept
  // only when it leaves the classification of `message` unchanged, or makes
  // it the transport failure it is: a host such as `payments.acme.test` would
  // read as billing, `ratelimit.acme.test` as a rate limit, a code such as
  // `ENOENT` as a missing binary.
  const base = classifyRecoverable({ message });
  const render = (entries: string[], hostPart: string) =>
    `${message} (cause: ${entries.join(", ")}${hostPart})`;
  const keeps = (entries: string[], hostPart: string) => {
    const next = classifyRecoverable({ message: render(entries, hostPart) });
    return (
      next.code === TRANSPORT_ERROR ||
      (next.code === base.code && next.recoverable === base.recoverable)
    );
  };
  const entries: string[] = [];
  for (const { name, code } of chain) {
    const bare = keeps([...entries, name], "") ? name : "Error";
    const withCode = code ? `${bare} ${code}` : bare;
    entries.push(code && keeps([...entries, withCode], "") ? withCode : bare);
  }
  const hostPart = host ? `; host: ${host}` : "";
  return render(entries, hostPart && keeps(entries, hostPart) ? hostPart : "");
}

/**
 * Reads the safe `name` and `code` of each error in the `cause` chain below
 * `error`, outermost first. A value that throws when read (a revoked `Proxy`,
 * a throwing getter) ends the chain; the entries read before it are kept.
 */
function causeChain(error: Error): { name: string; code?: string }[] {
  const chain: { name: string; code?: string }[] = [];
  try {
    const seen = new Set<unknown>([error]);
    let current: unknown = error.cause;
    while (
      current !== null &&
      typeof current === "object" &&
      !seen.has(current) &&
      chain.length < MAX_CAUSE_DEPTH
    ) {
      seen.add(current);
      const { name, code } = current as { name?: unknown; code?: unknown };
      chain.push({
        name: typeof name === "string" && SAFE_NAME.test(name) ? name : "Error",
        code:
          typeof code === "string" && SAFE_CODE.test(code) ? code : undefined,
      });
      // Read after the push, so a throwing `cause` keeps this entry.
      current = (current as { cause?: unknown }).cause;
    }
  } catch {
    // A cause that cannot be read ends the chain.
  }
  return chain;
}

/**
 * Reads the hostname of a base URL, without its port, path, query or user
 * info.
 *
 * @param url - A base URL.
 * @returns The hostname, or `undefined` when `url` does not parse.
 * @internal
 */
export function hostnameOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads the HTTP status of a caught provider SDK error.
 *
 * @param error - A caught value.
 * @returns The numeric `status` of an API error (as the OpenAI and Anthropic
 *   SDKs set it), or `undefined`.
 * @internal
 */
export function httpStatusOf(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}
