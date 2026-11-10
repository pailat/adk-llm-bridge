/**
 * Request converter for ADK to OpenAI format.
 *
 * This module handles the conversion of ADK LlmRequest objects to
 * OpenAI-compatible chat completion request format.
 */

import type { LlmRequest } from "@google/adk";
import {
  type Content,
  FunctionCallingConfigMode,
  type Part,
} from "@google/genai";
import type OpenAI from "openai";
import type { ReasoningCapability } from "../core/provider-definition.js";
import { LogCode, WarningScope, warn } from "../utils/log.js";
import { uriScheme } from "../utils/uri.js";
import { normalizeSchema } from "./schema.js";
import { ToolCallIdCorrelator } from "./tool-call-ids.js";
import {
  extractSystemInstruction,
  normalizeJsonSchemaValue,
  readToolDeclarations,
  serializeToolResponse,
} from "./tool-declarations.js";

/**
 * Provider-aware options forwarded into {@link convertRequest}.
 *
 * Carries the declarative {@link ReasoningCapability} so the request converter
 * can choose between the strict `reasoning_effort` path (OpenAI/xAI) and the
 * permissive native `reasoning` object path (OpenRouter/AI Gateway).
 */
export interface ConvertRequestOptions {
  /** Reasoning capability from the provider definition (undefined = strict). */
  reasoning?: ReasoningCapability;
  /**
   * Output-limit parameter for models the name rules do not mark as reasoning
   * models. Reasoning models always get `max_completion_tokens`.
   *
   * @defaultValue `"max_tokens"`
   */
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
}

/**
 * Extracts the bare model name from a possibly provider-prefixed id.
 *
 * OpenAI-compatible providers accept ids like `gpt-6.1-sol`,
 * `openai/gpt-6.1-sol`, `o3-mini`, or `x-ai/grok-4.7`. For feature gating we only care about the final
 * segment (the actual model name), lowercased for case-insensitive matching.
 * An OpenAI fine-tune id (`ft:<base>:<org>:<suffix>:<id>`) yields its base
 * model, so `ft:o4-mini-2025-04-16:org::abc` gives `o4-mini-2025-04-16`.
 *
 * @internal
 */
function bareModelName(model: string | undefined): string {
  if (!model) return "";
  const slash = model.lastIndexOf("/");
  let name = (slash >= 0 ? model.slice(slash + 1) : model).toLowerCase();
  if (name.startsWith("ft:")) {
    const end = name.indexOf(":", 3);
    name = end >= 0 ? name.slice(3, end) : name.slice(3);
  }
  return name;
}

/**
 * Detects OpenAI reasoning models, which reject `max_tokens` and sampling
 * controls and require `max_completion_tokens`.
 *
 * Matches by family and version, so new releases need no code change:
 * `gpt-<N>` with N of 5 or more (`gpt-5`, `gpt-5.1-codex`, `gpt-6.1-sol`,
 * `gpt-7`, ...) and the o-series `o<N>` (`o1`, `o3-mini`, `o4-mini`, ...).
 * `gpt-4o` and other `gpt-4*` / `gpt-3.5*` chat models do not match. The
 * provider prefix (`openai/`), an `ft:` fine-tune id and case are ignored.
 *
 * @internal
 */
export function usesMaxCompletionTokens(model: string | undefined): boolean {
  const name = bareModelName(model);
  if (!name) return false;
  const gpt = /^gpt-(\d+)/.exec(name);
  if (gpt) return Number(gpt[1]) >= 5;
  return /^o\d+(?:-|$)/.test(name);
}

/**
 * Detects models that accept the `reasoning_effort` parameter.
 *
 * Sending `reasoning_effort` to a plain chat model (gpt-4.1, gpt-4o, grok-4)
 * returns a 400 on the direct APIs, so this returns false when in doubt.
 * Covers:
 * - every OpenAI reasoning model ({@link usesMaxCompletionTokens});
 * - xAI `grok-3-mini*` and the explicit `*-reasoning` Grok variants, but not
 *   `*-non-reasoning`. Other Grok 4.x models reason on their own and showed
 *   no response to `reasoning_effort`, so they do not get it.
 *
 * @internal
 */
export function supportsReasoningEffort(model: string | undefined): boolean {
  const name = bareModelName(model);
  if (!name) return false;
  if (usesMaxCompletionTokens(name)) return true;
  if (!name.startsWith("grok-")) return false;
  if (name.includes("non-reasoning")) return false;
  return name.startsWith("grok-3-mini") || name.includes("reasoning");
}

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

  /**
   * Generation + structured-output parameters mapped from `config`.
   *
   * Built from a strict allowlist (temperature, top_p, max_tokens, etc. plus
   * response_format). Spread directly into the chat completion request body.
   */
  params?: Record<string, unknown>;

  /**
   * OpenAI `tool_choice` mapped from `config.toolConfig.functionCallingConfig`.
   *
   * Only meaningful when tools are present.
   */
  toolChoice?: OpenAI.ChatCompletionToolChoiceOption;
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
export function convertRequest(
  llmRequest: LlmRequest,
  model?: string,
  opts?: ConvertRequestOptions,
): ConvertedRequest {
  const messages: OpenAI.ChatCompletionMessageParam[] = [];
  const toolCallIdCorrelation = new ToolCallIdCorrelator();
  // One scope per request: a long history logs each repeated condition once.
  const warnings = new WarningScope();

  const systemContent = extractSystemInstruction(llmRequest);
  if (systemContent) {
    messages.push({ role: "system", content: systemContent });
  }

  for (const content of llmRequest.contents ?? []) {
    processContent(
      content,
      messages,
      toolCallIdCorrelation,
      warnings,
      opts?.reasoning,
    );
  }

  const tools = convertTools(llmRequest, warnings);

  // Prefer the caller-supplied model (the LLM instance's resolved model id),
  // falling back to the request's model field. Used for provider feature gating
  // (max_completion_tokens vs max_tokens, reasoning_effort eligibility).
  const resolvedModel = model ?? llmRequest.model;

  const params: Record<string, unknown> = {
    ...convertGenerationConfig(llmRequest, resolvedModel, opts),
    ...convertStructuredOutput(llmRequest),
    ...convertReasoningConfig(llmRequest, resolvedModel, opts),
    ...convertLogprobsConfig(llmRequest, resolvedModel),
  };

  return {
    messages,
    tools,
    params: Object.keys(params).length ? params : undefined,
    toolChoice: convertToolChoice(llmRequest),
  };
}

/**
 * Maps ADK generation config to OpenAI chat completion params.
 *
 * Uses a STRICT allowlist — the ADK `config` is never blind-spread, so
 * Gemini-only knobs (safetySettings, responseModalities, etc.) cannot leak
 * into the OpenAI request body. `topK` is intentionally dropped (no OpenAI
 * Chat Completions equivalent).
 *
 * @param req - The LLM request
 * @returns An OpenAI params object, or `{}` when no fields are set
 */
export function convertGenerationConfig(
  req: LlmRequest,
  model?: string,
  opts?: ConvertRequestOptions,
): Record<string, unknown> {
  const config = req.config;
  if (!config) return {};

  assertSupportedCandidateCount(config.candidateCount);

  const resolvedModel = model ?? req.model;
  const reasoningModel = usesMaxCompletionTokens(resolvedModel);

  const params: Record<string, unknown> = {};

  // OpenAI reasoning models (gpt-5 and later, o-series) reject sampling controls
  // ENTIRELY: temperature and top_p both return a 400 ("Unsupported value")
  // even when set to their defaults. They only accept reasoning_effort/verbosity
  // for steering. Drop temperature/top_p for reasoning models; keep them for
  // every other provider/model (xAI, OpenRouter, plain OpenAI chat).
  if (config.temperature !== undefined && !reasoningModel)
    params.temperature = config.temperature;
  if (config.topP !== undefined && !reasoningModel) params.top_p = config.topP;
  if (config.maxOutputTokens !== undefined) {
    // OpenAI reasoning models reject max_tokens with a 400 and require
    // max_completion_tokens (which also covers reasoning tokens). A provider
    // can make max_completion_tokens its default (OpenAI: max_tokens is
    // deprecated there); everything else uses max_tokens.
    if (reasoningModel || opts?.maxTokensParam === "max_completion_tokens") {
      params.max_completion_tokens = config.maxOutputTokens;
    } else {
      params.max_tokens = config.maxOutputTokens;
    }
  }
  // Reasoning models reject sampling knobs like stop/penalties (and often
  // temperature/top_p), but at minimum stop + the penalties trigger 400s. Keep
  // them off reasoning models; emit them for everything else.
  if (config.stopSequences !== undefined && !reasoningModel)
    params.stop = config.stopSequences;
  if (config.seed !== undefined) params.seed = config.seed;
  if (config.presencePenalty !== undefined && !reasoningModel)
    params.presence_penalty = config.presencePenalty;
  if (config.frequencyPenalty !== undefined && !reasoningModel)
    params.frequency_penalty = config.frequencyPenalty;
  // topK intentionally dropped — no OpenAI Chat Completions equivalent.
  // Reasoning is handled separately in convertReasoningConfig.

  return params;
}

/**
 * Rejects unsupported ADK response-candidate counts.
 *
 * The bridge produces one ADK `LlmResponse` for each provider response, so it
 * cannot faithfully represent multiple Chat Completions choices from a single
 * response. The shared request converter runs before both streaming and
 * non-streaming provider calls; rejecting here prevents providers from
 * generating paid choices that the bridge would discard. A `candidateCount`
 * of `1` remains supported and is omitted because Chat Completions defaults to
 * one choice.
 *
 * @param candidateCount - Requested number of ADK response candidates
 * @throws {@link Error} When a provided value is anything other than integer `1`
 * @internal
 */
function assertSupportedCandidateCount(candidateCount: unknown): void {
  if (candidateCount === undefined) return;

  if (
    typeof candidateCount !== "number" ||
    !Number.isInteger(candidateCount) ||
    candidateCount !== 1
  ) {
    throw new Error(
      "candidateCount must be exactly 1 when provided: adk-llm-bridge returns one ADK LlmResponse per provider response and cannot represent multiple Chat Completions choices. Set candidateCount to 1 or omit it.",
    );
  }
}

/**
 * Buckets an ADK `thinkingBudget` into a coarse `reasoning_effort` level.
 *
 * - no budget set → "medium" (sensible default)
 * - `0 < budget ≤ 2048` → "low"
 * - `2048 < budget ≤ 8192` → "medium"
 * - `budget > 8192` → "high"
 *
 * Callers handle the budget ≤ 0 ("disable") case before calling this.
 *
 * @internal
 */
function budgetToEffort(
  budget: number | null | undefined,
): "low" | "medium" | "high" {
  if (budget === undefined || budget === null) return "medium";
  if (budget <= 2048) return "low";
  if (budget <= 8192) return "medium";
  return "high";
}

/**
 * Decides which depth lever a budget should steer for an OpenRouter-routed
 * model: the coarse `reasoning.effort` bucket vs the token-precise
 * `reasoning.max_tokens`.
 *
 * OpenRouter rejects sending BOTH `reasoning.effort` and `reasoning.max_tokens`
 * in one request ("Only one of 'reasoning.effort' and 'reasoning.max_tokens'
 * can be specified"), so a single ADK `thinkingBudget` must be mapped to exactly
 * one of them — and the choice must match the lever the target model family
 * actually honors:
 *
 * - **effort-family**: OpenAI reasoning models (gpt-5 and later, o-series) and xAI Grok
 *   reasoners IGNORE `max_tokens` through OpenRouter but respond cleanly to
 *   `effort` (verified: gpt-5-mini low→high ~10x reasoning tokens). Anthropic
 *   thinking is also routed via `effort` here (OpenRouter maps it to a thinking
 *   budget under the hood and `effort` gives monotonic control). These reuse the
 *   existing {@link supportsReasoningEffort} model-name gate.
 * - **everything else** (gemini thinking, glm/deepseek, and unknown/default
 *   reasoners): honor `max_tokens` cleanly (verified: gemini-2.5-flash
 *   256→16384 budget scales reasoning tokens monotonically), so a budget maps
 *   to `max_tokens`.
 *
 * @returns `"effort"` for effort-family models, otherwise `"max_tokens"`
 * @internal
 */
function openRouterBudgetLever(
  model: string | undefined,
): "effort" | "max_tokens" {
  return supportsReasoningEffort(model) ? "effort" : "max_tokens";
}

/**
 * Maps ADK `thinkingConfig` to a provider-appropriate reasoning param.
 *
 * Behavior is selected by the provider's declarative {@link ReasoningCapability}
 * (`opts.reasoning.style`); when absent the strict `"openai-effort"` path is
 * used.
 *
 * **`"openai-effort"` (strict — OpenAI, xAI, manual/custom):**
 * Emit `reasoning_effort` of "low" | "medium" | "high" ONLY when the resolved
 * model is reasoning-capable (the {@link supportsReasoningEffort} model-name
 * gate). gpt-4.1, gpt-4o, plain grok-4, etc. return a 400 on `reasoning_effort`,
 * so when a model is supplied and it is NOT reasoning-capable we drop it
 * entirely. When no model is supplied we keep the legacy emit behavior (used by
 * callers that gate elsewhere). The budget bucketing is described in
 * {@link budgetToEffort}.
 *
 * **`"openrouter"` (permissive — OpenRouter, AI Gateway):**
 * NO model-name gate (these providers return HTTP 200 and ignore reasoning on
 * non-reasoning models). Build the native OpenRouter `reasoning` object:
 * - `includeThoughts === false` → `{ exclude: true }` (reason but do not
 *   surface the thoughts) merged with the enable controls below.
 * - `thinkingBudget > 0` → a SINGLE depth lever chosen by
 *   {@link openRouterBudgetLever}: `{ effort: <bucket> }` for effort-family
 *   models (OpenAI/xAI/Anthropic reasoners, which ignore `max_tokens` via
 *   OpenRouter) or `{ max_tokens: budget }` for everything else (gemini and
 *   default reasoners). Only one may be sent — OpenRouter 400s if both are
 *   present.
 * - `thinkingBudget === 0` (explicit) → `{ enabled: false }` (leave reasoning
 *   off).
 * - `thinkingBudget` unset (but `thinkingConfig` present) → `{ effort: "medium" }`
 *   (sensible enable default; no `max_tokens`).
 *
 * @param req - The LLM request
 * @param model - The resolved model id (for reasoning-capability gating)
 * @param opts - Provider-aware options carrying the reasoning capability
 * @returns A params object with `reasoning_effort` or a native `reasoning`
 *   object, or `{}` when not applicable
 */
export function convertReasoningConfig(
  req: LlmRequest,
  model?: string,
  opts?: ConvertRequestOptions,
): Record<string, unknown> {
  const thinking = req.config?.thinkingConfig;
  if (!thinking) return {};

  if (opts?.reasoning?.style === "openrouter") {
    return convertOpenRouterReasoning(thinking, model ?? req.model);
  }

  // Strict "openai-effort" path (default). When a model is known, only emit
  // reasoning_effort for reasoning-capable models. If no model is supplied, fall
  // back to the request's model field; if that is also absent, emit (legacy).
  const resolvedModel = model ?? req.model;
  if (resolvedModel && !supportsReasoningEffort(resolvedModel)) return {};

  const budget = thinking.thinkingBudget;

  // An explicit budget of 0 disables thinking — emit nothing so the model is
  // left at its own default behavior rather than forced to reason.
  if (budget !== undefined && budget !== null && budget <= 0) return {};

  return { reasoning_effort: budgetToEffort(budget) };
}

/**
 * Builds the native OpenRouter `reasoning` object from ADK `thinkingConfig`.
 *
 * See {@link convertReasoningConfig} for the mapping rules. Returns `{}` only
 * when there is nothing meaningful to send.
 *
 * @param thinking - The ADK thinkingConfig
 * @param model - The resolved model id (selects the depth lever for a budget;
 *   see {@link openRouterBudgetLever})
 * @internal
 */
function convertOpenRouterReasoning(
  thinking: NonNullable<NonNullable<LlmRequest["config"]>["thinkingConfig"]>,
  model: string | undefined,
): Record<string, unknown> {
  const budget = thinking.thinkingBudget;
  const reasoning: Record<string, unknown> = {};

  if (budget !== undefined && budget !== null && budget <= 0) {
    // Explicit disable: turn reasoning off rather than forcing it on.
    reasoning.enabled = false;
  } else if (budget !== undefined && budget !== null) {
    // A budget is given. OpenRouter 400s if BOTH `max_tokens` and `effort` are
    // present ("Only one of 'reasoning.effort' and 'reasoning.max_tokens' can be
    // specified"), so route the budget to the SINGLE lever the target model
    // family actually honors (effort-family ignore max_tokens via OpenRouter).
    if (openRouterBudgetLever(model) === "effort") {
      reasoning.effort = budgetToEffort(budget);
    } else {
      reasoning.max_tokens = budget;
    }
  } else {
    // thinkingConfig present without a budget: enable with a sensible default.
    reasoning.effort = "medium";
  }

  // includeThoughts === false means "reason internally but don't surface the
  // thoughts". Map to exclude:true (still reasons; thoughts not returned).
  if (thinking.includeThoughts === false) {
    reasoning.exclude = true;
  }

  return Object.keys(reasoning).length ? { reasoning } : {};
}

/**
 * Maps ADK logprobs config to OpenAI-compatible `logprobs` / `top_logprobs`.
 *
 * ADK (`GenerateContentConfig` from `@google/genai`) expresses logprobs intent via:
 * - `responseLogprobs` (boolean) — request log probabilities of output tokens
 * - `logprobs` (number) — how many top alternatives to return per token
 *
 * OpenAI Chat Completions uses:
 * - `logprobs` (boolean) — return log probabilities of output tokens
 * - `top_logprobs` (integer 0-5) — top-N alternatives per token; requires
 *   `logprobs: true`
 *
 * Mapping rules (each field only emitted when set, never blind-spread):
 * - `responseLogprobs === true` → `logprobs: true`
 * - `logprobs` (number) → `top_logprobs: <n>`. Because OpenAI requires
 *   `logprobs: true` whenever `top_logprobs` is present, we also force
 *   `logprobs: true` so the count is never sent in isolation (which providers
 *   reject).
 *
 * CRITICAL: nothing is emitted unless one of these ADK fields is explicitly
 * set, so non-logprobs requests are completely unaffected.
 *
 * OpenAI reasoning models (gpt-5 and later, o-series) do NOT support logprobs at all —
 * sending `logprobs`/`top_logprobs` returns a 400. When the resolved model is a
 * reasoning model these fields are dropped (rather than risking the 400). They
 * are still emitted for every other model that requested them.
 *
 * @param req - The LLM request
 * @param model - The resolved model id (for reasoning-model gating)
 * @returns A params object with `logprobs`/`top_logprobs`, or `{}` when not set
 */
export function convertLogprobsConfig(
  req: LlmRequest,
  model?: string,
): Record<string, unknown> {
  const config = req.config;
  if (!config) return {};

  // Reasoning models reject logprobs/top_logprobs outright — drop them.
  const resolvedModel = model ?? req.model;
  if (usesMaxCompletionTokens(resolvedModel)) return {};

  const params: Record<string, unknown> = {};

  if (config.responseLogprobs === true) {
    params.logprobs = true;
  }
  if (config.logprobs !== undefined && config.logprobs !== null) {
    // OpenAI-compatible APIs accept top_logprobs only in the 0-20 range and
    // return a 400 outside it. Clamp so out-of-range ADK values still succeed.
    params.top_logprobs = Math.min(Math.max(config.logprobs, 0), 20);
    // top_logprobs requires logprobs:true on OpenAI-compatible APIs.
    params.logprobs = true;
  }

  return params;
}

/**
 * Maps ADK `functionCallingConfig` to an OpenAI `tool_choice`.
 *
 * - AUTO → "auto"
 * - NONE → "none"
 * - ANY / VALIDATED → "required" (or a specific function when exactly one
 *   allowedFunctionName is given)
 *
 * @param req - The LLM request
 * @returns The OpenAI tool_choice, or undefined when no toolConfig is present
 */
export function convertToolChoice(
  req: LlmRequest,
): OpenAI.ChatCompletionToolChoiceOption | undefined {
  const fcc = req.config?.toolConfig?.functionCallingConfig;
  if (!fcc) return undefined;

  switch (fcc.mode) {
    case FunctionCallingConfigMode.AUTO:
      return "auto";
    case FunctionCallingConfigMode.NONE:
      return "none";
    case FunctionCallingConfigMode.ANY:
    case FunctionCallingConfigMode.VALIDATED: {
      const allowed = fcc.allowedFunctionNames;
      if (allowed?.length === 1) {
        return { type: "function", function: { name: allowed[0] } };
      }
      return "required";
    }
    default:
      return undefined;
  }
}

/**
 * Maps ADK structured-output config to an OpenAI `response_format`.
 *
 * - `responseJsonSchema` → json_schema (already JSON Schema; only string
 *   int64 counts are converted to integers)
 * - `responseSchema` → json_schema (normalized from Gemini types)
 * - `responseMimeType === "application/json"` only → json_object
 *
 * `strict` is intentionally `false`. OpenAI strict mode imposes hard structural
 * requirements (every object must set `additionalProperties: false` and list
 * ALL properties in `required`) that Gemini-derived / arbitrary caller schemas
 * routinely violate, producing a 400. Lenient (`strict: false`) accepts partial
 * schemas, which is the lower-risk default for caller-supplied schemas.
 *
 * @param req - The LLM request
 * @returns A params object with `response_format`, or `{}` when not applicable
 */
export function convertStructuredOutput(
  req: LlmRequest,
): Record<string, unknown> {
  const config = req.config;
  if (!config) return {};

  if (config.responseJsonSchema) {
    const jsonSchema = config.responseJsonSchema;
    return {
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "response",
          strict: false,
          schema: normalizeJsonSchemaValue(jsonSchema),
        },
      },
    };
  }

  if (config.responseSchema) {
    return {
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "response",
          strict: false,
          schema: normalizeSchema(config.responseSchema) ?? {},
        },
      },
    };
  }

  if (config.responseMimeType === "application/json") {
    return { response_format: { type: "json_object" } };
  }

  return {};
}

/**
 * Parses an ADK thought part's `thoughtSignature` back into an OpenRouter
 * `reasoning_details` array.
 *
 * The response converter stores the entire `reasoning_details` array verbatim as
 * a JSON string on `thoughtSignature` (so the signed reasoning round-trips
 * byte-for-byte). Here we parse it back. Display-only thought parts (no parseable
 * array — e.g. glm/deepseek string reasoning) return undefined, in which case the
 * thought text is simply dropped from the assistant turn.
 *
 * @param signature - The thoughtSignature value (may be undefined)
 * @returns The parsed reasoning_details array, or undefined when not present/valid
 *
 * @internal
 */
function parseReasoningDetails(
  signature: string | undefined,
): unknown[] | undefined {
  if (!signature) return undefined;
  try {
    const parsed = JSON.parse(signature);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a `thoughtSignature` is a `reasoning_details` array produced by this
 * bridge: a non-empty JSON array of objects whose `type` starts with
 * `reasoning.` (`reasoning.text`, `reasoning.summary`, `reasoning.encrypted`).
 *
 * @internal
 */
function isReasoningDetailsSignature(signature: string | undefined): boolean {
  const parsed = parseReasoningDetails(signature);
  return (
    parsed !== undefined &&
    parsed.length > 0 &&
    parsed.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as { type?: unknown }).type === "string" &&
        (entry as { type: string }).type.startsWith("reasoning."),
    )
  );
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
  correlation: ToolCallIdCorrelator,
  warnings: WarningScope,
  reasoning?: ReasoningCapability,
): void {
  if (!content.parts?.length) return;

  const texts: string[] = [];
  const images: OpenAI.ChatCompletionContentPartImage[] = [];
  const calls: {
    id: string;
    name: string;
    arguments: string;
    generated: boolean;
  }[] = [];
  const responses: { id: string; content: string }[] = [];
  // reasoning_details arrays parsed from thought parts' thoughtSignature, to be
  // echoed verbatim on the assistant turn (openrouter style only).
  const reasoningDetails: unknown[] = [];

  for (const part of content.parts) {
    // Thought parts (captured from a prior assistant turn) must NEVER be folded
    // back into answer content — re-sending reasoning as plain text pollutes the
    // context and, for signature-strict upstreams, corrupts the round-trip.
    // Handled before the text branch so a thought part never falls through.
    //
    // ADK's planners (`BuiltInPlanner`, `PlanReActPlanner`) clear `thought` on
    // every history part before the request is built, but keep
    // `thoughtSignature`. Our own `reasoning_details` JSON in the signature is
    // an unambiguous marker (a Gemini signature is opaque base64 and never
    // parses to this shape), so such a part is still a thought part.
    if (
      part.thought ||
      (reasoning?.style === "openrouter" &&
        !part.functionCall &&
        !part.functionResponse &&
        isReasoningDetailsSignature(part.thoughtSignature))
    ) {
      if (reasoning?.style === "openrouter") {
        const parsed = parseReasoningDetails(part.thoughtSignature);
        if (parsed) reasoningDetails.push(...parsed);
      }
      continue;
    }
    if (part.text) texts.push(part.text);
    const image = partToOpenAIImage(part, warnings);
    if (image) images.push(image);
    if (part.functionCall) {
      if (!part.functionCall.id) {
        warn(
          LogCode.TOOL_CALL_MISSING_ID,
          "functionCall missing id, using generated ID",
        );
      }
      if (!part.functionCall.name) {
        warn(LogCode.TOOL_CALL_MISSING_NAME, "functionCall missing name");
      }
      calls.push({
        id: correlation.callId(part.functionCall.id),
        name: part.functionCall.name ?? "",
        arguments: JSON.stringify(part.functionCall.args ?? {}),
        generated: !part.functionCall.id,
      });
    }
    if (part.functionResponse) {
      if (!part.functionResponse.id) {
        warn(LogCode.TOOL_RESPONSE_MISSING_ID, "functionResponse missing id");
      }
      responses.push({
        id:
          content.role === "user"
            ? correlation.response(
                part.functionResponse.id,
                part.functionResponse.name,
              )
            : correlation.callId(part.functionResponse.id),
        content: serializeToolResponse(part.functionResponse.response),
      });
    }
  }

  if (content.role === "user") {
    if (images.length) {
      // Mixed multimodal content: text + image parts.
      const contentParts: OpenAI.ChatCompletionContentPart[] = [];
      for (const text of texts) {
        contentParts.push({ type: "text", text });
      }
      contentParts.push(...images);
      messages.push({ role: "user", content: contentParts });
    } else if (texts.length) {
      messages.push({ role: "user", content: texts.join("\n") });
    }
    for (const r of responses) {
      messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
    }
  } else if (content.role === "model") {
    if (images.length) {
      // OpenAI assistant messages cannot carry images; only user messages can.
      // Drop image parts on a model/assistant turn (keep text + tool_calls).
      warnings.warnOnce(
        LogCode.IMAGE_DROPPED_ON_MODEL_TURN,
        "dropping image part(s) on an assistant/model turn — " +
          "OpenAI assistant messages cannot carry images",
      );
    }
    if (texts.length || calls.length || reasoningDetails.length) {
      const msg: OpenAI.ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: texts.length ? texts.join("\n") : null,
      };
      if (calls.length) {
        for (const { id, name, generated } of calls) {
          correlation.track({ id, name, generated });
        }
        msg.tool_calls = calls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: c.arguments },
        }));
      }
      // Echo signed reasoning back verbatim so signature-strict upstreams
      // (Anthropic/Gemini thinking via OpenRouter) accept the continuation.
      // The OpenAI SDK type has no reasoning_details field; attach defensively.
      if (reasoningDetails.length) {
        (msg as unknown as Record<string, unknown>).reasoning_details =
          reasoningDetails;
      }
      messages.push(msg);
    }
  }
}

/**
 * Maps an ADK Part with image media to an OpenAI image content part.
 *
 * - `inlineData` (base64) → `data:` URL
 * - `fileData` → the http(s) URI (gs:// and other schemes are dropped)
 *
 * Non-image media (audio/video) is dropped with a single warning. Returns
 * undefined when the part carries no usable image.
 *
 * @internal
 */
function partToOpenAIImage(
  part: Part,
  warnings: WarningScope,
): OpenAI.ChatCompletionContentPartImage | undefined {
  const inline = part.inlineData;
  if (inline?.data && inline.mimeType) {
    if (!inline.mimeType.startsWith("image/")) {
      warnings.warnOnce(
        LogCode.MEDIA_MIME_UNSUPPORTED,
        `dropping unsupported inlineData mime type: ${inline.mimeType}`,
      );
      return undefined;
    }
    return {
      type: "image_url",
      image_url: { url: `data:${inline.mimeType};base64,${inline.data}` },
    };
  }

  const file = part.fileData;
  if (file?.fileUri) {
    const isImage = !file.mimeType || file.mimeType.startsWith("image/");
    if (
      file.fileUri.startsWith("http://") ||
      file.fileUri.startsWith("https://")
    ) {
      if (!isImage) {
        warnings.warnOnce(
          LogCode.MEDIA_MIME_UNSUPPORTED,
          `dropping unsupported fileData mime type: ${file.mimeType}`,
        );
        return undefined;
      }
      return { type: "image_url", image_url: { url: file.fileUri } };
    }
    // gs:// and other non-fetchable schemes are dropped cleanly.
    warnings.warnOnce(
      LogCode.MEDIA_URI_UNSUPPORTED,
      `dropping non-http fileData URI (scheme: ${uriScheme(file.fileUri)})`,
    );
  }

  return undefined;
}

/**
 * Converts ADK tool declarations to OpenAI format.
 *
 * Only `functionDeclarations` are forwarded. Gemini-only built-in tool groups
 * (googleSearch, codeExecution, urlContext, retrieval, googleMaps, etc.) are
 * skipped without crashing; if any are present a SINGLE warning is emitted
 * naming the dropped built-in tool(s) so users know grounding / code execution
 * will not run on a non-Gemini provider.
 *
 * @param req - The LLM request containing tool definitions
 * @returns Array of OpenAI tool objects, or undefined if no tools
 *
 * @internal
 */
function convertTools(
  req: LlmRequest,
  warnings: WarningScope,
): OpenAI.ChatCompletionTool[] | undefined {
  const tools: OpenAI.ChatCompletionTool[] = readToolDeclarations(
    req,
    warnings,
  ).map((declaration) => ({
    type: "function",
    function: declaration,
  }));
  return tools.length ? tools : undefined;
}
