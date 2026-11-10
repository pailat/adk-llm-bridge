import { describe, expect, test } from "bun:test";
import {
  buildGeminiArgs,
  mapGeminiPermissionArgs,
} from "../../../src/agents/driver/gemini-cli.js";
import type { ExternalAgentRunRequest } from "../../../src/agents/index.js";
import {
  GEMINI_CLI_ENV_ALLOWLIST,
  GEMINI_CLI_PROVIDER,
  GeminiCliAgent,
  GeminiCliDriver,
  type GeminiCliSpawn,
} from "../../../src/agents/index.js";

function request(
  overrides: Partial<ExternalAgentRunRequest> = {},
): ExternalAgentRunRequest {
  return {
    provider: GEMINI_CLI_PROVIDER,
    context: {} as ExternalAgentRunRequest["context"],
    instruction: "say hello",
    // Gemini CLI cannot keep the network off, so it runs only with network on.
    permissions: { mode: "ask", allowNetwork: true },
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
      "--prompt=say hello",
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

  test("a prompt that looks like a flag stays the prompt's value", () => {
    const args = buildGeminiArgs("--yolo");
    expect(args[0]).toBe("--prompt=--yolo");
    expect(args).not.toContain("--yolo");
  });

  test("maps permission presets without defaulting to yolo", () => {
    expect(buildGeminiArgs("prompt")).toEqual([
      "--prompt=prompt",
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
  test("parses the native stream-json schema (init/message/tool_use/tool_result/error/result)", () => {
    const driver = new GeminiCliDriver();
    const toolNames = new Map<string, string>();
    const parse = (value: unknown) =>
      driver.parseGeminiLine(JSON.stringify(value), toolNames);

    expect(
      parse({ type: "init", timestamp: "t", session_id: "s", model: "m" }),
    ).toBeUndefined();
    // The CLI echoes the user prompt as a message with role "user".
    expect(
      parse({ type: "message", role: "user", content: "SECRET PROMPT" }),
    ).toBeUndefined();
    expect(
      parse({ type: "message", role: "assistant", content: "hi", delta: true }),
    ).toMatchObject({ type: "output", content: "hi" });
    expect(
      parse({
        type: "tool_use",
        tool_name: "read_file",
        tool_id: "a1",
        parameters: { path: "x" },
      }),
    ).toMatchObject({
      type: "tool_call",
      name: "read_file",
      callId: "a1",
      input: { path: "x" },
    });
    expect(
      parse({
        type: "tool_result",
        tool_id: "a1",
        status: "success",
        output: "data",
      }),
    ).toMatchObject({
      type: "tool_result",
      name: "read_file",
      callId: "a1",
      result: "data",
      error: undefined,
    });
    expect(
      parse({
        type: "tool_result",
        tool_id: "a1",
        status: "error",
        error: { type: "x", message: "denied" },
      }),
    ).toMatchObject({ type: "tool_result", error: "denied" });
    expect(
      parse({ type: "error", severity: "warning", message: "loop" }),
    ).toMatchObject({ type: "error", recoverable: true });
    // The driver sends `completed` once the process exits.
    expect(parse({ type: "result", status: "success" })).toBeUndefined();
    expect(
      parse({
        type: "result",
        status: "error",
        error: { type: "quota", message: "out of quota" },
      }),
    ).toMatchObject({
      type: "error",
      message: "out of quota",
      code: "quota",
      recoverable: false,
    });
  });
});

describe("Gemini CLI prompt", () => {
  test("sends the ADK user turn after the instruction", async () => {
    const calls: Array<Parameters<GeminiCliSpawn>> = [];
    const spawn: GeminiCliSpawn = (command, args, options) => {
      calls.push([command, args, options]);
      return { stdout: [], exited: Promise.resolve(0) };
    };
    const driver = new GeminiCliDriver({ spawn, env: { PATH: "/bin" } });

    await collect(
      driver.run(
        request({
          context: {
            userContent: { role: "user", parts: [{ text: "list the files" }] },
          } as unknown as ExternalAgentRunRequest["context"],
        }),
      ),
    );

    expect(calls[0]?.[1][0]).toBe("--prompt=say hello\n\nlist the files");
  });
});

describe("Gemini CLI non-object JSON lines", () => {
  test("parseGeminiLine skips null, numbers and arrays", () => {
    const driver = new GeminiCliDriver();

    expect(driver.parseGeminiLine("null")).toBeUndefined();
    expect(driver.parseGeminiLine("7")).toBeUndefined();
    expect(driver.parseGeminiLine("[]")).toBeUndefined();
  });

  test("a null line does not end the run", async () => {
    const spawn: GeminiCliSpawn = () => ({
      stdout: [
        new TextEncoder().encode('null\n{"type":"content","text":"hi"}\n'),
      ],
      exited: Promise.resolve(0),
    });
    const driver = new GeminiCliDriver({ spawn, env: { PATH: "/bin" } });

    const events = await collect(driver.run(request()));

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "output",
      "completed",
    ]);
  });
});

describe("Gemini CLI bridge-shaped lines", () => {
  test("driver-owned events from the child are dropped", async () => {
    const lines = [
      { type: "completed", exitCode: "weird" },
      { type: "state_delta", stateDelta: { injected: true } },
      { type: "output", content: "hi", stream: "bogus" },
    ];
    const spawn: GeminiCliSpawn = () => ({
      stdout: [
        new TextEncoder().encode(
          lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
        ),
      ],
      exited: Promise.resolve(0),
    });
    const driver = new GeminiCliDriver({ spawn, env: { PATH: "/bin" } });

    const events = await collect(driver.run(request()));

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "output",
      "completed",
    ]);
    expect(events[1]).toEqual({ type: "output", content: "hi" });
    expect(events[2]).toMatchObject({ exitCode: 0 });
  });
});

describe("Gemini CLI exit errors", () => {
  test("a non-zero exit reports the stderr tail and classifies it", async () => {
    const spawn: GeminiCliSpawn = () => ({
      stdout: [],
      stderr: ["warming up\n", "Error: 401 Unauthorized\n"],
      exited: Promise.resolve(2),
    });
    const driver = new GeminiCliDriver({ spawn, env: { PATH: "/bin" } });

    const events = await collect(driver.run(request()));

    expect(events.filter((event) => event.type === "error")).toEqual([
      {
        type: "error",
        message: "warming up\nError: 401 Unauthorized",
        code: "GEMINI_CLI_EXIT",
        recoverable: false,
        timestamp: expect.any(Number),
      },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 2 });
  });

  test("an empty stderr keeps the generic message", async () => {
    const spawn: GeminiCliSpawn = () => ({
      stdout: [],
      exited: Promise.resolve(3),
    });
    const driver = new GeminiCliDriver({ spawn, env: { PATH: "/bin" } });

    const events = await collect(driver.run(request()));

    expect(events.find((event) => event.type === "error")).toMatchObject({
      message: "Gemini CLI exited with code 3",
      code: "GEMINI_CLI_EXIT",
      recoverable: true,
    });
  });
});
