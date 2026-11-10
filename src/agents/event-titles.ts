/**
 * Internal helpers that build the readable titles of external-agent events
 * (`customMetadata.title`) and the small value checks they share. Not part of
 * the public API: do not re-export from any barrel.
 */

import { EXTERNAL_AGENT_ERROR } from "./events.js";

/** Longest detail a tool title shows; longer details are cut. */
const TOOL_DETAIL_CHARS = 72;

/**
 * Tells whether a value is a plain record.
 *
 * @param value - Anything.
 * @returns Whether `value` is a non-null object that is not an array.
 */
export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrows a value to a string.
 *
 * @param value - Anything.
 * @returns `value` when it is a string, else `""`.
 */
export function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Cuts `value` to `maxLength` characters, ending with `...` when cut.
 *
 * @param value - The text.
 * @param maxLength - Longest result, the `...` included.
 * @returns The text, cut when longer than `maxLength`.
 */
export function truncate(value: string, maxLength: number): string {
  return value.length > maxLength
    ? `${value.slice(0, maxLength - 3)}...`
    : value;
}

/**
 * Short detail for a tool event title: the command, query, tool name or
 * status found in `value`, cut to 72 characters.
 *
 * @param value - Tool arguments or result.
 * @returns `": <detail>"`, or `""` when `value` has nothing to show.
 */
export function toolDetail(value: unknown): string {
  if (!isPlainRecord(value)) {
    return "";
  }
  const detail =
    stringValue(value.command) ||
    stringValue(value.query) ||
    stringValue(value.toolName) ||
    stringValue(value.status);
  return detail ? `: ${truncate(detail, TOOL_DETAIL_CHARS)}` : "";
}

/** @returns `"<agent>: <name> call<detail>"`. */
export function toolCallTitle(
  agentName: string,
  toolName: string,
  args: unknown,
): string {
  return `${agentName}: ${toolName} call${toolDetail(args)}`;
}

/** @returns `"<agent>: <name> response<detail>"`. */
export function toolResponseTitle(
  agentName: string,
  toolName: string,
  response: unknown,
): string {
  return `${agentName}: ${toolName} response${toolDetail(response)}`;
}

/** @returns `"<agent>: <itemType>"`, plus `" <status>"` when there is one. */
export function itemTitle(
  agentName: string,
  itemType: string,
  status: string,
): string {
  return `${agentName}: ${itemType}${status ? ` ${status}` : ""}`;
}

/** @returns `"<agent>: error <code>"`, with `EXTERNAL_AGENT_ERROR` for a missing or empty code. */
export function errorTitle(
  agentName: string,
  code: string | undefined,
): string {
  return `${agentName}: error ${code || EXTERNAL_AGENT_ERROR}`;
}

/** @returns `"<agent>: progress"` for a partial text, else `"<agent>: final response"`. */
export function textTitle(agentName: string, partial: boolean): string {
  return partial ? `${agentName}: progress` : `${agentName}: final response`;
}
