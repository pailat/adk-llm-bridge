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
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  ClaudeAgentSdkDriver,
  type ClaudeAgentSdkDriverConfig,
} from "../../../src/agents/driver/claude-agent-sdk.js";
import { CLAUDE_NO_NETWORK_SANDBOX } from "../../../src/agents/driver/claude-isolation.js";
import {
  type ClaudeMcpServer,
  selectMcpServers,
} from "../../../src/agents/driver/claude-mcp-servers.js";
import { mcpSecretHost } from "../../../src/agents/driver/mcp-secrets.js";
import {
  EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE,
  EXTERNAL_AGENT_NETWORK_UNENFORCEABLE,
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
  /** The JSON-RPC method of a POST, else the HTTP method. */
  method: string;
  path: string;
}

interface FakeOptions {
  /** Gzip every JSON answer, with `content-encoding: gzip`. */
  gzip?: boolean;
  /** Wait this long before answering a POST. */
  delayMs?: number;
  /** Keep a GET's SSE stream quiet this long between its two events. */
  sseGapMs?: number;
  /** Answer every request with `302 Location: <redirectTo>`. */
  redirectTo?: string;
}

/**
 * A fake streamable-HTTP MCP server with one tool, `timeline_get`. It
 * records every request's `Authorization` header and refuses a request
 * without `Bearer <MACHINE_TOKEN>` with 401, as the real server does. A
 * GET opens an SSE stream (one event), a DELETE ends the session.
 */
function fakeMcpServer(options: FakeOptions = {}) {
  const seen: Seen[] = [];
  /** POSTs whose caller went away while the answer was still delayed. */
  const aborted = { count: 0 };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // The fake never cuts a slow answer itself; the proxy is under test.
    idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const authorization = req.headers.get("authorization");
      const authorized = authorization === `Bearer ${MACHINE_TOKEN}`;
      if (options.redirectTo) {
        seen.push({ authorization, method: req.method, path });
        return new Response(null, {
          status: 302,
          headers: { location: options.redirectTo },
        });
      }
      if (req.method !== "POST") {
        seen.push({ authorization, method: req.method, path });
        if (!authorized) return new Response("unauthorized", { status: 401 });
        if (req.method === "GET") {
          const gap = options.sseGapMs ?? 0;
          const stream = new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode(": open\n\n"));
              await Bun.sleep(gap);
              controller.enqueue(
                new TextEncoder().encode("event: message\ndata: {}\n\n"),
              );
              controller.close();
            },
          });
          return new Response(stream, {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response(null, { status: 202 });
      }
      const body = (await req.json()) as {
        id: number;
        method: string;
      };
      seen.push({ authorization, method: body.method, path });
      if (!authorized) return new Response("unauthorized", { status: 401 });
      if (options.delayMs) {
        let pending = true;
        req.signal.addEventListener("abort", () => {
          if (pending) aborted.count++;
        });
        await Bun.sleep(options.delayMs);
        pending = false;
      }
      const result =
        body.method === "initialize"
          ? {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "acme-fake", version: "1.0.0" },
            }
          : { content: [{ type: "text", text: "timeline of Acme Rollout" }] };
      const json = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
      if (options.gzip) {
        return new Response(Bun.gzipSync(json), {
          headers: {
            "content-type": "application/json",
            "content-encoding": "gzip",
          },
        });
      }
      return new Response(json, {
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    aborted,
    seen,
    server,
    url: `http://127.0.0.1:${server.port}/mcp`,
  };
}

type StartMcpProxy = (
  upstream: string,
  token: () => string,
) => ReturnType<typeof Bun.serve>;

/**
 * The host-owned loopback proxy of the second recipe, exactly as the page
 * prints it: the `startMcpProxy` function is cut from
 * docs/mcp-headless-lane.md and imported, so a change to the page is a
 * change to what these tests run.
 */
async function documentedProxy(): Promise<StartMcpProxy> {
  const page = readFileSync(
    join(import.meta.dir, "../../../docs/mcp-headless-lane.md"),
    "utf8",
  );
  const source = page.match(/^export function startMcpProxy\([\s\S]*?^\}$/m);
  if (!source) {
    throw new Error("docs/mcp-headless-lane.md prints no startMcpProxy");
  }
  const file = join(ROOT, "documented-proxy.ts");
  writeFileSync(file, `${source[0]}\n`);
  const module = (await import(file)) as { startMcpProxy: StartMcpProxy };
  return module.startMcpProxy;
}

/** The documented proxy in front of `upstream`, with the machine token. */
async function loopbackProxy(
  upstream: string,
  token: () => string = () => MACHINE_TOKEN,
) {
  const server = (await documentedProxy())(upstream, token);
  return { server, url: `http://127.0.0.1:${server.port}/mcp` };
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
    // As the page documents it: the token recipe runs with the network on,
    // which also takes the shell out of the no-network sandbox.
    const tokenRequest = () =>
      laneRequest({
        permissions: { mode: "workspace-write", allowNetwork: true },
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
      const events = await collect(laneDriver(sdk, registry()), tokenRequest());
      expect(errorOf(events)).toBeUndefined();
      expect(state.options?.sandbox).not.toEqual(CLAUDE_NO_NETWORK_SANDBOX);
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
          tokenRequest(),
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
      const code = errorOf(
        await collect(laneDriver(sdk, registry()), tokenRequest()),
      )?.code;
      if (scope === undefined || scope === "0") {
        expect(code).toBe(EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE);
      } else {
        expect(code).toBeUndefined();
      }
    });

    test("no transcript, no resume, no session store; large MCP results stay inline", async () => {
      mcpSecretHost.readPtraceScope = () => "1";
      const { sdk, state } = connectingSdk();
      await collect(laneDriver(sdk, registry()), tokenRequest());
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
    let proxy: Awaited<ReturnType<typeof loopbackProxy>>;
    beforeAll(async () => {
      upstream = fakeMcpServer();
      proxy = await loopbackProxy(upstream.url);
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
      const { sdk, state } = connectingSdk();
      const events = await collect(laneDriver(sdk, registry()));
      expect(errorOf(events)).toBeUndefined();
      // The runtime got no header to send; the proxy added the token.
      expect(state.payload?.pai?.headers).toBeUndefined();
      expect(upstream.seen.map((s) => s.authorization)).toEqual([
        `Bearer ${MACHINE_TOKEN}`,
        `Bearer ${MACHINE_TOKEN}`,
      ]);
      expect(state.replies.map((r) => r.status)).toEqual([200, 200]);
      expect(state.replies[1]?.text).toContain("Acme Rollout");
      expect(JSON.stringify(state.payload)).not.toContain(MACHINE_TOKEN);
      expect(JSON.stringify(state.options)).not.toContain(MACHINE_TOKEN);
    });

    test("allowNetwork false: the shell stays in the no-network sandbox and web tools stay off", async () => {
      const { sdk, state } = connectingSdk();
      const events = await collect(laneDriver(sdk, registry()));
      expect(errorOf(events)).toBeUndefined();
      expect(state.options?.sandbox).toEqual(CLAUDE_NO_NETWORK_SANDBOX);
      expect(state.options?.disallowedTools).toEqual(
        expect.arrayContaining(["WebFetch", "WebSearch"]),
      );
      // A lane that names a web tool is refused, not quietly trimmed.
      const refused = connectingSdk();
      const refusal = errorOf(
        await collect(
          laneDriver(refused.sdk, registry(), {
            tools: ["Bash", "Read", "WebFetch"],
          }),
        ),
      );
      expect(refusal?.code).toBe(EXTERNAL_AGENT_NETWORK_UNENFORCEABLE);
      expect(refused.state.options).toBeUndefined();
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

describe.skipIf(!LINUX)("the documented loopback proxy itself", () => {
  const servers: Array<{ stop: (force?: boolean) => unknown }> = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
  });
  async function pair(options: FakeOptions = {}) {
    const upstream = fakeMcpServer(options);
    const proxy = await loopbackProxy(upstream.url);
    servers.push(proxy.server, upstream.server);
    return { upstream, proxy };
  }
  const rpc = (method: string) =>
    JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} });

  test("streamable HTTP: POST (streamed body), GET (SSE) and DELETE reach upstream /mcp with the token", async () => {
    const { upstream, proxy } = await pair();
    const post = await fetch(proxy.url, {
      method: "POST",
      // A client's own header is replaced, never passed on.
      headers: {
        "content-type": "application/json",
        authorization: "Bearer acme-agent-guess",
      },
      body: new Blob([rpc("tools/call")]).stream(),
    });
    expect(post.status).toBe(200);
    expect(await post.text()).toContain("Acme Rollout");
    const sse = await fetch(proxy.url, {
      headers: { accept: "text/event-stream" },
    });
    expect(sse.status).toBe(200);
    expect(sse.headers.get("content-type")).toBe("text/event-stream");
    expect(await sse.text()).toContain("event: message");
    const end = await fetch(proxy.url, { method: "DELETE" });
    expect(end.status).toBe(202);
    expect(upstream.seen).toEqual(
      ["tools/call", "GET", "DELETE"].map((method) => ({
        authorization: `Bearer ${MACHINE_TOKEN}`,
        method,
        path: "/mcp",
      })),
    );
  });

  test("any path but /mcp is 404 and never reaches upstream", async () => {
    const { upstream, proxy } = await pair();
    const base = proxy.url.replace(/\/mcp$/, "");
    for (const path of ["/", "/admin", "/mcp/extra", "/mcpx"]) {
      for (const method of ["GET", "POST"]) {
        const res = await fetch(`${base}${path}`, {
          method,
          ...(method === "POST" ? { body: rpc("tools/call") } : {}),
        });
        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain(MACHINE_TOKEN);
      }
    }
    expect(upstream.seen).toEqual([]);
  });

  /**
   * One raw HTTP/1.1 request, so the test, not the client library, sets
   * `Host` (a browser after DNS rebinding sends its own name there).
   * Returns the status code.
   */
  async function rawStatus(
    port: number,
    method: string,
    headers: Record<string, string>,
  ): Promise<number> {
    const body = method === "POST" ? rpc("tools/call") : "";
    const head = [
      `${method} /mcp HTTP/1.1`,
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      "content-type: application/json",
      `content-length: ${Buffer.byteLength(body)}`,
      "connection: close",
      "",
      "",
    ].join("\r\n");
    let reply = "";
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          socket.write(head + body);
        },
        data(_socket, chunk) {
          reply += chunk.toString();
        },
        close() {
          resolve();
        },
        error(_socket, error) {
          reject(error);
        },
      },
    });
    await promise;
    const status = reply.match(/^HTTP\/1\.1 (\d{3})/)?.[1];
    if (!status) throw new Error(`no HTTP status in: ${reply.slice(0, 80)}`);
    return Number(status);
  }

  test("a browser's request is 403 and never reaches upstream: foreign Host (DNS rebinding) or any Origin", async () => {
    const { upstream, proxy } = await pair();
    const port = proxy.server.port as number;
    const own = `127.0.0.1:${port}`;
    const refused: Array<Record<string, string>> = [
      { host: `rebind.acme.example:${port}` },
      { host: `localhost:${port}` },
      { host: "127.0.0.1" },
      { host: own, origin: "https://acme.example" },
      { host: own, origin: `http://${own}` },
      { host: own, origin: "null" },
    ];
    for (const headers of refused) {
      for (const method of ["POST", "GET", "DELETE"]) {
        expect(await rawStatus(port, method, headers)).toBe(403);
      }
    }
    expect(upstream.seen).toEqual([]);
    // The agent's own request (its Host, no Origin) still goes through.
    expect(await rawStatus(port, "POST", { host: own })).toBe(200);
    expect(upstream.seen.map((s) => s.authorization)).toEqual([
      `Bearer ${MACHINE_TOKEN}`,
    ]);
  });

  test("an upstream redirect is not followed: 502, and the other host gets nothing", async () => {
    const elsewhere = fakeMcpServer();
    servers.push(elsewhere.server);
    const { upstream, proxy } = await pair({ redirectTo: elsewhere.url });
    const res = await fetch(proxy.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: rpc("tools/call"),
      redirect: "manual",
    });
    expect(res.status).toBe(502);
    expect(upstream.seen.map((s) => s.method)).toEqual(["POST"]);
    expect(elsewhere.seen).toEqual([]);
  });

  test("an agent that goes away cancels the upstream request", async () => {
    const { upstream, proxy } = await pair({ delayMs: 10_000 });
    const gone = new AbortController();
    const call = fetch(proxy.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: rpc("tools/call"),
      signal: gone.signal,
    }).catch(() => undefined);
    while (upstream.seen.length === 0) await Bun.sleep(20);
    gone.abort();
    await call;
    for (let i = 0; i < 100 && upstream.aborted.count === 0; i++) {
      await Bun.sleep(20);
    }
    expect(upstream.aborted.count).toBe(1);
  });

  test("a failing upstream or token store is a plain 502 with no details", async () => {
    const down = fakeMcpServer();
    down.server.stop(true);
    const live = fakeMcpServer();
    servers.push(live.server);
    const proxies = [
      await loopbackProxy(down.url),
      await loopbackProxy(live.url, () => {
        throw new Error("acme token store is rotating");
      }),
      await loopbackProxy(live.url, () => "acme\r\nx-acme: 1"),
    ];
    servers.push(...proxies.map((p) => p.server));
    for (const proxy of proxies) {
      const res = await fetch(proxy.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: rpc("tools/call"),
      });
      expect(res.status).toBe(502);
      expect(res.headers.get("content-type") ?? "").not.toContain("html");
      expect(await res.text()).not.toContain("acme");
    }
    expect(live.seen).toEqual([]);
  });

  test("a gzipping upstream: the client gets a body it can decode", async () => {
    const { proxy } = await pair({ gzip: true });
    const res = await fetch(proxy.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept-encoding": "gzip",
      },
      body: rpc("tools/call"),
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain("Acme Rollout");
  });

  test("a gzipping upstream through the lane: the tool result arrives", async () => {
    const { proxy } = await pair({ gzip: true });
    const { sdk, state } = connectingSdk();
    const events = await collect(
      laneDriver(sdk, {
        pai: { type: "http", url: proxy.url, tools: ["timeline_get"] },
      }),
    );
    expect(errorOf(events)).toBeUndefined();
    expect(state.replies.map((r) => r.status)).toEqual([200, 200]);
    expect(state.replies[1]?.text).toContain("Acme Rollout");
  });

  // Past Bun.serve's 10 s idle default; both run at once to keep it short.
  test("a tool call answered after 10 s and an SSE stream quiet for 10 s are not cut off", async () => {
    const { proxy } = await pair({ delayMs: 11_000, sseGapMs: 11_000 });
    const [call, stream] = await Promise.all([
      fetch(proxy.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: rpc("tools/call"),
      }).then(async (res) => ({ status: res.status, text: await res.text() })),
      fetch(proxy.url, { headers: { accept: "text/event-stream" } }).then(
        async (res) => ({ status: res.status, text: await res.text() }),
      ),
    ]);
    expect(call.status).toBe(200);
    expect(call.text).toContain("Acme Rollout");
    expect(stream.status).toBe(200);
    expect(stream.text).toContain("event: message");
  }, 30_000);
});
