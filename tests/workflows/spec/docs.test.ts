import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as spec from "../../../src/workflows/spec/index.js";
import {
  RUN_SPEC_ISSUE_CODES,
  RunSpecSchema,
  validateRunSpec,
} from "../../../src/workflows/spec/index.js";
import { testRules } from "./helpers.js";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

/** Text of the section under a heading with the given title, through the next heading of the same or higher level. */
function section(doc: string, title: string): string {
  const lines = doc.split("\n");
  const start = lines.findIndex(
    (line) =>
      /^#{1,6}\s/.test(line) &&
      line
        .replace(/^#+\s+/, "")
        .trim()
        .toLowerCase() === title.toLowerCase(),
  );
  if (start < 0) return "";
  const level = lines[start]?.match(/^#+/)?.[0].length ?? 1;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    const heading = /^(#{1,6})\s/.exec(lines[index] ?? "");
    if (heading && (heading[1]?.length ?? 0) <= level) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** Bodies of every fenced `json` block of a Markdown document. */
function jsonBlocks(doc: string): string[] {
  return [...doc.matchAll(/```json\n([\s\S]*?)\n```/g)].map(
    (match) => match[1] ?? "",
  );
}

const DOC_PATH = "docs/workflow-run-spec.md";
const doc = (): string => read(DOC_PATH);

describe("workflow run spec documentation", () => {
  test("the document is marked experimental and states the zod requirement", () => {
    const text = doc();
    expect(text).toMatch(/experimental/i);
    expect(text).toMatch(/zod\s*>=\s*4/);
  });

  test("the document has the sections the lane requires", () => {
    const headings = doc()
      .split("\n")
      .filter((line) => /^#{1,6}\s/.test(line))
      .map((line) => line.toLowerCase());
    for (const keyword of [
      "comparison",
      "mapping",
      "example",
      "rule",
      "error",
      "plan",
      "json schema",
      "path",
      "host",
      "next",
    ]) {
      expect(headings.some((line) => line.includes(keyword))).toBe(true);
    }
  });

  test("every RUN_SPEC issue code of issues.ts appears in the document", () => {
    const text = doc();
    const missing = RUN_SPEC_ISSUE_CODES.filter(
      (code) => !new RegExp(`\\b${code}\\b`).test(text),
    );
    expect(missing).toEqual([]);
  });

  test("the code list exported by issues.ts matches its source keys", () => {
    const source = read("src/workflows/spec/issues.ts");
    const sourceCodes = [
      ...source.matchAll(
        /(RUN_SPEC_[A-Z_]+):\s*"(?:shape|paths|budget|models|graph|gates)"/g,
      ),
    ].map((match) => match[1] ?? "");
    expect([...sourceCodes].sort()).toEqual([...RUN_SPEC_ISSUE_CODES].sort());
  });

  test("every RUN_SPEC name the document mentions is a code or an export", () => {
    const known = new Set<string>([
      ...RUN_SPEC_ISSUE_CODES,
      ...Object.keys(spec).filter((name) => name.startsWith("RUN_SPEC_")),
    ]);
    const mentioned = doc().match(/\bRUN_SPEC_[A-Z][A-Z_]*[A-Z]\b/g) ?? [];
    expect(mentioned.filter((name) => !known.has(name))).toEqual([]);
  });

  test("every rule set key is named in the document", () => {
    const text = doc();
    const missing = spec.RUN_RULE_KEYS.filter((key) => !text.includes(key));
    expect(missing).toEqual([]);
  });

  test("the example spec is a lanes job that validates under the test rule set", () => {
    const example = jsonBlocks(doc()).find((block) =>
      block.includes('"specVersion"'),
    );
    expect(example).toBeDefined();
    const parsed: unknown = JSON.parse(example ?? "null");
    expect(RunSpecSchema.safeParse(parsed).success).toBe(true);
    expect((parsed as { workflowId?: unknown }).workflowId).toBe("lanes");
    const result = validateRunSpec(parsed, testRules());
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  test("the mapping names the control-plane operation and the plan rules", () => {
    const mapping = section(doc(), "Mapping") || doc();
    for (const term of [
      "execution.start",
      "runSpecHash",
      "startInput",
      "validateWorkflowPlan",
      "subtree",
    ]) {
      expect(mapping).toContain(term);
    }
  });

  test("the document names the public functions it describes", () => {
    const text = doc();
    for (const name of [
      "validateRunSpec",
      "runSpecJsonSchema",
      "resolveRunPlan",
      "runSpecHash",
      "mergeRunRules",
      "layerRunSpecLanes",
      "DEFAULT_DENIED_PATH_PATTERNS",
    ]) {
      expect(text).toContain(name);
    }
  });

  test("the JSON Schema section states the draft and the exported function", () => {
    const schemaSection = section(doc(), "JSON Schema");
    expect(schemaSection).toContain("2020-12");
    expect(schemaSection).toContain("runSpecJsonSchema");
  });

  test("the next section lists the factory, server, worker, CLI and MCP", () => {
    const next = section(doc(), "Next");
    expect(next).not.toBe("");
    for (const term of ["factory", "server", "worker", "CLI", "MCP"]) {
      expect(next).toContain(term);
    }
  });

  test("the document uses no internal tracking labels", () => {
    const text = doc();
    expect(text).not.toMatch(/\b(DF\d+|G-[A-Z]+|W\d+)\b/);
    expect(text).not.toMatch(/\brun id\b/i);
  });
});

describe("run spec links and entry points", () => {
  test("the docs index links the run spec page", () => {
    expect(read("docs/README.md")).toContain("workflow-run-spec.md");
  });

  test("the README peer table row for the spec subpath requires zod 4", () => {
    const rows = read("README.md")
      .split("\n")
      .filter(
        (line) => line.startsWith("|") && line.includes("workflows/spec"),
      );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => /zod\s*>=\s*4|zod@\^4/.test(row))).toBe(true);
  });

  test("the README lists the spec subpath in the workflows subpath list", () => {
    expect(read("README.md")).toContain("`adk-llm-bridge/workflows/spec`");
  });

  test("the 0.7.0 changelog has an experimental Added entry for the spec subpath", () => {
    const changelog = read("CHANGELOG.md");
    const release = changelog.slice(
      changelog.indexOf("## [0.7.0]"),
      changelog.indexOf("## [0.6.0]"),
    );
    const added = section(release, "Added");
    expect(added).toContain("adk-llm-bridge/workflows/spec");
    expect(added).toMatch(/experimental/i);
  });
});
