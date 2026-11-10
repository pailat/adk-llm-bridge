import { describe, expect, test } from "bun:test";
import {
  type RunSpecIssue,
  runSpecIssue,
} from "../../../src/workflows/spec/issues.js";
import {
  mergeRunRules,
  type RunRules,
  type RunSpec,
} from "../../../src/workflows/spec/schema.js";
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
