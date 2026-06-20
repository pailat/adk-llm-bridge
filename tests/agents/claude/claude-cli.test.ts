import { describe, expect, test } from "bun:test";
import {
  ClaudeCliDriver,
  mapClaudePermissionArgs,
} from "../../../src/agents/driver/claude-cli.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/schema.js";

describe("Claude CLI provider", () => {
  test("declares native, OAuth, and cloud auth environment allowlist", () => {
    expect(CLAUDE_PROVIDER.envAllowlist).toContain("ANTHROPIC_API_KEY");
    expect(CLAUDE_PROVIDER.envAllowlist).toContain("ANTHROPIC_AUTH_TOKEN");
    expect(CLAUDE_PROVIDER.envAllowlist).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(CLAUDE_PROVIDER.envAllowlist).toContain("CLAUDE_CONFIG_DIR");
    expect(CLAUDE_PROVIDER.envAllowlist).toContain("CLAUDE_CODE_USE_BEDROCK");
    expect(CLAUDE_PROVIDER.envAllowlist).toContain("CLAUDE_CODE_USE_VERTEX");
    expect(CLAUDE_PROVIDER.envAllowlist).toContain("CLAUDE_CODE_USE_FOUNDRY");
  });

  test("CLI fallback driver can be constructed without auth side effects", () => {
    const driver = new ClaudeCliDriver({ command: "claude" });

    expect(driver.providerId).toBe(CLAUDE_PROVIDER.id);
    expect(driver.command).toBe("claude");
  });
});

describe("ClaudeCliDriver", () => {
  test("builds claude stream-json command args", () => {
    const driver = new ClaudeCliDriver();
    const args = driver.buildArgs({
      provider: CLAUDE_PROVIDER,
      context: { userContent: { parts: [{ text: "Review this diff" }] } } as never,
      instruction: "You are a reviewer.",
      permissions: { mode: "ask" },
    });

    expect(args).toEqual([
      "-p",
      "You are a reviewer.\n\nReview this diff",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "default",
    ]);
  });

  test("passes native auth home/config and only allowlisted credential env vars", () => {
    const driver = new ClaudeCliDriver({
      env: {
        PATH: "/bin",
        HOME: "/Users/example",
        USER: "example",
        SHELL: "/bin/zsh",
        CLAUDE_CONFIG_DIR: "/Users/example/.claude",
        ANTHROPIC_API_KEY: "anthropic-key",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
        SECRET_NOT_ALLOWED: "nope",
      },
    });

    const env = driver.buildEnv({
      provider: CLAUDE_PROVIDER,
      context: {} as never,
      credential: {
        kind: "env",
        env: {
          ANTHROPIC_API_KEY: "anthropic-key",
          CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
          SECRET_NOT_ALLOWED: "nope",
        },
      },
    });

    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/Users/example");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/Users/example/.claude");
    expect(env.ANTHROPIC_API_KEY).toBe("anthropic-key");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token");
    expect(env.SECRET_NOT_ALLOWED).toBeUndefined();
  });

  test("normalizes Claude stream-json assistant events", () => {
    const driver = new ClaudeCliDriver();
    const event = driver.parseClaudeLine(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Looks good." }] },
      }),
    );

    expect(event).toMatchObject({
      type: "output",
      content: "Looks good.",
    });
  });

  test("suppresses Claude lifecycle diagnostics", () => {
    const driver = new ClaudeCliDriver();

    expect(
      driver.parseClaudeLine(
        JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
      ),
    ).toBeUndefined();
    expect(
      driver.parseClaudeLine(JSON.stringify({ type: "rate_limit_event" })),
    ).toBeUndefined();
  });

  test("maps permission presets to Claude permission modes", () => {
    expect(mapClaudePermissionArgs({ mode: "read-only" })).toEqual([
      "--permission-mode",
      "plan",
    ]);
    expect(mapClaudePermissionArgs({ mode: "ask" })).toEqual([
      "--permission-mode",
      "default",
    ]);
    expect(mapClaudePermissionArgs({ mode: "workspace-write" })).toEqual([
      "--permission-mode",
      "acceptEdits",
    ]);
    expect(mapClaudePermissionArgs({ mode: "full-access" })).toEqual([
      "--permission-mode",
      "bypassPermissions",
    ]);
  });
});
