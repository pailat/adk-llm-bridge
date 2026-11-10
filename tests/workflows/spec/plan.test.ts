import { describe, expect, test } from "bun:test";
import { canonicalDigest } from "../../../src/workflows/internal/canonical-hash.js";
import { validateWorkflowPlan } from "../../../src/workflows/orchestration/json.js";
import {
  resolveRunPlan,
  runSpecHash,
} from "../../../src/workflows/spec/plan.js";
import {
  mergeRunRules,
  RUN_SPEC_DRY_RUN_BINDING,
  RUN_SPEC_LIMITS,
  type RunSpec,
  type RunSpecLane,
  runSpecWorkflowPlan,
} from "../../../src/workflows/spec/schema.js";
import type { RunPlan } from "../../../src/workflows/spec/types.js";
import { validateRunSpec } from "../../../src/workflows/spec/validate.js";
import { testRules, validSpec, wideSpec } from "./helpers.js";

function plan(spec: unknown, rules = testRules()): RunPlan {
  const result = resolveRunPlan(spec, rules);
  if (!result.ok) {
    throw new Error(`expected a plan, got ${JSON.stringify(result.errors)}`);
  }
  return result.plan;
}

function lane(
  taskId: string,
  dependsOn: string[],
  extra: Partial<RunSpecLane> = {},
): RunSpecLane {
  return {
    taskId,
    title: taskId,
    role: "worker",
    dependsOn,
    allowedPaths: [`src/${taskId}`],
    agent: {
      providerId: "codex",
      model: "gpt-5.5",
      mode: "workspace-write",
      tools: [],
    },
    steps: { testsFirst: false, review: { kind: "none" } },
    ...extra,
  };
}

function withLanes(lanes: RunSpecLane[]): RunSpec {
  return { ...validSpec(), lanes };
}

describe("resolveRunPlan validation", () => {
  test("returns the validation errors unchanged for an invalid spec", () => {
    const spec = validSpec();
    spec.budget.maxUsd = 1_000;
    const expected = validateRunSpec(spec, testRules());
    expect(expected.ok).toBe(false);
    const result = resolveRunPlan(spec, testRules());
    expect(result.ok).toBe(false);
    if (!result.ok && !expected.ok)
      expect(result.errors).toEqual(expected.errors);
  });

  test("returns shape errors for a non-object input without throwing", () => {
    const result = resolveRunPlan("nope", testRules());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
  });

  test("returns the concurrency error when the spec exceeds the rule cap", () => {
    const rules = { ...testRules(), maxConcurrency: 1 };
    const result = resolveRunPlan(validSpec(), rules);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toContain(
        "RUN_SPEC_CONCURRENCY_EXCEEDED",
      );
    }
  });

  test("returns the dependency cycle error and no plan", () => {
    const result = resolveRunPlan(
      withLanes([lane("a", ["b"]), lane("b", ["a"])]),
      testRules(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toContain(
        "RUN_SPEC_DEPENDENCY_CYCLE",
      );
    }
  });
});

describe("resolveRunPlan waves and lanes", () => {
  test("puts dependent lanes in later waves", () => {
    const p = plan(validSpec());
    expect(p.waves).toEqual([
      { waveId: "wave-1", taskIds: ["api"] },
      { waveId: "wave-2", taskIds: ["docs"] },
    ]);
    expect(p.lanes.map((l) => [l.taskId, l.waveId, l.waveIndex])).toEqual([
      ["api", "wave-1", 0],
      ["docs", "wave-2", 1],
    ]);
  });

  test("places a lane one wave after its latest dependency in a diamond", () => {
    const p = plan(
      withLanes([
        lane("a", []),
        lane("b", ["a"]),
        lane("c", ["a"]),
        lane("d", ["b", "c"]),
        lane("e", ["a", "d"]),
        lane("f", []),
      ]),
    );
    expect(p.waves).toEqual([
      { waveId: "wave-1", taskIds: ["a", "f"] },
      { waveId: "wave-2", taskIds: ["b", "c"] },
      { waveId: "wave-3", taskIds: ["d"] },
      { waveId: "wave-4", taskIds: ["e"] },
    ]);
    expect(p.lanes.map((l) => l.taskId)).toEqual([
      "a",
      "f",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  test("orders lanes by dependency even when the spec lists them out of order", () => {
    const spec = validSpec();
    spec.lanes.reverse();
    const p = plan(spec);
    expect(p.lanes.map((l) => l.taskId)).toEqual(["api", "docs"]);
    expect(p.waves.map((w) => w.taskIds)).toEqual([["api"], ["docs"]]);
  });

  test("keeps spec order inside a wave", () => {
    const p = plan(withLanes([lane("z", []), lane("m", []), lane("a", [])]));
    expect(p.waves).toEqual([{ waveId: "wave-1", taskIds: ["z", "m", "a"] }]);
  });

  test("every dependency is in an earlier wave and every lane is in one wave", () => {
    const p = plan(wideSpec(120));
    const waveOf = new Map<string, number>();
    p.waves.forEach((wave, index) => {
      for (const id of wave.taskIds) {
        expect(waveOf.has(id)).toBe(false);
        waveOf.set(id, index);
      }
    });
    expect(waveOf.size).toBe(120);
    for (const l of p.lanes) {
      for (const dep of l.dependsOn) {
        expect(waveOf.get(dep) as number).toBeLessThan(l.waveIndex);
      }
    }
  });

  test("copies lane fields unchanged", () => {
    const p = plan(validSpec());
    expect(p.lanes[0]).toMatchObject({
      taskId: "api",
      title: "Add the health endpoint",
      role: "worker",
      dependsOn: [],
      allowedPaths: ["src/api", "tests/api"],
    });
    expect(p.specVersion).toBe(1);
    expect(p.workflowId).toBe("lanes");
    expect(p.workflowVersion).toBe("1");
    expect(p.projectRoot).toBe(".");
  });

  test("the topology is accepted by the existing plan validator", () => {
    const p = plan(validSpec());
    const full = runSpecWorkflowPlan(p.topology, RUN_SPEC_DRY_RUN_BINDING);
    expect(() => validateWorkflowPlan(full)).not.toThrow();
  });
});

describe("resolveRunPlan agents", () => {
  test("lists tests, implement and review agents in run order", () => {
    const p = plan(validSpec());
    expect(p.lanes[0]?.agents).toEqual([
      {
        purpose: "tests",
        providerId: "claude-code",
        model: "claude-sonnet-5",
        mode: "workspace-write",
        allowNetwork: false,
        tools: ["Read", "Edit"],
        mcp: [],
        maxRuns: 1,
      },
      {
        purpose: "implement",
        providerId: "claude-code",
        model: "claude-sonnet-5",
        mode: "workspace-write",
        allowNetwork: false,
        tools: ["Read", "Edit"],
        mcp: [],
        maxRuns: 3,
      },
      {
        purpose: "review",
        providerId: "codex",
        model: "gpt-5.5",
        mode: "read-only",
        allowNetwork: false,
        tools: [],
        mcp: [],
        maxRuns: 3,
      },
    ]);
    expect(p.lanes[0]?.maxAgentRuns).toBe(7);
  });

  test("a lane with no tests and no review has one implement agent", () => {
    const p = plan(validSpec());
    expect(p.lanes[1]?.agents.map((a) => [a.purpose, a.maxRuns])).toEqual([
      ["implement", 1],
    ]);
    expect(p.lanes[1]?.maxAgentRuns).toBe(1);
  });

  test("allowNetwork is false when the spec omits it", () => {
    const spec = validSpec();
    const first = spec.lanes[0];
    expect(first?.agent.allowNetwork).toBeUndefined();
    const p = plan(spec);
    expect(p.lanes[0]?.agents.every((a) => a.allowNetwork === false)).toBe(
      true,
    );
  });

  test("allowNetwork true is kept for the lane agent but never for the reviewer", () => {
    const rules = { ...testRules(), allowNetwork: true };
    const spec = validSpec();
    const first = spec.lanes[0];
    if (!first) throw new Error("missing lane");
    first.agent.allowNetwork = true;
    const agents = plan(spec, rules).lanes[0]?.agents ?? [];
    expect(agents.find((a) => a.purpose === "implement")?.allowNetwork).toBe(
      true,
    );
    expect(agents.find((a) => a.purpose === "review")?.allowNetwork).toBe(
      false,
    );
  });

  test("reviewer runs read-only with no tools even if the lane agent writes", () => {
    const review = plan(validSpec()).lanes[0]?.agents.find(
      (a) => a.purpose === "review",
    );
    expect(review?.mode).toBe("read-only");
    expect(review?.tools).toEqual([]);
  });

  test("maxRuns follows the change round count", () => {
    const spec = validSpec();
    const first = spec.lanes[0];
    if (first?.steps.review.kind !== "agent") throw new Error("setup");
    first.steps.review.maxChangeRounds = 3;
    const p = plan(spec);
    expect(p.lanes[0]?.maxAgentRuns).toBe(1 + 4 + 4);
  });
});

describe("resolveRunPlan limits and cost bound", () => {
  test("reports effective limits with their ceilings", () => {
    const p = plan(validSpec());
    expect(p.limits.budgetUsd).toMatchObject({
      value: 5,
      ceiling: 10,
      rule: "maxBudgetUsd",
    });
    expect(p.limits.maxConcurrency).toMatchObject({
      value: 2,
      ceiling: 4,
      rule: "maxConcurrency",
    });
    expect(p.limits.lanes).toMatchObject({
      value: 2,
      ceiling: 1_000,
      rule: "maxLanes",
    });
    expect(p.limits.agentRuns).toMatchObject({
      value: 8,
      ceiling: 10_000,
      rule: "maxAgentRuns",
    });
    expect(p.limits.changeRounds).toMatchObject({
      value: 2,
      ceiling: 3,
      rule: "maxChangeRounds",
    });
  });

  test("no limit value exceeds its ceiling", () => {
    const p = plan(validSpec());
    for (const limit of Object.values(p.limits)) {
      expect(limit.value).toBeLessThanOrEqual(limit.ceiling);
    }
  });

  test("changeRounds is 0 when no lane is reviewed", () => {
    const p = plan(withLanes([lane("a", [])]));
    expect(p.limits.changeRounds.value).toBe(0);
  });

  test("cost bound is the spec budget, summed agent runs and peak concurrency", () => {
    const p = plan(validSpec());
    expect(p.costBound).toEqual({
      maxUsd: 5,
      maxAgentRuns: 8,
      peakConcurrency: 1,
    });
  });

  test("peak concurrency is the smaller of the limit and the widest wave", () => {
    const spec = wideSpec(30);
    spec.maxConcurrency = 4;
    expect(plan(spec).costBound.peakConcurrency).toBe(4);
    spec.maxConcurrency = 2;
    expect(plan(spec).costBound.peakConcurrency).toBe(2);
    const narrow = withLanes([lane("a", []), lane("b", ["a"])]);
    narrow.maxConcurrency = 4;
    expect(plan(narrow).costBound.peakConcurrency).toBe(1);
    const wide = withLanes([lane("a", []), lane("b", []), lane("c", [])]);
    wide.maxConcurrency = 4;
    expect(plan(wide).costBound.peakConcurrency).toBe(3);
  });

  test("cost bound agent runs equals the limit value and the lane sum", () => {
    const p = plan(wideSpec(25));
    expect(p.costBound.maxAgentRuns).toBe(25);
    expect(p.limits.agentRuns.value).toBe(25);
    expect(p.lanes.reduce((n, l) => n + l.maxAgentRuns, 0)).toBe(25);
  });

  test("start input is inline for a small spec and reference for a large one", () => {
    expect(plan(validSpec()).startInput).toBe("inline");
    expect(plan(wideSpec(1_000)).startInput).toBe("reference");
  });
});

describe("resolveRunPlan rule set provenance", () => {
  test("an unmerged rule set names its own id for every limit", () => {
    const p = plan(validSpec());
    for (const limit of Object.values(p.limits)) {
      expect(limit.ruleSets).toEqual(["test"]);
    }
  });

  test("a merged rule set names the rule sets that decided each ceiling", () => {
    const merged = mergeRunRules(testRules(), { id: "org", maxBudgetUsd: 8 });
    const p = plan(validSpec(), merged);
    expect(p.limits.budgetUsd.ceiling).toBe(8);
    expect(p.limits.budgetUsd.ruleSets).toEqual(
      merged.origins?.maxBudgetUsd as string[],
    );
    expect(p.limits.budgetUsd.ruleSets).toEqual(["org"]);
    expect(p.limits.lanes.ruleSets).toEqual(["test"]);
  });

  test("origins in the rule set are copied, not shared", () => {
    const merged = mergeRunRules(testRules(), { id: "org", maxBudgetUsd: 8 });
    const p = plan(validSpec(), merged);
    expect(p.limits.budgetUsd.ruleSets).not.toBe(merged.origins?.maxBudgetUsd);
  });

  test("a spec above a merged ceiling is rejected, not reduced", () => {
    const merged = mergeRunRules(testRules(), { id: "org", maxBudgetUsd: 4 });
    const result = resolveRunPlan(validSpec(), merged);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toContain(
        "RUN_SPEC_BUDGET_EXCEEDED",
      );
    }
  });
});

describe("resolveRunPlan determinism", () => {
  test("the same input gives a deep-equal plan", () => {
    expect(plan(validSpec())).toEqual(plan(validSpec()));
    expect(plan(wideSpec(200))).toEqual(plan(wideSpec(200)));
  });

  test("planning does not change the input", () => {
    const spec = validSpec();
    const before = structuredClone(spec);
    plan(spec);
    expect(spec).toEqual(before);
  });

  test("does not read the clock or a random source", () => {
    const realNow = Date.now;
    const realRandom = Math.random;
    const realDate = globalThis.Date;
    const trap = () => {
      throw new Error("non-deterministic source used");
    };
    Date.now = trap;
    Math.random = trap;
    try {
      const p = plan(validSpec());
      expect(p.lanes.length).toBe(2);
    } finally {
      Date.now = realNow;
      Math.random = realRandom;
      globalThis.Date = realDate;
    }
  });
});

describe("resolveRunPlan scale", () => {
  test("resolves a 1,000-lane layered spec within the time budget", () => {
    const spec = wideSpec(1_000);
    const start = performance.now();
    const result = resolveRunPlan(spec, testRules());
    const elapsed = performance.now() - start;
    expect(result.ok).toBe(true);
    expect(elapsed).toBeLessThan(2_000);
    if (!result.ok) return;
    expect(result.plan.lanes).toHaveLength(1_000);
    expect(result.plan.waves).toHaveLength(100);
    expect(result.plan.waves.every((w) => w.taskIds.length === 10)).toBe(true);
    expect(result.plan.waves[99]?.waveId).toBe("wave-100");
    expect(result.plan.costBound.maxAgentRuns).toBe(1_000);
    expect(result.plan.costBound.peakConcurrency).toBe(2);
  });

  test("resolves a 1,000-lane chain and a flat 1,000-lane spec", () => {
    const chain = wideSpec(1_000);
    for (const [index, l] of chain.lanes.entries()) {
      l.dependsOn = index > 0 ? [`lane-${index - 1}`] : [];
    }
    const start = performance.now();
    const chained = plan(chain);
    expect(chained.waves).toHaveLength(1_000);
    const flat = wideSpec(1_000);
    for (const l of flat.lanes) l.dependsOn = [];
    const flatPlan = plan(flat);
    expect(flatPlan.waves).toHaveLength(1);
    expect(flatPlan.waves[0]?.taskIds).toHaveLength(1_000);
    expect(performance.now() - start).toBeLessThan(4_000);
  });
});

describe("resolveRunPlan with many paths per lane", () => {
  /** Lanes that each own `paths` paths under one long shared prefix. */
  function manyPaths(lanes: number, paths: number) {
    const prefix = Array.from(
      { length: 60 },
      (_, index) => `segment-${"x".repeat(50)}-${index}`,
    ).join("/");
    const spec = wideSpec(lanes);
    spec.lanes.forEach((lane, laneIndex) => {
      lane.allowedPaths = Array.from(
        { length: paths },
        (_, pathIndex) => `${prefix}/l${laneIndex}p${pathIndex}`,
      );
    });
    return spec;
  }

  test("plans the most paths a spec may own, with long shared prefixes, within a generous bound", () => {
    const lanes = RUN_SPEC_LIMITS.maxTotalAllowedPaths / 64;
    const spec = manyPaths(lanes, 64);
    const start = performance.now();
    const result = resolveRunPlan(spec, testRules());
    expect(result.ok ? [] : result.errors).toEqual([]);
    // Measured at about 0.3 s; the bound leaves room for a slow machine.
    expect(performance.now() - start).toBeLessThan(10_000);
  });

  test("rejects one path more than the limit before comparing any claims", () => {
    const lanes = RUN_SPEC_LIMITS.maxTotalAllowedPaths / 64;
    const spec = manyPaths(lanes + 1, 64);
    const result = resolveRunPlan(spec, testRules());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((issue) => issue.code)).toEqual([
      "RUN_SPEC_PLAN_TOO_LARGE",
    ]);
  });
});

describe("runSpecHash", () => {
  test("is the canonical digest of the spec", async () => {
    const spec = validSpec();
    delete (spec.lanes[1] as RunSpecLane).agent.allowNetwork;
    expect(await runSpecHash(spec)).toBe(await canonicalDigest(spec));
    expect(await runSpecHash(spec)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("is stable for equal specs", async () => {
    expect(await runSpecHash(validSpec())).toBe(await runSpecHash(validSpec()));
  });

  test("does not depend on object key order", async () => {
    const spec = validSpec();
    const shuffled = JSON.parse(
      JSON.stringify(spec, (_k, v) =>
        v && typeof v === "object" && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).reverse())
          : v,
      ),
    ) as RunSpec;
    expect(Object.keys(shuffled)).not.toEqual(Object.keys(spec));
    expect(await runSpecHash(shuffled)).toBe(await runSpecHash(spec));
  });

  test("does not depend on a frozen copy or the spec returned by validation", async () => {
    const validated = validateRunSpec(validSpec(), testRules());
    if (!validated.ok) throw new Error("setup");
    expect(await runSpecHash(validated.spec)).toBe(
      await runSpecHash(validSpec()),
    );
  });

  test("changes with any semantic change", async () => {
    const base = await runSpecHash(validSpec());
    const edits: Array<(s: RunSpec) => void> = [
      (s) => {
        s.budget.maxUsd = 6;
      },
      (s) => {
        s.maxConcurrency = 1;
      },
      (s) => {
        s.workflowVersion = "2";
      },
      (s) => {
        s.projectRoot = "packages";
      },
      (s) => {
        s.env = [];
      },
      (s) => {
        (s.lanes[0] as RunSpecLane).title = "Other";
      },
      (s) => {
        (s.lanes[0] as RunSpecLane).allowedPaths.reverse();
      },
      (s) => {
        s.lanes.reverse();
      },
      (s) => {
        (s.lanes[1] as RunSpecLane).dependsOn = [];
      },
      (s) => {
        (s.lanes[1] as RunSpecLane).agent.allowNetwork = true;
      },
      (s) => {
        (s.lanes[0] as RunSpecLane).steps.testsFirst = false;
      },
      (s) => {
        s.gates.publish = { kind: "none" };
      },
      (s) => {
        (s.gates.qa[0] as { command: string[] }).command = [
          "bun",
          "run",
          "lint",
        ];
      },
    ];
    const seen = new Set<string>([base]);
    for (const edit of edits) {
      const spec = validSpec();
      edit(spec);
      const hash = await runSpecHash(spec);
      expect(seen.has(hash)).toBe(false);
      seen.add(hash);
    }
  });

  test("treats an explicit false and an absent allowNetwork as the same", async () => {
    const absent = validSpec();
    const explicit = validSpec();
    (explicit.lanes[0] as RunSpecLane).agent.allowNetwork = false;
    delete (absent.lanes[1] as RunSpecLane).agent.allowNetwork;
    const before = JSON.stringify(explicit);
    expect(await runSpecHash(explicit)).toBe(await runSpecHash(absent));
    expect(JSON.stringify(explicit)).toBe(before);
  });

  test("does not read the clock or a random source", async () => {
    const realNow = Date.now;
    const realRandom = Math.random;
    const trap = () => {
      throw new Error("non-deterministic source used");
    };
    Date.now = trap;
    Math.random = trap;
    try {
      await runSpecHash(validSpec());
    } finally {
      Date.now = realNow;
      Math.random = realRandom;
    }
  });
});

describe("resolveRunPlan denied paths", () => {
  test("the plan carries the effective denied path patterns of the checked rule set", () => {
    const rules = testRules();
    const p = plan(validSpec(), rules);
    expect(p.deniedPathPatterns).toEqual(rules.deniedPathPatterns);
    expect(p.deniedPathPatterns.length).toBeGreaterThan(0);
    expect(p.deniedPathPatterns).not.toBe(rules.deniedPathPatterns);
  });

  test("the plan's patterns come from the validated copy, not a second read of the host's rules", () => {
    const rules = testRules();
    const first = [...rules.deniedPathPatterns];
    let reads = 0;
    Object.defineProperty(rules, "deniedPathPatterns", {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? first : ["SWAPPED"];
      },
    });
    const p = plan(validSpec(), rules);
    expect(reads).toBe(1);
    expect(p.deniedPathPatterns).toEqual(first);
  });

  test("the topology has the run-spec.denied-paths invariant, enforced by the host", () => {
    for (const rules of [
      testRules(),
      { ...testRules(), deniedPathPatterns: [] },
    ]) {
      const invariant = plan(validSpec(), rules).topology.invariants.find(
        (entry) => entry.invariantId === "run-spec.denied-paths",
      );
      expect(invariant?.enforcedBy).toBe("host");
      expect(invariant?.appliesTo).toBe("workflow");
    }
  });

  test("a subtree claim that holds a denied name below it still plans, and the plan names the pattern", () => {
    const spec = validSpec();
    spec.lanes = [
      { ...(spec.lanes[0] as RunSpecLane), allowedPaths: ["packages"] },
    ];
    spec.lanes[0] = { ...(spec.lanes[0] as RunSpecLane), dependsOn: [] };
    const p = plan(spec);
    expect(p.topology.lanes[0]?.ownedPaths).toEqual([
      { path: "packages", scope: "subtree" },
    ]);
    expect(p.deniedPathPatterns).toContain(".env");
  });
});
