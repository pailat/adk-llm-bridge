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
 * `allowedPaths` an array of strings and `pathBounds` an array of string
 * arrays.
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
  const { mode, allowNetwork, allowedPaths, pathBounds } = value as Record<
    string,
    unknown
  >;
  if (typeof mode !== "string" || !PERMISSION_MODES.has(mode)) return null;
  if (allowNetwork !== undefined && typeof allowNetwork !== "boolean") {
    return null;
  }
  let paths: readonly string[] | undefined;
  if (allowedPaths !== undefined) {
    if (!Array.isArray(allowedPaths)) return null;
    const copy = [...allowedPaths];
    if (!copy.every((path) => typeof path === "string")) return null;
    paths = Object.freeze(copy);
  }
  let bounds: readonly (readonly string[])[] | undefined;
  if (pathBounds !== undefined) {
    if (!Array.isArray(pathBounds)) return null;
    const lists: (readonly string[])[] = [];
    for (const list of [...pathBounds]) {
      if (!Array.isArray(list)) return null;
      const copy = [...list];
      if (!copy.every((path) => typeof path === "string")) return null;
      lists.push(Object.freeze(copy));
    }
    bounds = Object.freeze(lists);
  }
  return Object.freeze({
    mode: mode as ExternalAgentPermissionPolicy["mode"],
    ...(allowNetwork !== undefined ? { allowNetwork } : {}),
    ...(paths ? { allowedPaths: paths } : {}),
    ...(bounds ? { pathBounds: bounds } : {}),
  });
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
 * an `allowedPaths` that is not an array of strings or a `pathBounds` that is
 * not an array of string arrays.
 */
export function assertPermissionPolicy(
  value: unknown,
  owner: string,
): ExternalAgentPermissionPolicy | undefined {
  const policy = snapshotPermissionPolicy(value);
  if (policy === null) {
    throw new InputValidationError(
      `${owner}: permissions must be { mode: "read-only" | "ask" | "workspace-write" | "full-access", allowNetwork?: boolean, allowedPaths?: string[], pathBounds?: string[][] }.`,
    );
  }
  return policy;
}
