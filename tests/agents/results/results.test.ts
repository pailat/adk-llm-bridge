import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  AGENT_RESULT_SCHEMA_IDS,
  type AgentResultSchemaId,
  agentResultJsonSchemas,
  agentResultSchemas,
  CHANGED_PATH_REFUSAL_CODES,
  checkChangedPaths,
  GateResultV1Schema,
  ImplementResultV1Schema,
  parseAgentResult,
  ReviewResultV1Schema,
  TestsResultV1Schema,
} from "../../../src/agents/results/index.js";
import { jsonSchemaAccepts } from "../../workflows/spec/json-schema-eval.js";

/** One golden fixture file: the frozen JSON Schema and sample results. */
interface Golden {
  readonly id: AgentResultSchemaId;
  readonly jsonSchema: Record<string, unknown>;
  readonly valid: readonly { name: string; result: unknown }[];
  readonly invalid: readonly { name: string; result: unknown }[];
}

const fixturesDir = join(import.meta.dir, "fixtures");
const goldens: Golden[] = readdirSync(fixturesDir)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map(
    (name) =>
      JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as Golden,
  );

describe("agent result schemas", () => {
  test("there is one golden file per schema id", () => {
    expect(goldens.map((golden) => golden.id).sort()).toEqual(
      [...AGENT_RESULT_SCHEMA_IDS].sort(),
    );
    expect([...AGENT_RESULT_SCHEMA_IDS]).toEqual([
      "implement@1",
      "tests@1",
      "review@1",
      "gate@1",
    ]);
  });

  test("the named schemas are the ones in the id map", () => {
    expect(agentResultSchemas["implement@1"]).toBe(ImplementResultV1Schema);
    expect(agentResultSchemas["tests@1"]).toBe(TestsResultV1Schema);
    expect(agentResultSchemas["review@1"]).toBe(ReviewResultV1Schema);
    expect(agentResultSchemas["gate@1"]).toBe(GateResultV1Schema);
  });

  test("the id lists and maps are frozen", () => {
    expect(Object.isFrozen(AGENT_RESULT_SCHEMA_IDS)).toBe(true);
    expect(Object.isFrozen(agentResultSchemas)).toBe(true);
    expect(Object.isFrozen(agentResultJsonSchemas)).toBe(true);
    expect(Object.isFrozen(CHANGED_PATH_REFUSAL_CODES)).toBe(true);
  });

  test("no schema is registered in zod's global registry", () => {
    for (const id of AGENT_RESULT_SCHEMA_IDS) {
      expect(z.globalRegistry.has(agentResultSchemas[id])).toBe(false);
    }
  });

  test("no document declares a $schema dialect and each uses only portable keywords", () => {
    // Claude Code checks --json-schema with a default draft-07 Ajv, which
    // throws on a 2020-12 `$schema`, so no document may name a dialect.
    const portable = new Set([
      "title",
      "description",
      "type",
      "enum",
      "properties",
      "required",
      "additionalProperties",
      "items",
      "minimum",
    ]);
    for (const id of AGENT_RESULT_SCHEMA_IDS) {
      const stack: unknown[] = [agentResultJsonSchemas[id]];
      while (stack.length > 0) {
        const node = stack.pop() as Record<string, unknown>;
        expect(Object.hasOwn(node, "$schema")).toBe(false);
        for (const [key, value] of Object.entries(node)) {
          expect(portable.has(key)).toBe(true);
          if (key === "properties") {
            stack.push(...Object.values(value as Record<string, unknown>));
          } else if (key === "items") {
            stack.push(value);
          }
        }
      }
    }
  });

  test("only the documents with no optional property meet strict structured output", () => {
    // OpenAI strict mode, which Codex uses, needs every property in
    // `required`. The docs list the documents that do not meet it.
    const strict = AGENT_RESULT_SCHEMA_IDS.filter((id) => {
      const stack: unknown[] = [agentResultJsonSchemas[id]];
      while (stack.length > 0) {
        const node = stack.pop() as Record<string, unknown>;
        if (node.properties !== undefined) {
          const keys = Object.keys(node.properties as object);
          const required = (node.required ?? []) as string[];
          if (!keys.every((key) => required.includes(key))) return false;
          stack.push(...Object.values(node.properties as object));
        }
        if (node.items !== undefined) stack.push(node.items);
      }
      return true;
    });
    expect(strict).toEqual(["tests@1", "gate@1"]);
  });

  for (const golden of goldens) {
    describe(golden.id, () => {
      const jsonSchema = agentResultJsonSchemas[golden.id];

      test("the JSON Schema equals its golden copy", () => {
        // A change here is a new version: add `<kind>@2`, never edit `@1`.
        expect(jsonSchema).toEqual(golden.jsonSchema);
        expect(jsonSchema.title).toBe(golden.id);
      });

      test("the JSON Schema is deeply frozen", () => {
        const stack: unknown[] = [jsonSchema];
        while (stack.length > 0) {
          const node = stack.pop();
          if (typeof node !== "object" || node === null) continue;
          expect(Object.isFrozen(node)).toBe(true);
          stack.push(...Object.values(node));
        }
      });

      for (const sample of golden.valid) {
        test(`accepts: ${sample.name}`, () => {
          expect(jsonSchemaAccepts(jsonSchema, sample.result)).toBe(true);
          const parsed = parseAgentResult(golden.id, sample.result);
          expect(parsed.ok).toBe(true);
          if (parsed.ok) expect(parsed.value).toEqual(sample.result as never);
        });
      }

      for (const sample of golden.invalid) {
        test(`rejects: ${sample.name}`, () => {
          expect(jsonSchemaAccepts(jsonSchema, sample.result)).toBe(false);
          const parsed = parseAgentResult(golden.id, sample.result);
          expect(parsed.ok).toBe(false);
          if (parsed.ok) return;
          expect(parsed.issues.length).toBeGreaterThan(0);
          for (const issue of parsed.issues) {
            expect(typeof issue.message).toBe("string");
            expect(Array.isArray(issue.path)).toBe(true);
          }
        });
      }
    });
  }

  test("a parsed result does not share objects with the input", () => {
    const input = {
      status: "done",
      summary: "Done.",
      changedPaths: ["src/a.ts"],
    };
    const parsed = parseAgentResult("implement@1", input);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).not.toBe(input);
    expect(parsed.value.changedPaths).not.toBe(input.changedPaths);
  });

  test("an issue names the path of the bad value", () => {
    const parsed = parseAgentResult("review@1", {
      verdict: "approve",
      findings: [{ severity: "urgent", path: "a.ts", summary: "Bad." }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.map((issue) => issue.path)).toEqual([
      ["findings", 0, "severity"],
    ]);
  });

  test("a finding's line is counted from 1", () => {
    const review = (line: number) => ({
      verdict: "block",
      findings: [{ severity: "high", path: "a.ts", line, summary: "x" }],
    });
    expect(parseAgentResult("review@1", review(1)).ok).toBe(true);
    expect(parseAgentResult("review@1", review(0)).ok).toBe(false);
    expect(parseAgentResult("review@1", review(-3)).ok).toBe(false);
    expect(
      jsonSchemaAccepts(agentResultJsonSchemas["review@1"], review(0)),
    ).toBe(false);
  });

  test("a check's durationMs is not negative", () => {
    const gate = (durationMs: number) => ({
      passed: true,
      checks: [{ id: "lint", exitCode: 0, durationMs }],
    });
    expect(parseAgentResult("gate@1", gate(0)).ok).toBe(true);
    expect(parseAgentResult("gate@1", gate(-1)).ok).toBe(false);
    expect(jsonSchemaAccepts(agentResultJsonSchemas["gate@1"], gate(-1))).toBe(
      false,
    );
  });

  test("an unknown schema id is a programming error", () => {
    expect(() =>
      parseAgentResult("verify@1" as AgentResultSchemaId, {}),
    ).toThrow(TypeError);
    expect(() =>
      parseAgentResult("__proto__" as AgentResultSchemaId, {}),
    ).toThrow(TypeError);
  });
});

describe("checkChangedPaths", () => {
  const result = (changedPaths: string[]) => ({ changedPaths });

  test("returns no refusal when every path is inside an allowed path", () => {
    expect(
      checkChangedPaths(result(["src/billing/export.ts", "docs/billing.md"]), [
        "src/billing",
        "docs/billing.md",
      ]),
    ).toEqual([]);
  });

  test("accepts a parsed implement@1 result", () => {
    const parsed = parseAgentResult("implement@1", {
      status: "done",
      summary: "Done.",
      changedPaths: ["src/a.ts"],
    });
    if (!parsed.ok) throw new Error("fixture must parse");
    expect(checkChangedPaths(parsed.value, ["src"])).toEqual([]);
  });

  test("refuses a path outside the allowed paths", () => {
    expect(
      checkChangedPaths(result(["src/billing/a.ts", "src/auth/token.ts"]), [
        "src/billing",
      ]),
    ).toEqual([
      {
        code: "CHANGED_PATH_OUTSIDE_ALLOWED_PATHS",
        index: 1,
        path: "src/auth/token.ts",
        message: '"src/auth/token.ts" is outside the allowed paths',
      },
    ]);
  });

  test("an allowed path covers entries below it, not siblings sharing a prefix", () => {
    const refusals = checkChangedPaths(result(["src/billing-old/a.ts"]), [
      "src/billing",
    ]);
    expect(refusals.map((refusal) => refusal.code)).toEqual([
      "CHANGED_PATH_OUTSIDE_ALLOWED_PATHS",
    ]);
  });

  test("no allowed paths refuses every change", () => {
    expect(
      checkChangedPaths(result(["a.ts", "b.ts"]), []).map((r) => r.index),
    ).toEqual([0, 1]);
  });

  test("the root allows every portable path", () => {
    expect(checkChangedPaths(result(["a.ts", "src/b/c.ts"]), ["."])).toEqual(
      [],
    );
  });

  test("a changed path is compared in canonical form", () => {
    expect(
      checkChangedPaths(result(["./src/billing//a.ts", "src/billing/"]), [
        "src/billing",
      ]),
    ).toEqual([]);
  });

  test("refuses a changed path that is not portable", () => {
    const bad = [
      "",
      "/etc/passwd",
      "C:/repo/a.ts",
      "src\\a.ts",
      "src/../secrets.txt",
      ".",
      "a\0b",
      "   ",
      "a:notes/x.md",
      "a".repeat(4097),
    ];
    const refusals = checkChangedPaths(result(bad), ["."]);
    expect(refusals.map((refusal) => [refusal.code, refusal.index])).toEqual(
      bad.map((_, index) => ["CHANGED_PATH_INVALID", index]),
    );
    for (const refusal of refusals) {
      expect(refusal.message.length).toBeGreaterThan(0);
    }
  });

  test("refuses a segment a host could read as the parent directory", () => {
    const bad = [
      "src/billing/.. /auth/token.ts",
      "src/billing/... /auth/token.ts",
      "src/billing/\u{ff0e}\u{ff0e}/auth/x.ts",
      "src/billing/%2e%2e/auth/x.ts",
      "src/billing/\u{3002}\u{3002}/auth/x.ts",
      "src/billing/x\u{2215}..\u{2215}auth/x.ts",
      "src/billing/..%20/auth/token.ts",
      "src/billing/%2e%2e%20/auth/token.ts",
      "src/billing/%c0%ae%c0%ae/auth/token.ts",
      "src/billing/%e0%80%ae%e0%80%ae/auth/token.ts",
      "src/billing/%252e%252e/auth/token.ts",
      "src/billing/x%c0%af..%c0%afauth/token.ts",
    ];
    const refusals = checkChangedPaths(result(bad), ["src/billing"]);
    expect(refusals.map((refusal) => [refusal.code, refusal.index])).toEqual(
      bad.map((_, index) => ["CHANGED_PATH_INVALID", index]),
    );
    const good = [
      "src/billing/a%20b.ts",
      "src/billing/.%20env",
      "src/billing/%2e",
    ];
    expect(checkChangedPaths(result(good), ["src/billing"])).toEqual([]);
  });

  test("refuses a path with control, format or invisible characters", () => {
    const bad = [
      "src/billing/a.ts\nrefusals: none",
      "src/billing/\u{202e}sts.a",
      "src/billing/.g\u{200c}it/config",
    ];
    const refusals = checkChangedPaths(result(bad), ["src/billing"]);
    expect(refusals.map((refusal) => refusal.code)).toEqual(
      bad.map(() => "CHANGED_PATH_INVALID"),
    );
    for (const refusal of refusals) {
      expect(refusal.message.startsWith(JSON.stringify(refusal.path))).toBe(
        true,
      );
    }
  });

  test("quotes the path in an outside refusal", () => {
    const [refusal] = checkChangedPaths(result(["docs/a b.md"]), ["src"]);
    expect(refusal?.message).toBe('"docs/a b.md" is outside the allowed paths');
  });

  test("compares case-sensitively", () => {
    expect(
      checkChangedPaths(result(["src/Billing/a.ts"]), ["src/billing"]).map(
        (refusal) => refusal.code,
      ),
    ).toEqual(["CHANGED_PATH_OUTSIDE_ALLOWED_PATHS"]);
  });

  test("an allowed path that is not canonical is a programming error", () => {
    expect(() => checkChangedPaths(result(["a.ts"]), ["./src"])).toThrow(
      TypeError,
    );
    expect(() => checkChangedPaths(result(["a.ts"]), ["../src"])).toThrow(
      TypeError,
    );
  });

  test("the refusal codes are the ones it returns", () => {
    expect([...CHANGED_PATH_REFUSAL_CODES]).toEqual([
      "CHANGED_PATH_INVALID",
      "CHANGED_PATH_OUTSIDE_ALLOWED_PATHS",
    ]);
  });
});
