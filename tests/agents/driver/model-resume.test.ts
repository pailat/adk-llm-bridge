/**
 * A resumed Codex thread or Claude session runs the driver's model, not the
 * model the session started with or the runtime default.
 */

import { describe, expect, test } from "bun:test";
import type { InvocationContext } from "@google/adk";
import {
  CLAUDE_PROVIDER,
  ClaudeAgentSdkDriver,
  CODEX_PROVIDER,
  CodexSdkDriver,
  claudeSdkSessionStateKey,
  type ExternalAgentEvent,
} from "../../../src/agents/index.js";

async function drain(events: AsyncIterable<ExternalAgentEvent>) {
  for await (const _event of events) {
    // drain
  }
}

describe("Codex SDK driver", () => {
  test("sends the model on start and on resume", async () => {
    const calls: { kind: string; model: unknown }[] = [];
    const thread = {
      id: "t1",
      runStreamed: async () => ({
        events: (async function* () {
          yield { type: "turn.completed", usage: { input_tokens: 1 } };
        })(),
      }),
    } as never;
    const driver = new CodexSdkDriver({
      model: "gpt-6.1-sol",
      sdk: {
        startThread: (options) => {
          calls.push({ kind: "start", model: options?.model });
          return thread;
        },
        resumeThread: (_id, options) => {
          calls.push({ kind: "resume", model: options?.model });
          return thread;
        },
      },
    });
    const request = (state: Record<string, unknown>) => ({
      provider: CODEX_PROVIDER,
      agent: { name: "codex" } as never,
      context: {
        agent: { name: "codex" },
        session: { state, events: [] },
        userContent: { role: "user", parts: [{ text: "go" }] },
      } as never,
      permissions: { mode: "read-only" as const, allowNetwork: true },
    });
    await drain(driver.run(request({})));
    await drain(driver.run(request({ "codex_thread:codex": "saved-1" })));
    expect(calls).toEqual([
      { kind: "start", model: "gpt-6.1-sol" },
      { kind: "resume", model: "gpt-6.1-sol" },
    ]);
  });
});

describe("Claude Agent SDK driver", () => {
  test("sends the model when it resumes a session", async () => {
    const seen: { resume?: string; model?: string }[] = [];
    const driver = new ClaudeAgentSdkDriver({
      model: "claude-opus-5-5",
      sdk: {
        query: ({ options }) => {
          seen.push(options as { resume?: string; model?: string });
          return (async function* () {
            yield {
              type: "result",
              subtype: "success",
              result: "ok",
              session_id: "sdk-new",
            } as never;
          })() as never;
        },
      },
    });
    await drain(
      driver.run({
        provider: CLAUDE_PROVIDER,
        agent: { name: "claude" } as never,
        context: {
          invocationId: "inv-1",
          agent: { name: "claude" },
          session: {
            id: "s1",
            state: { [claudeSdkSessionStateKey("claude")]: "from-state" },
            events: [],
          },
        } as unknown as InvocationContext,
        permissions: { mode: "ask" },
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.resume).toBe("from-state");
    expect(seen[0]?.model).toBe("claude-opus-5-5");
  });
});
