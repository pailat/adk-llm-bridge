import { describe, expect, test } from "bun:test";
import { ClaudeCliDriver } from "../../../src/agents/driver/claude-cli.js";
import { CodexCliDriver } from "../../../src/agents/driver/codex-cli.js";
import { GeminiCliDriver } from "../../../src/agents/driver/gemini-cli.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import type { ExternalAgentRunRequest } from "../../../src/agents/external-agent-driver.js";
import { CODEX_PROVIDER } from "../../../src/agents/provider/codex.js";
import { GEMINI_CLI_PROVIDER } from "../../../src/agents/provider/gemini-cli.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/schema.js";
import { withDeadline } from "../helpers.js";

/**
 * A controllable fake CLI process: the test pushes stdout lines, and the
 * process only ends when the test finishes it or the driver kills it.
 */
function fakeProcess() {
  const encoder = new TextEncoder();
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  let stderrController!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller;
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      stderrController = controller;
    },
  });
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const state = { kills: 0, spawned: 0, done: false };

  const end = (code: number) => {
    if (state.done) return;
    state.done = true;
    for (const controller of [stdoutController, stderrController]) {
      try {
        controller.close();
      } catch {
        // The reader already cancelled this stream.
      }
    }
    resolveExit(code);
  };

  return {
    state,
    spawn: () => {
      state.spawned++;
      return {
        stdout,
        stderr,
        exited,
        kill: () => {
          state.kills++;
          end(143);
        },
      };
    },
    push(line: unknown) {
      stdoutController.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
    },
    finish() {
      end(0);
    },
  };
}

type Fake = ReturnType<typeof fakeProcess>;

interface DriverCase {
  name: string;
  provider: ExternalAgentRunRequest["provider"];
  create(fake: Fake): {
    run(request: ExternalAgentRunRequest): AsyncIterable<ExternalAgentEvent>;
  };
  outputLine: unknown;
}

const CASES: DriverCase[] = [
  {
    name: "ClaudeCliDriver",
    provider: CLAUDE_PROVIDER,
    create: (fake) => new ClaudeCliDriver({ spawn: fake.spawn, env: {} }),
    outputLine: {
      type: "assistant",
      message: { content: [{ type: "text", text: "working" }] },
    },
  },
  {
    name: "CodexCliDriver",
    provider: CODEX_PROVIDER,
    create: (fake) => new CodexCliDriver({ spawn: fake.spawn, env: {} }),
    outputLine: {
      type: "item.completed",
      item: { id: "m1", type: "agent_message", text: "working" },
    },
  },
  {
    name: "GeminiCliDriver",
    provider: GEMINI_CLI_PROVIDER,
    create: (fake) => new GeminiCliDriver({ spawn: fake.spawn, env: {} }),
    outputLine: { type: "message", role: "assistant", content: "working" },
  },
];

function request(
  provider: ExternalAgentRunRequest["provider"],
  extra: Partial<ExternalAgentRunRequest> = {},
): ExternalAgentRunRequest {
  return {
    provider,
    context: { userContent: { parts: [{ text: "go" }] } } as never,
    instruction: "go",
    ...extra,
  };
}

/** Reads events until the first `output` event. */
async function untilOutput(
  iterator: AsyncIterator<ExternalAgentEvent>,
): Promise<ExternalAgentEvent[]> {
  const seen: ExternalAgentEvent[] = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) {
      throw new Error(`stream ended before output: ${JSON.stringify(seen)}`);
    }
    seen.push(next.value);
    if (next.value.type === "output") {
      return seen;
    }
  }
}

describe.each(CASES)("$name subprocess lifecycle", (driverCase) => {
  test("aborting mid-stream kills the process and ends the run", async () => {
    const fake = fakeProcess();
    const controller = new AbortController();
    const iterator = driverCase
      .create(fake)
      .run(request(driverCase.provider, { abortSignal: controller.signal }))
      [Symbol.asyncIterator]();

    fake.push(driverCase.outputLine);
    await untilOutput(iterator);

    controller.abort();
    const rest: ExternalAgentEvent[] = [];
    await withDeadline(
      (async () => {
        while (true) {
          const next = await iterator.next();
          if (next.done) return;
          rest.push(next.value);
        }
      })(),
      2000,
      "run did not end after abort",
    );

    expect(fake.state.kills).toBe(1);
    // The aborted run ends silently: no exit error, no completion.
    expect(rest).toEqual([]);
  });

  test("an abort on the ADK context signal is honored too", async () => {
    const fake = fakeProcess();
    const controller = new AbortController();
    const iterator = driverCase
      .create(fake)
      .run({
        provider: driverCase.provider,
        context: {
          userContent: { parts: [{ text: "go" }] },
          abortSignal: controller.signal,
        } as never,
        instruction: "go",
      })
      [Symbol.asyncIterator]();

    fake.push(driverCase.outputLine);
    await untilOutput(iterator);
    controller.abort();
    await withDeadline(
      (async () => {
        while (!(await iterator.next()).done) {}
      })(),
      2000,
      "run did not end after context abort",
    );

    expect(fake.state.kills).toBe(1);
  });

  test("abandoning the generator (iterator.return()) kills the process", async () => {
    const fake = fakeProcess();
    const iterator = driverCase
      .create(fake)
      .run(request(driverCase.provider))
      [Symbol.asyncIterator]();

    fake.push(driverCase.outputLine);
    await untilOutput(iterator);
    await withDeadline(
      iterator.return?.() ?? Promise.resolve(),
      2000,
      "iterator.return() hung",
    );

    expect(fake.state.kills).toBe(1);
  });

  test("normal completion does not kill the process", async () => {
    const fake = fakeProcess();
    const iterator = driverCase
      .create(fake)
      .run(request(driverCase.provider))
      [Symbol.asyncIterator]();

    fake.push(driverCase.outputLine);
    await untilOutput(iterator);
    fake.finish();

    const rest: ExternalAgentEvent[] = [];
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      rest.push(next.value);
    }

    expect(fake.state.kills).toBe(0);
    expect(rest.at(-1)).toMatchObject({ type: "completed", exitCode: 0 });
  });

  test("an already-aborted signal does not spawn the process", async () => {
    const fake = fakeProcess();
    const events: ExternalAgentEvent[] = [];
    for await (const event of driverCase
      .create(fake)
      .run(
        request(driverCase.provider, { abortSignal: AbortSignal.abort() }),
      )) {
      events.push(event);
    }

    expect(fake.state.spawned).toBe(0);
    expect(events.some((event) => event.type === "completed")).toBe(false);
  });
});
