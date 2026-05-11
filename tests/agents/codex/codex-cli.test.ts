/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import type { InvocationContext } from "@google/adk";
import {
  CODEX_PROVIDER,
  CodexAgent,
  CodexCliDriver,
  type CodexCliSpawn,
  type ExternalAgentRunRequest,
  mapPolicyToCodexArgs,
} from "../../../src/agents/index.js";

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

    const driver = new CodexCliDriver({ spawn });
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
      CODEX_CA_CERTIFICATE: "/tmp/ca.pem",
      SSL_CERT_FILE: "/tmp/ssl.pem",
    });
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

    const events = await collect(new CodexCliDriver({ spawn }).run(request()));

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
      timestamp: undefined,
    });
    expect(events).toContainEqual({
      type: "completed",
      exitCode: 0,
      timestamp: undefined,
    });
  });

  test("maps bridge permissions to current Codex global and exec flags", () => {
    expect(mapPolicyToCodexArgs()).toEqual([
      "--ask-for-approval",
      "never",
      "exec",
      "--json",
      "--sandbox",
      "read-only",
    ]);
    expect(mapPolicyToCodexArgs({ mode: "ask" })).toEqual([
      "--ask-for-approval",
      "on-request",
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
    ]);
    expect(mapPolicyToCodexArgs({ mode: "workspace-write" })).toEqual([
      "--ask-for-approval",
      "never",
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
    ]);
    expect(mapPolicyToCodexArgs({ mode: "full-access" })).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
      "exec",
      "--json",
    ]);
  });

  test("CodexAgent defaults to Codex provider and CLI driver without import-time side effects", () => {
    const agent = new CodexAgent({ name: "codex" });

    expect(agent.provider).toEqual(CODEX_PROVIDER);
    expect(agent.driver).toBeInstanceOf(CodexCliDriver);
  });
});
