import { portablePathProblem } from "../../internal/portable-path.js";
import {
  validateWorkflowPath,
  workflowPathClaimsOverlap,
} from "../../orchestration/json.js";
import {
  type RunSpecIssue,
  type RunSpecIssueCode,
  runSpecIssue,
} from "../issues.js";
import {
  RUN_SPEC_LIMITS,
  type RunRules,
  type RunSpec,
  runSpecWorkspacePath,
} from "../schema.js";

/**
 * Reason text of the shared path grammar, mapped to its issue code.
 *
 * The keys must equal the strings `portablePathProblem` returns; an unknown
 * reason falls back to `RUN_SPEC_PATH_INVALID`.
 */
const PROBLEM_CODES: Readonly<Record<string, RunSpecIssueCode>> = {
  "must be relative": "RUN_SPEC_PATH_ABSOLUTE",
  "must not traverse parent directories": "RUN_SPEC_PATH_TRAVERSAL",
  "must use forward slashes": "RUN_SPEC_PATH_BACKSLASH",
  "must be canonical": "RUN_SPEC_PATH_NOT_CANONICAL",
  "must identify an entry below the root": "RUN_SPEC_PATH_ROOT_NOT_ALLOWED",
};

/**
 * Characters a path may not contain beyond what the shared grammar rejects:
 * controls (newline, escape), format characters (bidi overrides, zero-width
 * marks, the byte order mark), other default-ignorable code points, line and
 * paragraph separators, and lone surrogates, which have no UTF-8 encoding.
 * They are invisible or change how a path is displayed, and HFS+ ignores the
 * default-ignorable ones, so `.g\u200cit` names `.git` there
 * (CVE-2014-9390).
 */
const HIDDEN_CHARACTER =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

/** The same set, global, to drop those characters before a denied match. */
const HIDDEN_CHARACTERS = new RegExp(HIDDEN_CHARACTER.source, "gu");

/** Reason the shared grammar gives for `..`; it maps to the traversal code. */
const TRAVERSAL_PROBLEM = "must not traverse parent directories";

/**
 * Look-alikes of the slash and the backslash that NFKC leaves alone: the
 * fraction slash, the division slash, the set minus and the big solidi.
 * A host that maps text to a legacy code page can turn them into ASCII.
 */
const SEPARATOR_LOOK_ALIKES = /[\u2044\u2215\u2216\u29f5\u29f8\u29f9]/gu;

/** The ideographic full stop, which URL host parsing reads as `.`. */
const DOT_LOOK_ALIKES = /\u3002/gu;

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
 * A segment shaped like a Windows 8.3 short name, such as `GIT~1`,
 * `PROGRA~2` or `ENV~1.TXT`: one to six characters without a dot or a tilde,
 * a tilde and digits, and an optional extension of one to three characters.
 * NTFS can open such a name as an alias of a longer one, and which one
 * depends on the volume, so a pure check cannot tell what it names.
 */
const SHORT_NAME = /^[^.~]{1,6}~[0-9]{1,6}(?:\.[^.]{1,3})?$/u;

/** Longest name before the extension of an 8.3 short name. */
const SHORT_NAME_BASE_LENGTH = 8;

/** Most segment names remembered per call, so the memo stays bounded. */
const MAX_REMEMBERED_SEGMENTS = 4_096;

/**
 * Most units of glob matching work per call: one per segment and glob
 * pattern pair, plus one per pattern part scanned in a full match.
 *
 * @remarks
 * One unit per pair for a spec at the plan limits (1,024 paths of 64 distinct
 * segments) against the most glob patterns a rule set may hold (1,024), so
 * such a spec is never denied for its size alone; full matches use the rest.
 * Spending it takes under a second. A path that would exceed it is denied
 * unchecked.
 *
 * @internal
 */
export const MAX_GLOB_MATCH_WORK =
  RUN_SPEC_LIMITS.maxTotalAllowedPaths *
  RUN_SPEC_LIMITS.maxPathSegments *
  RUN_SPEC_LIMITS.maxRuleListEntries;

/** Reason given for a path with more segments than the hard limit. */
const SEGMENTS_PROBLEM = `must have at most ${RUN_SPEC_LIMITS.maxPathSegments} segments`;

/** Why a path is denied, or `undefined` when it is not. */
type DeniedReason = "pattern" | "short name" | "unchecked";

/** Denied patterns prepared once per call. */
interface DeniedMatcher {
  /** Folded patterns without `*`, matched by equality. */
  readonly exact: ReadonlySet<string>;
  /** Folded patterns with `*`, prepared for matching. */
  readonly globs: readonly Glob[];
  /**
   * Result per segment name already seen in this call, up to
   * {@link MAX_REMEMBERED_SEGMENTS} names.
   */
  readonly seen: Map<string, boolean>;
  /** Units of glob work left in this call; see {@link MAX_GLOB_MATCH_WORK}. */
  work: number;
  /**
   * Set once a path was reported unchecked: the spec is already rejected, so
   * later paths skip the patterns and the issue list keeps room for others.
   */
  exhausted: boolean;
}

/** A glob pattern split on `*`, with its longest literal part. */
interface Glob {
  readonly parts: readonly string[];
  /** The longest part: a name without it cannot match. */
  readonly literal: string;
}

interface Entry {
  readonly lane: number;
  readonly index: number;
  readonly folded: string;
  readonly sortKey: string;
}

/**
 * Checks the paths rules of a run spec whose shape is already valid and
 * appends one issue per violation.
 *
 * @remarks
 * Every path must be a canonical portable path below the project root, with
 * at most `RUN_SPEC_LIMITS.maxPathSegments` segments, no segment matching a
 * denied pattern and no segment shaped like a Windows 8.3 short name
 * (`GIT~1`), which could alias a denied name. The allowed paths of the lanes
 * must not repeat or nest, ignoring case and Unicode composition. A path is
 * also a traversal when a segment would read as `..` after a host strips
 * trailing dots and spaces, maps compatibility characters (NFKC) or
 * separator look-alikes to ASCII, or decodes percent escapes. Overlap also
 * ignores what Windows ignores in a name: everything from the first `:` (an
 * alternate data stream) and trailing dots and spaces. Values are never
 * rewritten; those readings are only compared.
 *
 * Cost: sorting is `O(p log p)` for `p` paths. Exact patterns are a set
 * lookup. Glob matching first looks for the longest literal part of each
 * pattern in the segment, and is bounded by {@link MAX_GLOB_MATCH_WORK} units
 * per call, whatever the number of distinct segments and host patterns; a path
 * reached after the budget is spent is denied, not accepted unchecked, and
 * the paths after it are not matched against the patterns. Lane ids are compared
 * case-sensitively here; case-only lane id collisions are a graph issue.
 *
 * @param spec - The spec, already shape-checked.
 * @param rules - The host's rules.
 * @param issues - Receives the issues found.
 * @experimental
 */
export function checkPathRules(
  spec: RunSpec,
  rules: RunRules,
  issues: RunSpecIssue[],
): void {
  const denied = deniedMatcher(rules.deniedPathPatterns);
  const rootProblem =
    portablePathProblem(spec.projectRoot, {
      canonical: true,
      allowRoot: true,
    }) ??
    hiddenCharacterProblem(spec.projectRoot) ??
    traversalAliasProblem(spec.projectRoot) ??
    segmentsProblem(spec.projectRoot);
  if (rootProblem !== undefined) {
    issues.push(problemIssue(["projectRoot"], "projectRoot", rootProblem));
  }
  const rootDenied =
    rootProblem === undefined || rootProblem === HIDDEN_CHARACTER_PROBLEM
      ? deniedReason(spec.projectRoot, denied)
      : undefined;
  if (rootDenied !== undefined) {
    issues.push(deniedIssue(["projectRoot"], "projectRoot", rootDenied));
  }

  const entries: Entry[] = [];
  spec.lanes.forEach((lane, laneIndex) => {
    lane.allowedPaths.forEach((path, index) => {
      const location = ["lanes", laneIndex, "allowedPaths", index];
      const problem =
        portablePathProblem(path, { canonical: true }) ??
        hiddenCharacterProblem(path) ??
        traversalAliasProblem(path) ??
        segmentsProblem(path);
      if (problem !== undefined) {
        issues.push(problemIssue(location, "allowed path", problem));
        // A path that only hides a denied name is reported as both, so the
        // reader sees that it names a secret file.
        const hidden =
          problem === HIDDEN_CHARACTER_PROBLEM
            ? deniedReason(path, denied)
            : undefined;
        if (hidden !== undefined) {
          issues.push(deniedIssue(location, "allowed path", hidden));
        }
        return;
      }
      if (rootProblem === undefined && !joinsValidly(spec.projectRoot, path)) {
        issues.push(
          runSpecIssue(
            "RUN_SPEC_PATH_INVALID",
            location,
            "allowed path joined to projectRoot is not a valid path",
          ),
        );
        return;
      }
      const reason = deniedReason(path, denied);
      if (reason !== undefined) {
        issues.push(deniedIssue(location, "allowed path", reason));
      }
      const folded = overlapFold(path);
      entries.push({
        lane: laneIndex,
        index,
        folded,
        sortKey: folded.replaceAll("/", "\u0000"),
      });
    });
  });

  reportOverlaps(spec, entries, issues);
}

function problemIssue(
  path: (string | number)[],
  what: string,
  problem: string,
): RunSpecIssue {
  const code = PROBLEM_CODES[problem] ?? "RUN_SPEC_PATH_INVALID";
  return runSpecIssue(code, path, `${what} ${problem}`);
}

/** Reason given for a path with a character {@link HIDDEN_CHARACTER} matches. */
const HIDDEN_CHARACTER_PROBLEM =
  "must not contain control, format or invisible characters";

function hiddenCharacterProblem(path: string): string | undefined {
  return HIDDEN_CHARACTER.test(path) ? HIDDEN_CHARACTER_PROBLEM : undefined;
}

/**
 * Reports a segment that a host could read as `..`.
 *
 * @remarks
 * The path itself already passed the shared grammar; this looks at the
 * readings listed on {@link checkPathRules}.
 */
function traversalAliasProblem(path: string): string | undefined {
  const widened = path
    .normalize("NFKC")
    .replace(SEPARATOR_LOOK_ALIKES, "/")
    .replace(DOT_LOOK_ALIKES, ".")
    .replace(PERCENT_DOT, ".")
    .replace(PERCENT_SEPARATOR, "/")
    .replaceAll("\\", "/");
  for (const segment of widened.split("/")) {
    if (PARENT_ALIAS.test(segment)) return TRAVERSAL_PROBLEM;
  }
  return undefined;
}

/** Reports a path with more segments than `RUN_SPEC_LIMITS.maxPathSegments`. */
function segmentsProblem(path: string): string | undefined {
  let segments = 1;
  for (let index = path.indexOf("/"); index !== -1; ) {
    segments += 1;
    if (segments > RUN_SPEC_LIMITS.maxPathSegments) return SEGMENTS_PROBLEM;
    index = path.indexOf("/", index + 1);
  }
  return undefined;
}

function deniedIssue(
  location: (string | number)[],
  what: string,
  reason: DeniedReason,
): RunSpecIssue {
  return runSpecIssue(
    "RUN_SPEC_PATH_DENIED",
    location,
    reason === "pattern"
      ? `${what} has a segment that matches a denied path pattern`
      : reason === "short name"
        ? `${what} has a segment that may be a Windows short name (8.3 form), which can alias a denied name`
        : `${what} could not be matched against the denied path patterns within the matching budget; use fewer distinct segments or fewer glob patterns`,
  );
}

function joinsValidly(root: string, path: string): boolean {
  try {
    validateWorkflowPath(runSpecWorkspacePath(root, path));
    return true;
  } catch {
    return false;
  }
}

/** Sorts so an ancestor is followed by its descendants, then sweeps once. */
function reportOverlaps(
  spec: RunSpec,
  entries: Entry[],
  issues: RunSpecIssue[],
): void {
  entries.sort((a, b) => {
    if (a.sortKey !== b.sortKey) return a.sortKey < b.sortKey ? -1 : 1;
    return a.lane - b.lane || a.index - b.index;
  });
  let kept: Entry | undefined;
  for (const entry of entries) {
    if (
      kept !== undefined &&
      workflowPathClaimsOverlap(
        { path: kept.folded, scope: "subtree" },
        { path: entry.folded, scope: "subtree" },
      )
    ) {
      const location = ["lanes", entry.lane, "allowedPaths", entry.index];
      if (kept.lane === entry.lane) {
        issues.push(
          runSpecIssue(
            "RUN_SPEC_PATH_DUPLICATE",
            location,
            `allowed path repeats or nests another path of lane ${laneName(spec, entry.lane)}`,
          ),
        );
      } else {
        issues.push(
          runSpecIssue(
            "RUN_SPEC_PATH_OVERLAP",
            location,
            `allowed path of lane ${laneName(spec, entry.lane)} overlaps a path of lane ${laneName(spec, kept.lane)}`,
          ),
        );
      }
    } else {
      kept = entry;
    }
  }
}

function laneName(spec: RunSpec, lane: number): string {
  return JSON.stringify(spec.lanes[lane]?.taskId ?? lane);
}

/**
 * Case and Unicode composition fold used for every comparison.
 *
 * Upper-casing first maps characters such as U+017F (long s) to their base
 * letter, as case-insensitive file systems do; `toLowerCase` alone would not.
 */
function fold(value: string): string {
  return value.normalize("NFC").toUpperCase().toLowerCase();
}

/**
 * The overlap key of a path: {@link fold}, then each segment as Windows
 * opens it, so `src/api.`, `src/api ` and `src/api::$DATA` all name
 * `src/api`.
 *
 * A segment that would become empty is kept as written.
 */
function overlapFold(path: string): string {
  return fold(path)
    .split("/")
    .map((segment) => windowsName(segment) || segment)
    .join("/");
}

/** A segment without its stream suffix and trailing dots and spaces. */
function windowsName(segment: string): string {
  const colon = segment.indexOf(":");
  const name = colon === -1 ? segment : segment.slice(0, colon);
  return trimDotsAndSpaces(name);
}

/**
 * A name without trailing dots and spaces.
 *
 * A loop, not `/[. ]+$/`, which backtracks over every run of dots or spaces
 * that does not end the name: quadratic in the run length.
 */
function trimDotsAndSpaces(name: string): string {
  let end = name.length;
  while (end > 0) {
    const last = name.charCodeAt(end - 1);
    if (last !== 0x2e && last !== 0x20) break;
    end -= 1;
  }
  return name.slice(0, end);
}

function deniedMatcher(patterns: readonly string[]): DeniedMatcher {
  const exact = new Set<string>();
  const globs: Glob[] = [];
  for (const pattern of patterns) {
    const folded = fold(pattern);
    if (!folded.includes("*")) {
      exact.add(folded);
      continue;
    }
    const parts = folded.split("*");
    let literal = "";
    for (const part of parts) if (part.length > literal.length) literal = part;
    globs.push({ parts, literal });
  }
  return {
    exact,
    globs,
    seen: new Map(),
    work: MAX_GLOB_MATCH_WORK,
    exhausted: false,
  };
}

/**
 * Tells whether a path is denied: a segment matches a denied pattern, or is
 * shaped like a Windows short name.
 *
 * @remarks
 * Hidden characters are dropped first, as HFS+ does. Everything from the
 * first `:` is dropped (NTFS alternate data streams such as `.env::$DATA`),
 * and so are trailing dots and spaces, because some file systems treat
 * `.env.` and `.env ` as `.env`. The short-name check applies whatever the
 * host's patterns are. Up to {@link MAX_REMEMBERED_SEGMENTS} distinct
 * segment names are remembered per call, so a repeated name is matched once.
 * A segment that cannot be matched within the call's work budget makes the
 * path `"unchecked"`, which is reported as denied; the paths after it skip
 * the patterns, since the spec is already rejected.
 */
function deniedReason(
  path: string,
  matcher: DeniedMatcher,
): DeniedReason | undefined {
  const patterns =
    !matcher.exhausted && (matcher.exact.size > 0 || matcher.globs.length > 0);
  for (const segment of fold(path.replace(HIDDEN_CHARACTERS, "")).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (isShortName(segment)) return "short name";
    if (!patterns) continue;
    let denied = matcher.seen.get(segment);
    if (denied === undefined) {
      denied = segmentDenied(segment, matcher);
      if (denied === undefined) {
        matcher.exhausted = true;
        return "unchecked";
      }
      if (matcher.seen.size < MAX_REMEMBERED_SEGMENTS) {
        matcher.seen.set(segment, denied);
      }
    }
    if (denied) return "pattern";
  }
  return undefined;
}

/** Whether a folded segment, as Windows opens it, looks like an 8.3 short name. */
function isShortName(segment: string): boolean {
  const name = windowsName(segment);
  return (
    SHORT_NAME.test(name) &&
    (name.split(".")[0] ?? "").length <= SHORT_NAME_BASE_LENGTH
  );
}

/**
 * Whether a folded segment matches a denied pattern, or `undefined` when the
 * glob work budget runs out first.
 */
function segmentDenied(
  segment: string,
  matcher: DeniedMatcher,
): boolean | undefined {
  const name = segment.split(":")[0] ?? "";
  const stripped = trimDotsAndSpaces(name);
  if (matcher.exact.has(name) || matcher.exact.has(stripped)) return true;
  const names = stripped === name ? [name] : [name, stripped];
  for (const glob of matcher.globs) {
    for (const candidate of names) {
      matcher.work -= 1;
      if (matcher.work < 0) return undefined;
      if (!candidate.includes(glob.literal)) continue;
      matcher.work -= glob.parts.length;
      if (matcher.work < 0) return undefined;
      if (globMatches(glob.parts, candidate)) return true;
    }
  }
  return false;
}

/** Matches a name against a pattern split on `*`, its only special character. */
function globMatches(parts: readonly string[], name: string): boolean {
  const first = parts[0] ?? "";
  const last = parts[parts.length - 1] ?? "";
  if (name.length < first.length + last.length) return false;
  if (!name.startsWith(first) || !name.endsWith(last)) return false;
  const end = name.length - last.length;
  let from = first.length;
  for (let i = 1; i < parts.length - 1; i += 1) {
    const part = parts[i] ?? "";
    const at = name.indexOf(part, from);
    if (at === -1 || at + part.length > end) return false;
    from = at + part.length;
  }
  return true;
}
