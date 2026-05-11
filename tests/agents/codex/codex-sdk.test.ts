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
      codexPathOverride: "/usr/local/bin/codex",
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
          CODEX_CA_CERTIFICATE: "/tmp/ca.pem",
          SSL_CERT_FILE: "/tmp/ssl.pem",
          OPENAI_API_KEY: "blocked",
        },
      },
    });

    expect(options).toEqual({
      codexPathOverride: "/usr/local/bin/codex",
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
        CODEX_CA_CERTIFICATE: "/tmp/ca.pem",
        SSL_CERT_FILE: "/tmp/ssl.pem",
      },
    });
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
        metadata: { itemType: "command_execution", status: "completed" },
        timestamp: expect.any(Number),
      },
      { type: "completed", exitCode: 0, timestamp: expect.any(Number) },
    ]);
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
