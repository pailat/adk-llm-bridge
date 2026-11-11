/**
 * The Codex SDK passes the thread id to resume as its own argv entry after
 * `resume`, and `codex exec resume` reads an entry that starts with `-` as
 * an option. A thread id that starts with `-` is refused before the SDK
 * resumes anything, whether it comes from `runtimeSession.id` or from
 * session state.
 */

import { describe, expect, test } from "bun:test";
import { EXTERNAL_AGENT_OPTION_UNSUPPORTED } from "../../../src/agents/driver/policy-errors.js";
import {
  CODEX_PROVIDER,
  CodexSdkDriver,
  type ExternalAgentEvent,
  type ExternalAgentRunRequest,
} from "../../../src/agents/index.js";

async function* sdkEvents(events: readonly Record<string, unknown>[]) {
  for (const event of events) {
    yield event;
  }
}

interface Calls {
  started: number;
  resumed: string[];
}

function codexDriver(calls: Calls): CodexSdkDriver {
  const thread = (id: string | null) =>
    ({
      id,
      runStreamed: async () => ({
        events: sdkEvents([
          { type: "turn.completed", usage: { input_tokens: 1 } },
        ]),
      }),
    }) as never;
  return new CodexSdkDriver({
    sdk: {
      startThread: () => {
        calls.started++;
        return thread(null);
      },
      resumeThread: (id) => {
        calls.resumed.push(id);
        return thread(id);
      },
    },
  });
}

function request(
  state: Record<string, unknown>,
  runtimeSession?: { id: string },
): ExternalAgentRunRequest {
  return {
    provider: CODEX_PROVIDER,
    agent: { name: "codex" } as never,
    context: {
      agent: { name: "codex" },
      session: { state, events: [] },
      userContent: { role: "user", parts: [{ text: "go" }] },
    } as never,
    // An injected sdk client keeps its host MCP servers, so the run opts
    // into the network (it is off unless allowNetwork is true).
    permissions: { mode: "read-only", allowNetwork: true },
    ...(runtimeSession ? { runtimeSession } : {}),
  };
}

async function drain(
  driver: CodexSdkDriver,
  runRequest: ExternalAgentRunRequest,
): Promise<ExternalAgentEvent[]> {
  const events: ExternalAgentEvent[] = [];
  for await (const event of driver.run(runRequest)) events.push(event);
  return events;
}

const FLAG_IDS = [
  "--dangerously-bypass-approvals-and-sandbox",
  "--model=gpt-x",
  "-mgpt-x",
  "--ignore-rules",
  "-",
  "--",
];

describe("CodexSdkDriver refuses a thread id that starts with '-'", () => {
  for (const id of FLAG_IDS) {
    for (const source of ["runtimeSession", "session state"] as const) {
      test(`${JSON.stringify(id)} from ${source}`, async () => {
        const calls: Calls = { started: 0, resumed: [] };
        const events = await drain(
          codexDriver(calls),
          source === "runtimeSession"
            ? request({}, { id })
            : request({ "codex_thread:codex": id }),
        );
        expect(calls).toEqual({ started: 0, resumed: [] });
        expect(events.map((event) => event.type)).toEqual([
          "started",
          "error",
          "completed",
        ]);
        const error = events[1] as Extract<
          ExternalAgentEvent,
          { type: "error" }
        >;
        expect(error.code).toBe(EXTERNAL_AGENT_OPTION_UNSUPPORTED);
        expect(error.recoverable).toBe(false);
        expect(error.message).toContain("starts with '-'");
        expect(events[2]).toMatchObject({ type: "completed", exitCode: 1 });
      });
    }
  }

  test("an explicit id that is not a flag wins over a saved flag", async () => {
    const calls: Calls = { started: 0, resumed: [] };
    await drain(
      codexDriver(calls),
      request(
        { "codex_thread:codex": "--yolo" },
        { id: "019a0000-0000-7000-8000-000000000001" },
      ),
    );
    expect(calls.resumed).toEqual(["019a0000-0000-7000-8000-000000000001"]);
  });

  for (const id of [
    "019a0000-0000-7000-8000-000000000001",
    "thread-name",
    "a-",
  ]) {
    test(`resumes ${JSON.stringify(id)}`, async () => {
      const calls: Calls = { started: 0, resumed: [] };
      const events = await drain(
        codexDriver(calls),
        request({ "codex_thread:codex": id }),
      );
      expect(calls.resumed).toEqual([id]);
      expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 0 });
    });
  }
});
