import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { Content } from "@google/genai";
import {
  ClaudeAgent,
  CLAUDE_AGENT_DEFINITION,
} from "../../../src/agents/claude-agent.js";
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
    // PERM-1: read-only must NOT map to interactive planning mode ("plan"),
    // which refuses tool execution; it maps to "default" so Q&A/read-only tools
    // still run while write/edit stays gated.
    const readOnly = mapPolicyToClaudeSdkPermission({ mode: "read-only" });
    expect(readOnly).toEqual({ permissionMode: "default" });
    expect(readOnly.permissionMode).not.toBe("plan");
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

  // --- AUTH-1: SDK isolation via settingSources default ---
  test("defaults settingSources to [] (SDK isolation), not omitted", () => {
    const driver = new ClaudeAgentSdkDriver();

    const options = driver.buildOptions({
      provider: CLAUDE_PROVIDER,
      context: {} as never,
      permissions: { mode: "ask" },
    });

    // The key must be PRESENT (not stripped by removeUndefined) and empty,
    // so the SDK does not load host user/project/local settings.
    expect("settingSources" in options).toBe(true);
    expect(options.settingSources).toEqual([]);
  });

  test("allows opting back into specific settingSources", () => {
    const driver = new ClaudeAgentSdkDriver({ settingSources: ["project"] });

    const options = driver.buildOptions({
      provider: CLAUDE_PROVIDER,
      context: {} as never,
      permissions: { mode: "ask" },
    });

    expect(options.settingSources).toEqual(["project"]);
  });

  // --- LIFECYCLE-1: abortController + interrupt()/return() teardown ---
  test("sets an abortController on options wired to the run abort signal", () => {
    const driver = new ClaudeAgentSdkDriver();
    const controller = new AbortController();

    const options = driver.buildOptions({
      provider: CLAUDE_PROVIDER,
      context: {} as never,
      permissions: { mode: "ask" },
      abortSignal: controller.signal,
    });

    expect(options.abortController).toBeInstanceOf(AbortController);
    expect(options.abortController?.signal.aborted).toBe(false);
    controller.abort();
    expect(options.abortController?.signal.aborted).toBe(true);
  });

  test("interrupts and returns the Query when the consumer breaks early", async () => {
    let interrupted = false;
    let returned = false;
    const driver = new ClaudeAgentSdkDriver({
      sdk: {
        query: () => {
          const gen = (async function* () {
            yield {
              type: "assistant",
              message: { content: [{ type: "text", text: "one" }] },
            } as never;
            yield {
              type: "assistant",
              message: { content: [{ type: "text", text: "two" }] },
            } as never;
            yield { type: "result", subtype: "success", result: "done" } as never;
          })();
          return Object.assign(gen, {
            interrupt: async () => {
              interrupted = true;
            },
            return: async (value?: unknown) => {
              returned = true;
              return gen.return(value as never);
            },
          });
        },
      },
    });

    for await (const event of driver.run({
      provider: CLAUDE_PROVIDER,
      context: { userContent: { parts: [{ text: "hi" }] } } as never,
      permissions: { mode: "ask" },
    })) {
      if (event.type === "output") {
        break; // early break after the first output
      }
    }

    expect(interrupted).toBe(true);
    expect(returned).toBe(true);
  });

  test("returns the Query on normal completion without interrupting", async () => {
    let interrupted = false;
    let returned = false;
    const driver = new ClaudeAgentSdkDriver({
      sdk: {
        query: () => {
          const gen = (async function* () {
            yield { type: "result", subtype: "success", result: "done" } as never;
          })();
          return Object.assign(gen, {
            interrupt: async () => {
              interrupted = true;
            },
            return: async (value?: unknown) => {
              returned = true;
              return gen.return(value as never);
            },
          });
        },
      },
    });

    for await (const _event of driver.run({
      provider: CLAUDE_PROVIDER,
      context: { userContent: { parts: [{ text: "hi" }] } } as never,
      permissions: { mode: "ask" },
    })) {
      void _event;
    }

    // Completed normally: no interrupt needed, but return() still finalizes.
    expect(interrupted).toBe(false);
    expect(returned).toBe(true);
  });

  // --- ERR-2: typed error classification ---
  test("classifies assistant/result error subtypes as (non-)recoverable", () => {
    const driver = new ClaudeAgentSdkDriver();

    const cases: Array<{
      message: ClaudeAgentSdkMessageInput;
      recoverable: boolean;
      code?: string;
    }> = [
      {
        message: { type: "assistant", error: "authentication_failed" },
        recoverable: false,
        code: "CLAUDE_AUTH_ERROR",
      },
      {
        message: { type: "assistant", error: "billing_error" },
        recoverable: false,
        code: "CLAUDE_BILLING_ERROR",
      },
      {
        message: { type: "assistant", error: "rate_limit" },
        recoverable: true,
        code: "CLAUDE_RATE_LIMIT",
      },
      {
        message: { type: "assistant", error: "server_error" },
        recoverable: true,
        code: "CLAUDE_SERVER_ERROR",
      },
      {
        message: { type: "result", subtype: "error_max_turns", errors: ["max turns"] },
        recoverable: false,
        code: "error_max_turns",
      },
      {
        message: {
          type: "result",
          subtype: "error_max_budget_usd",
          errors: ["budget"],
        },
        recoverable: false,
        code: "error_max_budget_usd",
      },
    ];

    for (const testCase of cases) {
      const events = driver.normalizeMessage(testCase.message as never);
      const errorEvent = events.find((event) => event.type === "error");
      expect(errorEvent).toBeDefined();
      if (errorEvent?.type === "error") {
        expect(errorEvent.recoverable).toBe(testCase.recoverable);
        if (testCase.code) {
          expect(errorEvent.code).toBe(testCase.code);
        }
      }
    }
  });

  test("run catch classifies auth errors as non-recoverable", async () => {
    const driver = new ClaudeAgentSdkDriver({
      sdk: {
        query: () => {
          throw new Error("401 Unauthorized: invalid api key");
        },
      },
    });

    const events = [];
    for await (const event of driver.run({
      provider: CLAUDE_PROVIDER,
      context: {} as never,
      permissions: { mode: "ask" },
    })) {
      events.push(event);
    }

    const errorEvent = events.find((event) => event.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === "error") {
      expect(errorEvent.recoverable).toBe(false);
    }
  });

  // --- ERR-2 / ERR-1-guard: permission-denied enrichment ---
  test("appends tool_name and decision_reason to permission-denied (keeps base message)", () => {
    const driver = new ClaudeAgentSdkDriver();

    const events = driver.normalizeMessage({
      type: "system",
      subtype: "permission_denied",
      message: "Permission to run Bash was denied",
      tool_name: "Bash",
      decision_reason: "rule: deny dangerous commands",
    } as never);

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.type).toBe("error");
    if (event.type === "error") {
      // Base message (ERR-1 refuted) MUST be preserved...
      expect(event.message).toContain("Permission to run Bash was denied");
      // ...and enriched with tool_name + decision_reason.
      expect(event.message).toContain("Bash");
      expect(event.message).toContain("rule: deny dangerous commands");
      expect(event.code).toBe("CLAUDE_PERMISSION_DENIED");
      expect(event.recoverable).toBe(false);
    }
  });

  // --- ERR-3: result success fallback ---
  test("falls back to result.result when no assistant text was streamed", async () => {
    const driver = new ClaudeAgentSdkDriver({
      sdk: {
        query: () =>
          (async function* () {
            yield {
              type: "result",
              subtype: "success",
              result: "final aggregated answer",
            } as never;
          })() as never,
      },
    });

    const outputs: string[] = [];
    for await (const event of driver.run({
      provider: CLAUDE_PROVIDER,
      context: { userContent: { parts: [{ text: "hi" }] } } as never,
      permissions: { mode: "ask" },
    })) {
      if (event.type === "output") {
        outputs.push(event.content);
      }
    }

    expect(outputs).toContain("final aggregated answer");
  });

  test("does NOT duplicate output when assistant text already streamed", async () => {
    const driver = new ClaudeAgentSdkDriver({
      sdk: {
        query: () =>
          (async function* () {
            yield {
              type: "assistant",
              message: { content: [{ type: "text", text: "streamed answer" }] },
            } as never;
            yield {
              type: "result",
              subtype: "success",
              result: "streamed answer",
            } as never;
          })() as never,
      },
    });

    const outputs: string[] = [];
    for await (const event of driver.run({
      provider: CLAUDE_PROVIDER,
      context: { userContent: { parts: [{ text: "hi" }] } } as never,
      permissions: { mode: "ask" },
    })) {
      if (event.type === "output") {
        outputs.push(event.content);
      }
    }

    expect(outputs).toEqual(["streamed answer"]);
  });

  // --- AUTH-2: plain-string system prompt opt-in ---
  test("uses preset+append system prompt by default", () => {
    const driver = new ClaudeAgentSdkDriver();

    const options = driver.buildOptions({
      provider: CLAUDE_PROVIDER,
      context: {} as never,
      permissions: { mode: "ask" },
      instruction: "Be concise.",
    });

    expect(options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "Be concise.",
    });
  });

  test("honors a configured plain-string system prompt", () => {
    const driver = new ClaudeAgentSdkDriver({
      systemPrompt: "You are a helpful Q&A assistant.",
    });

    const withInstruction = driver.buildOptions({
      provider: CLAUDE_PROVIDER,
      context: {} as never,
      permissions: { mode: "ask" },
      instruction: "Answer briefly.",
    });
    expect(typeof withInstruction.systemPrompt).toBe("string");
    expect(withInstruction.systemPrompt).toContain(
      "You are a helpful Q&A assistant.",
    );
    expect(withInstruction.systemPrompt).toContain("Answer briefly.");

    const noInstruction = driver.buildOptions({
      provider: CLAUDE_PROVIDER,
      context: {} as never,
      permissions: { mode: "ask" },
    });
    expect(noInstruction.systemPrompt).toBe("You are a helpful Q&A assistant.");
  });

  // --- SESSION-RESUME: capture SDK session_id and resume on next turn ---
  test("captures the SDK session_id from system/init and result messages", async () => {
    const capturedOptions: Array<{ resume?: string; sessionId?: unknown }> = [];
    const driver = new ClaudeAgentSdkDriver({
      sdk: {
        query: ({ options }) => {
          capturedOptions.push(options as { resume?: string; sessionId?: unknown });
          return (async function* () {
            yield { type: "system", subtype: "init", session_id: "sess-1" } as never;
            yield { type: "result", subtype: "success", result: "ok", session_id: "sess-1" } as never;
          })() as never;
        },
      },
    });

    const baseContext = {
      agent: { name: "claude" },
      branch: "root",
      session: { id: "adk-session-A", events: [] },
      userContent: { role: "user", parts: [{ text: "hello" }] },
    };

    // Turn 1: no resume; the SDK emits a session_id the driver must capture.
    for await (const _event of driver.run({
      provider: CLAUDE_PROVIDER,
      context: baseContext as never,
      permissions: { mode: "ask" },
    })) {
      void _event;
    }
    expect(capturedOptions[0]?.resume).toBeUndefined();

    // Turn 2 (same ADK session): the driver must resume the captured id and
    // must NOT also set sessionId (the SDK throws on resume+sessionId).
    for await (const _event of driver.run({
      provider: CLAUDE_PROVIDER,
      context: {
        ...baseContext,
        userContent: { role: "user", parts: [{ text: "again" }] },
      } as never,
      permissions: { mode: "ask" },
    })) {
      void _event;
    }
    expect(capturedOptions[1]?.resume).toBe("sess-1");
    expect("sessionId" in (capturedOptions[1] ?? {})).toBe(false);
  });

  test("two turns of one ADK session resume and send exactly one user-role message", async () => {
    const calls: Array<{
      prompt: unknown;
      options: { resume?: string };
    }> = [];
    const driver = new ClaudeAgentSdkDriver({
      sdk: {
        query: ({ prompt, options }) => {
          calls.push({ prompt, options: options as { resume?: string } });
          return (async function* () {
            yield { type: "system", subtype: "init", session_id: "sdk-sess-42" } as never;
            yield {
              type: "assistant",
              message: { content: [{ type: "text", text: "answer" }] },
            } as never;
            yield {
              type: "result",
              subtype: "success",
              result: "answer",
              session_id: "sdk-sess-42",
            } as never;
          })() as never;
        },
      },
    });

    const sessionEvents: Array<{ author: string; content: Content }> = [
      { author: "user", content: { role: "user", parts: [{ text: "turn-1" }] } },
    ];

    const turn1Events: string[] = [];
    for await (const event of driver.run({
      provider: CLAUDE_PROVIDER,
      context: {
        agent: { name: "claude" },
        branch: "root",
        session: { id: "adk-session-B", events: sessionEvents },
        userContent: { role: "user", parts: [{ text: "turn-1" }] },
      } as never,
      permissions: { mode: "ask" },
    })) {
      turn1Events.push(event.type);
    }
    expect(turn1Events).not.toContain("error");
    expect(calls[0].options.resume).toBeUndefined();

    // Simulate ADK appending the model reply + the new user turn for turn 2.
    sessionEvents.push({
      author: "claude",
      content: { role: "model", parts: [{ text: "answer" }] },
    });
    sessionEvents.push({
      author: "user",
      content: { role: "user", parts: [{ text: "turn-2" }] },
    });

    const turn2Events: Array<{ type: string; code?: string }> = [];
    for await (const event of driver.run({
      provider: CLAUDE_PROVIDER,
      context: {
        agent: { name: "claude" },
        branch: "root",
        session: { id: "adk-session-B", events: sessionEvents },
        userContent: { role: "user", parts: [{ text: "turn-2" }] },
      } as never,
      permissions: { mode: "ask" },
    })) {
      turn2Events.push(event as { type: string; code?: string });
    }

    // Turn 2 resumes the captured SDK session id.
    expect(calls[1].options.resume).toBe("sdk-sess-42");

    // Turn 2 sends exactly one user-role message: the newest turn only.
    const prompt = calls[1].prompt;
    expect(typeof prompt).not.toBe("string");
    const collected: Array<{ message: { role: string; content: Array<{ type: string; text?: string }> } }> = [];
    for await (const message of prompt as AsyncIterable<{
      message: { role: string; content: Array<{ type: string; text?: string }> };
    }>) {
      collected.push(message);
    }
    expect(collected).toHaveLength(1);
    expect(collected[0].message.role).toBe("user");
    const text = collected[0].message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    expect(text).toBe("turn-2");

    // No input message had role 'assistant'; no error/CLAUDE_AGENT_SDK_ERROR.
    for (const message of collected) {
      expect(message.message.role).not.toBe("assistant");
    }
    expect(turn2Events.some((e) => e.type === "error")).toBe(false);
    expect(turn2Events.some((e) => e.code === "CLAUDE_AGENT_SDK_ERROR")).toBe(false);
  });

  // --- STREAM-1: capability claim matches actual behavior ---
  test("does not advertise token-level streaming", () => {
    expect(CLAUDE_AGENT_DEFINITION.capabilities.streaming).toBe(false);
  });
});

type ClaudeAgentSdkMessageInput = Record<string, unknown>;
