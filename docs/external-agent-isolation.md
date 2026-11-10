# External agent isolation and network policy

This page states what `adk-llm-bridge/agents` guarantees when it runs Claude
Code, Codex or Gemini CLI as an ADK agent: which host configuration the agent
sees, and how each driver keeps the network off. Network is off unless the
policy sets `allowNetwork: true`.

## Host configuration

| Driver | Default | Opt out |
|---|---|---|
| `ClaudeAgentSdkDriver` (default for `ClaudeAgent`) | Isolated: the built-in tools in `DEFAULT_CLAUDE_TOOLS` plus the bridge's tools; no host MCP servers, settings files, skills, claude.ai connectors or auto-memory. | `inheritHostConfig: true`, or `tools: [...]` to choose the built-in tools. |
| `ClaudeCliDriver` | Isolated the same way, through CLI flags. | Same options. |
| Codex and Gemini CLI drivers | Use the host's Codex or Gemini configuration. Without `allowNetwork: true` see the table below. | - |

Both Claude drivers check the tools and MCP servers the runtime reports at
start, and every tool the model is about to use. A tool outside the configured
set is denied before it runs, in every permission mode, and the run ends with
the non-recoverable error `EXTERNAL_AGENT_ISOLATION_VIOLATED`. This catches a
host admin or managed policy that adds tools or connectors, at start or later.
`inheritHostConfig: true` turns the check off.

The error message says what the bridge saw. A tool the runtime listed in its
`system/init` tools points to a host or managed setting. A built-in it did
not list means the model asked for a tool it was not given (the runtime
refuses such a call; the run still stops). An MCP tool it did not list may
come from the model or from a server or connector that connected after start.
A tool call seen before `system/init` gets a neutral message. The code and
recoverability are the same in every case.

The per-message check compares built-in tool names by canonical name, so an
offered tool reported as `bash` for `Bash` is never flagged. Everything else
outside the offered set is flagged and stops the run: a built-in that was not
offered, any `mcp__` tool outside the expected servers (MCP names are never
case-folded), an unknown name in any case, a near-miss spelling such as
`"Bash "` or `" Bash"`, and a `tool_use` with an empty or missing name. `ClaudeAgentSdkDriver`'s
`PreToolUse` hooks also deny a call whose hook input has no tool name.

### Host context the runtime still adds

An isolated Claude run sets `autoMemoryEnabled: false` in the flag settings
(`settings` for the SDK, `--settings` for the CLI). Claude Code then leaves
out its auto-memory section, which would otherwise point the agent at the
host's memory directory under `~/.claude/projects/` and ask it to write
there. `inheritHostConfig: true` leaves the host's memory setting as it is.

Known limit: Claude Code adds account context of its own to every session,
isolated or not, including the signed-in account's email address. Neither
the Agent SDK options nor the documented settings turn it off, so an
isolated Claude agent can still see the host account's email. The agent's
tools, files and network stay isolated. Do not rely on isolation to hide the
host account's identity from the model; run the agent under an account (or
API key) you are fine with it seeing.

A required MCP server other than the bridge's own (`requiredMcpServers`) needs
`inheritHostConfig: true`; otherwise the driver throws `InputValidationError`
at construction.

A `read-only` Claude agent never uses MCP tools other than the bridge's own,
also with `inheritHostConfig: true`: `ClaudeCliDriver` denies `mcp__*` and
`ClaudeAgentSdkDriver` adds a `PreToolUse` hook that denies them. A host
`permissions.allow` rule cannot let one through. `ClaudeCliDriver` runs
`read-only` with `--permission-mode dontAsk` (not `plan`, which runs a
different model than `--model`).

## Network off by default, per driver

Network is off unless the policy sets `allowNetwork: true`. An unset
`allowNetwork`, or no `permissions` at all, means `false`, at the root, in
workflow steps, in delegated children and in a driver run directly. The
guarantee below applies to every run without `allowNetwork: true`:

- **At the root**, an agent keeps network only when its own policy sets
  `allowNetwork: true`.
- **Under an `ExternalAgent` ancestor** (directly, or through the session
  registry that `AgentInvocationGateway` copies to delegated runs), the
  ancestor's policy is a ceiling. A child keeps network only when both set
  `allowNetwork: true`. A child cannot turn network on.
- **A root `WorkflowAgent` with no external ancestor** applies no ceiling. A
  workflow agent is not a security principal: each step runs with its own
  policy, so a step with `allowNetwork: true` keeps network and a step
  without it has none.
- Agents that the workflow agent factory builds from definitions also need
  host opt-in before they can ask for `allowNetwork: true`. Their
  `workingDirectory` and `allowedPaths` must lie inside the host's
  `workingDirectoryRoots` once symlinks are resolved, so a link inside a root
  that points outside it is rejected.

| Driver | Shell commands | Web tools | MCP tools | Where it cannot be enforced |
|---|---|---|---|---|
| Claude Agent SDK | Bash runs in the Claude Code sandbox with every host denied, in every permission mode, `bypassPermissions` included. | Removed from the default tool list, and denied by the guard. Naming `WebFetch` or `WebSearch` in `tools` refuses the run with `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE`. | Only the bridge server exists. The guard denies other `mcp__*` tools. | If the sandbox cannot start (Windows, Linux without bubblewrap), the run fails at start. `allowUnsandboxedShell: true` skips the sandbox; shell calls then reach the approver. |
| Claude CLI | Same sandbox, through `--settings`. | Same as the SDK driver. | No MCP server; `permissions.deny` for `mcp__*`. | Same as the SDK driver. |
| Codex SDK | Codex sandbox with no network in `read-only`, `ask` and `workspace-write`. | Web search disabled, so a host `config.toml` cannot turn it on. | Host MCP servers are listed with `codex mcp list --json` and each one is turned off for the run. | `full-access`, a failed listing, a server name that cannot be written as an override, or a prebuilt `sdk` client: refused with `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE`. Opt in with `allowUnenforcedNetwork: true`. |
| Codex CLI | `sandbox_workspace_write.network_access=false` is pinned. | `web_search="disabled"` is pinned. | Same listing; each server gets `mcp_servers.<name>.enabled=false`. | Same as the Codex SDK driver. |
| Gemini CLI | Not enforceable. | Not enforceable: `google_web_search` and `web_fetch` run without the guard. | Not enforceable: servers from `~/.gemini/settings.json` run without the guard. | Every run without `allowNetwork: true` is refused with `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE`, in every mode, so a Gemini CLI agent needs `allowNetwork: true` (or a driver built with `allowUnenforcedNetwork: true`). |

### Read-only agents with network

A `read-only` agent with `allowNetwork: true` can read the web, for example a
research agent that must check documentation:

**Read-only does not stop data leaving.** With `allowNetwork: true` a
read-only agent can send what it reads (file contents, secrets in the
workspace) to any host through the web tools, for example in a URL after a
prompt injection, and no approver is asked. Turn the network on only for
agents whose inputs you trust, or use `ask` mode so web calls go to an
approver.

| Driver | Web tools under `read-only` + `allowNetwork: true` |
|---|---|
| Claude Agent SDK | `WebFetch` and `WebSearch`, when offered, run without a confirmation: the guard lets them through and the agent allows them without asking an approver. Driven without a permission callback, the driver adds them to `allowedTools`. |
| Claude CLI | Same: `--settings` adds `permissions.allow` for the offered web tools next to the `mcp__*` deny, since `dontAsk` denies anything that would prompt. |
| Codex SDK and CLI | Web search follows the driver's `webSearchMode` / `webSearchEnabled` (SDK) or Codex's own setting (CLI); it is only pinned to `disabled` without the network. Shell commands stay in the read-only sandbox. |
| Gemini CLI | Runs in plan mode with `--sandbox`; `google_web_search` and `web_fetch` run without the guard, as in every mode. |

Every other read-only rule stays: write, edit and shell tools are denied, MCP
tools other than the bridge's own are denied, and the web exception matches
the exact runtime names only (`WebFetch`, `WebSearch`, `web_fetch`,
`web_search`, `google_web_search`), so `webfetch` or `mcp__x__WebFetch` is
still denied. A path outside `allowedPaths` in a web tool's input is still
denied with the path reason. Outside `read-only`, a web tool with the network on still goes
to the approver.

A Claude agent whose `tools` name a web tool (in any case) while the network
is off is refused at run start with `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE`,
before `query()` or the CLI starts, instead of running without the tools the
caller asked for. An unset `allowNetwork` counts as off here too, and so does
a ceiling inherited from a parent without network. The default tool list is
still trimmed without a refusal.

## The confirmation guard

Every permission request passes the guard before the approver or the ADK
confirmation sees it. Its denials are final; no approval overrides them.

- Without `allowNetwork: true`: web tools, MCP tools other than the bridge
  tools registered for the run (matched by exact name, so a host server
  named `adk_bridge__x` gets no exemption), and shell calls that the driver
  did not run in a no-network sandbox.
- Path guard (with `allowedPaths` or inherited `pathBounds`): path arguments
  of file tools (Claude Code, Codex and Gemini CLI argument names, nested
  file changes, `apply_patch` file headers), and the base of globs that leave
  the allowed paths. Brace alternatives are expanded (at most 64; more is
  checked as `/`), and a relative glob is resolved against the tool's own
  search root (`path`, `dir_path`), or against the working directory when
  the tool has none (Gemini `read_many_files` `include`, for example). Symlinks are resolved, dangling links
  included, so a link to a file that does not exist yet is checked where the
  write would land; a symlink loop is denied. Under `read-only` a path outside
  the allowed paths is denied with the path reason.
- Only `ClaudeAgentSdkDriver` can enforce the path guard. Besides the
  permission prompts, it checks every tool call with a `PreToolUse` hook,
  because Claude Code approves reads and `acceptEdits` writes inside its
  working directory and `additionalDirectories` without asking. A search
  tool without a search path (`Glob`, `Grep`) searches the working
  directory, so it is checked against it. The sandbox limits what shell
  commands write: its writable roots are the allowed roots. With a shell
  tool on offer, the run is refused with `EXTERNAL_AGENT_PATHS_UNENFORCEABLE`
  when:
  - the working directory is outside `allowedPaths` (Claude Code always keeps
    it writable);
  - the shell is unsandboxed (`allowNetwork: true`, `allowUnsandboxedShell`);
  - the driver has `inheritHostConfig: true` (host `Edit(...)` allow rules
    and a host `sandbox.filesystem.allowWrite` are merged into the writable
    paths);
  - the working directory or an allowed root is inside a temp directory the
    sandbox always keeps writable (`/tmp`, which holds `/tmp/claude-<uid>`,
    the host temp directory, `TMPDIR`, `CLAUDE_CODE_TMPDIR`): the paths
    around the allowed roots there would stay writable.

  Without a shell tool any working directory works; the hook checks the file
  and search tools. The Claude
  CLI, Codex SDK, Codex CLI and Gemini CLI drivers run file tools without
  asking the bridge, so they refuse a run with `allowedPaths` or `pathBounds`
  with `EXTERNAL_AGENT_PATHS_UNENFORCEABLE`. Build the driver with
  `allowUnenforcedPaths: true` to run anyway; the runtime's own sandbox then
  decides which paths the agent reaches.
- It does not check paths inside shell commands. Those rely on the runtime
  sandbox or the `read-only` mode. The Claude Code sandbox confines writes
  only: a shell command can still read files outside `allowedPaths`, and it
  can still write to the sandbox's own temp directories. Under
  `workspace-write` (and `ask`) a Bash call also needs an approver
  (`confirmation.approver` or `confirmation: { adk: true }`); without one
  every Bash call is denied.

A delegated agent's `allowedPaths` are the intersection of its own and its
parent's, by containment: a root inside a root of the other side is kept, so
`["/repo"]` and `["/repo/src"]` give `["/repo/src"]`. Roots are compared like
the guard compares paths (resolved, with symlinks followed on both sides), so
a symlink or `..` cannot leave a parent root. A parent's relative roots
never pass to a delegated agent: each is relative to its own agent's working
directory, so `src` of a parent in `/a` is not `src` of a child in `/b`. A
child of a parent with only relative roots therefore gets `[]`, even when it
sets no `allowedPaths`. A child's own relative roots stay only when the
parent sets no `allowedPaths`. Use absolute or `~` roots for delegated
agents. An empty intersection, or an empty list on either side, allows no
path.

The derived policy also keeps both sides' absolute roots as `pathBounds`, and
the guard checks every bound when a request arrives. A kept root that a
symlink later points outside the parent's roots (a link created or retargeted
after delegation) is therefore still denied.

## Credentials

`ClaudeAgent`, `CodexAgent` and `GeminiCliAgent` read credentials with
`EnvCredentialProvider`: only the variables in the provider's `envAllowlist`
(for Codex: `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `CODEX_HOME`, and so on)
reach the runtime. `OPENAI_API_KEY` is not in the Codex allowlist on purpose:
an OpenAI key set for other tools on the host does not reach Codex; set
`CODEX_API_KEY` for it. A plain `ExternalAgent` uses `NoopCredentialProvider`,
and the runtime uses its own login state.

A credential provider returns an `env` credential, a `none` credential (the
runtime's own login, the same as `undefined`), or `undefined` (`null` counts
as `undefined`). Any other `kind` (`"custom"`, `""`, `"ENV"`, a missing kind)
ends the turn with `EXTERNAL_AGENT_CREDENTIAL_UNSUPPORTED` before the driver
starts, so the run never falls back to the runtime's login; so does an `env`
that is not an object. The agent reads the credential once and gives the
driver a frozen copy; non-string `env` values are dropped.

`request.runtimeSession.id`, when a caller sets it on a direct driver run, is
the session to resume: the Codex SDK driver prefers it over the thread id
saved in session state; the Claude Agent SDK driver uses its
`resumeSessionId` option first, then `runtimeSession.id`, then session state,
then its own memory. `ExternalAgent` never sets it.

## Cancel and host signals

Cancelling a CLI run kills the CLI's whole process group on macOS and Linux
(shells, MCP servers and other children it started), with SIGKILL after
`killGraceMs` (default 2000 ms) if SIGTERM is ignored. Ctrl-C, SIGTERM and
SIGHUP of the host are forwarded to the CLI's group, and the host still ends by
that signal unless it handles it itself. On Windows only the CLI process is
signaled.

## Missing dependencies

A missing `@anthropic-ai/claude-agent-sdk` or `@openai/codex-sdk` is an error
event with `EXTERNAL_AGENT_DEPENDENCY_MISSING`. A missing `claude`, `codex` or
`gemini` binary is an error event with `MISSING_BINARY`
(`EXTERNAL_AGENT_MISSING_BINARY`). Both name the install command; neither
throws out of the agent.

The SDK drivers look for the `claude` or `codex` binary under `PATH`, the home
directory, and the `node_modules` of the host process directory and of the
bridge's own install. They never look in the run's `workingDirectory`: the
agent can write there, so a binary it left behind would start the next run
outside the runtime's sandbox. If the only copy is inside the workspace, set
`CLAUDE_CODE_EXECUTABLE` or `CODEX_EXECUTABLE` to it. The CLI drivers start
`command` as given, found on `PATH` without a shell.

## Error codes

An error event's code lands on the ADK event's `errorCode`. The constants are
exported from `adk-llm-bridge/agents`.

| Code | Constant | Recoverable | When |
| --- | --- | --- | --- |
| `EXTERNAL_AGENT_ERROR` | `EXTERNAL_AGENT_ERROR` | As the driver reports | The driver reported an error without a code. |
| `EXTERNAL_AGENT_TRANSFER_FAILED` | `EXTERNAL_AGENT_TRANSFER_FAILED` | - | A `transfer_to_agent` target failed and did not report the error itself. |
| `EXTERNAL_AGENT_NOT_CONFIGURED` | `EXTERNAL_AGENT_NOT_CONFIGURED` | No | The agent runs `PlaceholderExternalAgentDriver`: no driver is configured. |
| `EXTERNAL_AGENT_CONFIRMATION_UNUSED` | `EXTERNAL_AGENT_CONFIRMATION_UNUSED` | No | The human approved a call through `confirmation: { adk: true }` and the runtime did not make it again on the answer turn, so it never ran. `customMetadata.unusedConfirmations` lists the tool and request id. |
| `EXTERNAL_AGENT_TOOL_CREDENTIAL_REQUIRED` | `EXTERNAL_AGENT_TOOL_CREDENTIAL_REQUIRED` | No | A bridged ADK tool called `toolContext.requestCredential()`; the runtime got a `CREDENTIAL_REQUIRED` error instead of a result. `customMetadata.tools` names the tools. |
| `EXTERNAL_AGENT_TOOL_RESULT_TOO_LARGE` | `EXTERNAL_AGENT_TOOL_RESULT_TOO_LARGE` | No | The user's answer to a paused long-running call is over 64 KiB (UTF-8 bytes of JSON), or the answers of one turn total over 256 KiB. The runtime does not start; the answers are not marked used, so a smaller one for the same call id can follow. |
| `EXTERNAL_AGENT_ISOLATION_VIOLATED` | `EXTERNAL_AGENT_ISOLATION_VIOLATED` | No | The runtime reported tools or MCP servers outside the isolated set. |
| `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE` | `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE` | No | The network cannot be kept off (the policy does not set `allowNetwork: true`), or a Claude agent's `tools` name a web tool while the network is off; see the tables above. The message names the remedy: `allowNetwork: true`, or `allowUnenforcedNetwork: true` on the driver; for web tools named in a Claude agent's `tools`, `allowNetwork: true` or removing them (`allowUnenforcedNetwork` does not lift that refusal). |
| `EXTERNAL_AGENT_PATHS_UNENFORCEABLE` | `EXTERNAL_AGENT_PATHS_UNENFORCEABLE` | No | The policy sets `allowedPaths` (or a parent agent passed `pathBounds`) and the driver cannot check tool paths: Claude CLI, Codex and Gemini CLI (remedy: `ClaudeAgentSdkDriver`, no `allowedPaths`, or `allowUnenforcedPaths: true` on the driver). On the Claude Agent SDK: a shell tool is on offer and the working directory is outside `allowedPaths` or the shell is unsandboxed (remedy: a working directory inside `allowedPaths`, or `tools` without `Bash`). |
| `EXTERNAL_AGENT_DEPENDENCY_MISSING` | `EXTERNAL_AGENT_DEPENDENCY_MISSING` | No | An optional SDK package is not installed. |
| `EXTERNAL_AGENT_CREDENTIAL_UNSUPPORTED` | `EXTERNAL_AGENT_CREDENTIAL_UNSUPPORTED` | No | The credential provider returned a `kind` other than `env` or `none`. |
| `EXTERNAL_AGENT_OPTION_UNSUPPORTED` | `EXTERNAL_AGENT_OPTION_UNSUPPORTED` | No | Thrown (not an event) when a driver is built with an option its runtime cannot honor: `sessionStore` on `ClaudeCliDriver`. |
| `CLAUDE_SESSION_STORE_MIRROR_ERROR` | `CLAUDE_SESSION_STORE_MIRROR_ERROR` | Yes | The Claude Agent SDK dropped a transcript batch its `sessionStore` rejected or timed out on (3 attempts in total); the run goes on. See [Persisting Claude sessions](claude-session-store.md). |
| `MISSING_BINARY` | `EXTERNAL_AGENT_MISSING_BINARY` | No | The `claude`, `codex` or `gemini` binary was not found. |
| `CLAUDE_CLI_EXIT`, `CODEX_CLI_EXIT`, `GEMINI_CLI_EXIT` | - | From the message | The CLI exited with a nonzero code (Codex: and reported no error of its own). The message holds the stderr tail; auth, billing and quota failures are not recoverable. |
| `CLAUDE_PERMISSION_DENIED` | - | No | The Claude Agent SDK denied a tool call (the message names the tool and the reason). |
| `CLAUDE_AGENT_SDK_ERROR` | - | From the message | The Claude Agent SDK threw; used when the message matches no known failure. |
| `CLAUDE_AGENT_SDK_RESULT_ERROR` | - | From the message | A Claude Agent SDK `result` reported an error with no known subtype. A known subtype such as `error_max_turns` gives its code instead (`MAX_TURNS_EXCEEDED`). |
| `CODEX_TURN_FAILED` | - | From the message | A Codex SDK `turn.failed` event. |
| `CODEX_SDK_STREAM_ERROR` | - | From the message | A Codex SDK `error` stream event. |
| `CODEX_SDK_ERROR` | - | From the message | The Codex SDK threw. |
| `CODEX_ITEM_ERROR` | - | From the message | A Codex SDK `error` item. |

"From the message" means `classifyRecoverable` sorts the message. Auth,
billing, quota and missing-binary failures are not recoverable; rate limits,
timeouts and other transport failures are, and so is any message that matches
nothing. For the SDK codes above, a message that matches a known failure
reports that failure's code instead (for example `RATE_LIMIT` or
`QUOTA_EXHAUSTED`); the CLI exit codes stay as shown, and for them only the
last stderr line is sorted. A Codex CLI that writes to stderr and exits 0 only
logs a `CODEX_CLI_STDERR` warning.

### Classified codes

`classifyRecoverable` gives the same code for the same failure whatever the
provider. The codes are the `RecoverableErrorCode` type:

| Code | Recoverable | From |
| --- | --- | --- |
| `AUTH_ERROR` | No | Claude `authentication_failed`, `oauth_org_not_allowed`, an auth status error; a 401, 403 or invalid key message. |
| `BILLING_ERROR` | No | Claude `billing_error`; a billing, payment or exhausted-credit message. |
| `QUOTA_EXHAUSTED` | No | Codex `quota_exhausted`, `usage_limit_reached`, `usage_limit_exceeded`; a plan usage cap message from any runtime. |
| `MAX_BUDGET_EXCEEDED` | No | Claude `error_max_budget_usd`. |
| `MAX_TURNS_EXCEEDED` | No | Claude `error_max_turns`. |
| `MAX_STRUCTURED_OUTPUT_RETRIES` | No | Claude `error_max_structured_output_retries`. |
| `MAX_OUTPUT_TOKENS` | No | Claude `max_output_tokens`. |
| `INVALID_REQUEST` | No | Claude or Codex `invalid_request`. |
| `MISSING_BINARY` | No | An "unable to locate" or `ENOENT` message. |
| `RATE_LIMIT` | Yes | Claude or Codex `rate_limit`; a 429 or rate-limit message. |
| `SERVER_ERROR` | Yes | Claude or Codex `server_error`. |
| `TRANSPORT_ERROR` | Yes | A timeout, connection, 502, 503 or 504 message. |
| `UNKNOWN_ERROR` | Yes, unless the caller says otherwise | Nothing matched and the caller gave no fallback code. |

Codes before 0.7 named a provider or were lower case. They are not reported
any more; `LEGACY_RECOVERABLE_ERROR_CODES` maps each to its replacement, and
`normalizeRecoverableErrorCode(code)` returns the new code for an old one (and
any other code unchanged), so a stored code still compares:

| Old code | New code |
| --- | --- |
| `CLAUDE_AUTH_ERROR`, `CLAUDE_AUTH_STATUS`, `CODEX_AUTH_ERROR` | `AUTH_ERROR` |
| `CLAUDE_BILLING_ERROR` | `BILLING_ERROR` |
| `CODEX_QUOTA_EXHAUSTED` | `QUOTA_EXHAUSTED` |
| `error_max_budget_usd` | `MAX_BUDGET_EXCEEDED` |
| `error_max_turns` | `MAX_TURNS_EXCEEDED` |
| `error_max_structured_output_retries` | `MAX_STRUCTURED_OUTPUT_RETRIES` |
| `max_output_tokens` | `MAX_OUTPUT_TOKENS` |
| `CLAUDE_INVALID_REQUEST` | `INVALID_REQUEST` |
| `CODEX_MISSING_BINARY` | `MISSING_BINARY` |
| `CLAUDE_RATE_LIMIT` | `RATE_LIMIT` |
| `CLAUDE_SERVER_ERROR` | `SERVER_ERROR` |
| `TRANSIENT_ERROR` | `TRANSPORT_ERROR` |

A failed delegation's `RunSubAgentResult` carries `error` and `errorKind`
(`"aborted"`, `"llm-calls-limit"`, `"preparation"`, `"agent-error"` or
`"invalid-resume"`). The registries throw `InputValidationError` from
`@google/adk` for an empty provider id or an unknown provider.
