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
 * Token usage and cost reported by an external runtime for one run. Drivers
 * leave out what the runtime does not report; they never send zeros for
 * unknown values.
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
  /** Total cost of the run in US dollars, when the runtime reports it. */
  totalCostUsd?: number;
  /** Per-model breakdown when the runtime reports several models. */
  byModel?: Record<string, Omit<ExternalAgentUsage, "byModel">>;
}

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
