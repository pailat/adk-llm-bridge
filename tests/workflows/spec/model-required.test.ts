import { describe, expect, test } from "bun:test";
import { runSpecJsonSchema } from "../../../src/workflows/spec/json-schema.js";
import { resolveRunPlan } from "../../../src/workflows/spec/plan.js";
import {
  mergeRunRules,
  RUN_RULE_KEYS,
  type RunRules,
  RunRulesOverrideSchema,
  RunRulesSchema,
  type RunSpec,
} from "../../../src/workflows/spec/schema.js";
import { validateRunSpec } from "../../../src/workflows/spec/validate.js";
import { testRules, validSpec } from "./helpers.js";

type Path = (string | number)[];

/** Sets the agent model of lane 0 (or the reviewer model) on a fresh spec. */
function specWith(target: "agent" | "reviewer", model: unknown): unknown {
  const spec = validSpec() as unknown as {
    lanes: {
      agent: Record<string, unknown>;
      steps: { review: Record<string, unknown> };
    }[];
  };
  const owner =
    target === "agent" ? spec.lanes[0]?.agent : spec.lanes[0]?.steps.review;
  if (!owner) throw new Error("fixture changed");
  if (model === undefined) delete owner.model;
  else owner.model = model;
  return spec;
}

const MODEL_PATH: Record<"agent" | "reviewer", Path> = {
  agent: ["lanes", 0, "agent", "model"],
  reviewer: ["lanes", 0, "steps", "review", "model"],
};

function issuesOf(spec: unknown, rules: RunRules = testRules()) {
  const result = validateRunSpec(spec, rules);
  return result.ok ? [] : result.errors;
}

/** Rules that list every model the cases below use. */
function rulesAllowing(...models: string[]): RunRules {
  const rules = testRules();
  rules.allowedModels = [...rules.allowedModels, ...models];
  return rules;
}

describe("RUN_SPEC_MODEL_REQUIRED", () => {
  for (const target of ["agent", "reviewer"] as const) {
    for (const [label, value] of [
      ["missing", undefined],
      ["empty", ""],
      ["blank", "  "],
      ["tab and newline", "\t\n"],
    ] as const) {
      test(`${target} model ${label}: one issue at the model path`, () => {
        const spec = specWith(target, value);
        const issues = issuesOf(spec);
        expect(issues.map((issue) => issue.code)).toEqual([
          "RUN_SPEC_MODEL_REQUIRED",
        ]);
        expect(issues[0]?.path).toEqual(MODEL_PATH[target]);
        const plan = resolveRunPlan(spec, testRules());
        expect(plan.ok).toBe(false);
        if (!plan.ok) {
          expect(plan.errors.map((issue) => issue.code)).toEqual([
            "RUN_SPEC_MODEL_REQUIRED",
          ]);
          expect(plan.errors[0]?.path).toEqual(MODEL_PATH[target]);
        }
      });
    }

    test(`${target} model with a space or a leading dash is a format issue`, () => {
      for (const value of ["a b", "-x"]) {
        const codes = issuesOf(specWith(target, value)).map((i) => i.code);
        expect(codes).toEqual(["RUN_SPEC_INVALID_FORMAT"]);
      }
    });

    test(`${target} model that is not a string is a type issue`, () => {
      for (const value of [5, null, true, {}]) {
        const codes = issuesOf(specWith(target, value)).map((i) => i.code);
        expect(codes).toEqual(["RUN_SPEC_INVALID_TYPE"]);
      }
    });
  }

  test("a missing model on another key stays RUN_SPEC_MISSING_KEY", () => {
    const spec = validSpec() as unknown as Record<string, unknown>;
    delete spec.workflowId;
    expect(issuesOf(spec).map((i) => i.code)).toEqual(["RUN_SPEC_MISSING_KEY"]);
  });

  test("a blank providerId is not a model issue", () => {
    const spec = validSpec();
    const lane = spec.lanes[0];
    if (!lane) throw new Error("fixture changed");
    lane.agent.providerId = "  ";
    expect(issuesOf(spec).map((i) => i.code)).toEqual([
      "RUN_SPEC_INVALID_FORMAT",
    ]);
  });

  test("a valid model is accepted", () => {
    expect(validateRunSpec(validSpec(), testRules()).ok).toBe(true);
  });
});

describe("model id bracket suffix", () => {
  const accepted = ["opus[1m]", "claude-opus-5-5[1m]", "x[A9]"];
  const refused = [
    "opus[]",
    "opus[1m]x",
    "opus[1m][2m]",
    "opus[1-m]",
    "op[1m]us",
    "[1m]",
    "opus]",
    "opus[1m",
  ];

  test("is accepted in agent and reviewer models", () => {
    for (const model of accepted) {
      for (const target of ["agent", "reviewer"] as const) {
        const rules = rulesAllowing(model);
        expect(validateRunSpec(specWith(target, model), rules).ok).toBe(true);
      }
    }
  });

  test("is accepted in allowedModels and allowedModelsByRole entries", () => {
    for (const model of accepted) {
      const rules = testRules() as unknown as Record<string, unknown>;
      rules.allowedModels = [model];
      rules.allowedModelsByRole = { worker: [model] };
      expect(RunRulesSchema.safeParse(rules).success).toBe(true);
    }
  });

  test("every malformed suffix is RUN_SPEC_INVALID_FORMAT", () => {
    for (const model of refused) {
      for (const target of ["agent", "reviewer"] as const) {
        const codes = issuesOf(specWith(target, model)).map((i) => i.code);
        expect(codes, model).toEqual(["RUN_SPEC_INVALID_FORMAT"]);
      }
    }
  });

  test("every malformed suffix is refused in the rule lists", () => {
    for (const model of refused) {
      const rules = testRules() as unknown as Record<string, unknown>;
      rules.allowedModels = [model];
      expect(RunRulesSchema.safeParse(rules).success, model).toBe(false);
      const byRole = {
        ...testRules(),
        allowedModelsByRole: { worker: [model] },
      };
      expect(RunRulesSchema.safeParse(byRole).success, model).toBe(false);
    }
  });

  test("256 characters in all, suffix included", () => {
    const fits = `${"a".repeat(252)}[1m]`; // 256
    const tooLong = `${"a".repeat(253)}[1m]`; // 257
    expect(fits).toHaveLength(256);
    expect(
      validateRunSpec(specWith("agent", fits), rulesAllowing(fits)).ok,
    ).toBe(true);
    const codes = issuesOf(specWith("agent", tooLong)).map((i) => i.code);
    expect(codes).toEqual(["RUN_SPEC_STRING_TOO_LONG"]);
  });

  test("the JSON Schema carries the new pattern", () => {
    const text = JSON.stringify(runSpecJsonSchema);
    expect(text).toContain("(?:\\\\[[A-Za-z0-9]+\\\\])?$");
  });
});

describe("allowedModelsByRole", () => {
  function rulesByRole(
    byRole: Record<string, string[]>,
    models: string[] = ["claude-sonnet-5", "gpt-5.5"],
  ): RunRules {
    return {
      ...testRules(),
      allowedModels: models,
      allowedModelsByRole: byRole,
    } as RunRules;
  }

  test("a model allowed overall but not for the role is refused, naming the rule", () => {
    const issues = issuesOf(
      validSpec(),
      rulesByRole({ worker: ["claude-sonnet-5"] }),
    );
    // Lane 1's worker agent uses gpt-5.5; the reviewer has no entry.
    expect(issues.map((i) => i.code)).toEqual(["RUN_SPEC_MODEL_NOT_ALLOWED"]);
    expect(issues[0]?.path).toEqual(["lanes", 1, "agent", "model"]);
    expect(issues[0]?.message).toContain("allowedModelsByRole");
  });

  test("the plain allowedModels refusal does not name the role rule", () => {
    const rules = testRules();
    rules.allowedModels = ["claude-sonnet-5"];
    const issues = issuesOf(validSpec(), rules);
    expect(issues.length).toBeGreaterThan(0);
    expect(
      issues.every((i) => !i.message.includes("allowedModelsByRole")),
    ).toBe(true);
  });

  test("a role entry naming a model outside allowedModels is still refused", () => {
    const rules = rulesByRole(
      { worker: ["claude-sonnet-5", "gpt-5.5", "outside-model"] },
      ["claude-sonnet-5", "gpt-5.5"],
    );
    const spec = validSpec();
    const lane = spec.lanes[0];
    if (!lane) throw new Error("fixture changed");
    lane.agent.model = "outside-model";
    const issues = issuesOf(spec, rules);
    expect(issues.map((i) => i.code)).toEqual(["RUN_SPEC_MODEL_NOT_ALLOWED"]);
  });

  test("a role without an entry uses allowedModels", () => {
    const rules = rulesByRole({ critic: ["gpt-5.5"] });
    expect(validateRunSpec(validSpec(), rules).ok).toBe(true);
  });

  test("an agent reviewer is checked against the reviewer entry", () => {
    const rules = rulesByRole({ reviewer: ["claude-sonnet-5"] });
    const issues = issuesOf(validSpec(), rules);
    expect(issues.map((i) => i.code)).toEqual(["RUN_SPEC_MODEL_NOT_ALLOWED"]);
    expect(issues[0]?.path).toEqual(["lanes", 0, "steps", "review", "model"]);
    const ok = rulesByRole({ reviewer: ["gpt-5.5"] });
    expect(validateRunSpec(validSpec(), ok).ok).toBe(true);
  });

  test("an empty role entry allows no model for that role", () => {
    const issues = issuesOf(validSpec(), rulesByRole({ worker: [] }));
    expect(issues.length).toBe(2);
    expect(issues.every((i) => i.code === "RUN_SPEC_MODEL_NOT_ALLOWED")).toBe(
      true,
    );
  });

  test("an unknown or wrongly cased key is RUN_SPEC_RULES_INVALID", () => {
    for (const key of ["workers", "Reviewer", "__proto__x", ""]) {
      const rules = rulesByRole({ [key]: ["gpt-5.5"] });
      const codes = issuesOf(validSpec(), rules).map((i) => i.code);
      expect(codes, key).toEqual(["RUN_SPEC_RULES_INVALID"]);
    }
  });

  test("a rule set without the key is unchanged", () => {
    expect(RunRulesSchema.safeParse(testRules()).success).toBe(true);
    expect(validateRunSpec(validSpec(), testRules()).ok).toBe(true);
  });

  test("RUN_RULE_KEYS lists it and the override schema accepts it", () => {
    expect(RUN_RULE_KEYS).toContain("allowedModelsByRole");
    expect(
      RunRulesOverrideSchema.safeParse({
        id: "o",
        allowedModelsByRole: { worker: ["gpt-5.5"] },
      }).success,
    ).toBe(true);
  });

  describe("merge", () => {
    test("narrows each key of the base", () => {
      const base = rulesByRole({
        worker: ["claude-sonnet-5", "gpt-5.5"],
        reviewer: ["gpt-5.5"],
      });
      const merged = mergeRunRules(base, {
        id: "team",
        allowedModelsByRole: { worker: ["gpt-5.5"] },
      });
      expect(merged.allowedModelsByRole).toEqual({
        worker: ["gpt-5.5"],
        reviewer: ["gpt-5.5"],
      });
      expect(merged.origins?.allowedModelsByRole).toEqual(["test", "team"]);
    });

    test("a key the base lacks takes the override, intersected with allowedModels", () => {
      const base = testRules();
      const merged = mergeRunRules(base, {
        id: "team",
        allowedModelsByRole: { worker: ["gpt-5.5", "not-in-base"] },
      });
      expect(merged.allowedModelsByRole).toEqual({ worker: ["gpt-5.5"] });
      expect(merged.origins?.allowedModelsByRole).toEqual(["test", "team"]);
    });

    test("an override cannot widen a key", () => {
      const base = rulesByRole({ worker: ["gpt-5.5"] });
      const merged = mergeRunRules(base, {
        id: "team",
        allowedModelsByRole: { worker: ["gpt-5.5", "claude-sonnet-5"] },
      });
      expect(merged.allowedModelsByRole).toEqual({ worker: ["gpt-5.5"] });
      expect(merged.origins?.allowedModelsByRole).toEqual(["test"]);
    });

    test("narrowing allowedModels also narrows what a role may use", () => {
      const base = rulesByRole({ worker: ["claude-sonnet-5", "gpt-5.5"] });
      const merged = mergeRunRules(base, {
        id: "team",
        allowedModels: ["gpt-5.5"],
      });
      const issues = issuesOf(validSpec(), merged);
      expect(issues.map((i) => i.path)).toEqual([
        ["lanes", 0, "agent", "model"],
      ]);
    });

    test("a base without the key and an override without it stay without it", () => {
      const merged = mergeRunRules(testRules(), { id: "team" });
      expect("allowedModelsByRole" in merged).toBe(false);
    });
  });
});

describe("rules and specs stay frozen", () => {
  test("validation does not change the rules", () => {
    const rules = {
      ...testRules(),
      allowedModelsByRole: { worker: ["gpt-5.5"] },
    } as RunRules;
    const before = JSON.stringify(rules);
    validateRunSpec(validSpec() as RunSpec, rules);
    expect(JSON.stringify(rules)).toBe(before);
  });
});
