import { describe, expect, test } from "bun:test";
import {
  ClaudeCliDriver,
  type ClaudeCliSpawn,
  mapClaudePermissionArgs,
} from "../../../src/agents/driver/claude-cli.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
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
      context: {
        userContent: { parts: [{ text: "Review this diff" }] },
      } as never,
      instruction: "You are a reviewer.",
      // With network on, so no web tools are removed and Bash is not sandboxed.
      permissions: { mode: "ask", allowNetwork: true },
    });

    expect(args).toEqual([
      "-p",
      "--input-format",
      "text",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "manual",
      // Isolated by default, like the Agent SDK driver.
      "--tools=Read,Glob,Grep,Edit,Write,NotebookEdit,Bash,WebFetch,WebSearch,TodoWrite",
      "--strict-mcp-config",
      "--setting-sources=",
      "--disable-slash-commands",
      '--settings={"disableClaudeAiConnectors":true,"autoMemoryEnabled":false,"permissions":{"deny":["mcp__*"]}}',
    ]);
  });

  test("a prompt that looks like a flag is never an argument", () => {
    const args = new ClaudeCliDriver({ args: ["--model", "haiku"] }).buildArgs({
      provider: CLAUDE_PROVIDER,
      context: { input: "--dangerously-skip-permissions" } as never,
      permissions: { mode: "ask", allowNetwork: true },
    });
    expect(args.slice(-2)).toEqual(["--model", "haiku"]);
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  test("the spawn receives the prompt as stdin input", async () => {
    let input: string | undefined;
    const driver = new ClaudeCliDriver({
      env: {},
      spawn: (_command, _args, options) => {
        input = options.input;
        return { stdout: null, stderr: null, exited: Promise.resolve(0) };
      },
    });
    for await (const _event of driver.run({
      provider: CLAUDE_PROVIDER,
      context: { input: "update" } as never,
      instruction: "Be brief.",
      permissions: { mode: "ask", allowNetwork: true },
    })) {
      // drain
    }
    expect(input).toBe("Be brief.\n\nupdate");
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
    // Not "plan": the CLI's plan mode swaps the configured model (Haiku ran
    // as Sonnet in a live check). "dontAsk" denies every tool that needs a
    // prompt and keeps the model.
    expect(mapClaudePermissionArgs({ mode: "read-only" })).toEqual([
      "--permission-mode",
      "dontAsk",
    ]);
    expect(mapClaudePermissionArgs({ mode: "ask" })).toEqual([
      "--permission-mode",
      "manual",
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

  test("maps an unset policy to the documented manual mode, not the default alias", () => {
    expect(mapClaudePermissionArgs()).toEqual(["--permission-mode", "manual"]);
  });
});

describe("ClaudeCliDriver final text", () => {
  function spawnLines(lines: readonly unknown[]): ClaudeCliSpawn {
    return () => ({
      stdout: lines.map((line) => `${JSON.stringify(line)}\n`),
      stderr: [],
      exited: Promise.resolve(0),
    });
  }

  async function outputs(lines: readonly unknown[]): Promise<string[]> {
    const driver = new ClaudeCliDriver({ spawn: spawnLines(lines), env: {} });
    const events: ExternalAgentEvent[] = [];
    for await (const event of driver.run({
      provider: CLAUDE_PROVIDER,
      context: {} as never,
      instruction: "Reply PONG",
    })) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 0 });
    return events.flatMap((event) =>
      event.type === "output" ? [event.content] : [],
    );
  }

  test("does not repeat result.result after the assistant text", async () => {
    expect(
      await outputs([
        { type: "system", subtype: "init" },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "PONG" }] },
        },
        { type: "result", subtype: "success", result: "PONG" },
      ]),
    ).toEqual(["PONG"]);
  });

  test("keeps result.result when no assistant text was emitted", async () => {
    expect(
      await outputs([
        { type: "system", subtype: "init" },
        { type: "result", subtype: "success", result: "PONG" },
      ]),
    ).toEqual(["PONG"]);
  });

  test("assistant tool-use turns without text do not suppress the result", async () => {
    expect(
      await outputs([
        {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", name: "Read", input: {} }],
          },
        },
        { type: "result", subtype: "success", result: "Done." },
      ]),
    ).toEqual(["Done."]);
  });
});

describe("Claude CLI non-object JSON lines", () => {
  test("parseClaudeLine skips JSON values that are not objects", () => {
    const driver = new ClaudeCliDriver();

    expect(driver.parseClaudeLine("null")).toBeUndefined();
    expect(driver.parseClaudeLine("42")).toBeUndefined();
    expect(driver.parseClaudeLine("[1,2]")).toBeUndefined();
  });
});

describe("Claude CLI bridge-shaped lines", () => {
  test("driver-owned events from the child are dropped and others rebuilt", async () => {
    const lines = [
      { type: "completed", exitCode: "weird" },
      { type: "state_delta", stateDelta: { injected: true } },
      { type: "started", providerId: "other" },
      { type: "output", content: "hi", stream: "bogus", timestamp: "x" },
    ];
    const driver = new ClaudeCliDriver({
      spawn: () => ({
        stdout: lines.map((line) => `${JSON.stringify(line)}\n`),
        stderr: [],
        exited: Promise.resolve(0),
      }),
      env: {},
    });

    const events: ExternalAgentEvent[] = [];
    for await (const event of driver.run({
      provider: CLAUDE_PROVIDER,
      context: {} as never,
      instruction: "x",
    })) {
      events.push(event);
    }

    expect(events.filter((event) => event.type === "completed")).toEqual([
      expect.objectContaining({ exitCode: 0 }),
    ]);
    expect(events.some((event) => event.type === "state_delta")).toBe(false);
    expect(
      events.filter(
        (event) => event.type === "started" && event.providerId === "other",
      ),
    ).toEqual([]);
    expect(events.filter((event) => event.type === "output")).toEqual([
      { type: "output", content: "hi" },
    ]);
  });
});

describe("Claude CLI error recoverability", () => {
  async function run(
    stderr: string[],
    exitCode: number,
    stdout: unknown[] = [],
  ) {
    const driver = new ClaudeCliDriver({
      spawn: () => ({
        stdout: stdout.map((line) => `${JSON.stringify(line)}\n`),
        stderr: stderr.map((line) => `${line}\n`),
        exited: Promise.resolve(exitCode),
      }),
      env: {},
    });
    const events: ExternalAgentEvent[] = [];
    for await (const event of driver.run({
      provider: CLAUDE_PROVIDER,
      context: {} as never,
      instruction: "x",
    })) {
      events.push(event);
    }
    return events.filter((event) => event.type === "error");
  }

  test("an auth failure on exit is not recoverable", async () => {
    expect(await run(["Error: Invalid API key (401)"], 2)).toEqual([
      {
        type: "error",
        message: "Error: Invalid API key (401)",
        code: "CLAUDE_CLI_EXIT",
        recoverable: false,
        timestamp: expect.any(Number),
      },
    ]);
  });

  test("a transport failure on exit stays recoverable", async () => {
    expect(await run(["socket hang up"], 1)).toEqual([
      expect.objectContaining({ code: "CLAUDE_CLI_EXIT", recoverable: true }),
    ]);
  });

  test("an in-stream auth error is not recoverable", async () => {
    const errors = await run([], 0, [
      { type: "error", error: { message: "authentication failed" } },
    ]);
    expect(errors).toEqual([
      expect.objectContaining({
        message: "authentication failed",
        recoverable: false,
      }),
    ]);
  });
});
