import {
  hiddenCharacterProblem,
  traversalAliasProblem,
} from "../../workflows/internal/path-readings.js";
import {
  normalizePortablePath,
  portablePathContains,
  portablePathProblem,
} from "../../workflows/internal/portable-path.js";

/**
 * Codes of the refusals {@link checkChangedPaths} returns.
 *
 * @remarks
 * - `CHANGED_PATH_INVALID`: the path is not a portable relative path. It is
 *   empty or blank, longer than 4,096 characters, absolute (a leading `/`
 *   or a drive prefix such as `C:`, so `a:b/c` too), uses a backslash,
 *   contains NUL, has a `..` segment or names the root. Or, as the run spec
 *   checks allowed paths: it contains a control, format or invisible
 *   character, or has a segment a host could read as `..`, such as `.. `
 *   (Windows strips trailing dots and spaces), fullwidth dots (NFKC), any
 *   percent-encoded form once decoded (`%2e%2e`, `..%20`, overlong `%c0%ae`,
 *   double-encoded `%252e`), ideographic full stops, or `..` between slash
 *   look-alikes such as U+2215.
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
  /** Index of the path in `changedPaths`, or in the list checked. */
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
 * `./src/a.ts` and `src//a.ts` are both `src/a.ts`. The comparison is exact
 * and case-sensitive, so `src/Billing/a.ts` is outside `src/billing` even on
 * a file system that ignores case: folding would accept paths that are
 * outside on a case-sensitive host. The host's denied path patterns and
 * Windows short names (`GIT~1`) are not checked; a host that holds changed
 * paths to them checks them itself. Each refused path gets
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
): ChangedPathRefusal[];
/**
 * Checks a plain list of changed paths against the lane's allowed paths.
 *
 * @remarks
 * The same check as for a result, for paths a result does not name
 * `changedPaths`, such as the `testPaths` of a `tests@1` result. A refusal's
 * `index` is the path's index in the list.
 *
 * @param changedPaths - The changed paths, such as `result.testPaths`.
 * @param allowedPaths - The lane's allowed paths, in canonical form with
 * forward slashes, as in a run spec lane's `allowedPaths`.
 * @returns The refusals; empty when every path is allowed.
 * @throws TypeError when an allowed path is not canonical. That is the
 * host's error, not the agent's.
 *
 * @experimental
 */
export function checkChangedPaths(
  changedPaths: readonly string[],
  allowedPaths: readonly string[],
): ChangedPathRefusal[];
export function checkChangedPaths(
  resultOrPaths:
    | { readonly changedPaths: readonly string[] }
    | readonly string[],
  allowedPaths: readonly string[],
): ChangedPathRefusal[] {
  const changedPaths: readonly string[] = Array.isArray(resultOrPaths)
    ? resultOrPaths
    : (resultOrPaths as { readonly changedPaths: readonly string[] })
        .changedPaths;
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
  changedPaths.forEach((path, index) => {
    const problem =
      portablePathProblem(path) ??
      hiddenCharacterProblem(path) ??
      traversalAliasProblem(path);
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
        message: `${JSON.stringify(path)} is outside the allowed paths`,
      });
    }
  });
  return refusals;
}
