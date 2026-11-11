import { describe, expect, test } from "bun:test";
import { ClaudeAgentSdkDriver } from "../../../src/agents/driver/claude-agent-sdk.js";
import { EXTERNAL_AGENT_NO_TURN } from "../../../src/agents/driver/policy-errors.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/schema.js";

// Claude Code writes a "model-less" result (success, num_turns 0, result "")
// when display rows reach the host while no turn is under way and its input
// queue is empty. On a resumed session this can happen before the new user
// message is queued; the turn that runs the message follows in the same
// query with its own result. A driver that stops at the first result ends
// the run before the input was worked on.

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

describe("Claude Agent SDK: a model-less result does not end the run", () => {
  test("a resumed run reads past the model-less result and reports the real turn", async () => {
    const fake = new FakeSdk();
    const driver = fake.driver();
    fake.scripts.push({
      messages: [
        init("sdk-1"),
        assistant("sdk-1", "one"),
        result("sdk-1", "one", 0.25),
      ],
    });
    fake.scripts.push({
      messages: [
        init("sdk-1"),
        modelLess("sdk-1", 0.25),
        assistant("sdk-1", "two"),
        result("sdk-1", "two", 0.5),
      ],
    });
    await run(driver, "first");
    const events = await run(driver, "second");

    expect(fake.resumes).toEqual([undefined, "sdk-1"]);
    expect(fake.prompts[1]).toContain("second");
    expect(outputs(events)).toEqual(["two"]);
    const completed = completedOf(events);
    expect(completed).toHaveLength(1);
    expect(completed[0].exitCode).toBe(0);
    expect(completed[0].numTurns).toBe(1);
    // The delta of the real turn, not the model-less result's session total.
    expect(completed[0].usage?.totalCostUsd).toBe(0.25);
    expect(completed[0].usage?.scope).toBe("run");
    expect(errorsOf(events)).toEqual([]);
  });

  test("a first run reads past a model-less result too", async () => {
    const fake = new FakeSdk();
    fake.scripts.push({
      messages: [
        init("sdk-1"),
        modelLess("sdk-1", 0),
        assistant("sdk-1", "hello"),
        result("sdk-1", "hello", 0.25),
      ],
    });
    const events = await run(fake.driver(), "hi");
    expect(outputs(events)).toEqual(["hello"]);
    expect(completedOf(events).map((e) => e.exitCode)).toEqual([0]);
  });

  test("a run that ends after only model-less results fails with EXTERNAL_AGENT_NO_TURN", async () => {
    const fake = new FakeSdk();
    const driver = fake.driver();
    fake.scripts.push({
      messages: [
        init("sdk-1"),
        assistant("sdk-1", "one"),
        result("sdk-1", "one", 0.25),
      ],
    });
    fake.scripts.push({
      messages: [
        init("sdk-1"),
        modelLess("sdk-1", 0.25),
        modelLess("sdk-1", 0.25),
      ],
    });
    await run(driver, "first");
    const events = await run(driver, "second");

    expect(outputs(events)).toEqual([]);
    const errors = errorsOf(events);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe(EXTERNAL_AGENT_NO_TURN);
    expect(errors[0].recoverable).toBe(true);
    expect(errors[0].message).toContain("sdk-1");
    const completed = completedOf(events);
    expect(completed).toHaveLength(1);
    expect(completed[0].exitCode).toBe(1);
    // Nothing ran: no usage is charged to this run.
    expect(completed[0].usage).toBeUndefined();
  });

  test("the next resume after a model-less-only run still resumes the same session", async () => {
    const fake = new FakeSdk();
    const driver = fake.driver();
    fake.scripts.push({
      messages: [
        init("sdk-1"),
        assistant("sdk-1", "one"),
        result("sdk-1", "one", 0.25),
      ],
    });
    fake.scripts.push({ messages: [init("sdk-1"), modelLess("sdk-1", 0.25)] });
    fake.scripts.push({
      messages: [
        init("sdk-1"),
        assistant("sdk-1", "three"),
        result("sdk-1", "three", 0.5),
      ],
    });
    await run(driver, "first");
    await run(driver, "second");
    const events = await run(driver, "third");
    expect(fake.resumes).toEqual([undefined, "sdk-1", "sdk-1"]);
    // The baseline is the last real result (0.25), not the model-less one.
    expect(completedOf(events)[0].usage?.totalCostUsd).toBe(0.25);
    expect(outputs(events)).toEqual(["three"]);
  });

  test("a real result stays terminal: the driver does not wait for another message", async () => {
    const fake = new FakeSdk();
    fake.scripts.push({
      messages: [
        init("sdk-1"),
        modelLess("sdk-1", 0),
        assistant("sdk-1", "x"),
        result("sdk-1", "x", 0.25),
      ],
      hang: true,
    });
    const events = await run(fake.driver(), "hi");
    expect(completedOf(events).map((e) => e.exitCode)).toEqual([0]);
    expect(fake.reads).toEqual([4]);
  });

  test("a zero-turn success that carries text is a real result and ends the run", async () => {
    const fake = new FakeSdk();
    fake.scripts.push({
      messages: [init("sdk-1"), result("sdk-1", "local command output", 0, 0)],
      hang: true,
    });
    const events = await run(fake.driver(), "/cost");
    expect(outputs(events)).toEqual(["local command output"]);
    expect(completedOf(events).map((e) => e.exitCode)).toEqual([0]);
  });

  test("a zero-turn error result is terminal and keeps its own error", async () => {
    const fake = new FakeSdk();
    fake.scripts.push({
      messages: [
        init("sdk-1"),
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          num_turns: 0,
          errors: ["boom"],
          session_id: "sdk-1",
        },
      ],
      hang: true,
    });
    const events = await run(fake.driver(), "hi");
    const errors = errorsOf(events);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).not.toBe(EXTERNAL_AGENT_NO_TURN);
    expect(completedOf(events).map((e) => e.exitCode)).toEqual([1]);
  });

  test("a model-less result after the model already answered is terminal (no pointer mid-turn)", async () => {
    const fake = new FakeSdk();
    fake.scripts.push({
      messages: [
        init("sdk-1"),
        assistant("sdk-1", "said"),
        modelLess("sdk-1", 0.25),
      ],
      hang: true,
    });
    const events = await run(fake.driver(), "hi");
    expect(outputs(events)).toEqual(["said"]);
    expect(completedOf(events).map((e) => e.exitCode)).toEqual([0]);
  });

  test("a turn result with empty text (num_turns 1) is terminal", async () => {
    const fake = new FakeSdk();
    fake.scripts.push({
      messages: [init("sdk-1"), { ...result("sdk-1", "", 0.25), num_turns: 1 }],
      hang: true,
    });
    const events = await run(fake.driver(), "hi");
    expect(completedOf(events).map((e) => e.exitCode)).toEqual([0]);
    expect(errorsOf(events)).toEqual([]);
    expect(fake.reads).toEqual([2]);
  });

  test("a zero-turn success flagged is_error with empty text is terminal", async () => {
    const fake = new FakeSdk();
    fake.scripts.push({
      messages: [init("sdk-1"), { ...modelLess("sdk-1", 0), is_error: true }],
      hang: true,
    });
    const events = await run(fake.driver(), "hi");
    expect(completedOf(events)).toHaveLength(1);
    expect(errorsOf(events).map((e) => e.code)).not.toContain(
      EXTERNAL_AGENT_NO_TURN,
    );
    expect(fake.reads).toEqual([2]);
  });

  for (const first of [
    {
      kind: "user",
      message: {
        type: "user",
        session_id: "sdk-1",
        parent_tool_use_id: null,
        message: { role: "user", content: "echo" },
      },
    },
    {
      kind: "stream_event",
      message: {
        type: "stream_event",
        session_id: "sdk-1",
        parent_tool_use_id: null,
        event: { type: "message_start" },
      },
    },
  ]) {
    test(`a ${first.kind} message counts as turn activity: a later model-less result is terminal`, async () => {
      const fake = new FakeSdk();
      fake.scripts.push({
        messages: [init("sdk-1"), first.message, modelLess("sdk-1", 0)],
        hang: true,
      });
      const events = await run(fake.driver(), "hi");
      expect(completedOf(events)).toHaveLength(1);
      expect(fake.reads).toEqual([3]);
    });
  }
});
