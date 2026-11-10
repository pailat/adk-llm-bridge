import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunRules } from "../../../src/workflows/spec/schema.js";
import { validateRunSpec } from "../../../src/workflows/spec/validate.js";
import { testRules } from "./helpers.js";

const CORPUS_DIR = fileURLToPath(new URL("./corpus/", import.meta.url));

interface CorpusCase {
  readonly description: string;
  readonly rules: RunRules | null;
  readonly spec: unknown;
  readonly expectCodes: readonly string[];
}

function load(group: "valid" | "invalid"): [string, CorpusCase][] {
  const dir = join(CORPUS_DIR, group);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => [
      name,
      JSON.parse(readFileSync(join(dir, name), "utf8")) as CorpusCase,
    ]);
}

describe("run spec corpus through validateRunSpec", () => {
  const valid = load("valid");
  const invalid = load("invalid");

  test("the corpus has valid and invalid cases", () => {
    expect(valid.length).toBeGreaterThan(0);
    expect(invalid.length).toBeGreaterThan(0);
  });

  for (const [name, item] of valid) {
    test(`valid case ${name} passes`, () => {
      const result = validateRunSpec(item.spec, item.rules ?? testRules());
      expect(result.ok ? [] : result.errors).toEqual([]);
      expect(result.ok).toBe(true);
    });
  }

  for (const [name, item] of invalid) {
    test(`invalid case ${name} reports every expected code`, () => {
      const result = validateRunSpec(item.spec, item.rules ?? testRules());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const found = new Set(result.errors.map((issue) => issue.code));
        const missing = item.expectCodes.filter(
          (code) => !found.has(code as never),
        );
        expect(missing).toEqual([]);
      }
    });
  }

  test("the path_invalid case reports the NUL path and the 4,096-character path", () => {
    const item = invalid.find(
      ([name]) => name === "run_spec_path_invalid.json",
    );
    expect(item).toBeDefined();
    if (item === undefined) return;
    const result = validateRunSpec(item[1].spec, item[1].rules ?? testRules());
    const paths = result.ok
      ? []
      : result.errors
          .filter((issue) => issue.code === "RUN_SPEC_PATH_INVALID")
          .map((issue) => issue.path.join("."));
    expect(paths).toEqual(["lanes.0.allowedPaths.0", "lanes.1.allowedPaths.0"]);
  });
});
