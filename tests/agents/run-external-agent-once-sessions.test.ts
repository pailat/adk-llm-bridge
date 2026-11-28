/**
 * `runExternalAgentOnce` with the session-keeping drivers (Codex SDK, fx,
 * Claude SDK): a resumed session's id comes back on the outcome, and the
 * outcome reads only the agent's own run report.
 */
import { describe, expect, test } from "bun:test";
import {
  type BaseAgent,
  type Event,
  InvocationContext,
  PluginManager,
  SequentialAgent,
} from "@google/adk";
import { ClaudeAgent } from "../../src/agents/claude-agent.js";
import { ClaudeAgentSdkDriver } from "../../src/agents/driver/claude-agent-sdk.js";
import { FxCliDriver } from "../../src/agents/driver/fx-cli.js";
import {
  CODEX_PROVIDER,
  CodexCliDriver,
  type CodexCliSpawn,
  CodexSdkDriver,
  EXTERNAL_AGENT_RUN_METADATA_KEY,
  ExternalAgent,
  type ExternalAgentDriver,
  type ExternalAgentEvent,
  type ExternalAgentRunRequest,
  runExternalAgentOnce,
} from "../../src/agents/index.js";
import { FX_PROVIDER } from "../../src/agents/provider/fx.js";
import { CLAUDE_PROVIDER } from "../../src/agents/provider/schema.js";
import { AgentInvocationGateway } from "../../src/runtime/agent-invocation-gateway.js";
import { baseConfig, FX_SUCCESS, recordingSpawn } from "./fx/helpers.js";
import { noHostMcpServers } from "./helpers.js";

const READ_ONLY_NETWORK = { mode: "read-only", allowNetwork: true } as const;

/** Codex stream of one turn on thread `id`. */
function codexTurn(id: string, text: string): Record<string, unknown>[] {
  return [
    { type: "thread.started", thread_id: id },
    { type: "item.completed", item: { type: "agent_message", text } },
    {
      type: "turn.completed",
      usage: { input_tokens: 20, cached_input_tokens: 0, output_tokens: 5 },
    },
  ];
}

/** A Codex SDK agent whose fake client records the thread it resumes. */
function codexSdkAgent(
  stream: (id: string) => Record<string, unknown>[],
  resumed: string[],
  threadStateKey?: (agentName: string) => string,
): ExternalAgent {
  const thread = (id: string) => ({
    id,
    runStreamed: async () => ({
      events: (async function* () {
        yield* stream(id);
      })(),
    }),
  });
  return new ExternalAgent({
    name: "acme_lane",
    provider: CODEX_PROVIDER,
    permissions: READ_ONLY_NETWORK,
    driver: new CodexSdkDriver({
      ...(threadStateKey ? { threadStateKey } : {}),
      sdk: {
        startThread: () => thread("thread-acme-1"),
        resumeThread: (id: string) => {
          resumed.push(id);
          return thread(id);
        },
      },
    }),
  });
}

describe("a resumed session comes back on the outcome", () => {
  test("Codex SDK: the resumed thread id is returned and chains", async () => {
    const resumed: string[] = [];
    const turn = (id: string) => codexTurn(id, `on ${id}`);
    const first = await runExternalAgentOnce(codexSdkAgent(turn, resumed), {
      prompt: "start",
    });
    expect(first.sessionId).toBe("thread-acme-1");
    const second = await runExternalAgentOnce(codexSdkAgent(turn, resumed), {
      prompt: "continue",
      sessionId: first.sessionId,
    });
    expect(second.errorKind).toBeUndefined();
    expect(second.sessionId).toBe("thread-acme-1");
    const third = await runExternalAgentOnce(codexSdkAgent(turn, resumed), {
      prompt: "and again",
      sessionId: second.sessionId,
    });
    expect(resumed).toEqual(["thread-acme-1", "thread-acme-1"]);
    expect(third.sessionId).toBe("thread-acme-1");
  });

  test("Codex SDK: a custom threadStateKey still resumes the returned thread", async () => {
    const resumed: string[] = [];
    const turn = (id: string) => codexTurn(id, `on ${id}`);
    const key = (name: string) => `acme_thread:${name}`;
    const outcome = await runExternalAgentOnce(
      codexSdkAgent(turn, resumed, key),
      { prompt: "continue", sessionId: "thread-acme-7" },
    );
    expect(outcome.errorKind).toBeUndefined();
    expect(resumed).toEqual(["thread-acme-7"]);
    expect(outcome.sessionId).toBe("thread-acme-7");
  });

  test("Codex CLI keeps no thread, so it returns no session id", async () => {
    const calls: string[][] = [];
    const spawn: CodexCliSpawn = (_command, args) => {
      calls.push([...args]);
      return {
        stdout: (async function* () {
          for (const line of codexTurn("thread-acme-2", "fresh")) {
            yield `${JSON.stringify(line)}\n`;
          }
        })(),
        exited: Promise.resolve(0),
      };
    };
    const agent = new ExternalAgent({
      name: "acme_lane",
      provider: CODEX_PROVIDER,
      permissions: { mode: "read-only", allowNetwork: false },
      driver: new CodexCliDriver({ listMcpServers: noHostMcpServers, spawn }),
    });
    const outcome = await runExternalAgentOnce(agent, {
      prompt: "continue",
      sessionId: "thread-acme-2",
    });
    expect(calls[0]).not.toContain("resume");
    expect(outcome.errorKind).toBeUndefined();
    expect(outcome.text).toBe("fresh");
    expect(outcome.sessionId).toBeUndefined();
  });

  test("fx: the resumed session id is returned", async () => {
    const fake = recordingSpawn([
      `${JSON.stringify({ ...FX_SUCCESS, session_id: "fxAcme01" })}\n`,
    ]);
    const agent = new ExternalAgent({
      name: "acme_fx",
      provider: FX_PROVIDER,
      permissions: { mode: "ask", allowNetwork: true },
      driver: new FxCliDriver(baseConfig({ spawn: fake.spawn })),
    });
    const outcome = await runExternalAgentOnce(agent, {
      prompt: "continue",
      sessionId: "fxAcme01",
    });
    const args = fake.calls[0]?.args ?? [];
    expect(args[args.indexOf("--resume-id") + 1]).toBe("fxAcme01");
    expect(outcome.errorKind).toBeUndefined();
    expect(outcome.sessionId).toBe("fxAcme01");
  });

  test("Claude SDK: a resumed run that throws still returns its session", async () => {
    const resumes: (string | undefined)[] = [];
    const agent = new ClaudeAgent({
      name: "acme_coder",
      driverOptions: {
        sdk: {
          query: ({ options }) => {
            const resume = (options as { resume?: string }).resume;
            resumes.push(resume);
            return (async function* () {
              yield { type: "system", subtype: "init", session_id: resume };
              throw new Error("Acme SDK transport closed");
            })() as never;
          },
        },
      },
    });
    const outcome = await runExternalAgentOnce(agent, {
      prompt: "continue",
      sessionId: "sdk-acme-31",
    });
    expect(resumes).toEqual(["sdk-acme-31"]);
    expect(outcome.errorKind).toBe("agent-error");
    expect(outcome.sessionId).toBe("sdk-acme-31");
  });
});

describe("Codex-shaped completed events (exit code and usage only)", () => {
  test("a recoverable error followed by an answer is not a failure", async () => {
    const outcome = await runExternalAgentOnce(
      codexSdkAgent(
        (id) => [
          { type: "thread.started", thread_id: id },
          {
            type: "item.completed",
            item: { type: "error", message: "Acme MCP server is slow" },
          },
          ...codexTurn(id, "done anyway").slice(1),
        ],
        [],
      ),
      { prompt: "go" },
    );
    expect(outcome.cause).toBeUndefined();
    expect(outcome.errorKind).toBeUndefined();
    expect(outcome.text).toBe("done anyway");
  });

  test("usage.scope survives without a cost, turns or session id", async () => {
    const driver: ExternalAgentDriver = {
      providerId: CODEX_PROVIDER.id,
      async *run() {
        yield { type: "output", content: "ok" };
        yield {
          type: "completed",
          exitCode: 0,
          usage: { inputTokens: 3, outputTokens: 1, scope: "session" },
        };
      },
    };
    const outcome = await runExternalAgentOnce(
      new ExternalAgent({
        name: "acme_lane",
        provider: CODEX_PROVIDER,
        driver,
      }),
      { prompt: "go" },
    );
    expect(outcome.usage.scope).toBe("session");
  });
});

/** A child that reports its own cost, turns and session. */
function child(
  answer = "written",
  subAgents: ExternalAgent[] = [],
): ExternalAgent {
  return new ExternalAgent({
    name: subAgents.length > 0 ? "acme_editor" : "acme_writer",
    provider: CLAUDE_PROVIDER,
    permissions: { mode: "workspace-write", allowNetwork: false },
    subAgents,
    driver: {
      providerId: CLAUDE_PROVIDER.id,
      async *run(request: ExternalAgentRunRequest) {
        if (subAgents.length > 0) {
          await request.toolGateway?.runSubAgent({
            agentName: "acme_writer",
            task: "write it",
          });
          // Dropped: the writer's turn is the editor's final answer.
          yield { type: "output", content: "editor done" };
        } else {
          yield { type: "output", content: answer };
        }
        yield {
          type: "completed",
          exitCode: 0,
          numTurns: 4,
          sessionId: "sdk-acme-child",
          usage: { inputTokens: 10, outputTokens: 2, totalCostUsd: 0.1 },
        };
      },
    },
  });
}

function parent(
  completed: ExternalAgentEvent,
  options: {
    subAgent?: ExternalAgent;
    delegation?: "subagent" | "coordinator";
    outputSchema?: Record<string, unknown>;
    stream?: boolean;
  } = {},
): ExternalAgent {
  const subAgent = options.subAgent ?? child();
  return new ExternalAgent({
    name: "acme_lead",
    provider: CLAUDE_PROVIDER,
    permissions: { mode: "read-only", allowNetwork: false },
    subAgents: [subAgent],
    ...(options.delegation === "subagent"
      ? {}
      : { delegation: { finalAnswer: "coordinator" } }),
    ...(options.outputSchema
      ? { outputSchema: options.outputSchema as never }
      : {}),
    driver: {
      providerId: CLAUDE_PROVIDER.id,
      async *run(request: ExternalAgentRunRequest) {
        await request.toolGateway?.runSubAgent({
          agentName: subAgent.name,
          task: "write it",
        });
        if (options.stream) {
          yield { type: "output", content: "lead ", partial: true };
          yield { type: "output", content: "done", partial: true };
        }
        yield { type: "output", content: "lead done" };
        yield completed;
      },
    },
  });
}

describe("sub-agent run reports are not the agent's own", () => {
  test("a parent report keeps the sub-agent's cost in usage.costUsd", async () => {
    const outcome = await runExternalAgentOnce(
      parent({
        type: "completed",
        exitCode: 0,
        numTurns: 2,
        usage: { inputTokens: 5, outputTokens: 1, totalCostUsd: 0.2 },
      }),
      { prompt: "lead" },
    );
    expect(outcome.text).toBe("lead done");
    expect(outcome.usage.costUsd).toBeCloseTo(0.3, 10);
    expect(outcome.usage.turns).toBe(2);
    expect(outcome.sessionId).toBeUndefined();
  });

  test("without a parent report, the sub-agent's session and cost are not the parent's", async () => {
    const outcome = await runExternalAgentOnce(
      parent({ type: "completed", exitCode: 0 }),
      { prompt: "lead" },
    );
    expect(outcome.errorKind).toBeUndefined();
    expect(outcome.sessionId).toBeUndefined();
    expect(outcome.usage.turns).toBeUndefined();
    expect(outcome.usage.costUsd).toBeCloseTo(0.1, 10);
  });
});

describe("default delegation: the sub-agent's turn is the final answer", () => {
  const leadCompleted: ExternalAgentEvent = {
    type: "completed",
    exitCode: 0,
    numTurns: 2,
    usage: { inputTokens: 5, outputTokens: 1, totalCostUsd: 0.2 },
  };

  test("text is the sub-agent's answer and usage keeps the lead's report", async () => {
    const outcome = await runExternalAgentOnce(
      parent(leadCompleted, { delegation: "subagent" }),
      { prompt: "lead" },
    );
    expect(outcome.errorKind).toBeUndefined();
    expect(outcome.text).toBe("written");
    expect(outcome.usage.turns).toBe(2);
    expect(outcome.usage.costUsd).toBeCloseTo(0.3, 10);
  });

  test("under an outputSchema the sub-agent's JSON answer is structured", async () => {
    const outcome = await runExternalAgentOnce(
      parent(leadCompleted, {
        delegation: "subagent",
        subAgent: child('{"status":"ok"}'),
        outputSchema: { type: "object" },
      }),
      { prompt: "lead" },
    );
    expect(outcome.errorKind).toBeUndefined();
    expect(outcome.structured).toEqual({ status: "ok" });
  });

  test("a nested transfer follows to the innermost answer", async () => {
    const outcome = await runExternalAgentOnce(
      parent(leadCompleted, {
        delegation: "subagent",
        subAgent: child("written", [child()]),
      }),
      { prompt: "lead" },
    );
    expect(outcome.errorKind).toBeUndefined();
    expect(outcome.text).toBe("written");
  });

  test("the lead's run report does not replace the answer as the last event", async () => {
    // ADK AgentTool reads the last event's content as the agent's result.
    const agent = parent(leadCompleted, { delegation: "subagent" });
    const result = await new AgentInvocationGateway({
      resolveAgent: () => agent,
    }).run({
      agentName: agent.name,
      input: { role: "user", parts: [{ text: "lead" }] },
      parentContext: new InvocationContext({
        invocationId: "inv-acme-lead",
        agent,
        session: {
          id: "s-acme-lead",
          appName: "acme",
          userId: "user",
          state: {},
          events: [],
          lastUpdateTime: 1,
        },
        pluginManager: new PluginManager(),
      }),
    });
    const last = result.events.at(-1);
    expect(last?.author).toBe("acme_writer");
    expect(last?.content?.parts?.[0]?.text).toBe("written");
    const report = result.events.find(
      (event) =>
        event.author === "acme_lead" &&
        event.customMetadata?.[EXTERNAL_AGENT_RUN_METADATA_KEY] !== undefined,
    );
    expect(report).toBeDefined();
    expect(result.usage.costUsd).toBeCloseTo(0.3, 10);
  });

  test("a streaming lead keeps the answer as the last event", async () => {
    const agent = parent(leadCompleted, {
      delegation: "subagent",
      stream: true,
    });
    const events: Event[] = [];
    for await (const event of agent.runAsync(
      new InvocationContext({
        invocationId: "inv-acme-stream",
        agent,
        session: {
          id: "s-acme-stream",
          appName: "acme",
          userId: "user",
          state: {},
          events: [],
          lastUpdateTime: 1,
        },
        pluginManager: new PluginManager(),
      }),
    )) {
      events.push(event);
    }
    const last = events.filter((event) => !event.partial).at(-1);
    expect(last?.author).toBe("acme_writer");
    expect(last?.content?.parts?.[0]?.text).toBe("written");
  });

  test("a nested sub-agent's own report carrier still counts its cost", async () => {
    // The editor's answer is the writer's turn, so the editor's own cost
    // rides on a content-less event, which must still reach the lead.
    const outcome = await runExternalAgentOnce(
      parent(leadCompleted, {
        delegation: "subagent",
        subAgent: child("written", [child()]),
      }),
      { prompt: "lead" },
    );
    expect(outcome.errorKind).toBeUndefined();
    expect(outcome.usage.costUsd).toBeCloseTo(0.4, 10);
  });
});

describe("Claude SDK: a resumed run that is aborted", () => {
  test("returns no sessionId: the id passed in stays the caller's", async () => {
    const controller = new AbortController();
    const agent = new ClaudeAgent({
      name: "acme_coder",
      driverOptions: {
        sdk: {
          query: ({ options }) => {
            const { resume, abortController } = options as {
              resume?: string;
              abortController?: AbortController;
            };
            return (async function* () {
              yield { type: "system", subtype: "init", session_id: resume };
              await new Promise<void>((resolve) => {
                abortController?.signal.addEventListener(
                  "abort",
                  () => resolve(),
                  { once: true },
                );
                controller.abort();
              });
            })() as never;
          },
        },
      },
    });
    const outcome = await runExternalAgentOnce(agent, {
      prompt: "continue",
      sessionId: "sdk-acme-41",
      signal: controller.signal,
    });
    expect(outcome.errorKind).toBe("aborted");
    expect(outcome.sessionId).toBeUndefined();
  });
});

describe("cause names the error that ended the run", () => {
  test("an error event followed by a driver throw reports the throw", async () => {
    const driver: ExternalAgentDriver = {
      providerId: CODEX_PROVIDER.id,
      async *run() {
        yield {
          type: "error",
          code: "PERMISSION_DENIED",
          message: "Bash is not allowed",
          recoverable: true,
        };
        throw new Error("Acme driver exploded");
      },
    };
    const outcome = await runExternalAgentOnce(
      new ExternalAgent({
        name: "acme_lane",
        provider: CODEX_PROVIDER,
        driver,
      }),
      { prompt: "go" },
    );
    expect(outcome.errorKind).toBeDefined();
    expect(outcome.cause?.message).toContain("Acme driver exploded");
    expect(outcome.cause?.code).not.toBe("PERMISSION_DENIED");
  });

  test("an error event followed by an abort does not report the earlier error", async () => {
    const controller = new AbortController();
    const driver: ExternalAgentDriver = {
      providerId: CODEX_PROVIDER.id,
      async *run() {
        yield {
          type: "error",
          code: "PERMISSION_DENIED",
          message: "Bash is not allowed",
          recoverable: true,
        };
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
    };
    const outcome = await runExternalAgentOnce(
      new ExternalAgent({
        name: "acme_lane",
        provider: CODEX_PROVIDER,
        driver,
      }),
      { prompt: "go", signal: controller.signal },
    );
    expect(outcome.errorKind).toBe("aborted");
    expect(outcome.cause?.code).not.toBe("PERMISSION_DENIED");
  });
});

/** A leaf sub-agent named `name` that answers `answer`. */
function leaf(name: string, answer: string): ExternalAgent {
  return new ExternalAgent({
    name,
    provider: CLAUDE_PROVIDER,
    permissions: { mode: "read-only", allowNetwork: false },
    driver: {
      providerId: CLAUDE_PROVIDER.id,
      async *run() {
        yield { type: "output", content: answer };
        yield { type: "completed", exitCode: 0 };
      },
    },
  });
}

/** A default-delegation lead that delegates once, then yields `after`. */
function lead(subAgent: BaseAgent, after: ExternalAgentEvent[]): ExternalAgent {
  return new ExternalAgent({
    name: "acme_lead",
    provider: CLAUDE_PROVIDER,
    permissions: { mode: "read-only", allowNetwork: false },
    subAgents: [subAgent],
    driver: {
      providerId: CLAUDE_PROVIDER.id,
      async *run(request: ExternalAgentRunRequest) {
        await request.toolGateway?.runSubAgent({
          agentName: subAgent.name,
          task: "write it",
        });
        yield* after;
        yield {
          type: "completed",
          exitCode: 0,
          usage: { inputTokens: 5, outputTokens: 1, totalCostUsd: 0.2 },
        };
      },
    },
  });
}

const READ_AFTER_DELEGATION: ExternalAgentEvent[] = [
  {
    type: "tool_call",
    name: "Read",
    input: { file_path: "report.md" },
    callId: "call-acme-read",
    metadata: { builtin: true },
  },
  {
    type: "tool_result",
    name: "Read",
    result: "Acme report",
    callId: "call-acme-read",
    metadata: { builtin: true },
  },
  // Dropped: the writer's turn is still the final answer.
  { type: "output", content: "lead done" },
];

describe("default delegation: the answer after the transfer", () => {
  test("a built-in tool after the delegation keeps the sub-agent's answer", async () => {
    const outcome = await runExternalAgentOnce(
      lead(leaf("acme_writer", '{"report":"Acme"}'), READ_AFTER_DELEGATION),
      { prompt: "lead" },
    );
    expect(outcome.errorKind).toBeUndefined();
    expect(outcome.text).toBe('{"report":"Acme"}');
  });

  test("a built-in tool after the delegation keeps the answer as the last event", async () => {
    const agent = lead(leaf("acme_writer", "Report"), READ_AFTER_DELEGATION);
    const result = await new AgentInvocationGateway({
      resolveAgent: () => agent,
    }).run({
      agentName: agent.name,
      input: { role: "user", parts: [{ text: "lead" }] },
      parentContext: new InvocationContext({
        invocationId: "inv-acme-read",
        agent,
        session: {
          id: "s-acme-read",
          appName: "acme",
          userId: "user",
          state: {},
          events: [],
          lastUpdateTime: 1,
        },
        pluginManager: new PluginManager(),
      }),
    });
    const last = result.events.at(-1);
    expect(last?.author).toBe("acme_writer");
    expect(last?.content?.parts?.[0]?.text).toBe("Report");
  });

  test("a lead whose last event is its own text after a built-in tool keeps it", async () => {
    const outcome = await runExternalAgentOnce(
      lead(leaf("acme_writer", "Report"), [
        { type: "tool_call", name: "acme_tool", callId: "call-acme-tool" },
        {
          type: "tool_result",
          name: "acme_tool",
          callId: "call-acme-tool",
          result: "x",
        },
        ...READ_AFTER_DELEGATION.slice(0, 2),
      ]),
      { prompt: "lead" },
    );
    // The lead went on working after the delegation and ended on a tool.
    expect(outcome.text).toBe("");
  });

  test("a transfer to a composite agent returns its leaf's answer", async () => {
    const pipeline = new SequentialAgent({
      name: "acme_pipeline",
      subAgents: [
        leaf("acme_draft", "draft"),
        leaf("acme_polish", '{"status":"polished"}'),
      ],
    });
    const outcome = await runExternalAgentOnce(
      lead(pipeline, [{ type: "output", content: "lead done" }]),
      { prompt: "lead" },
    );
    expect(outcome.errorKind).toBeUndefined();
    expect(outcome.text).toBe('{"status":"polished"}');
  });
});

describe("usage under scope session", () => {
  test("tokens are the agent's own session total, as costUsd is", async () => {
    const outcome = await runExternalAgentOnce(
      parent(
        {
          type: "completed",
          exitCode: 0,
          usage: {
            inputTokens: 50,
            outputTokens: 7,
            totalCostUsd: 0.9,
            scope: "session",
          },
        },
        { delegation: "subagent" },
      ),
      { prompt: "lead" },
    );
    expect(outcome.usage.scope).toBe("session");
    expect(outcome.usage.costUsd).toBeCloseTo(0.9, 10);
    expect(outcome.usage.tokens.input).toBe(50);
    expect(outcome.usage.tokens.output).toBe(7);
  });
});

describe("the session state key follows the driver", () => {
  test("a Claude SDK driver under a custom provider id resumes the sessionId", async () => {
    const resumes: (string | undefined)[] = [];
    const agent = new ExternalAgent({
      name: "acme_coder",
      provider: { ...CLAUDE_PROVIDER, id: "claude-work" },
      permissions: { mode: "read-only", allowNetwork: false },
      driver: new ClaudeAgentSdkDriver({
        sdk: {
          query: ({ options }) => {
            const resume = (options as { resume?: string }).resume;
            resumes.push(resume);
            return (async function* () {
              yield { type: "system", subtype: "init", session_id: resume };
            })() as never;
          },
        },
      }),
    });
    await runExternalAgentOnce(agent, {
      prompt: "continue",
      sessionId: "sdk-acme-51",
    });
    expect(resumes).toEqual(["sdk-acme-51"]);
  });
});
