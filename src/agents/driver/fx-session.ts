import { randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { InvocationContext } from "@google/adk";

/**
 * One fx session directory (`~/.fx/sessions/v2/<id>`: the log, the blobs and
 * the lock file), as plain data a {@link FxSessionStore} can keep.
 *
 * @remarks
 * fx 0.0.16 resumes a session from a copy of its whole directory, so the
 * bundle holds every file under it, blobs included, and the directory
 * structure. `version` is the bundle format, `1` today.
 *
 * @experimental
 */
export interface FxSessionBundle {
  /** Bundle format. */
  version: 1;
  /** Directories of the session, relative to its root, in creation order. */
  directories: string[];
  /** Files of the session; `path` is relative to its root, `base64` the bytes. */
  files: { path: string; base64: string }[];
}

/**
 * Durable storage for fx session directories, so a session survives a host
 * change: `FxCliDriver` saves the directory after a turn and restores it when
 * a resume finds it missing.
 *
 * @experimental
 */
export interface FxSessionStore {
  /**
   * Stores the session directory of `id`, replacing an earlier copy.
   *
   * @param id - The fx session id.
   * @param bundle - The whole directory.
   */
  save(id: string, bundle: FxSessionBundle): Promise<void>;
  /**
   * Reads the stored directory of `id`.
   *
   * @param id - The fx session id.
   * @returns The bundle, or `undefined` when nothing is stored for `id`.
   */
  load(id: string): Promise<FxSessionBundle | undefined>;
}

/**
 * Builds a {@link FxSessionStore} for one run from its invocation context.
 *
 * @experimental
 */
export type FxSessionStoreFactory = (run: {
  context: InvocationContext;
}) => FxSessionStore;

/** An fx session id is a plain token: it names a directory and a CLI argument. */
const PLAIN_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Whether `value` can be used as an fx session id: 1 to 128 letters, digits,
 * `_` or `-`, including a leading `-`, except the bare tokens `-` and `--`.
 *
 * @internal
 */
export function isFxSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    PLAIN_SESSION_ID.test(value) &&
    value !== "-" &&
    value !== "--"
  );
}

/** Describe a rejected id without revealing its contents. @internal */
export function describeFxSessionId(value: unknown): string {
  if (typeof value !== "string") return "non-string id";
  const first = value.charAt(0);
  const kind = /^[A-Za-z]$/.test(first)
    ? "letter"
    : /^[0-9]$/.test(first)
      ? "digit"
      : first === "-"
        ? "-"
        : first === "_"
          ? "_"
          : "other";
  return `length ${value.length}, first character: ${kind}`;
}

/**
 * The directory fx keeps session `id` in, under the home directory.
 *
 * @internal
 */
export function fxSessionDirectory(home: string, id: string): string {
  return join(home, ".fx", "sessions", "v2", id);
}

/**
 * Reads a whole session directory into a bundle. Symbolic links are not
 * followed and not stored.
 *
 * @internal
 */
export function readFxSessionBundle(root: string): FxSessionBundle {
  const directories: string[] = [];
  const files: FxSessionBundle["files"] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const path = relative(root, full).split(sep).join("/");
      const stat = lstatSync(full);
      if (stat.isDirectory()) {
        directories.push(path);
        walk(full);
      } else if (stat.isFile()) {
        files.push({
          path,
          base64: readFileSync(full).toString("base64"),
        });
      }
    }
  };
  walk(root);
  return { version: 1, directories, files };
}

/** The absolute path of a bundle entry, or an error when it leaves `root`. */
function insideRoot(root: string, path: string): string {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    throw new Error("a stored fx session has an empty or invalid path");
  }
  const target = resolve(root, path);
  if (
    target === root ||
    !target.startsWith(root + sep) ||
    path.split(/[\\/]/).includes("..")
  ) {
    throw new Error(
      `a stored fx session has a path outside its directory: ${path.slice(0, 80)}`,
    );
  }
  return target;
}

/**
 * Writes a bundle under `root`. Every path is checked first; one that leaves
 * `root` rejects the whole bundle before anything is written.
 *
 * @remarks
 * The files go into a sibling temporary directory that is renamed onto `root`
 * once complete, so a failed write never leaves a partial `root` behind that
 * a later run would take for a finished session. The temporary directory is
 * removed on any error.
 *
 * @internal
 */
export function restoreFxSessionBundle(
  root: string,
  bundle: FxSessionBundle,
): void {
  const absoluteRoot = resolve(root);
  // Validate against the final root, then rebase onto the temporary one.
  const directories = bundle.directories.map((path) =>
    insideRoot(absoluteRoot, path),
  );
  const files = bundle.files.map((file) => ({
    target: insideRoot(absoluteRoot, file.path),
    bytes: Buffer.from(file.base64, "base64"),
  }));
  const temporary = `${absoluteRoot}.restore-${randomBytes(6).toString("hex")}`;
  const rebase = (target: string): string =>
    join(temporary, relative(absoluteRoot, target));
  mkdirSync(dirname(absoluteRoot), { recursive: true });
  try {
    mkdirSync(temporary);
    for (const directory of directories) {
      mkdirSync(rebase(directory), { recursive: true });
    }
    for (const file of files) {
      const target = rebase(file.target);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.bytes);
    }
    renameSync(temporary, absoluteRoot);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Whether `value` has the shape of a {@link FxSessionBundle}.
 *
 * @internal
 */
export function isFxSessionBundle(value: unknown): value is FxSessionBundle {
  if (typeof value !== "object" || value === null) return false;
  const bundle = value as Record<string, unknown>;
  return (
    bundle.version === 1 &&
    Array.isArray(bundle.directories) &&
    bundle.directories.every((entry) => typeof entry === "string") &&
    Array.isArray(bundle.files) &&
    bundle.files.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).path === "string" &&
        typeof (entry as Record<string, unknown>).base64 === "string",
    )
  );
}
