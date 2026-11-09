/**
 * Tool call / tool response ID correlation shared by every request converter.
 *
 * ADK may hand a provider history whose `functionCall` / `functionResponse`
 * parts have no `id` (ADK strips its client-generated `adk-*` ids for every
 * non-Claude model) or an empty one. Providers require each tool result to
 * reference the call it answers, so a converter must (1) give every call an ID
 * and (2) hand the same ID to the response that answers it.
 *
 * Create one {@link ToolCallIdCorrelator} per converted request and route every
 * call and response through it, in history order.
 */

/** Pattern accepted for tool call IDs by Anthropic (and by OpenAI in practice). */
const PORTABLE_TOOL_CALL_ID = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Returns true when `id` matches `^[a-zA-Z0-9_-]{1,64}$`, the strictest ID
 * format used by the supported providers.
 */
export function isPortableToolCallId(id: string): boolean {
  return PORTABLE_TOOL_CALL_ID.test(id);
}

/** Generates a collision-safe ID accepted by OpenAI-compatible tool calls. */
export function generateToolCallId(): string {
  return `call_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** Options for {@link ToolCallIdCorrelator}. */
export interface ToolCallIdCorrelatorOptions {
  /**
   * Rewrites explicit IDs that do not match `^[a-zA-Z0-9_-]{1,64}$` into
   * generated ones (Anthropic rejects anything else). The mapping is stable for
   * the lifetime of the correlator, so a call and its response get the same
   * replacement. Default `false`: explicit IDs pass through untouched.
   */
  sanitize?: boolean;
}

interface PendingToolCall {
  id: string;
  name: string;
  generated: boolean;
}

/**
 * Correlates tool calls with the responses that answer them within one request.
 *
 * @example
 * ```typescript
 * const ids = new ToolCallIdCorrelator();
 * const callId = ids.callId(part.functionCall.id);
 * ids.track({ id: callId, name: part.functionCall.name ?? "", generated: !part.functionCall.id });
 * // ...later, for the user turn carrying the result:
 * const responseId = ids.response(part.functionResponse.id, part.functionResponse.name);
 * ```
 */
export class ToolCallIdCorrelator {
  private readonly pending: PendingToolCall[] = [];
  private readonly sanitized = new Map<string, string>();
  private readonly sanitize: boolean;

  constructor(options: ToolCallIdCorrelatorOptions = {}) {
    this.sanitize = options.sanitize ?? false;
  }

  /**
   * Resolves the ID to send for a call (or for any part that needs a plain ID):
   * the explicit ID (sanitized when enabled) or a generated one. An empty string
   * counts as missing. Does NOT queue the call; use {@link track} once the call
   * is actually emitted.
   */
  callId(id: string | undefined): string {
    return this.resolveExplicit(id) ?? generateToolCallId();
  }

  /**
   * Queues an emitted call so a later {@link response} without an ID can find
   * it. `generated` tells whether the ID was synthesized (no explicit ID).
   */
  track(call: { id: string; name: string; generated: boolean }): void {
    this.pending.push({ ...call });
  }

  /**
   * Resolves the ID to send for a tool response in a user turn.
   *
   * An explicit ID wins and is removed from the pending set. A missing ID is
   * matched by name (preferring a generated call, so parallel same-name calls
   * can answer out of order); an unmatched name gets a fresh ID and leaves the
   * pending calls untouched. Without a name the first generated (else first)
   * pending call is used.
   */
  response(id: string | undefined, name: string | undefined): string {
    if (id) {
      const resolved = this.resolveExplicit(id) as string;
      const index = this.pending.findIndex((call) => call.id === resolved);
      if (index >= 0) this.pending.splice(index, 1);
      return resolved;
    }

    let index: number;
    if (name) {
      index = this.pending.findIndex(
        (call) => call.name === name && call.generated,
      );
      if (index < 0) index = this.pending.findIndex((c) => c.name === name);
      if (index < 0) return generateToolCallId();
    } else {
      index = this.pending.findIndex((call) => call.generated);
      if (index < 0) index = 0;
    }
    return this.pending.splice(index, 1)[0]?.id ?? generateToolCallId();
  }

  private resolveExplicit(id: string | undefined): string | undefined {
    if (!id) return undefined;
    if (!this.sanitize || isPortableToolCallId(id)) return id;
    let replacement = this.sanitized.get(id);
    if (replacement === undefined) {
      replacement = generateToolCallId();
      this.sanitized.set(id, replacement);
    }
    return replacement;
  }
}
