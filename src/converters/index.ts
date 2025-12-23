/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Request and response converters for ADK ↔ OpenAI format.
 *
 * This module exports functions for converting between ADK's LlmRequest/LlmResponse
 * format and OpenAI's chat completion API format.
 *
 * @module converters
 *
 * @example
 * ```typescript
 * import {
 *   convertRequest,
 *   convertResponse,
 *   convertStreamChunk,
 *   createStreamAccumulator
 * } from "adk-llm-bridge";
 *
 * // Convert ADK request to OpenAI format
 * const { messages, tools } = convertRequest(adkRequest);
 *
 * // Convert OpenAI response to ADK format
 * const adkResponse = convertResponse(openaiResponse);
 * ```
 */

export { convertRequest } from "./request";
export {
  convertResponse,
  convertStreamChunk,
  createStreamAccumulator,
} from "./response";
