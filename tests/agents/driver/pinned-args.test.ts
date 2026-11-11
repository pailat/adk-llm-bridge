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
  EXTERNAL_AGENT_MODEL_OVERRIDE,
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
  // Subagents carry their own tools, permission mode, MCP servers and hooks.
  ["--agents", '{"x":{"description":"d","prompt":"p","tools":["Bash"]}}'],
  ["--agents=agents.json"],
  ["--agent", "x"],
  ["--agent=x"],
  ["--plugin-url", "https://example.invalid/plugin.zip"],
  ["--permission-prompts", "host"],
  // These move the session's root or run it outside this process.
  ["--worktree"],
  ["--worktree=name"],
  ["-w"],
  ["-wname"],
  ["--remote-control"],
  ["--cloud", "session_x"],
  ["--teleport"],
  ["--environment", "ccpool_x"],
  // Commander expands a cluster of boolean short flags: `-pw` is `-p -w`.
  ["-pw"],
  ["-pvw", "name"],
  ["-cpwname"],
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
  ["--approve-for-me"],
  // A hidden clap alias of --approve-for-me in codex-cli 0.167.0.
  ["--not-so-yolo"],
  ["--not-so-yolo=true"],
  ["--dangerously-bypass-hook-trust"],
  ["--worktree"],
  ["-c", 'approvals_reviewer="auto_review"'],
  ["-c", 'default_permissions=":workspace"'],
  ["-c", "permissions.open.network=true"],
  ["-c", 'agents.x.config_file="/tmp/role.toml"'],
  // Clap expands a cluster of boolean short flags: `-hs x` is `-h -s x`.
  ["-hsdanger-full-access"],
  ["-Vs", "danger-full-access"],
  ["-hc", "sandbox_mode=danger-full-access"],
  ["-hcsandbox_mode=danger-full-access"],
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
      "--verbose",
      "--append-system-prompt=Be brief.",
      "--max-budget-usd",
      "2",
      // A value-taking short flag keeps the rest of the cluster as its value.
      "-nwork",
      "-dapi,hooks",
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
      "--output-last-message",
      "last.txt",
      "-c",
      'model_reasoning_summary="auto"',
      "--config=model_reasoning_effort=high",
      "--skip-git-repo-check",
      // A value-taking short flag keeps the rest of the cluster as its value.
      "-olast-s.txt",
      "-ishot-s.png",
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

describe("CodexCliDriver args: execpolicy rules and user config", () => {
  for (const args of [["--ignore-rules"], ["--ignore-rules=true"]]) {
    test(`refuses ${JSON.stringify(args)}: it drops the execpolicy rules`, () => {
      const error = refusal(() => new CodexCliDriver({ args }));
      expect(error.code).toBe(EXTERNAL_AGENT_OPTION_UNSUPPORTED);
    });
  }

  test("passes --ignore-rules with allowPolicyOverrideArgs", () => {
    expect(
      () =>
        new CodexCliDriver({
          args: ["--ignore-rules"],
          allowPolicyOverrideArgs: true,
        }),
    ).not.toThrow();
  });

  test("keeps --ignore-user-config: it only drops the host config.toml", () => {
    const argv = new CodexCliDriver({
      args: ["--ignore-user-config"],
    }).buildArgs({
      provider: CODEX_PROVIDER,
      context: { input: "hi" } as never,
    });
    expect(argv.slice(-3)).toEqual(["--ignore-user-config", "--", "hi"]);
  });
});

describe("CodexCliDriver args: positional words", () => {
  // The driver ends argv with `-- <prompt>`, so a bare word in args comes
  // before `--` and codex exec reads it as a subcommand (review, resume,
  // fork, help) or as the prompt.
  const POSITIONAL: readonly (readonly string[])[] = [
    ["review"],
    ["resume", "--last"],
    ["fork", "019a-session"],
    ["help"],
    ["write a poem"],
    ["-"],
    ["--"],
    // An empty entry before `--` would be an empty prompt.
    [""],
    ["--skip-git-repo-check", "review"],
    ["--json", "review"],
    // --image takes one value per flag here: repeat -i for more files.
    ["-i", "a.png", "review"],
    ["-hi", "a.png", "review"],
    // A value attached to its flag leaves the next entry positional.
    ["-ia.png", "review"],
    ["-hia.png", "review"],
    ["-c", "x=1", "resume"],
    ["--color=never", "review"],
  ];
  for (const args of POSITIONAL) {
    test(`refuses ${JSON.stringify(args)}`, () => {
      const error = refusal(() => new CodexCliDriver({ args }));
      expect(error.code).toBe(EXTERNAL_AGENT_OPTION_UNSUPPORTED);
      expect(error.message).toContain("positional");
    });
  }

  const KEPT: readonly (readonly string[])[] = [
    ["-o", "review"],
    ["--output-last-message", "resume"],
    ["-oreview"],
    ["--output-last-message=review"],
    ["-i", "a.png", "-i", "b.png"],
    ["--image", "a.png"],
    ["-hi", "a.png"],
    ["-Vi", "a.png"],
    // A trailing value flag is kept: codex exec does not take the driver's
    // `--` as its value and stops with a usage error before any turn.
    ["-o"],
    ["-c", "x=1", "--config", "y=2"],
    ["--color", "never"],
    ["--output-schema", "schema.json"],
    ["--thread-source", "user"],
    ["--cyber-access-program", "standard"],
    ["--add-dir", "/tmp/x"],
    ["--ephemeral", "--strict-config", "--json"],
  ];
  for (const args of KEPT) {
    test(`keeps ${JSON.stringify(args)}`, () => {
      const argv = new CodexCliDriver({
        args,
        allowPolicyOverrideArgs: args.includes("--add-dir"),
      }).buildArgs({
        provider: CODEX_PROVIDER,
        context: { input: "hi" } as never,
      });
      expect(argv.slice(-(args.length + 2), -2)).toEqual([...args]);
    });
  }

  test("passes a positional word with allowPolicyOverrideArgs", () => {
    const argv = new CodexCliDriver({
      args: ["review"],
      allowPolicyOverrideArgs: true,
    }).buildArgs({
      provider: CODEX_PROVIDER,
      context: { input: "hi" } as never,
    });
    expect(argv.slice(-3)).toEqual(["review", "--", "hi"]);
  });

  test("the policy flag check runs before the positional check", () => {
    const error = refusal(
      () => new CodexCliDriver({ args: ["review", "--yolo"] }),
    );
    expect(error.message).toContain("--yolo");
  });

  // The model check ignores allowPolicyOverrideArgs and runs before the
  // positional check, so a model flag is reported as a model override
  // whatever follows it.
  for (const args of [
    ["review", "--model", "gpt-x"],
    ["-m", "gpt-x"],
    ["--model", "gpt-x"],
    ["--local-provider", "ollama"],
  ]) {
    test(`the model check runs first: ${JSON.stringify(args)}`, () => {
      const error = refusal(() => new CodexCliDriver({ args }));
      expect(error.code).toBe(EXTERNAL_AGENT_MODEL_OVERRIDE);
    });
  }
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

  test("expands a short-flag cluster only through boolean flags", () => {
    const clustered = { ...pinned, booleanShortFlags: ["-h", "-V"] };
    expect(findPinnedArgOverride(["-hVs", "x"], clustered)).toBe("-hVs");
    expect(
      findPinnedArgOverride(["-hc", "mcp_servers.x.enabled=true"], clustered),
    ).toBe("-hc mcp_servers.x.enabled=true");
    // `-m` takes a value, so `s` belongs to it and is not a flag.
    expect(findPinnedArgOverride(["-msx"], clustered)).toBeUndefined();
    // Without the boolean list a cluster is not expanded.
    expect(findPinnedArgOverride(["-hsx"], pinned)).toBeUndefined();
  });
});
