/**
 * Fields shared by the final `LlmResponse` of every provider converter.
 */

import type { LlmResponse } from "@google/adk";
import { FinishReason } from "@google/genai";

/** `errorMessage` of a content-filtered turn that returned no content. */
export const CONTENT_FILTERED_MESSAGE =
  "The provider blocked the response (content filter) and returned no content.";

/**
 * The error fields of a turn the provider's content filter ended with no
 * content.
 *
 * @remarks
 * ADK's `createLlmResponse` sets a candidate's finish reason as the
 * `errorCode` when the candidate has no content, so a blocked turn is an
 * error event, not a blank answer. The bridge does the same for
 * `finishReason: SAFETY` only (OpenAI `content_filter`, Anthropic
 * `refusal`): a filter that cut a partial answer keeps its content and gets
 * no error code, and other finishes with no content are unchanged.
 *
 * @param finishReason - The mapped finish reason of the turn.
 * @param hasContent - Whether the response has at least one part.
 * @returns `{ errorCode: "SAFETY", errorMessage }`, or an empty object.
 */
export function contentFilteredError(
  finishReason: FinishReason | undefined,
  hasContent: boolean,
): Pick<LlmResponse, "errorCode" | "errorMessage"> {
  if (finishReason !== FinishReason.SAFETY || hasContent) return {};
  return {
    errorCode: FinishReason.SAFETY,
    errorMessage: CONTENT_FILTERED_MESSAGE,
  };
}

/**
 * `{ modelVersion }` when the provider reported a model, otherwise an empty
 * object (so the key is absent rather than `undefined`).
 *
 * @param model - The model the provider reports in its response.
 */
export function modelVersionOf(
  model: string | null | undefined,
): Pick<LlmResponse, "modelVersion"> {
  return typeof model === "string" && model ? { modelVersion: model } : {};
}
