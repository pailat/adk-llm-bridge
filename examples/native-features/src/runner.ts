/**
 * AgentHarness — the Facade and the SINGLE ADK integration point.
 *
 * It is the only module that imports Runner / InMemorySessionService /
 * StreamingMode / runAsync. It wraps those primitives and reduces the raw
 * `Event` stream into a typed {@link RunResult}, classifying each part
 * (text / thought / functionCall / functionResponse), counting partials, and
 * capturing usageMetadata from the final non-partial event. Demos stay free of
 * ADK plumbing.
 */
import {
  type LlmAgent,
  Runner,
  InMemorySessionService,
  StreamingMode,
} from "@google/adk";
import type { Content, Part } from "@google/genai";
import type { Output } from "./output";
import type { RunResult, Usage } from "./types";

const APP_NAME = "native-features";

/** Build a user message Content from text plus optional extra parts. */
export function buildMessage(text: string, extraParts: Part[] = []): Content {
  return { role: "user", parts: [{ text }, ...extraParts] };
}

export interface RunOptions {
  /** Enable token-level streaming (RunConfig.streamingMode = SSE). */
  streaming?: boolean;
  /** Override the session user id (defaults to a per-run id). */
  userId?: string;
  /**
   * The agent's `outputKey`, if it uses `outputSchema`. Lets the harness read
   * the auto-parsed structured result out of `session.state` after the run.
   */
  outputKey?: string;
  /**
   * Bound on the total LLM calls for the run (RunConfig.maxLlmCalls).
   *
   * Needed for forced tool calling: `functionCallingConfig.mode = ANY` makes
   * EVERY turn emit a function call, so once a tool returns, the next turn is
   * forced to call a tool again — an unbounded loop. Setting this to 1 lets the
   * single forced call fire, then ADK stops the run by throwing the limit
   * error (which the harness treats as the expected stop signal).
   */
  maxLlmCalls?: number;
}

/** True when an error is ADK's expected "max llm calls" stop signal. */
function isLlmCallsLimitError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /max number of llm calls limit/i.test(error.message)
  );
}

/** True when `text` (trimmed) looks like a JSON object literal. */
function looksLikeJsonObject(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
}

export class AgentHarness {
  private readonly sessionService = new InMemorySessionService();

  constructor(private readonly out: Output) {}

  /**
   * Run `agent` once with `message` and return a reduced {@link RunResult}.
   * Each invocation uses its own fresh session so demos stay independent.
   */
  async run(
    agent: LlmAgent,
    message: Content,
    opts: RunOptions = {},
  ): Promise<RunResult> {
    const runner = new Runner({
      agent,
      appName: APP_NAME,
      sessionService: this.sessionService,
    });

    const userId = opts.userId ?? `user-${Date.now()}`;
    const session = await this.sessionService.getOrCreateSession({
      appName: APP_NAME,
      userId,
    });

    const result: RunResult = {
      finalText: "",
      thoughtText: "",
      toolCalls: [],
      partials: 0,
    };

    const events = runner.runAsync({
      userId,
      sessionId: session.id,
      newMessage: message,
      runConfig: {
        streamingMode: opts.streaming
          ? StreamingMode.SSE
          : StreamingMode.NONE,
        // Only set when provided; <= 0 / undefined means "unbounded".
        ...(opts.maxLlmCalls ? { maxLlmCalls: opts.maxLlmCalls } : {}),
      },
    });

    try {
      for await (const event of events) {
        const isPartial = Boolean(event.partial);
        if (isPartial) result.partials += 1;

        for (const part of event.content?.parts ?? []) {
          this.classifyPart(part, result, {
            streaming: Boolean(opts.streaming),
            isPartial,
          });
        }

        // usageMetadata is reported on the final, non-partial event.
        if (!isPartial && event.usageMetadata) {
          result.usage = pickUsage(event.usageMetadata);
        }
      }
    } catch (error) {
      // For forced-tool (mode: ANY) runs we deliberately cap maxLlmCalls; the
      // resulting limit error is the EXPECTED stop signal once the forced call
      // has been captured. Re-throw anything else.
      if (!(opts.maxLlmCalls && isLlmCallsLimitError(error))) throw error;
      result.stoppedByLlmCallLimit = true;
    }

    // Structured-output fallbacks for the JSON-text path:
    //  1) ADK's `outputKey` auto-parses the JSON answer into session.state.
    //  2) Otherwise, the final text may itself be a JSON object.
    if (result.structured === undefined) {
      const state = await this.readState(userId, session.id);
      if (opts.outputKey && state && opts.outputKey in state) {
        result.structured = state[opts.outputKey];
      } else if (looksLikeJsonObject(result.finalText)) {
        try {
          result.structured = JSON.parse(result.finalText.trim());
        } catch {
          /* leave undefined */
        }
      }
    }

    return result;
  }

  /** Read the (post-run) session state for outputKey-based structured output. */
  private async readState(
    userId: string,
    sessionId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const session = await this.sessionService.getSession({
      appName: APP_NAME,
      userId,
      sessionId,
    });
    return session?.state as Record<string, unknown> | undefined;
  }

  /**
   * Classify a single part and accumulate it into the result.
   *
   * Text accumulation must avoid double-counting in SSE mode: each partial
   * event carries an incremental delta, and the final NON-partial event carries
   * the full aggregated text. So when streaming we print partial deltas live but
   * accumulate `finalText` only from the final non-partial event; when NOT
   * streaming there are no partials, so we accumulate every text part.
   */
  private classifyPart(
    part: Part,
    result: RunResult,
    ctx: { streaming: boolean; isPartial: boolean },
  ): void {
    if (part.functionCall) {
      const name = part.functionCall.name ?? "(unnamed)";
      result.toolCalls.push({ name, args: part.functionCall.args });
      // ADK's `outputSchema` path (Anthropic native) emits the structured
      // result as a forced "json_output" tool call whose args ARE the object.
      if (name === "json_output") result.structured = part.functionCall.args;
      return;
    }
    if (part.functionResponse) {
      // Tool results flow back through the event stream; demos that care read
      // them via toolCalls + final text. Nothing to accumulate here.
      return;
    }
    if (typeof part.text !== "string") return;

    if (part.thought === true) {
      // Thought parts only arrive on non-partial events; accumulate directly.
      if (!ctx.isPartial) result.thoughtText += part.text;
      return;
    }

    if (ctx.streaming) {
      if (ctx.isPartial) {
        // Live delta: print it but don't accumulate (avoids double counting).
        this.out.stream(part.text);
      } else {
        // Final aggregated text for this turn — this is the source of truth.
        result.finalText += part.text;
      }
      return;
    }

    // Non-streaming: each event is final; accumulate.
    result.finalText += part.text;
  }
}

function pickUsage(meta: {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}): Usage {
  return {
    promptTokenCount: meta.promptTokenCount,
    candidatesTokenCount: meta.candidatesTokenCount,
    thoughtsTokenCount: meta.thoughtsTokenCount,
    totalTokenCount: meta.totalTokenCount,
  };
}
