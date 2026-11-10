import { describe, expect, test } from "bun:test";
import type { RunSpecIssue } from "../../../../src/workflows/spec/issues.js";
import { checkBudgetRules } from "../../../../src/workflows/spec/rules/budget.js";
import type {
  RunRules,
  RunSpec,
} from "../../../../src/workflows/spec/schema.js";
import { testRules, validSpec, wideSpec } from "../helpers.js";

function run(spec: RunSpec, rules: RunRules = testRules()): RunSpecIssue[] {
  const issues: RunSpecIssue[] = [];
  checkBudgetRules(spec, rules, issues);
  return issues;
}

function codes(issues: RunSpecIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

function only(issues: RunSpecIssue[], code: string): RunSpecIssue[] {
  return issues.filter((issue) => issue.code === code);
}

/** Casts a deliberately malformed value past the type system. */
function bad<T>(value: unknown): T {
  return value as T;
}

describe("checkBudgetRules: valid input", () => {
  test("reports nothing for the valid spec under the test rules", () => {
    expect(run(validSpec())).toEqual([]);
  });

  test("reports nothing for 1,000 plain lanes", () => {
    expect(run(wideSpec(1_000))).toEqual([]);
  });

  test("does not change the spec or the rules", () => {
    const spec = validSpec();
    const rules = testRules();
    const specBefore = structuredClone(spec);
    const rulesBefore = structuredClone(rules);
    run({ ...spec, budget: { maxUsd: 99 } }, rules);
    expect(spec).toEqual(specBefore);
    expect(rules).toEqual(rulesBefore);
  });

  test("appends to the issues already in the list and keeps them", () => {
    const existing: RunSpecIssue[] = [
      { code: "RUN_SPEC_PATH_DENIED", path: ["x"], message: "earlier" },
    ];
    const spec = validSpec();
    spec.budget.maxUsd = 11;
    checkBudgetRules(spec, testRules(), existing);
    expect(codes(existing)).toEqual([
      "RUN_SPEC_PATH_DENIED",
      "RUN_SPEC_BUDGET_EXCEEDED",
    ]);
  });
});

describe("RUN_SPEC_BUDGET_EXCEEDED", () => {
  test("is reported above the host maximum at budget.maxUsd", () => {
    const spec = validSpec();
    spec.budget.maxUsd = 11;
    const issues = run(spec);
    expect(codes(issues)).toEqual(["RUN_SPEC_BUDGET_EXCEEDED"]);
    expect(issues[0]?.path).toEqual(["budget", "maxUsd"]);
  });

  test("accepts a budget equal to the host maximum", () => {
    const spec = validSpec();
    spec.budget.maxUsd = 10;
    expect(run(spec)).toEqual([]);
  });

  test("rejects a budget just above the maximum by a fraction", () => {
    const spec = validSpec();
    spec.budget.maxUsd = 10.000001;
    expect(codes(run(spec))).toEqual(["RUN_SPEC_BUDGET_EXCEEDED"]);
  });

  test("follows a tighter rule set", () => {
    const rules = testRules();
    rules.maxBudgetUsd = 4;
    expect(codes(run(validSpec(), rules))).toEqual([
      "RUN_SPEC_BUDGET_EXCEEDED",
    ]);
  });

  test("rejects the largest number a spec can hold", () => {
    const spec = validSpec();
    spec.budget.maxUsd = Number.MAX_VALUE;
    expect(codes(run(spec))).toEqual(["RUN_SPEC_BUDGET_EXCEEDED"]);
  });

  test("fails closed on Infinity, NaN and a non-number budget", () => {
    for (const value of [
      Number.POSITIVE_INFINITY,
      Number.NaN,
      "1",
      null,
      undefined,
    ]) {
      const spec = validSpec();
      spec.budget = bad({ maxUsd: value });
      expect(codes(run(spec))).toContain("RUN_SPEC_BUDGET_EXCEEDED");
    }
  });

  test("fails closed when the budget is missing", () => {
    const spec = validSpec();
    spec.budget = bad(undefined);
    expect(() => run(spec)).not.toThrow();
    expect(codes(run(spec))).toContain("RUN_SPEC_BUDGET_EXCEEDED");
  });
});

describe("RUN_SPEC_CONCURRENCY_EXCEEDED", () => {
  test("is reported above the host maximum at maxConcurrency", () => {
    const spec = validSpec();
    spec.maxConcurrency = 5;
    const issues = run(spec);
    expect(codes(issues)).toEqual(["RUN_SPEC_CONCURRENCY_EXCEEDED"]);
    expect(issues[0]?.path).toEqual(["maxConcurrency"]);
  });

  test("accepts a concurrency equal to the host maximum", () => {
    const spec = validSpec();
    spec.maxConcurrency = 4;
    expect(run(spec)).toEqual([]);
  });

  test("follows a tighter rule set", () => {
    const rules = testRules();
    rules.maxConcurrency = 1;
    expect(codes(run(validSpec(), rules))).toEqual([
      "RUN_SPEC_CONCURRENCY_EXCEEDED",
    ]);
  });

  test("rejects the hard limit and beyond", () => {
    for (const value of [256, 1_000_000, Number.MAX_SAFE_INTEGER]) {
      const spec = validSpec();
      spec.maxConcurrency = value;
      expect(codes(run(spec))).toEqual(["RUN_SPEC_CONCURRENCY_EXCEEDED"]);
    }
  });

  test("fails closed on Infinity, NaN and a non-number", () => {
    for (const value of [
      Number.POSITIVE_INFINITY,
      Number.NaN,
      "2",
      undefined,
    ]) {
      const spec = validSpec();
      spec.maxConcurrency = bad(value);
      expect(codes(run(spec))).toContain("RUN_SPEC_CONCURRENCY_EXCEEDED");
    }
  });
});

describe("RUN_SPEC_LANE_LIMIT_EXCEEDED", () => {
  test("is reported once at lanes when there are more lanes than allowed", () => {
    const rules = testRules();
    rules.maxLanes = 1;
    const issues = run(validSpec(), rules);
    expect(codes(issues)).toEqual(["RUN_SPEC_LANE_LIMIT_EXCEEDED"]);
    expect(issues[0]?.path).toEqual(["lanes"]);
  });

  test("accepts a lane count equal to the limit", () => {
    const rules = testRules();
    rules.maxLanes = 2;
    expect(run(validSpec(), rules)).toEqual([]);
  });

  test("fails closed when the host lane limit is not a number", () => {
    for (const value of [Number.NaN, undefined]) {
      const rules = testRules();
      (rules as { maxLanes: unknown }).maxLanes = value;
      expect(codes(run(validSpec(), rules))).toContain(
        "RUN_SPEC_LANE_LIMIT_EXCEEDED",
      );
    }
  });

  test("reports one issue, not one per extra lane, for 1,000 lanes", () => {
    const rules = testRules();
    rules.maxLanes = 10;
    const issues = run(wideSpec(1_000), rules);
    expect(only(issues, "RUN_SPEC_LANE_LIMIT_EXCEEDED")).toHaveLength(1);
  });
});

describe("RUN_SPEC_STRING_LIMIT_EXCEEDED", () => {
  test("is reported at the path of a string that is too long", () => {
    const rules = testRules();
    rules.maxStringLength = 8;
    const spec = validSpec();
    spec.lanes[0]!.title = "123456789";
    spec.lanes[1]!.title = "12345678";
    const issues = only(run(spec, rules), "RUN_SPEC_STRING_LIMIT_EXCEEDED");
    const paths = issues.map((issue) => JSON.stringify(issue.path));
    expect(paths).toContain(JSON.stringify(["lanes", 0, "title"]));
    expect(paths).not.toContain(JSON.stringify(["lanes", 1, "title"]));
  });

  test("accepts a string whose length equals the limit", () => {
    const spec = validSpec();
    const rules = testRules();
    rules.maxStringLength = 4_096;
    spec.lanes[0]!.title = "a".repeat(4_096);
    expect(run(spec, rules)).toEqual([]);
  });

  test("rejects a string one unit over the limit", () => {
    const spec = validSpec();
    spec.lanes[0]!.title = "a".repeat(4_097);
    expect(codes(only(run(spec), "RUN_SPEC_STRING_LIMIT_EXCEEDED"))).toEqual([
      "RUN_SPEC_STRING_LIMIT_EXCEEDED",
    ]);
  });

  test("counts UTF-16 code units, so astral characters count twice", () => {
    const rules = testRules();
    rules.maxStringLength = 7;
    const spec = validSpec();
    spec.lanes[0]!.title = "\u{1F600}".repeat(4);
    expect(
      only(run(spec, rules), "RUN_SPEC_STRING_LIMIT_EXCEEDED").map((i) =>
        JSON.stringify(i.path),
      ),
    ).toContain(JSON.stringify(["lanes", 0, "title"]));
    rules.maxStringLength = 8;
    const again = only(run(spec, rules), "RUN_SPEC_STRING_LIMIT_EXCEEDED").map(
      (i) => JSON.stringify(i.path),
    );
    expect(again).not.toContain(JSON.stringify(["lanes", 0, "title"]));
  });

  test("checks strings in every part of the spec", () => {
    const rules = testRules();
    rules.maxStringLength = 1;
    const spec = validSpec();
    spec.workflowVersion = "v1";
    const issues = only(run(spec, rules), "RUN_SPEC_STRING_LIMIT_EXCEEDED");
    const paths = new Set(issues.map((issue) => JSON.stringify(issue.path)));
    for (const expected of [
      ["workflowId"],
      ["workflowVersion"],
      ["lanes", 0, "taskId"],
      ["lanes", 0, "allowedPaths", 0],
      ["lanes", 0, "agent", "providerId"],
      ["lanes", 0, "agent", "model"],
      ["lanes", 0, "agent", "tools", 0],
      ["lanes", 0, "steps", "review", "providerId"],
      ["lanes", 0, "steps", "review", "model"],
      ["lanes", 1, "dependsOn", 0],
      ["gates", "qa", 0, "id"],
      ["gates", "qa", 0, "command", 0],
    ]) {
      expect(paths.has(JSON.stringify(expected))).toBe(true);
    }
  });

  test("checks the entries of env", () => {
    const rules = testRules();
    rules.maxStringLength = 1;
    const issues = only(
      run(validSpec(), rules),
      "RUN_SPEC_STRING_LIMIT_EXCEEDED",
    );
    expect(issues.map((issue) => JSON.stringify(issue.path))).toContain(
      JSON.stringify(["env", 0]),
    );
  });

  test("exempts strings inside extensions", () => {
    const spec = validSpec();
    spec.extensions = { "x-a": "e".repeat(4_000) };
    spec.lanes[0]!.extensions = { "x-b": { note: "f".repeat(4_000) } };
    const rules = testRules();
    rules.maxStringLength = 100;
    const issues = run(spec, rules);
    const extensionIssues = issues.filter(
      (issue) =>
        issue.path[0] === "extensions" ||
        (issue.path[0] === "lanes" && issue.path[2] === "extensions"),
    );
    expect(extensionIssues).toEqual([]);
  });

  test("does not echo a huge string in the message", () => {
    const spec = validSpec();
    const huge = "Z".repeat(65_000);
    spec.lanes[0]!.title = huge;
    const issues = only(run(spec), "RUN_SPEC_STRING_LIMIT_EXCEEDED");
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.message.length).toBeLessThanOrEqual(512);
      expect(issue.message).not.toContain("ZZZZZZZZ");
    }
  });
});

describe("RUN_SPEC_ARRAY_LIMIT_EXCEEDED", () => {
  test("is reported at the path of a long allowedPaths", () => {
    const rules = testRules();
    rules.maxArrayLength = 1;
    const issues = only(
      run(validSpec(), rules),
      "RUN_SPEC_ARRAY_LIMIT_EXCEEDED",
    );
    expect(issues.map((issue) => JSON.stringify(issue.path))).toContain(
      JSON.stringify(["lanes", 0, "allowedPaths"]),
    );
  });

  test("accepts an array whose length equals the limit", () => {
    const rules = testRules();
    rules.maxArrayLength = 3;
    expect(run(validSpec(), rules)).toEqual([]);
  });

  test("checks tools, dependsOn, env, qa and a qa command", () => {
    const spec = validSpec();
    spec.lanes[0]!.agent.tools = ["Read", "Edit", "Bash"];
    spec.lanes[1]!.dependsOn = ["api"];
    spec.env = ["CI", "NODE_ENV"];
    spec.gates.qa = [
      { id: "a", command: ["bun", "run", "test"] },
      { id: "b", command: ["bun", "run", "lint"] },
    ];
    const rules = testRules();
    rules.maxArrayLength = 1;
    const paths = new Set(
      only(run(spec, rules), "RUN_SPEC_ARRAY_LIMIT_EXCEEDED").map((issue) =>
        JSON.stringify(issue.path),
      ),
    );
    for (const expected of [
      ["lanes", 0, "agent", "tools"],
      ["env"],
      ["gates", "qa"],
      ["gates", "qa", 0, "command"],
    ]) {
      expect(paths.has(JSON.stringify(expected))).toBe(true);
    }
  });

  test("checks dependsOn", () => {
    const spec = wideSpec(30);
    spec.lanes[29]!.dependsOn = ["lane-0", "lane-1"];
    const rules = testRules();
    rules.maxArrayLength = 1;
    const paths = only(run(spec, rules), "RUN_SPEC_ARRAY_LIMIT_EXCEEDED").map(
      (issue) => JSON.stringify(issue.path),
    );
    expect(paths).toContain(JSON.stringify(["lanes", 29, "dependsOn"]));
  });

  test("exempts lanes themselves", () => {
    const spec = wideSpec(100);
    spec.env = ["CI"];
    spec.gates.qa = [{ id: "t", command: ["a", "b", "c"] }];
    const rules = testRules();
    rules.maxArrayLength = 3;
    const issues = run(spec, rules);
    expect(only(issues, "RUN_SPEC_ARRAY_LIMIT_EXCEEDED")).toEqual([]);
  });

  test("does not count the items of an array inside extensions", () => {
    const spec = validSpec();
    spec.extensions = { "x-a": Array.from({ length: 50 }, () => 1) };
    const rules = testRules();
    rules.maxArrayLength = 3;
    expect(only(run(spec, rules), "RUN_SPEC_ARRAY_LIMIT_EXCEEDED")).toEqual([]);
  });
});

describe("RUN_SPEC_CHANGE_ROUNDS_EXCEEDED", () => {
  test("is reported at the path of the review's maxChangeRounds", () => {
    const rules = testRules();
    rules.maxChangeRounds = 1;
    const issues = run(validSpec(), rules);
    expect(codes(issues)).toEqual(["RUN_SPEC_CHANGE_ROUNDS_EXCEEDED"]);
    expect(issues[0]?.path).toEqual([
      "lanes",
      0,
      "steps",
      "review",
      "maxChangeRounds",
    ]);
  });

  test("accepts rounds equal to the limit", () => {
    const rules = testRules();
    rules.maxChangeRounds = 2;
    expect(run(validSpec(), rules)).toEqual([]);
  });

  test("reports each lane that is above the limit", () => {
    const spec = wideSpec(3);
    for (const lane of spec.lanes) {
      lane.steps.review = {
        kind: "agent",
        providerId: "codex",
        model: "gpt-5.5",
        maxChangeRounds: 3,
      };
    }
    const rules = testRules();
    rules.maxChangeRounds = 2;
    expect(
      only(run(spec, rules), "RUN_SPEC_CHANGE_ROUNDS_EXCEEDED"),
    ).toHaveLength(3);
  });

  test("does not report a lane with no review", () => {
    const rules = testRules();
    rules.maxChangeRounds = 0;
    const issues = only(
      run(validSpec(), rules),
      "RUN_SPEC_CHANGE_ROUNDS_EXCEEDED",
    );
    expect(issues.map((issue) => issue.path[1])).toEqual([0]);
  });
});

describe("RUN_SPEC_AGENT_RUN_LIMIT_EXCEEDED", () => {
  test("is reported at lanes when the worst case is above the limit", () => {
    const rules = testRules();
    rules.maxAgentRuns = 7;
    const issues = run(validSpec(), rules);
    expect(codes(issues)).toEqual(["RUN_SPEC_AGENT_RUN_LIMIT_EXCEEDED"]);
    expect(issues[0]?.path).toEqual(["lanes"]);
  });

  test("accepts a worst case equal to the limit of 8", () => {
    const rules = testRules();
    rules.maxAgentRuns = 8;
    expect(run(validSpec(), rules)).toEqual([]);
  });

  test("sums the lanes: 1,000 lanes of one run each need 1,000", () => {
    const rules = testRules();
    rules.maxAgentRuns = 999;
    expect(codes(run(wideSpec(1_000), rules))).toEqual([
      "RUN_SPEC_AGENT_RUN_LIMIT_EXCEEDED",
    ]);
    rules.maxAgentRuns = 1_000;
    expect(run(wideSpec(1_000), rules)).toEqual([]);
  });

  test("counts tests first as one extra run per lane", () => {
    const spec = wideSpec(5);
    for (const lane of spec.lanes) lane.steps.testsFirst = true;
    const rules = testRules();
    rules.maxAgentRuns = 9;
    expect(codes(run(spec, rules))).toEqual([
      "RUN_SPEC_AGENT_RUN_LIMIT_EXCEEDED",
    ]);
    rules.maxAgentRuns = 10;
    expect(run(spec, rules)).toEqual([]);
  });

  test("counts a review as one run plus two per change round", () => {
    const spec = wideSpec(1);
    spec.lanes[0]!.steps.review = {
      kind: "agent",
      providerId: "codex",
      model: "gpt-5.5",
      maxChangeRounds: 10,
    };
    const rules = testRules();
    rules.maxChangeRounds = 10;
    rules.maxAgentRuns = 21;
    expect(codes(run(spec, rules))).toEqual([
      "RUN_SPEC_AGENT_RUN_LIMIT_EXCEEDED",
    ]);
    rules.maxAgentRuns = 22;
    expect(run(spec, rules)).toEqual([]);
  });

  test("is still reported when the lane count is also above its limit", () => {
    const rules = testRules();
    rules.maxLanes = 1;
    rules.maxAgentRuns = 7;
    expect(codes(run(validSpec(), rules)).sort()).toEqual([
      "RUN_SPEC_AGENT_RUN_LIMIT_EXCEEDED",
      "RUN_SPEC_LANE_LIMIT_EXCEEDED",
    ]);
  });
});

describe("RUN_SPEC_EXTENSION_TOO_LARGE", () => {
  function withExtension(value: unknown): RunSpec {
    const spec = validSpec();
    spec.extensions = { "x-a": value };
    return spec;
  }

  test("accepts a small extension at every level", () => {
    const spec = validSpec();
    spec.extensions = { "x-a": { n: 1, list: [1, "two", null, true] } };
    spec.lanes[0]!.extensions = { "x-b": "text" };
    expect(run(spec)).toEqual([]);
  });

  test("is reported at extensions when the object has 17 keys", () => {
    const spec = validSpec();
    const extensions: Record<string, unknown> = {};
    for (let index = 0; index < 17; index++) extensions[`x-k${index}`] = 1;
    spec.extensions = extensions;
    const issues = only(run(spec), "RUN_SPEC_EXTENSION_TOO_LARGE");
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.path[0]).toBe("extensions");
  });

  test("accepts exactly 16 keys", () => {
    const spec = validSpec();
    const extensions: Record<string, unknown> = {};
    for (let index = 0; index < 16; index++) extensions[`x-k${index}`] = 1;
    spec.extensions = extensions;
    expect(run(spec)).toEqual([]);
  });

  test("applies the key limit to a lane's extensions", () => {
    const spec = validSpec();
    const extensions: Record<string, unknown> = {};
    for (let index = 0; index < 17; index++) extensions[`x-k${index}`] = 1;
    spec.lanes[1]!.extensions = extensions;
    const issues = only(run(spec), "RUN_SPEC_EXTENSION_TOO_LARGE");
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.path.slice(0, 3)).toEqual(["lanes", 1, "extensions"]);
  });

  test("is reported at the key for a value nested nine levels", () => {
    let value: unknown = 1;
    for (let level = 0; level < 9; level++) value = { next: value };
    const issues = only(
      run(withExtension(value)),
      "RUN_SPEC_EXTENSION_TOO_LARGE",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["extensions", "x-a"]);
  });

  test("accepts a value wrapped in eight objects", () => {
    let value: unknown = 1;
    for (let level = 0; level < 8; level++) value = { next: value };
    expect(run(withExtension(value))).toEqual([]);
  });

  test("accepts an array of exactly 256 values in total", () => {
    const edge = Array.from({ length: 255 }, () => 1);
    expect(run(withExtension(edge))).toEqual([]);
  });

  test("is reported for 257 values and accepted for fewer", () => {
    const big = Array.from({ length: 257 }, () => 1);
    expect(codes(run(withExtension(big)))).toEqual([
      "RUN_SPEC_EXTENSION_TOO_LARGE",
    ]);
    const small = Array.from({ length: 200 }, () => 1);
    expect(run(withExtension(small))).toEqual([]);
  });

  test("is reported for a string longer than 4,096 units", () => {
    expect(codes(run(withExtension("s".repeat(4_097))))).toEqual([
      "RUN_SPEC_EXTENSION_TOO_LARGE",
    ]);
    expect(run(withExtension("s".repeat(4_096)))).toEqual([]);
  });

  test("is reported for values that are not plain JSON", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const sparse: unknown[] = [];
    sparse[3] = 1;
    class Custom {
      value = 1;
    }
    for (const value of [
      new Date(),
      new Map(),
      new Custom(),
      () => 1,
      Symbol("s"),
      10n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      circular,
      sparse,
      { [Symbol("k")]: 1 },
      Object.create(null, { hidden: { value: 1, enumerable: true } }),
    ]) {
      const issues = only(
        run(withExtension(value)),
        "RUN_SPEC_EXTENSION_TOO_LARGE",
      );
      expect(issues.length).toBeGreaterThan(0);
    }
  });

  test("does not throw on a hostile extension and stays fast", () => {
    let deep: unknown = 1;
    for (let level = 0; level < 100_000; level++) deep = [deep];
    const huge = Array.from({ length: 1_000_000 }, () => 0);
    const started = performance.now();
    expect(() => run(withExtension(deep))).not.toThrow();
    expect(codes(run(withExtension(huge)))).toContain(
      "RUN_SPEC_EXTENSION_TOO_LARGE",
    );
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("does not run an accessor on an extension", () => {
    let called = false;
    const value = {
      get danger() {
        called = true;
        return 1;
      },
    };
    run(withExtension(value));
    expect(called).toBe(false);
  });
});

describe("RUN_SPEC_PLAN_TOO_LARGE", () => {
  test("is reported once for 1,000 lanes with 64 paths each", () => {
    const spec = wideSpec(1_000);
    spec.lanes.forEach((lane, index) => {
      lane.allowedPaths = Array.from(
        { length: 64 },
        (_, path) => `src/lane-${index}/part-${path}`,
      );
    });
    const rules = testRules();
    rules.maxArrayLength = 64;
    const issues = only(run(spec, rules), "RUN_SPEC_PLAN_TOO_LARGE");
    expect(issues).toHaveLength(1);
  });

  test("is not reported for 1,000 lanes with one path each", () => {
    expect(only(run(wideSpec(1_000)), "RUN_SPEC_PLAN_TOO_LARGE")).toEqual([]);
  });

  test("is not reported for the valid spec", () => {
    expect(only(run(validSpec()), "RUN_SPEC_PLAN_TOO_LARGE")).toEqual([]);
  });

  test("does not throw when the graph or the paths are broken", () => {
    const spec = validSpec();
    spec.lanes[0]!.dependsOn = ["docs"];
    spec.lanes[1]!.dependsOn = ["api", "api", "missing", "docs"];
    spec.lanes[1]!.allowedPaths = ["../x", "/etc", "src//y"];
    expect(() => run(spec)).not.toThrow();
  });

  test("does not throw on duplicate lane ids", () => {
    const spec = validSpec();
    spec.lanes[1]!.taskId = "api";
    expect(() => run(spec)).not.toThrow();
  });
});

describe("combined and hostile input", () => {
  test("reports every violated rule in one call", () => {
    const spec = validSpec();
    spec.budget.maxUsd = 11;
    spec.maxConcurrency = 5;
    const rules = testRules();
    rules.maxLanes = 1;
    rules.maxChangeRounds = 1;
    rules.maxAgentRuns = 7;
    expect(codes(run(spec, rules)).sort()).toEqual(
      [
        "RUN_SPEC_AGENT_RUN_LIMIT_EXCEEDED",
        "RUN_SPEC_BUDGET_EXCEEDED",
        "RUN_SPEC_CHANGE_ROUNDS_EXCEEDED",
        "RUN_SPEC_CONCURRENCY_EXCEEDED",
        "RUN_SPEC_LANE_LIMIT_EXCEEDED",
      ].sort(),
    );
  });

  test("reports only codes of the budget family", () => {
    const spec = validSpec();
    spec.budget.maxUsd = 1_000;
    spec.maxConcurrency = 256;
    spec.lanes[0]!.title = "t".repeat(5_000);
    spec.extensions = { "x-a": new Date() };
    const rules = testRules();
    rules.maxArrayLength = 1;
    rules.maxAgentRuns = 1;
    const issues = run(spec, rules);
    expect(issues.length).toBeGreaterThan(4);
    for (const issue of issues) {
      expect([
        "RUN_SPEC_BUDGET_EXCEEDED",
        "RUN_SPEC_CONCURRENCY_EXCEEDED",
        "RUN_SPEC_LANE_LIMIT_EXCEEDED",
        "RUN_SPEC_STRING_LIMIT_EXCEEDED",
        "RUN_SPEC_ARRAY_LIMIT_EXCEEDED",
        "RUN_SPEC_CHANGE_ROUNDS_EXCEEDED",
        "RUN_SPEC_AGENT_RUN_LIMIT_EXCEEDED",
        "RUN_SPEC_EXTENSION_TOO_LARGE",
        "RUN_SPEC_PLAN_TOO_LARGE",
      ]).toContain(issue.code);
    }
  });

  test("keeps every message within 512 units and free of secrets", () => {
    const spec = validSpec();
    spec.env = ["SECRET_TOKEN_VALUE_" + "Q".repeat(5_000)];
    spec.lanes[0]!.agent.tools = ["T".repeat(5_000)];
    const issues = run(spec);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.message.length).toBeLessThanOrEqual(512);
      expect(issue.message).not.toContain("SECRET_TOKEN_VALUE");
    }
  });

  test("handles the largest accepted shapes within a time budget", () => {
    const spec = wideSpec(1_000);
    spec.lanes.forEach((lane) => {
      lane.title = "t".repeat(256);
      lane.dependsOn = lane.dependsOn.slice(0, 1);
    });
    const rules = testRules();
    rules.maxLanes = 1;
    rules.maxStringLength = 1;
    rules.maxArrayLength = 1;
    const started = performance.now();
    const issues = run(spec, rules);
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(only(issues, "RUN_SPEC_LANE_LIMIT_EXCEEDED")).toHaveLength(1);
  });
});

describe("hard limits above a malformed host rule set", () => {
  test("caps the budget at the library limit", () => {
    const rules = testRules();
    rules.maxBudgetUsd = 5_000_000;
    const spec = validSpec();
    spec.budget.maxUsd = 2_000_000;
    expect(codes(run(spec, rules))).toContain("RUN_SPEC_BUDGET_EXCEEDED");
  });

  test("caps concurrency at the library limit", () => {
    const rules = testRules();
    rules.maxConcurrency = 1_000;
    const spec = validSpec();
    spec.maxConcurrency = 300;
    expect(codes(run(spec, rules))).toContain("RUN_SPEC_CONCURRENCY_EXCEEDED");
  });

  test("caps the lane count at the library limit", () => {
    const rules = testRules();
    rules.maxLanes = 5_000;
    expect(codes(run(wideSpec(1_001), rules))).toContain(
      "RUN_SPEC_LANE_LIMIT_EXCEEDED",
    );
  });

  test("caps change rounds at the library limit", () => {
    const rules = testRules();
    rules.maxChangeRounds = 100;
    const spec = validSpec();
    spec.lanes[0]!.steps.review = {
      kind: "agent",
      providerId: "codex",
      model: "gpt-5.5",
      maxChangeRounds: 11,
    };
    expect(codes(run(spec, rules))).toContain(
      "RUN_SPEC_CHANGE_ROUNDS_EXCEEDED",
    );
  });
});

describe("malformed spec parts", () => {
  test("a lane with broken steps counts as over the agent run limit", () => {
    const spec = validSpec();
    spec.lanes[0]!.steps = bad(undefined);
    expect(codes(run(spec))).toContain("RUN_SPEC_AGENT_RUN_LIMIT_EXCEEDED");
  });

  test("extensions that are not an object are reported", () => {
    const spec = validSpec();
    spec.extensions = bad("text");
    const issues = only(run(spec), "RUN_SPEC_EXTENSION_TOO_LARGE");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["extensions"]);
  });
});
