/**
 * Checks the code comment standard in docs/contributing/comments.md.
 *
 * - Internal tracking ids (finding, stream, wave and request labels) in
 *   comments and test names under `src/` and `tests/`. Test names inside
 *   `describe`, `test` and `it` calls, including the `.each(...)(` forms, are
 *   checked as well.
 * - TSDoc syntax of every `/** *\/` block under `src/`.
 * - Any comment under `src/` and `tests/` that contains `@license`,
 *   `Copyright` or `SPDX-License-Identifier`; the LICENSE file is the single
 *   source.
 *
 * Usage:
 * - `bun scripts/check-comments.ts`: exit 1 on any finding.
 * - `bun scripts/check-comments.ts --report`: print the findings, exit 0.
 *   `ci` and `prepublishOnly` use this mode until the check is enforced.
 *
 * A line that contains `check-comments-allow: <reason>` is exempt from the
 * tracking id and license rules. The marker without a reason is a finding.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { TSDocConfiguration, TSDocParser } from "@microsoft/tsdoc";

const ROOT = resolve(import.meta.dir, "..");
const reportOnly = process.argv.includes("--report");
const ALLOW_MARKER = "check-comments-allow";
/** The marker only counts when a reason follows the colon. */
const ALLOW_WITH_REASON = /check-comments-allow:\s*\S/;

/** Labels that only make sense inside the team's tracking, never in code. */
const TRACKING_ID_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
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
    name: "severity label",
    pattern: /(?<![\w.#/-])P[0-3](?=$|[\s:,;)])(?![\w-])/,
  },
];

interface Finding {
  file: string;
  line: number;
  rule: string;
  text: string;
}

const findings: Finding[] = [];

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "fixtures") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (/\.(?:ts|tsx|mts|cts)$/.test(name) && !name.endsWith(".d.ts")) {
      yield path;
    }
  }
}

interface Comment {
  kind: "line" | "block";
  text: string;
  start: number;
}

/**
 * Splits TypeScript source into comments without a full parser.
 *
 * @remarks
 * TypeScript 7 has no JavaScript compiler API, so this is a small lexer. It
 * skips string, template and regular expression literals; a `/` starts a
 * regular expression when the previous significant token cannot end an
 * expression.
 */
function scanComments(source: string): {
  comments: Comment[];
  strings: Comment[];
} {
  const comments: Comment[] = [];
  const strings: Comment[] = [];
  const templateDepth: number[] = [];
  let braceDepth = 0;
  let last = "";
  let i = 0;
  const n = source.length;
  const regexAllowedAfter =
    /^(?:[(,=:[!&|?{};+\-*%<>~^]|return|typeof|case|delete|void|in|of|yield|await|=>)$/;

  const readString = (quote: string, start: number): number => {
    let j = start + 1;
    while (j < n && source[j] !== quote) {
      if (source[j] === "\\") j++;
      else if (source[j] === "\n" && quote !== "`") break;
      j++;
    }
    return j + 1;
  };

  const readTemplate = (start: number): number => {
    let j = start;
    while (j < n) {
      const c = source[j];
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === "`") return j + 1;
      if (c === "$" && source[j + 1] === "{") {
        templateDepth.push(braceDepth);
        return -(j + 2);
      }
      j++;
    }
    return n;
  };

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      comments.push({ kind: "line", text: source.slice(i, stop), start: i });
      i = stop;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      comments.push({ kind: "block", text: source.slice(i, stop), start: i });
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = readString(c, i);
      strings.push({ kind: "line", text: source.slice(i, end), start: i });
      i = end;
      last = "str";
      continue;
    }
    if (c === "`" || (c === "}" && templateDepth.at(-1) === braceDepth)) {
      if (c === "}") templateDepth.pop();
      const start = i;
      const end = readTemplate(i + 1);
      if (end < 0) {
        strings.push({ kind: "line", text: source.slice(start, -end), start });
        i = -end;
        last = "{";
      } else {
        strings.push({ kind: "line", text: source.slice(start, end), start });
        i = end;
        last = "str";
      }
      continue;
    }
    if (c === "/" && (last === "" || regexAllowedAfter.test(last))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && source[j] !== "\n") {
        const ch = source[j];
        if (ch === "\\") j++;
        else if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) break;
        j++;
      }
      j++;
      while (j < n && /[a-z]/i.test(source[j] ?? "")) j++;
      i = j;
      last = "regex";
      continue;
    }
    if (c === "{") braceDepth++;
    else if (c === "}") braceDepth--;
    if (/\s/.test(c ?? "")) {
      i++;
      continue;
    }
    if (/[\w$]/.test(c ?? "")) {
      let j = i;
      while (j < n && /[\w$]/.test(source[j] ?? "")) j++;
      last = source.slice(i, j);
      i = j;
      continue;
    }
    if (c === "=" && next === ">") {
      last = "=>";
      i += 2;
      continue;
    }
    last = c ?? "";
    i++;
  }
  return { comments, strings };
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let k = 0; k < offset; k++) if (source.charCodeAt(k) === 10) line++;
  return line;
}

function checkTrackingIds(
  file: string,
  source: string,
  text: string,
  start: number,
): void {
  const lines = text.split("\n");
  let offset = start;
  for (const lineText of lines) {
    if (lineText.includes(ALLOW_MARKER) && !ALLOW_WITH_REASON.test(lineText)) {
      findings.push({
        file,
        line: lineAt(source, offset),
        rule: "allow marker without reason",
        text: lineText.trim().slice(0, 120),
      });
    }
    if (!ALLOW_WITH_REASON.test(lineText)) {
      for (const { name, pattern } of TRACKING_ID_PATTERNS) {
        const match = pattern.exec(lineText);
        if (match) {
          findings.push({
            file,
            line: lineAt(source, offset),
            rule: `tracking id (${name})`,
            text: lineText.trim().slice(0, 120),
          });
          break;
        }
      }
    }
    offset += lineText.length + 1;
  }
}

/**
 * Tracking labels in a file path, for example `wave4d` in
 * `claude-agent-sdk-wave4d.test.ts`. The separator before the label keeps
 * ordinary words (`rewave`, `gola4`) from matching.
 */
const PATH_TRACKING_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> =
  [
    {
      name: "wave label",
      pattern: /(?:^|[-_./])waves?-?\d+[a-z]?(?=$|[-_./])/i,
    },
    { name: "ola label", pattern: /(?:^|[-_./])ola-?\d+[a-z]?(?=$|[-_./])/i },
    {
      name: "stream or lane id",
      pattern:
        /(?:^|[-_./])(?:stream|agents|rt|wf|llm|obs|perm|session)-\d+[a-z]?(?=$|[-_./])/i,
    },
    {
      name: "finding group id",
      pattern: /(?:^|[-_./])(?:df|secp)-?\d+[a-z]?(?=$|[-_./])/i,
    },
  ];

function checkPath(file: string): void {
  for (const { name, pattern } of PATH_TRACKING_PATTERNS) {
    if (pattern.test(file)) {
      findings.push({
        file,
        line: 1,
        rule: `tracking id in file name (${name})`,
        text: "file names do not carry internal tracking labels",
      });
      return;
    }
  }
}

const LICENSE_HEADER_PATTERN = /@license|\bCopyright\b|SPDX-License-Identifier/;

/**
 * A string that opens a test: `test("name"`, or the second call of
 * `test.each(table)("name"` / ``describe.each`...`("name"``.
 */
const TEST_NAME_CALL =
  /\b(?:describe|test|it)(?:\.\w+)*\(\s*$|\b(?:describe|test|it)(?:\.\w+)*\.each\b[\s\S]*[)`]\(\s*$/;

function tsdocParser(): TSDocParser {
  const configuration = new TSDocConfiguration();
  return new TSDocParser(configuration);
}

const parser = tsdocParser();

function checkTsdoc(file: string, source: string, comment: Comment): void {
  if (!comment.text.startsWith("/**") || comment.text === "/**/") return;
  const context = parser.parseString(comment.text);
  for (const message of context.log.messages) {
    const range = message.textRange;
    findings.push({
      file,
      line: lineAt(source, comment.start + range.pos),
      rule: `tsdoc ${message.messageId}`,
      text: message.unformattedText.slice(0, 120),
    });
  }
}

for (const dir of ["src", "tests"]) {
  for (const path of sourceFiles(join(ROOT, dir))) {
    const file = relative(ROOT, path);
    checkPath(file);
    const source = readFileSync(path, "utf8");
    const { comments, strings } = scanComments(source);
    for (const comment of comments) {
      checkTrackingIds(file, source, comment.text, comment.start);
      if (dir === "src") checkTsdoc(file, source, comment);
    }
    for (const literal of strings) {
      const before = source.slice(
        Math.max(0, literal.start - 400),
        literal.start,
      );
      if (TEST_NAME_CALL.test(before)) {
        checkTrackingIds(file, source, literal.text, literal.start);
      }
    }
    for (const comment of comments) {
      let offset = comment.start;
      for (const lineText of comment.text.split("\n")) {
        if (
          LICENSE_HEADER_PATTERN.test(lineText) &&
          !ALLOW_WITH_REASON.test(lineText)
        ) {
          findings.push({
            file,
            line: lineAt(source, offset),
            rule: "license header",
            text: "per-file license or copyright headers are not used; LICENSE is the single source",
          });
        }
        offset += lineText.length + 1;
      }
    }
  }
}

const byRule = new Map<string, number>();
for (const finding of findings) {
  console.log(
    `${finding.file}:${finding.line}: ${finding.rule}: ${finding.text}`,
  );
  const key = finding.rule.split(" (")[0]?.split(" ")[0] ?? finding.rule;
  byRule.set(key, (byRule.get(key) ?? 0) + 1);
}
const summary = [...byRule]
  .map(([rule, count]) => `${rule} ${count}`)
  .join(", ");
if (findings.length === 0) {
  console.log("check-comments: OK");
} else if (reportOnly) {
  console.log(
    `check-comments: ${findings.length} finding(s) (${summary}); report mode`,
  );
} else {
  console.error(
    `check-comments: FAIL, ${findings.length} finding(s) (${summary})`,
  );
  process.exit(1);
}
