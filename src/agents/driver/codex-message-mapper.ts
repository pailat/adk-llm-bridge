import { warn } from "../../utils/log.js";
import { EXTERNAL_AGENT_ERROR, type ExternalAgentEvent } from "../events.js";
import { CODEX_PROVIDER } from "../provider/codex.js";
import {
  classifyRecoverable,
  isKnownSubtype,
} from "../runtime/error-classification.js";
import { codexTurnUsage } from "./run-summary.js";
import { asRecord, bridgeEvent, stringValue } from "./shared.js";

/**
 * Type of the envelope a transport uses to hand the run loop an event it
 * built itself (a process exit, a line of stderr) instead of a Codex event.
 * {@link normalizeCodexJsonlEvent} returns the wrapped event as is.
 */
export const CODEX_BRIDGE_ENVELOPE = "adk.bridge_event";

/**
 * Wraps a bridge event so it crosses the event stream of a transport
 * unchanged.
 *
 * @param event - The event the transport built.
 * @returns A stream event for {@link normalizeCodexJsonlEvent}.
 */
export function codexBridgeEnvelope(
  event: ExternalAgentEvent,
): Record<string, unknown> {
  return { type: CODEX_BRIDGE_ENVELOPE, event };
}

/**
 * The thread id of a `thread.started` event. The SDK shape is
 * `ThreadStartedEvent { type: "thread.started", thread_id }`.
 *
 * @param event - The stream event.
 * @returns The id, when present.
 */
export function codexThreadStartedId(
  event: Record<string, unknown>,
): string | undefined {
  return stringValue(event.thread_id) ?? stringValue(asRecord(event.thread).id);
}

/**
 * The message of a failed-turn event, when it carries one: `message`, a
 * string `error`, or `error.message`.
 *
 * @param event - A `turn.failed` or `error` event.
 * @returns The message, when present.
 */
export function codexFailureMessage(
  event: Record<string, unknown>,
): string | undefined {
  return (
    stringValue(event.message) ??
    stringValue(event.error) ??
    stringValue(asRecord(event.error).message)
  );
}

/**
 * Maps one Codex SDK thread event to bridge events: whole items become call
 * and result pairs, progress items become partial output, `turn.failed`
 * becomes an error followed by `completed` with exit code 1. Every event is
 * stamped with `timestamp`.
 *
 * @param event - The stream event.
 * @param timestamp - The time to stamp the events with.
 * @returns Zero or more events; unknown event types yield none.
 */
export function normalizeCodexSdkEvent(
  event: Record<string, unknown>,
  timestamp: number = Date.now(),
): ExternalAgentEvent[] {
  const type = stringValue(event.type);

  if (type === "turn.completed") {
    // Codex reports token usage per turn; it does not report the model.
    const usage = codexTurnUsage(event.usage);
    return [
      {
        type: "completed",
        exitCode: 0,
        ...(usage ? { usage } : {}),
        timestamp,
      },
    ];
  }

  if (type === "turn.failed") {
    const message = codexFailureMessage(event) ?? "Codex turn failed";
    const { recoverable, code } = classifyRecoverable({
      message,
      fallbackCode: "CODEX_TURN_FAILED",
    });
    return [
      { type: "error", message, code, recoverable, timestamp },
      { type: "completed", exitCode: 1, timestamp },
    ];
  }

  if (type === "error") {
    const message = stringValue(event.message) ?? "Codex SDK error";
    const { recoverable, code } = classifyRecoverable({
      message,
      fallbackCode: "CODEX_SDK_STREAM_ERROR",
    });
    return [{ type: "error", message, code, recoverable, timestamp }];
  }

  if (type === "item.started" || type === "item.updated") {
    return normalizeProgressItem(asRecord(event.item), timestamp);
  }

  if (type !== "item.completed") {
    return [];
  }

  return normalizeCompletedItem(asRecord(event.item), timestamp);
}

/**
 * Maps one parsed `codex exec --json` line to one bridge event, keeping the
 * shapes that CLI transport has always reported: a tool call opens on
 * `item.started` and its result arrives on `item.completed`, the source
 * timestamp is kept, `turn.failed` is only an error (the exit code ends the
 * run), and older text shapes such as `response.output_text.delta` still map.
 * A line that is already a bridge event passes through, and a bridge-shaped
 * line missing its fields is dropped.
 *
 * @param value - The parsed line.
 * @returns The event, or `undefined` for lifecycle and unknown events.
 */
export function normalizeCodexJsonlEvent(
  value: unknown,
): ExternalAgentEvent | undefined {
  const record = asRecord(value);
  if (record.type === CODEX_BRIDGE_ENVELOPE) {
    return record.event as ExternalAgentEvent;
  }
  // Codex's own `{"type":"error","message":...}` is also bridge-shaped, so
  // error lines are always normalized and classified below.
  if (record.type !== "error") {
    const bridged = bridgeEvent(record, "drop");
    if (bridged === "drop") {
      return undefined;
    }
    if (bridged !== undefined) {
      return bridged;
    }
  }
  return normalizeCodexEvent(value);
}

/**
 * Logs and drops a line that is not JSON: a stray CLI banner or debug print
 * must not end the run.
 *
 * @param line - The raw line.
 */
export function warnNonJsonLine(line: string): void {
  warn(
    "CODEX_CLI_NON_JSON_LINE",
    `Ignoring a non-JSON line from codex exec --json: ${truncate(line.trim(), 200)}`,
  );
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** Codex event types whose payload is assistant text. */
const TEXT_EVENT_TYPES = new Set([
  "response.output_text.delta",
  "agent_message",
  "agent_message_delta",
]);

function codexEventType(record: Record<string, unknown>): string {
  return stringValue(record.type) ?? stringValue(record.event) ?? "unknown";
}

function codexError(
  message: string,
  source: Record<string, unknown>,
  timestamp: number | undefined,
): ExternalAgentEvent {
  const explicitCode = stringValue(source.code);
  // Same classifier as the Codex SDK driver: a usage cap becomes a
  // non-recoverable QUOTA_EXHAUSTED, a rate limit stays recoverable.
  // An explicit code on the line wins, unless it is a classifier subtype key
  // (for example `quota_exhausted`): then the classified code is used, so it
  // matches what the SDK driver reports for the same condition.
  const classified = classifyRecoverable({
    subtype: explicitCode,
    message,
    fallbackCode: EXTERNAL_AGENT_ERROR,
    defaultRecoverable: false,
  });
  return {
    type: "error",
    message,
    code:
      explicitCode && !isKnownSubtype(explicitCode)
        ? explicitCode
        : classified.code,
    recoverable:
      typeof source.recoverable === "boolean"
        ? source.recoverable
        : classified.recoverable,
    timestamp,
  };
}

/**
 * Maps one Codex JSONL event to a bridge event. Only known text-bearing
 * events produce `output`; lifecycle and unknown events return `undefined`
 * so raw JSONL never reaches the assistant text.
 */
function normalizeCodexEvent(value: unknown): ExternalAgentEvent | undefined {
  const record = asRecord(value);
  const type = codexEventType(record);
  const timestamp = numberValue(record.timestamp);

  // `codex exec --json` ends a failed turn with `turn.failed`
  // ({ error: { message } }), which does not contain the word "error".
  if (type.includes("error") || type.includes("failed")) {
    const message =
      stringValue(record.message) ??
      stringValue(record.error) ??
      stringValue(asRecord(record.error).message) ??
      // An empty `turn.failed` (no message) gets a readable message
      // instead of the raw JSON line.
      `Codex reported ${type} without an error message`;
    return codexError(message, record, timestamp);
  }

  const item = asRecord(record.item);
  const itemType = stringValue(item.type);
  if (itemType === "agent_message") {
    // Like the SDK driver, only the completed message is assistant text;
    // `item.started` / `item.updated` would duplicate it.
    const text = type === "item.completed" ? extractText(item) : undefined;
    return text
      ? { type: "output", content: text, stream: "stdout", timestamp }
      : undefined;
  }

  if (itemType === "error") {
    const message =
      stringValue(item.message) ?? extractErrorMessage(item.error);
    return message ? codexError(message, item, timestamp) : undefined;
  }

  const toolName = extractToolName(record);
  if (toolName) {
    if (type === "item.completed") {
      return {
        type: "tool_result",
        name: toolName,
        result: item.result ?? item.aggregated_output ?? item,
        callId: stringValue(item.id),
        error: extractErrorMessage(item.error),
        metadata: { ...(itemType ? { itemType } : {}), builtin: true },
        timestamp,
      };
    }
    // One tool_call per callId: `item.started` opens it; `item.updated` is
    // progress of the same call and must not emit a second call.
    if (type === "item.updated") {
      return undefined;
    }
    return {
      type: "tool_call",
      name: toolName,
      input:
        itemType === "command_execution" && item.command !== undefined
          ? { command: item.command }
          : (record.input ?? record.arguments ?? item.input ?? item.arguments),
      callId: stringValue(item.id),
      metadata: { ...(itemType ? { itemType } : {}), builtin: true },
      timestamp,
    };
  }

  if (type === "thread.started" || type === "response.created") {
    return {
      type: "started",
      providerId: CODEX_PROVIDER.id,
      runId:
        stringValue(record.thread_id) ??
        stringValue(record.run_id) ??
        stringValue(record.id),
      timestamp,
    };
  }

  if (type === "turn.completed" || type === "response.completed") {
    // `turn.completed` carries the turn's token usage.
    const usage = codexTurnUsage(record.usage);
    return {
      type: "completed",
      exitCode: numberValue(record.exit_code),
      ...(usage ? { usage } : {}),
      timestamp,
    };
  }

  if (TEXT_EVENT_TYPES.has(type)) {
    const text = extractText(record);
    return text
      ? { type: "output", content: text, stream: "stdout", timestamp }
      : undefined;
  }

  return undefined;
}

function extractToolName(record: Record<string, unknown>): string | undefined {
  const directName = stringValue(record.name) ?? stringValue(record.tool_name);
  const type = stringValue(record.type) ?? "";
  if (directName && (type.includes("tool") || type.includes("call"))) {
    return directName;
  }

  const item = asRecord(record.item);
  const itemType = stringValue(item.type) ?? "";
  if (itemType.includes("tool") || itemType.includes("call")) {
    return (
      stringValue(item.name) ??
      stringValue(item.tool_name) ??
      stringValue(item.tool)
    );
  }
  if (itemType === "command_execution") {
    return "command_execution";
  }

  return undefined;
}

function extractErrorMessage(value: unknown): string | undefined {
  return stringValue(value) ?? stringValue(asRecord(value).message);
}

function extractText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  const record = asRecord(value);
  const direct =
    stringValue(record.content) ??
    stringValue(record.text) ??
    stringValue(record.delta) ??
    stringValue(record.message);
  if (direct) {
    return direct;
  }

  if (record.item !== undefined) {
    const itemText = extractText(record.item);
    if (itemText) {
      return itemText;
    }
  }

  if (Array.isArray(record.content)) {
    const parts = record.content
      .map((part) => extractText(part))
      .filter((part): part is string => typeof part === "string");
    if (parts.length > 0) {
      return parts.join("");
    }
  }

  return undefined;
}

function normalizeProgressItem(
  item: Record<string, unknown>,
  timestamp: number,
): ExternalAgentEvent[] {
  const itemType = stringValue(item.type);
  // Same value as the builtin tool_call `callId`, so the first progress event
  // can set the start time of the tool span.
  const itemId = stringValue(item.id);
  const idMetadata = itemId ? { itemId } : {};

  if (itemType === "command_execution") {
    const command = stringValue(item.command);
    const status = stringValue(item.status);
    return command
      ? [
          {
            type: "output",
            content: `Codex command ${status ?? "running"}: ${command}`,
            partial: true,
            turnComplete: false,
            metadata: {
              itemType,
              ...idMetadata,
              status,
              command,
              exitCode: item.exit_code,
              title: `Codex: command_execution ${status ?? "running"}`,
            },
            timestamp,
          },
        ]
      : [];
  }

  if (itemType === "mcp_tool_call") {
    const toolName = stringValue(item.tool) ?? "mcp_tool_call";
    const status = stringValue(item.status) ?? "running";
    return [
      {
        type: "output",
        content: `Codex MCP tool ${status}: ${toolName}`,
        partial: true,
        turnComplete: false,
        metadata: {
          itemType,
          ...idMetadata,
          toolName,
          status: item.status,
          title: `Codex: ${toolName} ${status}`,
        },
        timestamp,
      },
    ];
  }

  if (itemType === "web_search") {
    const query = stringValue(item.query);
    return query
      ? [
          {
            type: "output",
            content: `Codex web search: ${query}`,
            partial: true,
            turnComplete: false,
            metadata: {
              itemType,
              ...idMetadata,
              query,
              title: "Codex: web_search",
            },
            timestamp,
          },
        ]
      : [];
  }

  return [];
}

function normalizeCompletedItem(
  item: Record<string, unknown>,
  timestamp: number,
): ExternalAgentEvent[] {
  const itemType = stringValue(item.type);

  if (itemType === "agent_message") {
    const text = stringValue(item.text);
    return text
      ? [{ type: "output", content: text, stream: "stdout", timestamp }]
      : [];
  }

  if (itemType === "error") {
    const message = stringValue(item.message) ?? "Codex item error";
    const { recoverable, code } = classifyRecoverable({
      message,
      fallbackCode: "CODEX_ITEM_ERROR",
    });
    return [
      {
        type: "error",
        message,
        code,
        recoverable,
        timestamp,
      },
    ];
  }

  if (itemType === "mcp_tool_call") {
    const toolName = stringValue(item.tool) ?? "mcp_tool_call";
    const status = stringValue(item.status) ?? "completed";
    return [
      {
        type: "tool_call",
        name: toolName,
        input: {
          server: item.server,
          arguments: item.arguments,
          status: item.status,
        },
        callId: stringValue(item.id),
        metadata: {
          itemType,
          builtin: true,
          status: item.status,
          title: `Codex: ${toolName} call`,
          ...codexMcpMetadata(item),
        },
        timestamp,
      },
      {
        type: "tool_result",
        name: toolName,
        result: {
          server: item.server,
          status: item.status,
          result: item.result,
          error: item.error,
        },
        callId: stringValue(item.id),
        error: stringValue(item.error),
        metadata: {
          itemType,
          builtin: true,
          status: item.status,
          title: `Codex: ${toolName} ${status}`,
          ...codexMcpMetadata(item),
        },
        timestamp,
      },
    ];
  }

  if (itemType === "command_execution") {
    const command = stringValue(item.command);
    const status = stringValue(item.status) ?? "completed";
    return [
      {
        type: "tool_call",
        name: "command_execution",
        input: {
          command: item.command,
          status: item.status,
          exitCode: item.exit_code,
        },
        callId: stringValue(item.id),
        metadata: {
          itemType,
          builtin: true,
          status: item.status,
          command,
          title: "Codex: command_execution call",
        },
        timestamp,
      },
      {
        type: "tool_result",
        name: "command_execution",
        result: {
          command: item.command,
          status: item.status,
          exitCode: item.exit_code,
          ...(typeof item.aggregated_output === "string"
            ? { output: item.aggregated_output }
            : {}),
        },
        callId: stringValue(item.id),
        metadata: {
          itemType,
          builtin: true,
          status: item.status,
          command,
          exitCode: item.exit_code,
          title: `Codex: command_execution ${status}`,
        },
        timestamp,
      },
    ];
  }

  if (itemType === "file_change") {
    // A patch the agent applied with its own tools.
    const status = stringValue(item.status) ?? "completed";
    const callId = stringValue(item.id);
    const metadata = { itemType, builtin: true, status: item.status };
    return [
      {
        type: "tool_call",
        name: "file_change",
        input: { changes: item.changes },
        callId,
        metadata: { ...metadata, title: "Codex: file_change call" },
        timestamp,
      },
      {
        type: "tool_result",
        name: "file_change",
        result: { changes: item.changes, status: item.status },
        callId,
        ...(status === "failed" ? { error: "Codex patch failed" } : {}),
        metadata: { ...metadata, title: `Codex: file_change ${status}` },
        timestamp,
      },
    ];
  }

  if (itemType === "web_search") {
    const callId = stringValue(item.id);
    const metadata = { itemType, builtin: true };
    return [
      {
        type: "tool_call",
        name: "web_search",
        input: { query: item.query },
        callId,
        metadata: { ...metadata, title: "Codex: web_search call" },
        timestamp,
      },
      {
        type: "tool_result",
        name: "web_search",
        result: { query: item.query },
        callId,
        metadata: { ...metadata, title: "Codex: web_search completed" },
        timestamp,
      },
    ];
  }

  return [];
}

/**
 * `metadata.mcp` for a Codex `mcp_tool_call` item: its server and tool, when
 * both are strings.
 */
function codexMcpMetadata(item: Record<string, unknown>): {
  mcp?: { server: string; tool: string };
} {
  const server = stringValue(item.server);
  const tool = stringValue(item.tool);
  return server !== undefined && tool !== undefined
    ? { mcp: { server, tool } }
    : {};
}
