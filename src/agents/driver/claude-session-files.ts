/**
 * The one place outside `allowedPaths` a confined Claude agent may read: the
 * `tool-results` directory of its own Claude Code session. When a tool result
 * is too large to keep inline, Claude Code saves it to
 * `<config dir>/projects/<project>/<session id>/tool-results/<id>.txt` and
 * tells the model to `Read` that file. Internal: not re-exported from a
 * barrel.
 */

import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { canonicalPath, isUnder } from "../permissions/paths.js";
import { stringValue } from "./shared.js";

/** A Claude Code session id: a UUID, so it cannot hold a path separator. */
const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The only tool the allowance covers: Claude Code's file reader. */
const SESSION_READ_TOOL = "Read";

/** Input keys of a `Read` call; a call with any other key is not allowed. */
const READ_INPUT_KEYS: ReadonlySet<string> = new Set([
  "file_path",
  "offset",
  "limit",
  "pages",
]);

/**
 * The Claude Code configuration directory the runtime uses with `env`:
 * `CLAUDE_CONFIG_DIR`, else `.claude` under `HOME` (else the host's home
 * directory).
 *
 * @param env - The environment the driver gives the runtime.
 * @returns The directory, or `undefined` when `CLAUDE_CONFIG_DIR` or `HOME`
 * is set but not absolute (the runtime would resolve it against a directory
 * the bridge does not know).
 */
export function claudeConfigDir(
  env: Record<string, string | undefined>,
): string | undefined {
  const configured = env.CLAUDE_CONFIG_DIR;
  if (configured) {
    return isAbsolute(configured) ? configured : undefined;
  }
  const home = env.HOME || homedir();
  return isAbsolute(home) ? join(home, ".claude") : undefined;
}

/** What {@link claudeSessionToolResultsDir} derives the directory from. */
export interface ClaudeSessionFilesSource {
  /** The session id the driver read from the runtime's `system/init`. */
  sessionId: string | undefined;
  /** The `session_id` of the hook input that asks about the call. */
  hookSessionId: unknown;
  /** The `transcript_path` of the same hook input. */
  transcriptPath: unknown;
  /** The runtime's configuration directory; see {@link claudeConfigDir}. */
  configDir: string | undefined;
}

/**
 * The canonical `tool-results` directory of the session the driver started.
 *
 * @remarks
 * Every part comes from the runtime, none from the model: the session id from
 * `system/init`, the transcript path from the hook input. It fails closed
 * (returns `undefined`) unless the session id is a UUID, the hook reports the
 * same session, and the transcript is `<session id>.jsonl` directly inside a
 * project directory of `<config dir>/projects`, after symlinks are resolved,
 * and neither the session directory nor `tool-results` is a symlink.
 * A custom session store that keeps transcripts elsewhere gets no allowance.
 *
 * @param source - The session id, the hook input fields and the config dir.
 * @returns The directory, or `undefined` when it cannot be derived safely.
 */
export function claudeSessionToolResultsDir(
  source: ClaudeSessionFilesSource,
): string | undefined {
  const { sessionId, configDir } = source;
  const transcriptPath = stringValue(source.transcriptPath);
  if (
    sessionId === undefined ||
    !SESSION_ID.test(sessionId) ||
    stringValue(source.hookSessionId) !== sessionId ||
    configDir === undefined ||
    transcriptPath === undefined ||
    !isAbsolute(transcriptPath) ||
    basename(transcriptPath) !== `${sessionId}.jsonl`
  ) {
    return undefined;
  }
  const projectsRoot = canonicalPath(join(configDir, "projects"), "/");
  const projectDir = canonicalPath(dirname(transcriptPath), "/");
  if (
    projectsRoot === undefined ||
    projectDir === undefined ||
    dirname(projectDir) !== projectsRoot
  ) {
    return undefined;
  }
  // The directory itself must not be a link: one to `/` would widen the
  // allowance to every file on the machine.
  const toolResultsDir = join(projectDir, sessionId, "tool-results");
  return canonicalPath(toolResultsDir, "/") === toolResultsDir
    ? toolResultsDir
    : undefined;
}

/**
 * Whether a tool call reads a file inside the session's `tool-results`
 * directory, and nothing else.
 *
 * @remarks Only `Read` (exact spelling) with `file_path` and the paging keys
 * qualifies; any other key, a relative path that resolves elsewhere, a
 * symlink that leaves the directory, or the directory itself is refused.
 *
 * @param toolResultsDir - From {@link claudeSessionToolResultsDir}.
 * @param toolName - The tool name as the runtime reports it.
 * @param toolInput - The call's input.
 * @param workingDirectory - Base for a relative `file_path`.
 * @returns `true` only for such a read.
 */
export function isSessionToolResultsRead(
  toolResultsDir: string | undefined,
  toolName: string,
  toolInput: Record<string, unknown>,
  workingDirectory: string,
): boolean {
  if (toolResultsDir === undefined || toolName !== SESSION_READ_TOOL) {
    return false;
  }
  if (Object.keys(toolInput).some((key) => !READ_INPUT_KEYS.has(key))) {
    return false;
  }
  const filePath = stringValue(toolInput.file_path);
  if (filePath === undefined) {
    return false;
  }
  const path = canonicalPath(filePath, workingDirectory);
  return (
    path !== undefined &&
    path !== toolResultsDir &&
    isUnder(path, toolResultsDir)
  );
}
