/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Tool-call argument parsing shared by every response converter.
 *
 * Models occasionally return tool-call arguments that are not valid JSON,
 * typically because `max_tokens` cut the call short. Executing the tool with
 * `{}` hides the problem; instead the converter reports the response with
 * `finishReason: MALFORMED_FUNCTION_CALL`, which ADK's
 * `ReflectAndRetryModelPlugin` treats as a model error to reflect on and retry.
 *
 * @module converters/tool-arguments
 */

import type { LlmResponse } from "@google/adk";
import { FinishReason, type Part } from "@google/genai";
import { tryParseJson } from "../utils/json.js";

/** A tool call whose arguments could not be parsed. */
export interface MalformedToolCall {
  /** Tool name as emitted by the model. */
  name: string;
  /** Why parsing failed. */
  reason: "invalid-json" | "not-an-object";
}

/** Result of {@link parseToolArguments}. */
export type ToolArgumentsResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; failure: MalformedToolCall };

/**
 * Parses a tool call's raw JSON arguments.
 *
 * Empty or whitespace-only text is a valid call without arguments (`{}`).
 * Integers beyond `Number.MAX_SAFE_INTEGER` are kept exact as strings (see
 * `tryParseJson`).
 *
 * @param raw - The raw arguments text
 * @param name - The tool name, used for the failure report
 */
export function parseToolArguments(
  raw: string,
  name: string,
): ToolArgumentsResult {
  const parsed = tryParseJson(raw);
  if (parsed.ok) return { ok: true, args: parsed.value };
  return { ok: false, failure: { name, reason: parsed.reason } };
}

/**
 * Builds the response for a turn whose tool call(s) had unparseable arguments.
 *
 * It carries `finishReason: MALFORMED_FUNCTION_CALL` and an `errorMessage`
 * naming the tools, plus `errorCode: "MALFORMED_FUNCTION_CALL"`. The error code
 * matters: without it (and without content) ADK drops the response and an
 * `LlmAgent` run emits no event at all when no retry plugin is installed.
 * `ReflectAndRetryModelPlugin` retries on the finish reason, with or without
 * the error code. Every
 * `functionCall` part is removed (a retry regenerates the whole turn); text and
 * thought parts are kept so nothing the model said is lost.
 *
 * @param parts - All parts of the turn, including the function calls
 * @param failures - The malformed calls (at least one)
 * @param extra - Usage and custom metadata to carry over
 */
export function malformedToolCallResponse(
  parts: readonly Part[],
  failures: readonly MalformedToolCall[],
  extra: Pick<LlmResponse, "usageMetadata" | "customMetadata"> = {},
): LlmResponse {
  const kept = parts.filter((part) => !part.functionCall);
  const names = failures
    .map((f) => `${f.name || "(unnamed)"} (${f.reason})`)
    .join(", ");
  return {
    content: kept.length ? { role: "model", parts: kept } : undefined,
    turnComplete: true,
    finishReason: FinishReason.MALFORMED_FUNCTION_CALL,
    errorCode: FinishReason.MALFORMED_FUNCTION_CALL,
    errorMessage: `Tool call arguments were not valid JSON, possibly truncated by the output token limit: ${names}`,
    ...extra,
  };
}
