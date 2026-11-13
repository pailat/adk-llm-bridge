import { describe, expect, test } from "bun:test";
import type { InvocationContext } from "@google/adk";
import {
  CLAUDE_PROVIDER,
  ClaudeAgentSdkDriver,
  type ClaudeAgentSdkDriverConfig,
  CODEX_PROVIDER,
  CodexSdkDriver,
  claudeSdkSessionStateKey,
  ExternalAgent,
  type ExternalAgentDriver,
  type ExternalAgentEvent,
  type ExternalAgentRunRequest,
} from "../../src/agents/index.js";

async function* sdkEvents(events: readonly Record<string, unknown>[]) {
  for (const event of events) {
    yield event;
  }
}

async function drain(events: AsyncIterable<ExternalAgentEvent>) {
  const collected: ExternalAgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("Codex SDK driver resumes request.runtimeSession.id", () => {
  function codexDriver(calls: { started: number; resumed: string[] }) {
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

  test("an explicit id wins over the id saved in session state", async () => {
    const calls = { started: 0, resumed: [] as string[] };
    await drain(
      codexDriver(calls).run(
        request({ "codex_thread:codex": "saved-1" }, { id: "explicit-7" }),
      ),
    );
    expect(calls).toEqual({ started: 0, resumed: ["explicit-7"] });
  });

  test("an explicit id resumes even without saved state", async () => {
    const calls = { started: 0, resumed: [] as string[] };
    await drain(codexDriver(calls).run(request({}, { id: "explicit-7" })));
    expect(calls).toEqual({ started: 0, resumed: ["explicit-7"] });
  });

  test("without an explicit id the saved id is used", async () => {
    const calls = { started: 0, resumed: [] as string[] };
    await drain(
      codexDriver(calls).run(request({ "codex_thread:codex": "saved-1" })),
    );
    expect(calls).toEqual({ started: 0, resumed: ["saved-1"] });
  });
});

describe("Claude SDK driver resume order", () => {
  function claudeDriver(
    resumes: Array<string | undefined>,
    config: ClaudeAgentSdkDriverConfig = {},
  ) {
    return new ClaudeAgentSdkDriver({
      ...config,
      sdk: {
        query: ({ options }) => {
          resumes.push((options as { resume?: string }).resume);
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
  }

  // One agent object: the driver keeps its memory per agent.
  const claudeAgent = { name: "claude" };

  function request(
    state: Record<string, unknown>,
    runtimeSession?: { id: string },
  ): ExternalAgentRunRequest {
    return {
      provider: CLAUDE_PROVIDER,
      agent: claudeAgent as never,
      context: {
        invocationId: "inv-1",
        agent: { name: "claude" },
        session: { id: "s1", state, events: [] },
      } as unknown as InvocationContext,
      permissions: { mode: "ask" },
      ...(runtimeSession ? { runtimeSession } : {}),
    };
  }

  const key = claudeSdkSessionStateKey("claude");

  test("config resumeSessionId wins over runtimeSession.id", async () => {
    const resumes: Array<string | undefined> = [];
    await drain(
      claudeDriver(resumes, { resumeSessionId: "from-config" }).run(
        request({ [key]: "from-state" }, { id: "from-request" }),
      ),
    );
    expect(resumes).toEqual(["from-config"]);
  });

  test("runtimeSession.id wins over session state", async () => {
    const resumes: Array<string | undefined> = [];
    await drain(
      claudeDriver(resumes).run(
        request({ [key]: "from-state" }, { id: "from-request" }),
      ),
    );
    expect(resumes).toEqual(["from-request"]);
  });

  test("runtimeSession.id wins over the driver's memory", async () => {
    const resumes: Array<string | undefined> = [];
    const driver = claudeDriver(resumes);
    // The first run stores "sdk-new" in the driver's memory for session s1.
    await drain(driver.run(request({})));
    await drain(driver.run(request({}, { id: "from-request" })));
    await drain(driver.run(request({})));
    expect(resumes).toEqual([undefined, "from-request", "sdk-new"]);
  });

  test("session state is used without runtimeSession", async () => {
    const resumes: Array<string | undefined> = [];
    await drain(claudeDriver(resumes).run(request({ [key]: "from-state" })));
    expect(resumes).toEqual(["from-state"]);
  });
});

describe("ExternalAgent and runtimeSession", () => {
  test("the agent never fills runtimeSession, least of all with the invocation id", async () => {
    const requests: ExternalAgentRunRequest[] = [];
    const driver: ExternalAgentDriver = {
      providerId: "codex",
      async *run(request) {
        requests.push(request);
        yield { type: "completed", exitCode: 0 };
      },
    };
    const agent = new ExternalAgent({
      name: "codex_agent",
      provider: CODEX_PROVIDER,
      driver,
    });
    for await (const _event of agent.runAsync({
      invocationId: "inv-42",
      branch: "root",
    } as InvocationContext)) {
      // drain
    }
    expect(requests).toHaveLength(1);
    expect(requests[0]?.runtimeSession).toBeUndefined();
    expect(JSON.stringify(requests[0]?.runtimeSession ?? null)).not.toContain(
      "inv-42",
    );
  });
});
