/**
 * Characterization scenarios for `AgentInvocationGateway.run()`.
 *
 * Each scenario drives the gateway with deterministic fakes and returns a
 * JSON-safe record: an ordered trace of every observable step (validator
 * phases, resolution, preparation, agent start/finally, gateway and request
 * sinks, run settlement) plus a projection of every result. The test suite
 * compares these records with a committed snapshot, and the event-trace probe
 * reuses them to diff the event sequence of two builds.
 */
import {
  BaseAgent,
  BaseLlm,
  type BaseLlmConnection,
  createEvent,
  createEventActions,
  type Event,
  InvocationContext,
  LlmAgent,
  LlmCallsLimitExceededError,
  type LlmRequest,
  type LlmResponse,
  PluginManager,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  type Session,
} from "@google/adk";
import type { Content } from "@google/genai";
import {
  getInheritedPermissions,
  setInheritedPermissions,
} from "../../../src/agents/permissions/inheritance.js";
import {
  AgentInvocationGateway,
  type AgentInvocationRequest,
  type AgentInvocationResult,
  rootSessionOf,
} from "../../../src/runtime/agent-invocation-gateway.js";

/** One JSON-safe observation of a scenario. */
export interface ScenarioRecord {
  trace: string[];
  results: Record<string, unknown>[];
  facts?: Record<string, unknown>;
}

/** Ordered log of what a scenario observed. */
export class Trace {
  readonly lines: string[] = [];
  push(line: string): void {
    this.lines.push(line);
  }
}

/** Agent whose body is a script; logs start and finally to the trace. */
export class ScriptAgent extends BaseAgent {
  context?: InvocationContext;
  constructor(
    name: string,
    private readonly trace: Trace,
    private readonly script: (
      context: InvocationContext,
    ) => AsyncGenerator<Event, void, void>,
  ) {
    super({ name });
  }
  protected async *runAsyncImpl(context: InvocationContext) {
    this.context = context;
    this.trace.push(`agent:${this.name}:start`);
    try {
      yield* this.script(context);
    } finally {
      this.trace.push(`agent:${this.name}:finally`);
    }
  }
  protected async *runLiveImpl() {}
}

/** Builds an event authored by `author` with deterministic content. */
export function ev(
  author: string,
  parts: NonNullable<Content["parts"]>,
  extra: Partial<Event> & { stateDelta?: Record<string, unknown> } = {},
): Event {
  const { stateDelta, ...rest } = extra;
  return createEvent({
    invocationId: "inv-1",
    author,
    content: { role: author === "user" ? "user" : "model", parts },
    ...(stateDelta ? { actions: createEventActions({ stateDelta }) } : {}),
    ...rest,
  });
}

/** Parent invocation context with one prior event and `{ shared: true }` state. */
export function parentContext(
  agent: BaseAgent,
  abortSignal?: AbortSignal,
): InvocationContext {
  return new InvocationContext({
    invocationId: "inv-1",
    branch: "root",
    agent,
    userContent: { role: "user", parts: [{ text: "parent task" }] },
    session: {
      id: "session-1",
      appName: "app",
      userId: "user",
      state: { shared: true },
      events: [
        createEvent({
          invocationId: "previous",
          author: "user",
          content: { role: "user", parts: [{ text: "previous task" }] },
        }),
      ],
      lastUpdateTime: 1,
    },
    pluginManager: new PluginManager(),
    abortSignal,
  });
}

const userText = (text: string): Content => ({
  role: "user",
  parts: [{ text }],
});

const answer = (id: string, name: string): Content => ({
  role: "user",
  parts: [{ functionResponse: { id, name, response: { ok: true } } }],
});

/** Short description of an event's content kind, in part order. */
export function eventType(event: Event): string {
  const kinds: string[] = [];
  for (const part of event.content?.parts ?? []) {
    if (part.functionCall) {
      kinds.push(`call:${part.functionCall.name}#${part.functionCall.id}`);
    } else if (part.functionResponse) {
      kinds.push(
        `response:${part.functionResponse.name}#${part.functionResponse.id}`,
      );
    } else if (typeof part.text === "string") {
      kinds.push(part.thought ? `thought:${part.text}` : `text:${part.text}`);
    } else {
      kinds.push("other");
    }
  }
  if (event.errorMessage) kinds.push(`error:${event.errorMessage}`);
  return kinds.length > 0 ? kinds.join("|") : "empty";
}

/** Keys of `actions` that carry a value, with state delta keys spelled out. */
export function actionKeys(event: Event): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(event.actions ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    ) {
      continue;
    }
    if (key === "stateDelta") {
      keys.push(
        `stateDelta{${Object.keys(value as object)
          .sort()
          .join(",")}}`,
      );
    } else {
      keys.push(key);
    }
  }
  return keys.sort();
}

/** JSON-safe projection of one event (no ids or timestamps). */
export function projectEvent(event: Event): Record<string, unknown> {
  return {
    author: event.author ?? null,
    type: eventType(event),
    partial: event.partial === true,
    actions: actionKeys(event),
    ...(event.longRunningToolIds && event.longRunningToolIds.length > 0
      ? { longRunning: [...event.longRunningToolIds] }
      : {}),
    ...(event.usageMetadata ? { usage: { ...event.usageMetadata } } : {}),
    ...(event.branch ? { branch: event.branch } : {}),
  };
}

/** JSON-safe projection of one result (durationMs only checked for type). */
export function projectResult(
  result: AgentInvocationResult,
): Record<string, unknown> {
  const { durationMs, ...summary } = result.summary;
  return {
    keys: Object.keys(result),
    agentName: result.agentName,
    output: result.output,
    transcript: result.transcript,
    events: result.events.map(projectEvent),
    summary,
    durationIsNumber: typeof durationMs === "number" && durationMs >= 0,
    usage: result.usage,
    stateDelta: result.stateDelta ?? null,
    error: result.error ?? null,
    errorKind: result.errorKind ?? null,
    interrupt: result.interrupt
      ? {
          kind: result.interrupt.kind,
          functionCallIds: [...result.interrupt.functionCallIds],
          requests: result.interrupt.requests.map((request) => ({
            interruptId: request.interruptId,
            kind: request.kind,
          })),
          events: result.interrupt.events.map(projectEvent),
        }
      : null,
  };
}

/** Request fields that log every hook of `run()` to the trace. */
function traced(
  trace: Trace,
  label = "req",
): Pick<
  AgentInvocationRequest,
  "validateInvocation" | "prepareContext" | "eventSink"
> {
  return {
    validateInvocation: (phase) => trace.push(`${label}:validate:${phase}`),
    prepareContext: (_context, agent) =>
      trace.push(`${label}:prepare:${agent.name}`),
    eventSink: (event) =>
      trace.push(
        `${label}:sink:${event.author}:${eventType(event)}${event.partial ? ":partial" : ""}`,
      ),
  };
}

/** Gateway whose resolver and gateway-level sink log to the trace. */
function tracedGateway(
  trace: Trace,
  agents: readonly BaseAgent[],
  label = "gw",
): AgentInvocationGateway {
  return new AgentInvocationGateway({
    resolveAgent: (name) => {
      trace.push(`${label}:resolve:${name}`);
      return agents.find((agent) => agent.name === name);
    },
    eventSink: (event) =>
      trace.push(
        `${label}:sink:${event.author}:${eventType(event)}${event.partial ? ":partial" : ""}`,
      ),
  });
}

async function settle(
  trace: Trace,
  promise: Promise<AgentInvocationResult>,
): Promise<AgentInvocationResult> {
  try {
    const result = await promise;
    trace.push(`run:resolved:${result.errorKind ?? "ok"}`);
    return result;
  } catch (caught) {
    trace.push(
      `run:rejected:${caught instanceof Error ? caught.message : String(caught)}`,
    );
    throw caught;
  }
}

/** JSON with object keys sorted at every depth. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : inner,
  );
}

/** Flushes pending microtasks and one macrotask so late `finally` blocks log. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Fake model that answers each call with the next scripted response. */
export class ScriptedLlm extends BaseLlm {
  calls = 0;
  constructor(private readonly responses: LlmResponse[]) {
    super({ model: "scripted" });
  }
  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    const response =
      this.responses[Math.min(this.calls, this.responses.length - 1)];
    this.calls++;
    if (response) yield response;
  }
  async connect(): Promise<BaseLlmConnection> {
    throw new Error("not implemented");
  }
}

const confirmation = (id = "req-1", extra: Partial<Event> = {}) =>
  ev(
    "worker",
    [
      {
        functionCall: {
          id,
          name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
          args: {
            originalFunctionCall: { id: `orig-${id}`, name: "delete" },
            toolConfirmation: { hint: "Delete it?" },
          },
        },
      },
    ],
    { longRunningToolIds: [id], ...extra },
  );

/** A scenario: a name and a function that runs it. */
export interface Scenario {
  name: string;
  run(): Promise<ScenarioRecord>;
}

const scenarios: Scenario[] = [];
const scenario = (name: string, run: () => Promise<ScenarioRecord>) =>
  scenarios.push({ name, run });

// ---------------------------------------------------------------- success

scenario("success: hooks, sinks and aggregation in order", async () => {
  const trace = new Trace();
  const worker = new ScriptAgent("worker", trace, async function* () {
    yield ev("worker", [{ text: "thinking", thought: true }]);
    yield ev("worker", [{ text: "typ" }], { partial: true });
    yield ev("worker", [{ text: "narration" }], {
      usageMetadata: {
        promptTokenCount: 3,
        candidatesTokenCount: 2,
        totalTokenCount: 5,
      },
    });
    yield ev("worker", [{ functionCall: { id: "c1", name: "lookup" } }], {
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 },
    });
    yield ev("worker", [
      { functionResponse: { id: "c1", name: "lookup", response: { v: 1 } } },
    ]);
    yield ev("worker", [{ text: "final answer" }], {
      stateDelta: { result: "x" },
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15,
        cachedContentTokenCount: 4,
      },
    });
  });
  const gateway = tracedGateway(trace, [worker]);
  const result = await settle(
    trace,
    gateway.run({
      agentName: "worker",
      input: userText("task"),
      parentContext: parentContext(new BaseAgentStub("root")),
      branch: "root.worker",
      ...traced(trace),
    }),
  );
  return { trace: trace.lines, results: [projectResult(result)] };
});

scenario("success: agentName comes from the resolved agent", async () => {
  const trace = new Trace();
  const worker = new ScriptAgent("worker", trace, async function* () {
    yield ev("worker", [{ text: "hi" }]);
  });
  const gateway = new AgentInvocationGateway({ resolveAgent: () => worker });
  const result = await settle(
    trace,
    gateway.run({
      agentName: "alias",
      input: userText("task"),
      parentContext: parentContext(new BaseAgentStub("root")),
    }),
  );
  return { trace: trace.lines, results: [projectResult(result)] };
});

scenario("output: function-response and error fallbacks", async () => {
  const trace = new Trace();
  const responder = new ScriptAgent("responder", trace, async function* () {
    yield ev("responder", [
      { functionResponse: { id: "a", name: "t", response: { output: "out" } } },
    ]);
    yield ev("responder", [
      { functionResponse: { id: "b", name: "t", response: { n: 2 } } },
    ]);
    yield ev("responder", [
      { functionResponse: { id: "c", name: "t", response: {} } },
    ]);
  });
  const errorer = new ScriptAgent("errorer", trace, async function* () {
    yield ev("errorer", [], { errorMessage: "first failure" });
    yield ev("errorer", [], { errorMessage: "second failure" });
  });
  const nonFinal = new ScriptAgent("nonfinal", trace, async function* () {
    yield ev("nonfinal", [{ text: "a" }, { text: "" }, { text: "b" }]);
    yield ev("nonfinal", [
      { text: "calling" },
      { functionCall: { id: "z", name: "tool" } },
    ]);
  });
  const gateway = tracedGateway(trace, [responder, errorer, nonFinal]);
  const results: Record<string, unknown>[] = [];
  for (const agentName of ["responder", "errorer", "nonfinal"]) {
    results.push(
      projectResult(
        await settle(
          trace,
          gateway.run({
            agentName,
            input: userText("go"),
            parentContext: parentContext(new BaseAgentStub("root")),
          }),
        ),
      ),
    );
  }
  return { trace: trace.lines, results };
});

// ------------------------------------------------------------- resolution

scenario("resolution: throw, unknown and validator ordering", async () => {
  const trace = new Trace();
  const throwing = new AgentInvocationGateway({
    resolveAgent: () => {
      trace.push("gw:resolve:throw");
      throw new Error("registry offline");
    },
  });
  const throwingString = new AgentInvocationGateway({
    resolveAgent: () => {
      trace.push("gw:resolve:throw-string");
      throw "plain string";
    },
  });
  const empty = tracedGateway(trace, []);
  const results = [
    await settle(
      trace,
      throwing.run({
        agentName: "w",
        input: userText("go"),
        parentContext: parentContext(new BaseAgentStub("root")),
        ...traced(trace),
      }),
    ),
    await settle(
      trace,
      throwingString.run({
        agentName: "w",
        input: userText("go"),
        parentContext: parentContext(new BaseAgentStub("root")),
        ...traced(trace),
      }),
    ),
    await settle(
      trace,
      empty.run({
        agentName: "ghost",
        input: userText("go"),
        parentContext: parentContext(new BaseAgentStub("root")),
        resume: { events: [] },
        ...traced(trace),
      }),
    ),
  ];
  return { trace: trace.lines, results: results.map(projectResult) };
});

scenario("validator: a rejection at each phase escapes", async () => {
  const trace = new Trace();
  const worker = new ScriptAgent("worker", trace, async function* () {
    yield ev("worker", [{ text: "ran" }]);
  });
  const gateway = tracedGateway(trace, [worker]);
  for (const deny of ["before-resolve", "before-prepare", "before-execute"]) {
    const hooks = traced(trace);
    try {
      await settle(
        trace,
        gateway.run({
          agentName: "worker",
          input: userText("go"),
          parentContext: parentContext(new BaseAgentStub("root")),
          ...hooks,
          validateInvocation: (phase) => {
            trace.push(`req:validate:${phase}`);
            if (phase === deny) throw new TypeError(`denied ${phase}`);
          },
        }),
      );
    } catch (caught) {
      trace.push(`caught:${(caught as Error).constructor.name}`);
    }
  }
  return { trace: trace.lines, results: [] };
});

// ----------------------------------------------------------------- resume

scenario("resume validation: every rejection path", async () => {
  const trace = new Trace();
  const worker = new ScriptAgent("worker", trace, async function* () {
    yield ev("worker", [{ text: "should not run" }]);
  });
  const gateway = tracedGateway(trace, [worker]);
  const base = {
    agentName: "alias-of-worker",
    parentContext: parentContext(new BaseAgentStub("root")),
  };
  // Resolver maps any name to the worker so agentName differs from agent.name.
  const aliasing = new AgentInvocationGateway({
    resolveAgent: (name) => {
      trace.push(`gw:resolve:${name}`);
      return worker;
    },
  });
  const pending = [ev("user", [{ text: "go" }]), confirmation("req-1")];
  const cases: [string, AgentInvocationRequest][] = [
    [
      "no pending interrupt",
      {
        ...base,
        input: answer("req-1", REQUEST_CONFIRMATION_FUNCTION_CALL_NAME),
        resume: { events: [ev("worker", [{ text: "done" }])] },
      },
    ],
    [
      "empty resume events",
      {
        ...base,
        input: answer("req-1", REQUEST_CONFIRMATION_FUNCTION_CALL_NAME),
        resume: { events: [] },
      },
    ],
    [
      "text input",
      { ...base, input: userText("yes"), resume: { events: pending } },
    ],
    [
      "input without parts",
      { ...base, input: { role: "user" }, resume: { events: pending } },
    ],
    [
      "unrelated id",
      {
        ...base,
        input: answer("other", REQUEST_CONFIRMATION_FUNCTION_CALL_NAME),
        resume: { events: pending },
      },
    ],
    [
      "non-string id",
      {
        ...base,
        input: {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: 7 as unknown as string,
                name: "x",
                response: {},
              },
            },
          ],
        },
        resume: { events: pending },
      },
    ],
    [
      "pending only on a partial event",
      {
        ...base,
        input: answer("req-1", REQUEST_CONFIRMATION_FUNCTION_CALL_NAME),
        resume: { events: [confirmation("req-1", { partial: true })] },
      },
    ],
    [
      "already answered in the resume events",
      {
        ...base,
        input: answer("req-1", REQUEST_CONFIRMATION_FUNCTION_CALL_NAME),
        resume: {
          events: [
            ...pending,
            ev("user", [
              {
                functionResponse: {
                  id: "req-1",
                  name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
                  response: {},
                },
              },
            ]),
          ],
        },
      },
    ],
  ];
  const results: Record<string, unknown>[] = [];
  for (const [label, request] of cases) {
    trace.push(`case:${label}`);
    results.push(
      projectResult(
        await settle(trace, aliasing.run({ ...request, ...traced(trace) })),
      ),
    );
  }
  // Resolution runs before resume validation: an unknown agent wins.
  trace.push("case:unknown agent with a bad resume");
  results.push(
    projectResult(
      await settle(
        trace,
        gateway.run({
          ...base,
          agentName: "ghost",
          input: userText("x"),
          resume: { events: [] },
          ...traced(trace),
        }),
      ),
    ),
  );
  return { trace: trace.lines, results };
});

scenario("resume: answering one of two pending calls", async () => {
  const trace = new Trace();
  const worker = new ScriptAgent("worker", trace, async function* (context) {
    trace.push(
      `history:${context.session.events.map((e) => `${e.author}/${eventType(e)}`).join(",")}`,
    );
    yield ev("worker", [{ text: "half done" }]);
  });
  const gateway = tracedGateway(trace, [worker]);
  const prior = [
    ev("user", [{ text: "go" }]),
    ev(
      "worker",
      [
        { functionCall: { id: "a", name: "slow" } },
        { functionCall: { id: "b", name: "slow" } },
      ],
      { longRunningToolIds: ["a", "b"] },
    ),
  ];
  const result = await settle(
    trace,
    gateway.run({
      agentName: "worker",
      input: answer("b", "slow"),
      parentContext: parentContext(new BaseAgentStub("root")),
      resume: { events: prior },
      ...traced(trace),
    }),
  );
  return { trace: trace.lines, results: [projectResult(result)] };
});

scenario("interrupt and resume: ordering of history and events", async () => {
  const trace = new Trace();
  let round = 0;
  const worker = new ScriptAgent("worker", trace, async function* (context) {
    round++;
    trace.push(
      `round${round}:history:${context.session.events.map((e) => `${e.author}/${eventType(e)}`).join(",")}`,
    );
    trace.push(`round${round}:state:${stableJson(context.session.state)}`);
    if (round === 1) {
      yield ev("worker", [{ text: "asking" }], {
        stateDelta: { stage: "asked", "temp:t": 1 },
      });
      yield ev("worker", [{ text: "ask" }], { partial: true });
      yield confirmation("req-1");
      return;
    }
    if (round === 2) {
      yield ev("worker", [{ text: "need input" }], {
        stateDelta: { stage: "second" },
      });
      yield ev(
        "worker",
        [
          {
            functionCall: {
              id: "in-1",
              name: REQUEST_INPUT_FUNCTION_CALL_NAME,
              args: { message: "Name?" },
            },
          },
        ],
        { longRunningToolIds: ["in-1"] },
      );
      return;
    }
    yield ev("worker", [{ text: "all done" }], {
      stateDelta: { stage: "done" },
    });
  });
  const gateway = tracedGateway(trace, [worker]);
  const context = parentContext(new BaseAgentStub("root"));
  const first = await settle(
    trace,
    gateway.run({
      agentName: "worker",
      input: userText("go"),
      parentContext: context,
      ...traced(trace),
    }),
  );
  const second = await settle(
    trace,
    gateway.run({
      agentName: "worker",
      input: answer("req-1", REQUEST_CONFIRMATION_FUNCTION_CALL_NAME),
      parentContext: context,
      resume: { events: first.interrupt?.events ?? [] },
      ...traced(trace),
    }),
  );
  const third = await settle(
    trace,
    gateway.run({
      agentName: "worker",
      input: answer("in-1", REQUEST_INPUT_FUNCTION_CALL_NAME),
      parentContext: context,
      resume: { events: second.interrupt?.events ?? [] },
      sessionHistoryMode: "inherit",
      ...traced(trace),
    }),
  );
  return {
    trace: trace.lines,
    results: [first, second, third].map(projectResult),
    facts: {
      parentEventsAfter: context.session.events.length,
      parentStateAfter: context.session.state,
    },
  };
});

scenario("resume with appendInput false", async () => {
  const trace = new Trace();
  const worker = new ScriptAgent("worker", trace, async function* (context) {
    trace.push(
      `history:${context.session.events.map((e) => `${e.author}/${eventType(e)}`).join(",")}`,
    );
    trace.push(`userContent:${JSON.stringify(context.userContent)}`);
    yield ev("worker", [{ functionCall: { id: "s1", name: "slow" } }], {
      longRunningToolIds: ["s1"],
    });
  });
  const gateway = tracedGateway(trace, [worker]);
  const input = userText("previous task");
  const result = await settle(
    trace,
    gateway.run({
      agentName: "worker",
      input,
      parentContext: parentContext(new BaseAgentStub("root")),
      sessionHistoryMode: "inherit",
      appendInput: false,
      ...traced(trace),
    }),
  );
  return { trace: trace.lines, results: [projectResult(result)] };
});

// ------------------------------------------------------------------ state

scenario("stateDelta: merge order, temp: and partial filtering", async () => {
  const trace = new Trace();
  const worker = new ScriptAgent("worker", trace, async function* (context) {
    yield ev("worker", [{ text: "one" }], {
      stateDelta: { a: 1, b: { nested: true }, "temp:x": 1 },
    });
    yield ev("worker", [{ text: "p" }], {
      partial: true,
      stateDelta: { a: "partial", p: 1 },
    });
    yield ev("worker", [{ text: "two" }], {
      stateDelta: { a: 2, "temp:y": 2, c: null },
    });
    trace.push(`childState:${stableJson(context.session.state)}`);
  });
  const tempOnly = new ScriptAgent("temponly", trace, async function* () {
    yield ev("temponly", [{ text: "t" }], { stateDelta: { "temp:z": 1 } });
  });
  const gateway = tracedGateway(trace, [worker, tempOnly]);
  const context = parentContext(new BaseAgentStub("root"));
  const merged = await settle(
    trace,
    gateway.run({
      agentName: "worker",
      input: userText("go"),
      parentContext: context,
      sessionState: { projected: 1 },
    }),
  );
  const replaced = await settle(
    trace,
    gateway.run({
      agentName: "worker",
      input: userText("go"),
      parentContext: context,
      sessionState: { projected: 2 },
      sessionStateMode: "replace",
    }),
  );
  const temp = await settle(
    trace,
    gateway.run({
      agentName: "temponly",
      input: userText("go"),
      parentContext: context,
    }),
  );
  return {
    trace: trace.lines,
    results: [merged, replaced, temp].map(projectResult),
    facts: {
      parentState: context.session.state,
      replacedChildFrozen: Object.isFrozen(worker.context?.session.state),
    },
  };
});

scenario("stateDelta: resume events seed the child state", async () => {
  const trace = new Trace();
  const worker = new ScriptAgent("worker", trace, async function* (context) {
    trace.push(`childState:${stableJson(context.session.state)}`);
    yield ev("worker", [{ text: "resumed" }]);
  });
  const gateway = tracedGateway(trace, [worker]);
  const prior = [
    ev("user", [{ text: "go" }], { stateDelta: { fromUser: 1 } }),
    ev("worker", [{ text: "x" }], {
      partial: true,
      stateDelta: { fromPartial: 1 },
    }),
    ev("worker", [{ functionCall: { id: "s1", name: "slow" } }], {
      longRunningToolIds: ["s1"],
      stateDelta: { stage: "asked", "temp:gone": 1, shared: "overridden" },
    }),
  ];
  const result = await settle(
    trace,
    gateway.run({
      agentName: "worker",
      input: answer("s1", "slow"),
      parentContext: parentContext(new BaseAgentStub("root")),
      resume: { events: prior },
      sessionState: { shared: "projected" },
      ...traced(trace),
    }),
  );
  return { trace: trace.lines, results: [projectResult(result)] };
});

// ----------------------------------------------------------------- errors

scenario("errors: event errors, thrown errors and preparation", async () => {
  const trace = new Trace();
  const eventErrors = new ScriptAgent("events", trace, async function* () {
    yield ev("events", [{ text: "before" }]);
    yield ev("events", [], { errorMessage: "first" });
    yield ev("events", [{ text: "between" }]);
    yield ev("events", [], { errorMessage: "second" });
    yield ev("events", [{ text: "after" }]);
  });
  const thrower = new ScriptAgent("thrower", trace, async function* () {
    yield ev("thrower", [], { errorMessage: "event error" });
    throw new Error("thrown later");
  });
  const limit = new ScriptAgent("limit", trace, async function* () {
    yield ev("limit", [{ text: "one call" }]);
    throw new LlmCallsLimitExceededError("budget exhausted");
  });
  const prepared = new ScriptAgent("prepared", trace, async function* () {
    yield ev("prepared", [{ text: "never" }]);
  });
  const gateway = tracedGateway(trace, [eventErrors, thrower, limit, prepared]);
  const base = {
    input: userText("go"),
    parentContext: parentContext(new BaseAgentStub("root")),
  };
  const results = [
    await settle(
      trace,
      gateway.run({ ...base, agentName: "events", ...traced(trace) }),
    ),
    await settle(
      trace,
      gateway.run({ ...base, agentName: "thrower", ...traced(trace) }),
    ),
    await settle(
      trace,
      gateway.run({ ...base, agentName: "limit", ...traced(trace) }),
    ),
    await settle(
      trace,
      gateway.run({
        ...base,
        agentName: "prepared",
        ...traced(trace),
        prepareContext: () => {
          trace.push("req:prepare:throw");
          throw new Error("binder refused");
        },
      }),
    ),
  ];
  return { trace: trace.lines, results: results.map(projectResult) };
});

scenario("errors: a throwing sink closes the generator", async () => {
  const trace = new Trace();
  const worker = new ScriptAgent("worker", trace, async function* () {
    yield ev("worker", [{ text: "one" }]);
    yield ev("worker", [{ text: "two" }]);
  });
  const gateway = tracedGateway(trace, [worker]);
  const result = await settle(
    trace,
    gateway.run({
      agentName: "worker",
      input: userText("go"),
      parentContext: parentContext(new BaseAgentStub("root")),
      eventSink: (event) => {
        trace.push(`req:sink:${eventType(event)}`);
        throw new Error("sink boom");
      },
    }),
  );
  await flush();
  return { trace: trace.lines, results: [projectResult(result)] };
});

// ------------------------------------------------------------------ abort

scenario("abort: in the middle of an event stream", async () => {
  const trace = new Trace();
  const worker = new ScriptAgent("worker", trace, async function* () {
    yield ev("worker", [{ text: "one" }], { stateDelta: { a: 1 } });
    yield ev("worker", [{ text: "two" }], { stateDelta: { b: 2 } });
    yield ev("worker", [{ text: "three" }]);
  });
  const gateway = tracedGateway(trace, [worker]);
  const results: Record<string, unknown>[] = [];
  for (const reason of [new Error("stop now"), "string reason", undefined]) {
    const abort = new AbortController();
    trace.push(`case:${reason instanceof Error ? "error" : typeof reason}`);
    const result = await settle(
      trace,
      gateway.run({
        agentName: "worker",
        input: userText("go"),
        parentContext: parentContext(new BaseAgentStub("root")),
        abortSignal: abort.signal,
        eventSink: (event) => {
          trace.push(`req:sink:${eventType(event)}`);
          if (eventType(event) === "text:one") abort.abort(reason);
        },
      }),
    );
    await flush();
    const projected = projectResult(result);
    // The default reason is a platform DOMException whose text may vary.
    if (reason === undefined) {
      projected.error = typeof result.error === "string" ? "<string>" : null;
      projected.output = "<omitted>";
      projected.transcript = "<omitted>";
    }
    results.push(projected);
  }
  return { trace: trace.lines, results };
});

scenario("abort: parent signal, before preparation", async () => {
  const trace = new Trace();
  const worker = new ScriptAgent("worker", trace, async function* () {
    yield ev("worker", [{ text: "never" }]);
  });
  const gateway = tracedGateway(trace, [worker]);
  const parentAbort = new AbortController();
  parentAbort.abort(new Error("parent cancelled"));
  const results = [
    await settle(
      trace,
      gateway.run({
        agentName: "worker",
        input: userText("go"),
        parentContext: parentContext(
          new BaseAgentStub("root"),
          parentAbort.signal,
        ),
        ...traced(trace),
      }),
    ),
  ];
  // Aborted during preparation: the abort wins over the preparation error.
  const during = new AbortController();
  results.push(
    await settle(
      trace,
      gateway.run({
        agentName: "worker",
        input: userText("go"),
        parentContext: parentContext(new BaseAgentStub("root")),
        abortSignal: during.signal,
        ...traced(trace),
        prepareContext: () => {
          trace.push("req:prepare:abort-then-throw");
          during.abort(new Error("cancelled while preparing"));
          throw new Error("preparation saw the abort");
        },
      }),
    ),
  );
  // Aborted by an agent that throws its own error after the signal fired.
  const inside = new AbortController();
  const thrower = new ScriptAgent("inner-thrower", trace, async function* () {
    yield ev("inner-thrower", [{ text: "x" }]);
  });
  results.push(
    await settle(
      trace,
      tracedGateway(trace, [thrower]).run({
        agentName: "inner-thrower",
        input: userText("go"),
        parentContext: parentContext(new BaseAgentStub("root")),
        abortSignal: inside.signal,
        eventSink: () => {
          trace.push("req:sink:abort-then-throw");
          inside.abort("late");
          throw new Error("sink error after abort");
        },
      }),
    ),
  );
  await flush();
  return { trace: trace.lines, results: results.map(projectResult) };
});

scenario("abort: a stalled agent releases run()", async () => {
  const trace = new Trace();
  let markStalled: () => void = () => undefined;
  const stalled = new Promise<void>((resolve) => {
    markStalled = resolve;
  });
  const worker = new ScriptAgent("stall", trace, async function* () {
    yield ev("stall", [{ text: "started" }]);
    markStalled();
    await new Promise<never>(() => undefined);
  });
  const abort = new AbortController();
  void stalled.then(() => abort.abort(new Error("stop stalled")));
  const result = await settle(
    trace,
    tracedGateway(trace, [worker]).run({
      agentName: "stall",
      input: userText("go"),
      parentContext: parentContext(new BaseAgentStub("root")),
      abortSignal: abort.signal,
    }),
  );
  await flush();
  return { trace: trace.lines, results: [projectResult(result)] };
});

// -------------------------------------------------------------- llm calls

scenario("maxLlmCalls: one budget shared by parent and children", async () => {
  const trace = new Trace();
  const makeWorker = (name: string) =>
    new LlmAgent({
      name,
      model: new ScriptedLlm([
        {
          content: { role: "model", parts: [{ text: `${name} says hi` }] },
          usageMetadata: {
            promptTokenCount: 2,
            candidatesTokenCount: 1,
            totalTokenCount: 3,
          },
        },
      ]),
    });
  const first = makeWorker("first");
  const second = makeWorker("second");
  const third = makeWorker("third");
  const gateway = tracedGateway(trace, [first, second, third]);
  const context = parentContext(new BaseAgentStub("root"));
  context.runConfig = { maxLlmCalls: 3 } as InvocationContext["runConfig"];
  context.incrementLlmCallCount();
  trace.push("parent:llm-call");
  const results: AgentInvocationResult[] = [];
  for (const agentName of ["first", "second", "third"]) {
    results.push(
      await settle(
        trace,
        gateway.run({
          agentName,
          input: userText("go"),
          parentContext: context,
        }),
      ),
    );
  }
  let parentThrows = false;
  try {
    context.incrementLlmCallCount();
  } catch (caught) {
    parentThrows = caught instanceof LlmCallsLimitExceededError;
  }
  return {
    trace: trace.lines,
    results: results.map(projectResult),
    facts: { parentThrowsAfterChildren: parentThrows },
  };
});

// ------------------------------------------------------------------ nested

scenario("nested gateways: two delegation hops", async () => {
  const trace = new Trace();
  const facts: Record<string, unknown> = {};
  const leaf = new ScriptAgent("leaf", trace, async function* (context) {
    facts.leafRootIsParentSession =
      rootSessionOf(context.session) === rootSession;
    facts.leafPermissions = getInheritedPermissions(context.session) ?? null;
    facts.leafState = { ...context.session.state };
    // The leaf shares the root's LLM call counter through both hops.
    context.incrementLlmCallCount();
    try {
      context.incrementLlmCallCount();
      facts.leafSecondCallThrows = false;
    } catch (caught) {
      facts.leafSecondCallThrows = caught instanceof LlmCallsLimitExceededError;
    }
    yield ev("leaf", [{ text: "leaf done" }], {
      stateDelta: { leaf: 1, "temp:l": 1 },
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });
  });
  const inner = tracedGateway(trace, [leaf], "inner");
  const middle = new ScriptAgent("middle", trace, async function* (context) {
    yield ev("middle", [{ text: "delegating" }], {
      stateDelta: { middle: 1 },
    });
    const result = await settle(
      trace,
      inner.run({
        agentName: "leaf",
        input: userText("leaf task"),
        parentContext: context,
        branch: "root.middle.leaf",
        sessionState: { fromMiddle: true },
        ...traced(trace, "innerReq"),
      }),
    );
    facts.innerResult = projectResult(result);
    // Forward the leaf's events into the middle's own stream.
    for (const event of result.events) yield event;
    yield ev("middle", [{ text: `middle got ${result.output}` }], {
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
    });
  });
  const outer = tracedGateway(trace, [middle], "outer");
  const context = parentContext(new BaseAgentStub("root"));
  const rootSession: Session = context.session;
  context.runConfig = { maxLlmCalls: 2 } as InvocationContext["runConfig"];
  context.incrementLlmCallCount();
  setInheritedPermissions(context.session, {
    mode: "read-only",
    allowNetwork: false,
  });
  const result = await settle(
    trace,
    outer.run({
      agentName: "middle",
      input: userText("outer task"),
      parentContext: context,
      branch: "root.middle",
      ...traced(trace, "outerReq"),
    }),
  );
  try {
    context.incrementLlmCallCount();
    facts.rootThrowsAfterLeaf = false;
  } catch (caught) {
    facts.rootThrowsAfterLeaf = caught instanceof LlmCallsLimitExceededError;
  }
  return { trace: trace.lines, results: [projectResult(result)], facts };
});

/** Minimal root agent for parent contexts. */
class BaseAgentStub extends BaseAgent {
  constructor(name: string) {
    super({ name });
  }
  protected async *runAsyncImpl() {}
  protected async *runLiveImpl() {}
}

/** Every characterization scenario, in a stable order. */
export function allScenarios(): readonly Scenario[] {
  return scenarios;
}

/** Runs every scenario and returns their records by name. */
export async function runAllScenarios(): Promise<
  Record<string, ScenarioRecord>
> {
  const records: Record<string, ScenarioRecord> = {};
  for (const { name, run } of scenarios) {
    records[name] = await run();
  }
  return records;
}
