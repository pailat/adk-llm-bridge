import { describe, expect, test } from "bun:test";
import type { RunSpecIssue } from "../../../../src/workflows/spec/issues.js";
import { checkModelRules } from "../../../../src/workflows/spec/rules/models.js";
import type {
  RunRules,
  RunSpec,
} from "../../../../src/workflows/spec/schema.js";
import { testRules, validSpec } from "../helpers.js";

function run(spec: RunSpec, rules: RunRules = testRules()): RunSpecIssue[] {
  const issues: RunSpecIssue[] = [];
  checkModelRules(spec, rules, issues);
  return issues;
}

function codes(issues: RunSpecIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

/** Applies a change to the agent of lane `index` and returns the spec. */
function withAgent(
  index: number,
  change: Partial<RunSpec["lanes"][number]["agent"]>,
): RunSpec {
  const spec = validSpec();
  const lane = spec.lanes[index];
  if (!lane) throw new Error("lane missing");
  lane.agent = { ...lane.agent, ...change };
  return spec;
}

/** Applies a change to the reviewer of the first lane and returns the spec. */
function withReviewer(change: {
  providerId?: string;
  model?: string;
}): RunSpec {
  const spec = validSpec();
  const lane = spec.lanes[0];
  if (lane?.steps.review.kind !== "agent") {
    throw new Error("reviewer missing");
  }
  lane.steps.review = { ...lane.steps.review, ...change };
  return spec;
}

describe("checkModelRules: valid input", () => {
  test("reports nothing for the valid spec under the test rules", () => {
    expect(run(validSpec())).toEqual([]);
  });

  test("appends to the issues array it is given and keeps earlier entries", () => {
    const issues: RunSpecIssue[] = [
      { code: "RUN_SPEC_BUDGET_EXCEEDED", path: ["budget"], message: "x" },
    ];
    checkModelRules(withAgent(0, { model: "nope" }), testRules(), issues);
    expect(issues[0]?.code).toBe("RUN_SPEC_BUDGET_EXCEEDED");
    expect(issues.length).toBe(2);
  });

  test("does not change the spec or the rules", () => {
    const spec = withAgent(0, { model: "nope", tools: ["Write", "Write"] });
    const rules = testRules();
    const specBefore = JSON.stringify(spec);
    const rulesBefore = JSON.stringify(rules);
    run(spec, rules);
    expect(JSON.stringify(spec)).toBe(specBefore);
    expect(JSON.stringify(rules)).toBe(rulesBefore);
  });

  test("returns only models-family codes", () => {
    const spec = withAgent(0, {
      providerId: "x",
      model: "x",
      mode: "ask",
      allowNetwork: true,
      tools: ["Write", "Write"],
    });
    spec.env = ["A", "A"];
    const found = codes(run(spec));
    expect(found.length).toBeGreaterThan(0);
    for (const code of found) {
      expect([
        "RUN_SPEC_PROVIDER_NOT_ALLOWED",
        "RUN_SPEC_MODEL_NOT_ALLOWED",
        "RUN_SPEC_PERMISSION_MODE_NOT_ALLOWED",
        "RUN_SPEC_NETWORK_NOT_ALLOWED",
        "RUN_SPEC_TOOL_NOT_ALLOWED",
        "RUN_SPEC_TOOL_DUPLICATE",
        "RUN_SPEC_ENV_NAME_NOT_ALLOWED",
        "RUN_SPEC_ENV_NAME_DUPLICATE",
      ]).toContain(code);
    }
  });
});

describe("checkModelRules: providers", () => {
  test("rejects an agent provider outside the allowlist", () => {
    const issues = run(withAgent(0, { providerId: "other" }));
    expect(codes(issues)).toEqual(["RUN_SPEC_PROVIDER_NOT_ALLOWED"]);
    expect(issues[0]?.path).toEqual(["lanes", 0, "agent", "providerId"]);
  });

  test("rejects a reviewer provider outside the allowlist", () => {
    const issues = run(withReviewer({ providerId: "other" }));
    expect(codes(issues)).toEqual(["RUN_SPEC_PROVIDER_NOT_ALLOWED"]);
    expect(issues[0]?.path).toEqual([
      "lanes",
      0,
      "steps",
      "review",
      "providerId",
    ]);
  });

  test("compares provider ids exactly, case included", () => {
    expect(codes(run(withAgent(0, { providerId: "Claude-Code" })))).toEqual([
      "RUN_SPEC_PROVIDER_NOT_ALLOWED",
    ]);
  });

  test("rejects every provider when the allowlist is empty", () => {
    const rules = { ...testRules(), allowedProviderIds: [] };
    expect(
      codes(run(validSpec(), rules)).filter(
        (code) => code === "RUN_SPEC_PROVIDER_NOT_ALLOWED",
      ).length,
    ).toBe(3);
  });
});

describe("checkModelRules: names listed in the rules", () => {
  for (const bad of ["../x", "gpt 5", "x\ny", ""]) {
    test(`a provider with bad grammar is rejected even when listed: ${JSON.stringify(bad)}`, () => {
      const rules = { ...testRules(), allowedProviderIds: [bad] };
      const issues = run(withAgent(0, { providerId: bad }), rules);
      expect(
        issues.some(
          (issue) =>
            issue.code === "RUN_SPEC_PROVIDER_NOT_ALLOWED" &&
            issue.path.join(".") === "lanes.0.agent.providerId",
        ),
      ).toBe(true);
    });

    test(`a model with bad grammar is rejected even when listed: ${JSON.stringify(bad)}`, () => {
      const rules = { ...testRules(), allowedModels: [bad] };
      const issues = run(withAgent(0, { model: bad }), rules);
      expect(
        issues.some(
          (issue) =>
            issue.code === "RUN_SPEC_MODEL_NOT_ALLOWED" &&
            issue.path.join(".") === "lanes.0.agent.model",
        ),
      ).toBe(true);
    });
  }
});

describe("checkModelRules: models", () => {
  test("rejects an agent model outside the allowlist, at the model path", () => {
    const issues = run(withAgent(1, { model: "gpt-9" }));
    expect(codes(issues)).toEqual(["RUN_SPEC_MODEL_NOT_ALLOWED"]);
    expect(issues[0]?.path).toEqual(["lanes", 1, "agent", "model"]);
  });

  test("rejects a reviewer model outside the allowlist, at the reviewer path", () => {
    const issues = run(withReviewer({ model: "gpt-9" }));
    expect(codes(issues)).toEqual(["RUN_SPEC_MODEL_NOT_ALLOWED"]);
    expect(issues[0]?.path).toEqual(["lanes", 0, "steps", "review", "model"]);
  });

  test("accepts a model that is on the list", () => {
    expect(run(withAgent(0, { model: "gpt-5.5" }))).toEqual([]);
  });

  test("rejects a model that differs only in case", () => {
    expect(codes(run(withAgent(0, { model: "GPT-5.5" })))).toEqual([
      "RUN_SPEC_MODEL_NOT_ALLOWED",
    ]);
    expect(codes(run(withReviewer({ model: "Gpt-5.5" })))).toEqual([
      "RUN_SPEC_MODEL_NOT_ALLOWED",
    ]);
  });

  const lookalikes: Array<[string, string]> = [
    ["trailing space", "gpt-5.5 "],
    ["leading space", " gpt-5.5"],
    ["trailing newline", "gpt-5.5\n"],
    ["trailing NUL", "gpt-5.5\u0000"],
    ["prefix match", "gpt-5"],
    ["suffix extension", "gpt-5.5-preview"],
    ["Cyrillic lookalike", "gpt-5.5".replace("p", "р")],
    ["full-width characters", "ｇｐｔ-5.5"],
    ["percent encoding", "gpt%2d5.5"],
    ["unicode escape text", "gpt\\u002d5.5"],
    ["path traversal", "../gpt-5.5"],
    ["trailing slash", "gpt-5.5/"],
    ["wildcard", "*"],
    ["empty string", ""],
    ["object prototype key", "__proto__"],
    ["constructor key", "constructor"],
    ["huge value", "m".repeat(100_000)],
  ];
  for (const [label, model] of lookalikes) {
    test(`rejects a model that is only a look-alike: ${label}`, () => {
      expect(codes(run(withAgent(0, { model })))).toContain(
        "RUN_SPEC_MODEL_NOT_ALLOWED",
      );
    });
  }

  test("a huge model value does not make the message large", () => {
    const issues = run(withAgent(0, { model: "m".repeat(100_000) }));
    for (const issue of issues) {
      expect(issue.message.length).toBeLessThan(5_000);
    }
  });

  test("an inherited object key is never treated as an allowed model", () => {
    const rules = { ...testRules(), allowedModels: [] };
    expect(codes(run(withAgent(0, { model: "toString" })))).toContain(
      "RUN_SPEC_MODEL_NOT_ALLOWED",
    );
    expect(codes(run(validSpec(), rules))).toContain(
      "RUN_SPEC_MODEL_NOT_ALLOWED",
    );
  });

  test("reports one issue per offending lane and reviewer", () => {
    const spec = validSpec();
    const lane0 = spec.lanes[0];
    const lane1 = spec.lanes[1];
    if (!lane0 || !lane1 || lane0.steps.review.kind !== "agent") {
      throw new Error("fixture changed");
    }
    lane0.agent.model = "a";
    lane0.steps.review.model = "b";
    lane1.agent.model = "c";
    const paths = run(spec)
      .filter((issue) => issue.code === "RUN_SPEC_MODEL_NOT_ALLOWED")
      .map((issue) => issue.path.join("."));
    expect(paths.sort()).toEqual([
      "lanes.0.agent.model",
      "lanes.0.steps.review.model",
      "lanes.1.agent.model",
    ]);
  });
});

describe("checkModelRules: permission modes", () => {
  test("rejects ask when the rules allow only read-only and workspace-write", () => {
    const issues = run(withAgent(0, { mode: "ask" }));
    expect(codes(issues)).toEqual(["RUN_SPEC_PERMISSION_MODE_NOT_ALLOWED"]);
    expect(issues[0]?.path).toEqual(["lanes", 0, "agent", "mode"]);
  });

  test("rejects full-access under the test rules", () => {
    expect(codes(run(withAgent(0, { mode: "full-access" })))).toEqual([
      "RUN_SPEC_PERMISSION_MODE_NOT_ALLOWED",
    ]);
  });

  test("rejects full-access even when a rule set lists it", () => {
    // A rule set that passed through a cast or an old version must not turn a
    // bypass mode on.
    const rules = {
      ...testRules(),
      allowedPermissionModes: [
        "read-only",
        "ask",
        "workspace-write",
        "full-access",
      ] as unknown as RunRules["allowedPermissionModes"],
    };
    expect(codes(run(withAgent(0, { mode: "full-access" }), rules))).toEqual([
      "RUN_SPEC_PERMISSION_MODE_NOT_ALLOWED",
    ]);
  });

  test("rejects every mode when the allowlist is empty", () => {
    const rules = { ...testRules(), allowedPermissionModes: [] };
    const found = codes(run(validSpec(), rules));
    expect(
      found.filter((code) => code === "RUN_SPEC_PERMISSION_MODE_NOT_ALLOWED"),
    ).toEqual([
      "RUN_SPEC_PERMISSION_MODE_NOT_ALLOWED",
      "RUN_SPEC_PERMISSION_MODE_NOT_ALLOWED",
    ]);
  });

  test("accepts each listed mode", () => {
    expect(run(withAgent(0, { mode: "read-only" }))).toEqual([]);
    expect(run(withAgent(0, { mode: "workspace-write" }))).toEqual([]);
  });

  const lookalikeModes = [
    "Workspace-Write",
    "WORKSPACE-WRITE",
    "workspace-write ",
    "workspace_write",
    "read-only\n",
    "",
    "bypassPermissions",
    "dangerously-skip-permissions",
    "full_access",
    "FULL-ACCESS",
  ];
  for (const mode of lookalikeModes) {
    test(`rejects an unknown mode value: ${JSON.stringify(mode)}`, () => {
      const spec = withAgent(0, {
        mode: mode as RunSpec["lanes"][number]["agent"]["mode"],
      });
      expect(codes(run(spec))).toContain(
        "RUN_SPEC_PERMISSION_MODE_NOT_ALLOWED",
      );
    });
  }

  test("an unknown mode is rejected even when the rules list the same text", () => {
    const rules = {
      ...testRules(),
      allowedPermissionModes: [
        "bypassPermissions",
      ] as unknown as RunRules["allowedPermissionModes"],
    };
    const spec = withAgent(0, {
      mode: "bypassPermissions" as RunSpec["lanes"][number]["agent"]["mode"],
    });
    const issues = run(spec, rules);
    expect(
      issues.some(
        (issue) =>
          issue.code === "RUN_SPEC_PERMISSION_MODE_NOT_ALLOWED" &&
          issue.path.join(".") === "lanes.0.agent.mode",
      ),
    ).toBe(true);
  });
});

describe("checkModelRules: network", () => {
  test("rejects allowNetwork true when the rules keep the network off", () => {
    const issues = run(withAgent(0, { allowNetwork: true }));
    expect(codes(issues)).toEqual(["RUN_SPEC_NETWORK_NOT_ALLOWED"]);
    expect(issues[0]?.path).toEqual(["lanes", 0, "agent", "allowNetwork"]);
  });

  test("accepts allowNetwork true when the rules allow it", () => {
    const rules = { ...testRules(), allowNetwork: true };
    expect(run(withAgent(0, { allowNetwork: true }), rules)).toEqual([]);
  });

  test("accepts allowNetwork false and an absent value when the rules keep the network off", () => {
    expect(run(withAgent(1, { allowNetwork: false }))).toEqual([]);
    expect(run(withAgent(0, { allowNetwork: undefined }))).toEqual([]);
  });

  test("reports each lane that asks for the network", () => {
    const spec = validSpec();
    for (const lane of spec.lanes) lane.agent.allowNetwork = true;
    const found = run(spec).filter(
      (issue) => issue.code === "RUN_SPEC_NETWORK_NOT_ALLOWED",
    );
    expect(found.map((issue) => issue.path[1])).toEqual([0, 1]);
  });

  test("treats a truthy non-boolean value as a request for the network", () => {
    const spec = withAgent(0, {
      allowNetwork: "true" as unknown as boolean,
    });
    expect(codes(run(spec))).toContain("RUN_SPEC_NETWORK_NOT_ALLOWED");
  });

  test("a non-boolean rules.allowNetwork does not open the network", () => {
    const rules = {
      ...testRules(),
      allowNetwork: "true" as unknown as boolean,
    };
    expect(codes(run(withAgent(0, { allowNetwork: true }), rules))).toContain(
      "RUN_SPEC_NETWORK_NOT_ALLOWED",
    );
  });
});

describe("checkModelRules: tools", () => {
  test("rejects a tool outside the allowlist at the entry path", () => {
    const issues = run(withAgent(0, { tools: ["Read", "Write"] }));
    expect(codes(issues)).toEqual(["RUN_SPEC_TOOL_NOT_ALLOWED"]);
    expect(issues[0]?.path).toEqual(["lanes", 0, "agent", "tools", 1]);
  });

  test("accepts every listed tool and an empty list", () => {
    expect(run(withAgent(0, { tools: ["Read", "Edit", "Bash"] }))).toEqual([]);
    expect(run(withAgent(0, { tools: [] }))).toEqual([]);
  });

  test("rejects a repeated tool at the path of the second entry", () => {
    const issues = run(withAgent(0, { tools: ["Read", "Edit", "Read"] }));
    expect(codes(issues)).toEqual(["RUN_SPEC_TOOL_DUPLICATE"]);
    expect(issues[0]?.path).toEqual(["lanes", 0, "agent", "tools", 2]);
  });

  test("reports a repeated tool that is also not allowed as both problems", () => {
    const found = codes(run(withAgent(0, { tools: ["Write", "Write"] })));
    expect(found).toContain("RUN_SPEC_TOOL_NOT_ALLOWED");
    expect(found).toContain("RUN_SPEC_TOOL_DUPLICATE");
  });

  test("the same tool in two different lanes is not a duplicate", () => {
    const spec = validSpec();
    for (const lane of spec.lanes) lane.agent.tools = ["Read"];
    expect(run(spec)).toEqual([]);
  });

  test("a third copy is reported once per extra entry", () => {
    const found = run(withAgent(0, { tools: ["Read", "Read", "Read"] }));
    expect(found.map((issue) => issue.path[4])).toEqual([1, 2]);
  });

  const toolLookalikes = [
    "read",
    "READ",
    "Read ",
    " Read",
    "Read\n",
    "Read\u0000",
    "Rеad",
    "Bash(rm -rf /)",
    "Bash:*",
    "*",
    "",
    "../Read",
    "mcp__server__tool",
    "__proto__",
    "constructor",
    "T".repeat(100_000),
  ];
  for (const tool of toolLookalikes) {
    test(`rejects a tool name that is not on the list: ${JSON.stringify(
      tool.length > 40 ? `${tool.slice(0, 10)}...` : tool,
    )}`, () => {
      expect(codes(run(withAgent(0, { tools: [tool] })))).toContain(
        "RUN_SPEC_TOOL_NOT_ALLOWED",
      );
    });
  }

  test("a case variant of a listed tool is not a duplicate of it", () => {
    const found = codes(run(withAgent(0, { tools: ["Read", "read"] })));
    expect(found).not.toContain("RUN_SPEC_TOOL_DUPLICATE");
    expect(found).toContain("RUN_SPEC_TOOL_NOT_ALLOWED");
  });

  test("an empty tool allowlist rejects every tool", () => {
    const rules = { ...testRules(), allowedTools: [] };
    expect(codes(run(validSpec(), rules))).toEqual([
      "RUN_SPEC_TOOL_NOT_ALLOWED",
      "RUN_SPEC_TOOL_NOT_ALLOWED",
    ]);
  });

  test("a huge tool list is checked in reasonable time", () => {
    const tools = Array.from({ length: 5_000 }, (_, i) => `t${i}`);
    const start = performance.now();
    const found = run(withAgent(0, { tools }));
    expect(performance.now() - start).toBeLessThan(5_000);
    expect(found.length).toBeGreaterThan(0);
  });
});

describe("checkModelRules: tool names listed in the rules", () => {
  test("a tool that is not a valid tool name is rejected even when the allowlist lists that exact text", () => {
    for (const bad of ["Bash(rm -rf /)", "Read Edit", "../Read", "Read\n"]) {
      const rules = { ...testRules(), allowedTools: [bad] };
      const found = run(withAgent(0, { tools: [bad] }), rules);
      expect(codes(found)).toContain("RUN_SPEC_TOOL_NOT_ALLOWED");
    }
  });
});

describe("checkModelRules: environment names", () => {
  test("a case variant of an env name is not a duplicate of it", () => {
    const rules = { ...testRules(), allowedEnvNames: ["CI", "ci"] };
    const spec = validSpec();
    spec.env = ["CI", "ci"];
    expect(codes(run(spec, rules))).not.toContain(
      "RUN_SPEC_ENV_NAME_DUPLICATE",
    );
  });

  function withEnv(env: string[]): RunSpec {
    const spec = validSpec();
    spec.env = env;
    return spec;
  }

  test("rejects a name outside the allowlist at the entry path", () => {
    const issues = run(withEnv(["CI", "AWS_SECRET_ACCESS_KEY"]));
    expect(codes(issues)).toEqual(["RUN_SPEC_ENV_NAME_NOT_ALLOWED"]);
    expect(issues[0]?.path).toEqual(["env", 1]);
  });

  test("accepts listed names and an empty list", () => {
    expect(run(withEnv(["CI", "NODE_ENV"]))).toEqual([]);
    expect(run(withEnv([]))).toEqual([]);
  });

  test("rejects a repeated name at the path of the second entry", () => {
    const issues = run(withEnv(["CI", "NODE_ENV", "CI"]));
    expect(codes(issues)).toEqual(["RUN_SPEC_ENV_NAME_DUPLICATE"]);
    expect(issues[0]?.path).toEqual(["env", 2]);
  });

  test("a repeated name that is not allowed reports both problems", () => {
    const found = codes(run(withEnv(["TOKEN", "TOKEN"])));
    expect(found).toContain("RUN_SPEC_ENV_NAME_NOT_ALLOWED");
    expect(found).toContain("RUN_SPEC_ENV_NAME_DUPLICATE");
  });

  test("an empty allowlist rejects every name", () => {
    const rules = { ...testRules(), allowedEnvNames: [] };
    expect(codes(run(withEnv(["CI"]), rules))).toEqual([
      "RUN_SPEC_ENV_NAME_NOT_ALLOWED",
    ]);
  });

  const notNames = [
    "CI=1",
    "CI=",
    "TOKEN=abc",
    "NODE_ENV=production",
    "ci",
    "Ci",
    "CI ",
    " CI",
    "CI\n",
    "CI\u0000",
    "CІ",
    "ＣＩ",
    "$CI",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal shell expansion is the input under test
    "${CI}",
    "CI;rm -rf /",
    "PATH",
    "LD_PRELOAD",
    "",
    "__proto__",
    "A".repeat(100_000),
  ];
  for (const name of notNames) {
    test(`rejects an entry that is not an allowed name: ${JSON.stringify(
      name.length > 40 ? `${name.slice(0, 10)}...` : name,
    )}`, () => {
      expect(codes(run(withEnv([name])))).toContain(
        "RUN_SPEC_ENV_NAME_NOT_ALLOWED",
      );
    });
  }

  test("an entry of the form NAME=value is rejected even when NAME is listed", () => {
    const issues = run(withEnv(["NODE_ENV=production"]));
    expect(codes(issues)).toContain("RUN_SPEC_ENV_NAME_NOT_ALLOWED");
  });

  test("an entry of the form NAME=value is rejected even when the allowlist lists that exact text", () => {
    const rules = { ...testRules(), allowedEnvNames: ["TOKEN=abc"] };
    expect(codes(run(withEnv(["TOKEN=abc"]), rules))).toContain(
      "RUN_SPEC_ENV_NAME_NOT_ALLOWED",
    );
  });

  test("a secret-looking value is never copied into a message", () => {
    const secrets = [
      "API_KEY=sk-ant-super-secret-value",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "AKIAABCDEFGHIJKLMNOP",
    ];
    for (const secret of secrets) {
      for (const issue of run(withEnv([secret]))) {
        expect(issue.message).not.toContain(secret);
        expect(issue.message).not.toContain("super-secret");
        expect(JSON.stringify(issue.path)).not.toContain(secret);
      }
    }
  });

  test("a huge entry does not make the message large", () => {
    for (const issue of run(withEnv(["A".repeat(100_000)]))) {
      expect(issue.message.length).toBeLessThan(5_000);
    }
  });

  test("a huge env list is checked in reasonable time", () => {
    const env = Array.from({ length: 5_000 }, (_, i) => `N${i}`);
    const start = performance.now();
    const found = run(withEnv(env));
    expect(performance.now() - start).toBeLessThan(5_000);
    expect(found.length).toBeGreaterThan(0);
  });
});

describe("checkModelRules: several violations", () => {
  test("reports every family of violation in one pass", () => {
    const spec = withAgent(0, {
      providerId: "x",
      model: "y",
      mode: "full-access",
      allowNetwork: true,
      tools: ["Write", "Write"],
    });
    spec.env = ["Z", "Z"];
    const found = new Set(codes(run(spec)));
    for (const code of [
      "RUN_SPEC_PROVIDER_NOT_ALLOWED",
      "RUN_SPEC_MODEL_NOT_ALLOWED",
      "RUN_SPEC_PERMISSION_MODE_NOT_ALLOWED",
      "RUN_SPEC_NETWORK_NOT_ALLOWED",
      "RUN_SPEC_TOOL_NOT_ALLOWED",
      "RUN_SPEC_TOOL_DUPLICATE",
      "RUN_SPEC_ENV_NAME_NOT_ALLOWED",
      "RUN_SPEC_ENV_NAME_DUPLICATE",
    ]) {
      expect(found.has(code)).toBe(true);
    }
  });

  test("a spec with no reviewer lanes is checked without error", () => {
    const spec = validSpec();
    for (const lane of spec.lanes) lane.steps.review = { kind: "none" };
    expect(run(spec)).toEqual([]);
  });

  test("a spec with no lanes only checks the env names", () => {
    const spec = validSpec();
    spec.lanes = [];
    spec.env = ["NOPE"];
    expect(codes(run(spec))).toEqual(["RUN_SPEC_ENV_NAME_NOT_ALLOWED"]);
  });
});
