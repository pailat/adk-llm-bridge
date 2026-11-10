/**
 * Per-run pieces of the Claude Code environment shared by the Claude Agent
 * SDK and CLI drivers: background tasks off for headless runs, a private
 * temp directory, and the check that a run does not end while a background
 * task it started is still running.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { warn } from "../../utils/log.js";
import type { ExternalAgentEvent } from "../events.js";
import { EXTERNAL_AGENT_BACKGROUND_TASK_PENDING } from "./policy-errors.js";
import { asRecord, stringValue } from "./shared.js";

/**
 * The Claude Code variable that turns background tasks off: the Bash tool
 * loses its `run_in_background` parameter, the Agent tool runs subagents in
 * the foreground, and a request to background a running task is refused.
 */
export const CLAUDE_DISABLE_BACKGROUND_TASKS_ENV =
  "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS";

/**
 * Sets {@link CLAUDE_DISABLE_BACKGROUND_TASKS_ENV} in a child environment
 * unless the driver allows background tasks.
 *
 * @remarks
 * A headless run ends at its `result`; nothing delivers the notification of
 * a task still running in the background, so the model would stop while
 * waiting for it and the run would report success with the work undone. Set
 * last, so no credential variable can turn it back on.
 *
 * @param env - The child environment, changed in place.
 * @param allowBackgroundTasks - The driver's opt-out.
 */
export function applyBackgroundTaskSetting(
  env: Record<string, string | undefined>,
  allowBackgroundTasks: boolean,
): void {
  if (allowBackgroundTasks) {
    delete env[CLAUDE_DISABLE_BACKGROUND_TASKS_ENV];
    return;
  }
  env[CLAUDE_DISABLE_BACKGROUND_TASKS_ENV] = "1";
}

/** A temp directory one run owns; see {@link createClaudeRunTempDir}. */
export interface ClaudeRunTempDir {
  /** `CLAUDE_CODE_TMPDIR` and `TMPDIR` for the child environment. */
  readonly env: { CLAUDE_CODE_TMPDIR: string; TMPDIR: string };
  /** Removes the directory and everything in it. Never throws. */
  dispose(): void;
}

/** Short root, so the per-user directory under it fits a Unix socket path. */
const RUN_TEMP_PARENT = "/tmp";

/**
 * Creates a fresh `0700` directory for one run and points Claude Code's temp
 * root at it.
 *
 * @remarks
 * Without it Claude Code uses the per-user `/tmp/claude-<uid>` that every
 * session of the user shares, and the drivers do not forward the host's
 * `TMPDIR`, so a shell command that does not get Claude Code's `TMPDIR`
 * makes temp files in the platform default (`/var/folders/.../T` on macOS),
 * which the sandbox does not let it write. With `CLAUDE_CODE_TMPDIR` set to
 * the new directory, Claude Code puts its per-user directory inside it,
 * keeps that one writable in the sandbox, and gives it to shell commands as
 * `TMPDIR`; the child's own `TMPDIR` is the same directory. Nothing outside
 * the new directory becomes writable: it is created by `mkdtemp` (a unique
 * name, no existing path reused) under `/tmp`, which the sandbox already
 * treats as temp space. Not used on Windows, where Claude Code chooses its
 * own temp directory.
 *
 * @returns The directory, or `undefined` on Windows or when it cannot be
 * created (a warning names why; the run then uses Claude Code's default).
 */
export function createClaudeRunTempDir(): ClaudeRunTempDir | undefined {
  if (process.platform === "win32") return undefined;
  let root: string | undefined;
  try {
    root = realpathSync(mkdtempSync(join(RUN_TEMP_PARENT, "adk-claude-")));
    const uid = process.getuid?.() ?? 0;
    const tmp = join(root, `claude-${uid}`);
    mkdirSync(tmp, { mode: 0o700 });
    const created = root;
    return {
      env: { CLAUDE_CODE_TMPDIR: created, TMPDIR: tmp },
      dispose: () => removeQuietly(created),
    };
  } catch (error) {
    if (root) removeQuietly(root);
    warn(
      "CLAUDE_RUN_TEMP_DIR_UNAVAILABLE",
      `Could not create a private temp directory for the Claude run (${error instanceof Error ? error.message : String(error)}); Claude Code uses its default temp directory.`,
    );
    return undefined;
  }
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Best effort: the run's outcome does not depend on the cleanup.
  }
}

/** One background task Claude Code reported as live. */
export interface ClaudeBackgroundTask {
  /** The task id. */
  id: string;
  /** Task kind, for example `local_bash` or `local_agent`. */
  type: string;
  /** The task's description, as Claude Code reported it. */
  description: string;
}

/**
 * Tracks the background tasks a run has live, from Claude Code's
 * `system/background_tasks_changed` messages.
 *
 * @remarks
 * Each message carries the full set (replace semantics). Ambient tasks
 * (watchers and other tasks that are not work) are ignored. A Claude Code
 * version that does not send the message leaves the set empty; the
 * {@link CLAUDE_DISABLE_BACKGROUND_TASKS_ENV} default is the first guard.
 */
export class ClaudeBackgroundTaskTracker {
  #tasks: ClaudeBackgroundTask[] = [];

  /**
   * Reads one message; anything but `background_tasks_changed` is ignored.
   *
   * @param message - One SDK message or parsed `stream-json` line.
   */
  observe(message: unknown): void {
    const record = asRecord(message);
    if (
      record.type !== "system" ||
      record.subtype !== "background_tasks_changed" ||
      !Array.isArray(record.tasks)
    ) {
      return;
    }
    this.#tasks = record.tasks.flatMap((item) => {
      const task = asRecord(item);
      const id = stringValue(task.task_id);
      if (!id || task.ambient === true) return [];
      return [
        {
          id,
          type: stringValue(task.task_type) ?? "unknown",
          description: stringValue(task.description) ?? "",
        },
      ];
    });
  }

  /** The live, non-ambient background tasks. */
  pending(): readonly ClaudeBackgroundTask[] {
    return this.#tasks;
  }
}

/**
 * The `error` event for a run that ended while background tasks were still
 * running. Not recoverable: the same instruction would end the same way.
 *
 * @param tasks - The live tasks.
 * @param runtime - The runtime name, for the message.
 * @returns The error event.
 */
export function backgroundTaskPendingEvent(
  tasks: readonly ClaudeBackgroundTask[],
  runtime: string,
): ExternalAgentEvent {
  const listed = tasks
    .slice(0, 5)
    .map((task) =>
      task.description
        ? `${task.id} (${task.type}: ${task.description.slice(0, 120)})`
        : `${task.id} (${task.type})`,
    )
    .join(", ");
  const more = tasks.length > 5 ? ` and ${tasks.length - 5} more` : "";
  return {
    type: "error",
    message: `${runtime}: the run ended while ${tasks.length} background task${tasks.length === 1 ? " was" : "s were"} still running (${listed}${more}). A headless run cannot wait for them, so their work is not done. Keep background tasks off (the default) or have the agent run the commands in the foreground.`,
    code: EXTERNAL_AGENT_BACKGROUND_TASK_PENDING,
    recoverable: false,
    timestamp: Date.now(),
  };
}
