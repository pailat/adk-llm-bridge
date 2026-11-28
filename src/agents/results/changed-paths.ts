import {
  normalizePortablePath,
  portablePathContains,
  portablePathProblem,
} from "../../workflows/internal/portable-path.js";

/**
 * Codes of the refusals {@link checkChangedPaths} returns.
 *
 * @remarks
 * - `CHANGED_PATH_INVALID`: the path is not a portable relative path (empty,
 *   absolute, with a backslash or NUL, with a `..` segment, or the root).
 * - `CHANGED_PATH_OUTSIDE_ALLOWED_PATHS`: no allowed path covers it.
 *
 * @experimental
 */
export const CHANGED_PATH_REFUSAL_CODES = Object.freeze([
  "CHANGED_PATH_INVALID",
  "CHANGED_PATH_OUTSIDE_ALLOWED_PATHS",
] as const);

/**
 * Code of a changed path refusal.
 *
 * @experimental
 */
export type ChangedPathRefusalCode =
  (typeof CHANGED_PATH_REFUSAL_CODES)[number];

/**
 * A changed path the lane was not allowed to change.
 *
 * @experimental
 */
export interface ChangedPathRefusal {
  /** Why the path is refused. */
  readonly code: ChangedPathRefusalCode;
  /** Index of the path in `changedPaths`. */
  readonly index: number;
  /** The path as the result spelled it. */
  readonly path: string;
  /** What is wrong, for people. */
  readonly message: string;
}

/**
 * Checks a result's `changedPaths` against the lane's allowed paths.
 *
 * @remarks
 * An allowed path covers the entry it names and everything below it; `.`
 * covers the whole project. A changed path is compared in canonical form, so
 * `./src/a.ts` and `src//a.ts` are both `src/a.ts`. Each refused path gets
 * one refusal, in the order of `changedPaths`; the host decides what a
 * refusal does to the run.
 *
 * @param result - A result with `changedPaths`, such as a parsed
 * `implement@1`.
 * @param allowedPaths - The lane's allowed paths, in canonical form with
 * forward slashes, as in a run spec lane's `allowedPaths`.
 * @returns The refusals; empty when every path is allowed.
 * @throws TypeError when an allowed path is not canonical. That is the
 * host's error, not the agent's.
 *
 * @experimental
 */
export function checkChangedPaths(
  result: { readonly changedPaths: readonly string[] },
  allowedPaths: readonly string[],
): ChangedPathRefusal[] {
  const allowed = allowedPaths.map((path) => {
    const problem = portablePathProblem(path, {
      canonical: true,
      allowRoot: true,
    });
    if (problem !== undefined) {
      throw new TypeError(`Allowed path ${JSON.stringify(path)} ${problem}`);
    }
    return path;
  });
  const refusals: ChangedPathRefusal[] = [];
  result.changedPaths.forEach((path, index) => {
    const problem = portablePathProblem(path);
    if (problem !== undefined) {
      refusals.push({
        code: "CHANGED_PATH_INVALID",
        index,
        path,
        message: `${JSON.stringify(path)} ${problem}`,
      });
      return;
    }
    const canonical = normalizePortablePath(path);
    if (!allowed.some((parent) => portablePathContains(parent, canonical))) {
      refusals.push({
        code: "CHANGED_PATH_OUTSIDE_ALLOWED_PATHS",
        index,
        path,
        message: `${path} is outside the allowed paths`,
      });
    }
  });
  return refusals;
}
