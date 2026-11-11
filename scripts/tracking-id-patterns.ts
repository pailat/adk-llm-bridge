/** Tracking-id patterns shared by `check-comments.ts` and its test. */

/** Labels that only make sense inside the team's tracking, never in code. */
export const TRACKING_ID_PATTERNS: ReadonlyArray<{
  name: string;
  pattern: RegExp;
}> = [
  {
    name: "stream or lane id",
    pattern:
      /\b(?:STREAM|AGENTS|RT|WF|LLM|OBS|ORCH|QUALITY|PACK|OLA|DOCS|PERM|SESSION)-\d+[a-z]?\b/,
  },
  {
    // Gate lanes such as `G-SEC` and wave lanes such as `4G-POST`.
    name: "gate or wave lane id",
    pattern: /(?<![\w-])\d*G-[A-Z]{2,}(?![\w-])/,
  },
  { name: "wave label", pattern: /\b[Ww]aves? \d+[a-z]?\b|\bola ?\d+[a-z]?\b/ },
  { name: "request number", pattern: /\bREQUESTS ?#\s?\d+/ },
  {
    // `issue #89` cannot be followed by a reader of the published code; a full
    // URL on the same line (a link such as .../issues/89) is fine. Matches
    // the issue or PR word (any case), the cross-repository form
    // `owner/repo#123`, and closing or reference keywords before a number.
    // A bare `#12` is not flagged: it would also match ordinary prose.
    name: "bare issue or pull request number",
    pattern:
      /^(?!.*https?:\/\/).*(?:\b(?:[Ii]ssues?|[Pp][Rr]s?|[Pp]ull requests?) ?#\d+|\b[\w.-]+\/[\w.-]+#\d+\b|\b(?:[Ff]ix(?:es|ed)?|[Cc]loses?|[Cc]losed|[Rr]esolves?|[Rr]esolved|[Ss]ee|[Rr]efs?) #\d+)/,
  },
  {
    name: "finding or review id",
    pattern:
      /(?<![\w.#/-])(?!V8\b)(?:F|N|E|B|C|V|M)\d{1,2}[a-z]?(?=$|[\s:,;)/.]|\/)(?![\w-])/,
  },
  {
    // Doc-review, fix and security-pass finding groups: `DF3`, `FIX1`, `SECP1`.
    name: "finding group id",
    pattern: /(?<![\w.#/-])(?:DF|FIX|SECP)\d{1,2}[a-z]?(?![\w-])/,
  },
  {
    name: "review minor id",
    pattern: /(?<![\w.#/-])(?:m|n)\d{1,2}(?=:|\s*\()|\((?:r\d+ )?[mn]\d{1,2}\)/,
  },
  {
    // Backlog and fix ids such as `BF-M1-F4`, `FS-RENAME-RETRY-1`, `BL-QJS-WORKER`.
    name: "backlog or fix id",
    pattern: /(?<![\w.#/-])(?:BF|BL|FS)-[A-Z0-9][A-Z0-9-]*(?![\w-])/,
  },
  {
    name: "verification or request id",
    pattern: /(?<![\w.#/-])(?:V|REQ)-\d+[a-z]?(?![\w-])/,
  },
  {
    // Hardening audit ids such as `H-C`.
    name: "hardening audit id",
    pattern: /(?<![\w.#/-])H-[A-Z](?![\w-])/,
  },
  {
    name: "severity label",
    pattern: /(?<![\w.#/-])P[0-3](?=$|[\s:,;)])(?![\w-])/,
  },
];

/**
 * The name of the first tracking-id rule that a line breaks.
 *
 * @param line - One line of a comment or test name.
 * @returns The rule name, or `undefined` when the line is clean.
 */
export function trackingIdRule(line: string): string | undefined {
  return TRACKING_ID_PATTERNS.find(({ pattern }) => pattern.test(line))?.name;
}
