import { describe, expect, test } from "bun:test";
import { ClaudeAgent } from "../../../src/agents/claude-agent.js";
import {
  ClaudeAgentSdkDriver,
  mapPolicyToClaudeSdkPermission,
} from "../../../src/agents/driver/claude-agent-sdk.js";
import { ClaudeCliDriver } from "../../../src/agents/driver/claude-cli.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/schema.js";

describe("ClaudeAgentSdkDriver", () => {
  test("ClaudeAgent uses the SDK driver by default", () => {
    const agent = new ClaudeAgent({ name: "claude" });

    expect(agent.driver).toBeInstanceOf(ClaudeAgentSdkDriver);
  });

  test("ClaudeAgent respects an explicit CLI fallback driver", () => {
    const driver = new ClaudeCliDriver({ command: "claude" });
    const agent = new ClaudeAgent({ name: "claude", driver });

    expect(agent.driver).toBe(driver);
  });

  test("builds SDK options for native auth, cwd, permissions, and allowed paths", () => {
    const driver = new ClaudeAgentSdkDriver({
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
      pathToClaudeCodeExecutable: "/usr/local/bin/claude",
      settingSources: ["user", "project", "local"],
      maxTurns: 3,
      model: "sonnet",
    });

    const options = driver.buildOptions({
      provider: CLAUDE_PROVIDER,
      context: {} as never,
      workingDirectory: "/repo",
      instruction: "Be concise.",
      permissions: { mode: "workspace-write", allowedPaths: ["/repo"] },
      credential: {
        kind: "env",
        env: {
          ANTHROPIC_API_KEY: "anthropic-key",
          CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
          SECRET_NOT_ALLOWED: "nope",
        },
      },
    });

    expect(options.cwd).toBe("/repo");
    expect(options.permissionMode).toBe("acceptEdits");
    expect(options.additionalDirectories).toEqual(["/repo"]);
    expect(options.pathToClaudeCodeExecutable).toBe("/usr/local/bin/claude");
    expect(options.settingSources).toEqual(["user", "project", "local"]);
    expect(options.maxTurns).toBe(3);
    expect(options.model).toBe("sonnet");
    expect(options.env?.PATH).toBe("/bin");
    expect(options.env?.HOME).toBe("/Users/example");
    expect(options.env?.CLAUDE_CONFIG_DIR).toBe("/Users/example/.claude");
    expect(options.env?.ANTHROPIC_API_KEY).toBe("anthropic-key");
    expect(options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token");
    expect(options.env?.SECRET_NOT_ALLOWED).toBeUndefined();
  });

  test("maps bridge permissions to Claude SDK permission modes", () => {
    expect(mapPolicyToClaudeSdkPermission({ mode: "read-only" })).toEqual({
      permissionMode: "plan",
    });
    expect(mapPolicyToClaudeSdkPermission({ mode: "ask" })).toEqual({
      permissionMode: "default",
    });
    expect(mapPolicyToClaudeSdkPermission({ mode: "workspace-write" })).toEqual({
      permissionMode: "acceptEdits",
    });
    expect(mapPolicyToClaudeSdkPermission({ mode: "full-access" })).toEqual({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    });
  });

  test("normalizes assistant and result messages", () => {
    const driver = new ClaudeAgentSdkDriver();

    expect(
      driver.normalizeMessage({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello" }] },
      } as never),
    ).toEqual([{ type: "output", content: "Hello", timestamp: expect.any(Number) }]);

    expect(
      driver.normalizeMessage({
        type: "result",
        subtype: "success",
        result: "Done",
      } as never),
    ).toEqual([{ type: "completed", exitCode: 0, timestamp: expect.any(Number) }]);
  });

  test("suppresses system and rate-limit diagnostics by default", () => {
    const driver = new ClaudeAgentSdkDriver();

    expect(driver.normalizeMessage({ type: "system", subtype: "init" } as never)).toEqual([]);
    expect(driver.normalizeMessage({ type: "rate_limit_event" } as never)).toEqual([]);
  });

  test("run uses injected SDK without importing the real package", async () => {
    let called = false;
    const driver = new ClaudeAgentSdkDriver({
      sdk: {
        query: ({ prompt, options }) => {
          called = true;
          expect(prompt).toBe("Review this");
          expect(options?.permissionMode).toBe("default");
          return (async function* () {
            yield {
              type: "assistant",
              message: { content: [{ type: "text", text: "Looks good." }] },
            } as never;
            yield { type: "result", subtype: "success", result: "Complete" } as never;
          })() as never;
        },
      },
    });

    const events = [];
    for await (const event of driver.run({
      provider: CLAUDE_PROVIDER,
      context: { userContent: { parts: [{ text: "Review this" }] } } as never,
      permissions: { mode: "ask" },
    })) {
      events.push(event);
    }

    expect(called).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "output",
      "completed",
    ]);
  });
});
