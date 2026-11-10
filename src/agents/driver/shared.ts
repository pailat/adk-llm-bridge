/**
 * Internal helpers shared by the external-agent drivers. Not part of the
 * public API: do not re-export from any barrel.
 */

import { existsSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InputValidationError } from "@google/adk";
import { readAllowedEnv } from "../auth/env.js";
import type {
  ExternalAgentErrorEvent,
  ExternalAgentEvent,
  ExternalAgentOutputEvent,
  ExternalAgentToolCallEvent,
  ExternalAgentToolResultEvent,
} from "../events.js";
import type { ExternalAgentRunRequest } from "../external-agent-driver.js";
import { canonicalPath, expandHome, isUnderAny } from "../permissions/paths.js";
import { classifyRecoverable } from "../runtime/error-classification.js";

/**
 * Narrows an unknown value to a record.
 *
 * @param value - Anything.
 * @returns `value` when it is a non-null object, otherwise an empty object.
 */
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * True for a JSON object: not `null`, not an array, not a primitive.
 *
 * @param value - A parsed JSON value.
 * @returns Whether `value` can be read as an event record.
 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns the value only when it is a non-empty string. */
export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Drops the entries whose value is `undefined`.
 *
 * @param value - A record.
 * @returns A copy without the undefined entries.
 */
export function removeUndefined(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

/**
 * Picks the first non-empty string.
 *
 * @param values - Candidates, in priority order.
 * @returns The first string with length above zero, or `undefined`.
 */
export function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

/**
 * Reads one variable from an `env` credential.
 *
 * @param request - The run.
 * @param key - Variable name.
 * @returns The value, or `undefined` when the credential is not of kind `env` or lacks the key.
 */
export function readCredentialEnv(
  request: ExternalAgentRunRequest,
  key: string,
): string | undefined {
  return request.credential?.kind === "env"
    ? request.credential.env?.[key]
    : undefined;
}

/**
 * Copies one key when its value is a non-empty string.
 *
 * @remarks
 * Drivers use this to build an allowlisted child environment key by key, so
 * no variable is inherited by accident.
 *
 * @param source - Where to read from.
 * @param target - Where to write to.
 * @param key - The variable name.
 */
export function copyIfPresent(
  source: Record<string, string | undefined>,
  target: Record<string, string | undefined>,
  key: string,
): void {
  const value = source[key];
  if (typeof value === "string" && value.length > 0) {
    target[key] = value;
  }
}

/**
 * Canonical directories the run's agent may write, which the executable
 * lookup never searches.
 *
 * @remarks
 * Security invariant: a binary the agent planted in one run must not start
 * the next run on the host, outside the runtime's sandbox. The roots are the
 * run's working directory (the process directory when it is unset, as the
 * runtimes then work there) and each `allowedPaths` entry resolved against
 * it, whatever the mode. A root whose symlinks cannot be resolved is kept as
 * its absolute path.
 *
 * @param request - The run, for its working directory and permissions.
 * @returns Absolute, canonical roots.
 */
export function agentWritableRoots(
  request: Pick<ExternalAgentRunRequest, "workingDirectory" | "permissions">,
): string[] {
  const workingDirectory = resolve(request.workingDirectory ?? process.cwd());
  const roots = [canonicalPath(workingDirectory, "/") ?? workingDirectory];
  for (const path of request.permissions?.allowedPaths ?? []) {
    roots.push(
      canonicalPath(path, workingDirectory) ??
        resolve(workingDirectory, expandHome(path)),
    );
  }
  return [...new Set(roots)];
}

/**
 * Whether the executable lookup may probe or use `path`: a candidate, or a
 * path a package resolution returned.
 *
 * @param path - The path, absolute or relative to the process directory.
 * @param excluded - Canonical roots the agent may write
 * ({@link agentWritableRoots}).
 * @returns `false` when the canonical path (symlinks resolved) is inside a
 * root, or cannot be resolved.
 */
export function isSearchableExecutable(
  path: string,
  excluded: readonly string[],
): boolean {
  const canonical = canonicalPath(path, process.cwd());
  return canonical !== undefined && !isUnderAny(canonical, excluded);
}

/**
 * Directories to search for locally installed CLI packages.
 *
 * @remarks
 * Callers drop every path they find under these that is inside the run's
 * {@link agentWritableRoots} ({@link isSearchableExecutable}), so the run's
 * working directory is never searched, including when it is this process
 * directory.
 *
 * @returns Absolute, de-duplicated paths: the process directory and up to
 * eight parents of this module.
 */
export function candidateBaseDirectories(): string[] {
  const roots = new Set<string>();
  roots.add(process.cwd());

  let current = dirname(fileURLToPath(import.meta.url));
  for (let index = 0; index < 8; index++) {
    roots.add(current);
    const next = dirname(current);
    if (next === current) {
      break;
    }
    current = next;
  }

  return [...roots].filter((item) => isAbsolute(item));
}

/**
 * Reads the text of the current user turn from an invocation context.
 *
 * @remarks
 * Accepts an ADK `Content` (`{ role, parts }`), a plain string, a list of
 * parts, or a record with `text`, `content`, `result` or `message`. Falls
 * back to `input` and `prompt` fields of the context. Thought parts are
 * skipped.
 *
 * @param context - The invocation context, or a synthetic test context.
 * @returns The text, or `undefined` when the context carries none.
 */
export function contextText(context: unknown): string | undefined {
  const record = asRecord(context);
  return (
    textOf(record.userContent ?? record.user_content) ??
    stringValue(record.input) ??
    stringValue(record.prompt)
  );
}

/**
 * Builds a one-shot prompt: the instruction, then the user turn's text.
 *
 * @remarks
 * For runtimes that take the whole prompt as one argument (the CLIs). Empty
 * pieces are dropped and the rest are joined by a blank line.
 *
 * @param request - The run.
 * @returns The prompt; empty when the run has neither.
 */
export function promptFromRequest(request: ExternalAgentRunRequest): string {
  return [request.instruction, contextText(request.context)]
    .filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    )
    .join("\n\n");
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.length > 0 ? value : undefined;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((part) => textOf(part))
      .filter((part): part is string => typeof part === "string");
    return parts.length > 0 ? parts.join("") : undefined;
  }
  const record = asRecord(value);
  if (record.thought === true) {
    return undefined;
  }
  const direct =
    stringValue(record.text) ??
    stringValue(record.content) ??
    stringValue(record.result) ??
    stringValue(record.message);
  if (direct) {
    return direct;
  }
  if (Array.isArray(record.parts)) {
    return textOf(record.parts);
  }
  if (Array.isArray(record.content)) {
    return textOf(record.content);
  }
  return undefined;
}

/**
 * Reads a stdout line that is already shaped like a bridge event.
 *
 * @remarks
 * The CLIs emit their own formats, so a bridge-shaped line is rare. Such a
 * line is rebuilt field by field, so a wrong type never reaches the agent.
 * `started`, `completed` and `state_delta` belong to the driver: a child
 * process must not end the run early or write session state, so those lines
 * return `"drop"`. An `output`, `tool_call` or `tool_result` line without the
 * bridge fields (for example a legacy `{"type":"output","text":...}`) is not
 * a bridge event: it returns `undefined` so the driver reads it in the
 * runtime's own format, unless `malformed` is `"drop"`.
 *
 * @param value - One parsed stdout line.
 * @param malformed - What a malformed `output`, `tool_call` or `tool_result`
 * line gives: `"native"` (the default) returns `undefined`, `"drop"` returns
 * `"drop"`.
 * @returns The rebuilt event; `"drop"` for a driver-owned event (or a
 * malformed one when `malformed` is `"drop"`); `undefined` when the line is
 * not a bridge event and should be read as the runtime's own format.
 */
export function bridgeEvent(
  value: Record<string, unknown>,
  malformed: "native" | "drop" = "native",
): ExternalAgentEvent | "drop" | undefined {
  const notBridge = malformed === "drop" ? "drop" : undefined;
  const timestamp =
    typeof value.timestamp === "number" && Number.isFinite(value.timestamp)
      ? value.timestamp
      : undefined;
  const metadata = isJsonObject(value.metadata) ? value.metadata : undefined;
  switch (value.type) {
    case "started":
    case "completed":
    case "state_delta":
      return "drop";
    case "output":
      if (typeof value.content !== "string") return notBridge;
      return withoutUndefined<ExternalAgentOutputEvent>({
        type: "output",
        content: value.content,
        stream:
          value.stream === "stdout" || value.stream === "stderr"
            ? value.stream
            : undefined,
        partial: typeof value.partial === "boolean" ? value.partial : undefined,
        metadata,
        timestamp,
      });
    case "tool_call":
      if (!stringValue(value.name)) return notBridge;
      return withoutUndefined<ExternalAgentToolCallEvent>({
        type: "tool_call",
        name: value.name as string,
        input: value.input,
        callId: stringValue(value.callId),
        metadata,
        timestamp,
      });
    case "tool_result":
      if (!stringValue(value.name)) return notBridge;
      return withoutUndefined<ExternalAgentToolResultEvent>({
        type: "tool_result",
        name: value.name as string,
        result: value.result,
        callId: stringValue(value.callId),
        error: stringValue(value.error),
        metadata,
        timestamp,
      });
    case "error":
      if (typeof value.message !== "string") return undefined;
      return withoutUndefined<ExternalAgentErrorEvent>({
        type: "error",
        message: value.message,
        code: stringValue(value.code),
        recoverable:
          typeof value.recoverable === "boolean"
            ? value.recoverable
            : isRecoverableMessage(value.message),
        timestamp,
      });
    default:
      return undefined;
  }
}

function withoutUndefined<T extends object>(value: T): T {
  return removeUndefined(value as Record<string, unknown>) as T;
}

/**
 * Whether an error message describes a condition a retry may fix.
 *
 * @remarks
 * Uses the shared classifier: auth, billing, quota and missing-binary
 * messages are not recoverable; anything unknown is.
 *
 * @param message - The error text.
 * @returns The classifier's verdict.
 */
export function isRecoverableMessage(message: string): boolean {
  return classifyRecoverable({ message, defaultRecoverable: true }).recoverable;
}

/** Longest message {@link exitErrorEvent} reports, in characters. */
const EXIT_MESSAGE_CHARS = 4096;

/**
 * The `error` event for a CLI that exited with a non-zero code.
 *
 * @remarks
 * The message is the stderr tail, cut to its last 4096 characters, or
 * `<runtime> exited with code <n>` when stderr was empty. The code is fixed
 * per runtime. Recoverability comes from {@link isRecoverableMessage} applied
 * to the last non-blank line, where a CLI prints its final error, so an
 * earlier warning (a missing settings file, a deprecation) does not decide
 * it; an auth or quota failure there is not retried.
 *
 * @param options - The runtime name, exit code, stderr tail and event code.
 * @returns The error event.
 */
export function exitErrorEvent(options: {
  runtime: string;
  exitCode: number;
  stderr: readonly string[];
  code: string;
}): ExternalAgentErrorEvent {
  const lines = options.stderr
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const tail = lines.join("\n");
  const message = tail
    ? tail.length > EXIT_MESSAGE_CHARS
      ? `...${tail.slice(-(EXIT_MESSAGE_CHARS - 3))}`
      : tail
    : `${options.runtime} exited with code ${options.exitCode}`;
  const classified = lines.at(-1) ?? message;
  return {
    type: "error",
    message,
    code: options.code,
    recoverable: isRecoverableMessage(classified),
    timestamp: Date.now(),
  };
}

/**
 * The credential variables a run may pass to its child process.
 *
 * @remarks
 * Only an `env` credential contributes, and only the keys in the provider's
 * `envAllowlist` with a non-empty value.
 *
 * @param request - The run.
 * @returns The allowed credential variables.
 */
export function credentialEnv(
  request: ExternalAgentRunRequest,
): Record<string, string> {
  return request.credential?.kind === "env"
    ? readAllowedEnv(
        request.credential.env ?? {},
        request.provider.envAllowlist,
      )
    : {};
}

/**
 * Builds a child environment from an allowlist.
 *
 * @remarks
 * Security invariant: the result never copies the whole parent environment.
 * It holds the `baseKeys` that are set in `source`, then the
 * {@link credentialEnv} variables, which win over the ambient values.
 *
 * @param source - The parent environment.
 * @param baseKeys - Ambient variables the runtime needs, such as `PATH`.
 * @param request - The run, for its credential.
 * @returns The child environment.
 */
export function buildChildEnv(
  source: Record<string, string | undefined>,
  baseKeys: readonly string[],
  request: ExternalAgentRunRequest,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of baseKeys) {
    copyIfPresent(source, env, key);
  }
  return Object.assign(env, credentialEnv(request));
}

/**
 * Finds a runtime executable: an explicit path wins, else the first candidate
 * that exists.
 *
 * @remarks
 * An explicit path is returned without checking that it exists, so the
 * runtime reports the precise failure.
 *
 * @param explicit - Configured paths, in priority order; empty ones are skipped.
 * @param candidates - Paths to probe, in order.
 * @returns The path found, if any, and every path considered, in order.
 */
export function findExecutable(
  explicit: ReadonlyArray<string | undefined>,
  candidates: readonly string[],
): { path?: string; checked: string[] } {
  const checked: string[] = [];
  const chosen = firstNonEmpty(...explicit);
  if (chosen) {
    checked.push(chosen);
    return { path: chosen, checked };
  }
  for (const candidate of candidates) {
    checked.push(candidate);
    if (existsSync(candidate)) {
      return { path: candidate, checked };
    }
  }
  return { checked };
}

/**
 * Where to look for a runtime executable.
 *
 * @remarks
 * Order: each `PATH` directory, then `extraDirs`, then for each
 * {@link candidateBaseDirectories} entry its `node_modules/.bin` and the
 * paths `packagePaths` returns for it. Duplicates are dropped.
 *
 * Security invariant: every candidate whose canonical path is at or under
 * one of `excluded` is dropped, wherever it comes from (a `PATH` entry such
 * as the `node_modules/.bin` a package-manager script adds, an extra
 * directory, or a symlink into the root). Explicit executable paths are not
 * candidates and are never filtered.
 *
 * @param options - The executable name, the parent environment, extra
 * directories, a per-base package path builder and the roots the agent may
 * write ({@link agentWritableRoots}).
 * @returns Absolute candidate paths.
 */
export function executableCandidates(options: {
  executable: string;
  env: Record<string, string | undefined>;
  extraDirs?: ReadonlyArray<string | undefined>;
  packagePaths?: (base: string) => readonly string[];
  excluded: readonly string[];
}): string[] {
  const candidates = new Set<string>();
  const dirs = [
    ...(options.env.PATH ?? "").split(delimiter),
    ...(options.extraDirs ?? []),
  ];
  for (const dir of dirs) {
    if (dir && dir.length > 0) {
      candidates.add(join(dir, options.executable));
    }
  }
  for (const base of candidateBaseDirectories()) {
    candidates.add(join(base, "node_modules", ".bin", options.executable));
    for (const path of options.packagePaths?.(base) ?? []) {
      candidates.add(path);
    }
  }
  return [...candidates].filter((path) =>
    isSearchableExecutable(path, options.excluded),
  );
}

/**
 * The message for an SDK that could not find its runtime executable.
 *
 * @param options - What was not found, how to fix it, the original error and
 * the paths checked.
 * @returns A multi-line message that lists the checked paths.
 */
export function describeMissingExecutable(options: {
  headline: string;
  hint: string;
  original: string;
  checked: readonly string[];
}): string {
  const checked =
    options.checked.length > 0
      ? options.checked.map((item) => `  - ${item}`).join("\n")
      : "  - <no candidates>";
  return [
    options.headline,
    options.hint,
    `Original error: ${options.original}`,
    "Checked paths:",
    checked,
  ].join("\n");
}

/**
 * Rejects driver options that could only fail later, or be silently ignored.
 *
 * @remarks
 * Checks the fields that are set: `command` is a non-empty string,
 * `killGraceMs` a finite number of at least 0, `maxTurns` a positive
 * integer.
 *
 * @param driver - The driver name, for the message.
 * @param config - The options to check.
 * @throws InputValidationError (from `@google/adk`) naming the first invalid
 * option.
 */
export function validateDriverConfig(
  driver: string,
  config: { command?: unknown; killGraceMs?: unknown; maxTurns?: unknown },
): void {
  if (
    config.command !== undefined &&
    (typeof config.command !== "string" || config.command.trim() === "")
  ) {
    throw new InputValidationError(
      `${driver}: command must be a non-empty string.`,
    );
  }
  if (
    config.killGraceMs !== undefined &&
    !(
      typeof config.killGraceMs === "number" &&
      Number.isFinite(config.killGraceMs) &&
      config.killGraceMs >= 0
    )
  ) {
    throw new InputValidationError(
      `${driver}: killGraceMs must be a finite number of milliseconds, 0 or more.`,
    );
  }
  if (
    config.maxTurns !== undefined &&
    !(
      typeof config.maxTurns === "number" &&
      Number.isSafeInteger(config.maxTurns) &&
      config.maxTurns > 0
    )
  ) {
    throw new InputValidationError(
      `${driver}: maxTurns must be a positive integer.`,
    );
  }
}
