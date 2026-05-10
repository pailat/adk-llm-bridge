import { describe, expect, test } from "bun:test";
import type { InvocationContext } from "@google/adk";
import {
  ExternalAgent,
  type ExternalAgentDriver,
  type ExternalAgentEvent,
  type ExternalAgentRunRequest,
} from "../../src/agents/index.js";
import { CODEX_PROVIDER } from "../../src/agents/provider/schema.js";

class StaticDriver implements ExternalAgentDriver {
  readonly providerId = CODEX_PROVIDER.id;

  constructor(private readonly events: ExternalAgentEvent[]) {}

  async *run(_request: ExternalAgentRunRequest): AsyncIterable<ExternalAgentEvent> {
    yield* this.events;
  }
}

async function collect(agent: ExternalAgent, context: Partial<InvocationContext> = {}) {
  const events = [];
  for await (const event of agent.runAsync({
    invocationId: "inv-1",
    branch: "root.external",
    ...context,
  } as InvocationContext)) {
    events.push(event);
  }
  return events;
}

describe("ExternalAgent ADK event formatting", () => {
  test("renders output as model text content with invocation metadata", async () => {
    const agent = new ExternalAgent({
      name: "codex_agent",
      provider: CODEX_PROVIDER,
      driver: new StaticDriver([{ type: "output", content: "Hello" }]),
    });

    const events = await collect(agent);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      invocationId: "inv-1",
      author: "codex_agent",
      branch: "root.external",
      content: { role: "model", parts: [{ text: "Hello" }] },
    });
  });

  test("does not render started or completed lifecycle events", async () => {
    const agent = new ExternalAgent({
      name: "codex_agent",
      provider: CODEX_PROVIDER,
      driver: new StaticDriver([
        { type: "started", providerId: "codex" },
        { type: "output", content: "Visible" },
        { type: "completed", exitCode: 0 },
      ]),
    });

    const events = await collect(agent);

    expect(events).toHaveLength(1);
    expect(events[0].content?.parts?.[0]?.text).toBe("Visible");
  });

  test("renders errors using ADK errorCode and errorMessage fields", async () => {
    const agent = new ExternalAgent({
      name: "codex_agent",
      provider: CODEX_PROVIDER,
      driver: new StaticDriver([
        {
          type: "error",
          code: "CODEX_ERROR",
          message: "Something failed",
          recoverable: true,
        },
      ]),
    });

    const events = await collect(agent);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      invocationId: "inv-1",
      author: "codex_agent",
      branch: "root.external",
      errorCode: "CODEX_ERROR",
      errorMessage: "Something failed",
    });
    expect(events[0].content).toBeUndefined();
  });

  test("renders tool calls as ADK functionCall parts", async () => {
    const agent = new ExternalAgent({
      name: "codex_agent",
      provider: CODEX_PROVIDER,
      driver: new StaticDriver([
        { type: "tool_call", name: "shell", input: { command: "pwd" } },
        { type: "tool_call", name: "raw", input: "value" },
      ]),
    });

    const events = await collect(agent);

    expect(events).toHaveLength(2);
    expect(events[0].content).toEqual({
      role: "model",
      parts: [{ functionCall: { name: "shell", args: { command: "pwd" } } }],
    });
    expect(events[1].content).toEqual({
      role: "model",
      parts: [{ functionCall: { name: "raw", args: { input: "value" } } }],
    });
  });
});
