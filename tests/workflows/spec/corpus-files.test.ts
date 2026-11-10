import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { RUN_SPEC_ISSUE_CODES } from "../../../src/workflows/spec/issues.js";
import {
  RunRulesSchema,
  RunSpecSchema,
} from "../../../src/workflows/spec/schema.js";

/** Directory holding the valid and invalid run spec cases. */
const CORPUS_DIR = fileURLToPath(new URL("./corpus/", import.meta.url));

/** Minimum number of valid cases the corpus must hold. */
const MIN_VALID_CASES = 8;

/**
 * Code of the one case whose rule set is malformed on purpose: the rule set
 * is the input under test, so it may fail `RunRulesSchema`.
 */
const BROKEN_RULES_CODE = "RUN_SPEC_RULES_INVALID";

/**
 * Codes no JSON document can produce, so they have no corpus file.
 * `RUN_SPEC_INTERNAL_ERROR` reports a defect of the library: a rule family
 * that throws on a spec whose shape and rule set are valid. The validator
 * tests reach it with a rule set whose getter throws on its second read.
 */
const CODES_WITHOUT_CORPUS_CASE: readonly string[] = [
  "RUN_SPEC_INTERNAL_ERROR",
];

/** Keys every corpus file must have, checked before the schema runs. */
const REQUIRED_KEYS = ["description", "rules", "spec", "expectCodes"] as const;

/**
 * Shape of one corpus file. `rules` is `null` when the case uses the test
 * rule set.
 *
 * @remarks
 * `rules` and `spec` take any value because a file is read with
 * `JSON.parse`, which can yield a non-finite number (for example `1e400`).
 * Such a number is the input under test in the not-JSON case, so the
 * schema must not reject it. Presence of every key is checked separately,
 * since zod makes keys whose value is `unknown` optional.
 */
const CorpusCaseSchema = z.strictObject({
  description: z.string().min(1),
  rules: z.unknown(),
  spec: z.unknown(),
  expectCodes: z.array(z.string()),
});

/** Whether a parsed JSON value is an object that has the key. */
function hasKey(value: unknown, key: string): boolean {
  return (
    typeof value === "object" && value !== null && Object.hasOwn(value, key)
  );
}

/** One corpus case: a description, the rule set, the spec and expected codes. */
type CorpusCase = z.infer<typeof CorpusCaseSchema>;

/** The corpus folder a case belongs to. */
type Group = "valid" | "invalid";

/** A corpus file read from disk, before it is parsed. */
interface CorpusFile {
  readonly group: Group;
  readonly name: string;
  readonly text: string;
}

/** A corpus file that parsed as a case. */
interface ParsedCase {
  readonly group: Group;
  readonly name: string;
  readonly case: CorpusCase;
}

/** Reads every `.json` file of both groups. A missing group yields none. */
function readCorpusFiles(): CorpusFile[] {
  const files: CorpusFile[] = [];
  for (const group of ["valid", "invalid"] as const) {
    const dir = join(CORPUS_DIR, group);
    if (!existsSync(dir)) {
      continue;
    }
    const names = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort();
    for (const name of names) {
      files.push({ group, name, text: readFileSync(join(dir, name), "utf8") });
    }
  }
  return files;
}

/** Problems of the files that do not parse as a case, one line each. */
function parseFailures(files: CorpusFile[]): string[] {
  const failures: string[] = [];
  for (const file of files) {
    const where = `${file.group}/${file.name}`;
    let json: unknown;
    try {
      json = JSON.parse(file.text);
    } catch {
      failures.push(`${where}: not valid JSON`);
      continue;
    }
    for (const key of REQUIRED_KEYS) {
      if (!hasKey(json, key)) {
        failures.push(`${where}: missing key ${key}`);
      }
    }
    const result = CorpusCaseSchema.safeParse(json);
    if (!result.success) {
      for (const issue of result.error.issues) {
        failures.push(
          `${where}: ${issue.path.join(".") || "(root)"}: ${issue.message}`,
        );
      }
    }
  }
  return failures;
}

/** Files that parse as a case, with their group and name. */
function parsedCases(files: CorpusFile[]): ParsedCase[] {
  const cases: ParsedCase[] = [];
  for (const file of files) {
    const result = CorpusCaseSchema.safeParse(JSON.parse(file.text));
    if (result.success) {
      cases.push({ group: file.group, name: file.name, case: result.data });
    }
  }
  return cases;
}

const files = readCorpusFiles();
const cases = parsedCases(files);

describe("run spec corpus files", () => {
  test("the corpus directory has files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test("every file is JSON with exactly the description, rules, spec and expectCodes keys", () => {
    expect(parseFailures(files)).toEqual([]);
  });

  test("every rule set is null or a complete RunRules, except the case that breaks the rule set", () => {
    const failures: string[] = [];
    for (const item of cases) {
      if (item.case.rules === null) {
        continue;
      }
      if (item.case.expectCodes.includes(BROKEN_RULES_CODE)) {
        continue;
      }
      const result = RunRulesSchema.safeParse(item.case.rules);
      if (!result.success) {
        failures.push(`${item.group}/${item.name}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test(`the valid group has at least ${MIN_VALID_CASES} cases`, () => {
    const valid = cases.filter((item) => item.group === "valid");
    expect(valid.length).toBeGreaterThanOrEqual(MIN_VALID_CASES);
  });

  test("every valid case lists no codes and holds a spec that parses the spec schema", () => {
    const failures: string[] = [];
    for (const item of cases) {
      if (item.group !== "valid") {
        continue;
      }
      if (item.case.expectCodes.length !== 0) {
        failures.push(`${item.name}: lists codes`);
      }
      if (!RunSpecSchema.safeParse(item.case.spec).success) {
        failures.push(`${item.name}: spec does not parse`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("every invalid case lists at least one known code", () => {
    const known: readonly string[] = RUN_SPEC_ISSUE_CODES;
    const failures: string[] = [];
    for (const item of cases) {
      if (item.group !== "invalid") {
        continue;
      }
      if (item.case.expectCodes.length === 0) {
        failures.push(`${item.name}: lists no codes`);
      }
      for (const code of item.case.expectCodes) {
        if (!known.includes(code)) {
          failures.push(`${item.name}: unknown code ${code}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test("every invalid case is named after one of the codes it lists, in lower case", () => {
    const failures: string[] = [];
    for (const item of cases) {
      if (item.group !== "invalid") {
        continue;
      }
      const named = item.case.expectCodes.some(
        (code) => item.name === `${code.toLowerCase()}.json`,
      );
      if (!named) {
        failures.push(item.name);
      }
    }
    expect(failures).toEqual([]);
  });

  test("every issue code has an invalid case that lists it", () => {
    const missing = RUN_SPEC_ISSUE_CODES.filter(
      (code) =>
        !CODES_WITHOUT_CORPUS_CASE.includes(code) &&
        !cases.some(
          (item) =>
            item.group === "invalid" &&
            item.name === `${code.toLowerCase()}.json` &&
            item.case.expectCodes.includes(code),
        ),
    );
    expect(missing).toEqual([]);
  });
});
