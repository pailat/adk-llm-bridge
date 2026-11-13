/**
 * Supplementary characterization tests for `AgentInvocationGateway.run()`.
 *
 * They pin behaviour the frozen suite (`gateway-characterization.test.ts` and
 * its snapshot) does not reach: malformed `resume` values from untyped
 * callers, a resume answer that is not the first input part, the combined
 * abort signal seen by the child context, and an error with an empty message.
 */
import { describe, expect, test } from "bun:test";
import {
  BaseAgent,
  type Event,
  type InvocationContext,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
} from "@google/adk";
import {
  AgentInvocationGateway,
  type AgentInvocationRequest,
} from "../../../src/runtime/agent-invocation-gateway.js";
import { ev, parentContext, ScriptAgent, Trace } from "./scenarios.js";

class RootAgent extends BaseAgent {
  constructor() {
    super({ name: "root" });
  }
  protected async *runAsyncImpl() {}
  protected async *runLiveImpl() {}
}

const pendingEvents = (): Event[] => [
  ev("user", [{ text: "go" }]),
  ev(
    "worker",
    [
      {
        functionCall: {
          id: "req-1",
          name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
          args: {
            originalFunctionCall: { id: "orig", name: "delete" },
            toolConfirmation: { hint: "Delete it?" },
          },
        },
      },
    ],
    { longRunningToolIds: ["req-1"] },
  ),
];

const answerPart = (id: string) => ({
  functionResponse: {
    id,
    name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
    response: { confirmed: true },
  },
});

function workerGateway(trace: Trace) {
  const worker = new ScriptAgent("worker", trace, async function* () {
    yield ev("worker", [{ text: "resumed" }]);
  });
  return new AgentInvocationGateway({ resolveAgent: () => worker });
}

describe("gateway characterization supplement: malformed resume", () => {
  const shapes: [string, unknown][] = [
    ["{}", {}],
    ["{ events: null }", { events: null }],
    ["{ events: undefined }", { events: undefined }],
  ];

  for (const [label, resume] of shapes) {
    test(`resume ${label} resolves invalid-resume and never runs the agent`, async () => {
      const trace = new Trace();
      const result = await workerGateway(trace).run({
        agentName: "worker",
        input: { role: "user", parts: [answerPart("req-1")] },
        parentContext: parentContext(new RootAgent()),
        resume: resume as AgentInvocationRequest["resume"],
      });

      expect(result.errorKind).toBe("invalid-resume");
      expect(result.error).toBe(
        "Resume input does not answer a pending interrupt",
      );
      expect(result.events).toEqual([]);
      expect(result.summary.errors).toBe(1);
      expect(trace.lines).toEqual([]);
    });
  }
});

describe("gateway characterization supplement: resume answer position", () => {
  test("an answer after a text part resumes the run", async () => {
    const trace = new Trace();
    const result = await workerGateway(trace).run({
      agentName: "worker",
      input: { role: "user", parts: [{ text: "ok" }, answerPart("req-1")] },
      parentContext: parentContext(new RootAgent()),
      resume: { events: pendingEvents() },
    });

    expect(result.errorKind).toBeUndefined();
    expect(result.output).toBe("resumed");
    expect(result.interrupt).toBeUndefined();
    expect(trace.lines).toEqual(["agent:worker:start", "agent:worker:finally"]);
  });

  test("an unrelated answer after a text part is rejected", async () => {
    const trace = new Trace();
    const result = await workerGateway(trace).run({
      agentName: "worker",
      input: { role: "user", parts: [{ text: "ok" }, answerPart("other")] },
      parentContext: parentContext(new RootAgent()),
      resume: { events: pendingEvents() },
    });

    expect(result.errorKind).toBe("invalid-resume");
    expect(trace.lines).toEqual([]);
  });
});

describe("gateway characterization supplement: child abort signal", () => {
  /** Agent that aborts `controller` after its first event and reports what its context saw. */
  function signalProbe(trace: Trace, controller: AbortController) {
    const seen: { abortedAfter?: boolean; hasSignal?: boolean } = {};
    const agent = new ScriptAgent(
      "worker",
      trace,
      async function* (context: InvocationContext) {
        seen.hasSignal = context.abortSignal !== undefined;
        controller.abort(new Error("stop"));
        seen.abortedAfter = context.abortSignal?.aborted === true;
        yield ev("worker", [{ text: "after abort" }]);
      },
    );
    return { agent, seen };
  }

  test("aborting the parent signal aborts the child context signal", async () => {
    const trace = new Trace();
    const parent = new AbortController();
    const request = new AbortController();
    const { agent, seen } = signalProbe(trace, parent);
    const result = await new AgentInvocationGateway({
      resolveAgent: () => agent,
    }).run({
      agentName: "worker",
      input: { role: "user", parts: [{ text: "go" }] },
      parentContext: parentContext(new RootAgent(), parent.signal),
      abortSignal: request.signal,
    });

    expect(seen).toEqual({ hasSignal: true, abortedAfter: true });
    expect(result.errorKind).toBe("aborted");
    expect(result.error).toBe("stop");
  });

  test("aborting the request signal aborts the child context signal", async () => {
    const trace = new Trace();
    const parent = new AbortController();
    const request = new AbortController();
    const { agent, seen } = signalProbe(trace, request);
    const result = await new AgentInvocationGateway({
      resolveAgent: () => agent,
    }).run({
      agentName: "worker",
      input: { role: "user", parts: [{ text: "go" }] },
      parentContext: parentContext(new RootAgent(), parent.signal),
      abortSignal: request.signal,
    });

    expect(seen).toEqual({ hasSignal: true, abortedAfter: true });
    expect(result.errorKind).toBe("aborted");
  });

  test("with only a request signal the child context gets that signal", async () => {
    const trace = new Trace();
    const request = new AbortController();
    let childSignal: AbortSignal | undefined;
    const agent = new ScriptAgent("worker", trace, async function* (context) {
      childSignal = context.abortSignal;
      yield ev("worker", [{ text: "ok" }]);
    });
    await new AgentInvocationGateway({ resolveAgent: () => agent }).run({
      agentName: "worker",
      input: { role: "user", parts: [{ text: "go" }] },
      parentContext: parentContext(new RootAgent()),
      abortSignal: request.signal,
    });

    expect(childSignal).toBe(request.signal);
  });
});

describe("gateway characterization supplement: empty error message", () => {
  test("a thrown Error('') counts an error but sets neither error nor errorKind", async () => {
    const trace = new Trace();
    const agent = new ScriptAgent("worker", trace, async function* () {
      yield ev("worker", [{ text: "before" }]);
      throw new Error("");
    });
    const result = await new AgentInvocationGateway({
      resolveAgent: () => agent,
    }).run({
      agentName: "worker",
      input: { role: "user", parts: [{ text: "go" }] },
      parentContext: parentContext(new RootAgent()),
    });

    expect(result.summary.errors).toBe(1);
    expect("error" in result).toBe(false);
    expect("errorKind" in result).toBe(false);
    expect(result.output).toBe("before");
  });
});
