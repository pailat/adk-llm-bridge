/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Namespaced `thoughtSignature` values for Anthropic thinking blocks.
 *
 * Anthropic requires the signed thinking block of a prior assistant turn to be
 * replayed on multi-turn tool + thinking requests. We carry the signature (or
 * the opaque `redacted_thinking` payload) on the ADK part's `thoughtSignature`.
 * ADK's `BuiltInPlanner` request processor strips `thought: true` from every
 * part of the history but keeps `thoughtSignature`, so the flag alone cannot
 * identify our parts. Gemini parts also carry `thoughtSignature` (on text and
 * function calls), and replaying one of those as a `thinking` block is a 400.
 *
 * The signatures we produce therefore carry a versioned prefix: a part that
 * has it is recognizably ours, with or without `thought: true`.
 *
 * @module providers/anthropic/converters/thinking-signature
 */

/** Prefix of every `thoughtSignature` produced by the Anthropic provider. */
export const THINKING_SIGNATURE_PREFIX = "adk-llm-bridge:anthropic:v1:";

/**
 * Prefix of signatures that belong to a `thinking` block whose text is empty
 * (for example when the API omits the reasoning text). The part is stored with
 * no `text` at all, because ADK drops any history event whose first part has
 * `text === ""` (`shouldIncludeEventInContext`), and this marker tells the
 * request converter to replay it as a `thinking` block with `thinking: ""`
 * rather than as `redacted_thinking`. Base64 payloads never contain `:`, so the
 * marker cannot collide with a real signature or redacted payload.
 */
export const EMPTY_THINKING_SIGNATURE_PREFIX = `${THINKING_SIGNATURE_PREFIX}empty:`;

/** Wraps an Anthropic signature (or redacted payload) in our namespace. */
export function encodeThinkingSignature(
  signature: string,
  options: { emptyThinking?: boolean } = {},
): string {
  return `${options.emptyThinking ? EMPTY_THINKING_SIGNATURE_PREFIX : THINKING_SIGNATURE_PREFIX}${signature}`;
}

/** A decoded Anthropic signature found on an ADK part. */
export interface ReadThinkingSignature {
  /** The raw Anthropic signature or redacted payload. */
  signature: string;
  /** True when the original `thinking` block had empty text. */
  emptyThinking: boolean;
}

/**
 * Reads a part's `thoughtSignature` as an Anthropic signature.
 *
 * - Namespaced value: returned without the prefix, whatever `thought` says.
 * - Legacy un-prefixed value (sessions stored before the namespace existed):
 *   accepted only when the part still has `thought: true`.
 * - Anything else (for example a Gemini signature on a text or function call
 *   part): `undefined`, so it is never replayed as a `thinking` block.
 */
export function readThinking(part: {
  thought?: boolean;
  thoughtSignature?: string;
}): ReadThinkingSignature | undefined {
  const value = part.thoughtSignature;
  if (!value) return undefined;
  if (value.startsWith(EMPTY_THINKING_SIGNATURE_PREFIX)) {
    const signature = value.slice(EMPTY_THINKING_SIGNATURE_PREFIX.length);
    return signature ? { signature, emptyThinking: true } : undefined;
  }
  if (value.startsWith(THINKING_SIGNATURE_PREFIX)) {
    const signature = value.slice(THINKING_SIGNATURE_PREFIX.length);
    return signature ? { signature, emptyThinking: false } : undefined;
  }
  return part.thought ? { signature: value, emptyThinking: false } : undefined;
}

/** Like {@link readThinking}, returning only the raw signature. */
export function readThinkingSignature(part: {
  thought?: boolean;
  thoughtSignature?: string;
}): string | undefined {
  return readThinking(part)?.signature;
}

/** True when the signature carries our namespace prefix. */
export function isNamespacedThinkingSignature(value: unknown): boolean {
  return (
    typeof value === "string" && value.startsWith(THINKING_SIGNATURE_PREFIX)
  );
}
