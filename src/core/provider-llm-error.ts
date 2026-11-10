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
