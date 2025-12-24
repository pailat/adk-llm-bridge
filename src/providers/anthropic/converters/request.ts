/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Request converter for ADK to Anthropic Messages API format.
 *
 * This module handles the conversion of ADK LlmRequest objects to
 * Anthropic's Messages API format.
 *
 * Key differences from OpenAI format:
 * - System instruction is a separate field, not a message
 * - Tools have a different schema format
 * - Content can be an array of content blocks
 *
 * @module providers/anthropic/converters/request
 */

import type { LlmRequest } from "@google/adk";
import type { Content, Part } from "@google/genai";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * Result of converting an ADK LlmRequest to Anthropic format.
 */
export interface ConvertedAnthropicRequest {
  /**
   * Array of Anthropic-format messages.
   */
  messages: Anthropic.MessageParam[];

  /**
   * System instruction as a string (Anthropic uses separate field).
   */
  system?: string;

  /**
   * Array of Anthropic-format tool definitions.
   */
  tools?: Anthropic.Tool[];
}

/**
 * Converts an ADK LlmRequest to Anthropic Messages API format.
 *
 * Handles:
 * - System instruction extraction (as separate field)
 * - User and assistant message conversion
 * - Function call and response handling
 * - Tool/function declaration conversion
 *
 * @param llmRequest - The ADK LlmRequest to convert
 * @returns The converted request with messages, system, and optional tools
 */
export function convertAnthropicRequest(
  llmRequest: LlmRequest,
): ConvertedAnthropicRequest {
  const messages: Anthropic.MessageParam[] = [];

  // Extract system instruction as separate field
  const system = extractSystemInstruction(llmRequest);

  // Process contents into messages
  for (const content of llmRequest.contents ?? []) {
    const msg = processContent(content);
    if (msg) {
      messages.push(msg);
    }
  }

  // Ensure first message is from user (Anthropic requirement)
  if (messages.length > 0 && messages[0].role !== "user") {
    messages.unshift({
      role: "user",
      content: "Continue from where you left off.",
    });
  }

  return {
    messages,
    system: system || undefined,
    tools: convertTools(llmRequest),
  };
}

/**
 * Extracts the system instruction from an LlmRequest.
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
 */
function extractText(parts: Part[]): string {
  return parts
    .map((p) => p.text)
    .filter(Boolean)
    .join("\n");
}

/**
 * Processes a Content object and returns an Anthropic message.
 */
function processContent(content: Content): Anthropic.MessageParam | null {
  if (!content.parts?.length) return null;

  const contentBlocks: Anthropic.ContentBlockParam[] = [];

  for (const part of content.parts) {
    if (part.text) {
      contentBlocks.push({ type: "text", text: part.text });
    }

    if (part.functionCall) {
      contentBlocks.push({
        type: "tool_use",
        id: part.functionCall.id ?? `call_${Date.now()}`,
        name: part.functionCall.name ?? "",
        input: part.functionCall.args ?? {},
      });
    }

    if (part.functionResponse) {
      contentBlocks.push({
        type: "tool_result",
        tool_use_id: part.functionResponse.id ?? "",
        content: JSON.stringify(part.functionResponse.response ?? {}),
      });
    }
  }

  if (contentBlocks.length === 0) return null;

  // Map ADK role to Anthropic role
  const role = content.role === "model" ? "assistant" : "user";

  return {
    role,
    content: contentBlocks,
  };
}

/**
 * Converts ADK tool declarations to Anthropic format.
 */
function convertTools(req: LlmRequest): Anthropic.Tool[] | undefined {
  const adkTools = req.config?.tools;
  if (!adkTools?.length) return undefined;

  const tools: Anthropic.Tool[] = [];

  for (const group of adkTools) {
    if (
      "functionDeclarations" in group &&
      Array.isArray(group.functionDeclarations)
    ) {
      for (const fn of group.functionDeclarations) {
        tools.push({
          name: fn.name ?? "",
          description: fn.description ?? "",
          input_schema: normalizeSchema(fn.parameters) ?? {
            type: "object",
            properties: {},
          },
        });
      }
    }
  }

  return tools.length ? tools : undefined;
}

/**
 * Normalizes Gemini-style schema to Anthropic-style schema.
 *
 * Converts UPPERCASE type names to lowercase.
 */
function normalizeSchema(
  schema: unknown,
): Anthropic.Tool.InputSchema | undefined {
  if (!schema || typeof schema !== "object") return undefined;

  const result: Record<string, unknown> = {};
  const input = schema as Record<string, unknown>;

  for (const [key, value] of Object.entries(input)) {
    if (key === "type" && typeof value === "string") {
      result[key] = value.toLowerCase();
    } else if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      result[key] = normalizeSchema(value);
    } else if (Array.isArray(value)) {
      result[key] = value;
    } else {
      result[key] = value;
    }
  }

  return result as Anthropic.Tool.InputSchema;
}
