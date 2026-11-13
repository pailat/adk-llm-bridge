import { describe, expect, test } from "bun:test";
import type {
  SessionKey as SdkSessionKey,
  SessionStore as SdkSessionStore,
  SessionStoreEntry as SdkSessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { InMemorySessionStore } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgent } from "../../../src/agents/claude-agent.js";
import {
  CLAUDE_SESSION_STORE_MIRROR_ERROR,
  ClaudeAgentSdkDriver,
} from "../../../src/agents/driver/claude-agent-sdk.js";
import { ClaudeCliDriver } from "../../../src/agents/driver/claude-cli.js";
import {
  EXTERNAL_AGENT_OPTION_UNSUPPORTED,
  ExternalAgentPolicyError,
} from "../../../src/agents/driver/policy-errors.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import type {
  SessionKey,
  SessionStore,
  SessionStoreEntry,
} from "../../../src/agents/index.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/schema.js";
import type { SqliteSessionStore } from "../../../src/agents/session-store/sqlite/index.js";

// The package's own session store types stay assignable both ways to the
// SDK's, so a store built for one is accepted by the other.
type Assignable<From, To> = From extends To ? true : false;
const typeChecks: [
  Assignable<SessionStore, SdkSessionStore>,
  Assignable<SdkSessionStore, SessionStore>,
  Assignable<SessionKey, SdkSessionKey>,
  Assignable<SdkSessionKey, SessionKey>,
  Assignable<SessionStoreEntry, SdkSessionStoreEntry>,
  Assignable<SdkSessionStoreEntry, SessionStoreEntry>,
  Assignable<SqliteSessionStore, SdkSessionStore>,
  Assignable<InMemorySessionStore, SessionStore>,
] = [true, true, true, true, true, true, true, true];

type CapturedOptions = { resume?: string; sessionStore?: unknown };

function recordingDriver(
  store: SessionStore,
  captured: CapturedOptions[],
  messages: (index: number) => unknown[] = () => [],
): ClaudeAgentSdkDriver {
  return new ClaudeAgentSdkDriver({
    sessionStore: store,
    sdk: {
      query: ({ options }) => {
        const index = captured.length;
        captured.push(options as CapturedOptions);
        return (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-1",
          } as never;
          for (const message of messages(index)) yield message as never;
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
}

const context = (text: string) =>
  ({
    agent: { name: "claude" },
    branch: "root",
    session: { id: "adk-session", events: [] },
    userContent: { role: "user", parts: [{ text }] },
  }) as never;

async function collect(
  iterable: AsyncIterable<ExternalAgentEvent>,
): Promise<ExternalAgentEvent[]> {
  const events: ExternalAgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("Claude Agent SDK sessionStore", () => {
  test("the package types match the SDK's", () => {
    expect(typeChecks.every(Boolean)).toBe(true);
  });

  test("the store reaches query() on the first run and on the resumed run", async () => {
    const store = new InMemorySessionStore();
    const captured: CapturedOptions[] = [];
    const driver = recordingDriver(store, captured);
    await collect(
      driver.run({
        provider: CLAUDE_PROVIDER,
        context: context("hello"),
        permissions: { mode: "ask" },
      }),
    );
    await collect(
      driver.run({
        provider: CLAUDE_PROVIDER,
        context: context("again"),
        permissions: { mode: "ask" },
      }),
    );
    expect(captured).toHaveLength(2);
    expect(captured[0]?.resume).toBeUndefined();
    expect(captured[0]?.sessionStore).toBe(store);
    // The resume loads the transcript from the store, so both go together.
    expect(captured[1]?.resume).toBe("sdk-1");
    expect(captured[1]?.sessionStore).toBe(store);
  });

  test("a configured resumeSessionId carries the store too", async () => {
    const store = new InMemorySessionStore();
    const driver = new ClaudeAgentSdkDriver({
      sessionStore: store,
      resumeSessionId: "from-store",
    });
    const options = driver.buildOptions({
      provider: CLAUDE_PROVIDER,
      context: context("hi"),
      permissions: { mode: "ask" },
    }) as CapturedOptions;
    expect(options.resume).toBe("from-store");
    expect(options.sessionStore).toBe(store);
  });

  test("without a store no sessionStore key is passed", () => {
    const options = new ClaudeAgentSdkDriver().buildOptions({
      provider: CLAUDE_PROVIDER,
      context: context("hi"),
      permissions: { mode: "ask" },
    });
    expect("sessionStore" in options).toBe(false);
  });

  test("ClaudeAgent passes driverOptions.sessionStore to query()", async () => {
    const store = new InMemorySessionStore();
    const captured: CapturedOptions[] = [];
    const agent = new ClaudeAgent({
      name: "claude",
      driverOptions: {
        sessionStore: store,
        sdk: {
          query: ({ options }) => {
            captured.push(options as CapturedOptions);
            return (async function* () {
              yield {
                type: "result",
                subtype: "success",
                result: "ok",
              } as never;
            })() as never;
          },
        },
      },
    });
    const driver = (agent as unknown as { driver: ClaudeAgentSdkDriver })
      .driver;
    await collect(
      driver.run({
        provider: CLAUDE_PROVIDER,
        context: context("hi"),
        permissions: { mode: "ask" },
      }),
    );
    expect(captured[0]?.sessionStore).toBe(store);
  });

  test("a mirror_error message becomes a recoverable error event and the run still completes", async () => {
    const captured: CapturedOptions[] = [];
    const driver = recordingDriver(new InMemorySessionStore(), captured, () => [
      {
        type: "system",
        subtype: "mirror_error",
        error: "disk full",
        key: { projectKey: "p", sessionId: "sdk-1" },
        uuid: "x",
        session_id: "sdk-1",
      },
    ]);
    const events = await collect(
      driver.run({
        provider: CLAUDE_PROVIDER,
        context: context("hi"),
        permissions: { mode: "ask" },
      }),
    );
    const errors = events.filter((event) => event.type === "error");
    expect(errors).toEqual([
      expect.objectContaining({
        code: CLAUDE_SESSION_STORE_MIRROR_ERROR,
        recoverable: true,
        message: expect.stringContaining("disk full"),
      }),
    ]);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({ type: "completed", exitCode: 0 }),
    );
  });

  test("ClaudeCliDriver refuses a sessionStore when it is built", () => {
    let caught: unknown;
    try {
      new ClaudeCliDriver({
        sessionStore: new InMemorySessionStore(),
      } as never);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExternalAgentPolicyError);
    expect((caught as ExternalAgentPolicyError).code).toBe(
      EXTERNAL_AGENT_OPTION_UNSUPPORTED,
    );
    expect(() => new ClaudeCliDriver({})).not.toThrow();
  });
});
