/** Lifecycle and output events emitted by external coding-agent runtimes. */
export type ExternalAgentEvent =
  | ExternalAgentStartedEvent
  | ExternalAgentOutputEvent
  | ExternalAgentToolCallEvent
  | ExternalAgentToolResultEvent
  | ExternalAgentErrorEvent
  | ExternalAgentStateDeltaEvent
  | ExternalAgentCompletedEvent;

/** The runtime has started a run. Drivers emit it once, first. */
export interface ExternalAgentStartedEvent {
  type: "started";
  /** Runtime-assigned id of the run, when it reports one. */
  runId?: string;
  /** Id of the provider that is running. */
  providerId: string;
  /**
   * Resolved model id when the runtime reports it (for example the Claude
   * SDK `init.model` or the Codex thread model).
   */
  model?: string;
  /**
   * Set when the runtime may route this run's turns to a model other than
   * the requested one (Gemini CLI plan mode, the read-only mapping). The
   * run's model status is then `unsupported`.
   */
  modelRouting?: "plan-mode";
  /** Epoch milliseconds when the event was produced. */
  timestamp?: number;
}

/** Text produced by the runtime. */
export interface ExternalAgentOutputEvent {
  type: "output";
  /** The text. */
  content: string;
  /** Subprocess stream the text came from, for CLI runtimes. */
  stream?: "stdout" | "stderr";
  /** The text is an incremental chunk, not a complete message. */
  partial?: boolean;
  /** The text ends the model turn. */
  turnComplete?: boolean;
  /** Driver-specific data attached to the output. */
  metadata?: Record<string, unknown>;
  /** Epoch milliseconds when the event was produced. */
  timestamp?: number;
}

/** The runtime called one of its tools. */
export interface ExternalAgentToolCallEvent {
  type: "tool_call";
  /** Tool name as the runtime reports it. */
  name: string;
  /** Arguments of the call. */
  input?: unknown;
  /** Id that pairs the call with its {@link ExternalAgentToolResultEvent}. */
  callId?: string;
  /** Driver-specific data attached to the call. */
  metadata?: Record<string, unknown>;
  /** Epoch milliseconds when the event was produced. */
  timestamp?: number;
}

/** A tool call the runtime made has finished. */
export interface ExternalAgentToolResultEvent {
  type: "tool_result";
  /** Tool name as the runtime reports it. */
  name: string;
  /** Value the tool returned. */
  result: unknown;
  /** Id of the matching {@link ExternalAgentToolCallEvent}. */
  callId?: string;
  /** Error message when the tool call failed. */
  error?: string;
  /** Driver-specific data attached to the result. */
  metadata?: Record<string, unknown>;
  /** Epoch milliseconds when the event was produced. */
  timestamp?: number;
}

/** The run failed or the runtime reported an error. */
export interface ExternalAgentErrorEvent {
  type: "error";
  /** Human-readable error message. */
  message: string;
  /** Machine-readable error code, when the runtime or driver classified the error. */
  code?: string;
  /**
   * Whether retrying the run could succeed (for example after a rate limit).
   * `false` marks a condition a retry will not fix, such as auth, billing or
   * exhausted quota. Absent means the driver did not classify the error.
   */
  recoverable?: boolean;
  /** Epoch milliseconds when the event was produced. */
  timestamp?: number;
}

/** Changes to ADK session state that `ExternalAgent` merges into the event's actions. */
export interface ExternalAgentStateDeltaEvent {
  type: "state_delta";
  /** Keys and values to write to the session state. */
  stateDelta: Record<string, unknown>;
  /** Epoch milliseconds when the event was produced. */
  timestamp?: number;
}

/**
 * Token usage and cost reported by an external runtime.
 *
 * @remarks
 * Drivers leave out what the runtime does not report; they never send zeros
 * for unknown values. The counters cover one run (`scope: "run"`) unless
 * `scope` says they are a session total: do not add `"session"` usage to the
 * usage of earlier runs.
 */
export interface ExternalAgentUsage {
  /**
   * Input tokens NOT served from or written to the prompt cache (Anthropic
   * semantics). A runtime that reports cached tokens inside its input count
   * (OpenAI/Codex `input_tokens` includes `cached_input_tokens`) subtracts
   * them here. The prompt size is the sum of `inputTokens`,
   * `cacheReadInputTokens` and `cacheCreationInputTokens`.
   */
  inputTokens?: number;
  /** Tokens the model generated. */
  outputTokens?: number;
  /** Input tokens read from the prompt cache. */
  cacheReadInputTokens?: number;
  /** Input tokens written to the prompt cache. */
  cacheCreationInputTokens?: number;
  /** Cost in US dollars, when the runtime reports it; see `scope`. */
  totalCostUsd?: number;
  /**
   * What the counters and cost cover. `"run"`: this run only. `"session"`: the
   * runtime session's total so far, earlier runs included, so do not add it to
   * the usage of earlier runs.
   *
   * Claude reports session-cumulative values on a resumed session. The Agent
   * SDK driver subtracts the previous result of the same session that it ran
   * itself and reports `"run"`. That baseline is in memory only (the last 256
   * sessions), so these runs report `"session"`:
   * - the first run of a session resumed from outside this driver instance
   *   (restart, another replica, `resumeSessionId`, `runtimeSession.id`);
   * - a `forkSession` run;
   * - a run whose baseline was dropped;
   * - a run where a counter went down.
   *
   * Absent when the driver does not report it.
   */
  scope?: "run" | "session";
  /**
   * Per-model breakdown when the runtime reports several models. The entries
   * cover what `scope` says for the whole usage.
   */
  byModel?: Record<string, ExternalAgentModelUsage>;
}

/**
 * The counters of one model in {@link ExternalAgentUsage.byModel}.
 *
 * @remarks
 * No `scope` and no nested breakdown: the entries cover what the enclosing
 * usage's `scope` says.
 */
export type ExternalAgentModelUsage = Omit<
  ExternalAgentUsage,
  "byModel" | "scope"
>;

/** The run finished. Drivers emit it once, last. */
export interface ExternalAgentCompletedEvent {
  type: "completed";
  /** Exit code of the runtime process, for CLI runtimes. */
  exitCode?: number;
  /** Signal that ended the runtime process, for CLI runtimes. */
  signal?: string;
  /** Resolved model id when the runtime reports it. */
  model?: string;
  /** Token usage the runtime reports for the run. */
  usage?: ExternalAgentUsage;
  /** Number of model turns the runtime reports for the run. */
  numTurns?: number;
  /** Run duration the runtime reports, in milliseconds. */
  durationMs?: number;
  /** Epoch milliseconds when the event was produced. */
  timestamp?: number;
}

/**
 * Error code of an `error` event the driver did not classify. `ExternalAgent`
 * puts it on the ADK event (`errorCode`) when the driver gives no code.
 */
export const EXTERNAL_AGENT_ERROR = "EXTERNAL_AGENT_ERROR";

/**
 * Error code of the event `ExternalAgent` adds when a `transfer_to_agent`
 * target fails and the target did not report the error itself.
 */
export const EXTERNAL_AGENT_TRANSFER_FAILED = "EXTERNAL_AGENT_TRANSFER_FAILED";

/**
 * Error code of `PlaceholderExternalAgentDriver`: the agent has no
 * driver configured, so it cannot run.
 */
export const EXTERNAL_AGENT_NOT_CONFIGURED = "EXTERNAL_AGENT_NOT_CONFIGURED";

/**
 * Error code of the event `ExternalAgent` ends a turn with when the human
 * approved a call through the ADK confirmation protocol and the runtime did
 * not make that call again on the answer turn, so the approved call never
 * ran. A rejected answer left unused is not an error.
 */
export const EXTERNAL_AGENT_CONFIRMATION_UNUSED =
  "EXTERNAL_AGENT_CONFIRMATION_UNUSED";

/**
 * Error code of the event `ExternalAgent` ends a turn with when a bridged ADK
 * tool asked for credentials (`toolContext.requestCredential()`). An external
 * runtime cannot run ADK's credential flow, so the call returned a
 * `CREDENTIAL_REQUIRED` error to the runtime instead of a result.
 */
export const EXTERNAL_AGENT_TOOL_CREDENTIAL_REQUIRED =
  "EXTERNAL_AGENT_TOOL_CREDENTIAL_REQUIRED";

/**
 * Error code of the event `ExternalAgent` ends a turn with, before the
 * runtime starts, when the user's results for its long-running calls are too
 * large: one result over 64 KiB (UTF-8 bytes of JSON), or more than 256 KiB
 * in one turn.
 * The results are not marked used, so a smaller answer for the same call id
 * can follow.
 */
export const EXTERNAL_AGENT_TOOL_RESULT_TOO_LARGE =
  "EXTERNAL_AGENT_TOOL_RESULT_TOO_LARGE";

/**
 * Narrows an unknown value to an {@link ExternalAgentEvent}.
 *
 * @remarks
 * Only the `type` discriminant is checked; the other fields are not validated.
 *
 * @param value - Value to test.
 * @returns Whether `value` is an object whose `type` is a known event type.
 */
export function isExternalAgentEvent(
  value: unknown,
): value is ExternalAgentEvent {
  if (!value || typeof value !== "object") {
    return false;
  }

  const type = (value as { type?: unknown }).type;
  return (
    type === "started" ||
    type === "output" ||
    type === "tool_call" ||
    type === "tool_result" ||
    type === "error" ||
    type === "state_delta" ||
    type === "completed"
  );
}
