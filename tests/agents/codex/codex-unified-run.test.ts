/**
 * The Codex CLI driver is a transport in front of the one run loop in
 * `CodexSdkDriver`. These tests pin the behavior that loop gives every
 * Codex run, whichever transport feeds it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  CODEX_PROVIDER,
  CodexCliDriver,
  type CodexCliSpawn,
  CodexSdkDriver,
  type ExternalAgentEvent,
  type ExternalAgentRunRequest,
} from "../../../src/agents/index.js";
import { noHostMcpServers } from "../helpers.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const INJECTED_SDK_RUN = { mode: "read-only", allowNetwork: true } as const;

async function* lines(values: readonly unknown[]): AsyncIterable<string> {
  for (const value of values) {
    yield `${typeof value === "string" ? value : JSON.stringify(value)}\n`;
  }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iterable) {
    result.push(item);
  }
  return result;
}

function historyContext(follow = "follow-up question") {
  return {
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
    userContent: { role: "user", parts: [{ text: follow }] },
  } as never;
}

function imageContext() {
  return {
    // A session makes the driver collect the turn's parts, images included.
    session: { events: [] },
    userContent: {
      role: "user",
      parts: [
        {
          inlineData: { mimeType: "image/png", data: PNG.toString("base64") },
        },
        { text: "describe it" },
      ],
    },
  } as never;
}

function request(
  overrides: Partial<ExternalAgentRunRequest> = {},
): ExternalAgentRunRequest {
  return {
    provider: CODEX_PROVIDER,
    context: { userContent: { parts: [{ text: "go" }] } } as never,
    workingDirectory: "/repo",
    ...overrides,
  };
}

function imageTempDirs(): string[] {
  return readdirSync(tmpdir()).filter((name) =>
    name.startsWith("codex-input-"),
  );
}

describe("the Codex CLI driver runs through the shared turn loop", () => {
  test("a cold-start turn carries the earlier history before the current turn", async () => {
    let prompt = "";
    const spawn: CodexCliSpawn = (_command, args) => {
      prompt = String(args.at(-1));
      return { stdout: lines([]), exited: Promise.resolve(0) };
    };
    await collect(
      new CodexCliDriver({ listMcpServers: noHostMcpServers, spawn }).run(
        request({ context: historyContext() }),
      ),
    );

    expect(prompt).toContain("first question");
    expect(prompt).toContain("earlier reply");
    expect(prompt).toContain("follow-up question");
    expect(prompt.indexOf("first question")).toBeLessThan(
      prompt.indexOf("follow-up question"),
    );
  });

  test("an image in the turn reaches codex as --image and its temp file is removed after the run", async () => {
    const before = imageTempDirs();
    let imageArg: string | undefined;
    let existedDuringRun = false;
    const spawn: CodexCliSpawn = (_command, args) => {
      imageArg = args.find((arg) => arg.startsWith("--image="));
      existedDuringRun = imageArg
        ? existsSync(imageArg.slice("--image=".length))
        : false;
      return {
        stdout: lines([{ type: "turn.completed" }]),
        exited: Promise.resolve(0),
      };
    };
    const events = await collect(
      new CodexCliDriver({ listMcpServers: noHostMcpServers, spawn }).run(
        request({ context: imageContext() }),
      ),
    );

    expect(imageArg).toBeDefined();
    expect(existedDuringRun).toBe(true);
    expect(existsSync((imageArg ?? "").slice("--image=".length))).toBe(false);
    expect(imageTempDirs()).toEqual(before);
    expect(events.filter((event) => event.type === "completed")).toHaveLength(
      1,
    );
  });

  test("a consumer that stops reading kills the process and removes the image temp directory", async () => {
    const before = imageTempDirs();
    const signals: Array<NodeJS.Signals | undefined> = [];
    let release: (code: number) => void = () => {};
    const spawn: CodexCliSpawn = () => ({
      stdout: (async function* () {
        yield `${JSON.stringify({ type: "thread.started", thread_id: "t" })}\n`;
        await new Promise(() => {});
      })(),
      exited: new Promise<number>((resolve) => {
        release = resolve;
      }),
      kill: (signal) => {
        signals.push(signal);
        release(143);
      },
    });
    const driver = new CodexCliDriver({
      listMcpServers: noHostMcpServers,
      spawn,
      killGraceMs: 10,
    });
    for await (const event of driver.run(
      request({ context: imageContext() }),
    )) {
      if (event.type === "started" && event.runId === "t") {
        break;
      }
    }

    expect(signals[0]).toBe("SIGTERM");
    expect(imageTempDirs()).toEqual(before);
  });

  test("the CLI driver keeps no thread state even when the context carries one", async () => {
    let args: readonly string[] = [];
    const spawn: CodexCliSpawn = (_command, spawned) => {
      args = spawned;
      return {
        stdout: lines([
          { type: "thread.started", thread_id: "fresh" },
          { type: "turn.completed" },
        ]),
        exited: Promise.resolve(0),
      };
    };
    const events = await collect(
      new CodexCliDriver({ listMcpServers: noHostMcpServers, spawn }).run(
        request({
          agent: { name: "codex" } as never,
          context: {
            agent: { name: "codex" },
            session: { state: { "codex_thread:codex": "saved" } },
            userContent: { parts: [{ text: "go" }] },
          } as never,
        }),
      ),
    );

    expect(events.some((event) => event.type === "state_delta")).toBe(false);
    expect(args).not.toContain("resume");
    expect(args.join(" ")).not.toContain("saved");
  });

  test("a runtime session is still refused before any process starts", async () => {
    let spawned = 0;
    const spawn: CodexCliSpawn = () => {
      spawned++;
      return { stdout: lines([]), exited: Promise.resolve(0) };
    };
    const events = await collect(
      new CodexCliDriver({ listMcpServers: noHostMcpServers, spawn }).run(
        request({ runtimeSession: { id: "thread-1" } as never }),
      ),
    );

    expect(spawned).toBe(0);
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "error",
      "completed",
    ]);
    expect(events[1]).toMatchObject({
      code: "EXTERNAL_AGENT_SESSIONS_UNSUPPORTED",
    });
  });

  test("a stderr line after a failed exit is one non-recoverable error, then one completed", async () => {
    const spawn: CodexCliSpawn = () => ({
      stdout: lines([{ type: "turn.started" }]),
      stderr: lines(["fatal: something broke"]),
      exited: Promise.resolve(2),
    });
    const events = await collect(
      new CodexCliDriver({ listMcpServers: noHostMcpServers, spawn }).run(
        request(),
      ),
    );

    expect(events.filter((event) => event.type === "error")).toEqual([
      { type: "error", message: "fatal: something broke", recoverable: false },
    ]);
    expect(events.filter((event) => event.type === "completed")).toEqual([
      { type: "completed", exitCode: 2, timestamp: expect.any(Number) },
    ]);
  });

  test("the CLI facade never imports the optional SDK package", async () => {
    const source = await Bun.file(
      new URL("../../../src/agents/driver/codex-cli.ts", import.meta.url)
        .pathname,
    ).text();

    expect(source).not.toMatch(
      /(from\s+|import\()\s*["']@openai\/codex-sdk["']/,
    );
  });
});

describe("one error event per failure, on every transport", () => {
  async function sdkRun(events: readonly Record<string, unknown>[]) {
    const driver = new CodexSdkDriver({
      sdk: {
        startThread: () => ({
          runStreamed: async () => ({
            events: (async function* () {
              yield* events;
            })(),
          }),
        }),
        resumeThread: () => {
          throw new Error("not used");
        },
      },
    });
    return collect(driver.run(request({ permissions: INJECTED_SDK_RUN })));
  }

  async function cliRun(events: readonly Record<string, unknown>[]) {
    const spawn: CodexCliSpawn = () => ({
      stdout: lines(events),
      exited: Promise.resolve(1),
    });
    return collect(
      new CodexCliDriver({ listMcpServers: noHostMcpServers, spawn }).run(
        request(),
      ),
    );
  }

  const errors = (events: ExternalAgentEvent[]) =>
    events.filter((event) => event.type === "error");

  for (const [name, run] of [
    ["SDK transport", sdkRun],
    ["CLI transport", cliRun],
  ] as const) {
    test(`${name}: a stream error and a turn.failed with another message are both reported, in order`, async () => {
      const events = await run([
        { type: "error", message: "stream broke" },
        { type: "turn.failed", error: { message: "turn gave up" } },
      ]);

      expect(
        errors(events).map((event) => (event as { message: string }).message),
      ).toEqual(["stream broke", "turn gave up"]);
      expect(events.filter((event) => event.type === "completed")).toHaveLength(
        1,
      );
    });

    test(`${name}: the same message twice is reported once`, async () => {
      const message = "You've hit your usage limit. Try again later.";
      const events = await run([
        { type: "error", message },
        { type: "turn.failed", error: { message } },
      ]);

      expect(errors(events)).toHaveLength(1);
      expect(errors(events)[0]).toMatchObject({
        code: "QUOTA_EXHAUSTED",
        recoverable: false,
      });
    });
  }

  test("temporary image files are removed when the thread run fails", async () => {
    const before = imageTempDirs();
    const driver = new CodexSdkDriver({
      sdk: {
        startThread: () => ({
          runStreamed: async () => {
            throw new Error("exec exploded");
          },
        }),
        resumeThread: () => {
          throw new Error("not used");
        },
      },
    });
    const events = await collect(
      driver.run(
        request({ context: imageContext(), permissions: INJECTED_SDK_RUN }),
      ),
    );

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "error",
      "completed",
    ]);
    expect(imageTempDirs()).toEqual(before);
  });
});
