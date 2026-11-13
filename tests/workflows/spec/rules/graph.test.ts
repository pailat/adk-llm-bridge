import { describe, expect, test } from "bun:test";
import {
  RUN_SPEC_ISSUE_FAMILIES,
  type RunSpecIssue,
} from "../../../../src/workflows/spec/issues.js";
import { checkGraphRules } from "../../../../src/workflows/spec/rules/graph.js";
import type { RunSpec } from "../../../../src/workflows/spec/schema.js";
import { testRules, validSpec, wideSpec } from "../helpers.js";

/** Runs the graph family on a spec and returns what it reported. */
function run(spec: RunSpec): RunSpecIssue[] {
  const issues: RunSpecIssue[] = [];
  checkGraphRules(spec, testRules(), issues);
  return issues;
}

/** A spec whose lanes are `ids` with the given dependencies, in order. */
function graph(lanes: Record<string, string[]>): RunSpec {
  const base = validSpec();
  const template = base.lanes[0] as RunSpec["lanes"][number];
  return {
    ...base,
    lanes: Object.entries(lanes).map(([taskId, dependsOn], index) => ({
      ...template,
      taskId,
      title: `Lane ${index}`,
      dependsOn,
      allowedPaths: [`src/lane-${index}`],
    })),
  };
}

/** Same as `graph` but from an ordered list, so ids may repeat. */
function ordered(lanes: [string, string[]][]): RunSpec {
  const spec = graph({});
  const template = validSpec().lanes[0] as RunSpec["lanes"][number];
  spec.lanes = lanes.map(([taskId, dependsOn], index) => ({
    ...template,
    taskId,
    title: `Lane ${index}`,
    dependsOn,
    allowedPaths: [`src/lane-${index}`],
  }));
  return spec;
}

const codes = (issues: RunSpecIssue[]) => issues.map((issue) => issue.code);

describe("checkGraphRules: valid graphs", () => {
  test("reports nothing for a valid spec", () => {
    expect(run(validSpec())).toEqual([]);
  });

  test("reports nothing for a diamond graph", () => {
    expect(run(graph({ a: [], b: ["a"], c: ["a"], d: ["b", "c"] }))).toEqual(
      [],
    );
  });

  test("reports nothing for lanes without dependencies", () => {
    expect(run(graph({ a: [], b: [], c: [] }))).toEqual([]);
  });

  test("accepts 1,000 lanes within five seconds", () => {
    const spec = wideSpec(1000);
    const start = performance.now();
    expect(run(spec)).toEqual([]);
    expect(performance.now() - start).toBeLessThan(5000);
  });

  test("appends to the issues already present and keeps them", () => {
    const issues: RunSpecIssue[] = [
      { code: "RUN_SPEC_PATH_INVALID", path: ["x"], message: "earlier" },
    ];
    checkGraphRules(graph({ a: ["a"] }), testRules(), issues);
    expect(issues[0]?.message).toBe("earlier");
    expect(codes(issues)).toEqual([
      "RUN_SPEC_PATH_INVALID",
      "RUN_SPEC_DEPENDENCY_SELF",
    ]);
  });

  test("does not change the spec", () => {
    const spec = graph({ a: ["b"], b: ["a"], c: ["nope", "nope"] });
    const before = structuredClone(spec);
    run(spec);
    expect(spec).toEqual(before);
  });

  test("reports only codes of the graph family", () => {
    const issues = run(
      ordered([
        ["a", ["a", "zzz", "b", "b"]],
        ["b", ["c"]],
        ["c", ["b"]],
        ["a", []],
      ]),
    );
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(RUN_SPEC_ISSUE_FAMILIES[issue.code]).toBe("graph");
    }
  });
});

describe("RUN_SPEC_LANE_ID_DUPLICATE", () => {
  test("is reported for ids that differ only in case, on the later lane", () => {
    const issues = run(
      ordered([
        ["api", []],
        ["docs", []],
        ["API", []],
      ]),
    );
    expect(codes(issues)).toEqual(["RUN_SPEC_LANE_ID_DUPLICATE"]);
    expect(issues[0]?.path).toEqual(["lanes", 2, "taskId"]);
    expect(issues[0]?.message).toContain("differs only in case");
    expect(issues[0]?.message).toContain("lane 0");
  });

  test("is reported once per later lane when three ids fold to one", () => {
    const issues = run(
      ordered([
        ["Build", []],
        ["build", []],
        ["BUILD", []],
      ]),
    );
    expect(codes(issues)).toEqual([
      "RUN_SPEC_LANE_ID_DUPLICATE",
      "RUN_SPEC_LANE_ID_DUPLICATE",
    ]);
    expect(issues.map((issue) => issue.path[1])).toEqual([1, 2]);
  });

  test("keeps ids that differ in more than case apart", () => {
    expect(
      run(
        ordered([
          ["api-1", []],
          ["api_1", []],
          ["api.1", []],
        ]),
      ),
    ).toEqual([]);
  });

  test("is reported on the later lane only", () => {
    const issues = run(
      ordered([
        ["a", []],
        ["b", []],
        ["a", []],
      ]),
    );
    expect(codes(issues)).toEqual(["RUN_SPEC_LANE_ID_DUPLICATE"]);
    expect(issues[0]?.path).toEqual(["lanes", 2, "taskId"]);
  });

  test("names the lane that first used an exactly equal id, not a case difference", () => {
    const issues = run(
      ordered([
        ["a", []],
        ["b", []],
        ["a", []],
      ]),
    );
    expect(issues[0]?.message).toContain("is already used by lane 0");
    expect(issues[0]?.message).not.toContain("differs only in case");
  });

  test("reports a cycle on the first lane with a repeated id, not on its copy", () => {
    const issues = run(
      ordered([
        ["a", ["b"]],
        ["b", ["a"]],
        ["a", []],
      ]),
    );
    const cycles = issues.filter(
      (issue) =>
        issue.code === "RUN_SPEC_DEPENDENCY_CYCLE" && issue.path[1] !== 1,
    );
    expect(cycles.map((issue) => issue.path)).toEqual([
      ["lanes", 0, "dependsOn"],
    ]);
  });

  test("is reported once per later copy", () => {
    const issues = run(
      ordered([
        ["a", []],
        ["a", []],
        ["a", []],
      ]),
    );
    expect(issues.map((issue) => issue.path)).toEqual([
      ["lanes", 1, "taskId"],
      ["lanes", 2, "taskId"],
    ]);
  });

  test("compares ids exactly, so a different case is another lane that collides", () => {
    const issues = run(
      ordered([
        ["api", []],
        ["API", []],
        ["docs", ["API"]],
      ]),
    );
    // One collision issue, and the dependency on the exact id "API" resolves.
    expect(codes(issues)).toEqual(["RUN_SPEC_LANE_ID_DUPLICATE"]);
    expect(issues[0]?.path).toEqual(["lanes", 1, "taskId"]);
  });

  test("compares a prototype-like id as a plain string", () => {
    const issues = run(
      ordered([
        ["__proto__", []],
        ["constructor", []],
        ["toString", []],
        ["__proto__", []],
      ]),
    );
    expect(codes(issues)).toEqual(["RUN_SPEC_LANE_ID_DUPLICATE"]);
    expect(issues[0]?.path).toEqual(["lanes", 3, "taskId"]);
  });

  test("does not treat an inherited property name as an existing lane", () => {
    expect(
      run(
        ordered([
          ["a", []],
          ["toString", []],
        ]),
      ),
    ).toEqual([]);
  });
});

describe("RUN_SPEC_DEPENDENCY_UNKNOWN", () => {
  test("is reported at the entry, without a cycle issue", () => {
    const issues = run(graph({ a: [], b: ["a", "nope"] }));
    expect(codes(issues)).toEqual(["RUN_SPEC_DEPENDENCY_UNKNOWN"]);
    expect(issues[0]?.path).toEqual(["lanes", 1, "dependsOn", 1]);
  });

  test("is reported for each unknown entry", () => {
    const issues = run(graph({ a: ["x", "y"] }));
    expect(issues.map((issue) => issue.path)).toEqual([
      ["lanes", 0, "dependsOn", 0],
      ["lanes", 0, "dependsOn", 1],
    ]);
    expect(codes(issues)).toEqual([
      "RUN_SPEC_DEPENDENCY_UNKNOWN",
      "RUN_SPEC_DEPENDENCY_UNKNOWN",
    ]);
  });

  test("a different case does not match", () => {
    expect(codes(run(graph({ api: [], docs: ["API"] })))).toEqual([
      "RUN_SPEC_DEPENDENCY_UNKNOWN",
    ]);
  });

  test("surrounding whitespace does not match", () => {
    for (const value of [" api", "api ", "api\n", "api\t", " api"]) {
      expect(codes(run(graph({ api: [], docs: [value] })))).toEqual([
        "RUN_SPEC_DEPENDENCY_UNKNOWN",
      ]);
    }
  });

  test("an encoded, escaped or look-alike id does not match", () => {
    for (const value of [
      "%61pi",
      "a%70i",
      "api\u0000",
      "\u0000api",
      "ａpi",
      "apı",
      "api​",
      "\\u0061pi",
    ]) {
      expect(codes(run(graph({ api: [], docs: [value] })))).toEqual([
        "RUN_SPEC_DEPENDENCY_UNKNOWN",
      ]);
    }
  });

  test("an empty, dot or traversal value is unknown", () => {
    for (const value of ["", ".", "..", "../api", "api/..", "./api"]) {
      expect(codes(run(graph({ api: [], docs: [value] })))).toEqual([
        "RUN_SPEC_DEPENDENCY_UNKNOWN",
      ]);
    }
  });

  test("names of Object.prototype members are unknown", () => {
    for (const value of [
      "__proto__",
      "constructor",
      "toString",
      "hasOwnProperty",
      "valueOf",
    ]) {
      expect(codes(run(graph({ api: [], docs: [value] })))).toEqual([
        "RUN_SPEC_DEPENDENCY_UNKNOWN",
      ]);
    }
  });

  test("a very long value is unknown and the message stays bounded", () => {
    const issues = run(graph({ api: [], docs: ["x".repeat(100_000)] }));
    expect(codes(issues)).toEqual(["RUN_SPEC_DEPENDENCY_UNKNOWN"]);
    expect(issues[0]?.message.length).toBeLessThanOrEqual(512);
  });

  test("a lane id that is a dependency of an earlier lane is known", () => {
    expect(run(graph({ a: ["b"], b: [] }))).toEqual([]);
  });

  test("a dependency on a lane that only exists as a duplicate is known", () => {
    const issues = run(
      ordered([
        ["a", []],
        ["b", ["a"]],
        ["a", []],
      ]),
    );
    expect(codes(issues)).toEqual(["RUN_SPEC_LANE_ID_DUPLICATE"]);
  });
});

describe("RUN_SPEC_DEPENDENCY_SELF", () => {
  test("is reported at the entry, without a cycle issue", () => {
    const issues = run(graph({ a: ["a"] }));
    expect(codes(issues)).toEqual(["RUN_SPEC_DEPENDENCY_SELF"]);
    expect(issues[0]?.path).toEqual(["lanes", 0, "dependsOn", 0]);
  });

  test("is reported on the right lane among several", () => {
    const issues = run(graph({ a: [], b: ["a", "b"] }));
    expect(codes(issues)).toEqual(["RUN_SPEC_DEPENDENCY_SELF"]);
    expect(issues[0]?.path).toEqual(["lanes", 1, "dependsOn", 1]);
  });

  test("is reported once per lane that names itself", () => {
    const issues = run(graph({ a: ["a"], b: ["b"] }));
    expect(codes(issues)).toEqual([
      "RUN_SPEC_DEPENDENCY_SELF",
      "RUN_SPEC_DEPENDENCY_SELF",
    ]);
  });

  test("an id that differs only by case is not a self reference", () => {
    // The two ids collide when case is ignored, which is its own error.
    expect(codes(run(graph({ a: [], A: ["a"] })))).toEqual([
      "RUN_SPEC_LANE_ID_DUPLICATE",
    ]);
  });

  test("a prototype-like self reference is reported", () => {
    expect(codes(run(graph({ __proto__x: ["__proto__x"] })))).toEqual([
      "RUN_SPEC_DEPENDENCY_SELF",
    ]);
    expect(codes(run(ordered([["constructor", ["constructor"]]])))).toEqual([
      "RUN_SPEC_DEPENDENCY_SELF",
    ]);
  });
});

describe("RUN_SPEC_DEPENDENCY_DUPLICATE", () => {
  test("is reported at the repeated entry only", () => {
    const issues = run(graph({ a: [], b: ["a", "a"] }));
    expect(codes(issues)).toEqual(["RUN_SPEC_DEPENDENCY_DUPLICATE"]);
    expect(issues[0]?.path).toEqual(["lanes", 1, "dependsOn", 1]);
  });

  test("is reported for each extra copy", () => {
    const issues = run(graph({ a: [], b: ["a", "a", "a"] }));
    expect(issues.map((issue) => issue.path)).toEqual([
      ["lanes", 1, "dependsOn", 1],
      ["lanes", 1, "dependsOn", 2],
    ]);
  });

  test("does not report different dependencies", () => {
    expect(run(graph({ a: [], b: [], c: ["a", "b"] }))).toEqual([]);
  });

  test("does not report ids that differ only by case", () => {
    // The lane ids collide, which is reported once on the lane; the two
    // dependencies are still different entries.
    expect(codes(run(graph({ a: [], A: [], c: ["a", "A"] })))).toEqual([
      "RUN_SPEC_LANE_ID_DUPLICATE",
    ]);
  });

  test("a repeated unknown id is reported unknown, then as a duplicate", () => {
    const issues = run(graph({ a: ["x", "x"] }));
    expect(codes(issues)).toEqual([
      "RUN_SPEC_DEPENDENCY_UNKNOWN",
      "RUN_SPEC_DEPENDENCY_DUPLICATE",
    ]);
    expect(issues.map((issue) => issue.path)).toEqual([
      ["lanes", 0, "dependsOn", 0],
      ["lanes", 0, "dependsOn", 1],
    ]);
  });

  test("a repeated edge does not hide or create a cycle report", () => {
    const issues = run(graph({ a: ["b", "b"], b: [] }));
    expect(codes(issues)).toEqual(["RUN_SPEC_DEPENDENCY_DUPLICATE"]);
  });

  test("256 copies of one dependency report 255 duplicates", () => {
    const issues = run(graph({ a: [], b: Array(256).fill("a") }));
    expect(
      codes(issues).filter((c) => c === "RUN_SPEC_DEPENDENCY_DUPLICATE"),
    ).toHaveLength(255);
  });
});

describe("RUN_SPEC_DEPENDENCY_CYCLE", () => {
  test("a two-lane cycle is reported once per lane", () => {
    const issues = run(graph({ a: ["b"], b: ["a"] }));
    expect(codes(issues)).toEqual([
      "RUN_SPEC_DEPENDENCY_CYCLE",
      "RUN_SPEC_DEPENDENCY_CYCLE",
    ]);
    expect(issues.map((issue) => issue.path)).toEqual([
      ["lanes", 0, "dependsOn"],
      ["lanes", 1, "dependsOn"],
    ]);
  });

  test("the message names the lanes of the cycle", () => {
    const issues = run(graph({ a: ["c"], b: ["a"], c: ["b"] }));
    expect(issues).toHaveLength(3);
    for (const issue of issues) {
      for (const id of ["a", "b", "c"]) expect(issue.message).toContain(id);
    }
  });

  test("the message shows the cycle path in dependency order", () => {
    // a waits for b, b for c, c for a.
    const issues = run(graph({ a: ["b"], b: ["c"], c: ["a"] }));
    const message = issues[0]?.message ?? "";
    expect(message).toMatch(/a\W+b\W+c\W+a|b\W+c\W+a\W+b|c\W+a\W+b\W+c/);
  });

  test("a lane that waits for a cycle is reported too", () => {
    const issues = run(graph({ a: ["b"], b: ["a"], c: ["a"] }));
    expect(codes(issues)).toEqual([
      "RUN_SPEC_DEPENDENCY_CYCLE",
      "RUN_SPEC_DEPENDENCY_CYCLE",
      "RUN_SPEC_DEPENDENCY_CYCLE",
    ]);
    expect(issues[2]?.path).toEqual(["lanes", 2, "dependsOn"]);
  });

  test("lanes outside the cycle are not reported", () => {
    const issues = run(graph({ ok: [], a: ["b"], b: ["a"], after: ["ok"] }));
    expect(issues.map((issue) => issue.path)).toEqual([
      ["lanes", 1, "dependsOn"],
      ["lanes", 2, "dependsOn"],
    ]);
  });

  test("a cycle is found when it does not start at the first lane", () => {
    const issues = run(
      graph({ root: [], a: ["root", "c"], b: ["a"], c: ["b"] }),
    );
    expect(codes(issues)).toHaveLength(3);
  });

  test("two separate cycles are both reported", () => {
    const issues = run(graph({ a: ["b"], b: ["a"], c: ["d"], d: ["c"] }));
    expect(codes(issues)).toHaveLength(4);
  });

  test("a self dependency is not also a cycle issue", () => {
    expect(codes(run(graph({ a: ["a"], b: [] })))).toEqual([
      "RUN_SPEC_DEPENDENCY_SELF",
    ]);
  });

  test("an unknown dependency is not also a cycle issue", () => {
    expect(codes(run(graph({ a: ["zzz"] })))).toEqual([
      "RUN_SPEC_DEPENDENCY_UNKNOWN",
    ]);
  });

  test("a cycle is still reported next to an unrelated faulty lane", () => {
    const issues = run(graph({ a: ["b"], b: ["a"], c: ["c"], d: ["x"] }));
    expect(
      codes(issues).filter((c) => c === "RUN_SPEC_DEPENDENCY_CYCLE"),
    ).toHaveLength(2);
    expect(codes(issues)).toContain("RUN_SPEC_DEPENDENCY_SELF");
    expect(codes(issues)).toContain("RUN_SPEC_DEPENDENCY_UNKNOWN");
  });

  test("a cycle with prototype-like ids is found", () => {
    const issues = run(
      ordered([
        ["__proto__", ["constructor"]],
        ["constructor", ["__proto__"]],
      ]),
    );
    expect(codes(issues)).toEqual([
      "RUN_SPEC_DEPENDENCY_CYCLE",
      "RUN_SPEC_DEPENDENCY_CYCLE",
    ]);
  });

  test("a cycle of exactly 12 lanes is listed in full, 13 is shortened", () => {
    const ring = (size: number) => {
      const lanes: Record<string, string[]> = {};
      for (let i = 0; i < size; i += 1) {
        lanes[`n${i}`] = [`n${(i + 1) % size}`];
      }
      return run(graph(lanes))[0]?.message ?? "";
    };
    const twelve = ring(12);
    expect(twelve).not.toContain("...");
    expect(twelve).toContain('"n11"');
    const thirteen = ring(13);
    expect(thirteen).toContain("...");
    expect(thirteen).not.toContain('"n12" ->');
  });

  test("an id of exactly 64 characters is echoed whole, 65 is cut", () => {
    const cycleMessage = (length: number) => {
      const a = "a".repeat(length);
      const b = "b".repeat(length);
      return run(graph({ [a]: [b], [b]: [a] }))[0]?.message ?? "";
    };
    const exact = cycleMessage(64);
    expect(exact).toContain(`"${"a".repeat(64)}"`);
    expect(exact).not.toContain("...");
    const over = cycleMessage(65);
    expect(over).toContain(`"${"a".repeat(64)}"...`);
    expect(over).not.toContain("a".repeat(65));
  });

  test("a 1,000-lane ring is reported within five seconds", () => {
    const spec = wideSpec(1000);
    for (const [index, lane] of spec.lanes.entries()) {
      lane.dependsOn = [`lane-${(index + 999) % 1000}`];
    }
    const start = performance.now();
    const issues = run(spec);
    expect(performance.now() - start).toBeLessThan(5000);
    expect(
      codes(issues).filter((c) => c === "RUN_SPEC_DEPENDENCY_CYCLE"),
    ).toHaveLength(1000);
  });

  test("the message stays bounded for a long cycle", () => {
    const spec = wideSpec(1000);
    for (const [index, lane] of spec.lanes.entries()) {
      lane.dependsOn = [`lane-${(index + 999) % 1000}`];
    }
    for (const issue of run(spec)) {
      expect(issue.message.length).toBeLessThanOrEqual(512);
    }
  });

  test("a 1,000-lane chain is accepted without a stack overflow", () => {
    const spec = wideSpec(1000);
    for (const [index, lane] of spec.lanes.entries()) {
      lane.dependsOn = index === 0 ? [] : [`lane-${index - 1}`];
    }
    expect(run(spec)).toEqual([]);
  });

  test("a chain closed into a cycle at the far end is found", () => {
    const spec = wideSpec(1000);
    for (const [index, lane] of spec.lanes.entries()) {
      lane.dependsOn = index === 0 ? ["lane-999"] : [`lane-${index - 1}`];
    }
    expect(run(spec)).toHaveLength(1000);
  });
});

describe("RUN_SPEC_PLAN_REJECTED", () => {
  test("is not reported when a more specific graph code was", () => {
    for (const spec of [
      graph({ a: ["a"] }),
      graph({ a: ["x"] }),
      graph({ a: ["b"], b: ["a"] }),
      graph({ a: [], b: ["a", "a"] }),
      ordered([
        ["a", []],
        ["a", []],
      ]),
    ]) {
      expect(codes(run(spec))).not.toContain("RUN_SPEC_PLAN_REJECTED");
    }
  });

  test("is reported when an acyclic graph exceeds the plan size limit", () => {
    const spec = wideSpec(300);
    for (const [index, lane] of spec.lanes.entries()) {
      const count = Math.min(index, 256);
      lane.dependsOn = Array.from(
        { length: count },
        (_, offset) => `lane-${index - 1 - offset}`,
      );
    }
    const issues = run(spec);
    expect(codes(issues)).toEqual(["RUN_SPEC_PLAN_REJECTED"]);
    expect(issues[0]?.path).toEqual(["lanes"]);
  });

  test("is not reported for a valid spec", () => {
    expect(codes(run(validSpec()))).not.toContain("RUN_SPEC_PLAN_REJECTED");
    expect(codes(run(wideSpec(1000)))).not.toContain("RUN_SPEC_PLAN_REJECTED");
  });
});
