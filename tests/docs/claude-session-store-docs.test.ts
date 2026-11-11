import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// These tests only read files.
const REPO_ROOT = resolve(import.meta.dir, "../..");
const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");

/** The body of a `## ` section, empty when the heading is missing. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  if (start === -1) return "";
  const rest = text.slice(start + heading.length + 2);
  const end = rest.search(/\n#{1,2} /);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("docs/claude-session-store.md: ADK artifacts", () => {
  const page = read("docs/claude-session-store.md");
  const body = section(page, "## ADK artifacts");

  test("the section exists", () => {
    expect(body.length).toBeGreaterThan(0);
  });

  test("names the subpath, the factory and the error codes", () => {
    for (const name of [
      "adk-llm-bridge/agents/session-store/adk-artifacts",
      "adkArtifactSessionStore",
      "CLAUDE_SESSION_STORE_UNAVAILABLE",
      "SESSION_STORE_NO_ARTIFACT_SERVICE",
      "SESSION_STORE_CORRUPT_VERSION",
      "maxVersionBytes",
    ]) {
      expect(body).toContain(name);
    }
  });

  test("states the eager-flush cost and the retention rule", () => {
    expect(body).toContain("Cost of eager flushing");
    expect(body).toContain('sessionStoreFlush: "eager"');
    expect(body).toContain("saveArtifact");
    expect(body.toLowerCase()).toContain("retention");
  });

  test("the CLI refusal is still documented", () => {
    expect(page).toContain("EXTERNAL_AGENT_OPTION_UNSUPPORTED");
  });
});

describe("the code and the docs agree", () => {
  test("the documented code string is the exported one", async () => {
    const agents = await import("../../src/agents/index.js");
    expect(agents.CLAUDE_SESSION_STORE_UNAVAILABLE).toBe(
      "CLAUDE_SESSION_STORE_UNAVAILABLE",
    );
  });

  test("CHANGELOG and migration name the new subpath", () => {
    expect(read("CHANGELOG.md")).toContain(
      "adk-llm-bridge/agents/session-store/adk-artifacts",
    );
    expect(read("docs/migration-0.7.md")).toContain(
      "adk-llm-bridge/agents/session-store/adk-artifacts",
    );
  });

  test("package.json, the build and CI list the subpath", () => {
    const entry = "adk-artifacts";
    expect(read("package.json")).toContain(`session-store/${entry}`);
    expect(read("bunup.config.ts")).toContain(
      `session-store/${entry}/index.ts`,
    );
    expect(read(".github/workflows/ci.yml")).toContain(
      `agents/session-store/${entry}`,
    );
  });
});
