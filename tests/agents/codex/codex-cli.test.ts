import { describe, expect, test } from "bun:test";
import type { InvocationContext } from "@google/adk";
import { mapPolicyToCodexArgs } from "../../../src/agents/driver/codex-cli.js";
import {
  CODEX_PROVIDER,
  CodexAgent,
  CodexCliDriver,
  type CodexCliSpawn,
  type ExternalAgentRunRequest,
} from "../../../src/agents/index.js";
import { captureWarnings } from "../../helpers/fake-logger.js";
import { noHostMcpServers } from "../helpers.js";

function context(input = "user request"): InvocationContext {
  return { input } as unknown as InvocationContext;
}

function request(
  overrides: Partial<ExternalAgentRunRequest> = {},
): ExternalAgentRunRequest {
  return {
    provider: CODEX_PROVIDER,
    context: context(),
    instruction: "system instruction",
    workingDirectory: "/repo",
    ...overrides,
  };
}

async function* chunks(lines: readonly string[]): AsyncIterable<string> {
  for (const line of lines) {
    yield `${line}\n`;
  }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iterable) {
    result.push(item);
  }
  return result;
}

describe("Codex CLI driver", () => {
  test("builds codex exec --json command with safe default permissions", async () => {
    const calls: Array<{
      command: string;
      args: readonly string[];
      cwd?: string;
    }> = [];
    const spawn: CodexCliSpawn = (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      return { stdout: chunks([]), exited: Promise.resolve(0) };
    };

    const driver = new CodexCliDriver({
      listMcpServers: noHostMcpServers,
      spawn,
    });
    await collect(driver.run(request()));

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("codex");
    expect(calls[0].cwd).toBe("/repo");
    expect(calls[0].args).toEqual([
      "--ask-for-approval",
      "never",
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "-c",
      'approvals_reviewer="user"',
      "-c",
      "sandbox_workspace_write.network_access=false",
      "-c",
      'web_search="disabled"',
      "--",
      "system instruction\n\nuser request",
    ]);
  });

  test("passes only Codex allowlisted credential environment values", async () => {
    let capturedEnv: Record<string, string> | undefined;
    const spawn: CodexCliSpawn = (_command, _args, options) => {
      capturedEnv = options.env;
      return { stdout: chunks([]), exited: Promise.resolve(0) };
    };

    const driver = new CodexCliDriver({
      listMcpServers: noHostMcpServers,
      spawn,
      env: {
        PATH: "/bin",
        HOME: "/Users/example",
        USER: "example",
        SHELL: "/bin/zsh",
        XDG_CONFIG_HOME: "/Users/example/.config",
        OPENAI_API_KEY: "blocked",
        SECRET_TOKEN: "blocked",
      },
    });

    await collect(
      driver.run(
        request({
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
              SECRET_TOKEN: "blocked",
            },
          },
        }),
      ),
    );

    expect(capturedEnv).toEqual({
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
    });
  });

  test("maps a failed turn (turn.failed) to an error event, not output text", async () => {
    const spawn: CodexCliSpawn = () => ({
      stdout: chunks([
        JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "turn.failed",
          error: { message: "You hit your usage limit" },
        }),
      ]),
      exited: Promise.resolve(1),
    });
    const driver = new CodexCliDriver({
      listMcpServers: noHostMcpServers,
      spawn,
    });
    const events = await collect(driver.run(request()));
    const errors = events.filter((event) => event.type === "error");
    expect(errors[0]).toMatchObject({
      type: "error",
      message: "You hit your usage limit",
    });
    expect(
      events.some(
        (event) =>
          event.type === "output" && event.content.includes("turn.failed"),
      ),
    ).toBe(false);
  });

  test("normalizes Codex JSONL events", async () => {
    const spawn: CodexCliSpawn = () => ({
      stdout: chunks([
        JSON.stringify({ type: "thread.started", id: "run-1" }),
        JSON.stringify({ type: "response.output_text.delta", delta: "hello" }),
        JSON.stringify({
          type: "item.completed",
          item: { id: "item-1", type: "agent_message", text: "final" },
        }),
        JSON.stringify({
          type: "tool_call.created",
          name: "shell",
          input: { cmd: "ls" },
        }),
        JSON.stringify({ type: "turn.completed", exit_code: 0 }),
      ]),
      exited: Promise.resolve(0),
    });

    const events = await collect(
      new CodexCliDriver({ listMcpServers: noHostMcpServers, spawn }).run(
        request(),
      ),
    );

    expect(events).toContainEqual({
      type: "started",
      providerId: "codex",
      runId: "run-1",
      timestamp: undefined,
    });
    expect(events).toContainEqual({
      type: "output",
      content: "hello",
      stream: "stdout",
      timestamp: undefined,
    });
    expect(events).toContainEqual({
      type: "output",
      content: "final",
      stream: "stdout",
      timestamp: undefined,
    });
    expect(events).toContainEqual({
      type: "tool_call",
      name: "shell",
      input: { cmd: "ls" },
      metadata: { builtin: true },
      timestamp: undefined,
    });
    expect(events.filter((event) => event.type === "completed")).toEqual([
      { type: "completed", exitCode: 0, timestamp: expect.any(Number) },
    ]);
  });

  test("decodes multibyte UTF-8 characters split across stdout chunks", async () => {
    const bytes = new TextEncoder().encode(
      `${JSON.stringify({ type: "response.output_text.delta", delta: "h\u00e9llo" })}\n`,
    );
    // "é" is 0xC3 0xA9: cut the stream between its two bytes.
    const split = bytes.indexOf(0xc3) + 1;
    expect(split).toBeGreaterThan(0);
    const spawn: CodexCliSpawn = () => ({
      stdout: (async function* () {
        yield bytes.slice(0, split);
        yield bytes.slice(split);
      })(),
      exited: Promise.resolve(0),
    });

    const events = await collect(
      new CodexCliDriver({ listMcpServers: noHostMcpServers, spawn }).run(
        request(),
      ),
    );

    expect(events).toContainEqual({
      type: "output",
      content: "h\u00e9llo",
      stream: "stdout",
      timestamp: undefined,
    });
    expect(JSON.stringify(events)).not.toContain("\ufffd");
  });

  test("does not terminate the turn when a Codex MCP item completes", async () => {
    const spawn: CodexCliSpawn = () => ({
      stdout: chunks([
        JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
        JSON.stringify({
          type: "item.started",
          item: {
            id: "call-1",
            type: "mcp_tool_call",
            tool: "workflow_get",
            arguments: {},
          },
        }),
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "call-1",
            type: "mcp_tool_call",
            tool: "workflow_get",
            arguments: {},
            result: { ok: true },
          },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { id: "message-1", type: "agent_message", text: "finished" },
        }),
        JSON.stringify({ type: "turn.completed", exit_code: 0 }),
      ]),
      exited: Promise.resolve(0),
    });

    const events = await collect(
      new CodexCliDriver({ listMcpServers: noHostMcpServers, spawn }).run(
        request(),
      ),
    );

    expect(events.filter((event) => event.type === "completed")).toEqual([
      { type: "completed", exitCode: 0, timestamp: expect.any(Number) },
    ]);
    expect(events).toContainEqual({
      type: "tool_call",
      name: "workflow_get",
      input: {},
      callId: "call-1",
      metadata: { itemType: "mcp_tool_call", builtin: true },
      timestamp: undefined,
    });
    expect(events).toContainEqual({
      type: "tool_result",
      name: "workflow_get",
      result: { ok: true },
      callId: "call-1",
      error: undefined,
      metadata: { itemType: "mcp_tool_call", builtin: true },
      timestamp: undefined,
    });
    expect(events).toContainEqual({
      type: "output",
      content: "finished",
      stream: "stdout",
      timestamp: undefined,
    });
  });

  test("maps bridge permissions to current Codex global and exec flags", () => {
    // Outside full-access the network is pinned off unless allowNetwork is true.
    expect(mapPolicyToCodexArgs()).toEqual([
      "--ask-for-approval",
      "never",
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "-c",
      'approvals_reviewer="user"',
      "-c",
      "sandbox_workspace_write.network_access=false",
      "-c",
      'web_search="disabled"',
    ]);
    expect(mapPolicyToCodexArgs({ mode: "ask" })).toEqual([
      "--ask-for-approval",
      "on-request",
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "-c",
      'approvals_reviewer="user"',
      "-c",
      "sandbox_workspace_write.network_access=false",
      "-c",
      'web_search="disabled"',
    ]);
    expect(mapPolicyToCodexArgs({ mode: "workspace-write" })).toEqual([
      "--ask-for-approval",
      "never",
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "-c",
      'approvals_reviewer="user"',
      "-c",
      "sandbox_workspace_write.network_access=false",
      "-c",
      'web_search="disabled"',
    ]);
    expect(mapPolicyToCodexArgs({ mode: "full-access" })).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
      "exec",
      "--json",
    ]);
  });

  test("CodexAgent accepts an explicit CLI fallback driver", () => {
    const driver = new CodexCliDriver();
    const agent = new CodexAgent({ name: "codex", driver });

    expect(agent.provider).toEqual(CODEX_PROVIDER);
    expect(agent.driver).toBe(driver);
  });

  test("skipGitRepoCheck adds --skip-git-repo-check to codex exec", () => {
    const driver = new CodexCliDriver({
      listMcpServers: noHostMcpServers,
      skipGitRepoCheck: true,
    });

    expect(driver.buildArgs(request())).toEqual([
      "--ask-for-approval",
      "never",
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "-c",
      'approvals_reviewer="user"',
      "-c",
      "sandbox_workspace_write.network_access=false",
      "-c",
      'web_search="disabled"',
      "--skip-git-repo-check",
      "--",
      "system instruction\n\nuser request",
    ]);
    expect(
      driver.buildArgs(request({ permissions: { mode: "full-access" } })),
    ).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--",
      "system instruction\n\nuser request",
    ]);
  });

  test("a prompt that looks like a flag stays the prompt", () => {
    const args = new CodexCliDriver({
      listMcpServers: noHostMcpServers,
    }).buildArgs({
      provider: CODEX_PROVIDER,
      context: { input: "--dangerously-bypass-approvals-and-sandbox" } as never,
    });
    expect(args.slice(-2)).toEqual([
      "--",
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
    expect(args.indexOf("--dangerously-bypass-approvals-and-sandbox")).toBe(
      args.length - 1,
    );
  });

  test("user args stay flags: they come before -- and the prompt", () => {
    const args = new CodexCliDriver({
      args: ["--output-last-message", "last.txt"],
      listMcpServers: noHostMcpServers,
    }).buildArgs({
      provider: CODEX_PROVIDER,
      context: { input: "hi" } as never,
    });
    expect(args.slice(-4)).toEqual([
      "--output-last-message",
      "last.txt",
      "--",
      "hi",
    ]);
  });

  test("skipGitRepoCheck is off by default", () => {
    expect(new CodexCliDriver().buildArgs(request())).not.toContain(
      "--skip-git-repo-check",
    );
    expect(
      new CodexCliDriver({
        listMcpServers: noHostMcpServers,
        skipGitRepoCheck: false,
      }).buildArgs(request()),
    ).not.toContain("--skip-git-repo-check");
  });

  test("stderr is drained while stdout is still open", async () => {
    // stdout only ends after stderr was fully read: a driver that reads the
    // two pipes one after the other would deadlock here.
    let stderrDone!: () => void;
    const stderrRead = new Promise<void>((resolve) => {
      stderrDone = resolve;
    });
    const spawn: CodexCliSpawn = () => ({
      stdout: (async function* () {
        await stderrRead;
        yield `${JSON.stringify({
          type: "item.completed",
          item: { id: "m1", type: "agent_message", text: "ok" },
        })}\n`;
      })(),
      stderr: (async function* () {
        yield "warning: something\n";
        stderrDone();
      })(),
      exited: Promise.resolve(0),
    });

    const warnings = captureWarnings();
    try {
      const events = await collect(
        new CodexCliDriver({ listMcpServers: noHostMcpServers, spawn }).run(
          request(),
        ),
      );

      // Exit 0: the stderr line is a diagnostic, not an error event.
      expect(events.map((event) => event.type)).toEqual([
        "started",
        "output",
        "completed",
      ]);
      expect(warnings.codes).toEqual(["CODEX_CLI_STDERR"]);
      expect(String(warnings.mock.calls[0]?.[0])).toContain(
        "warning: something",
      );
    } finally {
      warnings.mockRestore();
    }
  });

  test("stderr lines become errors only when the process exits nonzero", async () => {
    const spawn: CodexCliSpawn = () => ({
      stdout: chunks([]),
      stderr: chunks(["Error: model not available"]),
      exited: Promise.resolve(2),
    });

    const events = await collect(
      new CodexCliDriver({ listMcpServers: noHostMcpServers, spawn }).run(
        request(),
      ),
    );

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "error",
      "completed",
    ]);
    expect(events[1]).toMatchObject({
      message: "Error: model not available",
      recoverable: false,
    });
    expect(events[2]).toMatchObject({ exitCode: 2 });
  });
  describe("JSONL normalization", () => {
    function spawnLines(
      lines: readonly unknown[],
      exitCode = 0,
    ): CodexCliSpawn {
      return () => ({
        stdout: chunks(lines.map((line) => JSON.stringify(line))),
        exited: Promise.resolve(exitCode),
      });
    }

    test("lifecycle and unknown events produce no output", async () => {
      const events = await collect(
        new CodexCliDriver({
          listMcpServers: noHostMcpServers,
          spawn: spawnLines([
            { type: "thread.started", thread_id: "t-1" },
            { type: "turn.started" },
            { type: "item.started", item: { id: "r1", type: "reasoning" } },
            {
              type: "item.started",
              item: { id: "m1", type: "agent_message" },
            },
            {
              type: "item.updated",
              item: { id: "m1", type: "agent_message", text: "partial" },
            },
            {
              type: "item.completed",
              item: { id: "r1", type: "reasoning", text: "thinking" },
            },
            { type: "some.future.event", message: "not assistant text" },
            { foo: "bar" },
          ]),
        }).run(request()),
      );

      expect(events.filter((event) => event.type === "output")).toEqual([]);
      expect(JSON.stringify(events)).not.toContain("turn.started");
      expect(events.map((event) => event.type)).toEqual([
        "started",
        "started",
        "completed",
      ]);
    });

    test("parseEvent drops lifecycle lines and parseLine throws for them", () => {
      const driver = new CodexCliDriver();
      const line = JSON.stringify({ type: "turn.started" });
      expect(driver.parseEvent(line)).toBeUndefined();
      expect(() => driver.parseLine(line)).toThrow(
        "Codex JSONL line carries no external agent event",
      );
    });

    test("agent_message text is unchanged", async () => {
      const events = await collect(
        new CodexCliDriver({
          listMcpServers: noHostMcpServers,
          spawn: spawnLines([
            { type: "turn.started" },
            {
              type: "item.completed",
              item: { id: "m1", type: "agent_message", text: "PONG" },
            },
            { type: "turn.completed" },
          ]),
        }).run(request()),
      );
      expect(events.filter((event) => event.type === "output")).toEqual([
        {
          type: "output",
          content: "PONG",
          stream: "stdout",
          timestamp: undefined,
        },
      ]);
    });

    test("a usage-limit failure yields one non-recoverable QUOTA_EXHAUSTED error", async () => {
      const message =
        "You've hit your usage limit. Upgrade to Pro or try again at Nov 12th, 2026 9:00 AM.";
      const events = await collect(
        new CodexCliDriver({
          listMcpServers: noHostMcpServers,
          spawn: spawnLines(
            [
              { type: "thread.started", thread_id: "t-1" },
              { type: "turn.started" },
              { type: "error", message },
              { type: "turn.failed", error: { message } },
            ],
            1,
          ),
        }).run(request()),
      );
      const errors = events.filter((event) => event.type === "error");
      expect(errors).toEqual([
        {
          type: "error",
          message,
          code: "QUOTA_EXHAUSTED",
          recoverable: false,
          timestamp: undefined,
        },
      ]);
      expect(events.filter((event) => event.type === "output")).toEqual([]);
      expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 1 });
    });

    test("a generic failure yields one EXTERNAL_AGENT_ERROR error", async () => {
      const message = "stream disconnected unexpectedly";
      const events = await collect(
        new CodexCliDriver({
          listMcpServers: noHostMcpServers,
          spawn: spawnLines(
            [
              { type: "error", message },
              { type: "turn.failed", error: { message } },
            ],
            1,
          ),
        }).run(request()),
      );
      expect(events.filter((event) => event.type === "error")).toEqual([
        {
          type: "error",
          message,
          code: "EXTERNAL_AGENT_ERROR",
          recoverable: false,
          timestamp: undefined,
        },
      ]);
    });

    test("distinct error and turn.failed messages both surface", async () => {
      const events = await collect(
        new CodexCliDriver({
          listMcpServers: noHostMcpServers,
          spawn: spawnLines(
            [
              { type: "error", message: "Reconnecting... 1/5" },
              {
                type: "turn.failed",
                error: { message: "You hit your usage limit" },
              },
            ],
            1,
          ),
        }).run(request()),
      );
      expect(
        events
          .filter((event) => event.type === "error")
          .map((event) => [event.message, event.code]),
      ).toEqual([
        ["Reconnecting... 1/5", "EXTERNAL_AGENT_ERROR"],
        ["You hit your usage limit", "QUOTA_EXHAUSTED"],
      ]);
    });

    test("a rate limit stays recoverable and an explicit code is kept", async () => {
      const events = await collect(
        new CodexCliDriver({
          listMcpServers: noHostMcpServers,
          spawn: spawnLines([
            { type: "error", message: "429 Too Many Requests" },
            { type: "error", message: "boom", code: "CUSTOM_CODE" },
          ]),
        }).run(request()),
      );
      expect(
        events
          .filter((event) => event.type === "error")
          .map((event) => [event.code, event.recoverable]),
      ).toEqual([
        ["RATE_LIMIT", true],
        ["CUSTOM_CODE", false],
      ]);
    });

    test("an explicit code wins over the message heuristic", () => {
      const event = new CodexCliDriver().parseEvent(
        JSON.stringify({
          type: "error",
          message: "429 Too Many Requests",
          code: "MY_CODE",
        }),
      );
      expect(event).toEqual({
        type: "error",
        message: "429 Too Many Requests",
        code: "MY_CODE",
        recoverable: true,
        timestamp: undefined,
      });
    });

    test("a bridge-native error line keeps its explicit recoverable flag", () => {
      const event = new CodexCliDriver().parseEvent(
        JSON.stringify({
          type: "error",
          message: "boom",
          code: "X",
          recoverable: true,
        }),
      );
      expect(event).toEqual({
        type: "error",
        message: "boom",
        code: "X",
        recoverable: true,
        timestamp: undefined,
      });
    });

    test("an item of type error becomes an error event, not output", async () => {
      const events = await collect(
        new CodexCliDriver({
          listMcpServers: noHostMcpServers,
          spawn: spawnLines([
            {
              type: "item.completed",
              item: { id: "e1", type: "error", message: "tool crashed" },
            },
          ]),
        }).run(request()),
      );
      expect(events.filter((event) => event.type === "output")).toEqual([]);
      expect(events).toContainEqual({
        type: "error",
        message: "tool crashed",
        code: "EXTERNAL_AGENT_ERROR",
        recoverable: false,
        timestamp: undefined,
      });
    });
  });
});

describe("Codex CLI prompt", () => {
  test("sends the ADK user turn after the instruction, without thought parts", async () => {
    const calls: Array<readonly string[]> = [];
    const spawn: CodexCliSpawn = (_command, args) => {
      calls.push(args);
      return { stdout: chunks([]), exited: Promise.resolve(0) };
    };
    const driver = new CodexCliDriver({
      listMcpServers: noHostMcpServers,
      spawn,
    });

    await collect(
      driver.run(
        request({
          context: {
            userContent: {
              role: "user",
              parts: [
                { text: "hidden reasoning", thought: true },
                { text: "fix the failing test" },
              ],
            },
          } as unknown as InvocationContext,
        }),
      ),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.at(-1)).toBe("system instruction\n\nfix the failing test");
  });
});

describe("Codex CLI bridge-shaped lines", () => {
  test("driver-owned events from the child are dropped", async () => {
    const spawn: CodexCliSpawn = () => ({
      stdout: chunks([
        JSON.stringify({ type: "completed", exitCode: "weird" }),
        JSON.stringify({ type: "state_delta", stateDelta: { injected: true } }),
        JSON.stringify({ type: "tool_call", name: "", input: {} }),
        JSON.stringify({ type: "output", content: "hi", stream: "bogus" }),
      ]),
      exited: Promise.resolve(0),
    });

    const events = await collect(
      new CodexCliDriver({ listMcpServers: noHostMcpServers, spawn }).run(
        request(),
      ),
    );

    expect(events.filter((event) => event.type === "completed")).toEqual([
      expect.objectContaining({ exitCode: 0 }),
    ]);
    expect(events.some((event) => event.type === "state_delta")).toBe(false);
    expect(events.some((event) => event.type === "tool_call")).toBe(false);
    expect(events.filter((event) => event.type === "output")).toEqual([
      { type: "output", content: "hi" },
    ]);
  });
});

describe("Codex CLI exit errors", () => {
  test("a non-zero exit without any error reports CODEX_CLI_EXIT", async () => {
    const spawn: CodexCliSpawn = () => ({
      stdout: chunks([]),
      exited: Promise.resolve(4),
    });

    const events = await collect(
      new CodexCliDriver({ listMcpServers: noHostMcpServers, spawn }).run(
        request(),
      ),
    );

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "error",
      "completed",
    ]);
    expect(events[1]).toMatchObject({
      message: "Codex CLI exited with code 4",
      code: "CODEX_CLI_EXIT",
      recoverable: true,
    });
  });

  test("a non-zero exit after an error event adds no second error", async () => {
    const spawn: CodexCliSpawn = () => ({
      stdout: chunks([JSON.stringify({ type: "error", message: "boom" })]),
      exited: Promise.resolve(1),
    });

    const events = await collect(
      new CodexCliDriver({ listMcpServers: noHostMcpServers, spawn }).run(
        request(),
      ),
    );

    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
  });

  test("reads a sync-iterable stdout", async () => {
    const spawn: CodexCliSpawn = () => ({
      stdout: [
        `${JSON.stringify({ type: "response.output_text.delta", delta: "hi" })}\n`,
      ],
      exited: Promise.resolve(0),
    });

    const events = await collect(
      new CodexCliDriver({ listMcpServers: noHostMcpServers, spawn }).run(
        request(),
      ),
    );

    expect(events).toContainEqual(
      expect.objectContaining({ type: "output", content: "hi" }),
    );
  });
});
