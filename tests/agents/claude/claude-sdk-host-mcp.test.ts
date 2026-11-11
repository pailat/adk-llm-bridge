/**
 * Declared MCP servers on the Claude Agent SDK driver, with a fake SDK:
 * transport over `setMcpServers` before the user message, the required-server
 * wait, the run-time order (no resolver before every check passed), the
 * output paths of a secret (canary), the output-scrub hook, the guard and
 * hooks, and the MCP event metadata.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { InputValidationError } from "@google/adk";
import {
  ClaudeAgentSdkDriver,
  type ClaudeAgentSdkDriverConfig,
  claudeSdkSessionStateKey,
  toolResultEvents,
  toolUseEvents,
} from "../../../src/agents/driver/claude-agent-sdk.js";
import { claudeProjectKey } from "../../../src/agents/driver/claude-spill-guard.js";
import { mcpSecretHost } from "../../../src/agents/driver/mcp-secrets.js";
import {
  EXTERNAL_AGENT_DEPENDENCY_MISSING,
  EXTERNAL_AGENT_ISOLATION_VIOLATED,
  EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE,
  EXTERNAL_AGENT_MCP_SERVER_NETWORK_REQUIRED,
  EXTERNAL_AGENT_MCP_SERVER_UNAVAILABLE,
  EXTERNAL_AGENT_MCP_STDIO_UNSAFE,
  EXTERNAL_AGENT_NETWORK_UNENFORCEABLE,
  ExternalAgentPolicyError,
} from "../../../src/agents/driver/policy-errors.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import type { ExternalAgentRunRequest } from "../../../src/agents/external-agent-driver.js";
import { guardPermissionRequest } from "../../../src/agents/permissions/confirmation.js";
import type { ExternalAgentPermissionPolicy } from "../../../src/agents/permissions/schema.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/schema.js";
import { captureWarnings } from "../../helpers/fake-logger.js";

const CANARY = "hostmcp-canary-5d1e8b7a";
const CANARY_FORMS = [
  CANARY,
  Buffer.from(CANARY).toString("base64"),
  Buffer.from(CANARY).toString("base64url"),
  Buffer.from(`Bearer ${CANARY}`).toString("base64"),
];

function expectNoCanary(value: unknown): void {
  const text = JSON.stringify(value, (_key, item) =>
    typeof item === "function" ? "[function]" : item,
  );
  for (const form of CANARY_FORMS) {
    expect(text).not.toContain(form);
  }
}

// A working directory and a Claude config dir of the test's own: a run with
// a declared secret reserves its session path there, never under ~/.claude.
// Next to this file, not in the temp directory, which a runtime sandbox keeps
// writable and the driver therefore refuses as allowedPaths.
const ROOT = realpathSync.native(
  mkdtempSync(join(import.meta.dir, ".host-scratch-sdk-")),
);
const WORK = join(ROOT, "repo");
const CONFIG = join(ROOT, "config");
mkdirSync(WORK);
const PROJECT_DIR = join(CONFIG, "projects", claudeProjectKey(WORK) as string);
const savedHome = process.env.HOME;
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const savedHost = { ...mcpSecretHost };
beforeEach(() => {
  // A driver env without CLAUDE_CONFIG_DIR or HOME falls back to the
  // process home: point it here too.
  process.env.HOME = join(ROOT, "home");
  // Default platform for these tests: macOS, where the sandboxed
  // shell cannot read process environments.
  mcpSecretHost.platform = () => "darwin";
  mcpSecretHost.readPtraceScope = () => "1";
});
afterEach(() => {
  Object.assign(mcpSecretHost, savedHost);
  process.env.HOME = savedHome;
});

type HookFn = (
  input: Record<string, unknown>,
  toolUseId: string | undefined,
  extra: { signal: AbortSignal },
) => Promise<Record<string, unknown>>;
type Hooks = Partial<Record<string, Array<{ hooks: HookFn[] }>>>;

type Options = Record<string, unknown> & {
  hooks?: Hooks;
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    extra: Record<string, unknown>,
  ) => Promise<{ behavior: string; message?: string }>;
  sessionStore?: { append: (key: unknown, entries: unknown) => unknown };
};

type Step =
  | Record<string, unknown>
  | ((options: Options) => Promise<void> | void);

interface FakeSdkOptions {
  steps?: Step[];
  setResult?: { errors?: Record<string, string> };
  setRejects?: Error;
  statuses?: Array<Array<{ name: string; status: string; error?: string }>>;
  noSetMcpServers?: boolean;
}

/**
 * A fake SDK whose query reads the prompt first, as the runtime does, then
 * streams `steps`. It records the options, the prompt, and the order of
 * control calls and user messages.
 */
function fakeSdk(fake: FakeSdkOptions = {}) {
  const state: {
    options?: Options;
    prompt?: unknown;
    messages: unknown[];
    log: string[];
    payloads: Record<string, Record<string, unknown>>[];
  } = { messages: [], log: [], payloads: [] };
  let statusCall = 0;
  const sdk = {
    query: (input: { prompt: unknown; options: Options }) => {
      state.options = input.options;
      state.prompt = input.prompt;
      const stream = (async function* () {
        if (typeof input.prompt === "string") {
          state.log.push("string-prompt");
        } else {
          for await (const message of input.prompt as AsyncIterable<unknown>) {
            state.log.push("message");
            state.messages.push(message);
          }
        }
        // The runtime reports the session id the driver passed.
        const sid = input.options.sessionId;
        for (const step of fake.steps ?? DEFAULT_STEPS) {
          if (typeof step === "function") await step(input.options);
          else if (typeof sid === "string" && step.session_id === "s-1")
            yield { ...step, session_id: sid };
          else yield step;
        }
      })();
      return Object.assign(
        stream,
        fake.noSetMcpServers
          ? {}
          : {
              setMcpServers: async (
                servers: Record<string, Record<string, unknown>>,
              ) => {
                state.log.push("setMcpServers");
                state.payloads.push(servers);
                if (fake.setRejects) throw fake.setRejects;
                return {
                  added: Object.keys(servers),
                  removed: [],
                  ...fake.setResult,
                };
              },
            },
        {
          mcpServerStatus: async () => {
            state.log.push("status");
            const list = fake.statuses ?? [];
            const at = list[Math.min(statusCall++, list.length - 1)] ?? [];
            // The real status carries the config (with headers): the driver
            // must never surface it.
            return at.map((entry) => ({
              ...entry,
              config: { headers: { Authorization: `Bearer ${CANARY}` } },
            }));
          },
          interrupt: async () => {},
        },
      );
    },
    tool: (name: string) => ({ name }),
    createSdkMcpServer: (config: Record<string, unknown>) => ({
      type: "sdk",
      name: config.name,
      instance: {},
    }),
  };
  return { sdk, state };
}

const INIT = (mcp: string[] = ["docs"]) => ({
  type: "system",
  subtype: "init",
  model: "claude-haiku-5-5",
  session_id: "s-1",
  tools: ["Read", ...mcp.map((name) => `mcp__${name}__search`)],
  mcp_servers: mcp.map((name) => ({ name, status: "connected" })),
});
const RESULT = {
  type: "result",
  subtype: "success",
  result: "done",
  session_id: "s-1",
};
const DEFAULT_STEPS: Step[] = [INIT(), RESULT];

function toolUse(
  name: string,
  id: string,
  input: unknown = {},
  parent?: string,
) {
  return {
    type: "assistant",
    parent_tool_use_id: parent ?? null,
    session_id: "s-1",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name, input }],
    },
  };
}
function toolResult(id: string, content: unknown, isError?: boolean) {
  return {
    type: "user",
    parent_tool_use_id: null,
    session_id: "s-1",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content,
          ...(isError ? { is_error: true } : {}),
        },
      ],
    },
  };
}

const DOCS = {
  docs: {
    type: "http" as const,
    url: "http://127.0.0.1:7801/mcp",
    headers: {
      Authorization: { resolve: () => CANARY, prefix: "Bearer " },
      Accept: { public: "application/json" },
    },
    tools: ["search", "read_page"],
    readOnly: true,
  },
};

function request(
  extra: Partial<ExternalAgentRunRequest> = {},
): ExternalAgentRunRequest {
  return {
    provider: CLAUDE_PROVIDER,
    context: { input: "find the docs" } as never,
    workingDirectory: WORK,
    permissions: { mode: "workspace-write" },
    ...extra,
  } as ExternalAgentRunRequest;
}

function driverOf(
  sdk: unknown,
  config: Partial<ClaudeAgentSdkDriverConfig> = {},
): ClaudeAgentSdkDriver {
  return new ClaudeAgentSdkDriver({
    sdk: sdk as never,
    tools: ["Read"],
    mcpServers: DOCS,
    ...config,
    env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: CONFIG, ...config.env },
  });
}

async function collect(
  driver: ClaudeAgentSdkDriver,
  req: ExternalAgentRunRequest = request(),
): Promise<ExternalAgentEvent[]> {
  const events: ExternalAgentEvent[] = [];
  for await (const event of driver.run(req)) events.push(event);
  return events;
}

const errorOf = (events: ExternalAgentEvent[]) =>
  events.find((event) => event.type === "error") as
    | (ExternalAgentEvent & {
        code?: string;
        recoverable?: boolean;
        message: string;
      })
    | undefined;

function hooksOf(options: Options | undefined, event: string): HookFn[] {
  return (options?.hooks?.[event] ?? []).flatMap((matcher) => matcher.hooks);
}

function sessionOf(options: Options | undefined): Record<string, unknown> {
  const sid =
    typeof options?.sessionId === "string" ? options.sessionId : "s-1";
  return {
    session_id: sid,
    transcript_path: join(PROJECT_DIR, `${sid}.jsonl`),
  };
}

async function runHooks(
  options: Options | undefined,
  event: string,
  input: Record<string, unknown>,
  id = "toolu_1",
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const hook of hooksOf(options, event)) {
    out.push(
      await hook(
        {
          hook_event_name: event,
          // The runtime names its session and transcript in every hook input.
          ...sessionOf(options),
          ...input,
        },
        id,
        {
          signal: new AbortController().signal,
        },
      ),
    );
  }
  return out;
}

const denied = (outputs: Record<string, unknown>[]) =>
  outputs.some(
    (output) =>
      (output.hookSpecificOutput as Record<string, unknown> | undefined)
        ?.permissionDecision === "deny",
  );

describe("transport", () => {
  test("declared servers never appear in query() options", async () => {
    const { sdk, state } = fakeSdk();
    await collect(driverOf(sdk));
    const servers = (state.options?.mcpServers ?? {}) as Record<
      string,
      unknown
    >;
    expect(Object.keys(servers)).not.toContain("docs");
    expect(JSON.stringify(state.options)).not.toContain("127.0.0.1:7801");
    expectNoCanary(state.options);
    // The child environment is unchanged by declared servers.
    expectNoCanary(state.options?.env);
  });

  test("setMcpServers is called once, before the user message", async () => {
    const { sdk, state } = fakeSdk();
    const events = await collect(driverOf(sdk));
    expect(errorOf(events)).toBeUndefined();
    expect(state.log.filter((entry) => entry === "setMcpServers")).toHaveLength(
      1,
    );
    expect(state.log.indexOf("setMcpServers")).toBeLessThan(
      state.log.indexOf("message"),
    );
    expect(state.payloads[0]?.docs).toEqual({
      type: "http",
      url: "http://127.0.0.1:7801/mcp",
      headers: {
        Authorization: `Bearer ${CANARY}`,
        Accept: "application/json",
      },
      alwaysLoad: true,
    });
  });

  test("the payload carries the bridge's own server, so it stays connected", async () => {
    const { sdk, state } = fakeSdk();
    await collect(
      driverOf(sdk),
      request({
        adkTools: {
          declarations: [{ name: "lookup", description: "x", parameters: {} }],
          runTool: async () => ({}),
        } as never,
      }),
    );
    expect(Object.keys(state.payloads[0] ?? {}).sort()).toEqual([
      "adk_bridge",
      "docs",
    ]);
    const optionServers = (state.options?.mcpServers ?? {}) as Record<
      string,
      unknown
    >;
    expect(state.payloads[0]?.adk_bridge as unknown).toBe(
      optionServers.adk_bridge,
    );
  });

  test("a stdio server is passed with timeout and alwaysLoad", async () => {
    const { sdk, state } = fakeSdk({ steps: [INIT(["proc"]), RESULT] });
    await collect(
      driverOf(sdk, {
        mcpServers: {
          proc: {
            type: "stdio",
            command: "/bin/sh",
            args: ["-v"],
            env: { MODE: { public: "fast" } },
            timeoutMs: 5000,
          },
        },
      }),
    );
    const proc = state.payloads[0]?.proc as Record<string, unknown>;
    expect(proc).toMatchObject({
      type: "stdio",
      args: ["-v"],
      env: { MODE: "fast" },
      timeout: 5000,
      alwaysLoad: true,
    });
    expect(String(proc.command)).toMatch(/sh$/);
  });

  test("the iterable carries exactly one user message with the prompt text", async () => {
    const { sdk, state } = fakeSdk();
    await collect(driverOf(sdk));
    expect(state.messages).toHaveLength(1);
    const message = state.messages[0] as Record<string, unknown>;
    expect(message.type).toBe("user");
    const plain = new ClaudeAgentSdkDriver({ env: {} }).buildPromptInput(
      request(),
    );
    expect(typeof plain).toBe("string");
    expect(asRecord(message.message).content).toEqual([
      { type: "text", text: plain },
    ]);
  });

  test("without declared servers the string prompt is byte-identical", async () => {
    const { sdk, state } = fakeSdk();
    const driver = new ClaudeAgentSdkDriver({
      sdk: sdk as never,
      env: { PATH: process.env.PATH },
      tools: ["Read"],
    });
    await collect(driver);
    expect(state.log).toContain("string-prompt");
    expect(state.prompt).toBe(driver.buildPromptInput(request()));
    expect(state.log).not.toContain("setMcpServers");
  });

  test("an SDK without setMcpServers refuses the run", async () => {
    const { sdk } = fakeSdk({ noSetMcpServers: true });
    const error = errorOf(await collect(driverOf(sdk)));
    expect(error?.code).toBe(EXTERNAL_AGENT_DEPENDENCY_MISSING);
  });

  test("a setMcpServers failure is the run's error, scrubbed", async () => {
    const { sdk } = fakeSdk({
      setRejects: new Error(`connect failed with Bearer ${CANARY}`),
    });
    const events = await collect(driverOf(sdk));
    const error = errorOf(events);
    expect(error).toBeDefined();
    expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 1 });
    expectNoCanary(events);
  });
});

describe("required servers", () => {
  const required = { requiredMcpServers: ["docs"] };

  test("pending, then connected: the message waits for it", async () => {
    const { sdk, state } = fakeSdk({
      statuses: [
        [{ name: "docs", status: "pending" }],
        [{ name: "docs", status: "pending" }],
        [{ name: "docs", status: "connected" }],
      ],
    });
    const events = await collect(driverOf(sdk, required));
    expect(errorOf(events)).toBeUndefined();
    const statusCalls = state.log.filter((entry) => entry === "status");
    expect(statusCalls).toHaveLength(3);
    expect(state.log.lastIndexOf("status")).toBeLessThan(
      state.log.indexOf("message"),
    );
  });

  test("still pending after mcpConnectTimeoutMs: recoverable UNAVAILABLE", async () => {
    const { sdk, state } = fakeSdk({
      statuses: [[{ name: "docs", status: "pending" }]],
    });
    const started = Date.now();
    const events = await collect(
      driverOf(sdk, { ...required, mcpConnectTimeoutMs: 1000 }),
    );
    const error = errorOf(events);
    expect(error?.code).toBe(EXTERNAL_AGENT_MCP_SERVER_UNAVAILABLE);
    expect(error?.recoverable).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(state.log).not.toContain("message");
    expect(events[0]?.type).toBe("started");
    expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 1 });
  });

  test("a failed status ends the wait at once, its error scrubbed", async () => {
    const { sdk, state } = fakeSdk({
      statuses: [
        [{ name: "docs", status: "failed", error: `401 for ${CANARY}` }],
      ],
    });
    const events = await collect(driverOf(sdk, required));
    expect(errorOf(events)?.code).toBe(EXTERNAL_AGENT_MCP_SERVER_UNAVAILABLE);
    expect(state.log.filter((entry) => entry === "status")).toHaveLength(1);
    expectNoCanary(events);
  });

  for (const status of ["needs-auth", "disabled"]) {
    test(`a ${status} status ends the wait at once`, async () => {
      const { sdk, state } = fakeSdk({
        statuses: [[{ name: "docs", status }]],
      });
      const started = Date.now();
      const events = await collect(driverOf(sdk, required));
      expect(errorOf(events)?.code).toBe(EXTERNAL_AGENT_MCP_SERVER_UNAVAILABLE);
      expect(errorOf(events)?.message).toContain(status);
      expect(state.log.filter((entry) => entry === "status")).toHaveLength(1);
      expect(Date.now() - started).toBeLessThan(900);
    });
  }

  test("errors[name] from setMcpServers for a required server", async () => {
    const { sdk } = fakeSdk({
      setResult: { errors: { docs: `refused ${CANARY}` } },
    });
    const events = await collect(driverOf(sdk, required));
    expect(errorOf(events)?.code).toBe(EXTERNAL_AGENT_MCP_SERVER_UNAVAILABLE);
    expectNoCanary(events);
  });

  test("errors[name] for a server that is not required: a scrubbed warning", async () => {
    const warnings = captureWarnings();
    try {
      const { sdk } = fakeSdk({
        setResult: { errors: { docs: `refused ${CANARY}` } },
      });
      const events = await collect(driverOf(sdk));
      expect(errorOf(events)).toBeUndefined();
      expect(warnings.codes).toContain(EXTERNAL_AGENT_MCP_SERVER_UNAVAILABLE);
      expectNoCanary(warnings.mock.calls);
    } finally {
      warnings.mockRestore();
    }
  });

  test("requiredMcpServers may name a declared server in isolated mode", () => {
    expect(() =>
      driverOf(fakeSdk().sdk, { requiredMcpServers: ["docs", "adk_bridge"] }),
    ).not.toThrow();
    expect(() =>
      driverOf(fakeSdk().sdk, { requiredMcpServers: ["other"] }),
    ).toThrow(InputValidationError);
    expect(() =>
      driverOf(fakeSdk().sdk, { requiredMcpServers: ["other"] }),
    ).toThrow(/mcpServers/);
  });
});

describe("run-time order: no resolver runs before every check passed", () => {
  function spyServer(server: Record<string, unknown>) {
    const calls: string[] = [];
    return {
      calls,
      servers: {
        docs: {
          ...server,
          headers: {
            Authorization: {
              resolve: () => {
                calls.push("resolve");
                return CANARY;
              },
            },
          },
        },
      } as never,
    };
  }

  test("network: a remote server with the network off", async () => {
    const spy = spyServer({ type: "http", url: "https://10.0.0.5/mcp" });
    const { sdk, state } = fakeSdk();
    const events = await collect(driverOf(sdk, { mcpServers: spy.servers }));
    expect(errorOf(events)?.code).toBe(
      EXTERNAL_AGENT_MCP_SERVER_NETWORK_REQUIRED,
    );
    expect(spy.calls).toEqual([]);
    expect(state.options).toBeUndefined();
  });

  test("network on: the remote server is accepted and resolved once", async () => {
    const spy = spyServer({ type: "http", url: "https://10.0.0.5/mcp" });
    const { sdk } = fakeSdk();
    const events = await collect(
      driverOf(sdk, { mcpServers: spy.servers }),
      request({ permissions: { mode: "workspace-write", allowNetwork: true } }),
    );
    expect(errorOf(events)).toBeUndefined();
    expect(spy.calls).toEqual(["resolve"]);
  });

  test("enforceability: { env } with a shell on Linux", async () => {
    mcpSecretHost.platform = () => "linux";
    const { sdk } = fakeSdk();
    const events = await collect(
      driverOf(sdk, {
        tools: ["Bash"],
        mcpServers: {
          docs: {
            type: "http",
            url: "http://127.0.0.1:1/",
            headers: { Authorization: { env: "DOCS_TOKEN" } },
          },
        },
        env: { PATH: process.env.PATH, DOCS_TOKEN: CANARY },
      }),
    );
    expect(errorOf(events)?.code).toBe(EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE);
    expectNoCanary(events);
  });

  test("a later existing refusal (web tools with the network off) runs no resolver", async () => {
    const spy = spyServer({ type: "http", url: "http://127.0.0.1:1/" });
    const { sdk } = fakeSdk();
    const events = await collect(
      driverOf(sdk, { mcpServers: spy.servers, tools: ["WebFetch"] }),
    );
    expect(errorOf(events)?.code).toBe(EXTERNAL_AGENT_NETWORK_UNENFORCEABLE);
    expect(spy.calls).toEqual([]);
  });

  test("a stdio server with a code-loading env name is refused at run time", async () => {
    const spy: string[] = [];
    const { sdk } = fakeSdk();
    const events = await collect(
      driverOf(sdk, {
        mcpServers: {
          proc: {
            type: "stdio",
            command: "/bin/sh",
            env: {
              NODE_OPTIONS: { public: "--require /w/x.js" },
              TOKEN: {
                resolve: () => {
                  spy.push("resolve");
                  return CANARY;
                },
              },
            },
          },
        },
      }),
    );
    expect(errorOf(events)?.code).toBe(EXTERNAL_AGENT_MCP_STDIO_UNSAFE);
    expect(errorOf(events)?.message).toContain("NODE_OPTIONS");
    expect(spy).toEqual([]);
  });

  test("Linux ptrace_scope 0 with Bash refuses a declared { resolve }", async () => {
    mcpSecretHost.platform = () => "linux";
    mcpSecretHost.readPtraceScope = () => "0";
    const spy = spyServer({ type: "http", url: "http://127.0.0.1:1/" });
    const { sdk } = fakeSdk();
    const events = await collect(
      driverOf(sdk, { mcpServers: spy.servers, tools: ["Bash"] }),
    );
    expect(errorOf(events)?.message).toContain("ptrace_scope");
    expect(spy.calls).toEqual([]);
  });

  test("Windows with a shell refuses a declared { resolve }; without one it runs", async () => {
    mcpSecretHost.platform = () => "win32";
    const spy = spyServer({ type: "http", url: "http://127.0.0.1:1/" });
    const refused = await collect(
      driverOf(fakeSdk().sdk, { mcpServers: spy.servers, tools: ["Bash"] }),
    );
    expect(errorOf(refused)?.message).toContain(
      "Windows: same-user processes can read process memory",
    );
    expect(spy.calls).toEqual([]);
    const accepted = await collect(
      driverOf(fakeSdk().sdk, { mcpServers: spy.servers, tools: ["Read"] }),
    );
    expect(errorOf(accepted)).toBeUndefined();
  });

  describe("macOS: the env exemption needs the no-network sandbox", () => {
    const envServer = {
      docs: {
        type: "http" as const,
        url: "http://127.0.0.1:1/",
        headers: { Authorization: { env: "DOCS_TOKEN" } },
      },
    };
    const stdioEnvServer = {
      proc: {
        type: "stdio" as const,
        command: "/bin/sh",
        env: { TOKEN: { resolve: () => CANARY } },
      },
    };
    const hostEnv = { PATH: process.env.PATH, DOCS_TOKEN: CANARY };
    const cases: [
      string,
      Partial<ClaudeAgentSdkDriverConfig>,
      ExternalAgentPermissionPolicy,
      string | undefined,
    ][] = [
      [
        "R1 Bash + { env }, network off (sandboxed): accepted",
        { mcpServers: envServer },
        { mode: "workspace-write" },
        undefined,
      ],
      [
        "R2 Bash + { env }, allowNetwork: true (no sandbox): refused",
        { mcpServers: envServer },
        { mode: "workspace-write", allowNetwork: true },
        EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE,
      ],
      [
        "R3 Bash + { env }, allowUnsandboxedShell: refused",
        { mcpServers: envServer, allowUnsandboxedShell: true },
        { mode: "workspace-write" },
        EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE,
      ],
      [
        "stdio env secret, allowNetwork: true: refused",
        { mcpServers: stdioEnvServer },
        { mode: "workspace-write", allowNetwork: true },
        EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE,
      ],
      [
        "stdio env secret, network off (sandboxed): accepted",
        { mcpServers: stdioEnvServer },
        { mode: "workspace-write" },
        undefined,
      ],
      [
        "confined paths on the no-network sandbox: accepted",
        { mcpServers: envServer },
        { mode: "workspace-write", allowedPaths: [WORK] },
        undefined,
      ],
      [
        "confined paths with allowNetwork: true: refused",
        { mcpServers: envServer },
        {
          mode: "workspace-write",
          allowNetwork: true,
          allowedPaths: [WORK],
        },
        EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE,
      ],
    ];
    for (const [label, config, permissions, code] of cases) {
      test(label, async () => {
        const names = Object.keys(config.mcpServers ?? {});
        const events = await collect(
          driverOf(fakeSdk({ steps: [INIT(names), RESULT] }).sdk, {
            tools: ["Read", "Bash"],
            env: hostEnv,
            ...config,
          }),
          request({ permissions }),
        );
        if (code === undefined) {
          expect(errorOf(events)).toBeUndefined();
        } else {
          expect(errorOf(events)?.code).toBe(code);
        }
        expectNoCanary(events);
      });
    }
  });

  test("Windows: PowerShell counts as a shell", async () => {
    mcpSecretHost.platform = () => "win32";
    const events = await collect(
      driverOf(fakeSdk().sdk, { tools: ["PowerShell"] }),
    );
    expect(errorOf(events)?.code).toBe(EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE);
    expect(errorOf(events)?.message).toContain("Windows");
  });

  test("an { env } variable that also reaches the runtime's env is refused", async () => {
    const provider = {
      ...CLAUDE_PROVIDER,
      envAllowlist: [...(CLAUDE_PROVIDER.envAllowlist ?? []), "DOCS_TOKEN"],
    };
    const events = await collect(
      driverOf(fakeSdk().sdk, {
        mcpServers: {
          docs: {
            type: "http",
            url: "http://127.0.0.1:1/",
            headers: { Authorization: { env: "DOCS_TOKEN" } },
          },
        },
        env: { PATH: process.env.PATH, DOCS_TOKEN: CANARY },
      }),
      request({
        provider,
        credential: { kind: "env", env: { DOCS_TOKEN: CANARY } },
      } as never),
    );
    expect(errorOf(events)?.code).toBe(EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE);
    expectNoCanary(events);
  });

  test("a resolved value equal to a runtime env value is refused before delivery", async () => {
    const provider = {
      ...CLAUDE_PROVIDER,
      envAllowlist: [...(CLAUDE_PROVIDER.envAllowlist ?? []), "SOME_KEY"],
    };
    const { sdk, state } = fakeSdk();
    const events = await collect(
      driverOf(sdk),
      request({
        provider,
        credential: { kind: "env", env: { SOME_KEY: CANARY } },
      } as never),
    );
    expect(errorOf(events)?.code).toBe(EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE);
    expect(state.payloads).toEqual([]);
    expectNoCanary(events);
  });

  test("declared servers follow the isolated rules under inheritHostConfig", async () => {
    mcpSecretHost.platform = () => "linux";
    const { sdk } = fakeSdk();
    const events = await collect(
      driverOf(sdk, {
        inheritHostConfig: true,
        tools: ["Bash"],
        mcpServers: {
          docs: {
            type: "http",
            url: "http://127.0.0.1:1/",
            headers: { Authorization: { env: "DOCS_TOKEN" } },
          },
        },
        env: { PATH: process.env.PATH, DOCS_TOKEN: CANARY },
      }),
    );
    expect(errorOf(events)?.code).toBe(EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE);
  });

  test("a debug switch in the credential env refuses a secret, and passes without one", async () => {
    const provider = {
      ...CLAUDE_PROVIDER,
      envAllowlist: [...(CLAUDE_PROVIDER.envAllowlist ?? []), "ANTHROPIC_LOG"],
    };
    const debugRequest = request({
      provider,
      credential: { kind: "env", env: { ANTHROPIC_LOG: "debug" } },
    } as never);
    const refused = await collect(driverOf(fakeSdk().sdk), debugRequest);
    expect(errorOf(refused)?.code).toBe(
      EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE,
    );
    expect(errorOf(refused)?.message).toContain("ANTHROPIC_LOG");
    const publicOnly = await collect(
      driverOf(fakeSdk().sdk, {
        mcpServers: {
          docs: {
            type: "http",
            url: "http://127.0.0.1:1/",
            headers: { Accept: { public: "x" } },
          },
        },
      }),
      debugRequest,
    );
    expect(errorOf(publicOnly)).toBeUndefined();
  });

  test("options never carry stderr, debug or debugFile", async () => {
    const { sdk, state } = fakeSdk();
    await collect(driverOf(sdk));
    for (const key of ["stderr", "debug", "debugFile"]) {
      expect(state.options).not.toHaveProperty(key);
    }
  });
});

describe("canary on every output path", () => {
  test("events, metadata, errors and results carry no secret form", async () => {
    const b64 = Buffer.from(CANARY).toString("base64");
    const { sdk } = fakeSdk({
      steps: [
        INIT(),
        {
          type: "assistant",
          parent_tool_use_id: null,
          session_id: "s-1",
          message: {
            role: "assistant",
            content: [{ type: "text", text: `I saw ${CANARY} and ${b64}` }],
          },
        },
        toolUse("mcp__docs__search", "toolu_1", { q: CANARY }, CANARY),
        toolResult("toolu_1", [
          { type: "text", text: `echo ${JSON.stringify({ h: CANARY })}` },
        ]),
        toolUse("mcp__docs__search", "toolu_2", { q: "x" }),
        toolResult("toolu_2", `error: ${encodeURIComponent(CANARY)}`, true),
        {
          type: "assistant",
          parent_tool_use_id: null,
          session_id: "s-1",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: `header ${Buffer.from(`Bearer ${CANARY}`).toString("base64")}`,
              },
            ],
          },
        },
        { ...RESULT, result: `final ${CANARY}` },
      ],
    });
    const events = await collect(driverOf(sdk));
    expect(errorOf(events)).toBeUndefined();
    expect(events.some((event) => event.type === "tool_result")).toBe(true);
    expectNoCanary(events);
  });

  test("an SDK error naming the secret is scrubbed", async () => {
    const { sdk } = fakeSdk({
      steps: [
        INIT(),
        () => {
          throw new Error(`upstream said Bearer ${CANARY}`);
        },
      ],
    });
    const events = await collect(driverOf(sdk));
    expect(errorOf(events)).toBeDefined();
    expectNoCanary(events);
  });

  test("the scrubber is cleared when the run ends", async () => {
    const { sdk } = fakeSdk();
    const driver = driverOf(sdk);
    await collect(driver);
    // A second run without the secret source: the old value is not known.
    const { sdk: sdk2 } = fakeSdk({
      steps: [INIT(), { ...RESULT, result: CANARY }],
    });
    const events = await collect(
      driverOf(sdk2, {
        mcpServers: {
          docs: { type: "http", url: "http://127.0.0.1:1/" },
        },
      }),
    );
    expect(JSON.stringify(events)).toContain(CANARY);
  });
});

describe("output-scrub hook", () => {
  async function postToolUse(toolName: string, toolResponse: unknown) {
    let outputs: Record<string, unknown>[] = [];
    const { sdk } = fakeSdk({
      steps: [
        INIT(),
        async (options) => {
          outputs = await runHooks(options, "PostToolUse", {
            tool_name: toolName,
            tool_response: toolResponse,
          });
        },
        RESULT,
      ],
    });
    await collect(driverOf(sdk));
    return outputs;
  }

  test("a leaking result is rewritten for the model", async () => {
    const outputs = await postToolUse("mcp__docs__search", [
      { type: "text", text: `Authorization: Bearer ${CANARY}` },
    ]);
    expect(outputs).toHaveLength(1);
    const output = outputs[0]?.hookSpecificOutput as Record<string, unknown>;
    expect(output.hookEventName).toBe("PostToolUse");
    expect(output.updatedMCPToolOutput).toEqual([
      { type: "text", text: "Authorization: [redacted]" },
    ]);
    expect(output.updatedToolOutput).toEqual(output.updatedMCPToolOutput);
  });

  test("a CallToolResult and a string are scrubbed too", async () => {
    const [object] = await postToolUse("mcp__docs__search", {
      content: [{ type: "text", text: CANARY }],
      structuredContent: { token: CANARY },
    });
    expectNoCanary(object);
    const [text] = await postToolUse("mcp__docs__search", `x ${CANARY}`);
    expect(
      (text?.hookSpecificOutput as Record<string, unknown> | undefined)
        ?.updatedMCPToolOutput,
    ).toBe("x [redacted]");
  });

  test("a result without a secret is not rewritten", async () => {
    expect(
      await postToolUse("mcp__docs__search", [{ type: "text", text: "clean" }]),
    ).toEqual([{}]);
  });

  test("an unknown shape is withheld", async () => {
    const [output] = await postToolUse("mcp__docs__search", 42);
    expect(
      (output?.hookSpecificOutput as Record<string, unknown> | undefined)
        ?.updatedMCPToolOutput,
    ).toBe("[output withheld: unrecognized shape]");
  });

  test("it matches declared servers only", async () => {
    expect(
      await postToolUse("mcp__other__search", [{ type: "text", text: CANARY }]),
    ).toEqual([{}]);
    expect(await postToolUse("Read", CANARY)).toEqual([{}]);
  });
});

describe("guard and hooks", () => {
  async function preToolUse(
    toolName: string,
    config: Partial<ClaudeAgentSdkDriverConfig> = {},
    permissions: ExternalAgentPermissionPolicy = { mode: "workspace-write" },
  ) {
    let outputs: Record<string, unknown>[] = [];
    const { sdk, state } = fakeSdk({
      steps: [
        INIT(),
        async (options) => {
          outputs = await runHooks(options, "PreToolUse", {
            tool_name: toolName,
            tool_input: {},
          });
        },
        RESULT,
      ],
    });
    const events = await collect(
      driverOf(sdk, config),
      request({ permissions }),
    );
    return { outputs, events, options: state.options };
  }

  test("a listed tool of a declared server passes the hooks with the network off", async () => {
    const { outputs, events } = await preToolUse("mcp__docs__search");
    expect(denied(outputs)).toBe(false);
    expect(errorOf(events)).toBeUndefined();
  });

  test("an unlisted tool of a declared server is denied, the run goes on", async () => {
    const { outputs, events } = await preToolUse("mcp__docs__delete_all");
    expect(denied(outputs)).toBe(true);
    expect(errorOf(events)).toBeUndefined();
  });

  test("an undeclared MCP tool is denied and stops the run", async () => {
    const { outputs, events } = await preToolUse("mcp__other__search");
    expect(denied(outputs)).toBe(true);
    expect(errorOf(events)?.code).toBe(EXTERNAL_AGENT_ISOLATION_VIOLATED);
  });

  test("read-only admits only listed tools of a readOnly server", async () => {
    const readOnly = { mode: "read-only" } as const;
    expect(
      denied((await preToolUse("mcp__docs__search", {}, readOnly)).outputs),
    ).toBe(false);
    const writable = {
      mcpServers: { docs: { ...DOCS.docs, readOnly: false } },
    };
    expect(
      denied(
        (await preToolUse("mcp__docs__search", writable, readOnly)).outputs,
      ),
    ).toBe(true);
  });

  test("under inheritHostConfig the foreign-MCP hook admits the same set", async () => {
    const inherit = { inheritHostConfig: true } as const;
    const off = { mode: "workspace-write" } as const;
    expect(
      denied((await preToolUse("mcp__docs__search", inherit, off)).outputs),
    ).toBe(false);
    expect(
      denied((await preToolUse("mcp__docs__drop", inherit, off)).outputs),
    ).toBe(true);
    expect(
      denied((await preToolUse("mcp__hostsrv__x", inherit, off)).outputs),
    ).toBe(true);
    const writable = {
      ...inherit,
      mcpServers: { docs: { ...DOCS.docs, readOnly: false } },
    };
    expect(
      denied(
        (await preToolUse("mcp__docs__search", writable, { mode: "read-only" }))
          .outputs,
      ),
    ).toBe(true);
  });

  test("the permission callback denies an unlisted declared tool", async () => {
    let decision: { behavior: string } | undefined;
    const { sdk } = fakeSdk({
      steps: [
        INIT(),
        async (options) => {
          decision = await options.canUseTool?.(
            "mcp__docs__delete_all",
            {},
            { toolUseID: "t1", signal: new AbortController().signal },
          );
        },
        RESULT,
      ],
    });
    await collect(
      driverOf(sdk),
      request({ requestPermission: async () => ({ behavior: "allow" }) }),
    );
    expect(decision?.behavior).toBe("deny");
  });

  test("declared tools are never pre-approved", async () => {
    const { options } = await preToolUse("mcp__docs__search");
    const allowed = (options?.allowedTools ?? []) as string[];
    expect(allowed.some((name) => name.startsWith("mcp__docs__"))).toBe(false);
  });

  test("declaredMcpServers() gives the guard names, tools and readOnly only", () => {
    expect(driverOf(fakeSdk().sdk).declaredMcpServers()).toEqual([
      { name: "docs", tools: ["search", "read_page"], readOnly: true },
    ]);
    expect(new ClaudeAgentSdkDriver().declaredMcpServers()).toEqual([]);
  });

  test("the guard: network off admits listed declared tools only", () => {
    const declaredMcpServers = [
      { name: "docs", tools: ["search"], readOnly: true },
      { name: "open", readOnly: false },
    ];
    const guard = (toolName: string, policy: ExternalAgentPermissionPolicy) =>
      guardPermissionRequest(
        policy,
        { requestId: "r", toolName, input: {} } as never,
        { declaredMcpServers },
      )?.behavior;
    const off = { mode: "workspace-write" } as const;
    expect(guard("mcp__docs__search", off)).toBeUndefined();
    expect(guard("mcp__open__anything", off)).toBeUndefined();
    expect(guard("mcp__docs__drop", off)).toBe("deny");
    expect(guard("mcp__other__x", off)).toBe("deny");
    expect(guard("mcp__docs__", off)).toBe("deny");
    const on = { mode: "workspace-write", allowNetwork: true } as const;
    expect(guard("mcp__docs__drop", on)).toBe("deny");
    expect(guard("mcp__other__x", on)).toBeUndefined();
    const ro = { mode: "read-only" } as const;
    expect(guard("mcp__docs__search", ro)).toBeUndefined();
    expect(guard("mcp__open__anything", ro)).toBe("deny");
    expect(guard("mcp__docs__drop", ro)).toBe("deny");
  });
});

describe("MCP calls in events", () => {
  test("tool_call and tool_result carry metadata.mcp; the result its duration", async () => {
    const { sdk } = fakeSdk({
      steps: [
        INIT(),
        toolUse("mcp__docs__search", "toolu_1", { q: "x" }),
        async () => {
          await new Promise((resolveWait) => setTimeout(resolveWait, 5));
        },
        toolResult("toolu_1", [{ type: "text", text: "found" }]),
        RESULT,
      ],
    });
    const events = await collect(driverOf(sdk));
    const call = events.find((event) => event.type === "tool_call");
    const result = events.find((event) => event.type === "tool_result");
    expect(call?.metadata?.mcp).toEqual({ server: "docs", tool: "search" });
    expect(result?.metadata?.mcp).toEqual({ server: "docs", tool: "search" });
    expect(result?.metadata?.durationMs).toBeGreaterThanOrEqual(1);
    expect(call?.metadata).not.toHaveProperty("durationMs");
    // No server config on events.
    expect(JSON.stringify(events)).not.toContain("127.0.0.1");
  });

  test("the longest known server name wins; an unknown prefix gets none", () => {
    const context = {
      servers: new Set(["docs", "docs_v2"]),
      started: new Map<string, number>(),
    };
    const content = (name: string, id: string) => [
      { type: "tool_use", id, name, input: {} },
    ];
    const names = new Map<string, string>();
    const meta = (events: readonly unknown[]) =>
      (events[0] as { metadata?: Record<string, unknown> } | undefined)
        ?.metadata;
    const use = (name: string, id: string) =>
      meta(toolUseEvents(content(name, id), names, null, context));
    expect(use("mcp__docs_v2__q", "a")?.mcp).toEqual({
      server: "docs_v2",
      tool: "q",
    });
    expect(use("mcp__docs__v2__q", "b")?.mcp).toEqual({
      server: "docs",
      tool: "v2__q",
    });
    expect(use("mcp__zzz__q", "c")).not.toHaveProperty("mcp");
    expect(use("Read", "d")).not.toHaveProperty("mcp");
    const result = meta(
      toolResultEvents(
        [{ type: "tool_result", tool_use_id: "a", content: "ok" }],
        names,
        null,
        context,
      ),
    );
    expect(result?.mcp).toEqual({ server: "docs_v2", tool: "q" });
    expect(typeof result?.durationMs).toBe("number");
    // Servers listed by system/init may contain "__": the longest wins.
    const nested = {
      servers: new Set(["docs", "docs__v2"]),
      started: new Map<string, number>(),
    };
    expect(
      meta(toolUseEvents(content("mcp__docs__v2__q", "f"), names, null, nested))
        ?.mcp,
    ).toEqual({ server: "docs__v2", tool: "q" });
    // Without a context the shared helpers behave as before.
    expect(
      meta(toolUseEvents(content("mcp__docs__q", "e"), new Map(), null)),
    ).toEqual({ builtin: true });
  });

  test("servers listed in system/init are known for inherited runs", async () => {
    const { sdk } = fakeSdk({
      steps: [
        INIT(["hostsrv"]),
        toolUse("mcp__hostsrv__search", "toolu_9"),
        toolResult("toolu_9", "ok"),
        RESULT,
      ],
    });
    const events = await collect(
      new ClaudeAgentSdkDriver({
        sdk: sdk as never,
        env: { PATH: process.env.PATH },
        inheritHostConfig: true,
      }),
      request({ permissions: { mode: "workspace-write", allowNetwork: true } }),
    );
    const call = events.find((event) => event.type === "tool_call");
    expect(call?.metadata?.mcp).toEqual({ server: "hostsrv", tool: "search" });
  });
});

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

describe("a declared secret keeps large tool results off disk", () => {
  const UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const counting = () => {
    const calls = { n: 0 };
    return {
      calls,
      servers: {
        docs: {
          ...DOCS.docs,
          headers: {
            Authorization: {
              resolve: () => {
                calls.n++;
                return CANARY;
              },
            },
          },
        },
      },
    };
  };

  test("the run picks a session id, reserves its path, and releases it", async () => {
    let during: { isFile: boolean; mode: number } | undefined;
    const { sdk, state } = fakeSdk({
      steps: [
        INIT(),
        (options) => {
          const stats = lstatSync(join(PROJECT_DIR, String(options.sessionId)));
          during = { isFile: stats.isFile(), mode: stats.mode & 0o777 };
        },
        RESULT,
      ],
    });
    const events = await collect(driverOf(sdk));
    expect(errorOf(events)).toBeUndefined();
    const sid = String(state.options?.sessionId);
    expect(sid).toMatch(UUID);
    expect(during).toEqual({ isFile: true, mode: 0o400 });
    expect(existsSync(join(PROJECT_DIR, sid))).toBe(false);
  });

  test("two runs use two session ids", async () => {
    const first = fakeSdk();
    const second = fakeSdk();
    await collect(driverOf(first.sdk));
    await collect(driverOf(second.sdk));
    expect(first.state.options?.sessionId).not.toBe(
      second.state.options?.sessionId,
    );
  });

  test("the child env turns MCP large-output files off", async () => {
    const { sdk, state } = fakeSdk();
    await collect(driverOf(sdk));
    expect(
      (state.options?.env as Record<string, string> | undefined)
        ?.ENABLE_MCP_LARGE_OUTPUT_FILES,
    ).toBe("0");
  });

  test("without a secret: no session id, no env flag, nothing reserved", async () => {
    const { sdk, state } = fakeSdk();
    await collect(
      driverOf(sdk, {
        mcpServers: {
          docs: {
            type: "http",
            url: "http://127.0.0.1:7801/mcp",
            headers: { Accept: { public: "application/json" } },
          },
        },
      }),
    );
    expect(state.options).not.toHaveProperty("sessionId");
    expect(state.options?.env).not.toHaveProperty(
      "ENABLE_MCP_LARGE_OUTPUT_FILES",
    );
  });

  test("a config dir that cannot hold the path: refused before any resolver", async () => {
    const bad = join(ROOT, "bad-config");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "projects"), "");
    const { calls, servers } = counting();
    const { sdk, state } = fakeSdk();
    const events = await collect(
      driverOf(sdk, { mcpServers: servers, env: { CLAUDE_CONFIG_DIR: bad } }),
    );
    expect(errorOf(events)?.code).toBe(EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE);
    expect(errorOf(events)?.message).toContain("could not reserve");
    expect(calls.n).toBe(0);
    expect(state.options).toBeUndefined();
  });

  test("a config dir that is not absolute: refused", async () => {
    const { sdk } = fakeSdk();
    const events = await collect(
      driverOf(sdk, { env: { CLAUDE_CONFIG_DIR: "relative/config" } }),
    );
    expect(errorOf(events)?.code).toBe(EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE);
    expect(errorOf(events)?.message).toContain("not an absolute path");
  });

  test("a working directory whose project key Claude Code would hash: refused", async () => {
    const deep = join(ROOT, "d".repeat(100), "e".repeat(100));
    mkdirSync(deep, { recursive: true });
    const { calls, servers } = counting();
    const { sdk } = fakeSdk();
    const events = await collect(
      driverOf(sdk, { mcpServers: servers }),
      request({ workingDirectory: deep }),
    );
    expect(errorOf(events)?.code).toBe(EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE);
    expect(errorOf(events)?.message).toContain("longer than 200");
    expect(calls.n).toBe(0);
  });

  test("a runtime that reports another session id ends the run", async () => {
    const { sdk } = fakeSdk({
      steps: [{ ...INIT(), session_id: "not-ours" }, RESULT],
    });
    const events = await collect(driverOf(sdk));
    expect(errorOf(events)?.code).toBe(EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE);
    expect(errorOf(events)?.message).toContain("did not use the session");
    expect(
      events.some(
        (event) =>
          event.type === "completed" &&
          (event as { exitCode?: number }).exitCode === 0,
      ),
    ).toBe(false);
  });

  test("a tool call from another session is denied first and ends the run", async () => {
    let outputs: Record<string, unknown>[] = [];
    let first: Record<string, unknown> | undefined;
    const { sdk } = fakeSdk({
      steps: [
        INIT(),
        async (options) => {
          outputs = await runHooks(options, "PreToolUse", {
            tool_name: "Read",
            tool_input: { file_path: join(WORK, "a.txt") },
            session_id: "other-session",
          });
          first = outputs[0];
        },
        toolUse("Read", "toolu_1"),
        RESULT,
      ],
    });
    const events = await collect(driverOf(sdk));
    expect(denied(outputs)).toBe(true);
    expect(
      (first?.hookSpecificOutput as Record<string, unknown>)
        ?.permissionDecision,
    ).toBe("deny");
    expect(errorOf(events)?.code).toBe(EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE);
  });

  test("a tool call whose transcript lies in another project folder is denied", async () => {
    let outputs: Record<string, unknown>[] = [];
    const { sdk } = fakeSdk({
      steps: [
        INIT(),
        async (options) => {
          outputs = await runHooks(options, "PreToolUse", {
            tool_name: "Read",
            tool_input: { file_path: join(WORK, "a.txt") },
            transcript_path: join(
              ROOT,
              "elsewhere",
              `${String(options.sessionId)}.jsonl`,
            ),
          });
        },
        RESULT,
      ],
    });
    const events = await collect(driverOf(sdk));
    expect(denied(outputs)).toBe(true);
    expect(errorOf(events)?.code).toBe(EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE);
  });

  test("a tool call from the reserved session passes the guard", async () => {
    let outputs: Record<string, unknown>[] = [];
    const { sdk } = fakeSdk({
      steps: [
        INIT(),
        async (options) => {
          outputs = await runHooks(options, "PreToolUse", {
            tool_name: "Read",
            tool_input: { file_path: join(WORK, "a.txt") },
          });
        },
        RESULT,
      ],
    });
    const events = await collect(driverOf(sdk));
    expect(denied(outputs)).toBe(false);
    expect(errorOf(events)).toBeUndefined();
  });

  test("the reservation is released when the run fails", async () => {
    let sid: unknown;
    const { sdk } = fakeSdk({
      steps: [
        (options) => {
          sid = options.sessionId;
          throw new Error("boom");
        },
      ],
    });
    const events = await collect(driverOf(sdk));
    expect(errorOf(events)).toBeDefined();
    expect(existsSync(join(PROJECT_DIR, String(sid)))).toBe(false);
  });
});

describe("the reservation is re-checked during and after the run", () => {
  const reserved = (options: Options) =>
    join(PROJECT_DIR, String(options.sessionId));
  const preToolUse = (options: Options) =>
    runHooks(options, "PreToolUse", {
      tool_name: "mcp__docs__search",
      tool_input: { q: "x" },
    });
  const noCleanCompletion = (events: ExternalAgentEvent[]) =>
    !events.some(
      (event) =>
        event.type === "completed" &&
        (event as { exitCode?: number }).exitCode === 0,
    );

  test("a removed reservation denies the next tool call and ends the run", async () => {
    let before: Record<string, unknown>[] = [];
    let after: Record<string, unknown>[] = [];
    const { sdk } = fakeSdk({
      steps: [
        INIT(),
        async (options) => {
          before = await preToolUse(options);
        },
        async (options) => {
          rmSync(reserved(options));
          after = await preToolUse(options);
        },
        toolUse("mcp__docs__search", "toolu_1"),
        RESULT,
      ],
    });
    const events = await collect(driverOf(sdk));
    expect(denied(before)).toBe(false);
    expect(denied(after)).toBe(true);
    expect(errorOf(events)?.code).toBe(EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE);
    expect(errorOf(events)?.message).toContain("reserved");
    expect(noCleanCompletion(events)).toBe(true);
  });

  test("the guard denies even before the stream sees another message", async () => {
    // Parallel batch: both calls ask PreToolUse before either message arrives.
    let outputs: Record<string, unknown>[] = [];
    const { sdk } = fakeSdk({
      steps: [
        INIT(),
        async (options) => {
          rmSync(reserved(options));
          outputs = await preToolUse(options);
        },
        RESULT,
      ],
    });
    await collect(driverOf(sdk));
    expect(denied(outputs)).toBe(true);
  });

  test("a folder in its place is denied, reported, scrubbed and kept", async () => {
    let dir = "";
    let outputs: Record<string, unknown>[] = [];
    const { sdk } = fakeSdk({
      steps: [
        INIT(),
        async (options) => {
          rmSync(reserved(options));
          dir = join(reserved(options), "tool-results");
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "mcp-docs-search-1.txt"), `echo ${CANARY}`);
          outputs = await preToolUse(options);
        },
        RESULT,
      ],
    });
    const events = await collect(driverOf(sdk));
    expect(denied(outputs)).toBe(true);
    const errors = events.filter((event) => event.type === "error") as Array<
      ExternalAgentEvent & { code?: string; message: string }
    >;
    expect(
      errors.every(
        (event) => event.code === EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE,
      ),
    ).toBe(true);
    const report = errors.find((event) => event.message.includes("folder"));
    expect(report?.message).toContain("1 of 1 files");
    expect(report?.message).toContain(dir.slice(0, dir.lastIndexOf("/")));
    expect(readFileSync(join(dir, "mcp-docs-search-1.txt"), "utf8")).toBe(
      "echo [redacted]",
    );
    expect(existsSync(dir)).toBe(true);
    expectNoCanary(events);
    rmSync(dir.slice(0, dir.lastIndexOf("/")), { recursive: true });
  });

  test("a reservation lost after the last tool call fails the run", async () => {
    const { sdk } = fakeSdk({
      steps: [
        INIT(),
        (options) => {
          rmSync(reserved(options));
        },
        RESULT,
      ],
    });
    const events = await collect(driverOf(sdk));
    expect(errorOf(events)?.code).toBe(EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE);
    expect(noCleanCompletion(events)).toBe(true);
  });

  test("a reservation lost after the result message still reports it", async () => {
    // The end-of-run check: nothing reads another message after the result.
    let path = "";
    const { sdk } = fakeSdk({
      steps: [
        INIT(),
        (options) => {
          path = reserved(options);
        },
        RESULT,
      ],
    });
    const wrapped = {
      ...sdk,
      query: (input: { prompt: unknown; options: Options }) => {
        const query = sdk.query(input);
        const done = query.return.bind(query);
        return Object.assign(query, {
          return: async (value: unknown) => {
            rmSync(path, { force: true });
            return done(value as never);
          },
        });
      },
    };
    const events = await collect(driverOf(wrapped));
    const last = events.at(-1) as ExternalAgentEvent & { code?: string };
    expect(last.type).toBe("error");
    expect(last.code).toBe(EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE);
  });

  test("the reservation outlives the subprocess teardown", async () => {
    let path = "";
    const seen: boolean[] = [];
    const { sdk } = fakeSdk({
      steps: [
        INIT(),
        (options) => {
          path = reserved(options);
        },
        RESULT,
      ],
    });
    const wrapped = {
      ...sdk,
      query: (input: { prompt: unknown; options: Options }) => {
        const query = sdk.query(input);
        const done = query.return.bind(query);
        return Object.assign(query, {
          return: async (value: unknown) => {
            seen.push(existsSync(path));
            return done(value as never);
          },
        });
      },
    };
    const events = await collect(driverOf(wrapped));
    expect(errorOf(events)).toBeUndefined();
    expect(seen).toEqual([true]);
    expect(existsSync(path)).toBe(false);
  });
});

describe("a declared secret keeps the transcript off disk", () => {
  const PUBLIC_ONLY = {
    docs: {
      type: "http" as const,
      url: "http://127.0.0.1:7801/mcp",
      headers: { Accept: { public: "application/json" } },
    },
  };
  const store = { append: async () => undefined, load: async () => null };

  test("persistSession is false with a { resolve } secret, and with { env }", async () => {
    const { sdk, state } = fakeSdk();
    await collect(driverOf(sdk));
    expect(state.options?.persistSession).toBe(false);
    expect(state.options?.resume).toBeUndefined();
    expect(driverOf(sdk).buildOptions(request()).persistSession).toBe(false);
    const envServer = {
      docs: {
        type: "http" as const,
        url: "http://127.0.0.1:7801/mcp",
        headers: { Authorization: { env: "HOSTMCP_TOKEN_X" } },
      },
    };
    expect(
      driverOf(sdk, { mcpServers: envServer }).buildOptions(request())
        .persistSession,
    ).toBe(false);
  });

  test("without a secret the SDK default stays (key absent)", () => {
    const { sdk } = fakeSdk();
    const options = driverOf(sdk, { mcpServers: PUBLIC_ONLY }).buildOptions(
      request(),
    );
    expect(options).not.toHaveProperty("persistSession");
    expect(
      driverOf(sdk, { mcpServers: {} }).buildOptions(request()),
    ).not.toHaveProperty("persistSession");
  });

  test("the session id is neither saved in state nor resumed on the next turn", async () => {
    const { sdk, state } = fakeSdk();
    const driver = driverOf(sdk);
    const stateKey = claudeSdkSessionStateKey("docs-agent");
    const turn = (persisted?: string) =>
      request({
        agent: { name: "docs-agent" } as never,
        context: {
          input: "find the docs",
          session: {
            id: "adk-1",
            state: persisted ? { [stateKey]: persisted } : {},
          },
        } as never,
      });
    const first = await collect(driver, turn());
    expect(first.some((event) => event.type === "state_delta")).toBe(false);
    await collect(driver, turn("s-old"));
    expect(state.options?.resume).toBeUndefined();
    expect(state.options?.persistSession).toBe(false);
  });

  test("the constructor refuses sessionStore and resumeSessionId with a secret", () => {
    const { sdk } = fakeSdk();
    for (const extra of [
      { sessionStore: store as never },
      { resumeSessionId: "s-1" },
    ]) {
      let code: string | undefined;
      try {
        driverOf(sdk, extra);
      } catch (error) {
        expect(error).toBeInstanceOf(ExternalAgentPolicyError);
        code = (error as ExternalAgentPolicyError).code;
        expectNoCanary((error as Error).message);
      }
      expect(code).toBe(EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE);
    }
  });

  test("both stay allowed without a secret", () => {
    const { sdk } = fakeSdk();
    expect(() =>
      driverOf(sdk, { mcpServers: PUBLIC_ONLY, sessionStore: store as never }),
    ).not.toThrow();
    expect(() =>
      driverOf(sdk, { mcpServers: PUBLIC_ONLY, resumeSessionId: "s-1" }),
    ).not.toThrow();
  });

  test("runtimeSession.id is refused at run time before any secret is read", async () => {
    let reads = 0;
    const { sdk, state } = fakeSdk();
    const driver = driverOf(sdk, {
      mcpServers: {
        docs: {
          ...DOCS.docs,
          headers: {
            Authorization: {
              resolve: () => {
                reads++;
                return CANARY;
              },
            },
          },
        },
      },
    });
    const events = await collect(
      driver,
      request({ runtimeSession: { id: "s-1" } } as never),
    );
    expect(errorOf(events)?.code).toBe(EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE);
    expect(reads).toBe(0);
    expect(state.options).toBeUndefined();
  });
});
