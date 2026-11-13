import { describe, expect, test } from "bun:test";
import {
  type BaseAgent,
  createSession,
  type Event,
  ExitLoopTool,
  FunctionTool,
  type InMemoryArtifactService,
  InMemoryRunner,
  InvocationContext,
  isFinalResponse,
  LoopAgent,
  PluginManager,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  resetIdProvider,
  setIdProvider,
  type ToolUnion,
} from "@google/adk";
import { z } from "zod";
import {
  ExternalAgent,
  type ExternalAgentConfig,
  type ExternalAgentDriver,
  type ExternalAgentEvent,
  type ExternalAgentRunRequest,
} from "../../src/agents/index.js";
import type { ExternalAgentPermissionPolicy } from "../../src/agents/permissions/schema.js";
import { CLAUDE_PROVIDER } from "../../src/agents/provider/schema.js";

interface ScriptedCall {
  name: string;
  args?: Record<string, unknown>;
}

/**
 * Plays a runtime that calls bridged ADK tools the way the Claude SDK driver
 * does: a `tool_call`, the call through `adkTools.execute` (asking
 * `requestPermission` for a `confirmationRequired` result and running the call
 * again when allowed), the state delta, the `tool_result`, and then more model
 * text that must not appear once a tool ended the turn.
 */
class ToolCallingDriver implements ExternalAgentDriver {
  readonly providerId = CLAUDE_PROVIDER.id;
  readonly requests: ExternalAgentRunRequest[] = [];
  readonly results: Array<{ status: string; response: unknown }> = [];
  aborted = false;

  constructor(
    private readonly calls: ScriptedCall[],
    private readonly options: { preamble?: string; parallel?: boolean } = {},
  ) {}

  async *run(
    request: ExternalAgentRunRequest,
  ): AsyncGenerator<ExternalAgentEvent> {
    this.requests.push(request);
    request.abortSignal?.addEventListener("abort", () => {
      this.aborted = true;
    });
    const bridge = request.adkTools;
    if (!bridge) throw new Error("no ADK tools");
    if (this.options.preamble) {
      yield { type: "output", content: this.options.preamble };
    }
    if (this.options.parallel) {
      yield* this.runParallel(request);
      return;
    }
    let n = 0;
    for (const call of this.calls) {
      const exposed = `adk_tool__${call.name}`;
      const runtimeName = `mcp__adk_bridge__${exposed}`;
      const callId = `toolu_${++n}`;
      const args = call.args ?? {};
      yield { type: "tool_call", name: runtimeName, input: args, callId };
      const functionCallId = `claude-adk-${n}`;
      let result = await bridge.execute(exposed, args, request.context, {
        functionCallId,
      });
      if (result.status === "confirmationRequired") {
        const decision = (await request.requestPermission?.({
          requestId: functionCallId,
          toolName: exposed,
          input: args,
          title: result.confirmation?.hint,
        })) ?? { behavior: "deny", message: "no approver" };
        if (decision.behavior === "allow") {
          result = await bridge.execute(exposed, args, request.context, {
            functionCallId,
            toolConfirmation: { confirmed: true },
          });
        }
      }
      this.results.push({ status: result.status, response: result.response });
      if (Object.keys(result.actions.stateDelta).length > 0) {
        request.emitStateDelta?.(result.actions.stateDelta);
      }
      if (request.abortSignal?.aborted) return;
      yield {
        type: "tool_result",
        name: runtimeName,
        callId,
        result: JSON.stringify(result.response),
        ...(result.status === "ok" ? {} : { error: "failed" }),
      };
    }
    if (request.abortSignal?.aborted) return;
    yield { type: "output", content: "after the tools" };
  }

  /** All calls first (as parallel tool use), then their results in order. */
  private async *runParallel(
    request: ExternalAgentRunRequest,
  ): AsyncGenerator<ExternalAgentEvent> {
    const bridge = request.adkTools;
    if (!bridge) return;
    const calls = this.calls.map((call, index) => ({
      ...call,
      exposed: `adk_tool__${call.name}`,
      callId: `toolu_${index + 1}`,
    }));
    for (const call of calls) {
      yield {
        type: "tool_call",
        name: `mcp__adk_bridge__${call.exposed}`,
        input: call.args ?? {},
        callId: call.callId,
      };
    }
    const results = await Promise.all(
      calls.map((call) =>
        bridge.execute(call.exposed, call.args ?? {}, request.context, {
          functionCallId: `claude-adk-${call.callId}`,
        }),
      ),
    );
    for (const [index, call] of calls.entries()) {
      const result = results[index];
      if (!result) continue;
      this.results.push({ status: result.status, response: result.response });
      if (request.abortSignal?.aborted) return;
      yield {
        type: "tool_result",
        name: `mcp__adk_bridge__${call.exposed}`,
        callId: call.callId,
        result: JSON.stringify(result.response),
        ...(result.status === "ok" ? {} : { error: "failed" }),
      };
    }
    if (request.abortSignal?.aborted) return;
    yield { type: "output", content: "after the tools" };
  }
}

/** One line per event of a session view: `author:text`, `call:name`, `resp:name`. */
function describeSession(events: readonly Event[]): string[] {
  return events.flatMap((event) =>
    (event.content?.parts ?? []).flatMap((part) => {
      if (typeof part.text === "string")
        return [`${event.author}:${part.text}`];
      if (part.functionCall) return [`call:${part.functionCall.name}`];
      if (part.functionResponse) {
        const transfer = event.actions?.transferToAgent;
        return [
          `resp:${part.functionResponse.name}${transfer ? ` [${transfer}]` : ""}`,
        ];
      }
      return [];
    }),
  );
}

/** A runtime that answers with one text turn and records its request. */
class AnsweringDriver implements ExternalAgentDriver {
  readonly providerId = CLAUDE_PROVIDER.id;
  readonly requests: ExternalAgentRunRequest[] = [];
  /** The session view of each run, as it was when the run started. */
  readonly sessions: string[][] = [];

  constructor(private readonly answer: string) {}

  async *run(
    request: ExternalAgentRunRequest,
  ): AsyncGenerator<ExternalAgentEvent> {
    this.requests.push(request);
    this.sessions.push(describeSession(request.context.session.events));
    yield { type: "output", content: this.answer };
  }
}

function externalAgent(
  name: string,
  driver: ExternalAgentDriver,
  extra: Partial<ExternalAgentConfig> = {},
): ExternalAgent {
  return new ExternalAgent({
    name,
    provider: CLAUDE_PROVIDER,
    driver,
    ...extra,
  });
}

async function run(agent: BaseAgent, message: unknown = text("go")) {
  const runner = new InMemoryRunner({ agent, appName: "app" });
  const session = await runner.sessionService.createSession({
    appName: "app",
    userId: "user",
  });
  const events = await turn(runner, session.id, message);
  return { runner, sessionId: session.id, events };
}

async function turn(
  runner: InMemoryRunner,
  sessionId: string,
  message: unknown,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: "user",
    sessionId,
    newMessage: message as never,
  })) {
    events.push(event);
  }
  return events;
}

function text(value: string) {
  return { role: "user", parts: [{ text: value }] };
}

function texts(events: readonly Event[]): string[] {
  return events.flatMap((event) =>
    (event.content?.parts ?? []).flatMap((part) =>
      typeof part.text === "string" ? [part.text] : [],
    ),
  );
}

function toolResultEvent(events: readonly Event[], name: string) {
  return events.find((event) =>
    event.content?.parts?.some(
      (part) =>
        part.functionResponse?.name === `mcp__adk_bridge__adk_tool__${name}`,
    ),
  );
}

function tool(
  name: string,
  execute: ConstructorParameters<typeof FunctionTool>[0]["execute"],
): FunctionTool {
  return new FunctionTool({
    name,
    description: name,
    parameters: z.object({}),
    execute,
  });
}

describe("bridged ADK tools: escalate", () => {
  test("rides on the result without ending the turn; a LoopAgent stops after the turn", async () => {
    const escalating = tool("escalate", (_args, context) => {
      if (context) context.actions.escalate = true;
      return { done: true };
    });
    const driver = new ToolCallingDriver([{ name: "escalate" }]);
    const loop = new LoopAgent({
      name: "loop",
      maxIterations: 3,
      subAgents: [externalAgent("worker", driver, { tools: [escalating] })],
    });

    const { events } = await run(loop);

    expect(driver.requests).toHaveLength(1);
    expect(driver.aborted).toBe(false);
    const response = toolResultEvent(events, "escalate");
    expect(response?.actions.escalate).toBe(true);
    expect(response?.actions.skipSummarization).toBeUndefined();
    // The runtime summarizes after the tool, as an LlmAgent would.
    expect(texts(events)).toContain("after the tools");
    expect(events.indexOf(response as Event)).toBeLessThan(
      events.findIndex((event) =>
        event.content?.parts?.some((part) => part.text === "after the tools"),
      ),
    );
    expect(events.some((event) => event.errorCode)).toBe(false);
  });

  test("ADK's ExitLoopTool (escalate and skipSummarization) ends the turn and the loop", async () => {
    const driver = new ToolCallingDriver([{ name: "exit_loop" }]);
    const loop = new LoopAgent({
      name: "loop",
      maxIterations: 3,
      subAgents: [
        externalAgent("worker", driver, { tools: [new ExitLoopTool()] }),
      ],
    });

    const { events } = await run(loop);

    expect(driver.requests).toHaveLength(1);
    expect(driver.aborted).toBe(true);
    const response = toolResultEvent(events, "exit_loop");
    expect(response?.actions.escalate).toBe(true);
    expect(response?.actions.skipSummarization).toBe(true);
    expect(texts(events)).not.toContain("after the tools");
  });

  test("without escalate the loop keeps iterating", async () => {
    const noop = tool("noop", () => ({ done: true }));
    const driver = new ToolCallingDriver([{ name: "noop" }]);
    const loop = new LoopAgent({
      name: "loop",
      maxIterations: 2,
      subAgents: [externalAgent("worker", driver, { tools: [noop] })],
    });

    const { events } = await run(loop);

    expect(driver.requests).toHaveLength(2);
    expect(texts(events)).toContain("after the tools");
  });
});

describe("bridged ADK tools: skipSummarization", () => {
  test("the tool response is the final response of the turn", async () => {
    const final = tool("final_answer", (_args, context) => {
      if (context) context.actions.skipSummarization = true;
      return { answer: 42 };
    });
    const driver = new ToolCallingDriver([{ name: "final_answer" }]);

    const { events } = await run(
      externalAgent("worker", driver, { tools: [final] }),
    );

    const response = toolResultEvent(events, "final_answer");
    expect(response?.actions.skipSummarization).toBe(true);
    expect(response && isFinalResponse(response)).toBe(true);
    expect(events.at(-1)).toBe(response);
    expect(texts(events)).not.toContain("after the tools");
  });
});

describe("bridged ADK tools: transferToAgent", () => {
  function transferTool(target: string): FunctionTool {
    return tool("handoff", (_args, context) => {
      if (context) context.actions.transferToAgent = target;
      return { transferred: target };
    });
  }

  test("ends the turn and runs the target with the inherited policy", async () => {
    const helperDriver = new AnsweringDriver("helper answer");
    const helper = externalAgent("helper", helperDriver, {
      permissions: { mode: "full-access", allowNetwork: true },
    });
    const driver = new ToolCallingDriver([{ name: "handoff" }]);
    const coordinator = externalAgent("coordinator", driver, {
      tools: [transferTool("helper")],
      permissions: { mode: "workspace-write", allowNetwork: false },
      subAgents: [helper],
    });

    const { events } = await run(coordinator, text("please help"));

    const response = toolResultEvent(events, "handoff");
    expect(response?.actions.transferToAgent).toBe("helper");
    expect(texts(events)).toContain("helper answer");
    expect(texts(events)).not.toContain("after the tools");
    const helperIndex = events.findIndex((event) => event.author === "helper");
    expect(helperIndex).toBeGreaterThan(events.indexOf(response as Event));
    expect(helperDriver.requests).toHaveLength(1);
    const policy = helperDriver.requests[0]
      ?.permissions as ExternalAgentPermissionPolicy;
    expect(policy.mode).toBe("workspace-write");
    expect(policy.allowNetwork).toBe(false);
    expect(
      helperDriver.requests[0]?.context.userContent?.parts?.[0]?.text,
    ).toBe("please help");
  });

  test("the target sees the user message once, then the coordinator's text, call and transfer response", async () => {
    const helperDriver = new AnsweringDriver("helper answer");
    const helper = externalAgent("helper", helperDriver);
    const driver = new ToolCallingDriver([{ name: "handoff" }], {
      preamble: "let me hand off",
    });
    const coordinator = externalAgent("coordinator", driver, {
      tools: [transferTool("helper")],
      subAgents: [helper],
    });

    await run(coordinator, text("please help"));

    expect(helperDriver.sessions[0]).toEqual([
      "user:please help",
      "coordinator:let me hand off",
      "call:mcp__adk_bridge__adk_tool__handoff",
      "resp:mcp__adk_bridge__adk_tool__handoff [helper]",
    ]);
    expect(helperDriver.requests[0]?.context.userContent).toEqual(
      text("please help"),
    );
  });

  test("from a context without a user message, the fallback input is appended for the target", async () => {
    const helperDriver = new AnsweringDriver("helper answer");
    const driver = new ToolCallingDriver([{ name: "handoff" }]);
    const coordinator = externalAgent("coordinator", driver, {
      tools: [transferTool("helper")],
      subAgents: [externalAgent("helper", helperDriver)],
    });
    // A host or workflow can build the context without `userContent`.
    const context = new InvocationContext({
      invocationId: "inv-no-user",
      agent: coordinator,
      session: createSession({ id: "s1", appName: "app", userId: "user" }),
      pluginManager: new PluginManager(),
    });

    const events: Event[] = [];
    for await (const event of coordinator.runAsync(context)) {
      events.push(event);
    }

    const fallback = {
      role: "user",
      parts: [{ text: "Transferred from coordinator." }],
    };
    expect(helperDriver.sessions[0]?.at(-1)).toBe(
      "user:Transferred from coordinator.",
    );
    expect(helperDriver.requests[0]?.context.userContent).toEqual(fallback);
    expect(texts(events)).toContain("helper answer");
  });

  test("a failed result does not carry a transfer meant for another call of the tool", async () => {
    const handoff = new FunctionTool({
      name: "handoff",
      description: "handoff",
      parameters: z.object({ fail: z.boolean() }),
      execute: ({ fail }, context) => {
        if (fail) throw new Error("not this one");
        if (context) context.actions.transferToAgent = "helper";
        return { transferred: true };
      },
    });
    const helperDriver = new AnsweringDriver("helper answer");
    const driver = new ToolCallingDriver(
      [
        { name: "handoff", args: { fail: true } },
        { name: "handoff", args: { fail: false } },
      ],
      { parallel: true },
    );
    const coordinator = externalAgent("coordinator", driver, {
      tools: [handoff],
      subAgents: [externalAgent("helper", helperDriver)],
    });

    const { events } = await run(coordinator);

    const results = events.filter((event) =>
      event.content?.parts?.some((part) => part.functionResponse),
    );
    expect(results).toHaveLength(2);
    expect(results[0]?.actions.transferToAgent).toBeUndefined();
    expect(results[1]?.actions.transferToAgent).toBe("helper");
    expect(texts(events)).toContain("helper answer");
    expect(texts(events)).not.toContain("after the tools");
  });

  test("reaches an agent elsewhere in the tree, capped by the caller", async () => {
    const peerDriver = new AnsweringDriver("peer answer");
    const peer = externalAgent("peer", peerDriver, {
      permissions: { mode: "full-access" },
    });
    const driver = new ToolCallingDriver([{ name: "handoff" }]);
    const worker = externalAgent("worker", driver, {
      tools: [transferTool("peer")],
      permissions: { mode: "ask" },
    });
    // Building the root links worker and peer as siblings under it.
    const root = externalAgent("root", new AnsweringDriver("unused"), {
      permissions: { mode: "full-access" },
      subAgents: [worker, peer],
    });
    expect(peer.parentAgent).toBe(root);

    // The worker runs directly, as ADK routes a turn to the agent that spoke
    // last; it has no sub-agents of its own.
    const { events } = await run(worker);

    expect(texts(events)).toContain("peer answer");
    expect(texts(events)).not.toContain("unused");
    expect(peerDriver.requests[0]?.permissions?.mode).toBe("ask");
  });

  test("an unknown target fails the call and the turn goes on", async () => {
    const driver = new ToolCallingDriver([{ name: "handoff" }]);
    const { events } = await run(
      externalAgent("worker", driver, { tools: [transferTool("nobody")] }),
    );

    expect(driver.results[0]?.status).toBe("error");
    expect(JSON.stringify(driver.results[0]?.response)).toContain("nobody");
    expect(
      events.some((event) => event.actions.transferToAgent !== undefined),
    ).toBe(false);
    expect(texts(events)).toContain("after the tools");
  });

  test("a transfer to the agent itself fails the call", async () => {
    const driver = new ToolCallingDriver([{ name: "handoff" }]);
    const { events } = await run(
      externalAgent("worker", driver, { tools: [transferTool("worker")] }),
    );

    expect(driver.results[0]?.status).toBe("error");
    expect(texts(events)).toContain("after the tools");
  });

  test("a target that throws is reported as EXTERNAL_AGENT_TRANSFER_FAILED", async () => {
    const broken: ExternalAgentDriver = {
      providerId: CLAUDE_PROVIDER.id,
      // biome-ignore lint/correctness/useYield: the driver fails before its first event.
      async *run() {
        throw new Error("boom");
      },
    };
    const driver = new ToolCallingDriver([{ name: "handoff" }]);
    const coordinator = externalAgent("coordinator", driver, {
      tools: [transferTool("broken")],
      subAgents: [externalAgent("broken", broken)],
    });

    const { events } = await run(coordinator);

    const failure = events.find(
      (event) => event.errorCode === "EXTERNAL_AGENT_TRANSFER_FAILED",
    );
    expect(failure?.errorMessage).toContain("boom");
  });
});

describe("bridged ADK tools: artifactDelta", () => {
  test("saves through the artifact service and surfaces the delta", async () => {
    const report = tool("write_report", async (_args, context) => {
      const version = await context?.saveArtifact("report.txt", {
        text: "quarterly numbers",
      });
      return { version };
    });
    const driver = new ToolCallingDriver([{ name: "write_report" }]);
    const agent = externalAgent("worker", driver, { tools: [report] });

    const { runner, sessionId, events } = await run(agent);

    const delta = events.find(
      (event) => Object.keys(event.actions.artifactDelta).length > 0,
    );
    expect(delta?.actions.artifactDelta).toEqual({ "report.txt": 0 });
    const saved = await runner.artifactService?.loadArtifact({
      appName: "app",
      userId: "user",
      sessionId,
      filename: "report.txt",
    });
    expect(saved?.text).toBe("quarterly numbers");
    // Not a terminal action: the turn goes on.
    expect(texts(events)).toContain("after the tools");
  });
});

describe("bridged ADK tools: requestConfirmation inside execute", () => {
  /** Asks inside `execute` and reports the decision it got. */
  function guardedTool(runs: Array<boolean | undefined>): ToolUnion {
    return tool("deploy", (_args, context) => {
      const decision = context?.toolConfirmation;
      runs.push(decision?.confirmed);
      if (!decision) {
        context?.state.set("deploy_attempt", "first");
        context?.requestConfirmation({
          hint: "Deploy to production?",
          payload: { env: "prod" },
        });
        return { status: "waiting" };
      }
      context?.state.set("deployed", decision.confirmed);
      return { deployed: decision.confirmed };
    });
  }

  test("an approver's approval runs the tool again with the decision", async () => {
    const runs: Array<boolean | undefined> = [];
    const titles: Array<string | undefined> = [];
    const driver = new ToolCallingDriver([{ name: "deploy" }]);
    const { runner, sessionId } = await run(
      externalAgent("worker", driver, {
        tools: [guardedTool(runs)],
        permissions: { mode: "ask" },
        confirmation: {
          approver: (request) => {
            titles.push(request.title);
            return true;
          },
        },
      }),
    );

    expect(titles).toEqual(["Deploy to production?"]);
    expect(runs).toEqual([undefined, true]);
    expect(driver.results[0]).toEqual({
      status: "ok",
      response: { deployed: true },
    });
    const session = await runner.sessionService.getSession({
      appName: "app",
      userId: "user",
      sessionId,
    });
    // The first, unconfirmed run's state change is dropped, as in ADK.
    expect(session?.state.deployed).toBe(true);
    expect(session?.state.deploy_attempt).toBeUndefined();
  });

  test("a rejection runs the tool again with confirmed: false", async () => {
    const runs: Array<boolean | undefined> = [];
    const driver = new ToolCallingDriver([{ name: "deploy" }]);
    await run(
      externalAgent("worker", driver, {
        tools: [guardedTool(runs)],
        permissions: { mode: "ask" },
        confirmation: { approver: () => false },
      }),
    );

    expect(runs).toEqual([undefined, false]);
    expect(driver.results[0]?.response).toEqual({ deployed: false });
  });

  test("without an approver the tool sees a rejection", async () => {
    const runs: Array<boolean | undefined> = [];
    const driver = new ToolCallingDriver([{ name: "deploy" }]);
    await run(
      externalAgent("worker", driver, {
        tools: [guardedTool(runs)],
        permissions: { mode: "ask" },
      }),
    );

    expect(runs).toEqual([undefined, false]);
  });

  test("the ADK confirmation protocol pauses the call once and resumes it", async () => {
    const runs: Array<boolean | undefined> = [];
    const first = new ToolCallingDriver([{ name: "deploy" }]);
    const second = new ToolCallingDriver([{ name: "deploy" }]);
    let current = first;
    const agent = externalAgent(
      "worker",
      { providerId: CLAUDE_PROVIDER.id, run: (r) => current.run(r) },
      {
        tools: [guardedTool(runs)],
        permissions: { mode: "ask" },
        confirmation: { adk: true },
      },
    );

    const { runner, sessionId, events } = await run(agent);

    const requests = events.flatMap((event) =>
      (event.content?.parts ?? []).flatMap((part) =>
        part.functionCall?.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME
          ? [part.functionCall]
          : [],
      ),
    );
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0]?.args)).toContain(
      "Deploy to production?",
    );
    // Paused: the tool ran once, up to its request, and not again.
    expect(runs).toEqual([undefined]);
    expect(texts(events)).not.toContain("after the tools");
    expect(events.some((event) => event.errorCode)).toBe(false);

    current = second;
    const resumed = await turn(runner, sessionId, {
      role: "user",
      parts: [
        {
          functionResponse: {
            id: requests[0]?.id,
            name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
            response: { confirmed: true },
          },
        },
      ],
    });

    // The retried call takes the stored answer first and runs once, with it.
    expect(runs).toEqual([undefined, true]);
    expect(second.results[0]?.response).toEqual({ deployed: true });
    expect(
      resumed.some((event) =>
        event.content?.parts?.some(
          (part) =>
            part.functionCall?.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
        ),
      ),
    ).toBe(false);
  });

  test("a resumed call without a function call id gets adk-bridge-<id> from ADK's id provider", async () => {
    let n = 0;
    setIdProvider(() => `id-${++n}`);
    try {
      const runs: Array<boolean | undefined> = [];
      const callIds: Array<string | undefined> = [];
      const deploy = tool("deploy", (_args, context) => {
        const decision = context?.toolConfirmation;
        runs.push(decision?.confirmed);
        callIds.push(context?.functionCallId);
        if (!decision) {
          context?.requestConfirmation({ hint: "Deploy to production?" });
          return { status: "waiting" };
        }
        return { deployed: decision.confirmed };
      });
      // The resumed runtime calls the tool without a function call id.
      const second: ExternalAgentDriver = {
        providerId: CLAUDE_PROVIDER.id,
        async *run(request) {
          await request.adkTools?.execute(
            "adk_tool__deploy",
            {},
            request.context,
          );
          yield { type: "output", content: "done" };
        },
      };
      let current: ExternalAgentDriver = new ToolCallingDriver([
        { name: "deploy" },
      ]);
      const agent = externalAgent(
        "worker",
        { providerId: CLAUDE_PROVIDER.id, run: (r) => current.run(r) },
        {
          tools: [deploy],
          permissions: { mode: "ask" },
          confirmation: { adk: true },
        },
      );
      const { runner, sessionId, events } = await run(agent);
      const request = events
        .flatMap((event) => event.content?.parts ?? [])
        .find(
          (part) =>
            part.functionCall?.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
        )?.functionCall;
      expect(request).toBeDefined();

      current = second;
      await turn(runner, sessionId, {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: request?.id,
              name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
              response: { confirmed: true },
            },
          },
        ],
      });

      expect(runs).toEqual([undefined, true]);
      expect(callIds[1]).toMatch(/^adk-bridge-id-\d+$/);
    } finally {
      resetIdProvider();
    }
  });

  test("a malformed retry leaves the human's answer for the well-formed one", async () => {
    const runs: Array<boolean | undefined> = [];
    const statuses: string[] = [];
    const args = { input: "prod" };
    const first = new ToolCallingDriver([{ name: "deploy", args }]);
    // On resume the runtime first retries with arguments that are not an
    // object (the bridge rejects them), then with the original ones.
    const second: ExternalAgentDriver = {
      providerId: CLAUDE_PROVIDER.id,
      async *run(request) {
        const bridge = request.adkTools;
        if (!bridge) throw new Error("no ADK tools");
        for (const callArgs of ["prod", args]) {
          const result = await bridge.execute(
            "adk_tool__deploy",
            callArgs,
            request.context,
            { functionCallId: `retry-${statuses.length}` },
          );
          statuses.push(result.error?.code ?? result.status);
        }
        yield { type: "output", content: "done" };
      },
    };
    let current: ExternalAgentDriver = first;
    const agent = externalAgent(
      "worker",
      { providerId: CLAUDE_PROVIDER.id, run: (r) => current.run(r) },
      {
        tools: [guardedTool(runs)],
        permissions: { mode: "ask" },
        confirmation: { adk: true },
      },
    );

    const { runner, sessionId, events } = await run(agent);
    const request = events
      .flatMap((event) => event.content?.parts ?? [])
      .find(
        (part) =>
          part.functionCall?.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
      )?.functionCall;
    expect(request).toBeDefined();

    current = second;
    const resumed = await turn(runner, sessionId, {
      role: "user",
      parts: [
        {
          functionResponse: {
            id: request?.id,
            name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
            response: { confirmed: true },
          },
        },
      ],
    });

    expect(statuses).toEqual(["INVALID_ARGUMENTS", "ok"]);
    expect(runs).toEqual([undefined, true]);
    expect(
      resumed.some((event) =>
        event.content?.parts?.some(
          (part) =>
            part.functionCall?.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
        ),
      ),
    ).toBe(false);
  });

  test("on resume an artifact saved before the request gets one new version, not two", async () => {
    const decisions: Array<boolean | undefined> = [];
    const logged = tool("deploy", async (_args, context) => {
      decisions.push(context?.toolConfirmation?.confirmed);
      await context?.saveArtifact("deploy-log.txt", { text: "attempt" });
      if (!context?.toolConfirmation) {
        context?.requestConfirmation({ hint: "Deploy?" });
        return { status: "waiting" };
      }
      return { deployed: context.toolConfirmation.confirmed };
    });
    let current = new ToolCallingDriver([{ name: "deploy" }]);
    const agent = externalAgent(
      "worker",
      { providerId: CLAUDE_PROVIDER.id, run: (r) => current.run(r) },
      {
        tools: [logged],
        permissions: { mode: "ask" },
        confirmation: { adk: true },
      },
    );
    const { runner, sessionId, events } = await run(agent);
    const request = events
      .flatMap((event) => event.content?.parts ?? [])
      .find(
        (part) =>
          part.functionCall?.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
      )?.functionCall;

    current = new ToolCallingDriver([{ name: "deploy" }]);
    await turn(runner, sessionId, {
      role: "user",
      parts: [
        {
          functionResponse: {
            id: request?.id,
            name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
            response: { confirmed: true },
          },
        },
      ],
    });

    expect(decisions).toEqual([undefined, true]);
    // InMemoryRunner always builds an InMemoryArtifactService.
    const artifacts = runner.artifactService as
      | InMemoryArtifactService
      | undefined;
    const versions = await artifacts?.listVersions({
      appName: "app",
      userId: "user",
      sessionId,
      filename: "deploy-log.txt",
    });
    expect(versions).toEqual([0, 1]);
  });

  test("a read-only policy is never confirmable: the tool sees a rejection", async () => {
    const runs: Array<boolean | undefined> = [];
    const driver = new ToolCallingDriver([{ name: "deploy" }]);
    await run(
      externalAgent("worker", driver, {
        tools: [guardedTool(runs)],
        readOnlyTools: ["deploy"],
        permissions: { mode: "read-only" },
        confirmation: { approver: () => true },
      }),
    );

    expect(runs).toEqual([undefined, false]);
  });
});

describe("delegation through run_adk_subagent", () => {
  /** Writes some text, then delegates as the Claude SDK driver's tool does. */
  class DelegatingDriver implements ExternalAgentDriver {
    readonly providerId = CLAUDE_PROVIDER.id;

    async *run(
      request: ExternalAgentRunRequest,
    ): AsyncGenerator<ExternalAgentEvent> {
      yield { type: "output", content: "I will delegate" };
      await request.toolGateway?.runSubAgent({
        agentName: "helper",
        task: "do it",
      });
    }
  }

  test("the target sees the coordinator's text and the transfer call and response before its task", async () => {
    const helperDriver = new AnsweringDriver("helper answer");
    const coordinator = externalAgent("coordinator", new DelegatingDriver(), {
      subAgents: [externalAgent("helper", helperDriver)],
    });

    await run(coordinator, text("please help"));

    expect(helperDriver.sessions[0]).toEqual([
      "user:please help",
      "coordinator:I will delegate",
      "call:transfer_to_agent",
      "resp:transfer_to_agent [helper]",
      "user:do it",
    ]);
  });
});

describe("bridged ADK tools: the confirmation payload reaches the tool", () => {
  type Seen = { confirmed: boolean; payload?: unknown; hint?: string };

  /** Asks for an amount inside `execute` and records the confirmation it got. */
  function payTool(seen: Array<Seen | undefined>): FunctionTool {
    return tool("pay", (_args, context) => {
      const confirmation = context?.toolConfirmation;
      seen.push(
        confirmation
          ? {
              confirmed: confirmation.confirmed,
              payload: confirmation.payload,
              hint: confirmation.hint,
            }
          : undefined,
      );
      if (!confirmation) {
        context?.requestConfirmation({
          hint: "Pay how much?",
          payload: { amount: 10 },
        });
        return { status: "waiting" };
      }
      return { paid: confirmation.confirmed };
    });
  }

  /** Pauses on the ADK protocol, then answers with `response`. */
  async function answerWith(response: unknown) {
    const seen: Array<Seen | undefined> = [];
    let current = new ToolCallingDriver([{ name: "pay" }]);
    const agent = externalAgent(
      "worker",
      { providerId: CLAUDE_PROVIDER.id, run: (r) => current.run(r) },
      {
        tools: [payTool(seen)],
        permissions: { mode: "ask" },
        confirmation: { adk: true },
      },
    );
    const { runner, sessionId, events } = await run(agent);
    const request = events
      .flatMap((event) => event.content?.parts ?? [])
      .find(
        (part) =>
          part.functionCall?.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
      )?.functionCall;
    current = new ToolCallingDriver([{ name: "pay" }]);
    await turn(runner, sessionId, {
      role: "user",
      parts: [
        {
          functionResponse: {
            id: request?.id,
            name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
            response,
          },
        },
      ],
    });
    return { seen, retry: current };
  }

  test("an ADK answer's payload and hint reach the tool", async () => {
    const { seen, retry } = await answerWith({
      confirmed: true,
      payload: { amount: 5 },
      hint: "approved with a lower amount",
    });

    expect(seen).toEqual([
      undefined,
      {
        confirmed: true,
        payload: { amount: 5 },
        hint: "approved with a lower amount",
      },
    ]);
    expect(retry.results[0]?.response).toEqual({ paid: true });
  });

  test("a wrapped { response: json } answer approves", async () => {
    const { seen } = await answerWith({
      response: JSON.stringify({ confirmed: true, payload: { amount: 7 } }),
    });

    expect(seen[1]).toMatchObject({ confirmed: true, payload: { amount: 7 } });
  });

  test("a malformed wrapped answer is a rejection", async () => {
    const { seen, retry } = await answerWith({ response: "{not json" });

    expect(seen[1]?.confirmed).toBe(false);
    expect(retry.results[0]?.response).toEqual({ paid: false });
  });

  test("an approver's payload reaches the tool", async () => {
    const seen: Array<Seen | undefined> = [];
    const driver = new ToolCallingDriver([{ name: "pay" }]);
    await run(
      externalAgent("worker", driver, {
        tools: [payTool(seen)],
        permissions: { mode: "ask" },
        confirmation: {
          approver: () => ({ behavior: "allow", payload: { amount: 3 } }),
        },
      }),
    );

    // ADK's ToolConfirmation defaults a missing hint to "".
    expect(seen).toEqual([
      undefined,
      { confirmed: true, payload: { amount: 3 }, hint: "" },
    ]);
    expect(driver.results[0]?.response).toEqual({ paid: true });
  });

  test("a rejecting approver's payload reaches the tool too", async () => {
    const seen: Array<Seen | undefined> = [];
    const driver = new ToolCallingDriver([{ name: "pay" }]);
    await run(
      externalAgent("worker", driver, {
        tools: [payTool(seen)],
        permissions: { mode: "ask" },
        confirmation: {
          approver: () => ({
            behavior: "deny",
            message: "too much",
            payload: { reason: "over budget" },
          }),
        },
      }),
    );

    expect(seen[1]).toMatchObject({
      confirmed: false,
      payload: { reason: "over budget" },
    });
  });
});

describe("bridged ADK tools: result pairing", () => {
  /**
   * Calls the bridged `escalate` tool, then reports results of other tools
   * whose names only end like it before the bridged tool's own result.
   */
  class LookalikeResultDriver implements ExternalAgentDriver {
    readonly providerId = CLAUDE_PROVIDER.id;

    async *run(
      request: ExternalAgentRunRequest,
    ): AsyncGenerator<ExternalAgentEvent> {
      const bridge = request.adkTools;
      if (!bridge) throw new Error("no ADK tools");
      const exposed = "adk_tool__escalate";
      const runtimeName = `mcp__adk_bridge__${exposed}`;
      yield { type: "tool_call", name: runtimeName, input: {}, callId: "a" };
      const result = await bridge.execute(exposed, {}, request.context, {
        functionCallId: "claude-adk-1",
      });
      for (const name of [
        `mcp__other__${exposed}`,
        `adk_tool__${exposed}`,
        runtimeName,
      ]) {
        yield {
          type: "tool_result",
          name,
          callId: name === runtimeName ? "a" : `other-${name}`,
          result: JSON.stringify(result.response),
        };
      }
    }
  }

  test("only the bridged tool's own result carries its actions", async () => {
    const escalating = tool("escalate", (_args, context) => {
      if (context) context.actions.escalate = true;
      return { done: true };
    });
    const agent = externalAgent("worker", new LookalikeResultDriver(), {
      tools: [escalating],
    });

    const { events } = await run(agent);

    const resultNames = (event: Event) =>
      (event.content?.parts ?? []).flatMap((part) =>
        part.functionResponse?.name ? [part.functionResponse.name] : [],
      );
    const escalated = events.filter((event) => event.actions?.escalate);
    expect(escalated.map(resultNames)).toEqual([
      ["mcp__adk_bridge__adk_tool__escalate"],
    ]);
  });
});
