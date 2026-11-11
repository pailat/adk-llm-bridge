/**
 * Keeps Claude Code's large-tool-result files off disk for a run that holds
 * MCP secrets.
 *
 * Claude Code saves a tool result larger than its inline limit to
 * `<config dir>/projects/<project key>/<session id>/tool-results/<name>.txt`
 * and hands the model that path, even with `persistSession: false`. An MCP
 * tool that echoes a header would leave the raw secret there, and the agent
 * could read the file back. When that directory cannot be made, Claude Code
 * falls back to an inline, truncated result and writes nothing.
 *
 * The guard reserves `<session id>` as an empty, read-only file before the
 * run starts, with a session id the driver chooses, so the `tool-results`
 * folder can never be made under it. `matches` confirms, from the runtime's
 * hook input, that the run really uses that session and project folder; the
 * driver ends the run when it does not. `stillReserved` confirms, before each
 * tool call and on each message, that nobody removed or replaced the file;
 * `scrubLeftover` rewrites a spill folder that appeared anyway.
 */

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Longest project key Claude Code uses as is; a longer one gets a hash
 * suffix this module does not reproduce.
 */
export const CLAUDE_PROJECT_KEY_MAX = 200;

/**
 * Claude Code's folder name for a project: every character other than an
 * ASCII letter or digit becomes `-`. `undefined` when the name is longer than
 * {@link CLAUDE_PROJECT_KEY_MAX}, because Claude Code then shortens it with a
 * hash.
 */
export function claudeProjectKey(path: string): string | undefined {
  const key = path.replace(/[^a-zA-Z0-9]/g, "-");
  return key.length <= CLAUDE_PROJECT_KEY_MAX ? key : undefined;
}

/** What identifies the reserved file: it must also stay empty. */
export interface ReservedFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly ctimeNs: bigint;
}

/** The parts of a `bigint` stat that {@link sameReservedFile} reads. */
export interface ReservedFileStats {
  isFile(): boolean;
  readonly size: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly ctimeNs: bigint;
}

/**
 * Whether `stats` (from `lstat`, never following a link) describe the file
 * the guard made: a regular, still empty file with the same device, inode
 * and change time. A file system may give a deleted file's inode to the
 * next one, so the change time and the size count on their own.
 */
export function sameReservedFile(
  identity: ReservedFileIdentity,
  stats: ReservedFileStats,
): boolean {
  return (
    stats.isFile() &&
    stats.size === 0n &&
    stats.dev === identity.dev &&
    stats.ino === identity.ino &&
    stats.ctimeNs === identity.ctimeNs
  );
}

/** What is at the reserved path now. */
export type ClaudeSpillPathState = "reserved" | "missing" | "folder" | "other";

/** A reserved session path; release it when the run ends. */
export interface ClaudeSpillReservation {
  /** `<config dir>/projects/<project key>/<session id>`, an empty file. */
  readonly path: string;
  /**
   * Whether a hook input names the reserved session in the reserved project
   * folder: `session_id` equals it and `transcript_path` is
   * `<project folder>/<session id>.jsonl`, compared by real path.
   */
  matches(input: Readonly<Record<string, unknown>>): boolean;
  /** Whether the reserved file is still there, unchanged (one `lstat`). */
  stillReserved(): boolean;
  /**
   * What is at the reserved path: the reserved file, nothing, a folder (in
   * which Claude Code may have saved tool results), or something else.
   */
  inspect(): ClaudeSpillPathState;
  /**
   * When a folder took the reserved file's place: rewrites every regular
   * file under it with `scrub` applied, without following links, and keeps
   * the folder for the host to inspect. Returns the files seen and the files
   * rewritten.
   */
  scrubLeftover(scrub: (text: string) => string): {
    files: number;
    rewritten: number;
  };
  /**
   * Removes the reserved file, if it is still the one made here (same
   * device, inode and change time, still empty), and the empty folders made
   * for it. Safe to call more than once.
   */
  release(): void;
}

/** The longest session id the guard reserves (a UUID is 36 characters). */
const SESSION_ID_MAX = 64;

/** Inputs of {@link reserveClaudeSpillPath}. */
export interface ClaudeSpillReservationOptions {
  /** Claude Code's config dir (`CLAUDE_CONFIG_DIR` or `~/.claude`). */
  readonly configDir: string;
  /** The run's working directory; it must exist. */
  readonly workingDirectory: string;
  /** The session id the run will use. */
  readonly sessionId: string;
}

/**
 * Reserves `<config dir>/projects/<project key>/<session id>` as an empty
 * read-only file. Throws when the path already exists, the project key would
 * be hashed, or the file cannot be made.
 */
export function reserveClaudeSpillPath(
  options: ClaudeSpillReservationOptions,
): ClaudeSpillReservation {
  const { configDir, sessionId } = options;
  if (!/^[A-Za-z0-9-]+$/.test(sessionId) || sessionId.length > SESSION_ID_MAX) {
    throw new Error("spill guard: the session id is not a plain id");
  }
  let cwd: string;
  try {
    cwd = realpathSync(options.workingDirectory);
  } catch {
    throw new Error(
      "spill guard: could not resolve the working directory to reserve the session path",
    );
  }
  const key = claudeProjectKey(cwd);
  if (key === undefined) {
    throw new Error(
      `spill guard: the project key for the working directory is longer than ${CLAUDE_PROJECT_KEY_MAX} characters`,
    );
  }
  const projectDir = join(configDir, "projects", key);
  const path = join(projectDir, sessionId);

  const created: string[] = [];
  const removeCreated = () => {
    for (const dir of [...created].reverse()) {
      try {
        rmdirSync(dir);
      } catch {
        // Not empty or already gone: leave it.
      }
    }
  };

  let identity: ReservedFileIdentity;
  let realProjectDir: string;
  try {
    const missing: string[] = [];
    for (let dir = projectDir; !existsSync(dir); dir = dirname(dir)) {
      missing.unshift(dir);
      if (dirname(dir) === dir) break;
    }
    for (const dir of missing) {
      mkdirSync(dir, { mode: 0o700 });
      created.push(dir);
    }
    realProjectDir = realpathSync(projectDir);
  } catch {
    removeCreated();
    throw new Error("spill guard: could not reserve the session path");
  }
  try {
    const fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o400,
    );
    try {
      const stats = fstatSync(fd, { bigint: true });
      identity = { dev: stats.dev, ino: stats.ino, ctimeNs: stats.ctimeNs };
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    removeCreated();
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("spill guard: the session path already exists");
    }
    throw new Error("spill guard: could not reserve the session path");
  }

  let released = false;
  const stillReserved = () => {
    try {
      return sameReservedFile(identity, lstatSync(path, { bigint: true }));
    } catch {
      return false;
    }
  };
  return {
    path,
    stillReserved,
    inspect() {
      if (stillReserved()) return "reserved";
      try {
        return lstatSync(path).isDirectory() ? "folder" : "other";
      } catch {
        return "missing";
      }
    },
    scrubLeftover(scrub) {
      const counts = { files: 0, rewritten: 0 };
      const walk = (dir: string) => {
        let entries: string[];
        try {
          entries = readdirSync(dir);
        } catch {
          return;
        }
        for (const name of entries) {
          const entry = join(dir, name);
          let stats: ReturnType<typeof lstatSync>;
          try {
            stats = lstatSync(entry);
          } catch {
            continue;
          }
          if (stats.isDirectory()) {
            walk(entry);
          } else if (stats.isFile()) {
            counts.files++;
            try {
              const fd = openSync(
                entry,
                constants.O_RDWR | constants.O_NOFOLLOW,
              );
              try {
                const text = readFileSync(fd, "utf8");
                const clean = scrub(text);
                if (clean !== text) {
                  // Through the same no-follow descriptor: cut, then write.
                  ftruncateSync(fd, 0);
                  writeSync(fd, clean, 0, "utf8");
                  counts.rewritten++;
                }
              } finally {
                closeSync(fd);
              }
            } catch {
              // Unreadable: counted as seen, not rewritten.
            }
          }
        }
      };
      try {
        if (lstatSync(path).isDirectory()) walk(path);
      } catch {
        // Nothing there.
      }
      return counts;
    },
    matches(input) {
      if (input.session_id !== sessionId) return false;
      const transcript = input.transcript_path;
      if (typeof transcript !== "string") return false;
      if (basename(transcript) !== `${sessionId}.jsonl`) return false;
      try {
        return realpathSync(dirname(transcript)) === realProjectDir;
      } catch {
        return false;
      }
    },
    release() {
      if (released) return;
      released = true;
      if (stillReserved()) {
        try {
          unlinkSync(path);
        } catch {
          // Already gone.
        }
      }
      removeCreated();
    },
  };
}
