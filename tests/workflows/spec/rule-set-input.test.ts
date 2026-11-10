import { describe, expect, test } from "bun:test";
import {
  type RunSpecIssue,
  runSpecIssue,
} from "../../../src/workflows/spec/issues.js";
import { resolveRunPlan } from "../../../src/workflows/spec/plan.js";
import {
  DEFAULT_DENIED_PATH_PATTERNS,
  mergeRunRules,
  type RunRules,
  type RunSpec,
} from "../../../src/workflows/spec/schema.js";
import type { RunPlan } from "../../../src/workflows/spec/types.js";
import {
  type RunSpecRuleFamily,
  validateRunSpec,
  validateRunSpecWith,
} from "../../../src/workflows/spec/validate.js";
import { testRules, validSpec } from "./helpers.js";

/** Rules that allow merges into `refs/heads/main` only. */
function refRules(): RunRules {
  return {
    ...testRules(),
    allowedPublishKinds: ["none", "commit", "integration"],
    allowedTargetRefs: ["refs/heads/main"],
  };
}

/** A valid spec that merges into `targetRef`. */
function mergeInto(targetRef: string): RunSpec {
  const spec = validSpec();
  spec.gates.publish = { kind: "integration", hitl: true, targetRef };
  return spec;
}

function codesOf(spec: unknown, rules: RunRules): string[] {
  const result = validateRunSpec(spec, rules);
  return result.ok ? [] : result.errors.map((issue) => issue.code);
}

/** Replaces `key` with a getter that returns `answers[n]` on read `n`. */
function answering<Key extends keyof RunRules>(
  rules: RunRules,
  key: Key,
  answers: RunRules[Key][],
): { reads: number } {
  const counter = { reads: 0 };
  Object.defineProperty(rules, key, {
    enumerable: true,
    configurable: true,
    get() {
      const answer = answers[Math.min(counter.reads, answers.length - 1)];
      counter.reads += 1;
      return answer;
    },
  });
  return counter;
}

describe("validateRunSpec reads the rule set once", () => {
  test("an allowedTargetRefs getter that widens after the first read cannot allow a merge", () => {
    const rules = refRules();
    const counter = answering(rules, "allowedTargetRefs", [
      [],
      ["refs/heads/prod"],
    ]);
    expect(codesOf(mergeInto("refs/heads/prod"), rules)).toEqual([
      "RUN_SPEC_TARGET_REF_NOT_ALLOWED",
    ]);
    expect(counter.reads).toBe(1);
  });

  test("an allowedWorkflows getter that widens after the first read cannot allow a workflow", () => {
    const rules = testRules();
    const counter = answering(rules, "allowedWorkflows", [
      [],
      [{ workflowId: "lanes", workflowVersion: "1" }],
    ]);
    expect(validateRunSpec(validSpec(), rules).ok).toBe(false);
    expect(counter.reads).toBe(1);
  });

  test("a getter that would throw on a later read is never read again", () => {
    const rules = testRules();
    const patterns = [...rules.deniedPathPatterns];
    let reads = 0;
    Object.defineProperty(rules, "deniedPathPatterns", {
      enumerable: true,
      get() {
        reads += 1;
        if (reads > 1) throw new Error("host getter failed");
        return patterns;
      },
    });
    expect(validateRunSpec(validSpec(), rules).ok).toBe(true);
    expect(reads).toBe(1);
  });

  test("a getter that throws is a host error, RUN_SPEC_RULES_INVALID", () => {
    const rules = testRules();
    Object.defineProperty(rules, "deniedPathPatterns", {
      enumerable: true,
      get() {
        throw new Error("host getter failed");
      },
    });
    expect(codesOf(validSpec(), rules)).toEqual(["RUN_SPEC_RULES_INVALID"]);
  });

  test("keys inherited from a prototype are not rules", () => {
    const own: Partial<RunRules> = refRules();
    delete own.allowedTargetRefs;
    delete own.allowedWorkflows;
    const rules = Object.assign(
      Object.create({
        allowedTargetRefs: ["refs/heads/prod"],
        allowedWorkflows: [{ workflowId: "lanes", workflowVersion: "1" }],
      }),
      own,
    ) as RunRules;
    expect(codesOf(mergeInto("refs/heads/prod"), rules)).toEqual([
      "RUN_SPEC_RULES_INVALID",
    ]);
  });

  test("an entry of allowedWorkflows that inherits its keys is invalid", () => {
    const rules = testRules();
    rules.allowedWorkflows = [
      Object.create({ workflowId: "lanes", workflowVersion: "1" }),
    ];
    expect(codesOf(validSpec(), rules)).toEqual(["RUN_SPEC_RULES_INVALID"]);
  });

  test("a rule set that is a class instance or holds a cycle is invalid", () => {
    class Rules {}
    const instance = Object.assign(new Rules(), testRules()) as RunRules;
    const cyclic = testRules() as RunRules & { self?: unknown };
    cyclic.self = cyclic;
    for (const rules of [instance, cyclic]) {
      expect(codesOf(validSpec(), rules)).toEqual(["RUN_SPEC_RULES_INVALID"]);
    }
  });

  test("the rule families receive a copy, not the host's object", () => {
    const rules = testRules();
    let seen: RunRules | undefined;
    const spy: RunSpecRuleFamily = (_spec, received) => {
      seen = received;
    };
    expect(validateRunSpecWith(validSpec(), rules, [spy]).ok).toBe(true);
    expect(seen).toBeDefined();
    expect(seen).not.toBe(rules);
    expect(seen?.allowedTargetRefs).not.toBe(rules.allowedTargetRefs);
    expect(seen).toEqual(rules);
  });
});

describe("a failing rule family", () => {
  const boom: RunSpecRuleFamily = () => {
    throw new Error("boom");
  };

  test("is RUN_SPEC_INTERNAL_ERROR, never a success and never a throw", () => {
    let result: ReturnType<typeof validateRunSpecWith> | undefined;
    expect(() => {
      result = validateRunSpecWith(validSpec(), testRules(), [boom]);
    }).not.toThrow();
    expect(result?.ok).toBe(false);
    if (result?.ok === false) {
      expect(result.errors.map((issue) => issue.code)).toEqual([
        "RUN_SPEC_INTERNAL_ERROR",
      ]);
      expect(result.errors[0]?.message).toContain("rule family failed");
    }
  });

  test("stops the families after it and keeps the issues before it", () => {
    let laterRan = false;
    const first: RunSpecRuleFamily = (
      _spec,
      _rules,
      issues: RunSpecIssue[],
    ) => {
      issues.push(runSpecIssue("RUN_SPEC_PATH_DENIED", [], "first family"));
    };
    const later: RunSpecRuleFamily = () => {
      laterRan = true;
    };
    const result = validateRunSpecWith(validSpec(), testRules(), [
      first,
      boom,
      later,
    ]);
    expect(laterRan).toBe(false);
    expect(result.ok === false && result.errors.map((i) => i.code)).toEqual([
      "RUN_SPEC_PATH_DENIED",
      "RUN_SPEC_INTERNAL_ERROR",
    ]);
  });
});

describe("mergeRunRules reads its inputs once", () => {
  test("a base getter that widens after the first read cannot widen the result", () => {
    const base = refRules();
    const counter = answering(base, "allowedTargetRefs", [
      [],
      ["refs/heads/prod"],
    ]);
    expect(mergeRunRules(base).allowedTargetRefs).toEqual([]);
    expect(counter.reads).toBe(1);
  });

  test("a base that only inherits a rule key is rejected", () => {
    const own: Partial<RunRules> = refRules();
    delete own.allowedTargetRefs;
    const base = Object.assign(
      Object.create({ allowedTargetRefs: ["refs/heads/prod"] }),
      own,
    ) as RunRules;
    expect(() => mergeRunRules(base)).toThrow(TypeError);
  });

  test("an override that is not plain data is rejected", () => {
    // Valid when inherited keys count; a plain copy has only the id.
    const override = Object.assign(
      Object.create({ allowedTargetRefs: ["refs/heads/main"] }),
      { id: "override" },
    );
    expect(() => mergeRunRules(refRules(), override)).toThrow(TypeError);
  });
});

/** The keys `resolveRunPlan` copies into the plan's limits. */
const PLAN_RULE_KEYS = [
  "id",
  "maxBudgetUsd",
  "maxConcurrency",
  "maxLanes",
  "maxAgentRuns",
  "maxChangeRounds",
] as const;

/** The plan of `spec` under `rules`, or a failure naming the issues. */
function planOf(spec: unknown, rules: RunRules): RunPlan {
  const result = resolveRunPlan(spec, rules);
  if (!result.ok) {
    throw new Error(`expected a plan, got ${JSON.stringify(result.errors)}`);
  }
  return result.plan;
}

/** A spec whose concurrency cap and widest wave are both 4. */
function fourWideSpec(): RunSpec {
  const spec = validSpec();
  const [first] = spec.lanes;
  if (first === undefined) throw new Error("validSpec has no lanes");
  spec.lanes = ["a", "b", "c", "d"].map((taskId) => ({
    ...first,
    taskId,
    title: taskId,
    dependsOn: [],
    allowedPaths: [`src/${taskId}`],
  }));
  spec.maxConcurrency = 4;
  return spec;
}

describe("resolveRunPlan reads the rule set once", () => {
  test("getters that answer differently on the second read do not change the plan", () => {
    const spec = fourWideSpec();
    const expected = planOf(spec, testRules());
    const rules = testRules();
    const counters = [
      answering(rules, "id", ["test", "widened"]),
      answering(rules, "maxBudgetUsd", [10, 1_000_000]),
      answering(rules, "maxConcurrency", [4, 1]),
      answering(rules, "maxLanes", [1_000, 1]),
      answering(rules, "maxAgentRuns", [10_000, 1]),
      answering(rules, "maxChangeRounds", [3, 0]),
    ];
    const resolved = planOf(spec, rules);
    expect(resolved).toEqual(expected);
    expect(resolved.limits.budgetUsd.ceiling).toBe(10);
    expect(resolved.limits.budgetUsd.ruleSets).toEqual(["test"]);
    expect(resolved.costBound.peakConcurrency).toBe(4);
    expect(counters.map((counter) => counter.reads)).toEqual(
      PLAN_RULE_KEYS.map(() => 1),
    );
  });

  test("an origins getter that answers differently on the second read does not change the plan's rule sets", () => {
    const merged = mergeRunRules(testRules(), {
      id: "org",
      maxBudgetUsd: 8,
    });
    const origins = merged.origins;
    if (origins === undefined) throw new Error("expected origins");
    const counter = answering(merged, "origins", [
      origins,
      { ...origins, maxBudgetUsd: ["someone-else"] },
    ]);
    const resolved = planOf(validSpec(), merged);
    expect(resolved.limits.budgetUsd.ruleSets).toEqual(["org"]);
    expect(counter.reads).toBe(1);
  });

  test("getters that throw on the second read give a result, never a throw", () => {
    const spec = fourWideSpec();
    const expected = planOf(spec, testRules());
    const rules: RunRules = testRules();
    const host = rules as unknown as Record<string, unknown>;
    let reads = 0;
    for (const key of PLAN_RULE_KEYS) {
      const value = host[key];
      let keyReads = 0;
      Object.defineProperty(rules, key, {
        enumerable: true,
        get() {
          keyReads += 1;
          reads += 1;
          if (keyReads > 1) throw new Error("host getter failed");
          return value;
        },
      });
    }
    let result: ReturnType<typeof resolveRunPlan> | undefined;
    expect(() => {
      result = resolveRunPlan(spec, rules);
    }).not.toThrow();
    expect(result).toEqual({ ok: true, plan: expected });
    expect(reads).toBe(PLAN_RULE_KEYS.length);
  });
});

describe("a rule set whose getter throws on its second read", () => {
  // The rule set is read once, so a later throw never happens: the spec is
  // checked against the first answers. It is neither a host error nor an
  // internal error.
  function throwingOnSecondRead(answer: string[]): {
    rules: RunRules;
    counter: { reads: number };
  } {
    const rules = testRules();
    const counter = { reads: 0 };
    Object.defineProperty(rules, "deniedPathPatterns", {
      enumerable: true,
      get() {
        counter.reads += 1;
        if (counter.reads > 1) throw new Error("host getter failed");
        return answer;
      },
    });
    return { rules, counter };
  }

  test.each([
    ["an empty list", [] as string[]],
    ["the default patterns", [...DEFAULT_DENIED_PATH_PATTERNS]],
  ])(
    "answering %s first is validated with that answer by validateRunSpec",
    (_name, answer) => {
      const { rules, counter } = throwingOnSecondRead(answer);
      expect(codesOf(validSpec(), rules)).toEqual([]);
      expect(counter.reads).toBe(1);
    },
  );

  test.each([
    ["an empty list", [] as string[]],
    ["the default patterns", [...DEFAULT_DENIED_PATH_PATTERNS]],
  ])("answering %s first gives a plan from resolveRunPlan", (_name, answer) => {
    const { rules, counter } = throwingOnSecondRead(answer);
    const result = resolveRunPlan(validSpec(), rules);
    expect(result.ok).toBe(true);
    expect(counter.reads).toBe(1);
  });

  test("still denies what the first answer denies", () => {
    const spec = validSpec();
    const [first] = spec.lanes;
    if (first === undefined) throw new Error("validSpec has no lanes");
    first.allowedPaths = ["secrets/keys"];
    const forValidate = throwingOnSecondRead(["secrets"]);
    expect(codesOf(spec, forValidate.rules)).toContain("RUN_SPEC_PATH_DENIED");
    const forPlan = throwingOnSecondRead(["secrets"]);
    const result = resolveRunPlan(spec, forPlan.rules);
    expect(result.ok === false && result.errors.map((i) => i.code)).toContain(
      "RUN_SPEC_PATH_DENIED",
    );
    expect([forValidate.counter.reads, forPlan.counter.reads]).toEqual([1, 1]);
  });
});
