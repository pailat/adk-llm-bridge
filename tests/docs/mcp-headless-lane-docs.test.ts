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

  test("the loopback proxy sample: /mcp only, no idle cut-off, body passed as sent", () => {
    // The Linux conformance test imports this function from the page.
    const proxy = read(PAGE).match(
      /^export function startMcpProxy\([\s\S]*?^\}$/m,
    )?.[0];
    expect(proxy).toBeDefined();
    expect(proxy).toContain('pathname !== "/mcp"');
    expect(proxy).toContain("status: 404");
    expect(proxy).toContain("idleTimeout: 0");
    // The upstream fetch has its own 5-minute idle default; a real wait that
    // long is too slow for a test, so the option is checked here.
    expect(proxy).toContain("timeout: false");
    expect(proxy).toContain("decompress: false");
  });

  test("the loopback recipe keeps the token where the agent cannot read it", () => {
    const page = read(PAGE);
    const start = page.indexOf("### Where the proxy keeps the token");
    expect(start).toBeGreaterThan(-1);
    const next = page.indexOf("\n#", start + 1);
    const section = page.slice(start, next === -1 ? undefined : next);
    expect(section).toContain("/proc/<pid>/environ");
    expect(section).toContain("readPaths");
    expect(section).toMatch(/separate\s+OS\s+user/);
    expect(section).toContain("ptrace_scope");
    expect(page).toMatch(/The driver enforces no `ptrace_scope` condition/);
  });

  test("the loopback proxy sample refuses browsers: own Host only, no Origin", () => {
    const proxy = read(PAGE).match(
      /^export function startMcpProxy\([\s\S]*?^\}$/m,
    )?.[0];
    expect(proxy).toContain("fetch(req, server)");
    expect(proxy).toContain("`127.0.0.1:$" + "{server.port}`");
    expect(proxy).toContain('req.headers.has("origin")');
    expect(proxy).toContain("status: 403");
  });

  test("who may call the proxy: no unsandboxed shell for a granted agent, on any lane", () => {
    const page = read(PAGE);
    const start = page.indexOf("### Who may call the proxy");
    expect(start).toBeGreaterThan(-1);
    const next = page.indexOf("\n#", start + 1);
    const section = page.slice(start, next === -1 ? undefined : next);
    expect(section).toContain("allowUnsandboxedShell: true");
    expect(section).toContain("allowNetwork: true");
    expect(section).toMatch(/any\s+lane\s+of\s+the\s+host/);
    expect(section).toMatch(/DNS\s+rebinding/);
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
