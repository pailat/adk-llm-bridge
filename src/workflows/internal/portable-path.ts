/**
 * The one portable relative path grammar used by workspace leases, change
 * sets, ownership claims and the Git worktree driver.
 *
 * @remarks
 * A portable path names an entry under a workspace root with `/`-separated
 * segments, the same way on every platform. Every form rejects:
 *
 * - an empty or blank string, or one longer than
 *   {@link MAX_PORTABLE_PATH_LENGTH} characters;
 * - a NUL character or a backslash (`\` is a separator on Windows and a file
 *   name character on POSIX, so it is never guessed);
 * - a leading `/`, or a drive prefix (`C:` and the like) as the first segment;
 * - any `..` segment.
 *
 * The canonical form has no empty segments, no `.` segments and no trailing
 * slash. {@link normalizePortablePath} accepts other spellings and returns the
 * canonical form; {@link portablePathProblem} with `canonical: true` accepts
 * only the canonical form, so stored claims cannot be bypassed by alternate
 * spellings.
 *
 * The grammar is lexical. Names Windows treats as aliases of another entry (a
 * trailing dot or space, an alternate data stream after `:` in a later
 * segment, an 8.3 short name) are outside its scope.
 *
 * @packageDocumentation
 */

/**
 * Longest portable path, in UTF-16 code units.
 *
 * @internal
 */
export const MAX_PORTABLE_PATH_LENGTH = 4_096;

/**
 * Options for {@link portablePathProblem} and {@link normalizePortablePath}.
 *
 * @internal
 */
export interface PortablePathOptions {
  /**
   * Accept only the canonical spelling.
   *
   * @defaultValue false
   */
  canonical?: boolean;
  /**
   * Accept the workspace root, spelled `.` (or, when not canonical, any
   * spelling that normalizes to nothing, such as `./`).
   *
   * @defaultValue false
   */
  allowRoot?: boolean;
}

/**
 * Explains why a value is not a portable path.
 *
 * @param input - Candidate path.
 * @param options - Whether only the canonical form and the root are accepted.
 * @returns A short reason such as `"must be relative"`, or `undefined` when
 * the value is a portable path.
 * @internal
 */
export function portablePathProblem(
  input: unknown,
  options: PortablePathOptions = {},
): string | undefined {
  if (typeof input !== "string" || input.trim().length === 0) {
    return "must be a non-empty string";
  }
  if (input.length > MAX_PORTABLE_PATH_LENGTH) {
    return `must be at most ${MAX_PORTABLE_PATH_LENGTH} characters`;
  }
  if (input.includes("\0")) return "must not contain NUL characters";
  // Checked before backslashes so `C:\repo` reads as an absolute path.
  if (input.startsWith("/") || /^[A-Za-z]:/u.test(input)) {
    return "must be relative";
  }
  if (input.includes("\\")) return "must use forward slashes";
  const segments = input.split("/");
  if (segments.includes("..")) return "must not traverse parent directories";
  const canonical = canonicalSegments(segments).join("/");
  if (canonical.length === 0) {
    if (!options.allowRoot) return "must identify an entry below the root";
    return options.canonical && input !== "." ? "must be canonical" : undefined;
  }
  if (options.canonical && canonical !== input) return "must be canonical";
  return undefined;
}

/**
 * Returns the canonical spelling of a portable path.
 *
 * @param input - Path to normalize.
 * @param options - Whether only the canonical form and the root are accepted.
 * @returns The canonical path; `.` for the root when `allowRoot` is set.
 * @throws TypeError with the reason from {@link portablePathProblem} when the
 * value is not a portable path. Callers rethrow their own error type.
 * @internal
 */
export function normalizePortablePath(
  input: string,
  options: PortablePathOptions = {},
): string {
  const problem = portablePathProblem(input, options);
  if (problem !== undefined) throw new TypeError(problem);
  const canonical = canonicalSegments(input.split("/")).join("/");
  return canonical.length === 0 ? "." : canonical;
}

/**
 * Tells whether `child` is `parent` or lies below it. Both must be canonical.
 *
 * @param parent - Canonical path, or `.` for the root.
 * @param child - Canonical path.
 * @returns True when `parent` contains `child`.
 * @internal
 */
export function portablePathContains(parent: string, child: string): boolean {
  return parent === "." || child === parent || child.startsWith(`${parent}/`);
}

function canonicalSegments(segments: readonly string[]): string[] {
  return segments.filter((segment) => segment !== "" && segment !== ".");
}
