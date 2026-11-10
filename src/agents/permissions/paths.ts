/**
 * Path rules shared by the permission guard and policy inheritance: how a
 * path is made canonical and when one path is inside another.
 *
 * It imports only Node built-ins, so `permissions/inheritance.ts` stays free
 * of agent runtime imports.
 */

import { lstatSync, readlinkSync, realpathSync } from "node:fs";
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
import type { ExternalAgentPermissionPolicy } from "./schema.js";

/**
 * Whether a policy restricts paths at all: it sets `allowedPaths`,
 * `readPaths`, `pathBounds` or `readPathBounds`.
 *
 * @param policy - The effective policy, if any.
 * @returns `true` when a path rule applies.
 */
export function policySetsPaths(
  policy: ExternalAgentPermissionPolicy | undefined,
): policy is ExternalAgentPermissionPolicy {
  return (
    policy?.allowedPaths !== undefined ||
    policy?.readPaths !== undefined ||
    policy?.pathBounds !== undefined ||
    policy?.readPathBounds !== undefined
  );
}

/** Most symlinks {@link canonicalPath} follows by hand before it gives up. */
const MAX_SYMLINK_HOPS = 40;

/**
 * Absolute, normalized path with symlinks resolved.
 *
 * @remarks
 * A path that does not exist yet (a file about to be written) resolves its
 * deepest existing ancestor and appends the rest, so a symlinked parent is
 * still followed. A dangling symlink on the way (a link whose target does
 * not exist yet) is followed too, so the result is where a write through it
 * would land. A leading `~` is the home directory.
 *
 * @param value - The path, absolute or relative to `base`.
 * @param base - Directory a relative path is resolved against.
 * @returns The canonical path, or `undefined` when its symlinks cannot be
 * resolved (a loop, or more than 40 links), so a caller can fail closed.
 */
export function canonicalPath(value: string, base: string): string | undefined {
  let absolute = resolve(base, expandHome(value));
  for (let hops = 0; hops <= MAX_SYMLINK_HOPS; hops++) {
    const missing: string[] = [];
    let current = absolute;
    let target: string | undefined;
    for (;;) {
      try {
        return join(realpathSync.native(current), ...missing.reverse());
      } catch {
        target = danglingLinkTarget(current);
        if (target !== undefined) break;
        const parent = dirname(current);
        if (parent === current) {
          return absolute;
        }
        missing.push(basename(current));
        current = parent;
      }
    }
    absolute = join(resolve(dirname(current), target), ...missing.reverse());
  }
  return undefined;
}

/** The target of `path` when it is a symlink (dangling or looping), else `undefined`. */
function danglingLinkTarget(path: string): string | undefined {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined;
  } catch {
    return undefined;
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
