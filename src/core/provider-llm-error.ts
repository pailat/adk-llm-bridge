/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Error thrown by providers when `errorMode` is `"throw"` (the default).
 *
 * ADK's `LlmAgent` catches model errors, runs plugins' `onModelErrorCallback`,
 * and otherwise parses `error.message` as `{"error":{"code","message"}}` to
 * build the event's `errorCode`/`errorMessage`. The `message` is therefore that
 * JSON document, so the event keeps the provider-specific code (for example
 * `API_ERROR_429` or `OPENAI_ERROR`) instead of `UNKNOWN_ERROR`. The original
 * human-readable text is on {@link detail}; the original error on `cause`.
 *
 * @module core/provider-llm-error
 */

/** Fields describing a failed provider call. */
export interface ProviderLlmErrorInit {
  /** Stable error code, e.g. `API_ERROR_429` or `OPENAI_ERROR`. */
  code: string;
  /** Human-readable message of the underlying failure. */
  detail: string;
  /** Provider id or error prefix that raised it. */
  provider: string;
  /** HTTP status when the failure was an API error. */
  status?: number;
  /** The original error. */
  cause?: unknown;
}

export class ProviderLlmError extends Error {
  /** Stable error code, the same value `errorMode: "response"` puts in `errorCode`. */
  readonly code: string;
  /** Human-readable message of the underlying failure. */
  readonly detail: string;
  /** Provider id or error prefix that raised it. */
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
