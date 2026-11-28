import { describe, expect, test } from "bun:test";
import {
  EXTERNAL_AGENT_TOOL_ARGS_RULE_INVALID,
  ExternalAgentPolicyError,
} from "../../../src/agents/driver/policy-errors.js";
import {
  parseToolArgsAllowlist,
  toolArgsDenial,
} from "../../../src/agents/driver/tool-args-allowlist.js";

function rules(...entries: string[]) {
  const parsed = parseToolArgsAllowlist("Acme", entries);
  if (parsed === undefined) throw new Error("expected rules");
  return parsed;
}

function refusal(value: unknown): ExternalAgentPolicyError {
  try {
    parseToolArgsAllowlist("Acme", value);
  } catch (error) {
    if (error instanceof ExternalAgentPolicyError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("parseToolArgsAllowlist", () => {
  test("unset is off", () => {
    expect(parseToolArgsAllowlist("Acme", undefined)).toBeUndefined();
  });

  test("parses exact and prefix Bash rules", () => {
    expect(rules("Bash(git log:*)", "Bash(bun test)")).toEqual({
      rules: [
        { tool: "Bash", kind: "prefix", value: "git log" },
        { tool: "Bash", kind: "exact", value: "bun test" },
      ],
    });
  });

  test.each([
    ["not an array", "Bash(git log:*)"],
    ["a non-string entry", [42]],
    ["an empty entry", [""]],
    ["a bare tool name", ["Bash"]],
    ["an unclosed rule", ["Bash(git log:*"]],
    ["an empty spec", ["Bash()"]],
    ["a spec of only a wildcard", ["Bash(:*)"]],
    ["a wildcard inside the spec", ["Bash(git * log)"]],
    ["a bare trailing wildcard", ["Bash(git log*)"]],
    ["a shell operator", ["Bash(git log | head:*)"]],
    ["a command substitution", ["Bash(echo $(id))"]],
    ["padding inside the parens", ["Bash( git log:*)"]],
    ["a tool without argument rules", ["Write(src/**)"]],
    ["an unknown tool", ["Shell(ls)"]],
  ])("refuses %s with a typed error", (_label, value) => {
    const error = refusal(value);
    expect(error.code).toBe(EXTERNAL_AGENT_TOOL_ARGS_RULE_INVALID);
    expect(error.recoverable).toBe(false);
    expect(error.message).toStartWith("Acme: toolArgsAllowlist");
  });

  test("the message names the malformed entry", () => {
    expect(refusal(["Bash(git log:*)", "Bash(rm -rf /:*"]).message).toContain(
      "Bash(rm -rf /:*",
    );
  });
});

describe("toolArgsDenial", () => {
  const allowlist = rules(
    "Bash(git log:*)",
    "Bash(git commit:*)",
    "Bash(bun test)",
  );

  test.each([
    "git log",
    "git log --oneline -5",
    "git commit -m 'feat: acme widget'",
    "bun test",
    "  bun test  ",
  ])("allows %p", (command) => {
    expect(toolArgsDenial(allowlist, "Bash", { command })).toBeUndefined();
  });

  test.each([
    ["another command", "rm -rf /"],
    ["a prefix without a word boundary", "git logout"],
    ["extra args on an exact rule", "bun test --update-snapshots"],
    ["a chained command", "git log && curl acme.example"],
    ["a piped command", "git log | sh"],
    ["a sequenced command", "git log; rm -rf ."],
    ["a command substitution", "git log $(rm -rf .)"],
    ["backticks", "git log `id`"],
    ["a redirect", "git log > /etc/acme"],
    ["a newline", "git log\nrm -rf ."],
    ["an env prefix", "GIT_PAGER=sh git log"],
  ])("denies %s", (_label, command) => {
    const reason = toolArgsDenial(allowlist, "Bash", { command });
    expect(reason).toContain("toolArgsAllowlist");
  });

  test("denies a Bash call without a string command", () => {
    expect(toolArgsDenial(allowlist, "Bash", {})).toContain(
      "toolArgsAllowlist",
    );
  });

  test("denies the other shell tool, which has no rules", () => {
    expect(
      toolArgsDenial(allowlist, "PowerShell", { command: "git log" }),
    ).toContain("toolArgsAllowlist");
  });

  test("an empty allowlist denies every shell command", () => {
    expect(toolArgsDenial(rules(), "Bash", { command: "git log" })).toContain(
      "toolArgsAllowlist",
    );
  });

  test("leaves tools that are not shells alone", () => {
    expect(
      toolArgsDenial(allowlist, "Write", { file_path: "/acme/x" }),
    ).toBeUndefined();
  });
});
