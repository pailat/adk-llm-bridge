import { describe, expect, test } from "bun:test";
import { ClaudeAgentSdkDriver } from "../../../src/agents/driver/claude-agent-sdk.js";
import {
  EXTERNAL_AGENT_NO_RESULT,
  EXTERNAL_AGENT_NO_TURN,
} from "../../../src/agents/driver/policy-errors.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/schema.js";

// A Claude Agent SDK stream that ends with no result message at all is a run
// that was cut off (the child died, the pipe closed): the driver must not
// report it as a clean exit 0.

const MODEL = "claude-haiku-5-5";

type Message = Record<string, unknown>;

function init(sessionId: string): Message {
  return {
    type: "system",
    subtype: "init",
    model: MODEL,
    session_id: sessionId,
    tools: [],
    mcp_servers: [],
  };
}

/** The CLI's model-less result: the session total, zero usage, no text. */
function modelLess(sessionId: string, totalCost: number): Message {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 0,
    result: "",
    session_id: sessionId,
    duration_ms: 0,
    total_cost_usd: totalCost,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {
      [MODEL]: { inputTokens: 10, outputTokens: 4, costUSD: totalCost },
    },
  };
}

function assistant(sessionId: string, text: string): Message {
  return {
    type: "assistant",
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: "assistant",
      model: MODEL,
      content: [{ type: "text", text }],
    },
  };
}

function result(
  sessionId: string,
  text: string,
  totalCost: number,
  turns = 1,
): Message {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: turns,
    result: text,
    session_id: sessionId,
    duration_ms: 5,
    total_cost_usd: totalCost,
    modelUsage: {
      [MODEL]: {
        inputTokens: 10 * Math.round(totalCost / 0.25),
        outputTokens: 4 * Math.round(totalCost / 0.25),
        costUSD: totalCost,
      },
    },
  };
}

interface Script {
  messages: Message[];
  /** Keep the iterator pending after the last message (never ends). */
  hang?: boolean;
  /** Aborted when the first message is handed out. */
  abortOnFirst?: AbortController;
}

/** A fake Agent SDK that plays one script per query() call. */
class FakeSdk {
  readonly scripts: Script[] = [];
  readonly resumes: Array<string | undefined> = [];
  readonly prompts: string[] = [];
  /** How many messages each query handed out. */
  readonly reads: number[] = [];

  readonly sdk = {
    query: ({
      prompt,
      options,
    }: {
      prompt: unknown;
      options: Record<string, unknown>;
    }) => {
      this.resumes.push(
        typeof options.resume === "string" ? options.resume : undefined,
      );
      const script = this.scripts.shift() ?? { messages: [] };
      const index = this.reads.push(0) - 1;
      const reads = this.reads;
      const prompts = this.prompts;
      const iterator = (async function* () {
        prompts.push(await promptText(prompt));
        for (const message of script.messages) {
          reads[index]++;
          yield message;
          script.abortOnFirst?.abort();
        }
        if (script.hang) {
          await new Promise(() => {});
        }
      })();
      return Object.assign(iterator, {
        interrupt: async () => {},
        close: () => {},
      });
    },
    tool: (name: string) => ({ name }),
    createSdkMcpServer: (config: Record<string, unknown>) => config,
  };

  driver(): ClaudeAgentSdkDriver {
    return new ClaudeAgentSdkDriver({ sdk: this.sdk as never, model: MODEL });
  }
}

async function promptText(prompt: unknown): Promise<string> {
  if (typeof prompt === "string") return prompt;
  const texts: string[] = [];
  for await (const message of prompt as AsyncIterable<Message>) {
    const content = (message.message as { content?: unknown })?.content;
    if (typeof content === "string") texts.push(content);
    else if (Array.isArray(content))
      for (const block of content as Array<{ text?: string }>)
        if (typeof block.text === "string") texts.push(block.text);
  }
  return texts.join("\n");
}

async function run(
  driver: ClaudeAgentSdkDriver,
  input: string,
  abortSignal?: AbortSignal,
): Promise<ExternalAgentEvent[]> {
  const events: ExternalAgentEvent[] = [];
  for await (const event of driver.run({
    provider: CLAUDE_PROVIDER,
    context: {
      session: {
        id: "adk-1",
        state: {},
        events: [
          {
            author: "user",
            content: { role: "user", parts: [{ text: input }] },
          },
        ],
      },
    } as never,
    workingDirectory: "/repo",
    ...(abortSignal ? { abortSignal } : {}),
  })) {
    events.push(event);
  }
  return events;
}

const outputs = (events: ExternalAgentEvent[]) =>
  events.flatMap((e) => (e.type === "output" ? [e.content] : []));
const completedOf = (events: ExternalAgentEvent[]) =>
  events.filter(
    (e): e is Extract<ExternalAgentEvent, { type: "completed" }> =>
      e.type === "completed",
  );
const errorsOf = (events: ExternalAgentEvent[]) =>
  events.filter(
    (e): e is Extract<ExternalAgentEvent, { type: "error" }> =>
      e.type === "error",
  );

describe("Claude Agent SDK: a stream that ends with no result message fails typed", () => {
  test("a stream that ends after assistant text, with no result, ends with exit code 1", async () => {
    const fake = new FakeSdk();
    fake.scripts.push({
      messages: [init("sdk-1"), assistant("sdk-1", "half an answer")],
    });
    const events = await run(fake.driver(), "do it");
    expect(outputs(events)).toEqual(["half an answer"]);
    const errors = errorsOf(events);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe(EXTERNAL_AGENT_NO_RESULT);
    expect(errors[0].recoverable).toBe(true);
    const done = completedOf(events);
    expect(done).toHaveLength(1);
    expect(done[0].exitCode).toBe(1);
    expect(events.at(-1)?.type).toBe("completed");
  });

  test("a stream with no message at all fails with the same code", async () => {
    const fake = new FakeSdk();
    fake.scripts.push({ messages: [] });
    const events = await run(fake.driver(), "do it");
    expect(errorsOf(events).map((e) => e.code)).toEqual([
      EXTERNAL_AGENT_NO_RESULT,
    ]);
    expect(completedOf(events).map((e) => e.exitCode)).toEqual([1]);
  });

  test("a stream with only an init message fails with the same code", async () => {
    const fake = new FakeSdk();
    fake.scripts.push({ messages: [init("sdk-1")] });
    const events = await run(fake.driver(), "do it");
    expect(errorsOf(events).map((e) => e.code)).toEqual([
      EXTERNAL_AGENT_NO_RESULT,
    ]);
    expect(completedOf(events).map((e) => e.exitCode)).toEqual([1]);
  });

  test("a fresh run's no-result error names the session its init reported", async () => {
    const fake = new FakeSdk();
    fake.scripts.push({
      messages: [init("sdk-fresh-7"), assistant("sdk-fresh-7", "partial")],
    });
    const events = await run(fake.driver(), "do it");
    expect(fake.resumes).toEqual([undefined]);
    const errors = errorsOf(events);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe(EXTERNAL_AGENT_NO_RESULT);
    expect(errors[0].message).toContain("sdk-fresh-7");
  });

  test("a resumed run's no-result error still names its session", async () => {
    const fake = new FakeSdk();
    fake.scripts.push({
      messages: [
        init("sdk-1"),
        assistant("sdk-1", "one"),
        result("sdk-1", "one", 0.25),
      ],
    });
    fake.scripts.push({ messages: [] });
    const driver = fake.driver();
    await run(driver, "first");
    const events = await run(driver, "second");
    expect(fake.resumes[1]).toBe("sdk-1");
    const errors = errorsOf(events);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe(EXTERNAL_AGENT_NO_RESULT);
    expect(errors[0].message).toContain("sdk-1");
  });

  test("a stream that ends after only model-less results keeps its own code", async () => {
    const fake = new FakeSdk();
    fake.scripts.push({ messages: [init("sdk-1"), modelLess("sdk-1", 0.25)] });
    const events = await run(fake.driver(), "do it");
    expect(errorsOf(events).map((e) => e.code)).toEqual([
      EXTERNAL_AGENT_NO_TURN,
    ]);
    expect(completedOf(events).map((e) => e.exitCode)).toEqual([1]);
  });

  test("an aborted run whose stream then ends cleanly gets no NO_RESULT error", async () => {
    const fake = new FakeSdk();
    const controller = new AbortController();
    fake.scripts.push({
      messages: [init("sdk-1"), assistant("sdk-1", "partial")],
      abortOnFirst: controller,
    });
    const events = await run(fake.driver(), "do it", controller.signal);
    expect(controller.signal.aborted).toBe(true);
    expect(errorsOf(events)).toEqual([]);
    expect(completedOf(events)).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("completed");
  });

  test("a stream with a real result is a clean exit 0 and no error", async () => {
    const fake = new FakeSdk();
    fake.scripts.push({
      messages: [
        init("sdk-1"),
        assistant("sdk-1", "done"),
        result("sdk-1", "done", 0.25),
      ],
    });
    const events = await run(fake.driver(), "do it");
    expect(errorsOf(events)).toEqual([]);
    expect(completedOf(events).map((e) => e.exitCode)).toEqual([0]);
  });
});
