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

import type Anthropic from "@anthropic-ai/sdk";
import type { LlmRequest } from "@google/adk";
import {
  type Content,
  FunctionCallingConfigMode,
  type Part,
} from "@google/genai";
import { normalizeSchema as normalizeSharedSchema } from "../../../converters/schema.js";

/** Name of the synthetic tool used to emulate structured JSON output. */
export const JSON_OUTPUT_TOOL_NAME = "json_output";

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

  /**
   * Generation parameters mapped from `config` (temperature, top_p, top_k,
   * max_tokens, stop_sequences). Built from a strict allowlist.
   */
  params?: AnthropicGenerationParams;

  /**
   * Anthropic `tool_choice` mapped from `config.toolConfig.functionCallingConfig`
   * (or forced when structured output is requested). Only meaningful with tools.
   */
  toolChoice?: Anthropic.ToolChoice;
}

/**
 * Result of applying opt-in prompt caching to a converted request.
 *
 * The `system` field is widened to Anthropic's block-array form because
 * `cache_control` can only be attached to a content block, not to a bare
 * string.
 */
export interface CachedAnthropicPrefix {
  /**
   * System instruction as an array of text blocks, with `cache_control` on
   * the (single) block. Undefined when there is no system instruction.
   */
  system?: Anthropic.TextBlockParam[];

  /**
   * Tool definitions with `cache_control` on the last tool. Undefined when
   * there are no tools.
   */
  tools?: Anthropic.Tool[];
}

/** Anthropic ephemeral cache breakpoint. */
const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" } as const;

/**
 * Applies opt-in Anthropic prompt caching to a converted request's prefix.
 *
 * Marks the largely-static prefix (system instruction + tool schemas) as
 * cacheable by attaching `cache_control: { type: "ephemeral" }` to the system
 * block and to the last tool definition. The system string is widened to a
 * single-element text block array (Anthropic requires a block to carry
 * `cache_control`).
 *
 * This is a pure transform; the caller decides whether to invoke it based on
 * the bridge's `promptCaching` instance config. It never mutates its inputs.
 *
 * @param system - The converted system instruction string (if any)
 * @param tools - The converted tool definitions (if any)
 * @returns System blocks and tools carrying cache breakpoints
 */
export function applyAnthropicPromptCaching(
  system: string | undefined,
  tools: Anthropic.Tool[] | undefined,
): CachedAnthropicPrefix {
  const result: CachedAnthropicPrefix = {};

  if (system) {
    result.system = [
      { type: "text", text: system, cache_control: EPHEMERAL_CACHE_CONTROL },
    ];
  }

  if (tools?.length) {
    const last = tools.length - 1;
    result.tools = tools.map((tool, i) =>
      i === last ? { ...tool, cache_control: EPHEMERAL_CACHE_CONTROL } : tool,
    );
  }

  return result;
}

/** Minimum thinking budget Anthropic accepts (must be >= 1024). */
const MIN_THINKING_BUDGET = 1024;

/** Default thinking budget when thinkingConfig is set without a budget. */
const DEFAULT_THINKING_BUDGET = 1024;

/**
 * Anthropic generation params built from ADK config (strict allowlist).
 */
export interface AnthropicGenerationParams {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
  stop_sequences?: string[];
  thinking?: Anthropic.ThinkingConfigEnabled;
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
      content: "[System: Continue conversation]",
    });
  }

  let tools = convertTools(llmRequest);
  let toolChoice = convertAnthropicToolChoice(llmRequest);

  // Structured output: inject a forced single output tool. It takes precedence
  // over an explicit tool_choice EXCEPT when the caller set mode=NONE
  // (tool_choice none) — forcing the json_output tool there would contradict an
  // explicit "do not call tools" instruction and 400. Respect NONE.
  const structured = convertAnthropicStructuredOutput(llmRequest);
  if (structured && toolChoice?.type !== "none") {
    tools = [...(tools ?? []), structured.tool];
    toolChoice = structured.toolChoice;
  }

  return {
    messages,
    system: system || undefined,
    tools,
    params: convertAnthropicGenerationConfig(llmRequest),
    toolChoice,
  };
}

/**
 * Maps ADK generation config to Anthropic message params (strict allowlist).
 *
 * Anthropic's temperature range is 0..1 (vs OpenAI's 0..2), so values >1 are
 * clamped. `seed`, penalties, and `candidateCount` have no Anthropic
 * equivalent and are dropped cleanly.
 *
 * @param req - The LLM request
 * @returns Anthropic generation params, or undefined when no fields are set
 */
export function convertAnthropicGenerationConfig(
  req: LlmRequest,
): AnthropicGenerationParams | undefined {
  const config = req.config;
  if (!config) return undefined;

  const params: AnthropicGenerationParams = {};

  if (config.temperature !== undefined) {
    params.temperature = Math.min(config.temperature, 1);
  }
  if (config.topP !== undefined) params.top_p = config.topP;
  if (config.topK !== undefined) params.top_k = config.topK;
  // Anthropic rejects max_tokens < 1 (400). Treat a non-positive
  // maxOutputTokens as unset so buildRequestParams falls back to the
  // clamped instance default (this.maxTokens) via `max_tokens ?? this.maxTokens`.
  if (config.maxOutputTokens !== undefined && config.maxOutputTokens >= 1)
    params.max_tokens = config.maxOutputTokens;
  if (config.stopSequences !== undefined)
    params.stop_sequences = config.stopSequences;

  // Extended thinking: only emitted when ADK thinkingConfig is present, so
  // non-reasoning requests are unaffected. Anthropic requires a budget >= 1024.
  if (config.thinkingConfig) {
    const budget = config.thinkingConfig.thinkingBudget;
    // An explicit budget <= 0 disables thinking (matches the OpenAI reasoning
    // path). Don't enable extended thinking with a default budget in that case.
    if (budget === undefined || budget > 0) {
      params.thinking = {
        type: "enabled",
        budget_tokens:
          budget !== undefined && budget >= MIN_THINKING_BUDGET
            ? budget
            : DEFAULT_THINKING_BUDGET,
      };
    }
  }

  reconcileAnthropicSamplingParams(params);

  return Object.keys(params).length ? params : undefined;
}

/**
 * Reconciles Anthropic sampling-parameter combinations the API rejects.
 *
 * Anthropic enforces two mutually-exclusive constraints that 332 shape-only
 * unit tests don't catch because each field is valid in isolation:
 *
 * 1. **thinking + sampling → 400.** When extended thinking is enabled,
 *    Anthropic forbids `top_p`, `top_k`, and any `temperature` other than 1.
 *    We drop `top_p`/`top_k` and omit a `temperature !== 1` (Anthropic uses
 *    temperature 1 internally with thinking).
 * 2. **temperature + top_p → 400 (Claude 4.5).** The API rejects sending both;
 *    we prefer `temperature` and drop `top_p` when both are present.
 *
 * Mutates `params` in place. Applied after all fields are populated so the
 * thinking constraint (which subsumes the temp/top_p one) takes precedence.
 *
 * @internal
 */
function reconcileAnthropicSamplingParams(
  params: AnthropicGenerationParams,
): void {
  if (params.thinking?.type === "enabled") {
    // Thinking forbids top_p/top_k and a non-1 temperature.
    params.top_p = undefined;
    params.top_k = undefined;
    if (params.temperature !== undefined && params.temperature !== 1) {
      params.temperature = undefined;
    }
    // Strip the keys so the emitted body never carries undefined values.
    if (params.top_p === undefined) delete params.top_p;
    if (params.top_k === undefined) delete params.top_k;
    if (params.temperature === undefined) delete params.temperature;
    return;
  }

  // Outside thinking: never send temperature and top_p together. Prefer
  // temperature (Anthropic's recommended primary control) and drop top_p.
  if (params.temperature !== undefined && params.top_p !== undefined) {
    delete params.top_p;
  }
}

/**
 * Maps ADK `functionCallingConfig` to an Anthropic `tool_choice`.
 *
 * - AUTO -> { type: "auto" }
 * - NONE -> { type: "none" }
 * - ANY / VALIDATED -> { type: "any" } (or { type: "tool", name } for a single
 *   allowedFunctionName)
 *
 * @param req - The LLM request
 * @returns The Anthropic tool_choice, or undefined when no toolConfig is present
 */
export function convertAnthropicToolChoice(
  req: LlmRequest,
): Anthropic.ToolChoice | undefined {
  const fcc = req.config?.toolConfig?.functionCallingConfig;
  if (!fcc) return undefined;

  switch (fcc.mode) {
    case FunctionCallingConfigMode.AUTO:
      return { type: "auto" };
    case FunctionCallingConfigMode.NONE:
      return { type: "none" };
    case FunctionCallingConfigMode.ANY:
    case FunctionCallingConfigMode.VALIDATED: {
      const allowed = fcc.allowedFunctionNames;
      if (allowed?.length === 1) {
        return { type: "tool", name: allowed[0] };
      }
      return { type: "any" };
    }
    default:
      return undefined;
  }
}

/**
 * Emulates structured JSON output on Anthropic via a forced output tool.
 *
 * When `responseSchema`/`responseJsonSchema` is set, a synthetic
 * `json_output` tool carrying the (normalized) schema is injected and forced
 * via `tool_choice: { type: "tool", name }`. The model's tool_use input is the
 * JSON object — surfaced downstream as a functionCall part by the response
 * converter (acceptable: ADK reads the forced tool args).
 *
 * @param req - The LLM request
 * @returns The injected tool + forced tool_choice, or undefined when N/A
 */
export function convertAnthropicStructuredOutput(
  req: LlmRequest,
): { tool: Anthropic.Tool; toolChoice: Anthropic.ToolChoice } | undefined {
  const config = req.config;
  if (!config) return undefined;

  let schema: Anthropic.Tool.InputSchema | undefined;
  if (config.responseJsonSchema) {
    schema = config.responseJsonSchema as Anthropic.Tool.InputSchema;
  } else if (config.responseSchema) {
    schema = normalizeSharedSchema(config.responseSchema) as
      | Anthropic.Tool.InputSchema
      | undefined;
  }

  if (!schema) return undefined;

  return {
    tool: {
      name: JSON_OUTPUT_TOOL_NAME,
      description: "Return the response as a structured JSON object.",
      input_schema: schema,
    },
    toolChoice: { type: "tool", name: JSON_OUTPUT_TOOL_NAME },
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
    // Extended-thinking round-trip: parts captured from a prior assistant turn
    // carry { thought: true, thoughtSignature }. They MUST be replayed as
    // Anthropic thinking/redacted_thinking content blocks (carrying the
    // signature) — re-sending them as plain text drops the signature and
    // breaks multi-turn tool+thinking requests with a 400. Handled before the
    // plain-text branch so a thought part never falls through to `type: text`.
    if (part.thought) {
      const block = thoughtPartToAnthropicBlock(part);
      if (block) contentBlocks.push(block);
      continue;
    }

    if (part.text) {
      contentBlocks.push({ type: "text", text: part.text });
    }

    const media = partToAnthropicMedia(part);
    if (media) contentBlocks.push(media);

    if (part.functionCall) {
      if (!part.functionCall.id) {
        console.warn(
          "[adk-llm-bridge] functionCall missing id, using generated ID",
        );
      }
      if (!part.functionCall.name) {
        console.warn("[adk-llm-bridge] functionCall missing name");
      }
      contentBlocks.push({
        type: "tool_use",
        id: part.functionCall.id ?? crypto.randomUUID(),
        name: part.functionCall.name ?? "",
        input: part.functionCall.args ?? {},
      });
    }

    if (part.functionResponse) {
      if (!part.functionResponse.id) {
        console.warn(
          "[adk-llm-bridge] functionResponse missing id, using generated ID",
        );
      }
      contentBlocks.push({
        type: "tool_result",
        tool_use_id: part.functionResponse.id ?? crypto.randomUUID(),
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
 * Re-emits an ADK thought Part as an Anthropic thinking content block.
 *
 * The response converter captures Anthropic thinking blocks as ADK parts:
 * - `thinking` block  -> { text, thought: true, thoughtSignature: signature }
 * - `redacted_thinking` block -> { thought: true, thoughtSignature: data } (no text)
 *
 * On the request side we reverse that so the assistant turn replays the SIGNED
 * thinking block Anthropic requires for multi-turn tool+thinking continuations.
 * A thought part WITH text maps back to a `thinking` block (signature carried on
 * `signature`); a thought part WITHOUT text maps back to a `redacted_thinking`
 * block (the opaque encrypted payload carried on `data`).
 *
 * A thought part with neither text nor signature carries nothing replayable and
 * is dropped (returns undefined) rather than emitted as an empty block.
 *
 * @internal
 */
function thoughtPartToAnthropicBlock(
  part: Part,
): Anthropic.ContentBlockParam | undefined {
  const signature = part.thoughtSignature;

  if (part.text) {
    // Visible thinking: replay as a signed thinking block. Anthropic requires a
    // signature on a thinking block; without one there is nothing to replay.
    if (!signature) return undefined;
    return { type: "thinking", thinking: part.text, signature };
  }

  // No text: this came from a redacted_thinking block (opaque encrypted data
  // stored on thoughtSignature). Replay it as redacted_thinking.
  if (signature) {
    return { type: "redacted_thinking", data: signature };
  }

  return undefined;
}

/** Anthropic image media types supported for base64 source blocks. */
const ANTHROPIC_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/**
 * Maps an ADK Part with image/document media to an Anthropic content block.
 *
 * - `inlineData` image/* (base64) -> image block (base64 source)
 * - `inlineData` application/pdf -> document block (base64 source)
 * - `fileData` http(s) image -> image block (url source)
 * - `fileData` http(s) pdf -> document block (url source)
 *
 * gs:// and unsupported media are dropped (with a warning). Returns undefined
 * when the part carries no usable media.
 *
 * @internal
 */
function partToAnthropicMedia(
  part: Part,
): Anthropic.ContentBlockParam | undefined {
  const inline = part.inlineData;
  if (inline?.data && inline.mimeType) {
    if (ANTHROPIC_IMAGE_MEDIA_TYPES.has(inline.mimeType)) {
      return {
        type: "image",
        source: {
          type: "base64",
          media_type:
            inline.mimeType as Anthropic.Base64ImageSource["media_type"],
          data: inline.data,
        },
      };
    }
    if (inline.mimeType === "application/pdf") {
      return {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: inline.data,
        },
      };
    }
    console.warn(
      `[adk-llm-bridge] dropping unsupported inlineData mime type: ${inline.mimeType}`,
    );
    return undefined;
  }

  const file = part.fileData;
  if (file?.fileUri) {
    const isHttp =
      file.fileUri.startsWith("http://") || file.fileUri.startsWith("https://");
    if (!isHttp) {
      console.warn(
        `[adk-llm-bridge] dropping non-http fileData URI: ${file.fileUri}`,
      );
      return undefined;
    }
    if (file.mimeType === "application/pdf") {
      return {
        type: "document",
        source: { type: "url", url: file.fileUri },
      };
    }
    if (!file.mimeType || file.mimeType.startsWith("image/")) {
      return { type: "image", source: { type: "url", url: file.fileUri } };
    }
    console.warn(
      `[adk-llm-bridge] dropping unsupported fileData mime type: ${file.mimeType}`,
    );
  }

  return undefined;
}

/**
 * Gemini-only built-in tool group keys.
 *
 * These are server-side tools (grounding, code execution, retrieval, etc.) that
 * only Gemini/Vertex executes. Anthropic has no equivalent, so they are skipped
 * cleanly (never forwarded) and the user is warned once per request that the
 * named built-in(s) won't run.
 *
 * @internal
 */
const GEMINI_ONLY_TOOL_KEYS = [
  "googleSearch",
  "googleSearchRetrieval",
  "codeExecution",
  "urlContext",
  "retrieval",
  "googleMaps",
  "enterpriseWebSearch",
  "computerUse",
  "fileSearch",
  "parallelAiSearch",
  "mcpServers",
] as const;

/**
 * Collects the names of Gemini-only built-in tools present in a tool group.
 *
 * @internal
 */
function collectGeminiOnlyToolNames(group: Record<string, unknown>): string[] {
  return GEMINI_ONLY_TOOL_KEYS.filter(
    (key) => group[key] !== undefined && group[key] !== null,
  );
}

/**
 * Converts ADK tool declarations to Anthropic format.
 *
 * Only `functionDeclarations` are forwarded. Gemini-only built-in tool groups
 * (googleSearch, codeExecution, urlContext, retrieval, googleMaps, etc.) are
 * skipped without crashing; if any are present a SINGLE warning is emitted
 * naming the dropped built-in tool(s).
 */
function convertTools(req: LlmRequest): Anthropic.Tool[] | undefined {
  const adkTools = req.config?.tools;
  if (!adkTools?.length) return undefined;

  const tools: Anthropic.Tool[] = [];
  const droppedBuiltins = new Set<string>();

  for (const group of adkTools) {
    if (
      "functionDeclarations" in group &&
      Array.isArray(group.functionDeclarations)
    ) {
      for (const fn of group.functionDeclarations) {
        if (!fn.name) {
          console.warn("[adk-llm-bridge] Tool function missing name, skipping");
          continue;
        }
        tools.push({
          name: fn.name,
          description: fn.description ?? "",
          input_schema: (normalizeSharedSchema(fn.parameters) as
            | Anthropic.Tool.InputSchema
            | undefined) ?? {
            type: "object",
            properties: {},
          },
        });
      }
    }

    // Skip (and record) any Gemini-only built-in tools on this group.
    for (const name of collectGeminiOnlyToolNames(
      group as Record<string, unknown>,
    )) {
      droppedBuiltins.add(name);
    }
  }

  if (droppedBuiltins.size > 0) {
    console.warn(
      `[adk-llm-bridge] dropping Gemini-only built-in tool(s) not supported on this provider: ${[
        ...droppedBuiltins,
      ].join(", ")}`,
    );
  }

  return tools.length ? tools : undefined;
}
