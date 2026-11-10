import { describe, expect, test } from "bun:test";
import {
  InMemorySessionService,
  Runner,
  ToolCallIntegrityPlugin,
} from "@google/adk";
import {
  ExternalAgent,
  type ExternalAgentDriver,
  type ExternalAgentEvent,
} from "../../src/agents/index.js";
import { CODEX_PROVIDER } from "../../src/agents/provider/schema.js";

const HMAC_KEY = "__adk_internal_fc_hmac";

class ScriptedDriver implements ExternalAgentDriver {
  readonly providerId = CODEX_PROVIDER.id;

  constructor(private readonly events: ExternalAgentEvent[]) {}

  async *run(): AsyncIterable<ExternalAgentEvent> {
    yield* this.events;
  }
}

async function runTurn(
  events: ExternalAgentEvent[],
  options: { allowUnstampedCalls?: boolean; turns?: number } = {},
) {
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: "app",
    userId: "user",
  });
  const agent = new ExternalAgent({
    name: "external",
    provider: CODEX_PROVIDER,
    driver: new ScriptedDriver(events),
  });
  const runner = new Runner({
    appName: "app",
    agent,
    sessionService,
    plugins: [
      new ToolCallIntegrityPlugin({
        secretKey: new TextEncoder().encode("test-secret"),
        allowUnstampedCalls: options.allowUnstampedCalls,
      }),
    ],
  });
  const streamed = [];
  for (let turn = 0; turn < (options.turns ?? 1); turn++) {
    for await (const event of runner.runAsync({
      userId: "user",
      sessionId: session.id,
      newMessage: { role: "user", parts: [{ text: `turn ${turn}` }] },
    })) {
      streamed.push(event);
    }
  }
  return streamed;
}

describe("ExternalAgent with ADK ToolCallIntegrityPlugin", () => {
  test("stamps function calls that carry a callId", async () => {
    const streamed = await runTurn([
      { type: "tool_call", callId: "call-1", name: "shell", input: {} },
      { type: "tool_result", callId: "call-1", name: "shell", result: "ok" },
      { type: "output", content: "done" },
    ]);

    const call = streamed.find((e) => e.content?.parts?.[0]?.functionCall);
    expect(call?.customMetadata?.[HMAC_KEY]).toHaveProperty("call-1");
  });

  test("does not reject function calls without an id and leaves them unstamped", async () => {
    const streamed = await runTurn(
      [
        { type: "tool_call", name: "shell", input: { command: "ls" } },
        { type: "tool_result", name: "shell", result: "ok" },
        { type: "output", content: "done" },
      ],
      { turns: 2 },
    );

    const calls = streamed.filter((e) => e.content?.parts?.[0]?.functionCall);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.customMetadata?.[HMAC_KEY]).toBeUndefined();
      expect(call.content?.parts?.[0]?.functionCall?.id).toBeUndefined();
    }
  });

  test("a second turn verifies the stamps written by the first", async () => {
    let turn = 0;
    const driver: ExternalAgentDriver = {
      providerId: CODEX_PROVIDER.id,
      async *run() {
        turn += 1;
        yield {
          type: "tool_call",
          callId: `call-${turn}`,
          name: "shell",
          input: {},
        };
        yield { type: "output", content: `done ${turn}` };
      },
    };
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: "app",
      userId: "user",
    });
    const runner = new Runner({
      appName: "app",
      agent: new ExternalAgent({
        name: "external",
        provider: CODEX_PROVIDER,
        driver,
      }),
      sessionService,
      plugins: [
        new ToolCallIntegrityPlugin({
          secretKey: new TextEncoder().encode("test-secret"),
        }),
      ],
    });

    const texts: string[] = [];
    for (let i = 0; i < 2; i++) {
      for await (const event of runner.runAsync({
        userId: "user",
        sessionId: session.id,
        newMessage: { role: "user", parts: [{ text: `turn ${i}` }] },
      })) {
        const text = event.content?.parts?.[0]?.text;
        if (text) texts.push(text);
      }
    }

    expect(texts).toEqual(["done 1", "done 2"]);
  });
});
