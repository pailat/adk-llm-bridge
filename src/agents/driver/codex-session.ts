import type { Content } from "@google/genai";
import type { ExternalAgentEvent } from "../events.js";
import type { ExternalAgentRunRequest } from "../external-agent-driver.js";
import { safeCollectContents } from "../runtime/content-collector.js";
import {
  summarizeHistoryForColdStart,
  userContentToCodexInput,
} from "./codex-input-mapper.js";
import type {
  CodexSdkClientLike,
  CodexSdkInput,
  CodexSdkThreadLike,
  CodexSdkThreadOptions,
} from "./codex-sdk.js";
import {
  EXTERNAL_AGENT_OPTION_UNSUPPORTED,
  ExternalAgentPolicyError,
} from "./policy-errors.js";
import { contextText, stringValue } from "./shared.js";

/** The thread one turn runs on, its input, and what the turn must release. */
export interface PreparedCodexTurn {
  /** The thread to run the turn on. */
  thread: CodexSdkThreadLike;
  /** The input: the current turn, with the instruction and any history. */
  input: CodexSdkInput;
  /** Removes the temporary image files; best-effort, never rejects. */
  cleanup: () => Promise<void>;
  /** The id of the thread being resumed, when there is one. */
  savedThreadId?: string;
}

/**
 * The session state key a run saves its thread id under.
 *
 * @param request - The run.
 * @param threadStateKey - Builds the key from the agent name.
 * @returns The key, or `undefined` when the run has no agent name.
 */
export function codexStateKey(
  request: ExternalAgentRunRequest,
  threadStateKey: (agentName: string) => string,
): string | undefined {
  const agentName = request.agent?.name ?? request.context?.agent?.name;
  return agentName ? threadStateKey(agentName) : undefined;
}

/**
 * Starts or resumes the thread for one turn and builds its input.
 *
 * @remarks
 * Resume precedence: an explicit `runtimeSession.id` wins over the id saved
 * in session state under `stateKey`. A resumed thread already holds the
 * earlier turns, so it gets only the latest content. With nothing to resume,
 * a turn that has earlier history gets a transcript of it in front of the
 * current turn (a cold start). Inline images become temporary files that
 * `cleanup` removes.
 *
 * @param options - The client, the run, the state key (`undefined` for a
 * transport that keeps no thread state) and the thread options.
 * @returns The thread, input and cleanup.
 * @throws ExternalAgentPolicyError with `EXTERNAL_AGENT_OPTION_UNSUPPORTED`
 * for a thread id that starts with `-`, before any thread is created.
 */
export function prepareCodexTurn(options: {
  client: CodexSdkClientLike;
  request: ExternalAgentRunRequest;
  stateKey: string | undefined;
  threadOptions: CodexSdkThreadOptions;
}): PreparedCodexTurn {
  const { client, request, stateKey, threadOptions } = options;
  // An explicit runtime session id wins over the id saved in state.
  const savedThreadId =
    stringValue(request.runtimeSession?.id) ??
    readSavedThreadId(request, stateKey);
  const contents = safeCollectContents(request.context);
  const lastContent = contents[contents.length - 1];

  if (savedThreadId) {
    assertThreadIdIsNotAFlag(savedThreadId);
    const thread = client.resumeThread(savedThreadId, threadOptions);
    const mapping = mapLastContentOrFallback(lastContent, request);
    return {
      thread,
      input: applyInstruction(request.instruction, mapping.input),
      cleanup: mapping.cleanup,
      savedThreadId,
    };
  }
  const thread = client.startThread(threadOptions);
  if (contents.length > 1 && lastContent) {
    const mapping = userContentToCodexInput(lastContent);
    const transcript = summarizeHistoryForColdStart(contents);
    return {
      thread,
      input: applyInstruction(
        request.instruction,
        prependColdStartTranscript(mapping.input, transcript),
      ),
      cleanup: mapping.cleanup,
    };
  }
  const mapping = mapLastContentOrFallback(lastContent, request);
  return {
    thread,
    input: applyInstruction(request.instruction, mapping.input),
    cleanup: mapping.cleanup,
  };
}

/**
 * Reports a thread id to session state as soon as it is known, once.
 *
 * @remarks
 * The `thread.started` event carries the id before the first turn
 * completes, so a turn that fails midway is still resumable.
 */
export class CodexThreadTracker {
  readonly #stateKey: string | undefined;
  readonly #savedThreadId: string | undefined;
  #reported: string | undefined;

  /**
   * @param stateKey - The key to save the id under; `undefined` disables
   * reporting.
   * @param savedThreadId - The id the run resumed: never reported again.
   */
  constructor(stateKey: string | undefined, savedThreadId: string | undefined) {
    this.#stateKey = stateKey;
    this.#savedThreadId = savedThreadId;
  }

  /**
   * @param threadId - An id seen on the stream or on the thread.
   * @returns A `state_delta` event the first time a new id is seen.
   */
  observe(threadId: string | undefined | null): ExternalAgentEvent | undefined {
    if (!this.#stateKey || !threadId) return undefined;
    if (threadId === this.#savedThreadId || threadId === this.#reported) {
      return undefined;
    }
    this.#reported = threadId;
    return {
      type: "state_delta",
      stateDelta: { [this.#stateKey]: threadId },
      timestamp: Date.now(),
    };
  }
}

function mapLastContentOrFallback(
  lastContent: Content | undefined,
  request: ExternalAgentRunRequest,
): { input: CodexSdkInput; cleanup: () => Promise<void> } {
  if (lastContent) {
    return userContentToCodexInput(lastContent);
  }
  // No content collected — fall back to the legacy text extractor so synthetic
  // contexts (e.g. unit tests with just `userContent: {...}`) keep working.
  const text = contextText(request.context) ?? "";
  return { input: text, cleanup: async () => {} };
}

function applyInstruction(
  instruction: string | undefined,
  input: CodexSdkInput,
): CodexSdkInput {
  if (!instruction || instruction.length === 0) {
    return input;
  }
  if (typeof input === "string") {
    return input.length > 0 ? `${instruction}\n\n${input}` : instruction;
  }
  return [{ type: "text", text: instruction }, ...input];
}

function prependColdStartTranscript(
  input: CodexSdkInput,
  transcript: string,
): CodexSdkInput {
  if (!transcript || transcript.length === 0) {
    return input;
  }
  if (typeof input === "string") {
    return input.length > 0 ? `${transcript}\n\n${input}` : transcript;
  }
  // Array input. If the first part is text, fold the transcript into it;
  // otherwise (e.g. starts with an image), insert a synthetic text part.
  const first = input[0];
  if (first && first.type === "text") {
    return [
      { type: "text", text: `${transcript}\n\n${first.text}` },
      ...input.slice(1),
    ];
  }
  return [{ type: "text", text: transcript }, ...input];
}

/**
 * Refuses a thread id that starts with `-`.
 *
 * The SDK passes the id as its own argv entry after `resume`, and
 * `codex exec resume` reads an entry that starts with `-` as an option, so
 * an id such as `--dangerously-bypass-approvals-and-sandbox` would change
 * the run's policy instead of naming a thread. The id can come from session
 * state, which other agents and tools may write.
 *
 * @param threadId - The id the run would resume.
 * @throws ExternalAgentPolicyError with `EXTERNAL_AGENT_OPTION_UNSUPPORTED`.
 */
export function assertThreadIdIsNotAFlag(threadId: string): void {
  if (threadId.startsWith("-")) {
    throw new ExternalAgentPolicyError(
      EXTERNAL_AGENT_OPTION_UNSUPPORTED,
      "CodexSdkDriver: the thread id to resume starts with '-', which codex exec resume would read as an option rather than a thread id. Codex thread ids never start with '-'; check runtimeSession.id and the thread id saved in session state.",
    );
  }
}

export function readSavedThreadId(
  request: ExternalAgentRunRequest,
  stateKey: string | undefined,
): string | undefined {
  if (!stateKey) return undefined;
  const session = (
    request.context as { session?: { state?: unknown } } | undefined
  )?.session;
  const state = session?.state;
  if (!state || typeof state !== "object") {
    return undefined;
  }
  const value = (state as Record<string, unknown>)[stateKey];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
