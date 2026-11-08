/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Human-in-the-loop bridge between an external runtime's permission prompts
 * (the `ask` permission mode) and ADK's tool-confirmation protocol.
 *
 * Two ways to answer a prompt, from simplest to most ADK-native:
 *
 * 1. an in-process {@link PermissionApprover} callback, and
 * 2. ADK's `adk_request_confirmation` flow: the agent emits a confirmation
 *    request event and ends the invocation; the application answers with a
 *    `functionResponse` on the next turn and the agent resumes.
 *
 * Invariants: a confirmation never widens the effective permission policy
 * (see {@link guardPermissionRequest}), `read-only` is never confirmable, and
 * with no way to answer, the request is denied.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  createEvent,
  createEventActions,
  type Event,
  type InvocationContext,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
} from "@google/adk";
import type { ExternalAgentPermissionPolicy } from "./schema.js";

/** A permission prompt raised by an external runtime for one tool call. */
export interface PermissionRequest {
  /** Id of the runtime's tool call (stable for the call). */
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Short human-readable title, when the runtime provides one. */
  title?: string;
  description?: string;
  /** Why the runtime asked, when it says. */
  reason?: string;
  /** File path that triggered the prompt, when applicable. */
  blockedPath?: string;
}

export type PermissionDecision =
  | { behavior: "allow" }
  | { behavior: "deny"; message: string };

/**
 * In-process answer to a {@link PermissionRequest}. Return `true`/`false` or a
 * full decision. Throwing or rejecting counts as a denial.
 */
export type PermissionApprover = (
  request: PermissionRequest,
) => boolean | PermissionDecision | Promise<boolean | PermissionDecision>;

export interface ExternalAgentConfirmationOptions {
  /** In-process approver. Without it (and without `adk`) every request is denied. */
  approver?: PermissionApprover;
  /**
   * Use ADK's confirmation protocol when no approver decided: emit an
   * `adk_request_confirmation` event, end the invocation, and resume from the
   * `ToolConfirmation` response on the next turn.
   */
  adk?: boolean;
}

/**
 * Tools whose network access the guard can see. `allowNetwork: false` is NOT
 * enforced for shell commands (`Bash curl ...`) or MCP tools under a
 * confirmation: the guard cannot tell from their input whether they reach the
 * network. Rely on the runtime's own sandbox for those, or keep them out of
 * an `ask` policy.
 */
const NETWORK_TOOLS = new Set(["WebFetch", "WebSearch"]);

/**
 * File tools (Claude Code names) and the input keys that carry their target
 * path. Checked against `allowedPaths` in addition to the runtime's
 * `blockedPath`, so a call is never approved just because the runtime did not
 * report which path triggered the prompt.
 */
const FILE_TOOL_PATH_KEYS: Readonly<Record<string, readonly string[]>> = {
  Read: ["file_path"],
  Write: ["file_path"],
  Edit: ["file_path"],
  MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path"],
  NotebookRead: ["notebook_path"],
  Glob: ["path"],
  Grep: ["path"],
  LS: ["path"],
};

const DENY_READ_ONLY =
  "Denied: this agent runs with a read-only policy, which cannot be overridden by a confirmation.";

export interface GuardPermissionOptions {
  /**
   * Base for relative paths (the agent's working directory). Defaults to the
   * process working directory.
   */
  workingDirectory?: string;
}

/**
 * Deny a request that a confirmation is not allowed to grant. Returns a denial
 * when the request would exceed the effective policy, `undefined` otherwise.
 *
 * Paths are compared after `path.resolve` and symlink resolution (of the
 * deepest existing ancestor), on both the request and `allowedPaths`, so `..`
 * segments and symlinks cannot escape a root, and `/repo2` is not under
 * `/repo`.
 */
export function guardPermissionRequest(
  policy: ExternalAgentPermissionPolicy | undefined,
  request: PermissionRequest,
  options: GuardPermissionOptions = {},
): PermissionDecision | undefined {
  if (policy?.mode === "read-only") {
    return { behavior: "deny", message: DENY_READ_ONLY };
  }
  if (
    policy &&
    policy.allowNetwork !== true &&
    NETWORK_TOOLS.has(request.toolName)
  ) {
    return {
      behavior: "deny",
      message: `Denied: network access is not allowed by this agent's policy (${request.toolName}).`,
    };
  }
  if (policy?.allowedPaths) {
    const base = options.workingDirectory ?? process.cwd();
    const roots = policy.allowedPaths.map((root) => canonicalPath(root, base));
    for (const candidate of requestPaths(request)) {
      if (!isUnderAny(canonicalPath(candidate, base), roots)) {
        return {
          behavior: "deny",
          message: `Denied: ${candidate} is outside the paths allowed by this agent's policy.`,
        };
      }
    }
  }
  return undefined;
}

/** Every path a request targets: the runtime's `blockedPath` plus file-tool inputs. */
function requestPaths(request: PermissionRequest): string[] {
  const paths: string[] = [];
  if (request.blockedPath !== undefined) {
    paths.push(request.blockedPath);
  }
  for (const key of FILE_TOOL_PATH_KEYS[request.toolName] ?? []) {
    const value = request.input[key];
    if (typeof value === "string" && value.length > 0) {
      paths.push(value);
    }
  }
  return paths;
}

/**
 * Absolute, normalized path with symlinks resolved. A path that does not exist
 * yet (a file about to be written) resolves its deepest existing ancestor and
 * appends the rest, so a symlinked parent is still followed.
 */
function canonicalPath(value: string, base: string): string {
  const absolute = resolve(base, expandHome(value));
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return absolute;
      }
      missing.push(basename(current));
      current = parent;
    }
  }
}

function expandHome(value: string): string {
  if (value === "~" || value.startsWith("~/")) {
    return join(homedir(), value.slice(1));
  }
  return value;
}

function isUnderAny(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const rel = relative(root, path);
    return (
      rel === "" ||
      (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
    );
  });
}

export function normalizeDecision(
  value: boolean | PermissionDecision,
): PermissionDecision {
  if (typeof value === "boolean") {
    return value
      ? { behavior: "allow" }
      : { behavior: "deny", message: "Denied by the approver." };
  }
  return value.behavior === "allow"
    ? { behavior: "allow" }
    : { behavior: "deny", message: value.message || "Denied by the approver." };
}

/** Order-independent signature of a tool call, used to match a retry to a decision. */
export function permissionSignature(
  toolName: string,
  input: Record<string, unknown>,
): string {
  return `${toolName}:${stableStringify(input)}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** A human answer recovered from the current turn's confirmation responses. */
export interface ConfirmationAnswer {
  /** Id of the `adk_request_confirmation` call this answers. */
  requestCallId: string;
  signature: string;
  toolName: string;
  confirmed: boolean;
}

/** Builds the `adk_request_confirmation` event for a pending request. */
export function createConfirmationRequestEvent({
  context,
  agentName,
  request,
}: {
  context: InvocationContext;
  agentName: string;
  request: PermissionRequest;
}): Event {
  const hint =
    request.title ??
    `The agent wants to run ${request.toolName}. Approve or reject this call.`;
  const toolConfirmation = {
    hint,
    confirmed: false,
    payload: {
      toolName: request.toolName,
      ...(request.description ? { description: request.description } : {}),
      ...(request.reason ? { reason: request.reason } : {}),
    },
  };
  const requestCallId = `adk-${crypto.randomUUID()}`;
  return createEvent({
    invocationId: context.invocationId,
    author: agentName,
    branch: context.branch,
    content: {
      role: "user",
      parts: [
        {
          functionCall: {
            id: requestCallId,
            name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
            args: {
              originalFunctionCall: {
                id: request.requestId,
                name: request.toolName,
                args: request.input,
              },
              toolConfirmation,
            },
          },
        },
      ],
    },
    longRunningToolIds: [requestCallId],
    actions: createEventActions({
      requestedToolConfirmations: { [request.requestId]: toolConfirmation },
    }),
  });
}

/**
 * Reads the answers delivered in the current user message. An answer counts
 * only if its `functionResponse` id matches a confirmation request that THIS
 * agent emitted earlier in the session: a forged response cannot approve a call
 * this agent never asked about. An answer is also used only on the turn it was
 * given: re-sending the same response on a later turn is ignored.
 */
export function readConfirmationAnswers(
  context: InvocationContext,
  agentName: string,
): ConfirmationAnswer[] {
  const responses = (context.userContent?.parts ?? [])
    .map((part) => part.functionResponse)
    .filter(
      (response) => response?.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
    );
  if (responses.length === 0) {
    return [];
  }

  const answers: ConfirmationAnswer[] = [];
  const events = context.session?.events ?? [];
  for (const response of responses) {
    if (!response?.id) continue;
    if (alreadyAnswered(events, agentName, response.id)) continue;
    const original = findOwnRequest(events, agentName, response.id);
    if (!original) continue;
    const confirmed = (response.response as { confirmed?: unknown } | undefined)
      ?.confirmed;
    answers.push({
      requestCallId: response.id,
      signature: permissionSignature(original.name, original.args),
      toolName: original.name,
      confirmed: confirmed === true,
    });
  }
  return answers;
}

/**
 * True when an earlier answer to `requestCallId` was already consumed: a
 * session event carries a response with that id and this agent ran after it.
 * The answer of the current turn has no event of this agent after it yet.
 */
function alreadyAnswered(
  events: readonly Event[],
  agentName: string,
  requestCallId: string,
): boolean {
  let answeredAt = -1;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (
      answeredAt === -1 &&
      event?.content?.parts?.some(
        (part) =>
          part.functionResponse?.id === requestCallId &&
          part.functionResponse.name ===
            REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
      )
    ) {
      answeredAt = index;
    } else if (answeredAt !== -1 && event?.author === agentName) {
      return true;
    }
  }
  return false;
}

function findOwnRequest(
  events: readonly Event[],
  agentName: string,
  requestCallId: string,
): { name: string; args: Record<string, unknown> } | undefined {
  for (const event of events) {
    if (event.author !== agentName) continue;
    for (const part of event.content?.parts ?? []) {
      const call = part.functionCall;
      if (
        call?.id !== requestCallId ||
        call.name !== REQUEST_CONFIRMATION_FUNCTION_CALL_NAME
      ) {
        continue;
      }
      const original = (call.args as { originalFunctionCall?: unknown })
        ?.originalFunctionCall as
        | { name?: unknown; args?: unknown }
        | undefined;
      if (typeof original?.name !== "string") return undefined;
      const args =
        original.args !== null && typeof original.args === "object"
          ? (original.args as Record<string, unknown>)
          : {};
      return { name: original.name, args };
    }
  }
  return undefined;
}

/** Session-state key of the marker recording which answers an agent used. */
export function confirmationAnswersStateKey(agentName: string): string {
  return `adk_confirmation_answers:${agentName}`;
}

/**
 * State-only event, authored by the agent, emitted as soon as it reads the
 * answers of a turn. It records the consumption explicitly, so a later turn
 * that re-sends the same responses is ignored even when the turn that used
 * them emitted nothing else (aborted, or a silent driver); see
 * `alreadyAnswered`. The marker is the event itself, not the state value, so a
 * tool rewriting that state key cannot re-enable an answer.
 */
export function createAnswersConsumedEvent({
  context,
  agentName,
  answers,
}: {
  context: InvocationContext;
  agentName: string;
  answers: readonly ConfirmationAnswer[];
}): Event {
  return createEvent({
    invocationId: context.invocationId,
    author: agentName,
    branch: context.branch,
    actions: createEventActions({
      stateDelta: {
        [confirmationAnswersStateKey(agentName)]: answers.map(
          (answer) => answer.requestCallId,
        ),
      },
    }),
  });
}

/** Instruction note telling the resumed runtime what the human decided. */
export function describeAnswers(
  answers: readonly ConfirmationAnswer[],
): string {
  const lines = answers.map(
    (answer) =>
      `- ${answer.toolName}: ${answer.confirmed ? "APPROVED, you may retry the same call" : "REJECTED, do not retry it"}`,
  );
  return [
    "The user answered the pending tool confirmations:",
    ...lines,
    "Continue the task accordingly.",
  ].join("\n");
}
