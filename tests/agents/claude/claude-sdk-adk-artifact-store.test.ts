import { describe, expect, test } from "bun:test";
import { InMemoryArtifactService, ScopedArtifactService } from "@google/adk";
import { ClaudeAgentSdkDriver } from "../../../src/agents/driver/claude-agent-sdk.js";
import { ClaudeCliDriver } from "../../../src/agents/driver/claude-cli.js";
import {
  EXTERNAL_AGENT_OPTION_UNSUPPORTED,
  ExternalAgentPolicyError,
} from "../../../src/agents/driver/policy-errors.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/schema.js";
import { adkArtifactSessionStore } from "../../../src/agents/session-store/adk-artifacts.js";
import type { SessionStore } from "../../../src/agents/session-store/types.js";

const KEY = { projectKey: "proj", sessionId: "sdk-1" };

function contextFor(
  sessionId: string,
  artifactService?: ScopedArtifactService,
): never {
  return {
    agent: { name: "claude" },
    branch: "root",
    session: { id: sessionId, appName: "app", userId: "u1", events: [] },
    userContent: { role: "user", parts: [{ text: "hi" }] },
    ...(artifactService ? { artifactService } : {}),
  } as never;
}

function scoped(base: InMemoryArtifactService, sessionId: string) {
  return new ScopedArtifactService(base, "app", "u1", sessionId);
}

type Fake = { driver: ClaudeAgentSdkDriver; stores: unknown[] };

/** A driver whose fake query() records the store it was given. */
function fakeDriver(sessionStore: unknown): Fake {
  const stores: unknown[] = [];
  const driver = new ClaudeAgentSdkDriver({
    sessionStore: sessionStore as never,
    sdk: {
      query: ({ options }) => {
        stores.push((options as { sessionStore?: unknown }).sessionStore);
        return (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-1",
          } as never;
          yield {
            type: "result",
            subtype: "success",
            result: "ok",
            session_id: "sdk-1",
          } as never;
        })() as never;
      },
    },
  });
  return { driver, stores };
}

async function collect(
  iterable: AsyncIterable<ExternalAgentEvent>,
): Promise<ExternalAgentEvent[]> {
  const events: ExternalAgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

const run = (driver: ClaudeAgentSdkDriver, context: never) =>
  collect(
    driver.run({
      provider: CLAUDE_PROVIDER,
      context,
      permissions: { mode: "ask" },
    }),
  );

describe("ClaudeAgentSdkDriver with a SessionStoreFactory", () => {
  test("A11: no artifact service gives CLAUDE_SESSION_STORE_UNAVAILABLE before query()", async () => {
    const { driver, stores } = fakeDriver(adkArtifactSessionStore());
    const events = await run(driver, contextFor("s1"));
    expect(stores).toHaveLength(0);
    const error = events.find((event) => event.type === "error");
    expect(error).toEqual(
      expect.objectContaining({
        code: "CLAUDE_SESSION_STORE_UNAVAILABLE",
        recoverable: false,
        message: expect.stringContaining("artifact service"),
      }),
    );
    expect(events.at(-1)).toEqual(
      expect.objectContaining({ type: "completed", exitCode: 1 }),
    );
    expect(events.filter((event) => event.type === "completed")).toHaveLength(
      1,
    );
  });

  test("A11: the SDK is never loaded when the store is unavailable", async () => {
    let imports = 0;
    const driver = new ClaudeAgentSdkDriver({
      sessionStore: adkArtifactSessionStore(),
      importSdk: async () => {
        imports += 1;
        throw new Error("the SDK must not be imported");
      },
    });
    const events = await run(driver, contextFor("s1"));
    expect(imports).toBe(0);
    expect(events.find((event) => event.type === "error")).toEqual(
      expect.objectContaining({ code: "CLAUDE_SESSION_STORE_UNAVAILABLE" }),
    );
  });

  test("A11: any throw from a factory is reported the same way, with its message", async () => {
    const { driver, stores } = fakeDriver(() => {
      throw new Error("factory exploded");
    });
    const events = await run(driver, contextFor("s1"));
    expect(stores).toHaveLength(0);
    expect(events.find((event) => event.type === "error")).toEqual(
      expect.objectContaining({
        code: "CLAUDE_SESSION_STORE_UNAVAILABLE",
        recoverable: false,
        message: expect.stringContaining("factory exploded"),
      }),
    );
    expect(events.at(-1)).toEqual(
      expect.objectContaining({ type: "completed", exitCode: 1 }),
    );
  });

  test("A12: query() gets a store bound to context.session.id; two sessions do not mix", async () => {
    const base = new InMemoryArtifactService();
    const { driver, stores } = fakeDriver(adkArtifactSessionStore());
    const a = await run(driver, contextFor("s1", scoped(base, "s1")));
    const b = await run(driver, contextFor("s2", scoped(base, "s2")));
    expect(a.at(-1)).toEqual(expect.objectContaining({ exitCode: 0 }));
    expect(b.at(-1)).toEqual(expect.objectContaining({ exitCode: 0 }));
    expect(stores).toHaveLength(2);
    const [first, second] = stores as SessionStore[];
    expect(first).not.toBe(second);
    await first?.append(KEY, [{ type: "user", uuid: "u-a" }]);
    await second?.append(KEY, [{ type: "user", uuid: "u-b" }]);
    expect(await first?.load(KEY)).toEqual([{ type: "user", uuid: "u-a" }]);
    expect(await second?.load(KEY)).toEqual([{ type: "user", uuid: "u-b" }]);
    const keys1 = await base.listArtifactKeys({
      appName: "app",
      userId: "u1",
      sessionId: "s1",
    });
    const keys2 = await base.listArtifactKeys({
      appName: "app",
      userId: "u1",
      sessionId: "s2",
    });
    expect(keys1.length).toBeGreaterThan(0);
    expect(keys2.length).toBeGreaterThan(0);
    expect(keys1.every((k) => k.startsWith("claude-session.v1."))).toBe(true);
  });

  test("A12: a plain store object still reaches query() unchanged", async () => {
    const plain: SessionStore = {
      append: async () => {},
      load: async () => null,
    };
    const { driver, stores } = fakeDriver(plain);
    await run(driver, contextFor("s1"));
    expect(stores).toEqual([plain]);
  });

  test("A13: the artifactService override is used, scoped by context.session", async () => {
    const override = new InMemoryArtifactService();
    const { driver, stores } = fakeDriver(
      adkArtifactSessionStore({ artifactService: override }),
    );
    // The context has no artifact service of its own: the override carries it.
    const events = await run(driver, contextFor("s9"));
    expect(events.at(-1)).toEqual(
      expect.objectContaining({ type: "completed", exitCode: 0 }),
    );
    const [store] = stores as SessionStore[];
    await store?.append(KEY, [{ type: "user", uuid: "u-o" }]);
    const keys = await override.listArtifactKeys({
      appName: "app",
      userId: "u1",
      sessionId: "s9",
    });
    expect(keys.some((k) => k.startsWith("claude-session.v1."))).toBe(true);
    expect(
      await override.listArtifactKeys({
        appName: "app",
        userId: "u1",
        sessionId: "other",
      }),
    ).toEqual([]);
  });

  test("a factory sessionStore is resolved on every run (fresh store per run)", async () => {
    const base = new InMemoryArtifactService();
    const { driver, stores } = fakeDriver(adkArtifactSessionStore());
    await run(driver, contextFor("s1", scoped(base, "s1")));
    await run(driver, contextFor("s1", scoped(base, "s1")));
    expect(stores).toHaveLength(2);
    expect(stores[0]).not.toBe(stores[1]);
    const [x, y] = stores as SessionStore[];
    await x?.append(KEY, [{ type: "user", uuid: "u-1" }]);
    expect(await y?.load(KEY)).toEqual([{ type: "user", uuid: "u-1" }]);
  });

  test("the factory is called once per run, with the run's context", async () => {
    const seen: unknown[] = [];
    const plain: SessionStore = {
      append: async () => {},
      load: async () => null,
    };
    const { driver, stores } = fakeDriver((run: { context: unknown }) => {
      seen.push(run.context);
      return plain;
    });
    const context = contextFor("s1");
    await run(driver, context);
    expect(seen).toEqual([context]);
    expect(stores).toEqual([plain]);
  });

  test("A14: ClaudeCliDriver refuses a factory sessionStore when built", () => {
    let caught: unknown;
    try {
      new ClaudeCliDriver({ sessionStore: adkArtifactSessionStore() } as never);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExternalAgentPolicyError);
    expect((caught as ExternalAgentPolicyError).code).toBe(
      EXTERNAL_AGENT_OPTION_UNSUPPORTED,
    );
  });
});
