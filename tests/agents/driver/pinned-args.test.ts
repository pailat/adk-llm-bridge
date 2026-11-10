/**
 * The CLI drivers append the configured extra `args` after the flags they set
 * from the permission policy and isolation. An entry that would override one
 * of those flags is refused when the driver is built, unless the driver opts
 * in with `allowPolicyOverrideArgs`.
 */

import { describe, expect, test } from "bun:test";
import { InputValidationError } from "@google/adk";
import { ClaudeCliDriver } from "../../../src/agents/driver/claude-cli.js";
import { CodexCliDriver } from "../../../src/agents/driver/codex-cli.js";
import {
  EXTERNAL_AGENT_OPTION_UNSUPPORTED,
  ExternalAgentPolicyError,
} from "../../../src/agents/driver/policy-errors.js";
import { findPinnedArgOverride } from "../../../src/agents/driver/subprocess-jsonl.js";
import { CLAUDE_PROVIDER, CODEX_PROVIDER } from "../../../src/agents/index.js";

function refusal(build: () => unknown): ExternalAgentPolicyError {
  try {
    build();
  } catch (error) {
    if (error instanceof ExternalAgentPolicyError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the driver to refuse its args");
}

const CLAUDE_OVERRIDES: readonly (readonly string[])[] = [
  ["--permission-mode", "bypassPermissions"],
  ["--permission-mode=bypassPermissions"],
  ["--dangerously-skip-permissions"],
  ["--allow-dangerously-skip-permissions"],
  ["--permission-prompt-tool", "mcp__x__approve"],
  ["--settings", '{"sandbox":{"enabled":false}}'],
  ['--settings={"permissions":{"allow":["Bash"]}}'],
  ["--setting-sources=user,project"],
  ["--tools", "Bash,WebFetch"],
  ["--allowedTools", "Bash"],
  ["--allowed-tools=Bash"],
  ["--disallowedTools="],
  ["--disallowed-tools", ""],
  ["--mcp-config", "servers.json"],
  ["--add-dir", "/"],
  ["--plugin-dir=/tmp/plugins"],
  ["--ide"],
  ["--chrome"],
  // The value of another flag spelled like a pinned flag fails closed.
  ["--append-system-prompt", "--settings"],
];

const CODEX_OVERRIDES: readonly (readonly string[])[] = [
  ["-c", "sandbox_workspace_write.network_access=true"],
  ["--config", "sandbox_workspace_write.network_access=true"],
  ["--config=sandbox_workspace_write.network_access=true"],
  ["-csandbox_workspace_write.network_access=true"],
  ["-c=web_search=live"],
  ["-c", 'web_search="live"'],
  ["-c", " Web_Search = 'live'"],
  ["-c", '"mcp_servers".host.enabled=true'],
  ["-c", "mcp_servers.host.enabled=true"],
  ["-c", "sandbox_mode=danger-full-access"],
  ["-c", "approval_policy=never"],
  ["-c", "features.web_search_request=true"],
  ["-c", "tools.web_search=true"],
  ["-c", "profile=open"],
  ["-c", 'sandbox_permissions=["disk-full-read-access"]'],
  ["-c", "profiles.x.sandbox_mode=danger-full-access"],
  ["--config=profiles.x.sandbox_mode=danger-full-access"],
  ["--sandbox", "danger-full-access"],
  ["--sandbox=danger-full-access"],
  ["-s", "danger-full-access"],
  ["-sdanger-full-access"],
  ["--ask-for-approval", "never"],
  ["-a", "never"],
  ["--full-auto"],
  ["--dangerously-bypass-approvals-and-sandbox"],
  ["--yolo"],
  ["--add-dir", "/"],
  ["--cd", "/"],
  ["-C", "/"],
  ["--profile", "open"],
  ["-p", "open"],
  ["--enable", "web_search_request"],
  ["--disable=x"],
  ["--search"],
];

describe("ClaudeCliDriver args", () => {
  for (const args of CLAUDE_OVERRIDES) {
    test(`refuses ${JSON.stringify(args)}`, () => {
      const error = refusal(() => new ClaudeCliDriver({ args }));
      expect(error.code).toBe(EXTERNAL_AGENT_OPTION_UNSUPPORTED);
      expect(error.message).toContain("allowPolicyOverrideArgs");
    });
  }

  test("keeps args that do not touch the policy", () => {
    const args = [
      "--model",
      "haiku",
      "--verbose",
      "--append-system-prompt=Be brief.",
      "--fallback-model",
      "sonnet",
    ];
    const driver = new ClaudeCliDriver({ args });
    expect(
      driver
        .buildArgs({ provider: CLAUDE_PROVIDER, context: {} as never })
        .slice(-args.length),
    ).toEqual(args);
  });

  test("passes an override with allowPolicyOverrideArgs, last", () => {
    const driver = new ClaudeCliDriver({
      args: ["--permission-mode", "bypassPermissions"],
      allowPolicyOverrideArgs: true,
    });
    const argv = driver.buildArgs({
      provider: CLAUDE_PROVIDER,
      context: {} as never,
      permissions: { mode: "read-only" },
    });
    expect(argv.indexOf("dontAsk")).toBeLessThan(
      argv.lastIndexOf("bypassPermissions"),
    );
    expect(argv.slice(-2)).toEqual(["--permission-mode", "bypassPermissions"]);
  });

  test("rejects args that are not strings", () => {
    expect(
      () => new ClaudeCliDriver({ args: [1] as unknown as string[] }),
    ).toThrow(InputValidationError);
  });
});

describe("CodexCliDriver args", () => {
  for (const args of CODEX_OVERRIDES) {
    test(`refuses ${JSON.stringify(args)}`, () => {
      const error = refusal(() => new CodexCliDriver({ args }));
      expect(error.code).toBe(EXTERNAL_AGENT_OPTION_UNSUPPORTED);
      expect(error.message).toContain("allowPolicyOverrideArgs");
    });
  }

  test("keeps args that do not touch the policy", () => {
    const args = [
      "--model",
      "gpt-x",
      "-m",
      "gpt-y",
      "-c",
      'model="o3"',
      "--config=model_reasoning_effort=high",
      "--skip-git-repo-check",
    ];
    const argv = new CodexCliDriver({ args }).buildArgs({
      provider: CODEX_PROVIDER,
      context: { input: "hi" } as never,
    });
    expect(argv.slice(-(args.length + 2), -2)).toEqual(args);
  });

  test("passes an override with allowPolicyOverrideArgs, after the pinned one", () => {
    const override = "sandbox_workspace_write.network_access=true";
    const argv = new CodexCliDriver({
      args: ["-c", override],
      allowPolicyOverrideArgs: true,
    }).buildArgs({
      provider: CODEX_PROVIDER,
      context: { input: "hi" } as never,
      permissions: { mode: "workspace-write" },
    });
    expect(
      argv.indexOf("sandbox_workspace_write.network_access=false"),
    ).toBeLessThan(argv.indexOf(override));
  });

  test("rejects args that are not an array", () => {
    expect(
      () => new CodexCliDriver({ args: "--yolo" as unknown as string[] }),
    ).toThrow(InputValidationError);
  });
});

describe("findPinnedArgOverride", () => {
  const pinned = {
    flags: ["--sandbox", "-s"],
    configFlags: ["-c"],
    configKeys: ["mcp_servers"],
  };

  test("reports the entry with its config value", () => {
    expect(
      findPinnedArgOverride(["-c", "mcp_servers.x.enabled=true"], pinned),
    ).toBe("-c mcp_servers.x.enabled=true");
  });

  test("matches a key only at a path boundary", () => {
    expect(
      findPinnedArgOverride(["-c", "mcp_servers_extra=1"], pinned),
    ).toBeUndefined();
    expect(findPinnedArgOverride(["--sandboxed"], pinned)).toBeUndefined();
    expect(findPinnedArgOverride(["--sandbox-x=1"], pinned)).toBeUndefined();
  });

  test("ignores a trailing config flag without a value", () => {
    expect(findPinnedArgOverride(["-c"], pinned)).toBeUndefined();
  });
});
