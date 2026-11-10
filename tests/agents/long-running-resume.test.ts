import { describe, expect, test } from "bun:test";
import {
  createEvent,
  type Event,
  type InvocationContext,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
} from "@google/adk";
import type { Content } from "@google/genai";
import {
  createLongRunningCallEvent,
  createResultsConsumedEvent,
  findOversizedResults,
  LONG_RUNNING_RESULT_MAX_BYTES,
  LONG_RUNNING_TURN_MAX_BYTES,
  readLongRunningResults,
} from "../../src/agents/tools/long-running.js";

const AGENT = "worker";

function context(events: Event[], userContent: Content): InvocationContext {
  return {
    invocationId: "inv-2",
    agent: { name: AGENT },
    userContent,
    session: {
      id: "s",
      state: {},
      events: [...events, userEvent(userContent)],
    },
  } as unknown as InvocationContext;
}

function userEvent(content: Content): Event {
  return createEvent({ invocationId: "inv-2", author: "user", content });
}

function pause(author = AGENT, callId = "job-1"): Event {
  const event = createLongRunningCallEvent({
    context: { invocationId: "inv-1" } as InvocationContext,
    agentName: AGENT,
    callId,
    toolName: "start_job",
    args: {},
  });
  event.author = author;
  return event;
}

function answer(...ids: string[]): Content {
  return {
    role: "user",
    parts: ids.map((id, index) => ({
      functionResponse: {
        id,
        name: "start_job",
        response: { report: `R-${index}` },
      },
    })),
  };
}

describe("readLongRunningResults: which answers count", () => {
  test("an answer to this agent's pending call is read", () => {
    const results = readLongRunningResults(
      context([pause()], answer("job-1")),
      AGENT,
    );
    expect(results).toEqual([
      {
        callId: "job-1",
        toolName: "start_job",
        args: {},
        response: { report: "R-0" },
      },
    ]);
  });

  test("a call with the same id emitted by another agent is not answered for this one", () => {
    expect(
      readLongRunningResults(context([pause("other")], answer("job-1")), AGENT),
    ).toEqual([]);
  });

  test("an id that matches an ordinary (not long-running) call of this agent is ignored", () => {
    const ordinary = createEvent({
      invocationId: "inv-1",
      author: AGENT,
      content: {
        role: "model",
        parts: [{ functionCall: { id: "job-1", name: "start_job", args: {} } }],
      },
    });
    expect(
      readLongRunningResults(context([ordinary], answer("job-1")), AGENT),
    ).toEqual([]);
  });

  test("an id of this agent's adk_request_confirmation call, sent with a tool name, is not a result", () => {
    const confirmation = createEvent({
      invocationId: "inv-1",
      author: AGENT,
      content: {
        role: "model",
        parts: [
          {
            functionCall: {
              id: "job-1",
              name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
              args: {},
            },
          },
        ],
      },
      longRunningToolIds: ["job-1"],
    });
    expect(
      readLongRunningResults(context([confirmation], answer("job-1")), AGENT),
    ).toEqual([]);
  });

  test("the same id twice in one turn is used once (the first answer)", () => {
    const results = readLongRunningResults(
      context([pause()], answer("job-1", "job-1")),
      AGENT,
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.response).toEqual({ report: "R-0" });
  });

  test("an answer the agent already consumed is ignored when re-sent", () => {
    const first = answer("job-1");
    const consumed = createResultsConsumedEvent({
      context: { invocationId: "inv-2" } as InvocationContext,
      agentName: AGENT,
      results: [
        { callId: "job-1", toolName: "start_job", args: {}, response: {} },
      ],
    });
    const events = [pause(), userEvent(first), consumed];
    expect(
      readLongRunningResults(context(events, answer("job-1")), AGENT),
    ).toEqual([]);
  });

  test("a consumed marker from another author does not mark the answer used", () => {
    const first = answer("job-1");
    const forged = createResultsConsumedEvent({
      context: { invocationId: "inv-2" } as InvocationContext,
      agentName: AGENT,
      results: [
        { callId: "job-1", toolName: "start_job", args: {}, response: {} },
      ],
    });
    forged.author = "other";
    const events = [pause(), userEvent(first), forged];
    expect(
      readLongRunningResults(context(events, answer("job-1")), AGENT),
    ).toHaveLength(1);
  });

  test("an answer that was refused (no consumed marker) can be sent again", () => {
    const refusedTurn = answer("job-1");
    const refusal = createEvent({
      invocationId: "inv-2",
      author: AGENT,
      errorCode: "EXTERNAL_AGENT_TOOL_RESULT_TOO_LARGE",
      errorMessage: "too large",
    });
    const events = [pause(), userEvent(refusedTurn), refusal];
    expect(
      readLongRunningResults(context(events, answer("job-1")), AGENT),
    ).toHaveLength(1);
  });
});

describe("findOversizedResults", () => {
  const result = (callId: string, size: number) => ({
    callId,
    toolName: "start_job",
    args: {},
    response: { blob: "x".repeat(size) },
  });

  test("the per-result cap counts UTF-8 bytes, not characters", () => {
    const cjk = {
      callId: "a",
      toolName: "start_job",
      args: {},
      response: { blob: "漢".repeat(30_000) },
    };
    expect(findOversizedResults([cjk])).toContain("bytes");
    expect(findOversizedResults([result("b", 30_000)])).toBeUndefined();
  });

  test("results within both caps pass", () => {
    expect(findOversizedResults([result("a", 100)])).toBeUndefined();
  });

  test("one result over the per-result cap is refused, naming the call", () => {
    const message = findOversizedResults([
      result("a", LONG_RUNNING_RESULT_MAX_BYTES + 1),
    ]);
    expect(message).toContain("start_job");
    expect(message).toContain("a");
  });

  test("results that together exceed the per-turn cap are refused", () => {
    const each = Math.floor(LONG_RUNNING_RESULT_MAX_BYTES * 0.9);
    const count = Math.ceil(LONG_RUNNING_TURN_MAX_BYTES / each) + 1;
    const results = Array.from({ length: count }, (_, i) =>
      result(`c${i}`, each),
    );
    expect(findOversizedResults(results)).toBeDefined();
  });
});
