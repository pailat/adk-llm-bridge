/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Request converter for ADK to OpenAI format.
 *
 * This module handles the conversion of ADK LlmRequest objects to
 * OpenAI-compatible chat completion request format.
 *
 * @module converters/request
 */

import type { LlmRequest } from "@google/adk";
import type { Content, Part } from "@google/genai";
import type OpenAI from "openai";

/**
 * Result of converting an ADK LlmRequest to OpenAI format.
 *
 * Contains the converted messages array and optional tools array
 * ready for use with the OpenAI chat completions API.
 */
export interface ConvertedRequest {
  /**
   * Array of OpenAI-format chat messages.
   *
   * Includes system, user, assistant, and tool messages
   * converted from ADK Content objects.
   */
  messages: OpenAI.ChatCompletionMessageParam[];

  /**
   * Array of OpenAI-format tool definitions.
   *
   * Converted from ADK function declarations with schema normalization.
   */
  tools?: OpenAI.ChatCompletionTool[];
}

/**
 * Converts an ADK LlmRequest to OpenAI chat completion format.
 *
 * This function handles:
 * - System instruction extraction
 * - User and model message conversion
 * - Function call and response handling
 * - Tool/function declaration conversion
 * - Schema normalization (Gemini UPPERCASE to OpenAI lowercase types)
 *
 * @param llmRequest - The ADK LlmRequest to convert
 * @returns The converted request with messages and optional tools
 *
 * @example
 * ```typescript
 * import { convertRequest } from "adk-llm-bridge";
 *
 * const adkRequest: LlmRequest = {
 *   contents: [{ role: "user", parts: [{ text: "Hello!" }] }],
 *   config: { systemInstruction: "You are a helpful assistant." }
 * };
 *
 * const { messages, tools } = convertRequest(adkRequest);
 * // messages = [
 * //   { role: "system", content: "You are a helpful assistant." },
 * //   { role: "user", content: "Hello!" }
 * // ]
 * ```
 *
 * @example
 * ```typescript
 * // With tools/functions
 * const adkRequest: LlmRequest = {
 *   contents: [...],
 *   config: {
 *     tools: [{
 *       functionDeclarations: [{
 *         name: "get_weather",
 *         description: "Get current weather",
 *         parameters: { type: "OBJECT", properties: { city: { type: "STRING" } } }
 *       }]
 *     }]
 *   }
 * };
 *
 * const { messages, tools } = convertRequest(adkRequest);
 * // tools[0].function.parameters.type = "object" (normalized from "OBJECT")
 * ```
 */
export function convertRequest(llmRequest: LlmRequest): ConvertedRequest {
  const messages: OpenAI.ChatCompletionMessageParam[] = [];

  const systemContent = extractSystemInstruction(llmRequest);
  if (systemContent) {
    messages.push({ role: "system", content: systemContent });
  }

  for (const content of llmRequest.contents ?? []) {
    processContent(content, messages);
  }

  return { messages, tools: convertTools(llmRequest) };
}

/**
 * Extracts the system instruction from an LlmRequest.
 *
 * Handles both string and Content object formats.
 *
 * @param req - The LLM request
 * @returns The system instruction text, or null if not present
 *
 * @internal
 */
function extractSystemInstruction(req: LlmRequest): string | null {
  const sys = req.config?.systemInstruction;
  if (!sys) return null;
  if (typeof sys === "string") return sys;
  if ("parts" in sys) return extractText(sys.parts ?? []);
  return null;
}

/**
 * Extracts text from an array of Parts.
 *
 * @param parts - Array of Part objects
 * @returns Concatenated text from all text parts
 *
 * @internal
 */
function extractText(parts: Part[]): string {
  return parts
    .map((p) => p.text)
    .filter(Boolean)
    .join("\n");
}

/**
 * Processes a Content object and adds appropriate messages.
 *
 * Handles user messages, model responses, function calls, and function responses.
 *
 * @param content - The ADK Content object
 * @param messages - The messages array to append to
 *
 * @internal
 */
function processContent(
  content: Content,
  messages: OpenAI.ChatCompletionMessageParam[],
): void {
  if (!content.parts?.length) return;

  const texts: string[] = [];
  const calls: { id: string; name: string; arguments: string }[] = [];
  const responses: { id: string; content: string }[] = [];

  for (const part of content.parts) {
    if (part.text) texts.push(part.text);
    if (part.functionCall) {
      calls.push({
        id: part.functionCall.id ?? `call_${Date.now()}`,
        name: part.functionCall.name ?? "",
        arguments: JSON.stringify(part.functionCall.args ?? {}),
      });
    }
    if (part.functionResponse) {
      responses.push({
        id: part.functionResponse.id ?? "",
        content: JSON.stringify(part.functionResponse.response ?? {}),
      });
    }
  }

  if (content.role === "user") {
    if (texts.length)
      messages.push({ role: "user", content: texts.join("\n") });
    for (const r of responses) {
      messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
    }
  } else if (content.role === "model") {
    if (texts.length || calls.length) {
      const msg: OpenAI.ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: texts.length ? texts.join("\n") : null,
      };
      if (calls.length) {
        msg.tool_calls = calls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: c.arguments },
        }));
      }
      messages.push(msg);
    }
  }
}

/**
 * Converts ADK tool declarations to OpenAI format.
 *
 * @param req - The LLM request containing tool definitions
 * @returns Array of OpenAI tool objects, or undefined if no tools
 *
 * @internal
 */
function convertTools(
  req: LlmRequest,
): OpenAI.ChatCompletionTool[] | undefined {
  const adkTools = req.config?.tools;
  if (!adkTools?.length) return undefined;

  const tools: OpenAI.ChatCompletionTool[] = [];

  for (const group of adkTools) {
    if (
      "functionDeclarations" in group &&
      Array.isArray(group.functionDeclarations)
    ) {
      for (const fn of group.functionDeclarations) {
        tools.push({
          type: "function",
          function: {
            name: fn.name ?? "",
            description: fn.description ?? "",
            parameters: normalizeSchema(fn.parameters) ?? {
              type: "object",
              properties: {},
            },
          },
        });
      }
    }
  }

  return tools.length ? tools : undefined;
}

/**
 * Normalizes Gemini-style schema to OpenAI-style schema.
 *
 * Converts UPPERCASE type names (Gemini format) to lowercase (OpenAI format).
 * For example: "OBJECT" → "object", "STRING" → "string".
 *
 * @param schema - The schema object to normalize
 * @returns The normalized schema, or undefined if input is invalid
 *
 * @internal
 *
 * @example
 * ```typescript
 * normalizeSchema({ type: "OBJECT", properties: { name: { type: "STRING" } } });
 * // Returns: { type: "object", properties: { name: { type: "string" } } }
 * ```
 */
function normalizeSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== "object") return undefined;

  const result: Record<string, unknown> = {};
  const input = schema as Record<string, unknown>;

  for (const [key, value] of Object.entries(input)) {
    if (key === "type" && typeof value === "string") {
      // Convert UPPERCASE type to lowercase (OBJECT -> object, STRING -> string, etc.)
      result[key] = value.toLowerCase();
    } else if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      // Recursively normalize nested objects (like properties)
      result[key] = normalizeSchema(value);
    } else if (Array.isArray(value)) {
      // Handle arrays (like required)
      result[key] = value;
    } else {
      result[key] = value;
    }
  }

  return result;
}
