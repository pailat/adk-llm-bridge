import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { CodexAgent } from "../../../src/agents/codex-agent.js";
import { CodexCliDriver } from "../../../src/agents/driver/codex-cli.js";
import {
  CodexSdkDriver,
  mapPolicyToCodexSdkThreadOptions,
} from "../../../src/agents/driver/codex-sdk.js";
import { CODEX_PROVIDER } from "../../../src/agents/provider/schema.js";

async function* sdkEvents(events: readonly Record<string, unknown>[]) {
  for (const event of events) {
    yield event;
  }
}

describe("CodexSdkDriver", () => {
  test("CodexAgent uses the SDK driver by default", () => {
    const agent = new CodexAgent({ name: "codex" });

    expect(agent.driver).toBeInstanceOf(CodexSdkDriver);
  });

  test("CodexAgent respects an explicit CLI fallback driver", () => {
    const driver = new CodexCliDriver({ command: "codex" });
    const agent = new CodexAgent({ name: "codex", driver });

    expect(agent.driver).toBe(driver);
  });

  test("builds client options with native auth env and allowlisted credentials", () => {
    const driver = new CodexSdkDriver({
      env: {
        PATH: "/bin",
        HOME: "/Users/example",
        USER: "example",
        SHELL: "/bin/zsh",
        XDG_CONFIG_HOME: "/Users/example/.config",
        OPENAI_API_KEY: "blocked",
        SECRET_NOT_ALLOWED: "blocked",
      },
      codexPathOverride: "/example/bin/codex",
      baseUrl: "https://example.test/v1",
      config: { show_raw_agent_reasoning: true },
    });

    const options = driver.buildClientOptions({
      provider: CODEX_PROVIDER,
      context: {} as never,
      credential: {
        kind: "env",
        env: {
          CODEX_API_KEY: "codex-key",
          CODEX_HOME: "/tmp/codex-home",
          CODEX_EXECUTABLE: "/tmp/codex-bin",
          CODEX_CLI_PATH: "/tmp/codex-cli",
          CODEX_CA_CERTIFICATE: "/tmp/ca.pem",
          SSL_CERT_FILE: "/tmp/ssl.pem",
          OPENAI_API_KEY: "blocked",
        },
      },
    });

    expect(options).toEqual({
      codexPathOverride: "/example/bin/codex",
      baseUrl: "https://example.test/v1",
      apiKey: "codex-key",
      config: { show_raw_agent_reasoning: true },
      env: {
        PATH: "/bin",
        HOME: "/Users/example",
        USER: "example",
        SHELL: "/bin/zsh",
        XDG_CONFIG_HOME: "/Users/example/.config",
        CODEX_API_KEY: "codex-key",
        CODEX_HOME: "/tmp/codex-home",
        CODEX_EXECUTABLE: "/tmp/codex-bin",
        CODEX_CLI_PATH: "/tmp/codex-cli",
        CODEX_CA_CERTIFICATE: "/tmp/ca.pem",
        SSL_CERT_FILE: "/tmp/ssl.pem",
      },
    });
  });

  test("detects Codex binary from explicit environment overrides", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-sdk-driver-"));
    const executable = join(dir, process.platform === "win32" ? "codex.exe" : "codex");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    const driver = new CodexSdkDriver({ env: { CODEX_EXECUTABLE: executable } });

    const resolution = driver.resolveCodexBinary({
      provider: CODEX_PROVIDER,
      context: {} as never,
    });
    const options = driver.buildClientOptions({
      provider: CODEX_PROVIDER,
      context: {} as never,
    });

    expect(resolution.path).toBe(executable);
    expect(options.codexPathOverride).toBe(executable);
  });

  test("emits actionable Codex binary lookup errors", async () => {
    const driver = new CodexSdkDriver({
      env: { CODEX_EXECUTABLE: "/missing/codex" },
      Codex: class {
        startThread() {
          throw new Error("Unable to locate Codex CLI binaries. Ensure @openai/codex is installed with optional dependencies.");
        }
        resumeThread() {
          throw new Error("not used");
        }
      },
    });

    const events = [];
    for await (const event of driver.run({
      provider: CODEX_PROVIDER,
      context: {} as never,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "started", providerId: "codex", timestamp: expect.any(Number) },
      {
        type: "error",
        message: expect.stringContaining("Set CODEX_EXECUTABLE=/absolute/path/to/codex"),
        code: "CODEX_SDK_ERROR",
        recoverable: true,
        timestamp: expect.any(Number),
      },
      { type: "completed", exitCode: 1, timestamp: expect.any(Number) },
    ]);
  });

  test("maps bridge permissions to Codex SDK thread options", () => {
    expect(mapPolicyToCodexSdkThreadOptions()).toEqual({
      sandboxMode: "read-only",
      approvalPolicy: "never",
    });
    expect(mapPolicyToCodexSdkThreadOptions({ mode: "ask" })).toEqual({
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
    });
    expect(mapPolicyToCodexSdkThreadOptions({ mode: "workspace-write" })).toEqual({
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
    });
    expect(mapPolicyToCodexSdkThreadOptions({ mode: "full-access" })).toEqual({
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
    });
    expect(
      mapPolicyToCodexSdkThreadOptions({
        mode: "read-only",
        allowNetwork: true,
        allowedPaths: ["/repo"],
      }),
    ).toEqual({
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: true,
      additionalDirectories: ["/repo"],
    });
  });

  test("run uses injected SDK and normalizes streamed events", async () => {
    let startThreadOptions: unknown;
    let runInput: unknown;
    const driver = new CodexSdkDriver({
      sdk: {
        startThread: (options) => {
          startThreadOptions = options;
          return {
            runStreamed: async (input) => {
              runInput = input;
              return {
                events: sdkEvents([
                  { type: "thread.started", thread_id: "thread-1" },
                  {
                    type: "item.completed",
                    item: { id: "item-1", type: "agent_message", text: "Done" },
                  },
                  {
                    type: "item.completed",
                    item: {
                      id: "item-2",
                      type: "command_execution",
                      command: "pwd",
                      status: "completed",
                      exit_code: 0,
                    },
                  },
                  { type: "turn.completed", usage: { input_tokens: 1 } },
                ]),
              };
            },
          };
        },
        resumeThread: () => {
          throw new Error("not used");
        },
      },
    });

    const events = [];
    for await (const event of driver.run({
      provider: CODEX_PROVIDER,
      context: { userContent: { parts: [{ text: "Review this" }] } } as never,
      instruction: "Be concise.",
      workingDirectory: "/repo",
      permissions: { mode: "read-only" },
    })) {
      events.push(event);
    }

    expect(startThreadOptions).toMatchObject({
      workingDirectory: "/repo",
      sandboxMode: "read-only",
      approvalPolicy: "never",
    });
    expect(runInput).toBe("Be concise.\n\nReview this");
    expect(events).toEqual([
      { type: "started", providerId: "codex", timestamp: expect.any(Number) },
      { type: "output", content: "Done", stream: "stdout", timestamp: expect.any(Number) },
      {
        type: "tool_call",
        name: "command_execution",
        input: { command: "pwd", status: "completed", exitCode: 0 },
        callId: "item-2",
        metadata: {
          itemType: "command_execution",
          status: "completed",
          command: "pwd",
          title: "Codex: command_execution call",
        },
        timestamp: expect.any(Number),
      },
      {
        type: "tool_result",
        name: "command_execution",
        result: { command: "pwd", status: "completed", exitCode: 0 },
        callId: "item-2",
        metadata: {
          itemType: "command_execution",
          status: "completed",
          command: "pwd",
          exitCode: 0,
          title: "Codex: command_execution completed",
        },
        timestamp: expect.any(Number),
      },
      { type: "completed", exitCode: 0, timestamp: expect.any(Number) },
    ]);
  });

  test("buildPrompt includes prior session history alongside userContent", async () => {
    let capturedInput = "";
    const driver = new CodexSdkDriver({
      sdk: {
        startThread: () => ({
          runStreamed: async (input) => {
            capturedInput = String(input);
            return {
              events: sdkEvents([{ type: "turn.completed" }]),
            };
          },
        }),
        resumeThread: () => {
          throw new Error("not used");
        },
      },
    });

    for await (const _event of driver.run({
      provider: CODEX_PROVIDER,
      context: {
        agent: { name: "codex" },
        branch: "root",
        session: {
          events: [
            {
              author: "user",
              content: { role: "user", parts: [{ text: "first question" }] },
            },
            {
              author: "codex",
              content: { role: "model", parts: [{ text: "earlier reply" }] },
            },
          ],
        },
        userContent: { role: "user", parts: [{ text: "follow-up question" }] },
      } as never,
      permissions: { mode: "read-only" },
    })) {
      void _event;
    }

    expect(capturedInput).toContain("first question");
    expect(capturedInput).toContain("earlier reply");
    expect(capturedInput).toContain("follow-up question");
  });

  test("normalizes mcp_tool_call progress without duplicate function calls", () => {
    const driver = new CodexSdkDriver();

    expect(
      driver.normalizeEvent({
        type: "item.updated",
        item: {
          id: "mcp-1",
          type: "mcp_tool_call",
          tool: "search_docs",
          status: "in_progress",
          server: "docs",
          arguments: { query: "ADK" },
        },
      }),
    ).toEqual([
      {
        type: "output",
        content: "Codex MCP tool in_progress: search_docs",
        partial: true,
        turnComplete: false,
        metadata: {
          itemType: "mcp_tool_call",
          toolName: "search_docs",
          status: "in_progress",
          title: "Codex: search_docs in_progress",
        },
        timestamp: expect.any(Number),
      },
    ]);

    expect(
      driver.normalizeEvent({
        type: "item.completed",
        item: {
          id: "mcp-1",
          type: "mcp_tool_call",
          tool: "search_docs",
          status: "completed",
          server: "docs",
          arguments: { query: "ADK" },
          result: { hits: 2 },
        },
      }),
    ).toEqual([
      {
        type: "tool_call",
        name: "search_docs",
        input: {
          server: "docs",
          arguments: { query: "ADK" },
          status: "completed",
        },
        callId: "mcp-1",
        metadata: {
          itemType: "mcp_tool_call",
          status: "completed",
          title: "Codex: search_docs call",
        },
        timestamp: expect.any(Number),
      },
      {
        type: "tool_result",
        name: "search_docs",
        result: {
          server: "docs",
          status: "completed",
          result: { hits: 2 },
          error: undefined,
        },
        callId: "mcp-1",
        error: undefined,
        metadata: {
          itemType: "mcp_tool_call",
          status: "completed",
          title: "Codex: search_docs completed",
        },
        timestamp: expect.any(Number),
      },
    ]);
  });

  test("first invocation emits state_delta carrying the new thread id", async () => {
    let startCalls = 0;
    let resumeCalls = 0;
    let runInput: unknown;
    const driver = new CodexSdkDriver({
      sdk: {
        startThread: () => {
          startCalls++;
          return {
            id: "thread-test-123",
            runStreamed: async (input) => {
              runInput = input;
              return {
                events: sdkEvents([
                  { type: "thread.started", thread_id: "thread-test-123" },
                  {
                    type: "item.completed",
                    item: { id: "item-1", type: "agent_message", text: "Hi" },
                  },
                  { type: "turn.completed", usage: { input_tokens: 1 } },
                ]),
              };
            },
          } as never;
        },
        resumeThread: () => {
          resumeCalls++;
          throw new Error("should not resume");
        },
      },
    });

    const session = { state: {} as Record<string, unknown>, events: [] };
    const events = [];
    for await (const event of driver.run({
      provider: CODEX_PROVIDER,
      agent: { name: "codex" } as never,
      context: {
        agent: { name: "codex" },
        session,
        userContent: { role: "user", parts: [{ text: "hello" }] },
      } as never,
      permissions: { mode: "read-only" },
    })) {
      events.push(event);
    }

    expect(startCalls).toBe(1);
    expect(resumeCalls).toBe(0);
    expect(runInput).toBe("hello");
    const stateDeltaEvent = events.find((e) => e.type === "state_delta");
    expect(stateDeltaEvent).toEqual({
      type: "state_delta",
      stateDelta: { "codex_thread:codex": "thread-test-123" },
      timestamp: expect.any(Number),
    });

    // Drive the state_delta through ExternalAgent and confirm the resulting
    // ADK Event carries actions.stateDelta so ADK's session machinery would
    // apply the delta.
    const { ExternalAgent } = await import(
      "../../../src/agents/external-agent.js"
    );
    const adkEvent = new (class extends ExternalAgent {
      expose(ev: unknown, ctx: unknown) {
        return (this as unknown as {
          toAdkEvent: (e: unknown, c: unknown) => unknown;
        }).toAdkEvent(ev, ctx);
      }
    })({ name: "codex", provider: CODEX_PROVIDER }).expose(stateDeltaEvent, {
      invocationId: "inv-1",
      branch: "root",
    });
    expect((adkEvent as { actions?: { stateDelta?: unknown } }).actions?.stateDelta)
      .toEqual({ "codex_thread:codex": "thread-test-123" });
  });

  test("second invocation resumes the saved thread and sends only the current turn", async () => {
    let startCalls = 0;
    let resumeId: string | undefined;
    let runInput: unknown;
    const driver = new CodexSdkDriver({
      sdk: {
        startThread: () => {
          startCalls++;
          throw new Error("should not start a new thread");
        },
        resumeThread: (id) => {
          resumeId = id;
          return {
            id,
            runStreamed: async (input) => {
              runInput = input;
              return {
                events: sdkEvents([
                  {
                    type: "item.completed",
                    item: { id: "item-2", type: "agent_message", text: "ok" },
                  },
                  { type: "turn.completed", usage: { input_tokens: 1 } },
                ]),
              };
            },
          } as never;
        },
      },
    });

    const events = [];
    for await (const event of driver.run({
      provider: CODEX_PROVIDER,
      agent: { name: "codex" } as never,
      context: {
        agent: { name: "codex" },
        session: {
          state: { "codex_thread:codex": "saved-thread-9" },
          events: [
            {
              author: "user",
              content: { role: "user", parts: [{ text: "first question" }] },
            },
            {
              author: "codex",
              content: { role: "model", parts: [{ text: "earlier reply" }] },
            },
          ],
        },
        userContent: { role: "user", parts: [{ text: "follow-up" }] },
      } as never,
      permissions: { mode: "read-only" },
    })) {
      events.push(event);
    }

    expect(startCalls).toBe(0);
    expect(resumeId).toBe("saved-thread-9");
    expect(runInput).toBe("follow-up");
    expect(String(runInput)).not.toContain("first question");
    expect(String(runInput)).not.toContain("earlier reply");
    expect(events.some((e) => e.type === "state_delta")).toBe(false);
  });

  test("cold start with history prepends transcript before the current turn", async () => {
    let capturedInput: unknown;
    const driver = new CodexSdkDriver({
      sdk: {
        startThread: () => ({
          id: "thread-cold-1",
          runStreamed: async (input) => {
            capturedInput = input;
            return {
              events: sdkEvents([{ type: "turn.completed" }]),
            };
          },
        }) as never,
        resumeThread: () => {
          throw new Error("not used");
        },
      },
    });

    for await (const _event of driver.run({
      provider: CODEX_PROVIDER,
      agent: { name: "codex" } as never,
      context: {
        agent: { name: "codex" },
        branch: "root",
        session: {
          state: {},
          events: [
            {
              author: "user",
              content: { role: "user", parts: [{ text: "first question" }] },
            },
            {
              author: "codex",
              content: { role: "model", parts: [{ text: "earlier reply" }] },
            },
          ],
        },
        userContent: { role: "user", parts: [{ text: "follow-up question" }] },
      } as never,
      permissions: { mode: "read-only" },
    })) {
      void _event;
    }

    expect(typeof capturedInput).toBe("string");
    const text = String(capturedInput);
    expect(text).toContain("first question");
    expect(text).toContain("earlier reply");
    expect(text).toContain("follow-up question");
    // Transcript prefix must precede the current turn text.
    expect(text.indexOf("first question")).toBeLessThan(
      text.indexOf("follow-up question"),
    );
  });

  test("normalizes failures and item errors", () => {
    const driver = new CodexSdkDriver();

    expect(
      driver.normalizeEvent({
        type: "item.completed",
        item: { id: "item-1", type: "error", message: "bad item" },
      }),
    ).toEqual([
      {
        type: "error",
        message: "bad item",
        code: "CODEX_ITEM_ERROR",
        recoverable: true,
        timestamp: expect.any(Number),
      },
    ]);

    expect(
      driver.normalizeEvent({ type: "turn.failed", error: { message: "failed" } }),
    ).toEqual([
      {
        type: "error",
        message: "failed",
        code: "CODEX_TURN_FAILED",
        recoverable: true,
        timestamp: expect.any(Number),
      },
      { type: "completed", exitCode: 1, timestamp: expect.any(Number) },
    ]);
  });
});
