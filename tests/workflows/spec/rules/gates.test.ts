import { describe, expect, test } from "bun:test";
import type { RunSpecIssue } from "../../../../src/workflows/spec/issues.js";
import { checkGateRules } from "../../../../src/workflows/spec/rules/gates.js";
import type {
  RunRules,
  RunSpec,
} from "../../../../src/workflows/spec/schema.js";
import { testRules, validSpec } from "../helpers.js";

type Qa = RunSpec["gates"]["qa"];
type Publish = RunSpec["gates"]["publish"];

function run(spec: RunSpec, rules: RunRules): RunSpecIssue[] {
  const issues: RunSpecIssue[] = [];
  checkGateRules(spec, rules, issues);
  return issues;
}

function codes(issues: RunSpecIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

function withGates(qa: Qa, publish: Publish): RunSpec {
  const spec = validSpec();
  return { ...spec, gates: { qa, publish } };
}

function withCommand(command: string[]): RunSpec {
  return withGates([{ id: "test", command }], { kind: "commit", hitl: true });
}

const commit: Publish = { kind: "commit", hitl: true };

describe("checkGateRules: valid specs", () => {
  test("reports nothing for the valid spec under the test rules", () => {
    expect(run(validSpec(), testRules())).toEqual([]);
  });

  test("reports nothing for a spec that publishes nothing and has no QA", () => {
    expect(run(withGates([], { kind: "none" }), testRules())).toEqual([]);
  });

  test("keeps issues that are already in the list and appends to it", () => {
    const existing: RunSpecIssue = {
      code: "RUN_SPEC_INVALID_VALUE",
      path: ["x"],
      message: "earlier",
    };
    const issues = [existing];
    checkGateRules(withCommand(["rm", "-rf", "/"]), testRules(), issues);
    expect(issues[0]).toBe(existing);
    expect(codes(issues)).toContain("RUN_SPEC_QA_COMMAND_NOT_ALLOWED");
  });

  test("does not change the spec or the rules", () => {
    const spec = withCommand(["rm"]);
    const rules = testRules();
    const specBefore = structuredClone(spec);
    const rulesBefore = structuredClone(rules);
    run(spec, rules);
    expect(spec).toEqual(specBefore);
    expect(rules).toEqual(rulesBefore);
  });
});

describe("RUN_SPEC_QA_ID_DUPLICATE", () => {
  const dup: Qa = [
    { id: "test", command: ["bun", "run", "test"] },
    { id: "test", command: ["bun", "run", "lint"] },
  ];

  test("reports two QA commands with the same id", () => {
    const issues = run(withGates(dup, commit), testRules());
    const found = issues.filter((i) => i.code === "RUN_SPEC_QA_ID_DUPLICATE");
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found[0]?.path.slice(0, 2)).toEqual(["gates", "qa"]);
    expect(found[0]?.path[2]).toBe(1);
  });

  test("does not report distinct ids with the same command", () => {
    const same: Qa = [
      { id: "a", command: ["bun", "run", "test"] },
      { id: "b", command: ["bun", "run", "test"] },
    ];
    expect(codes(run(withGates(same, commit), testRules()))).not.toContain(
      "RUN_SPEC_QA_ID_DUPLICATE",
    );
  });

  test("reports a duplicate that is not adjacent", () => {
    const qa: Qa = [
      { id: "a", command: ["bun", "run", "test"] },
      { id: "b", command: ["bun", "run", "lint"] },
      { id: "a", command: ["bun", "run", "lint"] },
    ];
    const found = run(withGates(qa, commit), testRules()).filter(
      (i) => i.code === "RUN_SPEC_QA_ID_DUPLICATE",
    );
    expect(found.map((i) => i.path[2])).toEqual([2]);
  });

  test("treats ids that differ only in case as distinct, as the grammar does", () => {
    const qa: Qa = [
      { id: "Test", command: ["bun", "run", "test"] },
      { id: "test", command: ["bun", "run", "lint"] },
    ];
    expect(codes(run(withGates(qa, commit), testRules()))).toEqual([]);
  });

  test("handles thousands of duplicate ids quickly", () => {
    const qa: Qa = Array.from({ length: 5_000 }, () => ({
      id: "same",
      command: ["bun", "run", "test"],
    }));
    const start = performance.now();
    const issues = run(withGates(qa, commit), testRules());
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(codes(issues)).toContain("RUN_SPEC_QA_ID_DUPLICATE");
  });
});

describe("RUN_SPEC_QA_COMMAND_NOT_ALLOWED", () => {
  const notAllowed = (command: string[], rules = testRules()) =>
    run(withCommand(command), rules)
      .filter((i) => i.code === "RUN_SPEC_QA_COMMAND_NOT_ALLOWED")
      .map((i) => i.path);

  test("accepts a command equal to an allowlist entry", () => {
    expect(notAllowed(["bun", "run", "lint"])).toEqual([]);
  });

  test("reports a different executable, pointing at the command", () => {
    expect(notAllowed(["npm", "run", "test"])).toEqual([
      ["gates", "qa", 0, "command"],
    ]);
  });

  test("reports an extra argument", () => {
    expect(notAllowed(["bun", "run", "test", "--force"])).toHaveLength(1);
  });

  test("reports a missing argument and a bare prefix", () => {
    expect(notAllowed(["bun", "run"])).toHaveLength(1);
    expect(notAllowed(["bun"])).toHaveLength(1);
  });

  test("reports reordered arguments", () => {
    expect(notAllowed(["run", "bun", "test"])).toHaveLength(1);
  });

  test("reports an empty command", () => {
    expect(notAllowed([])).toHaveLength(1);
  });

  test("reports a case variant of an allowed command", () => {
    expect(notAllowed(["BUN", "run", "test"])).toHaveLength(1);
    expect(notAllowed(["bun", "Run", "test"])).toHaveLength(1);
  });

  test("reports surrounding or trailing whitespace", () => {
    expect(notAllowed(["bun ", "run", "test"])).toHaveLength(1);
    expect(notAllowed([" bun", "run", "test"])).toHaveLength(1);
    expect(notAllowed(["bun", "run", "test\n"])).toHaveLength(1);
    expect(notAllowed(["bun", "run", "test\0"])).toHaveLength(1);
  });

  test("reports a command joined into one shell-style string", () => {
    expect(notAllowed(["bun run test"])).toHaveLength(1);
    expect(notAllowed(["bun", "run test"])).toHaveLength(1);
    expect(notAllowed(["bun run", "test"])).toHaveLength(1);
  });

  test("reports shell metacharacters appended to an argument", () => {
    for (const tail of [";rm -rf /", " && curl x", "$(id)", "`id`", "|sh"]) {
      expect(notAllowed(["bun", "run", `test${tail}`])).toHaveLength(1);
    }
  });

  test("reports a path-qualified or traversing executable", () => {
    expect(notAllowed(["./bun", "run", "test"])).toHaveLength(1);
    expect(notAllowed(["/usr/bin/bun", "run", "test"])).toHaveLength(1);
    expect(notAllowed(["../bun", "run", "test"])).toHaveLength(1);
    expect(notAllowed(["bun/../bun", "run", "test"])).toHaveLength(1);
  });

  test("reports look-alike Unicode and encoded spellings", () => {
    expect(notAllowed(["bun", "run", "tеst"])).toHaveLength(1); // Cyrillic e
    expect(notAllowed(["bun", "run", "ｔest"])).toHaveLength(1); // fullwidth t
    expect(notAllowed(["bun", "run", "te​st"])).toHaveLength(1);
    expect(notAllowed(["bun", "run", "%74est"])).toHaveLength(1);
    expect(notAllowed(["bun", "run", "tést"])).toHaveLength(1);
  });

  test("compares without Unicode normalization on the allowlist side", () => {
    const rules = testRules();
    rules.allowedQaCommands = [["bun", "run", "café"]];
    expect(notAllowed(["bun", "run", "café"], rules)).toEqual([]);
    expect(notAllowed(["bun", "run", "café"], rules)).toHaveLength(1);
  });

  test("does not confuse argument boundaries with separators in values", () => {
    const rules = testRules();
    rules.allowedQaCommands = [["a", "b,c"]];
    expect(notAllowed(["a", "b,c"], rules)).toEqual([]);
    expect(notAllowed(["a,b", "c"], rules)).toHaveLength(1);
    expect(notAllowed(['a","b', "c"], rules)).toHaveLength(1);
    expect(notAllowed(["a b", "c"], rules)).toHaveLength(1);
  });

  test("reports every command when the allowlist is empty", () => {
    const rules = testRules();
    rules.allowedQaCommands = [];
    expect(notAllowed(["bun", "run", "test"], rules)).toHaveLength(1);
  });

  test("reports an empty-string argument", () => {
    expect(notAllowed(["bun", "run", ""])).toHaveLength(1);
    expect(notAllowed(["", "run", "test"])).toHaveLength(1);
  });

  test("reports a huge command and a huge argument without throwing", () => {
    expect(notAllowed(Array.from({ length: 100_000 }, () => "x"))).toHaveLength(
      1,
    );
    expect(notAllowed(["bun", "run", "x".repeat(1_000_000)])).toHaveLength(1);
  });

  test("reports only the offending command among several", () => {
    const qa: Qa = [
      { id: "a", command: ["bun", "run", "test"] },
      { id: "b", command: ["bun", "run", "evil"] },
      { id: "c", command: ["bun", "run", "lint"] },
      { id: "d", command: ["sh"] },
    ];
    const found = run(withGates(qa, commit), testRules())
      .filter((i) => i.code === "RUN_SPEC_QA_COMMAND_NOT_ALLOWED")
      .map((i) => i.path[2]);
    expect(found).toEqual([1, 3]);
  });

  test("does not let a __proto__ or constructor argument match", () => {
    expect(notAllowed(["__proto__"])).toHaveLength(1);
    expect(notAllowed(["constructor"])).toHaveLength(1);
    expect(notAllowed(["toString"])).toHaveLength(1);
  });

  test("checks commands even when the spec publishes nothing", () => {
    const spec = withGates([{ id: "x", command: ["curl", "evil"] }], {
      kind: "none",
    });
    expect(codes(run(spec, testRules()))).toEqual([
      "RUN_SPEC_QA_COMMAND_NOT_ALLOWED",
    ]);
  });
});

describe("RUN_SPEC_QA_REQUIRED", () => {
  test("reports a commit with no QA when the rules require it", () => {
    expect(codes(run(withGates([], commit), testRules()))).toEqual([
      "RUN_SPEC_QA_REQUIRED",
    ]);
  });

  test("reports a merge with no QA when the rules require it", () => {
    const rules = testRules();
    rules.allowedPublishKinds = ["none", "commit", "integration"];
    const spec = withGates([], {
      kind: "integration",
      hitl: true,
      targetRef: "refs/heads/main",
    });
    expect(codes(run(spec, rules))).toEqual(["RUN_SPEC_QA_REQUIRED"]);
  });

  test("points at the QA list", () => {
    const found = run(withGates([], commit), testRules());
    expect(found[0]?.path.slice(0, 2)).toEqual(["gates", "qa"]);
  });

  test("accepts no QA when the rules do not require it", () => {
    const rules = testRules();
    rules.requireQa = false;
    expect(run(withGates([], commit), rules)).toEqual([]);
  });

  test("accepts no QA when nothing is published", () => {
    expect(run(withGates([], { kind: "none" }), testRules())).toEqual([]);
  });

  test("does not count a disallowed QA command as satisfying the requirement", () => {
    const found = codes(run(withCommand(["evil"]), testRules()));
    expect(found).toContain("RUN_SPEC_QA_COMMAND_NOT_ALLOWED");
    expect(found).not.toContain("RUN_SPEC_QA_REQUIRED");
  });
});

describe("RUN_SPEC_PUBLISH_KIND_NOT_ALLOWED", () => {
  test("reports a merge when the rules allow only none and commit", () => {
    const spec = withGates([{ id: "test", command: ["bun", "run", "test"] }], {
      kind: "integration",
      hitl: true,
      targetRef: "refs/heads/main",
    });
    const found = run(spec, testRules()).filter(
      (i) => i.code === "RUN_SPEC_PUBLISH_KIND_NOT_ALLOWED",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.path.slice(0, 3)).toEqual(["gates", "publish", "kind"]);
  });

  test("reports a commit when the rules allow only none", () => {
    const rules = testRules();
    rules.allowedPublishKinds = ["none"];
    expect(codes(run(validSpec(), rules))).toContain(
      "RUN_SPEC_PUBLISH_KIND_NOT_ALLOWED",
    );
  });

  test("reports every kind, including none, when the allowlist is empty", () => {
    const rules = testRules();
    rules.allowedPublishKinds = [];
    expect(codes(run(withGates([], { kind: "none" }), rules))).toEqual([
      "RUN_SPEC_PUBLISH_KIND_NOT_ALLOWED",
    ]);
  });

  test("accepts a merge when the rules allow it", () => {
    const rules = testRules();
    rules.allowedPublishKinds = ["integration"];
    const spec = withGates([{ id: "test", command: ["bun", "run", "test"] }], {
      kind: "integration",
      hitl: true,
      targetRef: "refs/heads/main",
    });
    expect(run(spec, rules)).toEqual([]);
  });

  test("does not accept a kind spelled in another case", () => {
    const spec = withGates([{ id: "t", command: ["bun", "run", "test"] }], {
      kind: "Commit",
      hitl: true,
    } as unknown as Publish);
    expect(codes(run(spec, testRules()))).toContain(
      "RUN_SPEC_PUBLISH_KIND_NOT_ALLOWED",
    );
  });

  test("does not accept the word merge, which is spelled integration", () => {
    const rules = testRules();
    rules.allowedPublishKinds = ["none", "commit", "integration"];
    const spec = withGates([{ id: "t", command: ["bun", "run", "test"] }], {
      kind: "merge",
      hitl: true,
    } as unknown as Publish);
    expect(codes(run(spec, rules))).toContain(
      "RUN_SPEC_PUBLISH_KIND_NOT_ALLOWED",
    );
  });

  test("does not accept an inherited property name as a kind", () => {
    const spec = withGates([], {
      kind: "toString",
    } as unknown as Publish);
    expect(codes(run(spec, testRules()))).toContain(
      "RUN_SPEC_PUBLISH_KIND_NOT_ALLOWED",
    );
  });
});

describe("RUN_SPEC_HITL_REQUIRED", () => {
  const qa: Qa = [{ id: "test", command: ["bun", "run", "test"] }];
  const hitlIssues = (spec: RunSpec, rules = testRules()) =>
    run(spec, rules).filter((i) => i.code === "RUN_SPEC_HITL_REQUIRED");

  test("reports a commit without human approval, at gates.publish.hitl", () => {
    const found = hitlIssues(withGates(qa, { kind: "commit", hitl: false }));
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toEqual(["gates", "publish", "hitl"]);
  });

  test("reports a merge without human approval", () => {
    const rules = testRules();
    rules.allowedPublishKinds = ["none", "commit", "integration"];
    const found = hitlIssues(
      withGates(qa, {
        kind: "integration",
        hitl: false,
        targetRef: "refs/heads/main",
      }),
      rules,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toEqual(["gates", "publish", "hitl"]);
  });

  test("accepts a commit and a merge with human approval", () => {
    const rules = testRules();
    rules.allowedPublishKinds = ["none", "commit", "integration"];
    expect(hitlIssues(withGates(qa, commit), rules)).toEqual([]);
    expect(
      hitlIssues(
        withGates(qa, {
          kind: "integration",
          hitl: true,
          targetRef: "refs/heads/main",
        }),
        rules,
      ),
    ).toEqual([]);
  });

  test("does not ask for approval when nothing is published", () => {
    expect(hitlIssues(withGates([], { kind: "none" }))).toEqual([]);
  });

  test("rejects values that are not the boolean true", () => {
    const values: unknown[] = [
      undefined,
      null,
      "true",
      "TRUE",
      1,
      "1",
      [true],
      {},
      0,
      "",
      Number.NaN,
    ];
    for (const hitl of values) {
      const publish = { kind: "commit", hitl } as unknown as Publish;
      expect(hitlIssues(withGates(qa, publish))).toHaveLength(1);
    }
  });

  test("rejects a commit whose hitl key is missing", () => {
    const publish = { kind: "commit" } as unknown as Publish;
    expect(hitlIssues(withGates(qa, publish))).toHaveLength(1);
  });

  test("is reported even when the rules allow every kind and drop QA", () => {
    const rules = testRules();
    rules.requireQa = false;
    rules.allowedPublishKinds = ["none", "commit", "integration"];
    expect(
      hitlIssues(withGates([], { kind: "commit", hitl: false }), rules),
    ).toHaveLength(1);
  });

  test("is reported together with a disallowed kind", () => {
    const found = codes(
      run(
        withGates(qa, {
          kind: "integration",
          hitl: false,
          targetRef: "refs/heads/main",
        }),
        testRules(),
      ),
    );
    expect(found).toContain("RUN_SPEC_HITL_REQUIRED");
    expect(found).toContain("RUN_SPEC_PUBLISH_KIND_NOT_ALLOWED");
  });
});

describe("one call reports every gates rule that is broken", () => {
  test("reports all five codes together", () => {
    const rules = testRules();
    rules.allowedPublishKinds = ["none"];
    const spec = withGates(
      [
        { id: "x", command: ["evil"] },
        { id: "x", command: ["bun", "run", "test"] },
      ],
      { kind: "commit", hitl: false },
    );
    const found = new Set(codes(run(spec, rules)));
    expect(found).toEqual(
      new Set([
        "RUN_SPEC_QA_ID_DUPLICATE",
        "RUN_SPEC_QA_COMMAND_NOT_ALLOWED",
        "RUN_SPEC_PUBLISH_KIND_NOT_ALLOWED",
        "RUN_SPEC_HITL_REQUIRED",
      ]),
    );
    const none = withGates([], { kind: "commit", hitl: true });
    expect(codes(run(none, rules))).toContain("RUN_SPEC_QA_REQUIRED");
  });

  test("reports only gates-family codes", () => {
    const rules = testRules();
    rules.allowedPublishKinds = [];
    const spec = withGates([{ id: "x", command: ["evil"] }], {
      kind: "commit",
      hitl: false,
    });
    const allowed = new Set([
      "RUN_SPEC_QA_ID_DUPLICATE",
      "RUN_SPEC_QA_COMMAND_NOT_ALLOWED",
      "RUN_SPEC_QA_REQUIRED",
      "RUN_SPEC_PUBLISH_KIND_NOT_ALLOWED",
      "RUN_SPEC_HITL_REQUIRED",
    ]);
    for (const issue of run(spec, rules)) {
      expect(allowed.has(issue.code)).toBe(true);
    }
  });
});

describe("RUN_SPEC_TARGET_REF_NOT_ALLOWED", () => {
  function integration(targetRef: string): RunSpec {
    return withGates([{ id: "test", command: ["bun", "run", "test"] }], {
      kind: "integration",
      targetRef,
      hitl: true,
    });
  }
  function rules(allowedTargetRefs: string[]): RunRules {
    const result = testRules();
    result.allowedPublishKinds = ["none", "commit", "integration"];
    result.allowedTargetRefs = allowedTargetRefs;
    return result;
  }

  test("accepts a merge into a listed ref", () => {
    expect(
      run(integration("refs/heads/main"), rules(["refs/heads/main"])),
    ).toEqual([]);
  });

  test("is reported at targetRef for a ref that is not listed", () => {
    const issues = run(
      integration("refs/heads/release"),
      rules(["refs/heads/main"]),
    );
    expect(codes(issues)).toEqual(["RUN_SPEC_TARGET_REF_NOT_ALLOWED"]);
    expect(issues[0]?.path).toEqual(["gates", "publish", "targetRef"]);
  });

  test("compares exactly, case included", () => {
    expect(
      codes(run(integration("refs/heads/Main"), rules(["refs/heads/main"]))),
    ).toEqual(["RUN_SPEC_TARGET_REF_NOT_ALLOWED"]);
  });

  test("denies every merge when the list is empty", () => {
    expect(codes(run(integration("refs/heads/main"), rules([])))).toEqual([
      "RUN_SPEC_TARGET_REF_NOT_ALLOWED",
    ]);
  });

  test("does not apply to a spec that commits or publishes nothing", () => {
    expect(run(withGates([], { kind: "none" }), rules([]))).toEqual([]);
    expect(run(withCommand(["bun", "run", "test"]), rules([]))).toEqual([]);
  });
});
