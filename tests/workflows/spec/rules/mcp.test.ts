import { describe, expect, test } from "bun:test";
import {
  RUN_SPEC_ISSUE_FAMILIES,
  type RunSpecIssue,
} from "../../../../src/workflows/spec/issues.js";
import {
  resolveRunPlan,
  runSpecHash,
} from "../../../../src/workflows/spec/plan.js";
import { checkModelRules } from "../../../../src/workflows/spec/rules/models.js";
import {
  mergeRunRules,
  RUN_RULE_KEYS,
  RUN_SPEC_LIMITS,
  type RunRules,
  RunRulesSchema,
  type RunSpec,
  RunSpecAgentSchema,
} from "../../../../src/workflows/spec/schema.js";
import { validateRunSpec } from "../../../../src/workflows/spec/validate.js";
import { testRules, validSpec } from "../helpers.js";

/** The test rules with MCP providers allowed. */
function mcpRules(allowed: string[] = ["github", "docs-search"]): RunRules {
  return { ...testRules(), allowedMcpProviders: allowed };
}

/** The valid spec with `mcp` set on the agent of lane `index`. */
function withMcp(mcp: unknown, index = 0): RunSpec {
  const spec = validSpec();
  const lane = spec.lanes[index];
  if (!lane) throw new Error("lane missing");
  (lane.agent as Record<string, unknown>).mcp = mcp;
  return spec;
}

function codes(result: { ok: boolean; errors?: RunSpecIssue[] }): string[] {
  return result.ok ? [] : (result.errors ?? []).map((issue) => issue.code);
}

function modelIssues(spec: RunSpec, rules: RunRules): RunSpecIssue[] {
  const issues: RunSpecIssue[] = [];
  checkModelRules(spec, rules, issues);
  return issues;
}

describe("allowedMcpProviders rule", () => {
  test("is a required key of RunRules", () => {
    expect(RUN_RULE_KEYS).toContain("allowedMcpProviders");
    const { allowedMcpProviders: _omitted, ...rest } = mcpRules();
    expect(RunRulesSchema.safeParse(rest).success).toBe(false);
    expect(codes(validateRunSpec(validSpec(), rest as RunRules))).toEqual([
      "RUN_SPEC_RULES_INVALID",
    ]);
  });

  test("an entry must match the provider id grammar", () => {
    for (const bad of [
      "https://evil.example",
      "a:b",
      "a/b",
      "a b",
      "a__b",
      "a_",
      "",
    ]) {
      expect(
        RunRulesSchema.safeParse({ ...testRules(), allowedMcpProviders: [bad] })
          .success,
      ).toBe(false);
    }
  });

  test("is bounded like every other rule list", () => {
    const many = Array.from(
      { length: RUN_SPEC_LIMITS.maxRuleListEntries + 1 },
      (_, index) => `p${index}`,
    );
    expect(
      RunRulesSchema.safeParse({ ...testRules(), allowedMcpProviders: many })
        .success,
    ).toBe(false);
  });

  test("merging keeps the intersection, in base order, and records the override", () => {
    const merged = mergeRunRules(mcpRules(["a", "b", "c"]), {
      id: "team",
      allowedMcpProviders: ["c", "a", "z"],
    });
    expect(merged.allowedMcpProviders).toEqual(["a", "c"]);
    expect(merged.origins?.allowedMcpProviders).toEqual(["test", "team"]);
  });

  test("an override can never add a provider the base does not allow", () => {
    const merged = mergeRunRules(mcpRules([]), {
      id: "wide",
      allowedMcpProviders: ["github"],
    });
    expect(merged.allowedMcpProviders).toEqual([]);
  });

  test("merging does not modify the inputs", () => {
    const base = mcpRules(["a", "b"]);
    const override = { id: "o", allowedMcpProviders: ["b"] };
    mergeRunRules(base, override);
    expect(base.allowedMcpProviders).toEqual(["a", "b"]);
    expect(override.allowedMcpProviders).toEqual(["b"]);
  });

  test("an override without the key leaves the list unchanged", () => {
    const merged = mergeRunRules(mcpRules(["a"]), { id: "o", maxLanes: 3 });
    expect(merged.allowedMcpProviders).toEqual(["a"]);
    expect(merged.origins?.allowedMcpProviders).toEqual(["test"]);
  });
});

describe("agent.mcp shape", () => {
  test("is optional: a spec without it is unchanged and valid", () => {
    expect(validateRunSpec(validSpec(), testRules()).ok).toBe(true);
  });

  test("accepts allowed provider ids", () => {
    const result = validateRunSpec(
      withMcp(["github", "docs-search"]),
      mcpRules(),
    );
    expect(result.ok).toBe(true);
  });

  test("an empty list is valid under the deny-by-default rule set", () => {
    expect(validateRunSpec(withMcp([]), testRules()).ok).toBe(true);
  });

  test.each([
    ["URL", "https://mcp.example.com/sse"],
    ["URL without scheme", "//mcp.example.com"],
    ["host and port", "localhost:8080"],
    ["colon", "a:b"],
    ["slash", "a/b"],
    ["backslash", "a\\b"],
    ["dot (host name)", "mcp.example.com"],
    ["space", "git hub"],
    ["leading space", " github"],
    ["trailing newline", "github\n"],
    ["tab", "git\thub"],
    ["NUL", "git\u0000hub"],
    ["zero-width space", "git​hub"],
    ["Cyrillic look-alike", "githuб"],
    ["Cyrillic a", "аpi"],
    ["fullwidth letters", "ｇithub"],
    ["fullwidth colon", "a：b"],
    ["fraction slash", "a⁄b"],
    ["double underscore (MCP tool namespace)", "a__b"],
    ["trailing underscore", "github_"],
    ["trailing dash", "github-"],
    ["leading dash", "-github"],
    ["leading underscore", "_github"],
    ["at sign (credential)", "user@host"],
    ["equals (token)", "TOKEN=abc"],
    ["header shape", "Authorization: Bearer x"],
    ["percent escape", "a%2Fb"],
    ["empty", ""],
  ])("rejects %s with RUN_SPEC_INVALID_FORMAT or a length code", (_, id) => {
    const result = validateRunSpec(withMcp([id]), mcpRules([]));
    expect(result.ok).toBe(false);
    const found = codes(result);
    expect(
      found.includes("RUN_SPEC_INVALID_FORMAT") ||
        found.includes("RUN_SPEC_STRING_TOO_SHORT"),
    ).toBe(true);
    // The value never reaches a rule family: shape fails alone.
    expect(
      found.every(
        (code) =>
          RUN_SPEC_ISSUE_FAMILIES[
            code as keyof typeof RUN_SPEC_ISSUE_FAMILIES
          ] === "shape",
      ),
    ).toBe(true);
  });

  test("an id longer than 64 characters is too long", () => {
    const result = validateRunSpec(withMcp(["a".repeat(65)]), mcpRules());
    expect(codes(result)).toContain("RUN_SPEC_STRING_TOO_LONG");
    expect(
      validateRunSpec(withMcp(["a".repeat(64)]), mcpRules(["a".repeat(64)])).ok,
    ).toBe(true);
  });

  test("an object entry (server config) is rejected", () => {
    const result = validateRunSpec(
      withMcp([{ url: "http://127.0.0.1:1/mcp", headers: { a: "b" } }]),
      mcpRules(),
    );
    expect(codes(result)).toContain("RUN_SPEC_INVALID_TYPE");
  });

  test("a map of servers instead of a list is rejected", () => {
    const result = validateRunSpec(
      withMcp({ github: { command: "/bin/sh" } }),
      mcpRules(),
    );
    expect(codes(result)).toContain("RUN_SPEC_INVALID_TYPE");
  });

  test("the per-agent limit is 16", () => {
    expect(RUN_SPEC_LIMITS.maxMcpProviders).toBe(16);
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
    expect(validateRunSpec(withMcp(ids(16)), mcpRules(ids(16))).ok).toBe(true);
    expect(
      codes(validateRunSpec(withMcp(ids(17)), mcpRules(ids(17)))),
    ).toContain("RUN_SPEC_ARRAY_TOO_LONG");
  });

  test(`more than ${RUN_SPEC_LIMITS.maxMcpProviders} entries is too long`, () => {
    const ids = Array.from(
      { length: RUN_SPEC_LIMITS.maxMcpProviders + 1 },
      (_, index) => `p${index}`,
    );
    const result = validateRunSpec(withMcp(ids), mcpRules(ids));
    expect(codes(result)).toContain("RUN_SPEC_ARRAY_TOO_LONG");
  });

  test("the schema keeps the agent closed: no server, url, header or token key", () => {
    for (const key of ["mcpServers", "url", "headers", "token", "command"]) {
      const spec = validSpec();
      (spec.lanes[0]?.agent as Record<string, unknown>)[key] = "x";
      expect(codes(validateRunSpec(spec, mcpRules()))).toContain(
        "RUN_SPEC_UNKNOWN_KEY",
      );
    }
    expect(RunSpecAgentSchema.shape.mcp).toBeDefined();
  });
});

describe("agent.mcp rules", () => {
  test("deny by default: an empty allowlist rejects every provider", () => {
    const result = validateRunSpec(withMcp(["github"]), testRules());
    expect(codes(result)).toEqual(["RUN_SPEC_MCP_PROVIDER_NOT_ALLOWED"]);
    if (!result.ok) {
      expect(result.errors[0]?.path).toEqual(["lanes", 0, "agent", "mcp", 0]);
    }
  });

  test("a provider outside the allowlist is reported at its index", () => {
    const issues = modelIssues(withMcp(["github", "slack"]), mcpRules());
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("RUN_SPEC_MCP_PROVIDER_NOT_ALLOWED");
    expect(issues[0]?.path).toEqual(["lanes", 0, "agent", "mcp", 1]);
  });

  test("comparison with the allowlist is exact, case included", () => {
    expect(codes(validateRunSpec(withMcp(["GitHub"]), mcpRules()))).toEqual([
      "RUN_SPEC_MCP_PROVIDER_NOT_ALLOWED",
    ]);
  });

  test("an allowlist entry that breaks the grammar never matches", () => {
    // The rule set is read through its schema first, so such an entry makes
    // the rule set invalid; the family itself also refuses it.
    const rules = { ...testRules(), allowedMcpProviders: ["a:b"] };
    expect(codes(validateRunSpec(withMcp(["a:b"]), rules))).toEqual([
      "RUN_SPEC_RULES_INVALID",
    ]);
    const issues = modelIssues(withMcp(["github"]), {
      ...testRules(),
      allowedMcpProviders: ["github\u0000"],
    });
    expect(issues.map((issue) => issue.code)).toEqual([
      "RUN_SPEC_MCP_PROVIDER_NOT_ALLOWED",
    ]);
  });

  test("the family re-checks the grammar: a listed id with a bad shape never matches", () => {
    // Bypasses both schemas, as a family that is reused elsewhere would.
    const spec = withMcp(["a:b"]);
    const issues = modelIssues(spec, {
      ...testRules(),
      allowedMcpProviders: ["a:b"],
    });
    expect(issues.map((issue) => issue.code)).toEqual([
      "RUN_SPEC_MCP_PROVIDER_NOT_ALLOWED",
    ]);
  });

  test("a family that reads a non-array allowlist denies everything", () => {
    const issues = modelIssues(withMcp(["github"]), {
      ...testRules(),
      allowedMcpProviders: "github" as unknown as string[],
    });
    expect(issues.map((issue) => issue.code)).toEqual([
      "RUN_SPEC_MCP_PROVIDER_NOT_ALLOWED",
    ]);
  });

  test("the same id twice is a duplicate", () => {
    const result = validateRunSpec(withMcp(["github", "github"]), mcpRules());
    expect(codes(result)).toEqual(["RUN_SPEC_MCP_PROVIDER_DUPLICATE"]);
    if (!result.ok) {
      expect(result.errors[0]?.path).toEqual(["lanes", 0, "agent", "mcp", 1]);
    }
  });

  test("ids that differ only in case are duplicates, like lane ids", () => {
    const result = validateRunSpec(
      withMcp(["github", "GITHUB"]),
      mcpRules(["github", "GITHUB"]),
    );
    expect(codes(result)).toEqual(["RUN_SPEC_MCP_PROVIDER_DUPLICATE"]);
  });

  test("each lane is checked on its own: two lanes may name the same provider", () => {
    const spec = withMcp(["github"], 0);
    (spec.lanes[1]?.agent as Record<string, unknown>).mcp = ["github"];
    expect(validateRunSpec(spec, mcpRules()).ok).toBe(true);
  });

  test("the message echoes the id but is bounded", () => {
    const issues = modelIssues(withMcp(["a".repeat(64)]), mcpRules());
    expect(issues[0]?.message.length).toBeLessThan(200);
  });

  test("the rule set cap on array length applies to mcp", () => {
    const rules = { ...mcpRules(["a", "b", "c"]), maxArrayLength: 2 };
    expect(codes(validateRunSpec(withMcp(["a", "b", "c"]), rules))).toContain(
      "RUN_SPEC_ARRAY_LIMIT_EXCEEDED",
    );
  });
});

describe("plan grant", () => {
  test("each agent of a lane lists the lane's MCP providers; a reviewer has none", () => {
    const result = resolveRunPlan(withMcp(["github"]), mcpRules());
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const api = result.plan.lanes.find((lane) => lane.taskId === "api");
    expect(api?.agents.map((agent) => [agent.purpose, agent.mcp])).toEqual([
      ["tests", ["github"]],
      ["implement", ["github"]],
      ["review", []],
    ]);
    const docs = result.plan.lanes.find((lane) => lane.taskId === "docs");
    expect(docs?.agents.map((agent) => agent.mcp)).toEqual([[]]);
  });

  test("the plan's list is a copy: changing it does not change the spec", () => {
    const spec = withMcp(["github"]);
    const result = resolveRunPlan(spec, mcpRules());
    if (!result.ok) throw new Error("invalid");
    result.plan.lanes[0]?.agents[0]?.mcp.push("x");
    expect(spec.lanes[0]?.agent.mcp).toEqual(["github"]);
  });

  test("the topology has the run-spec.mcp-providers invariant, enforced by the host", () => {
    for (const spec of [validSpec(), withMcp(["github"])]) {
      const result = resolveRunPlan(spec, mcpRules());
      if (!result.ok) throw new Error("invalid");
      const invariant = result.plan.topology.invariants.find(
        (entry) => entry.invariantId === "run-spec.mcp-providers",
      );
      expect(invariant?.enforcedBy).toBe("host");
      expect(invariant?.appliesTo).toBe("workflow");
    }
  });

  test("an invalid grant gives no plan", () => {
    const result = resolveRunPlan(withMcp(["github"]), testRules());
    expect(result.ok).toBe(false);
  });
});

describe("runSpecHash", () => {
  test("an empty mcp list and no mcp key hash the same", async () => {
    expect(await runSpecHash(withMcp([]))).toBe(await runSpecHash(validSpec()));
  });

  test("a granted provider changes the hash", async () => {
    expect(await runSpecHash(withMcp(["github"]))).not.toBe(
      await runSpecHash(validSpec()),
    );
  });
});

describe("every lane is checked", () => {
  test("a disallowed id and a case-only duplicate on a later lane are reported at their paths", () => {
    const spec = withMcp(["github"], 0);
    (spec.lanes[1]?.agent as Record<string, unknown>).mcp = [
      "github",
      "not-allowed",
      "GITHUB",
    ];
    const result = validateRunSpec(spec, mcpRules(["github"]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.errors.map((issue) => [issue.code, issue.path.join(".")]),
    ).toEqual([
      ["RUN_SPEC_MCP_PROVIDER_NOT_ALLOWED", "lanes.1.agent.mcp.1"],
      ["RUN_SPEC_MCP_PROVIDER_NOT_ALLOWED", "lanes.1.agent.mcp.2"],
      ["RUN_SPEC_MCP_PROVIDER_DUPLICATE", "lanes.1.agent.mcp.2"],
    ]);
  });

  test("the last lane of a wide spec is checked too", () => {
    const spec = validSpec();
    const lanes = spec.lanes;
    const last = lanes[lanes.length - 1];
    if (!last) throw new Error("lane missing");
    last.agent = { ...last.agent, mcp: ["slack"] };
    const result = validateRunSpec(spec, mcpRules(["github"]));
    expect(codes(result)).toEqual(["RUN_SPEC_MCP_PROVIDER_NOT_ALLOWED"]);
  });
});

describe("MCP tool names in agent.tools are tied to the grant", () => {
  /** The valid spec with tools and mcp set on lane `index`. */
  function withTools(tools: string[], mcp: string[], index = 0): RunSpec {
    const spec = withMcp(mcp, index);
    const lane = spec.lanes[index];
    if (!lane) throw new Error("lane missing");
    lane.agent.tools = tools;
    return spec;
  }
  function rules(tools: string[], mcp: string[] = ["github"]): RunRules {
    return {
      ...mcpRules(mcp),
      allowedTools: [...testRules().allowedTools, ...tools],
    };
  }

  test("an MCP tool of a granted provider is accepted when the host allows the tool", () => {
    const tool = "mcp__github__list_issues";
    expect(
      validateRunSpec(withTools([tool], ["github"]), rules([tool])).ok,
    ).toBe(true);
  });

  test("a tool part may contain __: the server ends at the first __ after the prefix", () => {
    const tool = "mcp__github__b__c";
    expect(
      validateRunSpec(withTools([tool], ["github"]), rules([tool])).ok,
    ).toBe(true);
    expect(
      codes(validateRunSpec(withTools([tool], ["b"]), rules([tool], ["b"]))),
    ).toEqual(["RUN_SPEC_MCP_TOOL_NOT_GRANTED"]);
  });

  test("a server-wide MCP rule of a granted provider is accepted", () => {
    expect(
      validateRunSpec(
        withTools(["mcp__github"], ["github"]),
        rules(["mcp__github"]),
      ).ok,
    ).toBe(true);
  });

  test.each([
    ["no grant at all", "mcp__github__list_issues", []],
    ["another provider", "mcp__slack__post", ["github"]],
    ["server-wide rule without grant", "mcp__slack", ["github"]],
    ["case variant of a granted provider", "mcp__GitHub__list", ["github"]],
    ["prefix in another case", "MCP__github__list", ["github"]],
    ["mixed-case prefix", "Mcp__github__list", ["github"]],
    ["empty tool part", "mcp__github__", ["github"]],
    ["empty server", "mcp____list", ["github"]],
    ["bare prefix", "mcp__", ["github"]],
    ["server is a prefix of a granted one", "mcp__git__x", ["github"]],
    ["granted id is a prefix of the server", "mcp__github2__x", ["github"]],
    ["resource listing without grant", "ListMcpResourcesTool", []],
    ["resource read without grant", "ReadMcpResourceTool", []],
    ["resource read in another case", "readmcpresourcetool", []],
  ])("refuses %s", (_, tool, mcp) => {
    const result = validateRunSpec(withTools([tool], mcp), rules([tool]));
    expect(codes(result)).toEqual(["RUN_SPEC_MCP_TOOL_NOT_GRANTED"]);
    if (!result.ok) {
      expect(result.errors[0]?.path).toEqual(["lanes", 0, "agent", "tools", 0]);
    }
  });

  test("the MCP resource tools are accepted when the agent has a grant", () => {
    const tools = ["ListMcpResourcesTool", "ReadMcpResourceTool"];
    expect(validateRunSpec(withTools(tools, ["github"]), rules(tools)).ok).toBe(
      true,
    );
  });

  test("an MCP tool on a later lane is checked against that lane's own grant", () => {
    const spec = withTools(["mcp__github__x"], ["github"], 0);
    const lane = spec.lanes[1];
    if (!lane) throw new Error("lane missing");
    lane.agent.tools = ["mcp__github__x"];
    const result = validateRunSpec(spec, rules(["mcp__github__x"]));
    expect(codes(result)).toEqual(["RUN_SPEC_MCP_TOOL_NOT_GRANTED"]);
    if (!result.ok) {
      expect(result.errors[0]?.path).toEqual(["lanes", 1, "agent", "tools", 0]);
    }
  });

  test("a tool the host does not allow is reported once for each rule it breaks", () => {
    const result = validateRunSpec(
      withTools(["mcp__slack__x"], []),
      testRules(),
    );
    expect(codes(result)).toEqual([
      "RUN_SPEC_TOOL_NOT_ALLOWED",
      "RUN_SPEC_MCP_TOOL_NOT_GRANTED",
    ]);
  });

  test("other tool names are unaffected", () => {
    expect(
      validateRunSpec(withTools(["Read", "Edit"], []), testRules()).ok,
    ).toBe(true);
  });
});
