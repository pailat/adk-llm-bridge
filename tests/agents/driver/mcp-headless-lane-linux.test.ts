/**
 * Conformance of the two recipes in docs/mcp-headless-lane.md, on Linux
 * with a shell offered, against a fake HTTP MCP server on loopback.
 *
 * The SDK is scripted: when the driver hands it the servers through
 * `setMcpServers`, it connects to each declared http server the way the
 * runtime would (JSON-RPC `initialize`, then `tools/call`) with exactly the
 * URL and headers it was given. So the tests see what reaches the server,
 * what reaches the runtime's options, and which run modes stay on.
 *
 * - Token recipe: a `{ resolve }` header. Needs `ptrace_scope >= 1` with a
 *   shell, keeps no transcript, resumes nothing, truncates large MCP results.
 * - Loopback-proxy recipe: a host proxy on `127.0.0.1` adds the header; the
 *   entry carries no secret, runs with the network off, and keeps resume and
 *   the session store.
 *
 * Skipped on other platforms; the Linux gate runs them.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  ClaudeAgentSdkDriver,
  type ClaudeAgentSdkDriverConfig,
} from "../../../src/agents/driver/claude-agent-sdk.js";
import {
  type ClaudeMcpServer,
  selectMcpServers,
} from "../../../src/agents/driver/claude-mcp-servers.js";
import { mcpSecretHost } from "../../../src/agents/driver/mcp-secrets.js";
import {
  EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE,
  ExternalAgentPolicyError,
} from "../../../src/agents/driver/policy-errors.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import type { ExternalAgentRunRequest } from "../../../src/agents/external-agent-driver.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/schema.js";

const LINUX = process.platform === "linux";

/** The machine token only the host holds. Fictional. */
const MACHINE_TOKEN = "acme-machine-token-7c41d0e9";

// Next to this file, not in the temp directory, which a runtime sandbox
// keeps writable and the driver therefore refuses.
const ROOT = LINUX
  ? realpathSync.native(
      mkdtempSync(join(import.meta.dir, ".host-scratch-mcp-lane-")),
    )
  : "";
const WORK = join(ROOT, "repo");
const CONFIG = join(ROOT, "config");
if (LINUX) mkdirSync(WORK);
afterAll(() => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
});

interface Seen {
  authorization: string | null;
  method: string;
}

/**
 * A fake streamable-HTTP MCP server with one tool, `timeline_get`. It
 * records every request's `Authorization` header and refuses a request
 * without `Bearer <MACHINE_TOKEN>` with 401, as the real server does.
 */
function fakeMcpServer() {
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as {
        id: number;
        method: string;
      };
      const authorization = req.headers.get("authorization");
      seen.push({ authorization, method: body.method });
      if (authorization !== `Bearer ${MACHINE_TOKEN}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const result =
        body.method === "initialize"
          ? {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "acme-fake", version: "1.0.0" },
            }
          : { content: [{ type: "text", text: "timeline of Acme Rollout" }] };
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    },
  });
  return { seen, server, url: `http://127.0.0.1:${server.port}/mcp` };
}

/**
 * The host-owned loopback proxy of the second recipe: it forwards each
 * request to the upstream server and adds the machine token itself. The
 * agent's entry names only the proxy.
 */
function loopbackProxy(upstream: string) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = await req.text();
      seen.push({
        authorization: req.headers.get("authorization"),
        method: (JSON.parse(body) as { method: string }).method,
      });
      return fetch(upstream, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${MACHINE_TOKEN}`,
        },
        body,
      });
    },
  });
  return { seen, server, url: `http://127.0.0.1:${server.port}/mcp` };
}

type Options = Record<string, unknown>;

/**
 * A scripted SDK: `setMcpServers` connects to every declared http server
 * with the URL and headers it received, then the stream reports the
 * server connected and the tool result, and ends.
 */
function connectingSdk() {
  const state: {
    options?: Options;
    payload?: Record<string, Record<string, unknown>>;
    replies: Array<{ status: number; text: string }>;
  } = { replies: [] };
  let connected = false;
  const call = async (
    server: Record<string, unknown>,
    id: number,
    method: string,
  ) => {
    const response = await fetch(server.url as string, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(server.headers as Record<string, string> | undefined),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: {} }),
    });
    state.replies.push({
      status: response.status,
      text: await response.text(),
    });
    return response.ok;
  };
  const sdk = {
    query: (input: { prompt: unknown; options: Options }) => {
      state.options = input.options;
      const sid = (input.options.sessionId as string | undefined) ?? "s-acme";
      const stream = (async function* () {
        if (typeof input.prompt !== "string") {
          for await (const _ of input.prompt as AsyncIterable<unknown>) {
            // The runtime reads the user message before it answers.
          }
        }
        yield {
          type: "system",
          subtype: "init",
          model: "claude-haiku-5-5",
          session_id: sid,
          tools: ["Bash", "mcp__pai__timeline_get"],
          mcp_servers: [{ name: "pai", status: "connected" }],
        };
        yield {
          type: "result",
          subtype: "success",
          result: "done",
          session_id: sid,
        };
      })();
      return Object.assign(stream, {
        setMcpServers: async (
          servers: Record<string, Record<string, unknown>>,
        ) => {
          state.payload = servers;
          for (const [name, server] of Object.entries(servers)) {
            if (name === "adk_bridge" || server.type !== "http") continue;
            connected =
              (await call(server, 1, "initialize")) &&
              (await call(server, 2, "tools/call"));
          }
          return { added: Object.keys(servers), removed: [], errors: {} };
        },
        mcpServerStatus: async () => [
          { name: "pai", status: connected ? "connected" : "failed" },
        ],
        interrupt: async () => {},
      });
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

/** A lane's agent: `mcp: ["pai"]` resolved from the host's registry. */
function laneDriver(
  sdk: unknown,
  registry: Record<string, ClaudeMcpServer>,
  extra: Partial<ClaudeAgentSdkDriverConfig> = {},
): ClaudeAgentSdkDriver {
  return new ClaudeAgentSdkDriver({
    sdk: sdk as never,
    tools: ["Bash", "Read"],
    mcpServers: selectMcpServers(["pai"], registry),
    requiredMcpServers: ["pai"],
    ...extra,
    env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: CONFIG },
  });
}

function laneRequest(
  extra: Partial<ExternalAgentRunRequest> = {},
): ExternalAgentRunRequest {
  return {
    provider: CLAUDE_PROVIDER,
    context: { input: "read the Acme Rollout timeline" } as never,
    workingDirectory: WORK,
    permissions: { mode: "workspace-write", allowNetwork: false },
    ...extra,
  } as ExternalAgentRunRequest;
}

async function collect(
  driver: ClaudeAgentSdkDriver,
  req: ExternalAgentRunRequest = laneRequest(),
): Promise<ExternalAgentEvent[]> {
  const events: ExternalAgentEvent[] = [];
  for await (const event of driver.run(req)) events.push(event);
  return events;
}

const errorOf = (events: ExternalAgentEvent[]) =>
  events.find((event) => event.type === "error") as
    | (ExternalAgentEvent & { code?: string; message: string })
    | undefined;

const savedHost = { ...mcpSecretHost };
beforeEach(() => {
  // The real platform: these tests run on Linux only.
  mcpSecretHost.platform = () => "linux";
});
afterEach(() => {
  Object.assign(mcpSecretHost, savedHost);
});

describe.skipIf(!LINUX)(
  "token recipe: { resolve } header on Linux with a shell",
  () => {
    let upstream: ReturnType<typeof fakeMcpServer>;
    beforeAll(() => {
      upstream = fakeMcpServer();
    });
    afterAll(() => {
      upstream.server.stop(true);
    });
    const registry = (): Record<string, ClaudeMcpServer> => ({
      pai: {
        type: "http",
        url: upstream.url,
        headers: {
          Authorization: { resolve: () => MACHINE_TOKEN, prefix: "Bearer " },
        },
        tools: ["timeline_get"],
        readOnly: true,
      },
    });

    test("ptrace_scope 1: the server gets the token, the agent's options never do", async () => {
      mcpSecretHost.readPtraceScope = () => "1";
      upstream.seen.length = 0;
      const { sdk, state } = connectingSdk();
      const events = await collect(laneDriver(sdk, registry()));
      expect(errorOf(events)).toBeUndefined();
      expect(upstream.seen.map((s) => s.method)).toEqual([
        "initialize",
        "tools/call",
      ]);
      expect(
        upstream.seen.every(
          (s) => s.authorization === `Bearer ${MACHINE_TOKEN}`,
        ),
      ).toBe(true);
      expect(state.replies.map((r) => r.status)).toEqual([200, 200]);
      expect(JSON.stringify(state.options)).not.toContain(MACHINE_TOKEN);
      expect(JSON.stringify(events)).not.toContain(MACHINE_TOKEN);
    });

    test("ptrace_scope 0 or missing: refused before the token is read or the server is contacted", async () => {
      for (const scope of ["0", undefined]) {
        mcpSecretHost.readPtraceScope = () => scope;
        upstream.seen.length = 0;
        let reads = 0;
        const { sdk, state } = connectingSdk();
        const events = await collect(
          laneDriver(sdk, {
            pai: {
              ...(registry().pai as ClaudeMcpServer & { type: "http" }),
              headers: {
                Authorization: {
                  resolve: () => {
                    reads++;
                    return MACHINE_TOKEN;
                  },
                  prefix: "Bearer ",
                },
              },
            },
          }),
        );
        expect(errorOf(events)?.code).toBe(
          EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE,
        );
        expect(errorOf(events)?.message).toContain("ptrace_scope");
        expect(reads).toBe(0);
        expect(upstream.seen).toEqual([]);
        expect(state.options).toBeUndefined();
      }
    });

    test("the host's real ptrace_scope decides, as the recipe's precheck says", async () => {
      mcpSecretHost.readPtraceScope = savedHost.readPtraceScope;
      const scope = savedHost.readPtraceScope();
      const { sdk } = connectingSdk();
      const code = errorOf(await collect(laneDriver(sdk, registry())))?.code;
      if (scope === undefined || scope === "0") {
        expect(code).toBe(EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE);
      } else {
        expect(code).toBeUndefined();
      }
    });

    test("no transcript, no resume, no session store; large MCP results stay inline", async () => {
      mcpSecretHost.readPtraceScope = () => "1";
      const { sdk, state } = connectingSdk();
      await collect(laneDriver(sdk, registry()));
      expect(state.options?.persistSession).toBe(false);
      expect(state.options?.resume).toBeUndefined();
      const env = state.options?.env as Record<string, string | undefined>;
      expect(env.ENABLE_MCP_LARGE_OUTPUT_FILES).toBe("0");
      const store = { append: async () => undefined, load: async () => null };
      for (const extra of [
        { sessionStore: store as never },
        { resumeSessionId: "s-acme" },
      ]) {
        let code: string | undefined;
        try {
          laneDriver(sdk, registry(), extra);
        } catch (error) {
          expect(error).toBeInstanceOf(ExternalAgentPolicyError);
          code = (error as ExternalAgentPolicyError).code;
        }
        expect(code).toBe(EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE);
      }
    });
  },
);

describe.skipIf(!LINUX)(
  "loopback-proxy recipe: no secret, network off, resume on",
  () => {
    let upstream: ReturnType<typeof fakeMcpServer>;
    let proxy: ReturnType<typeof loopbackProxy>;
    beforeAll(() => {
      upstream = fakeMcpServer();
      proxy = loopbackProxy(upstream.url);
    });
    afterAll(() => {
      proxy.server.stop(true);
      upstream.server.stop(true);
    });
    const registry = (): Record<string, ClaudeMcpServer> => ({
      pai: {
        type: "http",
        url: proxy.url,
        tools: ["timeline_get"],
        readOnly: true,
      },
    });
    const store = { append: async () => undefined, load: async () => null };

    test("the entry is http://127.0.0.1:<port> with no header at all", () => {
      const entry = selectMcpServers(["pai"], registry()).pai as {
        url: string;
        headers?: unknown;
      };
      expect(entry.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      expect(entry.headers).toBeUndefined();
    });

    test("allowNetwork false with a shell: the proxy adds the token, the agent never holds it", async () => {
      // No secret is declared, so ptrace_scope does not matter.
      mcpSecretHost.readPtraceScope = () => "0";
      upstream.seen.length = 0;
      proxy.seen.length = 0;
      const { sdk, state } = connectingSdk();
      const events = await collect(laneDriver(sdk, registry()));
      expect(errorOf(events)).toBeUndefined();
      expect(proxy.seen.map((s) => s.authorization)).toEqual([null, null]);
      expect(upstream.seen.map((s) => s.authorization)).toEqual([
        `Bearer ${MACHINE_TOKEN}`,
        `Bearer ${MACHINE_TOKEN}`,
      ]);
      expect(state.replies.map((r) => r.status)).toEqual([200, 200]);
      expect(state.replies[1]?.text).toContain("Acme Rollout");
      expect(JSON.stringify(state.payload)).not.toContain(MACHINE_TOKEN);
      expect(JSON.stringify(state.options)).not.toContain(MACHINE_TOKEN);
    });

    test("resume and the session store stay on; large results are not forced inline", async () => {
      const { sdk, state } = connectingSdk();
      const driver = laneDriver(sdk, registry(), {
        sessionStore: store as never,
        resumeSessionId: "s-acme",
      });
      const events = await collect(driver);
      expect(errorOf(events)).toBeUndefined();
      expect(state.options?.resume).toBe("s-acme");
      expect(state.options?.sessionStore).toBe(store);
      expect(state.options).not.toHaveProperty("persistSession");
      const env = state.options?.env as Record<string, string | undefined>;
      expect(env.ENABLE_MCP_LARGE_OUTPUT_FILES).toBeUndefined();
    });

    test("a run-time runtimeSession.id is accepted too", async () => {
      const { sdk, state } = connectingSdk();
      const events = await collect(
        laneDriver(sdk, registry()),
        laneRequest({ runtimeSession: { id: "s-acme-2" } } as never),
      );
      expect(errorOf(events)).toBeUndefined();
      expect(state.options?.resume).toBe("s-acme-2");
    });

    test("without the proxy the server refuses the agent: the token is the proxy's job", async () => {
      upstream.seen.length = 0;
      const { sdk, state } = connectingSdk();
      const events = await collect(
        laneDriver(sdk, {
          pai: { type: "http", url: upstream.url, tools: ["timeline_get"] },
        }),
      );
      expect(upstream.seen.map((s) => s.authorization)).toEqual([null]);
      expect(state.replies.map((r) => r.status)).toEqual([401]);
      expect(errorOf(events)).toBeDefined();
    });
  },
);
