import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import packageJson from "../../package.json" with { type: "json" };
import * as agents from "../../src/agents/index.js";

const repoRoot = join(import.meta.dir, "..", "..");

/** Runtime names the removed Gemini CLI external agent used to export. */
const REMOVED_VALUES = [
  "GeminiCliDriver",
  "GeminiCliAgent",
  "GEMINI_CLI_AGENT_DEFINITION",
  "GEMINI_CLI_PROVIDER",
  "GEMINI_CLI_ENV_ALLOWLIST",
  "GEMINI_CLI_OPTION_KEYS",
  "GEMINI_MODEL_ENV",
  "GEMINI_PLAN_MODE_REASON",
  "mapGeminiPermissionArgs",
  "buildGeminiArgs",
];

/** Type names it used to export (checked in the entry point sources). */
const REMOVED_TYPES = [
  "GeminiCliDriverConfig",
  "GeminiCliSpawn",
  "GeminiCliSpawnOptions",
  "GeminiCliSubprocess",
  "GeminiCliAgentConfig",
];

/** Every package `exports` subpath that maps to a module, as its src entry. */
function entryPoints(): { subpath: string; source: string }[] {
  return Object.entries(packageJson.exports as Record<string, unknown>)
    .filter(([subpath]) => subpath !== "./package.json")
    .map(([subpath, target]) => {
      const dist =
        typeof target === "string"
          ? target
          : (target as { import: string }).import;
      const source = dist.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts");
      return { subpath, source };
    });
}

describe("the Gemini CLI external agent is removed", () => {
  test("package exports cover the root and the agents subpath", () => {
    const subpaths = entryPoints().map((entry) => entry.subpath);
    expect(subpaths).toContain(".");
    expect(subpaths).toContain("./agents");
  });

  for (const { subpath, source } of entryPoints()) {
    test(`no Gemini CLI value is exported from "${subpath}"`, async () => {
      const mod = (await import(join(repoRoot, source))) as Record<
        string,
        unknown
      >;
      const present = REMOVED_VALUES.filter((name) => name in mod);
      expect(present).toEqual([]);
    });

    test(`no Gemini CLI name is re-exported by ${source}`, () => {
      const text = readFileSync(join(repoRoot, source), "utf8");
      const present = [...REMOVED_VALUES, ...REMOVED_TYPES].filter((name) =>
        new RegExp(`\\b${name}\\b`).test(text),
      );
      expect(present).toEqual([]);
      expect(text).not.toMatch(/gemini-cli/);
    });
  }

  test("the default registries hold no gemini-cli entry", () => {
    expect(
      agents.createDefaultExternalAgentProviderRegistry().has("gemini-cli"),
    ).toBe(false);
    expect(
      agents.createDefaultExternalAgentDefinitionRegistry().get("gemini-cli"),
    ).toBeUndefined();
    expect(() =>
      agents
        .createDefaultExternalAgentDefinitionRegistry()
        .create("gemini-cli", { name: "g" }),
    ).toThrow("Unknown external agent provider: gemini-cli");
  });
});
