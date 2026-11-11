/**
 * Characterization tests for `AgentInvocationGateway.run()`.
 *
 * They pin the observable behaviour of `run()` (hook and sink order, event
 * order, result aggregation, error classification, resume validation) so an
 * internal restructuring can be checked against it. The snapshot fixture is
 * the full ordered record of every scenario in `scenarios.ts`; the targeted
 * tests below restate the most important facts so a failure reads clearly.
 *
 * Regenerate the fixture only for an intended behaviour change:
 * `GATEWAY_CHARACTERIZATION_WRITE=1 bun test tests/runtime/gateway-characterization`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  allScenarios,
  runAllScenarios,
  type ScenarioRecord,
} from "./scenarios.js";

const FIXTURE = join(import.meta.dir, "event-order.snapshot.json");
const writing = process.env.GATEWAY_CHARACTERIZATION_WRITE === "1";

let cached: Promise<Record<string, ScenarioRecord>> | undefined;
const records = () => {
  cached ??= runAllScenarios();
  return cached;
};
const record = async (name: string) => {
  const found = (await records())[name];
  if (!found) throw new Error(`no scenario named ${name}`);
  return found;
};
type Projected = Record<string, unknown> & {
  summary: Record<string, number>;
  usage: Record<string, number>;
};
const result = async (name: string, index = 0) =>
  (await record(name)).results[index] as Projected;

describe("gateway characterization: event-order snapshot", () => {
  test("the fixture lists exactly the scenarios", async () => {
    const all = await records();
    if (writing) {
      writeFileSync(FIXTURE, `${JSON.stringify(all, null, 2)}\n`);
    }
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<
      string,
      ScenarioRecord
    >;
    expect(Object.keys(fixture)).toEqual(allScenarios().map((s) => s.name));
  });

  for (const { name } of allScenarios()) {
    test(`matches the snapshot: ${name}`, async () => {
      const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<
        string,
        ScenarioRecord
      >;
      expect(JSON.parse(JSON.stringify(await record(name)))).toEqual(
        fixture[name] as ScenarioRecord,
      );
    });
  }

  test("two runs produce the same records", async () => {
    const again = await runAllScenarios();
    expect(JSON.parse(JSON.stringify(again))).toEqual(
      JSON.parse(JSON.stringify(await records())),
    );
  });
});

describe("gateway characterization: hook and sink order", () => {
  test("validator phases, resolution, preparation, then gateway sink before request sink", async () => {
    const { trace } = await record(
      "success: hooks, sinks and aggregation in order",
    );
    expect(trace.slice(0, 6)).toEqual([
      "req:validate:before-resolve",
      "gw:resolve:worker",
      "req:validate:before-prepare",
      "req:prepare:worker",
      "req:validate:before-execute",
      "agent:worker:start",
    ]);
    expect(trace.slice(6, 8)).toEqual([
      "gw:sink:worker:thought:thinking",
      "req:sink:worker:thought:thinking",
    ]);
    expect(trace.slice(-2)).toEqual([
      "agent:worker:finally",
      "run:resolved:ok",
    ]);
  });

  test("a validator rejection escapes at its phase and stops the run there", async () => {
    const { trace } = await record(
      "validator: a rejection at each phase escapes",
    );
    expect(trace.filter((line) => line.startsWith("caught:"))).toEqual([
      "caught:TypeError",
      "caught:TypeError",
      "caught:TypeError",
    ]);
    expect(trace).not.toContain("agent:worker:start");
    expect(trace).toContain("run:rejected:denied before-execute");
  });

  test("resolution failures skip every later phase", async () => {
    const { trace, results } = await record(
      "resolution: throw, unknown and validator ordering",
    );
    expect(trace).not.toContain("req:validate:before-prepare");
    expect(results.map((r) => [r.error, r.errorKind])).toEqual([
      ["registry offline", "agent-error"],
      ["plain string", "agent-error"],
      ["Unknown ADK agent: ghost", "agent-error"],
    ]);
  });
});

describe("gateway characterization: resume validation", () => {
  test("every rejection path yields invalid-resume with the same message and no run", async () => {
    const { trace, results } = await record(
      "resume validation: every rejection path",
    );
    const rejected = results.slice(0, -1);
    expect(rejected).toHaveLength(8);
    for (const r of rejected) {
      expect(r.errorKind).toBe("invalid-resume");
      expect(r.error).toBe("Resume input does not answer a pending interrupt");
      // The failed result names the requested agent, not the resolved one.
      expect(r.agentName).toBe("alias-of-worker");
      expect(r.summary).toEqual({
        events: 0,
        textEvents: 0,
        toolCalls: 0,
        errors: 1,
      });
      expect(r.events).toEqual([]);
    }
    expect(trace).not.toContain("req:validate:before-prepare");
    expect(trace).not.toContain("agent:worker:start");
  });

  test("resolution runs before resume validation", async () => {
    const { results } = await record("resume validation: every rejection path");
    expect(results.at(-1)?.errorKind).toBe("agent-error");
    expect(results.at(-1)?.error).toBe("Unknown ADK agent: ghost");
  });

  test("answering one of two pending calls resumes and the other stays pending", async () => {
    const r = await result("resume: answering one of two pending calls");
    expect(r.error).toBeNull();
    expect(r.output).toBe("half done");
    expect(r.interrupt).toMatchObject({
      kind: "long-running",
      functionCallIds: ["a"],
    });
  });
});

describe("gateway characterization: interrupt and resume ordering", () => {
  const name = "interrupt and resume: ordering of history and events";

  test("interrupt events are resume events, then the input event, then the run's non-partial events", async () => {
    const second = await result(name, 1);
    const interrupt = second.interrupt as { events: { type: string }[] };
    expect(interrupt.events.map((e) => e.type)).toEqual([
      "text:go",
      "text:asking",
      "call:adk_request_confirmation#req-1",
      "response:adk_request_confirmation#req-1",
      "text:need input",
      "call:adk_request_input#in-1",
    ]);
  });

  test("a resumed child sees prior events, then the answer; inherit puts parent history first", async () => {
    const { trace } = await record(name);
    expect(trace).toContain(
      "round2:history:user/text:go,worker/text:asking,worker/call:adk_request_confirmation#req-1,user/response:adk_request_confirmation#req-1",
    );
    expect(
      trace.find((line) => line.startsWith("round3:history:")),
    ).toStartWith("round3:history:user/text:previous task,user/text:go,");
    expect(trace).toContain('round2:state:{"shared":true,"stage":"asked"}');
  });

  test("the parent session is never written", async () => {
    const { facts } = await record(name);
    expect(facts).toEqual({
      parentEventsAfter: 1,
      parentStateAfter: { shared: true },
    });
  });

  test("appendInput false keeps the input out of history and of interrupt events", async () => {
    const { trace, results } = await record("resume with appendInput false");
    expect(trace).toContain("history:user/text:previous task");
    const interrupt = results[0]?.interrupt as { events: { type: string }[] };
    expect(interrupt.events.map((e) => e.type)).toEqual(["call:slow#s1"]);
  });
});

describe("gateway characterization: usage aggregation", () => {
  test("sums non-partial usage, falls back to prompt + completion, counts tool calls", async () => {
    const r = await result("success: hooks, sinks and aggregation in order");
    expect(r.usage).toEqual({
      promptTokens: 17,
      completionTokens: 8,
      totalTokens: 25,
      cachedTokens: 4,
      toolCalls: 1,
      llmCalls: 3,
    });
    expect(r.summary).toEqual({
      events: 6,
      textEvents: 2,
      toolCalls: 1,
      errors: 0,
    });
    expect(r.output).toBe("final answer");
    expect(r.transcript).toBe("narration\nfinal answer");
  });

  test("an outer run counts only the events its agent yields", async () => {
    const r = await result("nested gateways: two delegation hops");
    expect(r.usage).toMatchObject({
      promptTokens: 6,
      completionTokens: 3,
      totalTokens: 9,
      llmCalls: 2,
    });
  });
});

describe("gateway characterization: maxLlmCalls sharing", () => {
  test("children spend the parent's budget; a real LlmAgent reports the limit as an error event", async () => {
    const { results, facts } = await record(
      "maxLlmCalls: one budget shared by parent and children",
    );
    expect(results.map((r) => r.errorKind)).toEqual([
      null,
      null,
      "llm-calls-limit",
    ]);
    expect(results[2]?.error).toBe(
      "Max number of llm calls limit of 3 exceeded",
    );
    expect(facts).toEqual({ parentThrowsAfterChildren: true });
  });

  test("a thrown LlmCallsLimitExceededError is classified llm-calls-limit", async () => {
    const r = await result(
      "errors: event errors, thrown errors and preparation",
      2,
    );
    expect(r.errorKind).toBe("llm-calls-limit");
    expect(r.error).toBe("budget exhausted");
  });

  test("the counter is shared through two delegation hops", async () => {
    const { facts } = await record("nested gateways: two delegation hops");
    expect(facts?.leafSecondCallThrows).toBe(true);
    expect(facts?.rootThrowsAfterLeaf).toBe(true);
  });
});

describe("gateway characterization: stateDelta and temp:", () => {
  const name = "stateDelta: merge order, temp: and partial filtering";

  test("later writes win, partial and temp: keys are left out, temp-only is absent", async () => {
    const { results } = await record(name);
    expect(results.map((r) => r.stateDelta)).toEqual([
      { a: 2, b: { nested: true }, c: null },
      { a: 2, b: { nested: true }, c: null },
      null,
    ]);
    expect(results[2]?.keys).not.toContain("stateDelta");
  });

  test("replace mode freezes the child state and the parent state is untouched", async () => {
    const { facts, trace } = await record(name);
    expect(facts).toEqual({
      parentState: { shared: true },
      replacedChildFrozen: true,
    });
    expect(trace).toContain(
      'childState:{"a":2,"b":{"nested":true},"c":null,"projected":2}',
    );
  });

  test("resume events seed the child state, skipping partial events and temp: keys", async () => {
    const { trace } = await record(
      "stateDelta: resume events seed the child state",
    );
    expect(trace).toContain(
      'childState:{"fromUser":1,"shared":"overridden","stage":"asked"}',
    );
  });
});

describe("gateway characterization: nested gateways", () => {
  test("the inner run completes inside the outer stream, and its child session roots at the parent", async () => {
    const { trace, facts, results } = await record(
      "nested gateways: two delegation hops",
    );
    const innerDone = trace.indexOf("agent:leaf:finally");
    expect(innerDone).toBeGreaterThan(
      trace.indexOf("outer:sink:middle:text:delegating"),
    );
    expect(innerDone).toBeLessThan(
      trace.indexOf("outer:sink:leaf:text:leaf done"),
    );
    expect(facts?.leafRootIsParentSession).toBe(true);
    expect(facts?.leafPermissions).toEqual({
      mode: "read-only",
      allowNetwork: false,
    });
    expect(facts?.leafState).toEqual({
      shared: true,
      middle: 1,
      fromMiddle: true,
    });
    expect(results[0]?.stateDelta).toEqual({ middle: 1, leaf: 1 });
  });
});

describe("gateway characterization: abort", () => {
  test("an abort mid-stream keeps the events seen so far and classifies aborted", async () => {
    const { results, trace } = await record(
      "abort: in the middle of an event stream",
    );
    expect(results.map((r) => [r.error, r.errorKind])).toEqual([
      ["stop now", "aborted"],
      ["string reason", "aborted"],
      ["<string>", "aborted"],
    ]);
    for (const r of results) {
      expect(r.summary).toEqual({
        events: 1,
        textEvents: 1,
        toolCalls: 0,
        errors: 1,
      });
      expect(r.stateDelta).toEqual({ a: 1 });
    }
    // run() settles before the generator's finally (return() is not awaited).
    expect(trace.indexOf("run:resolved:aborted")).toBeLessThan(
      trace.indexOf("agent:worker:finally"),
    );
  });

  test("an aborted parent stops before preparation; the abort wins over other errors", async () => {
    const { results, trace } = await record(
      "abort: parent signal, before preparation",
    );
    expect(results.map((r) => [r.error, r.errorKind])).toEqual([
      ["parent cancelled", "aborted"],
      ["preparation saw the abort", "aborted"],
      ["sink error after abort", "aborted"],
    ]);
    expect(trace.slice(0, 4)).toEqual([
      "req:validate:before-resolve",
      "gw:resolve:worker",
      "req:validate:before-prepare",
      "run:resolved:aborted",
    ]);
  });

  test("a stalled agent does not keep run() pending", async () => {
    const r = await result("abort: a stalled agent releases run()");
    expect(r.errorKind).toBe("aborted");
    expect(r.error).toBe("stop stalled");
  });
});

describe("gateway characterization: errors and output", () => {
  test("the last error wins and every error is counted", async () => {
    const { results } = await record(
      "errors: event errors, thrown errors and preparation",
    );
    expect(
      (results as Projected[]).map((r) => [
        r.error,
        r.errorKind,
        r.summary.errors,
      ]),
    ).toEqual([
      ["second", "agent-error", 2],
      ["thrown later", "agent-error", 2],
      ["budget exhausted", "llm-calls-limit", 1],
      ["binder refused", "preparation", 1],
    ]);
  });

  test("a throwing sink ends the run and closes the generator before run() settles", async () => {
    const { trace, results } = await record(
      "errors: a throwing sink closes the generator",
    );
    expect(trace.slice(-2)).toEqual([
      "agent:worker:finally",
      "run:resolved:agent-error",
    ]);
    expect(results[0]?.error).toBe("sink boom");
  });

  test("output falls back to function responses, then error messages", async () => {
    const { results } = await record(
      "output: function-response and error fallbacks",
    );
    expect(results.map((r) => [r.output, r.transcript])).toEqual([
      ['out\n{"n":2}', 'out\n{"n":2}'],
      ["first failure\nsecond failure", "first failure\nsecond failure"],
      ["a\nb", "a\nb\ncalling"],
    ]);
  });
});
