import { describe, expect, test } from "bun:test";
import {
  RUN_SPEC_ISSUE_FAMILIES,
  RUN_SPEC_ISSUE_FAMILY_NAMES,
  RUN_SPEC_MAX_ISSUES,
  type RunSpecIssue,
} from "../../../src/workflows/spec/issues.js";
import type { RunSpec } from "../../../src/workflows/spec/schema.js";
import { validateRunSpec } from "../../../src/workflows/spec/validate.js";
import { testRules, validSpec, wideSpec } from "./helpers.js";

/** Time budget for the 1,000-lane runs; generous so a slow machine passes. */
const TIME_BUDGET_MS = 2_000;

function codes(errors: readonly RunSpecIssue[]): string[] {
  return errors.map((issue) => issue.code);
}

function failure(spec: unknown, rules = testRules()): RunSpecIssue[] {
  const result = validateRunSpec(spec, rules);
  if (result.ok) {
    throw new Error("expected the spec to be rejected");
  }
  return result.errors;
}

/** A spec that breaks one rule in each of the five rule families. */
function brokenInEveryFamily(): RunSpec {
  const spec = validSpec();
  const [first, second] = spec.lanes;
  if (first === undefined || second === undefined) {
    throw new Error("helper spec must have two lanes");
  }
  first.allowedPaths = [".env"];
  spec.budget = { maxUsd: 50 };
  second.agent = { ...second.agent, providerId: "gemini" };
  second.dependsOn = ["missing"];
  spec.gates = { qa: [], publish: { kind: "commit", hitl: true } };
  return spec;
}

describe("validateRunSpec", () => {
  test("accepts the valid helper spec and returns an equal spec", () => {
    const input = validSpec();
    const result = validateRunSpec(input, testRules());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec).toEqual(validSpec());
      expect(result.spec).not.toBe(input);
      expect(Object.isFrozen(result.spec)).toBe(true);
    }
  });

  test("does not mutate the input, on success or on failure", () => {
    const good = validSpec();
    const goodBefore = structuredClone(good);
    validateRunSpec(good, testRules());
    expect(good).toEqual(goodBefore);
    expect(Object.isFrozen(good)).toBe(false);

    const bad = brokenInEveryFamily();
    const badBefore = structuredClone(bad);
    validateRunSpec(bad, testRules());
    expect(bad).toEqual(badBefore);
    expect(Object.isFrozen(bad)).toBe(false);
  });

  test("does not mutate the rule set", () => {
    const rules = testRules();
    const before = structuredClone(rules);
    validateRunSpec(brokenInEveryFamily(), rules);
    validateRunSpec(validSpec(), rules);
    expect(rules).toEqual(before);
  });

  test("returns the same issues in the same order on every call", () => {
    const first = failure(brokenInEveryFamily());
    const second = failure(brokenInEveryFamily());
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThanOrEqual(5);
  });

  test("reports an issue of every rule family in one call", () => {
    const families = new Set(
      codes(failure(brokenInEveryFamily())).map(
        (code) =>
          RUN_SPEC_ISSUE_FAMILIES[code as keyof typeof RUN_SPEC_ISSUE_FAMILIES],
      ),
    );
    for (const name of ["paths", "budget", "models", "graph", "gates"]) {
      expect(families.has(name as never)).toBe(true);
    }
  });

  test("lists issues in family order", () => {
    const order: readonly string[] = RUN_SPEC_ISSUE_FAMILY_NAMES;
    const ranks = codes(failure(brokenInEveryFamily())).map((code) =>
      order.indexOf(
        RUN_SPEC_ISSUE_FAMILIES[code as keyof typeof RUN_SPEC_ISSUE_FAMILIES],
      ),
    );
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  test("a shape failure reports only shape issues and skips the rule families", () => {
    const spec = validSpec() as unknown as Record<string, unknown>;
    spec.maxConcurrency = "two";
    const errors = failure(spec);
    expect(errors.length).toBeGreaterThan(0);
    for (const issue of errors) {
      expect(RUN_SPEC_ISSUE_FAMILIES[issue.code]).toBe("shape");
    }
  });

  test("a malformed rule set is reported, not thrown", () => {
    const rules = { id: "broken" } as unknown as ReturnType<typeof testRules>;
    expect(codes(failure(validSpec(), rules))).toContain(
      "RUN_SPEC_RULES_INVALID",
    );
  });

  test("a malformed rule set is a host error, never an internal error", () => {
    const rules = { id: "broken" } as unknown as ReturnType<typeof testRules>;
    expect(codes(failure(validSpec(), rules))).toEqual([
      "RUN_SPEC_RULES_INVALID",
    ]);
  });

  test("a path-only failure reports only path codes", () => {
    const spec = validSpec();
    const lane = spec.lanes[0];
    if (lane === undefined) throw new Error("helper spec has no lane");
    lane.allowedPaths = ["src/../escape.ts"];
    const reported = codes(failure(spec));
    expect(reported.length).toBeGreaterThan(0);
    for (const code of reported) {
      expect(code.startsWith("RUN_SPEC_PATH_")).toBe(true);
    }
  });

  test("a non-JSON input is rejected with one issue", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(codes(failure(cyclic))).toEqual(["RUN_SPEC_INPUT_NOT_JSON"]);
  });

  test("never returns more than the issue cap", () => {
    const spec = wideSpec(300);
    for (const lane of spec.lanes) {
      (lane as { role: string }).role = "lead";
    }
    const errors = failure(spec);
    expect(errors.length).toBeLessThanOrEqual(RUN_SPEC_MAX_ISSUES);
    expect(codes(errors).at(-1)).toBe("RUN_SPEC_ISSUES_TRUNCATED");
  });

  test("validates a 1,000-lane valid spec within the time budget", () => {
    const spec = wideSpec(1_000);
    const start = performance.now();
    const result = validateRunSpec(spec, testRules());
    const elapsed = performance.now() - start;
    expect(result.ok).toBe(true);
    expect(elapsed).toBeLessThan(TIME_BUDGET_MS);
  });

  test("validates a 1,000-lane spec with one cycle and one path overlap within the time budget", () => {
    const spec = wideSpec(1_000);
    const lanes = spec.lanes;
    const zero = lanes[0];
    const five = lanes[5];
    if (zero === undefined || five === undefined) {
      throw new Error("wide spec must have 1,000 lanes");
    }
    zero.dependsOn = ["lane-990"];
    five.allowedPaths = [...five.allowedPaths, "src/lane-6/nested"];
    const start = performance.now();
    const result = validateRunSpec(spec, testRules());
    const elapsed = performance.now() - start;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const found = codes(result.errors);
      expect(found).toContain("RUN_SPEC_DEPENDENCY_CYCLE");
      expect(found).toContain("RUN_SPEC_PATH_OVERLAP");
    }
    expect(elapsed).toBeLessThan(TIME_BUDGET_MS);
  });
});

describe("validateRunSpec and resolveRunPlan agree", () => {
  test("a spec validates exactly when it can be planned", async () => {
    const { resolveRunPlan } = await import(
      "../../../src/workflows/spec/plan.js"
    );
    const specs: RunSpec[] = [validSpec(), wideSpec(1_000)];
    const nested = validSpec();
    nested.projectRoot = "packages/app";
    specs.push(nested);
    const manyPaths = wideSpec(16);
    manyPaths.lanes.forEach((lane, laneIndex) => {
      lane.allowedPaths = Array.from(
        { length: 64 },
        (_, index) => `src/l${laneIndex}/p${index}`,
      );
    });
    specs.push(manyPaths);
    for (const spec of specs) {
      const validated = validateRunSpec(spec, testRules());
      const planned = resolveRunPlan(spec, testRules());
      expect(validated.ok).toBe(true);
      expect(planned.ok).toBe(validated.ok);
    }
  });
});
