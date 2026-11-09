/**
 * Path rules shared by the permission guard and policy inheritance: how a
 * path is made canonical and when one path is inside another.
 *
 * It imports only Node built-ins, so `permissions/inheritance.ts` stays free
 * of agent runtime imports.
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

/**
 * Absolute, normalized path with symlinks resolved.
 *
 * @remarks
 * A path that does not exist yet (a file about to be written) resolves its
 * deepest existing ancestor and appends the rest, so a symlinked parent is
 * still followed. A leading `~` is the home directory.
 *
 * @param value - The path, absolute or relative to `base`.
 * @param base - Directory a relative path is resolved against.
 * @returns The canonical path.
 */
export function canonicalPath(value: string, base: string): string {
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

/**
 * Expands a leading `~` or `~/` to the home directory.
 *
 * @param value - A path.
 * @returns The path with the home directory expanded; other paths unchanged.
 */
export function expandHome(value: string): string {
  if (value === "~" || value.startsWith("~/")) {
    return join(homedir(), value.slice(1));
  }
  return value;
}

/**
 * Whether a path names a fixed place: absolute, or under the home directory
 * (`~`). Any other path depends on the directory it is resolved against.
 *
 * @param value - A path.
 * @returns `true` for an absolute or `~` path.
 */
export function isAnchoredPath(value: string): boolean {
  return isAbsolute(expandHome(value));
}

/**
 * Whether `path` is `root` or inside it. Both must be canonical (see
 * {@link canonicalPath}); `/repo2` is not inside `/repo`.
 *
 * @param path - The canonical path to test.
 * @param root - The canonical root.
 * @returns `true` when `path` is `root` or below it.
 */
export function isUnder(path: string, root: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

/**
 * Whether `path` is inside any of `roots`. All must be canonical.
 *
 * @param path - The canonical path to test.
 * @param roots - The canonical roots.
 * @returns `true` when `path` is under at least one root.
 */
export function isUnderAny(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => isUnder(path, root));
}
