# MCP from a headless lane

How a host gives a headless agent lane (a `ClaudeAgentSdkDriver` run with no
person at the keyboard) access to a remote HTTP MCP server that needs a
machine token, without handing the token to the agent. Two recipes:

| | [Token recipe](#token-recipe) | [Loopback-proxy recipe](#loopback-proxy-recipe) |
| --- | --- | --- |
| Entry the agent sees | `https://…` with an `Authorization: { resolve }` header | `http://127.0.0.1:<port>` with no header |
| Network | `allowNetwork: true` | `allowNetwork: false` |
| Linux with a shell | needs `kernel.yama.ptrace_scope` ≥ 1 | no condition |
| Resume, `sessionStore` | refused | available |
| MCP result over the inline limit | truncated inline | Claude Code's default handling |
| Who holds the token | the bridge, for one run | a host proxy process |

Prefer the loopback-proxy recipe for lanes that need resume (fix rounds) or
must run with the network off. Both recipes apply to `ClaudeAgentSdkDriver`
only: the other drivers have no `mcpServers` in this release, so a host
refuses a lane on them whose `mcp` is not empty.

The behaviour on this page is checked on Linux, with a shell offered,
against a fake HTTP MCP server on loopback by
[`tests/agents/driver/mcp-headless-lane-linux.test.ts`](../tests/agents/driver/mcp-headless-lane-linux.test.ts).
The full rules are in
[Host MCP servers and secrets](external-agent-isolation.md#host-mcp-servers-and-secrets).

## The lane side

Both recipes start the same way. The run spec grants the provider id on the
lane's agent, and never carries a URL, header or token:

```json
"agent": {
  "providerId": "claude-code",
  "model": "claude-sonnet-5",
  "mode": "workspace-write",
  "allowNetwork": false,
  "tools": ["Bash", "Read", "mcp__pai__timeline_get"],
  "mcp": ["pai"]
}
```

For the token recipe, set `"allowNetwork": true` instead (see below).

The plan keeps the grant (`RunPlanAgent.mcp`), and the host resolves it from
its own registry with `selectMcpServers`, which returns only the granted
entries and throws `EXTERNAL_AGENT_MCP_PROVIDER_UNKNOWN` for an id with no
entry (see
[host duty 14](workflow-run-spec.md#what-the-host-must-do-at-run-time)):

```ts
import { ClaudeAgentSdkDriver, selectMcpServers } from "adk-llm-bridge/agents";

const driver = new ClaudeAgentSdkDriver({
  tools: ["Bash", "Read"],
  mcpServers: selectMcpServers(planAgent.mcp, hostMcpServers), // mcp: ["pai"]
  requiredMcpServers: ["pai"],
});
```

`requiredMcpServers` makes the first message wait for the server, and ends
the run with the recoverable `EXTERNAL_AGENT_MCP_SERVER_UNAVAILABLE` when it
fails to connect (for example on a 401) or is not connected within
`mcpConnectTimeoutMs`.

## Token recipe

The host registry holds the remote server with the machine token behind a
resolver. The resolver runs once per run, after every other check passed,
and the value is kept out of the agent's options, events, errors and
results:

```ts
const hostMcpServers = {
  pai: {
    type: "http",
    url: "https://mcp.acme.example/mcp",
    headers: {
      Authorization: { resolve: () => machineTokens.current(), prefix: "Bearer " },
    },
    tools: ["timeline_get"],
    readOnly: true,
  },
} satisfies Record<string, ClaudeMcpServer>;
```

A remote `https` server needs `allowNetwork: true` on the agent, otherwise
the run ends with `EXTERNAL_AGENT_MCP_SERVER_NETWORK_REQUIRED` before it
starts. That also turns off the no-network shell sandbox (see
[Network rules](external-agent-isolation.md#network-rules-http-sse)).

### Precheck: `ptrace_scope` on Linux

On Linux, a run that offers a shell tool (`Bash`) with a declared secret is
refused with `EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE`, before the resolver
runs, when `kernel.yama.ptrace_scope` is `0` or missing: other same-user
processes could read the token from the `claude` process's memory. Check it
when the host starts, so a lane fails early instead of on its first run:

```ts
import { readFileSync } from "node:fs";

function ptraceScope(): string | undefined {
  try {
    return readFileSync("/proc/sys/kernel/yama/ptrace_scope", "utf8").trim();
  } catch {
    return undefined; // no Yama
  }
}

const scope = ptraceScope();
if (process.platform === "linux" && (scope === undefined || scope === "0")) {
  throw new Error(
    "MCP token lanes with a shell need kernel.yama.ptrace_scope >= 1 " +
      "(sysctl kernel.yama.ptrace_scope=1), or use the loopback-proxy recipe",
  );
}
```

Without a shell tool the `ptrace_scope` term does not apply. `{ env }`
values are refused whenever a shell is offered; use `{ resolve }`.

### What a declared secret turns off

So that a server's echo of its token never lands on disk, a run with any
`{ resolve }` or `{ env }` value:

- keeps no transcript (`persistSession: false`) and resumes nothing. The
  constructor refuses `sessionStore` and `resumeSessionId`, and a run
  refuses `runtimeSession.id`, each with
  `EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE`. Each turn folds the ADK
  history into its prompt instead.
- **truncates large MCP results inline.** The driver sets
  `ENABLE_MCP_LARGE_OUTPUT_FILES=0` in Claude Code's environment and blocks
  the session's `tool-results` folder, so a result larger than the inline
  limit is cut, not saved to a file the model could read back. Claude Code
  cuts an MCP result at `MAX_MCP_OUTPUT_TOKENS`, 25,000 tokens by default,
  and keeps at most 50,000 characters of any tool result inline (see
  [Large tool results](external-agent-isolation.md#large-tool-results)).
  The model sees only the start of a larger result, with no way to fetch
  the rest. A Pai `timeline_get` of about 76,000 characters is cut this way;
  the fix is server-side pagination, tracked in the Pai task 4tas8fc2.

## Loopback-proxy recipe

The host runs a small proxy on a loopback IP literal. The proxy holds the
machine token and adds the `Authorization` header to every request it
forwards to the remote server. The agent's entry names only the proxy and
carries no secret:

```ts
export function startMcpProxy(upstream: string, token: () => string) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0, // ephemeral
    // No idle cut-off: a slow tool call or a quiet SSE stream stays open.
    idleTimeout: 0,
    async fetch(req) {
      // Only the MCP path; nothing else gets the token.
      if (new URL(req.url).pathname !== "/mcp") {
        return new Response("not found", { status: 404 });
      }
      const headers = new Headers(req.headers);
      headers.set("authorization", `Bearer ${token()}`);
      headers.delete("host");
      return fetch(upstream, {
        method: req.method,
        headers,
        body: req.body,
        // Pass the body on as sent, matching its content-encoding header.
        decompress: false,
      });
    },
  });
}

const proxy = startMcpProxy("https://mcp.acme.example/mcp", () =>
  machineTokens.current(),
);

const hostMcpServers = {
  pai: {
    type: "http",
    url: `http://127.0.0.1:${proxy.port}/mcp`,
    tools: ["timeline_get"],
    readOnly: true,
  },
} satisfies Record<string, ClaudeMcpServer>;
```

The proxy forwards every streamable-HTTP method on `/mcp` (POST, the SSE
GET, DELETE) and streams both bodies. It answers 404 on any other path,
and replaces any `Authorization` header the client sent. `decompress:
false` matters: Bun's `fetch` otherwise decodes a gzipped answer but keeps
its `content-encoding` header, and the agent then cannot read it.
`idleTimeout: 0` turns off `Bun.serve`'s 10-second idle default. The conformance
test loads this exact function from the page.

and the agent runs with the network off:

```ts
permissions: { mode: "workspace-write", allowNetwork: false }
```

Because the entry carries no `{ resolve }` or `{ env }` value:

- **Network stays off.** A loopback server is accepted without
  `allowNetwork`; it must be the IP literal `127.D.D.D` or `[::1]`, never
  `localhost` (see
  [Network rules](external-agent-isolation.md#network-rules-http-sse)).
  The shell stays in the no-network sandbox and web tools stay off.
- **No `ptrace_scope` condition.** There is no secret in the `claude`
  process to read.
- **Resume and the session store stay on.** `resumeSessionId`,
  `runtimeSession.id`, the session id kept in ADK state and `sessionStore`
  all work as without MCP, so a fix round can resume the implementer's
  session (see [Persisting Claude sessions](claude-session-store.md)).
- **Large results are not forced inline.** The driver does not set
  `ENABLE_MCP_LARGE_OUTPUT_FILES=0`, so Claude Code handles a large MCP
  result as it does without the bridge, which may save it under the session
  folder. Pagination (4tas8fc2) is still the way to get a 76,000-character
  result whole.

### Who may call the proxy

The proxy authenticates nobody: any local process that can reach the port
uses the machine token's access. Narrow that:

- Give the machine token a read-only scope.
- Bind an ephemeral port per host, and listen only while an agent step that
  was granted the provider runs.
- Do not turn on `allowLocalBinding` for that agent: with it, shell commands
  may reach loopback servers directly (macOS only; Claude Code ignores it on
  Linux).
- Forward only the MCP path, to the one upstream URL, and never take the
  upstream from the request (the sample answers 404 on any other path).

Adding a per-run token for the proxy as a `{ resolve }` header turns resume
and the session store back off: any declared secret does. A token in the URL
path is not a secret to the bridge and appears in the transcript.
