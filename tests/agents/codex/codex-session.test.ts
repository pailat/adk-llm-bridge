import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  assertThreadIdIsNotAFlag,
  CodexThreadTracker,
  prepareCodexTurn,
  readSavedThreadId,
} from "../../../src/agents/driver/codex-session.js";
import { ExternalAgentPolicyError } from "../../../src/agents/driver/policy-errors.js";
import { CODEX_PROVIDER } from "../../../src/agents/provider/schema.js";

type Call = { method: "start" | "resume"; id?: string };

function fakeClient(calls: Call[]) {
  return {
    startThread: () => {
      calls.push({ method: "start" });
      return {
        id: null,
        runStreamed: async () => ({ events: (async function* () {})() }),
      };
    },
    resumeThread: (id: string) => {
      calls.push({ method: "resume", id });
      return {
        id,
        runStreamed: async () => ({ events: (async function* () {})() }),
      };
    },
  };
}

function request(
  overrides: Record<string, unknown> = {},
  state: Record<string, unknown> = {},
) {
  return {
    provider: CODEX_PROVIDER,
    instruction: "be brief",
    context: {
      session: { state, events: [] },
      userContent: { role: "user", parts: [{ text: "current" }] },
    },
    ...overrides,
  } as never;
}

describe("thread id safety", () => {
  test("a flag-like id is refused with the option-unsupported code", () => {
    for (const id of ["-x", "--dangerously-bypass-approvals-and-sandbox"]) {
      try {
        assertThreadIdIsNotAFlag(id);
        throw new Error("expected a refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(ExternalAgentPolicyError);
        expect((error as ExternalAgentPolicyError).code).toBe(
          "EXTERNAL_AGENT_OPTION_UNSUPPORTED",
        );
      }
    }
    expect(() => assertThreadIdIsNotAFlag("019a-thread")).not.toThrow();
  });

  test("the saved id is read from session state under the key, and only when non-empty", () => {
    expect(readSavedThreadId(request({}, { k: "t1" }), "k")).toBe("t1");
    expect(readSavedThreadId(request({}, { k: "" }), "k")).toBeUndefined();
    expect(readSavedThreadId(request({}, { k: 5 }), "k")).toBeUndefined();
    expect(
      readSavedThreadId(request({}, { k: "t1" }), undefined),
    ).toBeUndefined();
  });
});

describe("CodexThreadTracker", () => {
  test("reports a new thread id once as a state delta", () => {
    const tracker = new CodexThreadTracker("codex_thread:a", undefined);

    expect(tracker.observe("t1")).toMatchObject({
      type: "state_delta",
      stateDelta: { "codex_thread:a": "t1" },
    });
    expect(tracker.observe("t1")).toBeUndefined();
    expect(tracker.observe(undefined)).toBeUndefined();
    expect(tracker.observe("t2")).toMatchObject({
      stateDelta: { "codex_thread:a": "t2" },
    });
  });

  test("never reports the id that was resumed, or anything without a state key", () => {
    expect(new CodexThreadTracker("k", "t1").observe("t1")).toBeUndefined();
    expect(
      new CodexThreadTracker(undefined, undefined).observe("t1"),
    ).toBeUndefined();
  });
});

describe("prepareCodexTurn", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  test("an explicit runtime session wins over the saved state", async () => {
    const calls: Call[] = [];
    const turn = prepareCodexTurn({
      client: fakeClient(calls),
      request: request({ runtimeSession: { id: "explicit" } }, { k: "saved" }),
      stateKey: "k",
      threadOptions: {},
    });
    cleanups.push(turn.cleanup);

    expect(calls).toEqual([{ method: "resume", id: "explicit" }]);
    expect(turn.savedThreadId).toBe("explicit");
    expect(turn.input).toBe("be brief\n\ncurrent");
  });

  test("a saved thread resumes with only the current turn", () => {
    const calls: Call[] = [];
    const base = request({}, { k: "saved" });
    (
      base as { context: { session: { events: unknown[] } } }
    ).context.session.events = [
      { author: "user", content: { role: "user", parts: [{ text: "old" }] } },
      { author: "a", content: { role: "model", parts: [{ text: "older" }] } },
    ];
    const turn = prepareCodexTurn({
      client: fakeClient(calls),
      request: base,
      stateKey: "k",
      threadOptions: {},
    });

    expect(calls).toEqual([{ method: "resume", id: "saved" }]);
    expect(String(turn.input)).not.toContain("old");
  });

  test("a flag-like saved id is refused before any thread is created", () => {
    const calls: Call[] = [];

    expect(() =>
      prepareCodexTurn({
        client: fakeClient(calls),
        request: request({}, { k: "--yolo" }),
        stateKey: "k",
        threadOptions: {},
      }),
    ).toThrow(ExternalAgentPolicyError);
    expect(calls).toEqual([]);
  });

  test("with no thread to resume, history is summarized once in front of the turn", () => {
    const calls: Call[] = [];
    const base = request({});
    (
      base as { context: { session: { events: unknown[] } } }
    ).context.session.events = [
      { author: "user", content: { role: "user", parts: [{ text: "first" }] } },
      { author: "a", content: { role: "model", parts: [{ text: "reply" }] } },
    ];
    const turn = prepareCodexTurn({
      client: fakeClient(calls),
      request: base,
      stateKey: undefined,
      threadOptions: {},
    });

    expect(calls).toEqual([{ method: "start" }]);
    const text = String(turn.input);
    expect(text.indexOf("first")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("first")).toBeLessThan(text.indexOf("current"));
  });

  test("image temp files exist until cleanup runs", async () => {
    const calls: Call[] = [];
    const turn = prepareCodexTurn({
      client: fakeClient(calls),
      request: {
        provider: CODEX_PROVIDER,
        context: {
          session: { events: [] },
          userContent: {
            role: "user",
            parts: [
              { inlineData: { mimeType: "image/png", data: "AAAA" } },
              { text: "see" },
            ],
          },
        },
      } as never,
      stateKey: undefined,
      threadOptions: {},
    });
    const image = (turn.input as Array<{ type: string; path?: string }>).find(
      (part) => part.type === "local_image",
    );

    expect(image?.path && existsSync(image.path)).toBe(true);
    await turn.cleanup();
    expect(existsSync(image?.path ?? "")).toBe(false);
  });
});
