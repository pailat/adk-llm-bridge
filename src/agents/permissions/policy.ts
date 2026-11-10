/**
 * Internal permission policy validation shared by the agent and the tool
 * gateway. Not part of the public API: do not re-export from any barrel.
 */

import { InputValidationError } from "@google/adk";
import type { ExternalAgentPermissionPolicy } from "./schema.js";

const PERMISSION_MODES: ReadonlySet<string> = new Set([
  "read-only",
  "ask",
  "workspace-write",
  "full-access",
]);

/**
 * Validated, deep-frozen copy of a permission policy.
 *
 * @remarks
 * Only the known fields are copied, so extra or accessor-backed fields cannot
 * leak through. `mode` must be a known mode, `allowNetwork` a boolean,
 * `allowedPaths` and `readPaths` arrays of strings and `pathBounds` and
 * `readPathBounds` arrays of string arrays. `readPaths` needs `allowedPaths`:
 * without it paths are not restricted, so read roots would mean nothing.
 *
 * @param value - Anything.
 * @returns The copy; `null` when `value` is not a well-formed policy;
 * `undefined` when there is no policy.
 */
export function snapshotPermissionPolicy(
  value: unknown,
): ExternalAgentPermissionPolicy | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const {
    mode,
    allowNetwork,
    allowedPaths,
    readPaths,
    pathBounds,
    readPathBounds,
  } = value as Record<string, unknown>;
  if (typeof mode !== "string" || !PERMISSION_MODES.has(mode)) return null;
  if (allowNetwork !== undefined && typeof allowNetwork !== "boolean") {
    return null;
  }
  const paths = snapshotPathList(allowedPaths);
  const reads = snapshotPathList(readPaths);
  const bounds = snapshotBoundLists(pathBounds);
  const readBounds = snapshotBoundLists(readPathBounds);
  if (paths === null || reads === null || bounds === null) return null;
  if (readBounds === null) return null;
  if (reads !== undefined && paths === undefined) return null;
  return Object.freeze({
    mode: mode as ExternalAgentPermissionPolicy["mode"],
    ...(allowNetwork !== undefined ? { allowNetwork } : {}),
    ...(paths ? { allowedPaths: paths } : {}),
    ...(reads ? { readPaths: reads } : {}),
    ...(bounds ? { pathBounds: bounds } : {}),
    ...(readBounds ? { readPathBounds: readBounds } : {}),
  });
}

/** A frozen copy of a string array; `null` when it is not one. */
function snapshotPathList(
  value: unknown,
): readonly string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const copy = [...value];
  if (!copy.every((path) => typeof path === "string")) return null;
  return Object.freeze(copy);
}

/** A frozen copy of an array of string arrays; `null` when it is not one. */
function snapshotBoundLists(
  value: unknown,
): readonly (readonly string[])[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const lists: (readonly string[])[] = [];
  for (const list of [...value]) {
    const copy = snapshotPathList(list);
    if (!copy) return null;
    lists.push(copy);
  }
  return Object.freeze(lists);
}

/**
 * Checks a configured permission policy and returns its snapshot.
 *
 * @remarks
 * `value` is read once, so a getter cannot pass the check with one policy
 * and hand a different one to the caller.
 *
 * @param value - The configured policy, or `undefined`.
 * @param owner - Who the policy belongs to, for the message.
 * @returns The validated, deep-frozen copy (see
 * {@link snapshotPermissionPolicy}); `undefined` when there is no policy.
 * @throws InputValidationError (from `@google/adk`) when `value` is set but is
 * not a well-formed policy: an unknown `mode`, a non-boolean `allowNetwork`,
 * an `allowedPaths` or `readPaths` that is not an array of strings, a
 * `pathBounds` or `readPathBounds` that is not an array of string arrays, or
 * `readPaths` without `allowedPaths`.
 */
export function assertPermissionPolicy(
  value: unknown,
  owner: string,
): ExternalAgentPermissionPolicy | undefined {
  const policy = snapshotPermissionPolicy(value);
  if (policy === null) {
    throw new InputValidationError(
      `${owner}: permissions must be { mode: "read-only" | "ask" | "workspace-write" | "full-access", allowNetwork?: boolean, allowedPaths?: string[], readPaths?: string[] (needs allowedPaths), pathBounds?: string[][], readPathBounds?: string[][] }.`,
    );
  }
  return policy;
}
