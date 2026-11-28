import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Reads files only. The behaviour the page states is tested in
// tests/agents/driver/mcp-headless-lane-linux.test.ts.

const REPO_ROOT = resolve(import.meta.dir, "../..");
const PAGE = "docs/mcp-headless-lane.md";

const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");

/** The text of the CHANGELOG's Unreleased section. */
function unreleased(): string {
  const changelog = read("CHANGELOG.md");
  const start = changelog.indexOf("## [Unreleased]");
  expect(start).toBeGreaterThan(-1);
  const next = changelog.indexOf("\n## [", start + 1);
  return changelog.slice(start, next === -1 ? undefined : next);
}

describe("MCP from a headless lane: the recipe page", () => {
  test("the page exists, is listed in the docs index and has one H1", () => {
    expect(existsSync(join(REPO_ROOT, PAGE))).toBe(true);
    expect(read("docs/README.md")).toContain("(mcp-headless-lane.md)");
    expect(read(PAGE).match(/^# /gm)).toHaveLength(1);
  });

  test('the token recipe: { resolve } on an http server, mcp: ["pai"], ptrace precheck', () => {
    const page = read(PAGE);
    expect(page).toContain("resolve:");
    expect(page).toContain('mcp: ["pai"]');
    expect(page).toContain("selectMcpServers");
    expect(page).toContain("/proc/sys/kernel/yama/ptrace_scope");
    expect(page).toContain("EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE");
  });

  test("the loopback recipe: no secret, network off, resume and store on", () => {
    const page = read(PAGE);
    expect(page).toContain("http://127.0.0.1:");
    expect(page).toContain("allowNetwork: false");
    expect(page).toContain("sessionStore");
    expect(page).toContain("resumeSessionId");
  });

  test("the page states the truncation and points to the pagination task", () => {
    const page = read(PAGE);
    expect(page).toContain("ENABLE_MCP_LARGE_OUTPUT_FILES=0");
    expect(page).toContain("MAX_MCP_OUTPUT_TOKENS");
    expect(page).toContain("25,000 tokens");
    expect(page).toContain("4tas8fc2");
  });

  test("the page links to its conformance test", () => {
    expect(read(PAGE)).toContain(
      "tests/agents/driver/mcp-headless-lane-linux.test.ts",
    );
    expect(
      existsSync(
        join(REPO_ROOT, "tests/agents/driver/mcp-headless-lane-linux.test.ts"),
      ),
    ).toBe(true);
  });

  test("the CHANGELOG's Unreleased section names the page", () => {
    expect(unreleased()).toContain("docs/mcp-headless-lane.md");
  });
});
