import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkFragments,
  FRAGMENT_DIR,
  parseFragment,
  readFragments,
  releaseChangelog,
  releaseInPlace,
  unreleasedNotes,
} from "../../scripts/changelog.js";

const ROOT = resolve(import.meta.dir, "../..");
const scratch = mkdtempSync(join(tmpdir(), "changelog-fragments-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const HEADER = `# Changelog

Intro line.

`;

const TAIL = `## [0.1.0] - 2026-01-01

### Added

- The first Acme widget.

[0.1.0]: https://github.com/pailat/adk-llm-bridge/releases/tag/v0.1.0
`;

const changelog = (unreleasedBody: string) =>
  `${HEADER}## [Unreleased]\n\n${unreleasedBody}${TAIL}`;

describe("parseFragment", () => {
  test("reads each section's entries", () => {
    const fragment = parseFragment(
      "acme-widget.md",
      "### Added\n\n- An Acme widget.\n  It spins.\n\n### Fixed\n\n- A crash.\n",
    );
    expect(fragment.sections).toEqual(
      new Map([
        ["Added", "- An Acme widget.\n  It spins."],
        ["Fixed", "- A crash."],
      ]),
    );
  });

  test("refuses an unknown section, text outside a section and an empty one", () => {
    expect(() => parseFragment("a.md", "### Improved\n\n- x\n")).toThrow(
      /a\.md: unknown section "Improved"/,
    );
    expect(() => parseFragment("b.md", "- x\n\n### Added\n\n- y\n")).toThrow(
      /b\.md: text before the first section/,
    );
    expect(() =>
      parseFragment("c.md", "### Added\n\n### Fixed\n\n- y\n"),
    ).toThrow(/c\.md: section "Added" is empty/);
    expect(() => parseFragment("d.md", "\n")).toThrow(/d\.md: no section/);
    expect(() =>
      parseFragment("e.md", "### Added\n\n- x\n\n### Added\n\n- y\n"),
    ).toThrow(/e\.md: section "Added" appears twice/);
  });
});

describe("unreleasedNotes", () => {
  test("merges the CHANGELOG's Unreleased entries and the fragments by section", () => {
    const notes = unreleasedNotes(changelog("### Fixed\n\n- Inline fix.\n\n"), [
      parseFragment("b.md", "### Fixed\n\n- Fix from b.\n"),
      parseFragment("a.md", "### Added\n\n- Feature from a.\n"),
    ]);
    expect(notes).toBe(
      "### Added\n\n- Feature from a.\n\n### Fixed\n\n- Inline fix.\n- Fix from b.\n",
    );
  });

  test("is empty when nothing is unreleased", () => {
    expect(unreleasedNotes(changelog(""), [])).toBe("");
  });
});

describe("releaseChangelog", () => {
  test("puts the notes under a dated version heading and adds its link", () => {
    const out = releaseChangelog(
      changelog(""),
      [parseFragment("acme.md", "### Added\n\n- An Acme widget.\n")],
      "0.2.0",
      "2026-02-02",
    );
    expect(out).toBe(
      `${HEADER}## [Unreleased]\n\n## [0.2.0] - 2026-02-02\n\n### Added\n\n- An Acme widget.\n\n${TAIL.replace(
        "[0.1.0]: ",
        "[0.2.0]: https://github.com/pailat/adk-llm-bridge/releases/tag/v0.2.0\n[0.1.0]: ",
      )}`,
    );
  });

  test("a fragment releases exactly like the same entry written in the CHANGELOG", () => {
    const entry = "### Added\n\n- An Acme widget.\n  It spins.\n";
    const inline = releaseChangelog(
      changelog(`${entry}\n`),
      [],
      "0.2.0",
      "2026-02-02",
    );
    const fromFragment = releaseChangelog(
      changelog(""),
      [parseFragment("acme.md", entry)],
      "0.2.0",
      "2026-02-02",
    );
    expect(fromFragment).toBe(inline);
  });

  test("refuses an empty release and a version that is already there", () => {
    expect(() =>
      releaseChangelog(changelog(""), [], "0.2.0", "2026-02-02"),
    ).toThrow(/nothing to release/);
    expect(() =>
      releaseChangelog(
        changelog("### Added\n\n- x\n\n"),
        [],
        "0.1.0",
        "2026-02-02",
      ),
    ).toThrow(/0\.1\.0 is already in the CHANGELOG/);
  });
});

describe("releaseInPlace", () => {
  test("writes the CHANGELOG and removes the released fragments", () => {
    const repo = join(scratch, "repo");
    mkdirSync(join(repo, FRAGMENT_DIR), { recursive: true });
    writeFileSync(join(repo, "CHANGELOG.md"), changelog(""));
    writeFileSync(
      join(repo, FRAGMENT_DIR, "acme.md"),
      "### Fixed\n\n- An Acme fix.\n",
    );
    releaseInPlace(repo, "0.2.0", "2026-02-02");
    expect(readFileSync(join(repo, "CHANGELOG.md"), "utf8")).toContain(
      "## [0.2.0] - 2026-02-02\n\n### Fixed\n\n- An Acme fix.\n",
    );
    expect(existsSync(join(repo, FRAGMENT_DIR, "acme.md"))).toBe(false);
    expect(readFragments(repo)).toEqual([]);
  });
});

describe("checkFragments", () => {
  const fragment = `${FRAGMENT_DIR}/acme.md`;

  test("a source change needs a fragment", () => {
    expect(checkFragments(["src/index.ts"], {})).toEqual({
      ok: false,
      reason: expect.stringContaining(FRAGMENT_DIR),
    });
    expect(checkFragments(["src/index.ts", fragment], {}).ok).toBe(true);
  });

  test("a change outside src does not", () => {
    expect(checkFragments(["docs/a.md", "tests/a.test.ts"], {}).ok).toBe(true);
  });

  test("an explicit opt-out with a reason passes, a blank one does not", () => {
    expect(
      checkFragments(["src/index.ts"], { skip: "internal refactor" }).ok,
    ).toBe(true);
    expect(checkFragments(["src/index.ts"], { skip: " " }).ok).toBe(false);
  });

  test("a deleted fragment does not count", () => {
    expect(
      checkFragments(["src/index.ts", fragment], { exists: () => false }).ok,
    ).toBe(false);
  });
});

describe("this repository", () => {
  test("every fragment parses and the notes can be released", () => {
    const fragments = readFragments(ROOT);
    const text = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
    if (fragments.length === 0 && unreleasedNotes(text, []) === "") return;
    expect(() =>
      releaseChangelog(text, fragments, "99.0.0", "2026-01-01"),
    ).not.toThrow();
  });

  test("the release checklist, CONTRIBUTING and CI name the fragment step", () => {
    const development = readFileSync(join(ROOT, "DEVELOPMENT.md"), "utf8");
    expect(development).toContain("bun scripts/changelog.ts release X.Y.Z");
    const contributing = readFileSync(join(ROOT, "CONTRIBUTING.md"), "utf8");
    expect(contributing).toContain(FRAGMENT_DIR);
    expect(contributing).toContain("skip-changelog");
    const ci = readFileSync(
      join(ROOT, ".github/workflows/changelog.yml"),
      "utf8",
    );
    expect(ci).toContain("bun scripts/changelog.ts check");
    expect(ci).toContain("skip-changelog");
  });
});
