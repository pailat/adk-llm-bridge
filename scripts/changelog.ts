/**
 * Changelog fragments: each pull request adds its notes as a file under
 * `changes/unreleased/` instead of editing `CHANGELOG.md`, so parallel pull
 * requests no longer conflict on the Unreleased section. A release assembles
 * the fragments into `CHANGELOG.md`.
 *
 * A fragment is `changes/unreleased/<slug>.md` with one or more Keep a
 * Changelog sections (`### Added`, `### Fixed`...), each a list of entries
 * written exactly as they would appear in `CHANGELOG.md`.
 *
 * Usage:
 * - `bun scripts/changelog.ts preview`: print the notes the next release gets
 *   (the CHANGELOG's Unreleased entries, then the fragments by file name).
 * - `bun scripts/changelog.ts release X.Y.Z [--date YYYY-MM-DD]`: move those
 *   notes under `## [X.Y.Z] - date`, add the version's link and delete the
 *   fragments. The date defaults to today.
 * - `bun scripts/changelog.ts check --base <ref> [--skip <reason>]`: exit 1
 *   when the changes since `<ref>` touch `src/` but add no fragment, unless
 *   an opt-out reason is given (also read from `$CHANGELOG_SKIP`). Every
 *   fragment must parse.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

/** Where pull requests put their fragments, relative to the repository root. */
export const FRAGMENT_DIR = "changes/unreleased";

/** The sections a fragment may have, in the order a release lists them. */
export const SECTIONS = [
  "Breaking",
  "Added",
  "Changed",
  "Deprecated",
  "Removed",
  "Fixed",
  "Security",
  "Docs",
  "Known limitations",
] as const;

/** Paths whose changes are user visible and so need a fragment. */
const USER_VISIBLE = ["src/"];

const UNRELEASED = "## [Unreleased]";
const RELEASE_URL = "https://github.com/pailat/adk-llm-bridge/releases/tag/v";

/** One fragment: its file name and each section's entries. */
export interface Fragment {
  name: string;
  /** Section name to its entries, without surrounding blank lines. */
  sections: Map<string, string>;
}

/** Parses a fragment's text; `name` labels the errors. */
export function parseFragment(name: string, text: string): Fragment {
  const sections = parseSections(name, text);
  if (sections.size === 0) throw new Error(`${name}: no section`);
  return { name, sections };
}

function parseSections(name: string, text: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | undefined;
  let lines: string[] = [];
  const close = () => {
    if (current === undefined) return;
    const body = lines.join("\n").replace(/^\n+|\s+$/g, "");
    if (body === "") throw new Error(`${name}: section "${current}" is empty`);
    sections.set(current, body);
  };
  for (const line of text.split("\n")) {
    const heading = /^### (.+?)\s*$/.exec(line)?.[1];
    if (heading !== undefined) {
      close();
      if (!(SECTIONS as readonly string[]).includes(heading)) {
        throw new Error(
          `${name}: unknown section "${heading}" (use one of ${SECTIONS.join(", ")})`,
        );
      }
      if (sections.has(heading)) {
        throw new Error(`${name}: section "${heading}" appears twice`);
      }
      current = heading;
      lines = [];
    } else if (current === undefined) {
      if (line.trim() !== "") {
        throw new Error(`${name}: text before the first section`);
      }
    } else {
      lines.push(line);
    }
  }
  close();
  return sections;
}

/** The fragments under `root`, sorted by file name. */
export function readFragments(root: string): Fragment[] {
  const dir = join(root, FRAGMENT_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) =>
      parseFragment(
        `${FRAGMENT_DIR}/${file}`,
        readFileSync(join(dir, file), "utf8"),
      ),
    );
}

/** Where the Unreleased section's body starts and ends in `changelog`. */
function unreleasedBounds(changelog: string): { start: number; end: number } {
  const heading = changelog.indexOf(`${UNRELEASED}\n`);
  if (heading === -1) throw new Error(`CHANGELOG.md has no "${UNRELEASED}"`);
  const start = heading + UNRELEASED.length + 1;
  const next = changelog.indexOf("\n## [", start - 1);
  return { start, end: next === -1 ? changelog.length : next + 1 };
}

/**
 * The notes the next release gets: the CHANGELOG's Unreleased entries, then
 * each fragment's, merged by section in {@link SECTIONS} order. Empty when
 * nothing is unreleased.
 */
export function unreleasedNotes(
  changelog: string,
  fragments: Fragment[],
): string {
  const { start, end } = unreleasedBounds(changelog);
  const inline = parseSections(
    "CHANGELOG.md Unreleased",
    changelog.slice(start, end),
  );
  const ordered = [...fragments].sort((a, b) => a.name.localeCompare(b.name));
  const parts: string[] = [];
  for (const section of SECTIONS) {
    const entries = [inline, ...ordered.map((f) => f.sections)]
      .map((sections) => sections.get(section))
      .filter((body): body is string => body !== undefined);
    if (entries.length > 0) {
      parts.push(`### ${section}\n\n${entries.join("\n")}\n`);
    }
  }
  return parts.join("\n");
}

/**
 * `changelog` with the unreleased notes moved under `## [version] - date`
 * (Unreleased left empty) and the version's link added above the others.
 */
export function releaseChangelog(
  changelog: string,
  fragments: Fragment[],
  version: string,
  date: string,
): string {
  if (changelog.includes(`\n## [${version}]`)) {
    throw new Error(`${version} is already in the CHANGELOG`);
  }
  const notes = unreleasedNotes(changelog, fragments);
  if (notes === "") throw new Error("nothing to release");
  const { start, end } = unreleasedBounds(changelog);
  const released = `${changelog.slice(0, start)}\n## [${version}] - ${date}\n\n${notes}\n${changelog.slice(end)}`;
  const link = `[${version}]: ${RELEASE_URL}${version}\n`;
  const firstLink = /^\[\d+\.\d+\.\d+[^\]]*\]: /m.exec(released);
  if (firstLink === null) return `${released.replace(/\n*$/, "\n\n")}${link}`;
  return `${released.slice(0, firstLink.index)}${link}${released.slice(firstLink.index)}`;
}

/** Releases `version` in the repository at `root`: writes `CHANGELOG.md`, deletes the fragments. */
export function releaseInPlace(
  root: string,
  version: string,
  date: string,
): void {
  const path = join(root, "CHANGELOG.md");
  const fragments = readFragments(root);
  writeFileSync(
    path,
    releaseChangelog(readFileSync(path, "utf8"), fragments, version, date),
  );
  for (const fragment of fragments) rmSync(join(root, fragment.name));
}

/** The outcome of {@link checkFragments}. */
export interface CheckResult {
  ok: boolean;
  reason: string;
}

/**
 * Whether `changed` (paths relative to the root) carries a fragment when it
 * changes user-visible source. `skip` is an explicit opt-out reason;
 * `exists` tells a fragment that is still there from a deleted one.
 */
export function checkFragments(
  changed: string[],
  options: { skip?: string; exists?: (path: string) => boolean },
): CheckResult {
  const exists = options.exists ?? (() => true);
  const source = changed.filter((path) =>
    USER_VISIBLE.some((prefix) => path.startsWith(prefix)),
  );
  if (source.length === 0) {
    return { ok: true, reason: "no user-visible source change" };
  }
  const fragments = changed.filter(
    (path) =>
      path.startsWith(`${FRAGMENT_DIR}/`) &&
      path.endsWith(".md") &&
      exists(path),
  );
  if (fragments.length > 0) {
    return { ok: true, reason: `fragment ${fragments.join(", ")}` };
  }
  const skip = options.skip?.trim();
  if (skip) return { ok: true, reason: `skipped: ${skip}` };
  return {
    ok: false,
    reason: `${source.length} source file(s) changed (${source[0]}...) without a fragment: add ${FRAGMENT_DIR}/<slug>.md (see CONTRIBUTING.md), or label the pull request skip-changelog when nothing user visible changed`,
  };
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function main(args: string[]): number {
  const root = resolve(import.meta.dir, "..");
  const [command] = args;
  if (command === "preview") {
    const text = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    process.stdout.write(unreleasedNotes(text, readFragments(root)));
    return 0;
  }
  if (command === "release") {
    const version = args[1];
    if (version === undefined || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
      console.error(
        "usage: bun scripts/changelog.ts release X.Y.Z [--date YYYY-MM-DD]",
      );
      return 2;
    }
    const date =
      option(args, "--date") ?? new Date().toLocaleDateString("en-CA");
    releaseInPlace(root, version, date);
    console.log(`CHANGELOG.md: released ${version} (${date})`);
    return 0;
  }
  if (command === "check") {
    const base = option(args, "--base");
    if (base === undefined) {
      console.error(
        "usage: bun scripts/changelog.ts check --base <ref> [--skip <reason>]",
      );
      return 2;
    }
    readFragments(root);
    const changed = execFileSync(
      "git",
      ["diff", "--name-only", `${base}...HEAD`],
      { cwd: root, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    const result = checkFragments(changed, {
      skip: option(args, "--skip") ?? process.env.CHANGELOG_SKIP,
      exists: (path) => existsSync(join(root, path)),
    });
    (result.ok ? console.log : console.error)(`changelog: ${result.reason}`);
    return result.ok ? 0 : 1;
  }
  console.error(
    "usage: bun scripts/changelog.ts preview | release X.Y.Z | check --base <ref>",
  );
  return 2;
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`changelog: ${(error as Error).message}`);
    process.exit(1);
  }
}
