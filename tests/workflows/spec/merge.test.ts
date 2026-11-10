import { describe, expect, test } from "bun:test";
import {
  mergeRunRules,
  RUN_RULE_KEYS,
  RUN_SPEC_LIMITS,
  RunRulesSchema,
} from "../../../src/workflows/spec/schema.js";
import { testRules } from "./helpers.js";

describe("workflow and target ref rules", () => {
  test("are required keys of a rule set", () => {
    expect(RUN_RULE_KEYS).toContain("allowedWorkflows");
    expect(RUN_RULE_KEYS).toContain("allowedTargetRefs");
    for (const key of ["allowedWorkflows", "allowedTargetRefs"] as const) {
      const rules: Record<string, unknown> = { ...testRules() };
      delete rules[key];
      expect(RunRulesSchema.safeParse(rules).success).toBe(false);
    }
  });

  test("reject an entry that is not a valid workflow id, version or ref", () => {
    for (const edit of [
      (r: Record<string, unknown>) =>
        (r.allowedWorkflows = [{ workflowId: "", workflowVersion: "1" }]),
      (r: Record<string, unknown>) =>
        (r.allowedWorkflows = [{ workflowId: "lanes" }]),
      (r: Record<string, unknown>) =>
        (r.allowedWorkflows = [
          { workflowId: "lanes", workflowVersion: "1", extra: 1 },
        ]),
      (r: Record<string, unknown>) => (r.allowedTargetRefs = ["refs/../main"]),
      (r: Record<string, unknown>) => (r.allowedTargetRefs = ["main:x"]),
    ]) {
      const rules: Record<string, unknown> = { ...testRules() };
      edit(rules);
      expect(RunRulesSchema.safeParse(rules).success).toBe(false);
    }
  });

  test("an override keeps only the workflows and refs both lists name", () => {
    const base = testRules();
    base.allowedWorkflows = [
      { workflowId: "lanes", workflowVersion: "1" },
      { workflowId: "lanes", workflowVersion: "2" },
    ];
    base.allowedTargetRefs = ["refs/heads/main", "refs/heads/release"];
    const merged = mergeRunRules(base, {
      id: "team",
      allowedWorkflows: [
        { workflowId: "lanes", workflowVersion: "2" },
        { workflowId: "deploy", workflowVersion: "1" },
      ],
      allowedTargetRefs: ["refs/heads/release", "refs/heads/other"],
    });
    expect(merged.allowedWorkflows).toEqual([
      { workflowId: "lanes", workflowVersion: "2" },
    ]);
    expect(merged.allowedTargetRefs).toEqual(["refs/heads/release"]);
    expect(merged.origins?.allowedWorkflows).toEqual(["test", "team"]);
    expect(merged.origins?.allowedTargetRefs).toEqual(["test", "team"]);
    expect(RunRulesSchema.safeParse(merged).success).toBe(true);
  });

  test("an override cannot add a workflow or a ref", () => {
    const merged = mergeRunRules(testRules(), {
      id: "team",
      allowedWorkflows: [
        { workflowId: "lanes", workflowVersion: "1" },
        { workflowId: "deploy", workflowVersion: "1" },
      ],
      allowedTargetRefs: ["refs/heads/main", "refs/heads/anything"],
    });
    expect(merged.allowedWorkflows).toEqual(testRules().allowedWorkflows);
    expect(merged.allowedTargetRefs).toEqual(testRules().allowedTargetRefs);
  });
});

describe("mergeRunRules input checks", () => {
  test("throws a TypeError for a base that is not a valid rule set", () => {
    const base: Record<string, unknown> = { ...testRules() };
    delete base.allowedModels;
    expect(() =>
      mergeRunRules(base as unknown as ReturnType<typeof testRules>),
    ).toThrow(TypeError);
  });

  test("throws a TypeError for a base whose values break the schema", () => {
    const base = testRules();
    base.maxBudgetUsd = -5;
    expect(() => mergeRunRules(base)).toThrow(TypeError);
    const fullAccess = testRules();
    fullAccess.allowedPermissionModes = ["full-access" as never, "read-only"];
    expect(() => mergeRunRules(fullAccess)).toThrow(TypeError);
  });

  test("throws a TypeError for an override that is not a valid override", () => {
    expect(() =>
      mergeRunRules(testRules(), {
        id: "team",
        maxBudgetUsd: -1,
      }),
    ).toThrow(TypeError);
    expect(() =>
      mergeRunRules(testRules(), {
        id: "team",
        unknownRule: true,
      } as never),
    ).toThrow(TypeError);
  });

  test("throws a TypeError when the overrides would record too many origins", () => {
    const overrides = Array.from(
      { length: RUN_SPEC_LIMITS.maxRuleOrigins },
      (_, index) => ({
        id: `layer-${index}`,
        deniedPathPatterns: [`extra-${index}.txt`],
      }),
    );
    expect(() => mergeRunRules(testRules(), ...overrides)).toThrow(TypeError);
  });

  test("accepts as many overrides as the origin limit allows", () => {
    const overrides = Array.from(
      { length: RUN_SPEC_LIMITS.maxRuleOrigins - 1 },
      (_, index) => ({
        id: `layer-${index}`,
        deniedPathPatterns: [`extra-${index}.txt`],
      }),
    );
    const merged = mergeRunRules(testRules(), ...overrides);
    expect(merged.origins?.deniedPathPatterns).toHaveLength(
      RUN_SPEC_LIMITS.maxRuleOrigins,
    );
    expect(RunRulesSchema.safeParse(merged).success).toBe(true);
  });
});
