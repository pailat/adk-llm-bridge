# MCP from a headless lane

How a host gives a headless agent lane (a `ClaudeAgentSdkDriver` run with no
person at the keyboard) access to a remote HTTP MCP server that needs a
machine token, without handing the token to the agent. Two recipes:

| | [Token recipe](#token-recipe) | [Loopback-proxy recipe](#loopback-proxy-recipe) |
| --- | --- | --- |
| Entry the agent sees | `https://…` with an `Authorization: { resolve }` header | `http://127.0.0.1:<port>` with no header |
| Network | `allowNetwork: true` | `allowNetwork: false` |
| Linux with a shell | needs `kernel.yama.ptrace_scope` ≥ 1 | none enforced; the host keeps the proxy's token unreadable |
| Windows with a shell | always refused | none enforced; the host keeps the proxy's token unreadable |
| Resume, `sessionStore` | refused | available |
| MCP result over the inline limit | truncated inline | Claude Code's default handling |
| Who holds the token | the bridge, for one run | a host proxy process |

Prefer the loopback-proxy recipe for lanes that need resume (fix rounds) or
must run with the network off. Both recipes apply to `ClaudeAgentSdkDriver`
only: the other drivers have no `mcpServers` in this release, so a host
refuses a lane on them whose `mcp` is not empty.

The behaviour on this page is checked on Linux, with a shell offered,
against a fake HTTP MCP server on loopback (the token recipe runs with
`allowNetwork: true`, as below, but against that loopback server) by
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

### Precheck: a shell on Linux or Windows

A run that offers a shell tool (`Bash` or `PowerShell`) with a declared
secret is refused with `EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE`, before the
resolver runs, in two cases, because other same-user processes could read
the token from the `claude` process's memory:

- on Linux, when `kernel.yama.ptrace_scope` is `0` or missing;
- on Windows, always. Such a lane needs the loopback-proxy recipe, or no
  shell.

Check it when the host starts, so a lane fails early instead of on its
first run:

```ts
import { readFileSync } from "node:fs";

function ptraceScope(): string | undefined {
  try {
    return readFileSync("/proc/sys/kernel/yama/ptrace_scope", "utf8").trim();
  } catch {
    return undefined; // no Yama
  }
}

function checkTokenLaneHost(tools: readonly string[]): void {
  if (!tools.includes("Bash") && !tools.includes("PowerShell")) return;
  if (process.platform === "win32") {
    throw new Error(
      "MCP token lanes with a shell are refused on Windows; " +
        "use the loopback-proxy recipe or drop the shell",
    );
  }
  if (process.platform !== "linux") return;
  const scope = ptraceScope();
  if (scope === undefined || scope === "0") {
    throw new Error(
      "MCP token lanes with a shell need kernel.yama.ptrace_scope >= 1 " +
        "(sysctl kernel.yama.ptrace_scope=1), or use the loopback-proxy recipe",
    );
  }
}

checkTokenLaneHost(planAgent.tools); // e.g. ["Bash", "Read", "mcp__pai__timeline_get"]
```

Without a shell tool neither term applies. `{ env }` values are refused
whenever a shell is offered; use `{ resolve }`.

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
    async fetch(req, server) {
      // Only the agent, never a browser: a page that rebinds a name to
      // 127.0.0.1 sends that name as Host, and any cross-origin request
      // carries Origin. The MCP client sends neither.
      if (
        req.headers.get("host") !== `127.0.0.1:${server.port}` ||
        req.headers.has("origin")
      ) {
        return new Response("forbidden", { status: 403 });
      }
      // Only the MCP path; nothing else gets the token.
      if (new URL(req.url).pathname !== "/mcp") {
        return new Response("not found", { status: 404 });
      }
      try {
        const headers = new Headers(req.headers);
        headers.set("authorization", `Bearer ${token()}`);
        headers.delete("host");
        return await fetch(upstream, {
          method: req.method,
          headers,
          body: req.body,
          // Never re-send the token anywhere but the one upstream URL.
          redirect: "error",
          // The agent went away: cancel the upstream request too.
          signal: req.signal,
          // No idle cut-off upstream either (Bun's fetch default is 5 minutes).
          timeout: false,
          // Pass the body on as sent, matching its content-encoding header.
          decompress: false,
        });
      } catch {
        // Upstream down, a redirect, or a failing token store: no details.
        return new Response("bad gateway", { status: 502 });
      }
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

The agent runs with the network off:

```ts
permissions: { mode: "workspace-write", allowNetwork: false }
```

The proxy forwards every streamable-HTTP method on `/mcp` (POST, the SSE
GET, DELETE) and streams both bodies. It answers 403 to a request whose
`Host` is not its own `127.0.0.1:<port>` or that carries an `Origin`
header, and 404 on any other path. It replaces any `Authorization` header
the client sent. The options of the upstream `fetch` each matter:

- `redirect: "error"`: Bun's `fetch` follows redirects by default, so a
  3xx from upstream would make the proxy re-send the request, with the
  token, to another URL. The proxy answers 502 instead.
- `signal: req.signal`: when the agent goes away (a cancelled run, a
  closed SSE stream), the upstream request is cancelled too, instead of
  holding a socket until the proxy exits.
- `timeout: false`, with `idleTimeout: 0` on the server: turns off the
  upstream `fetch`'s 5-minute and `Bun.serve`'s 10-second idle defaults, so
  a tool call or SSE stream that stays quiet longer is not cut on either
  side.
- `decompress: false`: Bun's `fetch` otherwise decodes a gzipped answer
  but keeps its `content-encoding` header, and the agent then cannot read
  it.

Any failure (upstream down, a redirect, a token store that throws) is a
plain 502 with no details, never Bun's development error page with a stack
trace. The conformance test loads this exact function from the page.

Because the entry carries no `{ resolve }` or `{ env }` value:

- **Network stays off.** A loopback server is accepted without
  `allowNetwork`; it must be the IP literal `127.D.D.D` or `[::1]`, never
  `localhost` (see
  [Network rules](external-agent-isolation.md#network-rules-http-sse)).
  The shell stays in the no-network sandbox and web tools stay off.
- **The driver enforces no `ptrace_scope` condition.** There is no secret
  in the `claude` process to read. The token is still in the proxy, so the
  host must keep it out of the agent's reach (see
  [Where the proxy keeps the token](#where-the-proxy-keeps-the-token)).
- **Resume and the session store stay on.** `resumeSessionId`,
  `runtimeSession.id`, the session id kept in ADK state and `sessionStore`
  all work as without MCP, so a fix round can resume the implementer's
  session (see [Persisting Claude sessions](claude-session-store.md)).
- **Large results are not forced inline.** The driver does not set
  `ENABLE_MCP_LARGE_OUTPUT_FILES=0`, so Claude Code handles a large MCP
  result as it does without the bridge, which may save it under the session
  folder. Pagination (4tas8fc2) is still the way to get a 76,000-character
  result whole.

### Where the proxy keeps the token

The bridge never sees the proxy's token, so it checks nothing about it.
The host keeps it out of the agent's reach
([host duty 14](workflow-run-spec.md#what-the-host-must-do-at-run-time)
asks for a process the agent cannot read):

- Do not put the token in the host's environment, nor on the proxy's
  command line, nor in a file or keychain the agent's `Read` or shell can
  reach. On Linux a file-read tool without bounds can read
  `/proc/<pid>/environ` of a same-user process, and a shell can read any
  file the user can. Any local user, even with the proxy under another OS
  user, can read its arguments from `/proc/<pid>/cmdline` or `ps`.
- Confine reads with `allowedPaths` (and `readPaths`) that exclude `/proc`
  and the token's file. The example lane above offers `Read` without them;
  add them before giving it a token-holding host.
- Run the proxy as a separate OS user, or in a process the agent cannot
  read. Otherwise, on Linux with a shell offered, keep
  `kernel.yama.ptrace_scope` at 1 or higher, so that the shell cannot read
  the proxy's memory.

### Who may call the proxy

The proxy authenticates nobody: any local process that can reach the port
uses the machine token's access. Narrow that:

- Give the machine token a read-only scope.
- Bind an ephemeral port per host, and listen only while an agent step that
  was granted the provider runs.
- Keep every shell on the host in the no-network sandbox. Do not set
  `allowUnsandboxedShell: true` or `allowNetwork: true` for an agent that
  is granted the provider, nor for any other lane on the same host. Either
  setting takes the shell out of the sandbox. An approved shell command can
  then call the proxy directly and use every upstream tool the token
  allows. That call skips the entry's `tools` allowlist and `readOnly`,
  which only bind the agent's MCP client. This holds for a shell on any
  lane of the host, not just the granted one.
- Do not turn on `allowLocalBinding` for that agent: with it, shell commands
  may reach loopback servers directly (macOS only; Claude Code ignores it on
  Linux).
- Refuse browsers. A web page open on the same machine can send requests to
  a loopback port. With DNS rebinding it can also read the replies, under
  its own host name. The sample answers 403 unless `Host` is exactly
  `127.0.0.1:<port>` and no `Origin` header is present. Keep both checks in
  any proxy you write.
- Forward only the MCP path, to the one upstream URL, and never take the
  upstream from the request nor from a redirect (the sample answers 404 on
  any other path and 502 on an upstream redirect).

Adding a per-run token for the proxy as a `{ resolve }` header turns resume
and the session store back off: any declared secret does. A token in the URL
path is not a secret to the bridge and appears in the transcript.
