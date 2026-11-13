import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemorySessionStore,
  importSessionToStore,
} from "@anthropic-ai/claude-agent-sdk";
import { InputValidationError } from "@google/adk";
import { ClaudeAgentSdkDriver } from "../../../src/agents/driver/claude-agent-sdk.js";
import { ClaudeCliDriver } from "../../../src/agents/driver/claude-cli.js";
import {
  EXTERNAL_AGENT_OPTION_UNSUPPORTED,
  ExternalAgentPolicyError,
} from "../../../src/agents/driver/policy-errors.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/schema.js";
import { SqliteSessionStore } from "../../../src/agents/session-store/sqlite/index.js";

const request = {
  provider: CLAUDE_PROVIDER,
  context: {
    agent: { name: "claude" },
    branch: "root",
    session: { id: "adk-session", events: [] },
    userContent: { role: "user", parts: [{ text: "hi" }] },
  } as never,
  permissions: { mode: "ask" as const },
};

function thrown(build: () => unknown): unknown {
  try {
    build();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("Claude Agent SDK session store tuning", () => {
  test("sessionStoreFlush and sessionStoreLoadTimeoutMs reach query() as the SDK options", () => {
    const store = new InMemorySessionStore();
    const options = new ClaudeAgentSdkDriver({
      sessionStore: store,
      sessionStoreFlush: "eager",
      sessionStoreLoadTimeoutMs: 5_000,
    }).buildOptions(request) as Record<string, unknown>;
    expect(options.sessionStore).toBe(store);
    expect(options.sessionStoreFlush).toBe("eager");
    expect(options.loadTimeoutMs).toBe(5_000);
  });

  test("without them the SDK defaults apply (no keys passed)", () => {
    const options = new ClaudeAgentSdkDriver({
      sessionStore: new InMemorySessionStore(),
    }).buildOptions(request) as Record<string, unknown>;
    expect("sessionStoreFlush" in options).toBe(false);
    expect("loadTimeoutMs" in options).toBe(false);
  });

  test.each([
    [{ sessionStoreFlush: "eager" }],
    [{ sessionStoreLoadTimeoutMs: 1_000 }],
  ])("refuses %p without a sessionStore instead of ignoring it", (config) => {
    const error = thrown(() => new ClaudeAgentSdkDriver(config as never));
    expect(error).toBeInstanceOf(InputValidationError);
    expect(String((error as Error).message)).toContain("sessionStore");
  });

  test.each([
    [{ sessionStoreFlush: "sometimes" }, "sessionStoreFlush"],
    [{ sessionStoreLoadTimeoutMs: 0 }, "sessionStoreLoadTimeoutMs"],
    [{ sessionStoreLoadTimeoutMs: -1 }, "sessionStoreLoadTimeoutMs"],
    [{ sessionStoreLoadTimeoutMs: 1.5 }, "sessionStoreLoadTimeoutMs"],
    [{ sessionStoreLoadTimeoutMs: Number.NaN }, "sessionStoreLoadTimeoutMs"],
    [{ sessionStoreLoadTimeoutMs: "100" }, "sessionStoreLoadTimeoutMs"],
  ])("refuses an invalid value %p", (config, field) => {
    const error = thrown(
      () =>
        new ClaudeAgentSdkDriver({
          sessionStore: new InMemorySessionStore(),
          ...(config as object),
        }),
    );
    expect(error).toBeInstanceOf(InputValidationError);
    expect(String((error as Error).message)).toContain(field);
  });

  test.each([
    [{ sessionStoreFlush: "eager" }],
    [{ sessionStoreLoadTimeoutMs: 1_000 }],
  ])("ClaudeCliDriver refuses %p when it is built", (config) => {
    const error = thrown(() => new ClaudeCliDriver(config as never));
    expect(error).toBeInstanceOf(ExternalAgentPolicyError);
    expect((error as ExternalAgentPolicyError).code).toBe(
      EXTERNAL_AGENT_OPTION_UNSUPPORTED,
    );
  });
});

describe("importing a local session into SqliteSessionStore", () => {
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  let root: string | undefined;

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  test("the SDK's importSessionToStore copies a local transcript into it (offline)", async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "adk-import-")));
    process.env.CLAUDE_CONFIG_DIR = join(root, "config");
    const cwd = join(root, "project");
    mkdirSync(cwd);
    // The SDK keys a project by its working directory with every
    // non-alphanumeric character replaced by "-".
    const projectKey = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const projectDir = join(root, "config", "projects", projectKey);
    mkdirSync(projectDir, { recursive: true });
    const sessionId = "11111111-2222-4333-8444-555555555555";
    const entry = {
      type: "user",
      uuid: "entry-1",
      sessionId,
      message: { role: "user", content: "hello" },
    };
    writeFileSync(
      join(projectDir, `${sessionId}.jsonl`),
      `${JSON.stringify(entry)}\n`,
    );

    const store = new SqliteSessionStore({ path: join(root, "sessions.db") });
    try {
      await importSessionToStore(sessionId, store, { dir: cwd });
      expect(await store.load({ projectKey, sessionId })).toEqual([entry]);
    } finally {
      store.close();
    }
  });
});
