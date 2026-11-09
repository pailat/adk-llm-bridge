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

import { isAbsolute, join } from "node:path";
import {
  createEvent,
  createEventActions,
  type Event,
  type InvocationContext,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
} from "@google/adk";
import { isPlainRecord } from "../event-titles.js";
import { BRIDGE_TOOL_PREFIX } from "../tools/adk-tool-bridge.js";
import { networkAllowed } from "./network.js";
import { canonicalPath, expandHome, isUnderAny } from "./paths.js";
import type { ExternalAgentPermissionPolicy } from "./schema.js";

/** A permission prompt raised by an external runtime for one tool call. */
export interface PermissionRequest {
  /** Id of the runtime's tool call (stable for the call). */
  requestId: string;
  /** Name of the tool the runtime wants to run. */
  toolName: string;
  /** Arguments of the tool call. */
  input: Record<string, unknown>;
  /** Short human-readable title, when the runtime provides one. */
  title?: string;
  /** Longer human-readable description, when the runtime provides one. */
  description?: string;
  /** Why the runtime asked, when it says. */
  reason?: string;
  /** File path that triggered the prompt, when applicable. */
  blockedPath?: string;
  /**
   * Set by the driver, never by the model: how this run keeps shell commands
   * off the network. `enforced`: the runtime sandbox denies every host.
   * `waived`: the driver was built with `allowUnsandboxedShell: true`.
   * Absent: not enforced, so without `allowNetwork: true` a shell call is
   * denied.
   */
  networkSandbox?: "enforced" | "waived";
}

/**
 * The answer to a {@link PermissionRequest}.
 *
 * @remarks
 * `payload` carries data from the approver (for example an edited value or
 * a choice). The runtimes' own permission prompts ignore it. Only a bridged
 * ADK tool that called `requestConfirmation()` receives it, as
 * `toolContext.toolConfirmation.payload`.
 */
export type PermissionDecision =
  | { behavior: "allow"; payload?: unknown }
  | { behavior: "deny"; message: string; payload?: unknown };

/**
 * In-process answer to a {@link PermissionRequest}. Return `true`/`false` or a
 * full decision. Throwing or rejecting counts as a denial.
 */
export type PermissionApprover = (
  request: PermissionRequest,
) => boolean | PermissionDecision | Promise<boolean | PermissionDecision>;

/**
 * How an external agent in `ask` mode gets its permission prompts answered.
 *
 * @remarks
 * Fail-closed: with neither an approver nor `adk`, every request is denied.
 * Whatever answers, the answer is applied after {@link guardPermissionRequest},
 * so a confirmation never widens the effective policy.
 */
export interface ExternalAgentConfirmationOptions {
  /**
   * In-process approver. Without it (and without `adk`) every request is
   * denied.
   */
  approver?: PermissionApprover;
  /**
   * Use ADK's confirmation protocol when no approver decided: emit an
   * `adk_request_confirmation` event, end the invocation, and resume from the
   * `ToolConfirmation` response on the next turn.
   *
   * @defaultValue `false`
   */
  adk?: boolean;
}

/**
 * Tools that reach the network on their own, across runtimes (Claude Code,
 * Codex, Gemini CLI names). Denied unless the policy sets `allowNetwork: true`.
 */
const NETWORK_TOOLS = new Set([
  "WebFetch",
  "WebSearch",
  "web_fetch",
  "web_search",
  "google_web_search",
]);

/**
 * Tools that run shell commands, across runtimes. Without `allowNetwork: true`
 * they are denied unless the request says the runtime sandbox keeps them off
 * the network (or the driver opted out); see
 * {@link PermissionRequest.networkSandbox}.
 */
const SHELL_TOOLS = new Set([
  "Bash",
  "PowerShell",
  "shell",
  "local_shell",
  "exec_command",
  "command_execution",
  "unified_exec",
  "run_shell_command",
]);

/**
 * Input keys that carry a file path in the file tools of Claude Code
 * (`file_path`, `notebook_path`, `path`), Gemini CLI (`absolute_path`,
 * `file_path`, `dir_path`, `paths`) and Codex (`path`, `workdir`, `cwd`). The
 * scan is runtime-neutral: every request is checked for these keys, so a file
 * tool from any runtime is checked against `allowedPaths`, not only the names
 * this module knows. Nested `changes[].path` (Codex file changes) and the
 * `*** ... File:` headers of an `apply_patch` input are read too.
 */
const PATH_KEYS = new Set([
  "file_path",
  "filePath",
  "notebook_path",
  "path",
  "paths",
  "absolute_path",
  "dir_path",
  "directory",
  "workdir",
  "cwd",
  "old_path",
  "new_path",
  "source_path",
  "destination_path",
]);

/**
 * Input keys that carry a glob in file-search tools: Claude Code `Glob`
 * (`pattern`) and `Grep` (`glob`), Gemini CLI `glob` (`pattern`) and
 * `read_many_files` (`include`). A glob that is absolute, starts with `~` or
 * has a `..` segment can reach outside `allowedPaths` without any
 * {@link PATH_KEYS} argument, so its static base is checked as a path.
 */
const GLOB_KEYS = new Set(["pattern", "patterns", "glob", "include"]);

/** Search tools whose `pattern` is a regular expression, not a glob. */
const REGEX_PATTERN_TOOLS = new Set([
  "Grep",
  "grep",
  "grep_search",
  "search_file_content",
]);

const GLOB_META = /[*?[{]/;

/**
 * Most alternatives a glob's brace groups may expand to. A glob with more is
 * checked as if its base were `/`, which fails closed.
 */
const MAX_BRACE_ALTERNATIVES = 64;

/**
 * Input keys that set where a file-search tool matches its glob (Claude
 * `Glob`/`Grep` `path`, Gemini `glob` `dir_path`). A relative glob is
 * resolved against it, not against the working directory.
 */
const SEARCH_ROOT_KEYS = ["path", "dir_path", "directory", "cwd"] as const;

/** Container keys whose entries are scanned for {@link PATH_KEYS}. */
const NESTED_KEYS = new Set(["changes", "edits", "files"]);

/** Input keys of a patch body whose file headers are read. */
const PATCH_KEYS = new Set(["patch", "input"]);

const PATCH_FILE_HEADER =
  /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

const DENY_READ_ONLY =
  "Denied: this agent runs with a read-only policy, which cannot be overridden by a confirmation.";

/** Options of {@link guardPermissionRequest}. */
export interface GuardPermissionOptions {
  /**
   * Base for relative paths (the agent's working directory).
   *
   * @defaultValue `process.cwd()`
   */
  workingDirectory?: string;
}

/**
 * Deny a request that a confirmation is not allowed to grant. Returns a denial
 * when the request would exceed the effective policy, `undefined` otherwise.
 *
 * @remarks
 * Fail-closed rules, in order: `read-only` denies every request; network tools
 * are denied unless `allowNetwork` is `true`; without `allowNetwork: true`,
 * non-bridge MCP tools and shell tools without a network sandbox are denied;
 * under `allowedPaths`, any path outside the roots is denied, and so is any
 * path outside one of the `pathBounds` lists.
 *
 * The guard runs before the host approver and the ADK confirmation, and its
 * denial is final: no approval can override it. It checks the path arguments
 * of file tools across runtimes (the keys in {@link PATH_KEYS}, nested file
 * changes, `apply_patch` headers, and the base of an escaping glob in
 * {@link GLOB_KEYS}, per brace alternative and relative to the call's own
 * search root). It does not parse shell commands, so a path inside a
 * command string is not checked: shell access relies on the runtime sandbox,
 * or on the `read-only` mode, which denies every request.
 *
 * Paths are compared after `path.resolve` and symlink resolution (of the
 * deepest existing ancestor), on both the request and `allowedPaths`, so `..`
 * segments and symlinks cannot escape a root, and `/repo2` is not under
 * `/repo`.
 *
 * @param policy - Effective policy of the agent. `undefined` means no policy,
 * so nothing is denied here.
 * @param request - The permission prompt to check.
 * @param options - Base directory for relative paths.
 * @returns A `deny` decision, or `undefined` when the policy does not forbid
 * the request (an approval may still be required).
 */
export function guardPermissionRequest(
  policy: ExternalAgentPermissionPolicy | undefined,
  request: PermissionRequest,
  options: GuardPermissionOptions = {},
): PermissionDecision | undefined {
  if (policy?.mode === "read-only") {
    return { behavior: "deny", message: DENY_READ_ONLY };
  }
  if (!networkAllowed(policy) && NETWORK_TOOLS.has(request.toolName)) {
    return {
      behavior: "deny",
      message: `Denied: network access is not allowed by this agent's policy (${request.toolName}).`,
    };
  }
  if (!networkAllowed(policy)) {
    const denial = denyWithoutNetwork(request);
    if (denial) {
      return denial;
    }
  }
  if (policy?.allowedPaths || policy?.pathBounds) {
    const base = options.workingDirectory ?? process.cwd();
    // Every root list is resolved now, when the request arrives, so a symlink
    // changed after the policy was set is followed to where it points today.
    const lists = [
      ...(policy.allowedPaths ? [policy.allowedPaths] : []),
      ...(policy.pathBounds ?? []),
    ].map((list) => list.map((root) => canonicalPath(root, base)));
    for (const candidate of requestPaths(request)) {
      const path = canonicalPath(candidate, base);
      if (!lists.every((roots) => isUnderAny(path, roots))) {
        return {
          behavior: "deny",
          message: `Denied: ${candidate} is outside the paths allowed by this agent's policy.`,
        };
      }
    }
  }
  return undefined;
}

/**
 * Without `allowNetwork: true`, MCP tools other than the bridge's own are
 * denied (the guard cannot see where a remote server sends data), and shell
 * tools are denied unless the runtime sandbox keeps them off the network.
 */
function denyWithoutNetwork(
  request: PermissionRequest,
): PermissionDecision | undefined {
  const name = request.toolName;
  if (name.startsWith("mcp__") && !name.startsWith(BRIDGE_TOOL_PREFIX)) {
    return {
      behavior: "deny",
      message: `Denied: MCP tool ${name} may reach the network, which this agent's policy does not allow.`,
    };
  }
  if (
    SHELL_TOOLS.has(name) &&
    request.networkSandbox !== "enforced" &&
    request.networkSandbox !== "waived"
  ) {
    return {
      behavior: "deny",
      message: `Denied: ${name} would run without a network sandbox, and this agent's policy does not allow network access.`,
    };
  }
  return undefined;
}

/**
 * Every path a request targets: the runtime's `blockedPath` plus every
 * path-like input (see {@link PATH_KEYS}), whatever the tool is called.
 */
function requestPaths(request: PermissionRequest): string[] {
  const paths: string[] = [];
  if (request.blockedPath !== undefined) {
    paths.push(request.blockedPath);
  }
  collectInputPaths(request.input, paths, 0, request.toolName);
  return paths;
}

function collectInputPaths(
  input: unknown,
  target: string[],
  depth: number,
  toolName: string,
): void {
  if (depth > 3 || input === null || typeof input !== "object") {
    return;
  }
  if (Array.isArray(input)) {
    for (const item of input) {
      collectInputPaths(item, target, depth + 1, toolName);
    }
    return;
  }
  for (const [key, value] of Object.entries(input)) {
    if (PATH_KEYS.has(key)) {
      pushPathValues(value, target);
    } else if (
      GLOB_KEYS.has(key) &&
      !(key === "pattern" && REGEX_PATTERN_TOOLS.has(toolName))
    ) {
      const globs: string[] = [];
      pushPathValues(value, globs);
      const root = searchRoot(input as Record<string, unknown>);
      for (const glob of globs) {
        target.push(...globBases(glob, root));
      }
    } else if (NESTED_KEYS.has(key)) {
      collectInputPaths(value, target, depth + 1, toolName);
    } else if (PATCH_KEYS.has(key) && typeof value === "string") {
      for (const match of value.matchAll(PATCH_FILE_HEADER)) {
        const path = match[1]?.trim();
        if (path) target.push(path);
      }
    }
  }
}

function pushPathValues(value: unknown, target: string[]): void {
  if (typeof value === "string") {
    if (value.length > 0) target.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && item.length > 0) target.push(item);
    }
  }
}

/** The search-root argument of a file-search call, if it has one. */
function searchRoot(input: Record<string, unknown>): string | undefined {
  for (const key of SEARCH_ROOT_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * The directories a glob cannot match outside of, one per brace
 * alternative, for the alternatives that can leave the search root.
 *
 * Brace groups are expanded first (`{/etc,src}/*` is `/etc/*` and `src/*`,
 * `{..,x}` holds a `..`), because matchers expand them before matching. Each
 * alternative is then reduced by {@link globBase}. A relative base is
 * resolved against the call's own search root when it has one.
 *
 * @param pattern - The glob as the tool received it.
 * @param root - The call's search-root argument, if any.
 * @returns Paths to check against `allowedPaths`; empty when every
 * alternative stays under the search root.
 */
function globBases(pattern: string, root: string | undefined): string[] {
  const alternatives = expandBraces(pattern, MAX_BRACE_ALTERNATIVES);
  if (alternatives === undefined) {
    return ["/"];
  }
  const bases: string[] = [];
  for (const alternative of alternatives) {
    const base = globBase(alternative);
    if (base === undefined) continue;
    bases.push(
      root !== undefined && !isAbsolute(base)
        ? join(expandHome(root), base)
        : base,
    );
  }
  return bases;
}

/**
 * Expands the brace groups of a glob (`a{b,c{d,e}}f`), nested and comma
 * lists. A group without a top-level comma, or an unbalanced brace, is kept
 * as written.
 *
 * @returns The alternatives, or `undefined` when there would be more than
 * `cap`.
 */
function expandBraces(pattern: string, cap: number): string[] | undefined {
  const group = firstBraceGroup(pattern);
  if (!group) {
    return [pattern];
  }
  const prefix = pattern.slice(0, group.start);
  const suffix = pattern.slice(group.end + 1);
  const results: string[] = [];
  for (const option of group.options) {
    const expanded = expandBraces(prefix + option + suffix, cap);
    if (expanded === undefined) return undefined;
    results.push(...expanded);
    if (results.length > cap) return undefined;
  }
  return results;
}

/** The first `{...}` with a top-level comma, and its comma-split options. */
function firstBraceGroup(
  pattern: string,
): { start: number; end: number; options: string[] } | undefined {
  for (let start = pattern.indexOf("{"); start >= 0; ) {
    let depth = 0;
    let optionStart = start + 1;
    const options: string[] = [];
    let end = -1;
    for (let index = start; index < pattern.length; index++) {
      const char = pattern[index];
      if (char === "\\") {
        index++;
      } else if (char === "{") {
        depth++;
      } else if (char === "}") {
        depth--;
        if (depth === 0) {
          end = index;
          break;
        }
      } else if (char === "," && depth === 1) {
        options.push(pattern.slice(optionStart, index));
        optionStart = index + 1;
      }
    }
    if (end < 0) {
      return undefined;
    }
    if (options.length > 0) {
      options.push(pattern.slice(optionStart, end));
      return { start, end, options };
    }
    start = pattern.indexOf("{", start + 1);
  }
  return undefined;
}

/**
 * The directory one brace-free glob cannot match outside of, or `undefined`
 * for a glob that stays under its search root (relative, no `..` segment).
 *
 * The base is the part before the first glob metacharacter, cut back to the
 * last separator (`/repo*` can match `/repo2`, so its base is `/`). Each
 * `..` segment after a metacharacter can climb one more level, so the base
 * climbs too. `~` is expanded; `~user` forms resolve to `/`.
 */
function globBase(pattern: string): string | undefined {
  const climbs = /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(pattern);
  if (!isAbsolute(pattern) && !pattern.startsWith("~") && !climbs) {
    return undefined;
  }
  if (pattern.startsWith("~") && pattern !== "~" && !pattern.startsWith("~/")) {
    return "/";
  }
  const expanded = expandHome(pattern);
  const meta = expanded.search(GLOB_META);
  if (meta < 0) {
    return expanded;
  }
  const head = expanded.slice(0, meta);
  const cut = Math.max(head.lastIndexOf("/"), head.lastIndexOf("\\"));
  const dir = cut < 0 ? "." : head.slice(0, cut + 1);
  const ups = expanded
    .slice(meta)
    .split(/[\\/]/)
    .filter((segment) => segment === "..").length;
  return ups > 0 ? join(dir, ...Array<string>(ups).fill("..")) : dir;
}

/**
 * Turns an approver's return value into a {@link PermissionDecision}.
 *
 * @remarks
 * Only the known fields (`behavior`, `message`, `payload`) are copied, so an
 * approver cannot pass extra data through. A `false` or an empty deny message
 * becomes a generic denial.
 *
 * @param value - Boolean or decision returned by the approver.
 * @returns A normalized decision.
 */
export function normalizeDecision(
  value: boolean | PermissionDecision,
): PermissionDecision {
  if (typeof value === "boolean") {
    return value
      ? { behavior: "allow" }
      : { behavior: "deny", message: "Denied by the approver." };
  }
  // Rebuilt field by field so nothing but the known fields passes through.
  const payload = value.payload !== undefined ? { payload: value.payload } : {};
  return value.behavior === "allow"
    ? { behavior: "allow", ...payload }
    : {
        behavior: "deny",
        message: value.message || "Denied by the approver.",
        ...payload,
      };
}

/**
 * Order-independent signature of a tool call, used to match a retry to a
 * decision.
 *
 * @param toolName - Name of the tool.
 * @param input - Arguments of the call; object key order does not matter.
 * @returns A stable string for the pair.
 */
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
  /** {@link permissionSignature} of the call the human answered about. */
  signature: string;
  /** Name of the tool the answer is about. */
  toolName: string;
  /** Whether the human approved the call. */
  confirmed: boolean;
  /** The `payload` of the ADK `ToolConfirmation` answer, when present. */
  payload?: unknown;
  /** The `hint` of the answer, when present. */
  hint?: string;
}

/**
 * Builds the `adk_request_confirmation` event for a pending request.
 *
 * @param options - Invocation context, name of the requesting agent and the
 * request to ask about.
 * @returns An event with a long-running `adk_request_confirmation` function
 * call. The agent emits it and ends the invocation.
 */
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
 *
 * @param context - Invocation context carrying the user message and session.
 * @param agentName - Name of the agent that emitted the requests.
 * @returns The valid answers of this turn; forged and already consumed
 * responses are dropped.
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
    const fields = parseConfirmationResponse(response.response);
    answers.push({
      requestCallId: response.id,
      signature: permissionSignature(original.name, original.args),
      toolName: original.name,
      confirmed: fields.confirmed === true,
      ...(fields.payload !== undefined ? { payload: fields.payload } : {}),
      ...(typeof fields.hint === "string" ? { hint: fields.hint } : {}),
    });
  }
  return answers;
}

/**
 * The fields of a confirmation answer, read like ADK's own parser: either the
 * object itself, or a single `response` key holding it as a JSON string.
 * A wrapped answer that does not parse to an object is a rejection (no
 * fields, so `confirmed` is not `true`).
 */
function parseConfirmationResponse(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    return {};
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "response") {
    return value;
  }
  const wrapped = value.response;
  if (typeof wrapped !== "string") {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(wrapped);
    return isPlainRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
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

/**
 * Session-state key of the marker recording which answers an agent used.
 *
 * @param agentName - Name of the agent.
 * @returns The state key for that agent.
 */
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
 *
 * @param options - Invocation context, agent name and the answers just read.
 * @returns A state-delta event authored by the agent.
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

/**
 * Instruction note telling the resumed runtime what the human decided.
 *
 * @param answers - Answers read for this turn.
 * @returns Multi-line text listing each tool as approved or rejected.
 */
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
