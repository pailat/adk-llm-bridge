import { describe, expect, test } from "bun:test";
import type { WorkflowPlan } from "../../../src/workflows/orchestration/contracts.js";
import type { RunSpecIssue } from "../../../src/workflows/spec/issues.js";
import {
  checkFullWorkflowPlan,
  checkGraphRules,
  fullWorkflowPlan,
  laneGraphWorkflowPlan,
} from "../../../src/workflows/spec/rules/graph.js";
import type { RunSpec } from "../../../src/workflows/spec/schema.js";
import {
  type RunSpecRuleFamily,
  validateRunSpecWith,
} from "../../../src/workflows/spec/validate.js";
import { testRules, validSpec } from "./helpers.js";

/** A projection with a defect: it throws instead of building a plan. */
function brokenProjection(): WorkflowPlan {
  throw new Error("projection defect");
}

/** A plan the existing plan validator rejects: its protocol is wrong. */
function rejectedPlan(plan: WorkflowPlan): WorkflowPlan {
  return { ...plan, protocol: "not-a-protocol" } as unknown as WorkflowPlan;
}

function codes(issues: readonly RunSpecIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

describe("the full plan check", () => {
  test("a valid spec's full plan is accepted", () => {
    const issues: RunSpecIssue[] = [];
    checkFullWorkflowPlan(validSpec(), issues);
    expect(issues).toEqual([]);
  });

  test("a plan the plan validator rejects is RUN_SPEC_PLAN_REJECTED", () => {
    const issues: RunSpecIssue[] = [];
    checkFullWorkflowPlan(validSpec(), issues, (spec) =>
      rejectedPlan(fullWorkflowPlan(spec)),
    );
    expect(codes(issues)).toEqual(["RUN_SPEC_PLAN_REJECTED"]);
  });

  test("a defect in the projection is thrown, not reported as a plan rejection", () => {
    const issues: RunSpecIssue[] = [];
    expect(() =>
      checkFullWorkflowPlan(validSpec(), issues, brokenProjection),
    ).toThrow("projection defect");
    expect(issues).toEqual([]);
  });

  test("validateRunSpec reports a defect of the full plan check as RUN_SPEC_INTERNAL_ERROR", () => {
    let result: ReturnType<typeof validateRunSpecWith> | undefined;
    expect(() => {
      result = validateRunSpecWith(validSpec(), testRules(), [], (spec, into) =>
        checkFullWorkflowPlan(spec, into, brokenProjection),
      );
    }).not.toThrow();
    expect(result?.ok === false && codes(result.errors)).toEqual([
      "RUN_SPEC_INTERNAL_ERROR",
    ]);
  });

  test("validateRunSpec reports the full plan's rejection as RUN_SPEC_PLAN_REJECTED", () => {
    const result = validateRunSpecWith(
      validSpec(),
      testRules(),
      [],
      (spec, into) =>
        checkFullWorkflowPlan(spec, into, (valid) =>
          rejectedPlan(fullWorkflowPlan(valid)),
        ),
    );
    expect(result.ok === false && codes(result.errors)).toEqual([
      "RUN_SPEC_PLAN_REJECTED",
    ]);
  });
});

describe("the lane graph check of the graph family", () => {
  function graphFamily(
    project: (spec: RunSpec) => WorkflowPlan,
  ): RunSpecRuleFamily {
    return (spec, rules, issues) =>
      checkGraphRules(spec, rules, issues, project);
  }

  test("a lane graph the plan validator rejects is RUN_SPEC_PLAN_REJECTED", () => {
    const issues: RunSpecIssue[] = [];
    checkGraphRules(validSpec(), testRules(), issues, (spec) =>
      rejectedPlan(laneGraphWorkflowPlan(spec)),
    );
    expect(codes(issues)).toEqual(["RUN_SPEC_PLAN_REJECTED"]);
  });

  test("a defect in the projection is thrown, not reported as a plan rejection", () => {
    const issues: RunSpecIssue[] = [];
    expect(() =>
      checkGraphRules(validSpec(), testRules(), issues, brokenProjection),
    ).toThrow("projection defect");
    expect(issues).toEqual([]);
  });

  test("validateRunSpec reports that defect as RUN_SPEC_INTERNAL_ERROR", () => {
    const result = validateRunSpecWith(validSpec(), testRules(), [
      graphFamily(brokenProjection),
    ]);
    expect(result.ok === false && codes(result.errors)).toEqual([
      "RUN_SPEC_INTERNAL_ERROR",
    ]);
  });

  test("the lane graph plan has no owned paths and the full plan has them", () => {
    const spec = validSpec();
    const graphLanes = laneGraphWorkflowPlan(spec).lanes;
    const fullLanes = fullWorkflowPlan(spec).lanes;
    expect(graphLanes.every((lane) => lane.ownedPaths.length === 0)).toBe(true);
    expect(fullLanes.some((lane) => lane.ownedPaths.length > 0)).toBe(true);
  });
});
