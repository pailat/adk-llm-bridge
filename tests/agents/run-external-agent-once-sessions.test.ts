/**
 * `runExternalAgentOnce` with the session-keeping drivers (Codex SDK, fx,
 * Claude SDK): a resumed session's id comes back on the outcome, and the
 * outcome reads only the agent's own run report.
 */
import { describe, expect, test } from "bun:test";
import { ClaudeAgent } from "../../src/agents/claude-agent.js";
import { FxCliDriver } from "../../src/agents/driver/fx-cli.js";
import {
  CODEX_PROVIDER,
  CodexCliDriver,
  type CodexCliSpawn,
  CodexSdkDriver,
  ExternalAgent,
  type ExternalAgentDriver,
  type ExternalAgentEvent,
  type ExternalAgentRunRequest,
  runExternalAgentOnce,
} from "../../src/agents/index.js";
import { FX_PROVIDER } from "../../src/agents/provider/fx.js";
import { CLAUDE_PROVIDER } from "../../src/agents/provider/schema.js";
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
function child(): ExternalAgent {
  return new ExternalAgent({
    name: "acme_writer",
    provider: CLAUDE_PROVIDER,
    permissions: { mode: "workspace-write", allowNetwork: false },
    driver: {
      providerId: CLAUDE_PROVIDER.id,
      async *run() {
        yield { type: "output", content: "written" };
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

function parent(completed: ExternalAgentEvent): ExternalAgent {
  return new ExternalAgent({
    name: "acme_lead",
    provider: CLAUDE_PROVIDER,
    permissions: { mode: "read-only", allowNetwork: false },
    subAgents: [child()],
    delegation: { finalAnswer: "coordinator" },
    driver: {
      providerId: CLAUDE_PROVIDER.id,
      async *run(request: ExternalAgentRunRequest) {
        await request.toolGateway?.runSubAgent({
          agentName: "acme_writer",
          task: "write it",
        });
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
