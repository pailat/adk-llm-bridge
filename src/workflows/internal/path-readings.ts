/**
 * Checks for a portable path that a host could read differently from how it
 * is written, shared by the run spec's path rules and `checkChangedPaths`.
 *
 * @remarks
 * They apply to a path that already passed `portablePathProblem`. The
 * module is free of Node built-ins, so the zod-only entries can use it.
 *
 * @packageDocumentation
 */

/**
 * Characters a path may not contain beyond what the shared grammar rejects:
 * controls (newline, escape), format characters (bidi overrides, zero-width
 * marks, the byte order mark), other default-ignorable code points, line and
 * paragraph separators, and lone surrogates, which have no UTF-8 encoding.
 * They are invisible or change how a path is displayed, and HFS+ ignores the
 * default-ignorable ones, so `.g‌it` names `.git` there
 * (CVE-2014-9390).
 */
const HIDDEN_CHARACTER =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

/**
 * The hidden characters, global, to drop them before a denied match.
 *
 * @internal
 */
export const HIDDEN_CHARACTERS = new RegExp(HIDDEN_CHARACTER.source, "gu");

/**
 * Reason given for a path with a hidden character.
 *
 * @internal
 */
export const HIDDEN_CHARACTER_PROBLEM =
  "must not contain control, format or invisible characters";

/** Reason the shared grammar gives for `..`; it maps to the traversal code. */
const TRAVERSAL_PROBLEM = "must not traverse parent directories";

/**
 * Look-alikes of the slash and the backslash that NFKC leaves alone: the
 * fraction slash, the division slash, the set minus and the big solidi.
 * A host that maps text to a legacy code page can turn them into ASCII.
 */
const SEPARATOR_LOOK_ALIKES = /[⁄∕∖⧵⧸⧹]/gu;

/** The ideographic full stop, which URL host parsing reads as `.`. */
const DOT_LOOK_ALIKES = /。/gu;

/** A percent-encoded `.`. */
const PERCENT_DOT = /%2e/giu;

/** A percent-encoded slash or backslash. */
const PERCENT_SEPARATOR = /%(?:2f|5c)/giu;

/**
 * A segment that names the parent directory on some host: `..` followed by
 * dots or spaces, which Windows strips, so `.. ` opens `..`.
 */
const PARENT_ALIAS = /^\.\.[. ]*$/u;

/**
 * Reports a path with a control, format or invisible character.
 *
 * @param path - Path to check.
 * @returns {@link HIDDEN_CHARACTER_PROBLEM}, or `undefined`.
 * @internal
 */
export function hiddenCharacterProblem(path: string): string | undefined {
  return HIDDEN_CHARACTER.test(path) ? HIDDEN_CHARACTER_PROBLEM : undefined;
}

/**
 * Reports a segment that a host could read as `..` in the
 * {@link widenedReading} of a path.
 *
 * @param path - A path that already passed the shared grammar.
 * @returns The traversal reason of the shared grammar, or `undefined`.
 * @internal
 */
export function traversalAliasProblem(path: string): string | undefined {
  for (const segment of widenedReading(path).split("/")) {
    if (PARENT_ALIAS.test(segment)) return TRAVERSAL_PROBLEM;
  }
  return undefined;
}

/**
 * A path as a host that maps text to a legacy code page, or decodes percent
 * escapes, could read it: NFKC, dot and slash look-alikes, percent-encoded
 * dots and separators, and backslashes as separators.
 *
 * @param path - Path to read.
 * @returns The widened reading.
 * @internal
 */
export function widenedReading(path: string): string {
  return path
    .normalize("NFKC")
    .replace(SEPARATOR_LOOK_ALIKES, "/")
    .replace(DOT_LOOK_ALIKES, ".")
    .replace(PERCENT_DOT, ".")
    .replace(PERCENT_SEPARATOR, "/")
    .replaceAll("\\", "/");
}
