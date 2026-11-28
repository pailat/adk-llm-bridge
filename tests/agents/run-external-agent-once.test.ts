import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvocationContext, PluginManager } from "@google/adk";
import { ClaudeAgent } from "../../src/agents/claude-agent.js";
import { claudeSdkSessionStateKey } from "../../src/agents/driver/claude-agent-sdk.js";
import {
  type AgentRunOutcome,
  EXTERNAL_AGENT_RUN_METADATA_KEY,
  runExternalAgentOnce,
} from "../../src/agents/index.js";
import { SqliteSessionStore } from "../../src/agents/session-store/sqlite/index.js";
import type { SessionStore } from "../../src/agents/session-store/types.js";
import { AgentInvocationGateway } from "../../src/runtime/agent-invocation-gateway.js";
import { nodeSqliteAvailable } from "../utils/fixtures/raw-sqlite.js";

type QueryOptions = {
  resume?: string;
  sessionStore?: SessionStore;
  abortController?: AbortController;
  cwd?: string;
};

type Script = (options: QueryOptions) => AsyncGenerator<unknown>;

const dirs: string[] = [];
const stores: SqliteSessionStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function scriptedAgent(
  script: Script,
  captured: QueryOptions[] = [],
  extra: { sessionStore?: SessionStore; outputSchema?: unknown } = {},
): ClaudeAgent {
  return new ClaudeAgent({
    name: "acme_coder",
    ...(extra.outputSchema
      ? { outputSchema: extra.outputSchema as never }
      : {}),
    driverOptions: {
      ...(extra.sessionStore ? { sessionStore: extra.sessionStore } : {}),
      sdk: {
        query: ({ options }) => {
          captured.push(options as QueryOptions);
          return script(options as QueryOptions) as never;
        },
      },
    },
  });
}

function success(sessionId: string, result: string, extra = {}) {
  return {
    type: "result",
    subtype: "success",
    result,
    session_id: sessionId,
    total_cost_usd: 0.25,
    num_turns: 3,
    usage: {
      input_tokens: 100,
      output_tokens: 40,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    },
    ...extra,
  };
}

function oneTurn(sessionId: string, result: string): Script {
  return async function* () {
    yield { type: "system", subtype: "init", session_id: sessionId };
    yield success(sessionId, result);
  };
}

describe("runExternalAgentOnce", () => {
  test("returns text, usage, sessionId without a Runner", async () => {
    const agent = scriptedAgent(oneTurn("sdk-acme-1", "Acme report ready"));
    const outcome: AgentRunOutcome = await runExternalAgentOnce(agent, {
      prompt: "Summarize the Acme ledger",
    });
    expect(outcome.errorKind).toBeUndefined();
    expect(outcome.cause).toBeUndefined();
    expect(outcome.text).toBe("Acme report ready");
    expect(outcome.structured).toBeUndefined();
    expect(outcome.sessionId).toBe("sdk-acme-1");
    expect(outcome.usage.costUsd).toBe(0.25);
    expect(outcome.usage.turns).toBe(3);
    expect(outcome.usage.tokens).toEqual({
      input: 115,
      output: 40,
      cacheRead: 10,
      cacheCreation: 5,
      total: 155,
    });
  });

  test("sessionId is the id stored under claude_sdk_session:<agent> and resumes it", async () => {
    const captured: QueryOptions[] = [];
    const first = await runExternalAgentOnce(
      scriptedAgent(oneTurn("sdk-acme-2", "one"), captured),
      { prompt: "first" },
    );
    expect(claudeSdkSessionStateKey("acme_coder")).toBe(
      "claude_sdk_session:acme_coder",
    );
    expect(first.sessionId).toBe("sdk-acme-2");

    // A new agent instance has no memory of the session: only the id resumes.
    const second = await runExternalAgentOnce(
      scriptedAgent(oneTurn("sdk-acme-2", "two"), captured),
      { prompt: "second", sessionId: first.sessionId },
    );
    expect(captured[0]?.resume).toBeUndefined();
    expect(captured[1]?.resume).toBe("sdk-acme-2");
    expect(second.text).toBe("two");
    expect(second.sessionId).toBe("sdk-acme-2");
  });

  test("the gateway's usage.costUsd includes a run-scoped ExternalAgent cost", async () => {
    const agent = scriptedAgent(oneTurn("sdk-acme-9", "done"));
    const parentContext = new InvocationContext({
      invocationId: "inv-acme",
      agent,
      session: {
        id: "s-acme",
        appName: "acme",
        userId: "user",
        state: {},
        events: [],
        lastUpdateTime: 1,
      },
      pluginManager: new PluginManager(),
    });
    const result = await new AgentInvocationGateway({
      resolveAgent: () => agent,
    }).run({
      agentName: agent.name,
      input: { role: "user", parts: [{ text: "go" }] },
      parentContext,
    });
    expect(result.usage.costUsd).toBe(0.25);
    const final = result.events.at(-1);
    expect(final?.customMetadata?.[EXTERNAL_AGENT_RUN_METADATA_KEY]).toEqual({
      costUsd: 0.25,
      turns: 3,
      scope: "run",
    });
  });

  test("a session-total cost is reported with scope session, not summed by the gateway", async () => {
    const agent = scriptedAgent(oneTurn("sdk-acme-10", "again"));
    const outcome = await runExternalAgentOnce(agent, {
      prompt: "resume",
      sessionId: "sdk-acme-10",
    });
    expect(outcome.usage.scope).toBe("session");
    expect(outcome.usage.costUsd).toBe(0.25);
  });

  test("parses the final answer as structured output with an outputSchema", async () => {
    const agent = scriptedAgent(
      oneTurn("sdk-acme-3", '{"verdict":"pass","count":2}'),
      [],
      { outputSchema: { type: "object" } },
    );
    const outcome = await runExternalAgentOnce(agent, { prompt: "grade" });
    expect(outcome.errorKind).toBeUndefined();
    expect(outcome.structured).toEqual({ verdict: "pass", count: 2 });
  });

  test("an answer that is not JSON under an outputSchema is invalid-output", async () => {
    const agent = scriptedAgent(oneTurn("sdk-acme-4", "not json"), [], {
      outputSchema: { type: "object" },
    });
    const outcome = await runExternalAgentOnce(agent, { prompt: "grade" });
    expect(outcome.errorKind).toBe("invalid-output");
    expect(outcome.text).toBe("not json");
    expect(outcome.structured).toBeUndefined();
    expect(outcome.cause?.message).toContain("JSON");
  });

  test("an error result reports agent-error with its code as cause", async () => {
    const agent = scriptedAgent(async function* () {
      yield { type: "system", subtype: "init", session_id: "sdk-acme-5" };
      yield {
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        session_id: "sdk-acme-5",
        num_turns: 9,
        total_cost_usd: 1.5,
      };
    });
    const outcome = await runExternalAgentOnce(agent, { prompt: "loop" });
    expect(outcome.errorKind).toBe("agent-error");
    expect(outcome.cause?.code).toBeString();
    expect(outcome.cause?.message).toBeString();
    expect(outcome.usage.costUsd).toBe(1.5);
    expect(outcome.usage.turns).toBe(9);
    expect(outcome.sessionId).toBe("sdk-acme-5");
  });

  test("abort through signal aborts the SDK run and reports aborted", async () => {
    const captured: QueryOptions[] = [];
    const controller = new AbortController();
    let sdkAborted = false;
    const agent = scriptedAgent(async function* (options) {
      yield { type: "system", subtype: "init", session_id: "sdk-acme-6" };
      const signal = options.abortController?.signal;
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener("abort", () => resolve(), { once: true });
        controller.abort();
      });
      sdkAborted = signal?.aborted ?? false;
    }, captured);
    const outcome = await runExternalAgentOnce(agent, {
      prompt: "long task",
      signal: controller.signal,
    });
    expect(sdkAborted).toBe(true);
    expect(captured[0]?.abortController?.signal.aborted).toBe(true);
    expect(outcome.errorKind).toBe("aborted");
  });

  test("an already aborted signal never starts the SDK", async () => {
    const captured: QueryOptions[] = [];
    const agent = scriptedAgent(oneTurn("sdk-acme-7", "x"), captured);
    const outcome = await runExternalAgentOnce(agent, {
      prompt: "nothing",
      signal: AbortSignal.abort(),
    });
    expect(captured).toHaveLength(0);
    expect(outcome.errorKind).toBe("aborted");
  });

  test.skipIf(!nodeSqliteAvailable)(
    "resumes through a SqliteSessionStore across agent instances",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "run-once-"));
      dirs.push(dir);
      const store = new SqliteSessionStore({ path: join(dir, "sessions.db") });
      stores.push(store);
      const captured: QueryOptions[] = [];
      const loaded: unknown[] = [];
      const script: Script = async function* (options) {
        const key = { projectKey: "acme", sessionId: "sdk-acme-8" };
        if (options.resume) {
          loaded.push(await options.sessionStore?.load(key));
        }
        yield { type: "system", subtype: "init", session_id: "sdk-acme-8" };
        await options.sessionStore?.append(key, [
          { type: "user", uuid: `u-${loaded.length}` },
        ]);
        yield success("sdk-acme-8", options.resume ? "resumed" : "fresh");
      };
      const first = await runExternalAgentOnce(
        scriptedAgent(script, captured, { sessionStore: store }),
        { prompt: "start" },
      );
      const second = await runExternalAgentOnce(
        scriptedAgent(script, captured, { sessionStore: store }),
        { prompt: "continue", sessionId: first.sessionId },
      );
      expect(captured[0]?.sessionStore).toBe(store);
      expect(captured[1]?.sessionStore).toBe(store);
      expect(captured[1]?.resume).toBe("sdk-acme-8");
      expect(loaded).toEqual([[{ type: "user", uuid: "u-0" }]]);
      expect(second.text).toBe("resumed");
      expect(second.sessionId).toBe("sdk-acme-8");
    },
  );
});
