/**
 * Library logging through ADK's logger.
 *
 * Everything goes through `logger` from `@google/adk`, so applications control
 * it with `setLogLevel`, `setLogger` and `resetLogger` like any other ADK
 * output (and can silence or redirect warnings). Messages are prefixed with
 * `[adk-llm-bridge]`; every warning then names its stable code in brackets
 * (`[adk-llm-bridge] [BUILTIN_TOOLS_DROPPED] ...`), so a custom logger can
 * filter or count by it. The line is a single string: ADK's default logger
 * joins its arguments as text, which would print an object argument as
 * `[object Object]`.
 */

import { logger } from "@google/adk";

/** Prefix of every message this library logs. */
export const LOG_PREFIX = "[adk-llm-bridge]";

/** Stable identifiers for the warnings this library emits. */
export const LogCode = {
  ALREADY_REGISTERED: "ALREADY_REGISTERED",
  TOOL_CALL_MISSING_ID: "TOOL_CALL_MISSING_ID",
  TOOL_CALL_MISSING_NAME: "TOOL_CALL_MISSING_NAME",
  TOOL_RESPONSE_MISSING_ID: "TOOL_RESPONSE_MISSING_ID",
  TOOL_DECLARATION_MISSING_NAME: "TOOL_DECLARATION_MISSING_NAME",
  BUILTIN_TOOLS_DROPPED: "BUILTIN_TOOLS_DROPPED",
  IMAGE_DROPPED_ON_MODEL_TURN: "IMAGE_DROPPED_ON_MODEL_TURN",
  MEDIA_MIME_UNSUPPORTED: "MEDIA_MIME_UNSUPPORTED",
  MEDIA_URI_UNSUPPORTED: "MEDIA_URI_UNSUPPORTED",
  THINKING_TOOL_CHOICE_DOWNGRADED: "THINKING_TOOL_CHOICE_DOWNGRADED",
  REQUEST_MODEL_IGNORED: "REQUEST_MODEL_IGNORED",
  ADK_TOOL_IN_MODEL_SKIPPED: "ADK_TOOL_IN_MODEL_SKIPPED",
  ADK_TOOL_REQUEST_PROCESSING_SKIPPED: "ADK_TOOL_REQUEST_PROCESSING_SKIPPED",
  ADK_TOOLSET_FAILED: "ADK_TOOLSET_FAILED",
  WORKFLOW_STEP_MODEL_CHANGED: "WORKFLOW_STEP_MODEL_CHANGED",
  WORKFLOW_STEP_MODEL_UNRECORDED: "WORKFLOW_STEP_MODEL_UNRECORDED",
  WORKFLOW_STEP_MISMATCH_HINT: "WORKFLOW_STEP_MISMATCH_HINT",
} as const;

/** One of the stable warning codes in {@link LogCode}. */
export type LogCodeValue = (typeof LogCode)[keyof typeof LogCode];

function format(message: string): string {
  return `${LOG_PREFIX} ${message}`;
}

/**
 * Logs a warning through ADK's logger as
 * `[adk-llm-bridge] [<code>] <message>`.
 *
 * @param code - The stable warning code.
 * @param message - The warning text.
 */
export function warn(code: LogCodeValue | string, message: string): void {
  logger.warn(format(`[${code}] ${message}`));
}

/** Logs a debug message through ADK's logger. */
export function debug(message: string): void {
  logger.debug(format(message));
}

const warnedOnce = new Set<string>();

/**
 * Logs a warning at most once per process for a given `code` (for conditions
 * that would repeat on every request, such as a permanent downgrade).
 */
export function warnOnce(code: LogCodeValue | string, message: string): void {
  if (warnedOnce.has(code)) return;
  warnedOnce.add(code);
  warn(code, message);
}

/** Clears the process-wide {@link warnOnce} memory. Intended for tests. */
export function resetWarnOnce(): void {
  warnedOnce.clear();
}

/**
 * De-duplicates warnings within one unit of work (for example one converted
 * request) so a history with many offending parts logs one line per code, not
 * one per part.
 */
export class WarningScope {
  private readonly seen = new Set<string>();

  /**
   * Logs `message` unless this scope already warned for `code` and `subject`.
   *
   * @param code - The stable warning code.
   * @param message - The warning text.
   * @param subject - What the warning is about (for example a tool name), so
   * one code can warn once per subject. Defaults to one warning per code.
   */
  warnOnce(code: LogCodeValue | string, message: string, subject = ""): void {
    const key = `${code}\u0000${subject}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    warn(code, message);
  }
}
