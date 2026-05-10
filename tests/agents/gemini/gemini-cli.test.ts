/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import {
  GeminiCliAgent,
  GeminiCliDriver,
  GEMINI_CLI_ENV_ALLOWLIST,
  GEMINI_CLI_PROVIDER,
  buildGeminiArgs,
  mapGeminiPermissionArgs,
  type GeminiCliSpawn,
} from "../../../src/agents";
import type { ExternalAgentRunRequest } from "../../../src/agents";

function request(
  overrides: Partial<ExternalAgentRunRequest> = {},
): ExternalAgentRunRequest {
  return {
    provider: GEMINI_CLI_PROVIDER,
    context: {} as ExternalAgentRunRequest["context"],
    instruction: "say hello",
    ...overrides,
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iterable) {
    result.push(item);
  }
  return result;
}

describe("Gemini CLI provider", () => {
  test("declares the complete auth/config environment allowlist", () => {
    expect(GEMINI_CLI_PROVIDER).toEqual({
      id: "gemini-cli",
      name: "Gemini CLI",
      command: "gemini",
      envAllowlist: GEMINI_CLI_ENV_ALLOWLIST,
    });
    expect(GEMINI_CLI_ENV_ALLOWLIST).toEqual([
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_GENAI_USE_VERTEXAI",
      "GOOGLE_CLOUD_PROJECT",
      "GOOGLE_CLOUD_PROJECT_ID",
      "GOOGLE_CLOUD_LOCATION",
      "GOOGLE_APPLICATION_CREDENTIALS",
    ]);
  });

  test("agent wires the Gemini provider and runtime driver without auth side effects", () => {
    const agent = new GeminiCliAgent({ name: "gemini" });

    expect(agent.provider).toBe(GEMINI_CLI_PROVIDER);
    expect(agent.driver).toBeInstanceOf(GeminiCliDriver);
  });
});

describe("GeminiCliDriver", () => {
  test("builds gemini stream-json command args", async () => {
    const calls: Array<Parameters<GeminiCliSpawn>> = [];
    const spawn: GeminiCliSpawn = (command, args, options) => {
      calls.push([command, args, options]);
      return {
        stdout: [
          new TextEncoder().encode('{"type":"content","text":"hello"}\n'),
        ],
        exited: Promise.resolve(0),
      };
    };

    const driver = new GeminiCliDriver({
      spawn,
      env: { PATH: "/bin", HOME: "/home/test", SECRET_TOKEN: "blocked" },
    });

    const events = await collect(
      driver.run(request({ workingDirectory: "/repo" })),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("gemini");
    expect(calls[0]?.[1]).toEqual([
      "-p",
      "say hello",
      "--output-format",
      "stream-json",
      "--approval-mode=default",
      "--sandbox",
    ]);
    expect(calls[0]?.[2]).toEqual({
      cwd: "/repo",
      env: { PATH: "/bin", HOME: "/home/test" },
    });
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "output",
      "completed",
    ]);
    expect(events[1]).toMatchObject({ type: "output", content: "hello" });
  });

  test("passes only allowlisted credential environment variables", async () => {
    const calls: Array<Parameters<GeminiCliSpawn>> = [];
    const spawn: GeminiCliSpawn = (command, args, options) => {
      calls.push([command, args, options]);
      return { stdout: [], exited: Promise.resolve(0) };
    };

    const driver = new GeminiCliDriver({
      spawn,
      env: {
        PATH: "/bin",
        HOME: "/home/test",
        AWS_SECRET_ACCESS_KEY: "blocked",
      },
    });

    await collect(
      driver.run(
        request({
          credential: {
            kind: "env",
            label: "gemini-cli:env",
            env: {
              GEMINI_API_KEY: "gemini-key",
              GOOGLE_APPLICATION_CREDENTIALS: "/tmp/adc.json",
              AWS_SECRET_ACCESS_KEY: "blocked",
            },
          },
        }),
      ),
    );

    expect(calls[0]?.[2].env).toEqual({
      PATH: "/bin",
      HOME: "/home/test",
      GEMINI_API_KEY: "gemini-key",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/adc.json",
    });
  });

  test("normalizes Gemini stream-json events", async () => {
    const spawn: GeminiCliSpawn = () => ({
      stdout: [
        '{"type":"content","text":"hello"}\n',
        '{"type":"tool_call","name":"read_file","input":{"path":"README.md"}}\n',
        '{"type":"error","error":{"message":"nope","code":"E_NOPE"}}\n',
      ],
      exited: Promise.resolve(0),
    });
    const driver = new GeminiCliDriver({ spawn });

    await expect(collect(driver.run(request()))).resolves.toEqual([
      expect.objectContaining({ type: "started", providerId: "gemini-cli" }),
      expect.objectContaining({ type: "output", content: "hello" }),
      expect.objectContaining({
        type: "tool_call",
        name: "read_file",
        input: { path: "README.md" },
      }),
      expect.objectContaining({
        type: "error",
        message: "nope",
        code: "E_NOPE",
      }),
      expect.objectContaining({ type: "completed", exitCode: 0 }),
    ]);
  });

  test("maps permission presets without defaulting to yolo", () => {
    expect(buildGeminiArgs("prompt")).toEqual([
      "-p",
      "prompt",
      "--output-format",
      "stream-json",
      "--approval-mode=default",
      "--sandbox",
    ]);
    expect(mapGeminiPermissionArgs({ mode: "read-only" })).toEqual([
      "--approval-mode=plan",
      "--sandbox",
    ]);
    expect(mapGeminiPermissionArgs({ mode: "ask" })).toEqual([
      "--approval-mode=default",
      "--sandbox",
    ]);
    expect(
      mapGeminiPermissionArgs({
        mode: "workspace-write",
        allowedPaths: ["/repo", "/tmp"],
      }),
    ).toEqual([
      "--approval-mode=auto_edit",
      "--sandbox",
      "--include-directories",
      "/repo",
      "--include-directories",
      "/tmp",
    ]);
    expect(mapGeminiPermissionArgs({ mode: "full-access" })).toEqual([
      "--approval-mode=yolo",
    ]);
  });
});
