import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { ClaudeAgent } from "../../../src/agents/claude-agent.js";
import {
  ClaudeAgentSdkDriver,
  mapPolicyToClaudeSdkPermission,
} from "../../../src/agents/driver/claude-agent-sdk.js";
import { ClaudeCliDriver } from "../../../src/agents/driver/claude-cli.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/schema.js";
import { CODEX_PROVIDER } from "../../../src/agents/provider/schema.js";
import { ExternalAgent } from "../../../src/agents/external-agent.js";

async function materializePrompt(prompt: unknown): Promise<string> {
  if (typeof prompt === "string") {
    return prompt;
  }
  if (prompt && typeof prompt === "object" && Symbol.asyncIterator in prompt) {
    const parts: string[] = [];
    for await (const message of prompt as AsyncIterable<{
      message?: { content?: Array<{ type: string; text?: string }> };
    }>) {
      const blocks = message.message?.content ?? [];
      for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string") {
          parts.push(block.text);
        }
      }
    }
    return parts.join("\n");
  }
  return String(prompt);
}

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
        CLAUDE_CODE_EXECUTABLE: "/tmp/claude-bin",
        CLAUDE_CODE_PATH: "/tmp/claude-path",
        SECRET_NOT_ALLOWED: "nope",
      },
      pathToClaudeCodeExecutable: "/example/bin/claude",
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
          CLAUDE_CODE_EXECUTABLE: "/tmp/claude-bin",
          CLAUDE_CODE_PATH: "/tmp/claude-path",
          SECRET_NOT_ALLOWED: "nope",
        },
      },
    });

    expect(options.cwd).toBe("/repo");
    expect(options.permissionMode).toBe("acceptEdits");
    expect(options.additionalDirectories).toEqual(["/repo"]);
    expect(options.pathToClaudeCodeExecutable).toBe("/example/bin/claude");
    expect(options.settingSources).toEqual(["user", "project", "local"]);
    expect(options.maxTurns).toBe(3);
    expect(options.model).toBe("sonnet");
    expect(options.env?.PATH).toBe("/bin");
    expect(options.env?.HOME).toBe("/Users/example");
    expect(options.env?.CLAUDE_CONFIG_DIR).toBe("/Users/example/.claude");
    expect(options.env?.ANTHROPIC_API_KEY).toBe("anthropic-key");
    expect(options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token");
    expect(options.env?.CLAUDE_CODE_EXECUTABLE).toBe("/tmp/claude-bin");
    expect(options.env?.CLAUDE_CODE_PATH).toBe("/tmp/claude-path");
    expect(options.env?.SECRET_NOT_ALLOWED).toBeUndefined();
  });

  test("detects Claude Code executable from explicit environment overrides", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-sdk-driver-"));
    const executable = join(dir, process.platform === "win32" ? "claude.exe" : "claude");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    const driver = new ClaudeAgentSdkDriver({ env: { CLAUDE_CODE_EXECUTABLE: executable } });

    const resolution = driver.resolveClaudeExecutable({
      provider: CLAUDE_PROVIDER,
      context: {} as never,
    });
    const options = driver.buildOptions({
      provider: CLAUDE_PROVIDER,
      context: {} as never,
    });

    expect(resolution.path).toBe(executable);
    expect(options.pathToClaudeCodeExecutable).toBe(executable);
  });

  test("detects Claude Code executable from configurable search paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-sdk-search-path-"));
    const executable = join(dir, process.platform === "win32" ? "claude.exe" : "claude");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    const driver = new ClaudeAgentSdkDriver({
      env: { PATH: "" },
      executableSearchPaths: [dir],
    });

    const resolution = driver.resolveClaudeExecutable({
      provider: CLAUDE_PROVIDER,
      context: {} as never,
    });

    expect(resolution.path).toBe(executable);
    expect(resolution.checked).toContain(executable);
  });

  test("emits actionable Claude executable lookup errors", async () => {
    const driver = new ClaudeAgentSdkDriver({
      env: { CLAUDE_CODE_EXECUTABLE: "/missing/claude" },
      sdk: {
        query: () => {
          throw new Error("Native CLI binary for darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.");
        },
      },
    });

    const events = [];
    for await (const event of driver.run({
      provider: CLAUDE_PROVIDER,
      context: {} as never,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "started", providerId: "claude", timestamp: expect.any(Number) },
      {
        type: "error",
        message: expect.stringContaining("Set CLAUDE_CODE_EXECUTABLE=/absolute/path/to/claude"),
        code: "CLAUDE_AGENT_SDK_ERROR",
        recoverable: true,
        timestamp: expect.any(Number),
      },
      { type: "completed", exitCode: 1, timestamp: expect.any(Number) },
    ]);
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

  test("builds SDK MCP options for ADK subagent delegation", async () => {
    let handler: ((args: Record<string, unknown>, extra: unknown) => Promise<unknown>) | undefined;
    const sdk = {
      query: async function* () {},
      tool: (
        name: string,
        _description: string,
        inputSchema: Record<string, unknown>,
        toolHandler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>,
      ) => {
        expect(name).toBe("run_adk_subagent");
        expect(inputSchema.agentName).toBeDefined();
        expect(inputSchema.task).toBeDefined();
        handler = toolHandler;
        return { name };
      },
      createSdkMcpServer: (options: Record<string, unknown>) => options,
    };
    const driver = new ClaudeAgentSdkDriver({ sdk });
    const subAgent = new ExternalAgent({ name: "CodexImplementer", provider: CODEX_PROVIDER });
    const result = { agentName: "CodexImplementer", output: "done", events: 1 };
    const options = await driver.buildOptionsForRun(
      {
        provider: CLAUDE_PROVIDER,
        context: {} as never,
        subAgents: [subAgent],
        toolGateway: {
          runSubAgent: async (input: unknown) => {
            expect(input).toEqual({ agentName: "CodexImplementer", task: "patch" });
            return result;
          },
        } as never,
      },
      sdk,
    );

    expect(options.mcpServers?.adk_bridge).toMatchObject({
      name: "adk_bridge",
      tools: [{ name: "run_adk_subagent" }],
    });
    expect(options.allowedTools).toContain("mcp__adk_bridge__run_adk_subagent");
    await expect(handler?.({ agentName: "CodexImplementer", task: "patch" }, {})).resolves.toEqual({
      content: [{ type: "text", text: "done" }],
    });
  });

  test("buildPrompt includes prior session history alongside userContent", async () => {
    let capturedPrompt: unknown;
    const driver = new ClaudeAgentSdkDriver({
      sdk: {
        query: ({ prompt }) => {
          capturedPrompt = prompt;
          return (async function* () {
            yield { type: "result", subtype: "success", result: "ok" } as never;
          })() as never;
        },
      },
    });

    for await (const _event of driver.run({
      provider: CLAUDE_PROVIDER,
      context: {
        agent: { name: "claude" },
        branch: "root",
        session: {
          events: [
            {
              author: "user",
              content: { role: "user", parts: [{ text: "first question" }] },
            },
            {
              author: "claude",
              content: { role: "model", parts: [{ text: "earlier reply" }] },
            },
          ],
        },
        userContent: { role: "user", parts: [{ text: "follow-up question" }] },
      } as never,
      permissions: { mode: "ask" },
    })) {
      // consume events
      void _event;
    }

    const flattened = await materializePrompt(capturedPrompt);
    expect(flattened).toContain("first question");
    expect(flattened).toContain("earlier reply");
    expect(flattened).toContain("follow-up question");
  });

  test("text-only single-turn invocation passes a string prompt", async () => {
    let capturedPrompt: unknown;
    const driver = new ClaudeAgentSdkDriver({
      sdk: {
        query: ({ prompt }) => {
          capturedPrompt = prompt;
          return (async function* () {
            yield { type: "result", subtype: "success", result: "ok" } as never;
          })() as never;
        },
      },
    });

    for await (const _event of driver.run({
      provider: CLAUDE_PROVIDER,
      context: {
        agent: { name: "claude" },
        branch: "root",
        session: { events: [] },
        userContent: { role: "user", parts: [{ text: "hello" }] },
      } as never,
      permissions: { mode: "ask" },
    })) {
      void _event;
    }

    expect(typeof capturedPrompt).toBe("string");
    expect(capturedPrompt).toContain("hello");
  });

  test("multimodal history yields async iterable of SDK user messages", async () => {
    let capturedPrompt: unknown;
    const driver = new ClaudeAgentSdkDriver({
      sdk: {
        query: ({ prompt }) => {
          capturedPrompt = prompt;
          return (async function* () {
            yield { type: "result", subtype: "success", result: "ok" } as never;
          })() as never;
        },
      },
    });

    for await (const _event of driver.run({
      provider: CLAUDE_PROVIDER,
      context: {
        agent: { name: "claude" },
        branch: "root",
        session: {
          events: [
            {
              author: "user",
              content: {
                role: "user",
                parts: [
                  { text: "look at this" },
                  { inlineData: { mimeType: "image/png", data: "AAAA" } },
                ],
              },
            },
          ],
        },
        userContent: {
          role: "user",
          parts: [
            { text: "look at this" },
            { inlineData: { mimeType: "image/png", data: "AAAA" } },
          ],
        },
      } as never,
      permissions: { mode: "ask" },
    })) {
      void _event;
    }

    expect(typeof capturedPrompt).not.toBe("string");
    expect(capturedPrompt).toBeDefined();
    const iterable = capturedPrompt as AsyncIterable<{
      message: { content: Array<{ type: string; source?: { media_type?: string } }> };
    }>;
    const collected: Array<{
      message: { content: Array<{ type: string; source?: { media_type?: string } }> };
    }> = [];
    for await (const message of iterable) {
      collected.push(message);
    }
    expect(collected.length).toBeGreaterThan(0);
    const allBlocks = collected.flatMap((m) => m.message.content);
    const imageBlock = allBlocks.find((b) => b.type === "image");
    expect(imageBlock).toBeDefined();
    expect(imageBlock?.source?.media_type).toBe("image/png");
  });

  test("resumeSessionId sends only the current turn and forwards resume option", async () => {
    let capturedPrompt: unknown;
    let capturedOptions: { resume?: string } | undefined;
    const driver = new ClaudeAgentSdkDriver({
      resumeSessionId: "session-xyz",
      sdk: {
        query: ({ prompt, options }) => {
          capturedPrompt = prompt;
          capturedOptions = options as { resume?: string };
          return (async function* () {
            yield { type: "result", subtype: "success", result: "ok" } as never;
          })() as never;
        },
      },
    });

    for await (const _event of driver.run({
      provider: CLAUDE_PROVIDER,
      context: {
        agent: { name: "claude" },
        branch: "root",
        session: {
          events: [
            {
              author: "user",
              content: { role: "user", parts: [{ text: "first" }] },
            },
            {
              author: "claude",
              content: { role: "model", parts: [{ text: "reply" }] },
            },
          ],
        },
        userContent: { role: "user", parts: [{ text: "follow-up" }] },
      } as never,
      permissions: { mode: "ask" },
    })) {
      void _event;
    }

    expect(capturedOptions?.resume).toBe("session-xyz");
    expect(typeof capturedPrompt).not.toBe("string");
    const iterable = capturedPrompt as AsyncIterable<{
      message: { content: Array<{ type: string; text?: string }> };
    }>;
    const collected: Array<{
      message: { content: Array<{ type: string; text?: string }> };
    }> = [];
    for await (const message of iterable) {
      collected.push(message);
    }
    expect(collected).toHaveLength(1);
    const text = collected[0].message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    expect(text).toBe("follow-up");
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
