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

`ClaudeAgentSdkDriver` does not stop for a call the runtime refuses on its
own. When the model asks for a built-in or unknown tool that `system/init`
did not list, the driver waits for the runtime's answer to that call:

- An error `tool_result` (the runtime has no such tool, so no hook or
  permission step ran) is a refused call. The run goes on. Its `tool_result`
  event carries `metadata.isolation: "EXTERNAL_AGENT_TOOL_NOT_OFFERED"`
  (exported as `EXTERNAL_AGENT_TOOL_NOT_OFFERED`), and a warning with that
  code is logged. The third refused call in one run stops it with
  `EXTERNAL_AGENT_ISOLATION_VIOLATED`, so a model that keeps asking does not
  spend the budget.
- Everything else still stops the run at once or at its answer: a call the
  `PreToolUse` hook or the permission callback was reached for (the tool
  exists), a result that is not an error (it ran), no result before the run
  ends, an `mcp__` tool, a call before `system/init`, and a call with no name
  or no call id.

Only the message structure is used (`is_error`, the call id), never the error
text. `ClaudeCliDriver` has no hook signal to tell a refused call from one
that reached a tool, so it stops the run on every call outside the set.

Built-in names in `tools` are passed on in their canonical spelling (`bash`
becomes `Bash`), so the shell sandbox, the web-tool refusal and the
`read-only` removals see a shell or web tool named in any case. The
per-message check compares built-in tool names by canonical name, so an
offered tool reported as `bash` for `Bash` is never flagged. Everything else
outside the offered set is flagged and stops the run: a built-in that was not
offered, any `mcp__` tool outside the expected servers (MCP names are never
case-folded), an unknown name in any case, a near-miss spelling such as
`"Bash "` or `" Bash"`, and a `tool_use` with an empty or missing name. `ClaudeAgentSdkDriver`'s
`PreToolUse` hooks also deny a call whose hook input has no tool name.

The same canonical comparison decides every isolation check, not only the
per-message one: the start check on the tools the runtime lists at
`system/init`, and, on `ClaudeAgentSdkDriver`, the `PreToolUse` hook that
denies tools outside the set and the wrapper around your `canUseTool`. An
offered built-in reported in another case (`bash` for `Bash`) passes all of
them. The wrapper then calls your `canUseTool` with the name as the runtime
reported it, so a callback that decides by tool name should compare built-in
names without regard to case.

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
`permissions.allow` rule cannot let one through. The same denial applies in
every mode while the policy does not set `allowNetwork: true`, because a host
MCP server runs outside the shell sandbox. `ClaudeCliDriver` runs
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
| Claude Agent SDK | Bash runs in the Claude Code sandbox with every host denied, in every permission mode, `bypassPermissions` included. | Removed from the default tool list, and denied by the guard. Naming `WebFetch` or `WebSearch` in `tools` refuses the run with `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE`. | Only the bridge server exists. The guard denies other `mcp__*` tools. | If the sandbox cannot start (Windows, Linux without bubblewrap), the run fails at start. `allowUnsandboxedShell: true` skips the sandbox; shell calls then reach the approver. The sandbox also forbids binding local ports; see [Local ports](#local-ports-in-the-no-network-sandbox). |
| Claude CLI | Same sandbox, through `--settings`. | Same as the SDK driver. | No MCP server; `permissions.deny` for `mcp__*`. | Same as the SDK driver. |
| Codex SDK | Codex sandbox with no network in `read-only`, `ask` and `workspace-write`. | Web search disabled, so a host `config.toml` cannot turn it on. | Host MCP servers are listed with `codex mcp list --json` and each one is turned off for the run. | `full-access`, a failed listing, a server name that cannot be written as an override, or a prebuilt `sdk` client: refused with `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE`. Opt in with `allowUnenforcedNetwork: true`. |
| Codex CLI | `sandbox_workspace_write.network_access=false` is pinned. | `web_search="disabled"` is pinned. | Same listing; each server gets `mcp_servers.<name>.enabled=false`. | Same as the Codex SDK driver. |
| Gemini CLI | Not enforceable. | Not enforceable: `google_web_search` and `web_fetch` run without the guard. | Not enforceable: servers from `~/.gemini/settings.json` run without the guard. | Every run without `allowNetwork: true` is refused with `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE`, in every mode, so a Gemini CLI agent needs `allowNetwork: true` (or a driver built with `allowUnenforcedNetwork: true`). |

### Local ports in the no-network sandbox

The Claude sandbox without network also forbids binding local (loopback)
ports, so a tool that talks to its own worker over a local port fails inside
it: Turbopack's PostCSS worker (`next build`) stops with `binding to a port:
Operation not permitted`, and test servers cannot listen. A failed Next.js
build may also leave the failure in `.next`, so the next build outside the
sandbox fails the same way until `.next` is removed.

Build the Claude driver with `allowLocalBinding: true` to allow it
(`sandbox.network.allowLocalBinding` in Claude Code). The setting is macOS
only: Claude Code ignores it on Linux. The failure above was seen on macOS;
the behavior under the Linux sandbox has not been verified. The default is
`false`, and the option has no effect when the sandbox is off
(`allowNetwork: true`, `allowUnsandboxedShell: true`).

Treat the opt-in as network access. Remote hosts stay denied, but binding a
local port may let shell commands reach services that already listen on
loopback ports (local databases, a Docker TCP socket, model servers), or
impersonate one by taking its port, and other local processes can connect
to the ports the agent opens. Enable it only where every local service is
trusted.

```ts
new ClaudeAgent({
  name: "builder",
  description: "Builds the web app",
  permissions: { mode: "workspace-write", allowNetwork: false },
  driverOptions: { allowLocalBinding: true },
});
```

Another way is to run the build outside the agent, in a workflow step of the
host process.

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
- Path guard (with `allowedPaths`, `readPaths` or inherited path bounds): path arguments
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
  and search tools.

  One read outside the allowed paths is let through: `Read` of a file in the
  `tool-results` directory of the run's own Claude Code session. When a tool
  output is too large to return inline, Claude Code saves it to
  `<config dir>/projects/<project>/<session id>/tool-results/<id>.txt` and
  tells the model to `Read` it; without the exception the agent would lose
  its own command output. The directory comes from the runtime, never from
  the model: the session id from `system/init`, the transcript path from the
  hook input, and the config directory from the child's `CLAUDE_CONFIG_DIR`
  (else `HOME/.claude`). It must match exactly (a UUID session id, the
  transcript `<session id>.jsonl` directly in a project directory of
  `<config dir>/projects`, no symlinked session or `tool-results`
  directory), or the read is checked like any other. Only `Read` qualifies
  (with `file_path` and the paging keys), only a file inside the directory
  after symlinks are resolved, and only that session: `Write`, `Edit`,
  `Glob`, `Grep`, Bash and another session's directory stay denied. When
  Claude Code asks about the read, the driver allows it without the
  approver, for that tool call only. A custom `sessionStore` that keeps
  transcripts elsewhere gets no exception.

  The Claude
  CLI, Codex SDK, Codex CLI and Gemini CLI drivers run file tools without
  asking the bridge, so they refuse a run with `allowedPaths` or `pathBounds`
  with `EXTERNAL_AGENT_PATHS_UNENFORCEABLE`. Build the driver with
  `allowUnenforcedPaths: true` to run anyway; the runtime's own sandbox then
  decides which paths the agent reaches.
- It does not check paths inside shell commands. Those rely on the runtime
  sandbox or the `read-only` mode. The Claude Code sandbox confines writes
  only: a shell command can still read files outside `allowedPaths`, and it
  can still write to the sandbox's own temp directories. Both Claude drivers
  point those at a fresh `0700` directory per run (`CLAUDE_CODE_TMPDIR`, and
  its `claude-<uid>` directory as `TMPDIR`), removed when the run ends, so
  runs do not share `/tmp/claude-<uid>`. The sandbox does not make the
  shared host temp directories writable, so on macOS two tools that ignore
  `TMPDIR` fail with "Operation not permitted": a bare `mktemp` (it uses the
  per-user `/var/folders/.../T`; use `mktemp -p "$TMPDIR"` or a file in the
  working directory) and `diff` with a pipe or process substitution input
  (`diff <(...)`; Apple's `diff` copies such input to a fixed `/tmp` path; use
  `cmp`, or write the inputs to files first). Process substitution itself
  works: other commands read `/dev/fd/N`. On Linux, `mktemp` honors
  `TMPDIR`. Under
  `workspace-write` (and `ask`) a Bash call also needs an approver
  (`confirmation.approver` or `confirmation: { adk: true }`); without one
  every Bash call is denied.
  - **Residual: a killed host leaves the directory behind.** The directory is
    `/tmp/adk-claude-<random>` (made by `mkdtemp`, with one `claude-<uid>`
    subdirectory) and is removed on every normal, error and cancel path, in
    the `finally` of both Claude drivers. A host process that is killed with
    `SIGKILL` (or loses power) before that `finally` runs cannot remove it,
    so the directory stays, holding only an empty `claude-<uid>`
    subdirectory. The library's own tests leave none. The runtime never
    reuses or sweeps old directories, so they only add up on hosts that kill
    runs often. To clean them safely, delete only directories that are
    yours, are not symlinks, and are old enough that no run can still own
    them (a longer age than your longest run), or sweep at host start,
    before any run begins. List them first, and delete only the ones whose
    `claude-<uid>` is empty: files inside it are the work of a run that was
    killed mid-command, so look at them before you delete anything. On
    macOS `/tmp` is a symlink, so give `find` the path with a trailing
    slash:
    `find /tmp/ -maxdepth 1 -type d -user "$(id -u)" -name 'adk-claude-*' -mmin +1440`
    lists the candidates (the age is the time since the run started); once
    you have checked them, `rmdir` the empty `claude-<uid>` inside each and
    then the directory itself.

A delegated agent's `allowedPaths` are the intersection of its own and its
parent's, by containment: a root inside a root of the other side is kept, so
`["/repo"]` and `["/repo/src"]` give `["/repo/src"]`. Roots are compared like
the guard compares paths (resolved, with symlinks followed on both sides), so
a symlink or `..` cannot leave a parent root. A parent's relative roots
never pass to a delegated agent: each is relative to its own agent's working
directory, so `src` of a parent in `/a` is not `src` of a child in `/b`. A
child of a parent with only relative roots therefore gets `[]`, even when it
sets no `allowedPaths`. A child's own relative roots stay only when the
parent sets no `allowedPaths`, and only for that child: a session created
from the child's session (a workflow step, for example) gets `[]` for them.
Use absolute or `~` roots for delegated agents. An empty intersection, or an
empty list on either side, allows no path.

The derived policy also keeps both sides' absolute roots as `pathBounds`, and
the guard checks every bound when a request arrives. A kept root that a
symlink later points outside the parent's roots (a link created or retargeted
after delegation) is therefore still denied.

### Approvers and ADK confirmation need a driver that asks

`confirmation.approver` and `confirmation.adk` only work when the driver hands
the runtime's permission prompts to the host (`capabilities().approvals` is
`true`, which means the driver calls `request.requestPermission`). Only the
Claude Agent SDK driver (`ClaudeAgent`) does. The Claude CLI, Codex SDK, Codex
CLI and Gemini CLI drivers enforce the policy through the runtime's own flags
and never ask the host: a tool that needs approval is denied, and an approver
or ADK confirmation there would be ignored.

So an agent built with either option on one of those drivers throws
`ExternalAgentPolicyError` `EXTERNAL_AGENT_APPROVALS_UNSUPPORTED`, naming the
driver. `clone()` re-checks, so a clone onto such a driver throws too. A custom
driver without `capabilities()` is not checked. The checks run in the order
tools (`EXTERNAL_AGENT_TOOLS_UNSUPPORTED`), approvals, then the `readOnlyTools`
checks.

### Reading wider than you write

`allowedPaths` holds the roots an agent may read and write. `readPaths` adds
roots for read tools only:

```ts
new ClaudeAgent({
  name: "porter",
  workingDirectory: "/work/new-app",
  permissions: {
    mode: "workspace-write",
    allowedPaths: ["/work/new-app"], // read and write
    readPaths: ["/work/old-app"], // read only
  },
});
```

- **Read tools are an explicit list.** Claude Code `Read`, `Glob`, `Grep`,
  `LS`, `NotebookRead` and Gemini CLI `read_file`, `read_many_files`,
  `list_directory`, `glob`, `grep`, `grep_search`, `search_file_content`,
  matched by exact name. Only these may target a path under `readPaths`.
  Every other tool counts as a write and must stay inside `allowedPaths`.
  This includes `Write`, `Edit`, `apply_patch`, an MCP tool, another
  spelling (`read`) and a tool the bridge does not know. So the guard fails
  closed: a new runtime tool cannot write into a read root.
- **`readPaths` needs `allowedPaths`.** Without `allowedPaths`, paths are not
  restricted at all, so a policy with `readPaths` alone is rejected
  (`InputValidationError`). Relative roots resolve against the working
  directory, like `allowedPaths`.
- **Claude Agent SDK.** `readPaths` are not passed as
  `additionalDirectories`, and they never join the sandbox's writable roots,
  so Bash cannot write there either. Claude Code asks before it reads
  outside its own directories. The driver approves such a read when the tool
  is a read tool and every path is under the read roots. It does this in
  every mode, `read-only` included, and without asking the host. The
  `PreToolUse` hook still checks every call.
- **Shell commands are not parsed.** As with `allowedPaths`, the sandbox
  limits where shell commands write (only `allowedPaths`), not what they
  read.
- **Other drivers.** The Claude CLI, Codex and Gemini CLI drivers cannot check
  tool paths. They refuse a run whose policy sets `readPaths` with
  `EXTERNAL_AGENT_PATHS_UNENFORCEABLE`, unless they are built with
  `allowUnenforcedPaths: true`. The runtime's own sandbox then decides what
  is read and written.
- **Delegation.** A delegated agent reads only where both it and its parent
  may read. The bridge takes each side's whole read set (`allowedPaths` plus
  `readPaths`) and intersects them by containment, as it does for
  `allowedPaths`. A parent's read root never becomes writable for the child,
  since writes still follow the `allowedPaths` intersection. Both sides'
  absolute read roots are kept as `readPathBounds`, which the guard checks
  for read tools in place of `pathBounds`. A read root that a symlink later
  points elsewhere therefore still cannot leave the parent's reads. A
  parent's relative read roots are not passed to a child.

Without `readPaths`, nothing changes: reads stay inside `allowedPaths`, and a
read outside it is denied with "outside the paths allowed by this agent's
policy". Other ways to read more than you write:

- **Split the step.** Run a `read-only` agent whose `allowedPaths` cover what it
  must read (it can write nothing), and pass what the writer needs as the
  writer's step input or session state. This works on every driver.
- **Put the material inside the writer's roots.** Copy what it must read into
  a directory that its `allowedPaths` include. Copy it; do not symlink it,
  because a link that leaves the roots is denied. The copy stays writable.

Declarative workflow agents (`permissions` in a workflow definition) accept
only `mode`, `allowNetwork` and `allowedPaths`, and reject `readPaths`. Give
such a step a code-defined agent instead.

## Bridged ADK tools

ADK tools given to an external agent (`tools`) are hosted by the Claude Agent
SDK driver on an in-process MCP server. Two things differ from an `LlmAgent`.

### Exposed tool names

The model does not see a tool's own name. Each name is rewritten so that every
runtime accepts it and no two tools collide:

1. `adk_tool__` is put before it (`ADK_TOOL_PREFIX`): `get_weather` becomes
   `adk_tool__get_weather`.
2. Every character other than `a-z`, `A-Z`, `0-9`, `_` and `-` becomes `_`.
3. The result is cut to 64 characters.
4. A name already taken gets `_2`, `_3`, ... (the name is cut further to keep
   64 characters). ADK throws on duplicate tool names; the bridge renames
   instead.

The runtime then reports the tool as `mcp__adk_bridge__<exposed name>`, the
name its permission prompts and `PreToolUse` hooks see. An instruction that names `get_weather` therefore
does not match any tool the model sees: describe what the tool does, or use
the exposed name. Read-only filters (`readOnlyTools`) match the tool's own
name, before it is rewritten.

### Read-only agents and host tools

`permissions.mode: "read-only"` constrains **the runtime's own tools**. It
cannot see inside a host function: an ADK `FunctionTool` is host code that
runs in your process with your authority (files, network, credentials),
outside every runtime sandbox, and no static check proves a closure has no
side effects. So "read-only" for a host tool is **your declaration**, made
with `readOnlyTools` (original tool names). **The bridge cannot verify it.**

```ts
new ClaudeAgent({
  permissions: { mode: "read-only" },
  tools: [getComponent, validateUsage],
  readOnlyTools: ["reui_get_component", "reui_validate_usage"],
});
```

What the bridge does guarantee: only declared tools are exposed under
`read-only`, a declaration that names no tool is caught, and nothing is
dropped silently.

| Code (`ExternalAgentPolicyError`, thrown when the agent is built) | When |
|---|---|
| `EXTERNAL_AGENT_TOOLS_UNSUPPORTED` | `tools` on a driver whose `capabilities().tools` is not `true` (Codex, Gemini CLI, Claude CLI). Only the Claude Agent SDK driver (`ClaudeAgent`) hosts ADK tools. A custom driver without `capabilities()` is not checked. |
| `EXTERNAL_AGENT_APPROVALS_UNSUPPORTED` | `confirmation.approver` or `confirmation.adk: true` on a driver whose `capabilities().approvals` is not `true` (Codex, Gemini CLI, Claude CLI): the runtime decides alone and the setting would be ignored. Only the Claude Agent SDK driver (`ClaudeAgent`) asks the host. A custom driver without `capabilities()` is not checked. See [Approvers and ADK confirmation](#approvers-and-adk-confirmation-need-a-driver-that-asks). |
| `EXTERNAL_AGENT_READ_ONLY_TOOL_UNKNOWN` | A `readOnlyTools` entry that is empty, listed twice, names no direct tool (when `tools` has no toolset), or names two or more direct tools. |
| `EXTERNAL_AGENT_TOOL_NOT_READ_ONLY` | The agent's **own** mode is `read-only` and a direct tool is not in `readOnlyTools`. Add it if it has no side effects, or remove it. |

The checks run in that order, so a typo in `readOnlyTools` is reported as
unknown before an undeclared tool. Toolsets are listed only at run time, so
they are not checked at construction.

When the run is under a `read-only` policy it inherited (for example a
`workspace-write` child of a `read-only` coordinator), hiding the tools is the
designed narrowing, so the agent still builds. The run reports what it hid, in
three places:

- **A warning, always.** One warning per run with the code
  `EXTERNAL_AGENT_TOOLS_HIDDEN` names the hidden, ambiguous and unmatched
  tools. It is logged when the tools are resolved, so it does not depend on how
  the run ends (a driver error, a pause, a run without a final event) or on
  tracing. An ambiguous name also gets its own `ADK_TOOL_AMBIGUOUS_SKIPPED`
  warning.
- **The final event**, when the run completes: `customMetadata.externalAgentTools`
  (on the last error event when there is no final text). A run that fails,
  pauses or ends without a completion has no event copy.
- **The span**, when tracing is on: the attributes
  `gcp.vertex.agent.external_agent.tools.hidden`, `.ambiguous` and
  `.unmatched_read_only`.

```ts
{ hidden: string[]; ambiguous?: string[]; unmatchedReadOnlyTools?: string[]; reason: "read-only" }
```

The names are original names, sorted. Nothing is set when nothing was hidden.

**A `readOnlyTools` entry declares one tool.** If a toolset can add a tool with
the same name (an MCP server that grows a `get_component` that writes), the
declaration is void at run time: neither tool is exposed and the run reports
the name as `ambiguous`. Give read-only tools names that are unique across the
agent's tools and toolsets, or filter the toolset. Edge cases: a toolset whose
`getTools()` fails adds nothing to the count, so a listed direct tool stays
exposed; a tool the bridge would skip anyway (an in-model tool, a tool with no
declaration) still counts, so it makes the name ambiguous. That fails closed.

Read-only MCP servers follow the same model: the host's declaration
(`readOnly: true` with a `tools` list) is the attestation, and the guard
enforces it as an allowlist.

### Confirmations compared with ADK

A tool's `requireConfirmation` and a `toolContext.requestConfirmation()` call
go through the agent's `confirmation` option (an approver, or
`confirmation: { adk: true }` for ADK's protocol). With ADK's protocol the
agent emits an `adk_request_confirmation` call and ends the invocation, as an
`LlmAgent` does, with these differences:

- **Ids.** `originalFunctionCall.id` is an id the bridge generates for the
  call, not the id of a function call event in the session, and
  `originalFunctionCall.name` is the exposed name.
- **Hint and payload.** For `requestConfirmation()`, the tool's own hint is
  kept. For `requireConfirmation`, the hint is
  `Please approve or reject the tool call <name>().`, and for a runtime's own
  permission prompt (a built-in tool under `ask`), the prompt's title or
  `The agent wants to run <tool>. Approve or reject this call.` The
  `toolConfirmation.payload` of the request is always the bridge's
  `{ toolName, description?, reason? }`, not a payload the tool passed. The
  human's answer may carry its own `payload`, which the tool gets in
  `toolContext.toolConfirmation` when it runs again.
- **Matching.** ADK runs the original call again itself. Here the runtime has
  to make the call again on the answer turn, and the answer applies to the
  first call with the same tool name and the same arguments (key order does
  not matter), once. An approved call that the runtime does not make again
  ends the turn with `EXTERNAL_AGENT_CONFIRMATION_UNUSED`.
- **One request per turn.** The turn pauses on the first request; any other
  call that needs a confirmation in the same turn is denied with
  `Another confirmation is already pending.`
- **Answers are checked.** An answer counts only on the turn it is sent and
  only for a request this agent emitted; a forged id or a re-sent answer is
  ignored.

## Extra args

`ClaudeCliDriver` and `CodexCliDriver` place `args` after the flags they set
from the policy, so an entry could override them. The constructor refuses
such an entry with `EXTERNAL_AGENT_OPTION_UNSUPPORTED` unless the driver is
built with `allowPolicyOverrideArgs: true`. It also refuses an entry that
would widen the run another way:

| Driver | Refused besides the policy flags |
|---|---|
| `ClaudeCliDriver` | `--agents` and `--agent` (a subagent definition carries its own tools, permission mode, MCP servers and hooks), `--plugin-url`, `--permission-prompts`, `--worktree`/`-w` (the session root moves to the repository's `.claude/worktrees`, outside a working directory below the repository root), `--remote-control`, `--cloud`, `--teleport` and `--environment` (the session runs or is driven somewhere else). |
| `CodexCliDriver` | `--approve-for-me` and its hidden alias `--not-so-yolo`, `--dangerously-bypass-hook-trust`, `--ignore-rules` (the user and project execpolicy `.rules` files, with their forbidden commands and network rules, are not loaded), `--worktree` (the working root moves under `CODEX_HOME`), a `-c` override of `approvals_reviewer`, `default_permissions`, `permissions` or `agents` (agent roles load their own config files), and a positional word (see below). |

A cluster of one-letter flags is split the way the CLI parses it, so `-pw`
(Claude) and `-hs danger-full-access` (Codex) are refused too, while a flag
that takes a value keeps the rest of the cluster as its value (`-nwork`).

`CodexCliDriver` also refuses a positional word in `args`: an entry that
does not start with `-` and is not the value of the option before it, and
the entries `-` and `--`. `codex exec` would read the word as a subcommand
(`review`, `resume`, `fork`, `help`), which runs another mode than the one
the driver starts, or as the prompt. An option's value is still allowed
(`-o last.txt`, `--color never`). `-i`/`--image` takes one value per entry
in the driver's check, so repeat it for several images (`-i a.png -i
b.png`). A value flag as the last entry (`args: ["-o"]`) is not refused:
the next entry is the driver's `--`, which `codex exec` never takes as a
value, so the run stops at start with a usage error ("a value is required")
before any model turn. `--ignore-user-config` is allowed: it only stops Codex from loading
`$CODEX_HOME/config.toml`, and the driver sets the policy with flags and
`-c` overrides either way. With `--ignore-rules` refused, Codex loads the
project's execpolicy `.rules` files too. They are in the workspace, so an
agent that can write there can change them for a later run; whether a rule
there can loosen the policy, and not only tighten it, was not checked.

`CodexSdkDriver` takes no `args`: the SDK builds the `codex exec` argv
itself, and the prompt goes to stdin. The one value it places as its own
argv entry is the thread id after `resume`, and `codex exec resume` reads
an entry that starts with `-` as an option
(`--dangerously-bypass-approvals-and-sandbox` would parse). The driver
refuses a thread id that starts with `-`, from `runtimeSession.id` or from
session state, with `EXTERNAL_AGENT_OPTION_UNSUPPORTED` before anything
starts. `ClaudeAgentSdkDriver` is not affected: its SDK passes the session
id as `--resume=<id>`.

The list is a denylist: a flag a later CLI adds is not on it. It was
reviewed against Claude Code 2.1.322 and codex-cli 0.167.0 (the `--help` of
each), with `@anthropic-ai/claude-agent-sdk` 0.3.319 (bundling Claude Code
2.1.319) and `@openai/codex-sdk` 0.167.0 (bundling `@openai/codex` 0.167.0)
installed. A test fails when the installed SDKs, the CLIs they bundle or the
peer ranges in `package.json` change, so the list is reviewed again on each
bump. Two limits remain:

- The CLI drivers run the `claude` or `codex` they find (or the `command`
  you set), not the SDK's bundled copy, and nothing checks its version. A
  newer CLI can accept a widening flag the list does not know. Pin the CLI
  version you run to one the list was reviewed against, or review its
  `--help` before upgrading.
- The default Claude tool lists do not include `Agent` (`Task`), so the
  built-in subagents (`general-purpose`, `Explore`, ...) cannot start. When
  `tools` adds `Agent`, the driver passes `--tools` and `--disallowedTools`
  as usual, but whether a built-in subagent stays inside them, the
  permission mode and the sandbox has not been verified against a live run.
  Do not offer `Agent` under `read-only`, `allowedPaths` or another
  restrictive policy until that is verified.

Both Codex drivers also pin `approvals_reviewer="user"` outside
`full-access`. With codex-cli 0.167.0, `approvals_reviewer = "auto_review"`
in `~/.codex/config.toml` turns `--ask-for-approval never` into
`on-request` with a model reviewer, which could grant a command outside the
sandbox.

### Planned changes

0.8 is planned to replace the denylist with an allowlist of known-safe
flags. Every other flag in `args` would then need
`allowPolicyOverrideArgs: true`, as a policy flag does today. Flags that set
or route the model stay refused even with the opt-in, as in 0.7.0 (see
[Model](#model)). This is not in 0.7.0, and the 0.7.0 behavior above stays as
it is.

It would break a host that passes a flag outside the allowlist in the `args`
of `ClaudeCliDriver` or `CodexCliDriver`. A host that passes no `args` is not
affected. Set the model, the turn limit and the system prompt through the
driver options (`model`, and `maxTurns` and `systemPrompt` on
`ClaudeCliDriver`), not through `args`.

What to do now:

- List the flags you pass in `args`.
- If a flag you need would be refused, open an issue in the repository naming
  the flag and the CLI version, so it can join the allowlist.
- Or build the driver with `allowPolicyOverrideArgs: true` knowingly: the
  CLI's handling of a repeated flag then decides, and the run may not keep
  the policy.

## Model

On the built-in drivers, the driver's `model` option is the only model id the
bridge sends, and no `args`, `config` or forwarded environment variable may
set, remap or route the model, except the host configuration listed here.
Host configuration that the run deliberately loads can still change the model
the runtime uses: Claude settings sources under `inheritHostConfig` or
`settingSources`; `--settings`, `--setting-sources`, `--agent`, `--agents`,
`--plugin-dir` and `--plugin-url` passed in Claude CLI `args` under
`allowPolicyOverrideArgs`; the Codex config home and a trusted workspace's
`.codex/config.toml`; and Gemini settings. Where the runtime reports the model
it started with, the run's events show it. A `fallbackModel` switch or an
alias remap may not show there (see "Residuals" below).

### The `model` option

Every built-in driver takes `model` and checks it when it is built. A model
id is a string of 1 to 256 characters, without whitespace or control
characters, that does not start with `-`. Anything else throws
`ExternalAgentPolicyError` with `EXTERNAL_AGENT_MODEL_INVALID`; `""` is no
longer dropped for the default model. The CLI drivers send it joined to its
flag (`--model=<id>`), so it is never read as a flag. The driver's `model`
getter returns it, and `ExternalAgent` writes it to `gen_ai.request.model`.

The model checks are the one deliberate exception to how drivers report bad
options: other invalid values (for example `maxTurns`) still throw
`InputValidationError`.

`requireExplicitModel: true` refuses a driver without a `model`, and a model
that lets the runtime choose, with `EXTERNAL_AGENT_MODEL_REQUIRED`. The
aliases are compared without regard to case:

| Driver | Refused aliases |
|---|---|
| `ClaudeAgentSdkDriver`, `ClaudeCliDriver` | `default`, `best`, `opusplan`, `opusplan[1m]` |
| `GeminiCliDriver` | `auto`, and any id that starts with `auto-` |
| `CodexSdkDriver`, `CodexCliDriver` | none |

Plain aliases (`opus`, `sonnet`, `haiku`, `fable`, `opus[1m]`) stay allowed
for `model`. The two Claude drivers also need `smallFastModel` under
`requireExplicitModel`, and it must be a full id (see
[The small/fast model](#the-smallfast-model-claude)).
Recommended for hosts: set `requireExplicitModel: true`, and use full model
ids (`claude-opus-5-5`, not `opus`), so a model the runtime replaced shows as
a requested id that differs from the reported one.

`reportsResolvedModel` on a driver says whether the runtime reports the model
it ran. It is `true` for the two Claude drivers (the `system/init` model on
`started`, and the `result` model on `completed`) and `false` for Codex,
which reports no model, and Gemini CLI, whose `init` model is kept on
`completed.model` for diagnostics only. `ClaudeCliDriver` emits `started`
with the first output line, so it can carry the init model; its timestamp is
still the start of the run, and it is still the first event on every path.

`ExternalAgent` turns this into `customMetadata.externalAgentModel` on the run's
final event (or its last error event when the run has no final text; partial
events never carry it):

| `status` | When | `resolved`, `modelVersion` |
| --- | --- | --- |
| `reported` | `reportsResolvedModel` is `true` and `completed.model` or `started.model` is a non-empty id | the reported id |
| `not-reported` | `reportsResolvedModel` is `true` and neither event carried an id | absent |
| `unsupported` | `reportsResolvedModel` is not `true`, or the run's `started` has `modelRouting: "plan-mode"` | absent, whatever the events carry |

`externalAgentModel` also carries what the run billed:

| Field | Meaning |
|---|---|
| `smallFast` | the driver's `smallFastModel` pin, when set |
| `used` | every model the run billed, sorted. It is the keys of `usage.byModel`; a run with one billed model has no `byModel`, so a driver with `reportsResolvedModel: true` contributes the model of its `completed` event instead (a routed plan-mode run does not). With neither, `used` is absent: the run's models are unknown (Codex, Gemini). A model the Claude drivers filled from `system/init` because the result had no `modelUsage` (`completed.modelFromInit`) is a guess, not billing: it counts for `resolved` only, and `used` stays absent |
| `unexpected` | the entries of `used` that are none of `requested`, `resolved` or `smallFast`, sorted. Present exactly when `used` is. It is never an error: the run already ran and was billed |
| `warnings` | `["UNEXPECTED_MODEL"]`, only when the driver has `requireExplicitModel` and `unexpected` is not empty |

The same values go to the `gcp.vertex.agent.external_agent.model.small_fast`,
`gcp.vertex.agent.external_agent.models.used` and
`gcp.vertex.agent.external_agent.models.unexpected`
span attributes (`unexpected` only when not empty), and a workflow step's
`result.models` gets the union as `used` and `unexpected`, and is `unknown`
when any external run in it reported no `used`. Comparison is exact string
equality: pass full ids, because an alias in `requested` or `smallFast`
matches nothing in `used`.

`requested` is the driver's `model`, when it has one. A mismatch between
`requested` and `resolved` is a reliable signal only for a **full model id**:
an alias such as `opus` always differs from the full id the runtime reports.
Loaded Claude settings can replace the start model, and a `fallbackModel`
switch in the middle of a run shows only in `usage.byModel`.

### Model-setting `args` and `config`

These are refused when the driver is built with
`EXTERNAL_AGENT_MODEL_OVERRIDE`, **even with `allowPolicyOverrideArgs`**:

| Driver | Flags | Config keys (`-c`/`--config`, or the SDK `config` object) |
|---|---|---|
| `ClaudeCliDriver` | `--model`, `--fallback-model` | - |
| `CodexCliDriver` | `--model`/`-m`, `--oss`, `--local-provider`, `--profile`/`-p` | `model`, `model_provider`, `model_providers`, `oss_provider`, `openai_base_url`, `chatgpt_base_url`, `model_catalog_json`, `model_catalog_url`, `profile`, `profiles` |
| `CodexSdkDriver` | - | the same keys, at any depth of `config` (`{profiles: {x: {model}}}`), quoted (`{'"model"': …}`) or dotted (`{"model_providers.x": …}`) |

Flags are matched in every spelling (`--model x`, `--model=x`, `-mx`, a
cluster such as `-hm x`). A key covers the keys below it (`profiles.x.model`).
Beyond that list, **any config key that contains `model`** (any case, at any
depth: `review_model`, `auto_review_model_override`, `agents.y.model`) is
refused, except the whole-key tuning keys that never choose a model:
`model_reasoning_effort`, `model_reasoning_summary`, `model_verbosity`,
`model_context_window`, `model_auto_compact_token_limit` and
`model_auto_compact_token_limit_scope`. The rule also refuses a config key
that only contains `model` by chance, such as an MCP server named
`model-registry` under `mcp_servers.`: rename the server. Without the
opt-in, `--profile`/`-p`, `profile` and `profiles` are refused by the policy
check first, with `EXTERNAL_AGENT_OPTION_UNSUPPORTED`.

The Codex SDK driver's own `baseUrl` and `apiKey` options are not refused:
they are endpoint and credential choices the host makes on purpose, not model
ids.

The tables were reviewed against Claude Code 2.1.319 (the CLI the Agent SDK
bundles) and codex-cli 0.167.0; the version-bump test covers them with the
policy flag lists.

### Model variables in the environment

A run whose child environment would carry a model variable (compared
without regard to case) is refused before anything starts: `started`, an
`EXTERNAL_AGENT_MODEL_OVERRIDE` error that names the variable (never its
value), and `completed` with `exitCode: 1`.

| Driver | Refused |
|---|---|
| Claude (SDK and CLI) | any variable whose name contains `MODEL` (any case), `CLAUDE_CODE_CLIENT_DATA_URL`, and every `CLAUDE_CODE_3P_*` variable |
| Codex (SDK and CLI) | `OPENAI_BASE_URL`, `CODEX_OSS_BASE_URL`, `CODEX_OSS_PORT` |
| Gemini CLI | `GEMINI_MODEL` |

The Claude rule is a pattern, not a list, because each Claude Code release adds
variables (`CLAUDE_CODE_MODEL_CATALOG`, `ANTHROPIC_CUSTOM_MODEL_OPTION*`,
`CLAUDE_CODE_AUTO_MODE_MODEL`, ...). A drift test
(`tests/agents/driver/model-env-drift.test.ts`) reads the Claude Code binary
bundled with `@anthropic-ai/claude-agent-sdk` and fails when it names a model
variable the rule does not refuse, so a Claude Code upgrade cannot leave a
silent gap. The one reviewed exception is a **region** variable:
`ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION` selects the AWS region of the small
model and never the model id, so a Bedrock host can still place the pin's
region. The `VERTEX_REGION_CLAUDE_*` variables do not match the pattern and
stay allowed for the same reason. Under Bedrock or Vertex, the ids in `used`
may be the provider's own (inference profiles), so "a full id" means the id
the runtime reports under that provider; this was not verified, because there
is no Bedrock or Vertex account to test with.

The built-in providers forward none of them. Only a custom provider whose
`envAllowlist` names one can, and the check comes before every other
pre-spawn refusal. The driver's own `smallFastModel` pin is added after the
check, so a host can never forward `ANTHROPIC_SMALL_FAST_MODEL` itself.

### The small/fast model (Claude)

Claude Code sends some calls to a second, small model instead of the main one.
In Claude Code 2.1.319 these are traced to it: WebFetch's page processing
(`web_fetch_apply`, in the default tool set), the tool-use summary, the
conversation summaries, `mcp_datetime_parse`, the bug-report title,
`extract_memories_first_look`, the artifact comment triage, the plugin
classifier, and `web_search_tool` when its feature flag is on. These were not
traced: `compact`, `generate_session_title`, `agent_summary`, `away_summary`,
`prompt_suggestion`, `hook_prompt` and `side_question`.

`smallFastModel` on `ClaudeAgentSdkDriver` and `ClaudeCliDriver` pins it. The
driver sets `ANTHROPIC_SMALL_FAST_MODEL` in the child environment after the
model environment check, and does not set `ANTHROPIC_DEFAULT_HAIKU_MODEL`,
which would also remap the `haiku` alias for the main model and the
sub-agents. Pinned, the runtime's helper fallback chain is off: it calls
exactly that model. The grammar is the one of `model`
(`EXTERNAL_AGENT_MODEL_INVALID`).

- With `requireExplicitModel`, `smallFastModel` is required
  (`EXTERNAL_AGENT_MODEL_REQUIRED`) and must be a **full model id**: `haiku`,
  `sonnet`, `opus`, `fable`, `default`, `best` and `opusplan`, with or without
  a `[…]` suffix, are refused, because the small model has no `resolved` field
  to absorb an alias. Without `requireExplicitModel` an alias is accepted and
  shows up in `unexpected`.
- Not pinned: the quota and key-check probes of a first-party subscription
  login (they are tiny and use a built-in haiku id), and an organization
  `deniedModels` policy, which replaces a denied pin with the main model. Both
  show in `used` when the runtime bills them.
- `requireExplicitModel` with `inheritHostConfig: true` or a non-empty
  `settingSources` **reports, it does not enforce**. Host settings `env` can
  replace the pin and remap the main model, and the run shows that only in
  `used` and `unexpected`. For an enforced pin, keep the default isolated mode.
- Through the workflow factory, pass `config.smallFastModel`. The run spec has
  no field for it in 0.7.0: the host maps its spec to `smallFastModel` itself.

**Reporting.** `externalAgentModel.used` lists every model the run billed and
`unexpected` the ones nobody asked for (see the field table above). `used`
comes from `usage.byModel` when the runtime reported two or more models; for a
single billed model the Claude drivers put it on `completed.model`, and
`ExternalAgent` uses that for a driver with `reportsResolvedModel: true`. A
model the drivers filled from `system/init` because the result had no
`modelUsage` is flagged (`completed.modelFromInit`) and never counts as
billed. A driver or run with none of these has no `used`, and its workflow
step is `unknown`.

### Gemini CLI read-only runs

The read-only policy maps to Gemini's plan mode (`--approval-mode=plan`),
which may route turns to another model than `--model`. A read-only run with a
`model`, or on a driver with `requireExplicitModel`, is refused before spawn
with `EXTERNAL_AGENT_MODEL_OVERRIDE`. A read-only run without a model still
runs (the CLI picks the model anyway) and its `started` event carries
`modelRouting: "plan-mode"`. To pin a model, use `ask` or `workspace-write`:
both let the agent write files (`ask` after approval), so choose them only if
it may.

### Residuals

- **Codex host config.** `CODEX_HOME` and `HOME` are forwarded, so the host
  `config.toml` still decides the provider and endpoint (`model_provider`,
  `model_providers`, `openai_base_url`), and, without `model`, the model.
  Codex reports no model, so nothing in the run's events confirms it.
- **Codex project config.** Codex 0.167.0 also reads `.codex/config.toml` in
  a trusted workspace, and ignores some keys there. Which provider and
  endpoint keys it accepts from that file was not checked. The file is in the
  workspace, so the agent can write it for a later run.
- **Gemini host settings.** Without `model`, `~/.gemini/settings.json`
  decides. A quota fallback to another model is not reported.
- **Gemini CLI model reporting.** Neither the model on Gemini's `init` line,
  nor plan-mode routing, nor the router aliases (`auto`, `auto-*`) were
  checked against a live Gemini CLI. So the driver trusts no reported model
  (`reportsResolvedModel: false`) and refuses a read-only run with a model.
- **Claude agents and plugins you pass** (`--agent`, `--agents`,
  `--plugin-dir`, `--plugin-url` under `allowPolicyOverrideArgs`): a
  main-thread agent whose `model` is not `inherit` switches the session's
  model, and a plugin can bring such an agent (or a skill with a `model`).
  So the model that runs may not be `model`. Whether `system/init` then
  names the agent's model was not checked against a live CLI.
- **Claude settings you load** (`inheritHostConfig`, `settingSources`,
  `--settings`/`--setting-sources` under `allowPolicyOverrideArgs`) can remap
  aliases (`env.ANTHROPIC_DEFAULT_*_MODEL`), restrict models
  (`availableModels`) or add a `fallbackModel`. Managed (policy) settings
  always load, even when the run is isolated. A replaced start model shows on
  `started` only when `model` is a full id: with an alias the reported id
  always differs. A `fallbackModel` switch happens mid-run and shows only in
  the usage per model.
- **Claude server-side substitution** (organization model lists, entitlement
  and refusal fallbacks) can replace an explicit `--model`; a mid-run switch
  shows only in the usage per model.
- **Codex helper models** (`review_model`, `auto_review_model_override`, the
  compact fallback and the hosted image tool models) cannot be pinned beyond
  the refused override keys, and Codex usage has no per-model breakdown, so
  they are not reported (`used` is absent, the step is `unknown`).
- **Gemini helper models** (the router classifier, loop detection, compression
  and similar flash calls) are not reported: Gemini CLI gives no per-model
  usage, and the CLI is not bundled, so this is not verified here.
- **Helper models and subagents** run other models: Claude's WebFetch helper
  and `Agent`/`Task` subagents (they show only in the usage per model), and
  Codex's `review_model` and subagent model (`agents.default_subagent_model`,
  reachable only through the policy key `agents` under
  `allowPolicyOverrideArgs`), which Codex does not report.

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

On Windows the CLI drivers refuse a `.cmd` or `.bat` command with
`EXTERNAL_AGENT_BATCH_COMMAND_REFUSED`; see
[Windows: batch files and npm installs](#windows-batch-files-and-npm-installs).

The SDK drivers look for the `claude` or `codex` binary under `PATH`, the home
directory, `executableSearchPaths` (Claude), and the `node_modules` of the
host process directory and of the bridge's own install. They skip every
candidate whose real path (symlinks resolved) is at or under a directory the
agent may write: the run's `workingDirectory` (the process directory when it
is unset) and its `allowedPaths`, whatever the mode. The agent can write
there, so a binary it left behind would start the next run outside the
runtime's sandbox. This also skips a `PATH` entry inside the workspace (a
package-manager script adds `node_modules/.bin`). Without a binary found
this way, `CodexSdkDriver` with the network off refuses with
`MISSING_BINARY` rather than list MCP servers through a bare `codex`.

Explicit paths (`CLAUDE_CODE_EXECUTABLE`, `CLAUDE_CODE_PATH`,
`pathToClaudeCodeExecutable`, `CODEX_EXECUTABLE`, `CODEX_CLI_PATH`,
`codexPathOverride`) are used as given; set one if the only copy is inside
the workspace.

What the lookup cannot protect:

- When it finds nothing, each SDK falls back to the binary bundled with its
  own install. If the host, and so the bridge and the SDKs, is installed
  inside a directory the agent can write (a host started from the repository
  the agent edits, with the default `workingDirectory`), the agent can change
  that binary or the installed packages themselves. Install the host outside
  the workspace, or give the run a separate `workingDirectory`. The opt-in
  `strictBinaryResolution` (below) refuses such a run instead.
- With `full-access` the agent can write anywhere the host user can.

### Strict binary resolution

`ClaudeAgentSdkDriver` and `CodexSdkDriver` take `strictBinaryResolution:
true` (default `false`). With it, when no explicit path is set and the lookup
above finds nothing, the run is refused with `MISSING_BINARY` before the SDK
starts if any of these overlaps the run's `workingDirectory` or
`allowedPaths`, that is, it is at or under one of them or one of them is
inside it (such as a package's `vendor` directory). Symlinks are resolved,
and a symlink counts both where it lives and where it points:

- the bridge's own install;
- the SDK package (`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`) as
  Node finds it from the bridge;
- the packages the SDK takes its binary from: its installed platform
  packages, and for Codex `@openai/codex` and its platform package.

It is also refused when the SDK package cannot be located, since then nothing
shows where the fallback would load from. The message names the location and
the fix: set `pathToClaudeCodeExecutable` / `CLAUDE_CODE_EXECUTABLE` or
`codexPathOverride` / `CODEX_EXECUTABLE` to a binary outside the workspace, or
install the host outside it. `CodexSdkDriver` throws
`EXTERNAL_AGENT_OPTION_UNSUPPORTED` when the option is combined with a
prebuilt `sdk` client, whose binary it cannot check.

```ts
const driver = new ClaudeAgentSdkDriver({ strictBinaryResolution: true });
```

The mode narrows the hole, it does not close it:

- It stops the SDK from starting a binary the agent could have replaced, but
  an agent that can write the installed packages can still change the
  JavaScript the host loads on its next start.
- It checks the SDK package Node finds from the bridge's install. An SDK the
  host passes in (`sdk` or `importSdk` for Claude, `Codex` or `importSdk` for
  Codex) is not inspected, so it must come from that same install; an SDK
  imported from a copy inside the workspace can still start the binary
  bundled there.

Only installing the host outside every directory the agent can write closes
it. With the option on, the common setup "host started from the
repository the agent edits, no global `claude` or `codex`" needs an explicit
path. The CLI drivers do not need the option: they never fall back to a
bundled binary, and with no binary outside the workspace they already end the
run with `MISSING_BINARY`.

The CLI drivers start `command` without a shell. With the built-in spawn a
bare `command` (no path separator) is looked up on the child's `PATH`, but
an entry whose real path is at or under the run's working directory (the
process directory when it is unset) or an `allowedPaths` entry is skipped, and
so is every relative or empty entry: under `npm run` / `bun run` `PATH`
starts with `<cwd>/node_modules/.bin`, which the agent can write. When nothing
is left the run ends with `MISSING_BINARY`; pass an absolute `command` to
choose the binary yourself. A `command` with a path separator is used as
given, so a relative one (`./claude`, `node_modules/.bin/claude`) resolves in
the run's working directory, which the agent can write: pass an absolute
path instead. A custom `spawn` gets `command` as given.

## Windows: batch files and npm installs

On Windows the CLI drivers (`ClaudeCliDriver`, `CodexCliDriver`,
`GeminiCliDriver`) look their command up themselves instead of leaving it to
the runtime: over the absolute entries of `PATH`, in the default `PATHEXT`
order (`.com`, `.exe`), never in the working directory, and the spawned path is
always absolute. A batch file is never run. Only a `.com` or `.exe` file is an answer: the three
files `npm install -g` writes (an extensionless shell shim, `.cmd` and `.ps1`)
are skipped when a native file comes later on `PATH`, so an npm shim does not
hide a real `.exe`. When the command itself is a batch file, or only a batch file is found
(the shim `npm install -g` creates, such as `gemini.cmd`), the run ends with
`EXTERNAL_AGENT_BATCH_COMMAND_REFUSED`: running it goes through `cmd.exe`,
which parses the prompt and the other arguments again, so a prompt with `&` or
`|` could run as a command. Nothing found is `MISSING_BINARY`, as elsewhere.
`PATH` entries at or under the run's working directory (or `allowedPaths`) are
never searched; a command with a directory in it is your choice and is used
as given, with or without its extension. macOS and Linux are unchanged.

What to run instead depends on the CLI:

| CLI | Supported route on Windows |
|---|---|
| Claude | The native `claude.exe` from Claude's native installer. Put it on `PATH` or set `command` to its path. |
| Codex | The native `codex.exe` inside the `@openai/codex` package: `<npm root -g>\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe` (`codex-win32-arm64` and `aarch64-pc-windows-msvc` on ARM). That is the layout of `@openai/codex` 0.167.0, read from the `@openai/codex-sdk` 0.167.0 lookup this package pins; older versions keep it at `vendor\<triple>\codex\codex.exe`. It was not checked on a Windows machine. To find it for another version, search `npm root -g` for `codex.exe`. Set `command` to its path. |
| Gemini | Gemini CLI ships only as an npm package, so there is no `.exe`. Set `interpreter` to Node and `entry` to the package's JavaScript entry, the file named by `bin.gemini` in `@google/gemini-cli`'s `package.json`. The driver runs `<interpreter> <entry> <flags>`; see [Interpreter and entry](#interpreter-and-entry). |

### Interpreter and entry

`ClaudeCliDriver`, `CodexCliDriver` and `GeminiCliDriver` take `interpreter`
and `entry` (both or neither, and not with `command`). The driver then runs
`<interpreter> <entry> <its flags> <args>` instead of `<command> <its flags>
<args>`, on every platform. It is meant for a CLI that ships as a JavaScript
package, Gemini CLI on Windows above all:

```ts
import { GeminiCliDriver } from "adk-llm-bridge/agents";

const driver = new GeminiCliDriver({
  // Node only. A bare name is looked up on PATH like `command`; an absolute path is used as given.
  interpreter: String.raw`C:\Program Files\nodejs\node.exe`,
  // The file named by `bin.gemini` in @google/gemini-cli's package.json.
  entry: String.raw`C:\Users\me\AppData\Roaming\npm\node_modules\@google\gemini-cli\bundle\gemini.js`,
});
```

The rules, all fail closed:

- The interpreter never starts in the run's working directory. The CLI
  process runs on the host, outside the runtime's sandbox, and that
  directory is the agent's: an interpreter or a version-manager shim that
  reads configuration from its working directory, or from the directories
  above it, would read files the agent wrote. Bun reads `bunfig.toml` (its
  `preload` runs code) and `.env`; asdf reads `.tool-versions`, where
  `nodejs path:<dir>` makes it run `<dir>/bin/node`, a program the agent
  chose; proto's native shims read `.prototools`; Volta's Windows `node.exe`
  reads the version pin from `package.json`. So the driver starts the
  interpreter in the entry's own directory (canonical, symlinks resolved),
  and Node changes into the workspace itself before the entry runs:

  ```text
  cwd: <the entry's directory>
  env: ADK_LLM_BRIDGE_AGENT_CWD=<the run's working directory>, plus the run's environment
  run: <interpreter> --import data:text/javascript,<fixed preload> <entry> <its flags> <args>
  ```

  `<entry>` is the entry's canonical path, the one the checks below saw,
  not the path as configured: a symlink on the way that passes through a
  directory the agent can write cannot be re-pointed between the check and
  the start (the interpreter is likewise started by its checked real path).
  The preload reads the workspace from `ADK_LLM_BRIDGE_AGENT_CWD`, removes
  the variable, and calls `process.chdir` (and sets `PWD`), so the CLI sees
  the workspace as `process.cwd()`, as with `command`. The preload's URL is a
  constant: the workspace path never becomes part of code. A missing
  variable or a failed `chdir` throws, and Node exits non-zero before the
  entry runs; the run ends with the CLI's exit error. The entry's directory
  must not be at or under an agent-writable root or a temp directory a
  runtime sandbox keeps writable (`/tmp`, the host temp directory, `TMPDIR`,
  `CLAUDE_CODE_TMPDIR`), which also means no directory above it is one;
  otherwise the run is refused with `EXTERNAL_AGENT_INTERPRETER_UNSAFE`.
  This closes configuration reads from the working directory for every kind
  of interpreter and shim, including ones the checks below would not catch.
- Only the native Node binary runs an entry (defense in depth). The
  interpreter's real path (symlinks resolved) must be named `node`
  (`node.exe` on Windows, any letter case), and that file must be a native
  executable for the platform: its first bytes are read through one open
  file descriptor and must be PE (`MZ`) on Windows, Mach-O (thin or
  fat/universal, either byte order) on macOS, or ELF elsewhere. A script
  (`#!`), an empty or truncated file, any other name, or a real file inside
  an agent-writable root or a sandbox temp directory is refused with
  `EXTERNAL_AGENT_INTERPRETER_UNSAFE` before any spawn. Symlink shims
  (`mise`, `volta`) fail the name check; script shims (`asdf`, `nodenv`)
  fail the native-executable check; `nvm` puts the real binary on `PATH` and
  passes. With a custom `spawn` the same checks apply to a path that exists
  on this host; a bare name must be `node`. The built-in spawn starts the
  real path it checked, not the name or symlink that led to it. Use the real
  binary, for example the output of `node -p process.execPath`.
- Node itself reads no configuration file from its working directory
  without a flag: with a planted `bunfig.toml`, `.env`, `node.config.json`,
  `.npmrc`, `package.json` and `node_modules`, none was read, and a bare
  `require` from the entry searched only the entry's parent directories,
  never the working directory. Its environment comes from the driver's
  allowlist, so `NODE_OPTIONS` cannot reach it. Bare `require` from the
  entry also searches `~/.node_modules` and `~/.node_libraries`: do not put
  the home directory in a run's `allowedPaths` (it is not, by default).
- Residuals, host-only: a non-Node native program the host installed under
  the name `node` passes the checks (it still starts outside the workspace);
  and Node cannot start a process from an open file descriptor, so the file
  is opened again by path at spawn time, after the check. It is outside
  every directory the agent can write, so only the host can change it in
  between.
- `interpreter` follows the `command` rule. A bare name is looked up over the
  absolute `PATH` entries outside the run's working directory and
  `allowedPaths`; on Windows only a native `.exe` or `.com` is an answer, and
  a `node.cmd` is refused with `EXTERNAL_AGENT_BATCH_COMMAND_REFUSED`, so
  nothing runs through `cmd.exe`. A relative path (`bin/node`) is rejected
  when the driver is built.
- `entry` must be an absolute path (checked when the driver is built). With
  the built-in spawn it must be an existing file, or the run ends with
  `MISSING_BINARY` naming it.
- Neither the entry nor an interpreter given as a path may be at or under
  the run's working directory, an `allowedPaths` root or a sandbox temp
  directory, symlinks resolved: the agent could rewrite the file in one run
  and have the next run execute it on the host, outside the runtime's
  sandbox. Such a run is refused with `EXTERNAL_AGENT_INTERPRETER_UNSAFE`
  before anything starts. Install the CLI package outside every directory an
  agent can write (a global npm root, a tools directory), not under a temp
  directory. Unlike `command`, this check applies to an explicit path too,
  and also with a custom `spawn`.
- The driver's own flags and the `args` checks are unchanged; the preload
  and the entry only come first. `CodexCliDriver` lists its MCP servers the
  same way (`<interpreter> --import <preload> <entry> mcp list --json`, same
  `cwd` and variable); a custom `listMcpServers` receives them as
  `prefixArgs`, `cwd` and `env` and must run the listing the same way.
- A custom `spawn` receives the interpreter as `command` (its checked real
  path when the configured path exists on this host), the preload and the
  entry's canonical path as the first arguments, the entry's directory as `cwd`, and the
  variable in `env`. It must keep all three, or the CLI starts in the wrong
  directory or not at all.

The Windows CI job runs a fake JavaScript entry through the native
`node.exe` (from `tests/agents/driver/cli-interpreter-entry.test.ts` under Bun
and `scripts/windows-shim-smoke.mjs` under Node) with a prompt `cmd.exe`
would re-parse, and checks that the prompt arrives intact and that the CLI
starts in the workspace. The same tests check that Bun as the interpreter is
refused, that a planted `bunfig.toml` preload never runs, that a script shim
named `node` (`node.exe` on Windows) is refused, that an entry in a temp
directory is refused, and that a failed `chdir` fails the run. On macOS and
Linux a compiled proto-style shim named `node`, which reads `.tool-versions`
from its working directory and the directories above it, never sees the
workspace's file.

A custom `spawn` remains possible, for example to run the CLI in a
container:

```ts
import { spawn as nodeSpawn } from "node:child_process";
import { GeminiCliDriver, type GeminiCliSpawn } from "adk-llm-bridge/agents";

// The file named by `bin.gemini` in @google/gemini-cli's package.json.
const entry = String.raw`C:\Users\me\AppData\Roaming\npm\node_modules\@google\gemini-cli\bundle\gemini.js`;

const spawn: GeminiCliSpawn = (_command, args, options) => {
  const child = nodeSpawn(process.execPath, [entry, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    exited: new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    }),
    kill: (signal) => child.kill(signal),
  };
};

const driver = new GeminiCliDriver({ spawn });
```

`tests/agents/driver/windows-command.test.ts` runs this rerouting against a
fake process. Prefer `interpreter` and `entry`: they keep the bridge's
lookup and the writable-root check. The policy (`allowNetwork`, paths) applies as for any other
run; the custom `spawn` only replaces how the process starts.

## Error codes

An error event's code lands on the ADK event's `errorCode`. The constants are
exported from `adk-llm-bridge/agents`. They come from two places, and
`EXTERNAL_AGENT_` alone does not tell them apart:

- **Policy refusals** (`ExternalAgentPolicyErrorCode`, the `code` of
  `ExternalAgentPolicyError`): `EXTERNAL_AGENT_ISOLATION_VIOLATED`,
  `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE`, `EXTERNAL_AGENT_PATHS_UNENFORCEABLE`,
  `EXTERNAL_AGENT_DEPENDENCY_MISSING`, `EXTERNAL_AGENT_MISSING_BINARY`
  (value `MISSING_BINARY`), `EXTERNAL_AGENT_BATCH_COMMAND_REFUSED`,
  `EXTERNAL_AGENT_CREDENTIAL_UNSUPPORTED`, `EXTERNAL_AGENT_OPTION_UNSUPPORTED`,
  `EXTERNAL_AGENT_MODEL_INVALID`, `EXTERNAL_AGENT_MODEL_REQUIRED` and
  `EXTERNAL_AGENT_MODEL_OVERRIDE`. A driver raises them; during a run the
  agent turns them into a non-recoverable error event, so you read them from
  `errorCode`. `EXTERNAL_AGENT_OPTION_UNSUPPORTED`,
  `EXTERNAL_AGENT_MODEL_INVALID` and `EXTERNAL_AGENT_MODEL_REQUIRED` are
  thrown to you by the driver's constructor, and so is
  `EXTERNAL_AGENT_MODEL_OVERRIDE` for `args` and `config`.
- **Agent event codes**: `EXTERNAL_AGENT_ERROR`,
  `EXTERNAL_AGENT_TRANSFER_FAILED`, `EXTERNAL_AGENT_NOT_CONFIGURED`,
  `EXTERNAL_AGENT_CONFIRMATION_UNUSED`,
  `EXTERNAL_AGENT_TOOL_CREDENTIAL_REQUIRED` and
  `EXTERNAL_AGENT_TOOL_RESULT_TOO_LARGE`. `ExternalAgent` emits them as error
  events; they are never thrown.

`EXTERNAL_AGENT_TOOL_NOT_OFFERED` is not an error code: it is the value of
`metadata.isolation` on the `tool_result` of a call the runtime refused
because the tool was not offered. The other codes in the table (`CLAUDE_*`,
`CODEX_*`, `GEMINI_*`) are reported by one driver and have no constant.

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
| `EXTERNAL_AGENT_BACKGROUND_TASK_PENDING` | `EXTERNAL_AGENT_BACKGROUND_TASK_PENDING` | No | A Claude run (SDK or CLI driver) reached its result while Claude Code still reported a background task (from `system/background_tasks_changed`; ambient tasks do not count). The task's work is not done; the run ends with exit code 1. Background tasks are off by default (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`); `allowBackgroundTasks: true` turns them on. |
| `EXTERNAL_AGENT_CREDENTIAL_UNSUPPORTED` | `EXTERNAL_AGENT_CREDENTIAL_UNSUPPORTED` | No | The credential provider returned a `kind` other than `env` or `none`. |
| `EXTERNAL_AGENT_OPTION_UNSUPPORTED` | `EXTERNAL_AGENT_OPTION_UNSUPPORTED` | No | Thrown (not an event) when a driver is built with an option its runtime cannot honor: `sessionStore` on `ClaudeCliDriver`. |
| `EXTERNAL_AGENT_MODEL_INVALID` | `EXTERNAL_AGENT_MODEL_INVALID` | No | Thrown when a driver is built with a `model` that is not a model id (not a string, empty, over 256 characters, with whitespace or a control character, or starting with `-`). See [Model](#model). |
| `EXTERNAL_AGENT_MODEL_REQUIRED` | `EXTERNAL_AGENT_MODEL_REQUIRED` | No | Thrown when a driver with `requireExplicitModel: true` has no `model`, or a router or default alias (`default`, `best`, `opusplan`, Gemini `auto`), or a Claude driver has no `smallFastModel` or one that is an alias instead of a full id. |
| `EXTERNAL_AGENT_MODEL_OVERRIDE` | `EXTERNAL_AGENT_MODEL_OVERRIDE` | No | Something other than `model` would set or route the model: thrown for model-setting `args` or Codex SDK `config` keys (even with `allowPolicyOverrideArgs`); an error event for a model variable in the run's environment, or a Gemini CLI read-only run with a model (plan mode may route turns to another model). |
| `CLAUDE_SESSION_STORE_MIRROR_ERROR` | `CLAUDE_SESSION_STORE_MIRROR_ERROR` | Yes | The Claude Agent SDK dropped a transcript batch its `sessionStore` rejected or timed out on (3 attempts in total); the run goes on. See [Persisting Claude sessions](claude-session-store.md). |
| `MISSING_BINARY` | `EXTERNAL_AGENT_MISSING_BINARY` | No | The `claude`, `codex` or `gemini` binary was not found, or, with `interpreter` and `entry`, the interpreter or the entry file. |
| `EXTERNAL_AGENT_BATCH_COMMAND_REFUSED` | `EXTERNAL_AGENT_BATCH_COMMAND_REFUSED` | No | On Windows, the CLI command (or `interpreter`) is or resolves to a `.cmd` or `.bat` file (for example an npm shim). Remedy per CLI: [Windows: batch files and npm installs](#windows-batch-files-and-npm-installs). |
| `EXTERNAL_AGENT_INTERPRETER_UNSAFE` | `EXTERNAL_AGENT_INTERPRETER_UNSAFE` | No | The driver's `entry`, or its `interpreter` given as a path, (or the entry's directory, where the interpreter starts) is at or under the run's working directory, an `allowedPaths` root or a temp directory a runtime sandbox keeps writable (symlinks resolved), or the interpreter is not the native Node binary (its real path is not named `node`/`node.exe`, or the file is not a native executable, such as an asdf or nodenv script shim). Install the CLI outside every directory the agent can write; see [Interpreter and entry](#interpreter-and-entry). |
| `CLAUDE_CLI_EXIT`, `CODEX_CLI_EXIT`, `GEMINI_CLI_EXIT` | - | From the message | The CLI exited with a nonzero code (Codex: and reported no error of its own). The message holds the stderr tail; auth, billing and quota failures are not recoverable. |
| `CLAUDE_PERMISSION_DENIED` | - | No | The Claude Agent SDK denied a tool call (the message names the tool and the reason). |
| `CLAUDE_AGENT_SDK_ERROR` | - | From the message | The Claude Agent SDK threw; used when the message matches no known failure. |
| `CLAUDE_AGENT_SDK_RESULT_ERROR` | - | From the message | A Claude Agent SDK `result` reported an error with no known subtype. A known subtype such as `error_max_turns` gives its code instead (`MAX_TURNS_EXCEEDED`). |
| `CODEX_TURN_FAILED` | - | From the message | A Codex SDK `turn.failed` event. |
| `CODEX_SDK_STREAM_ERROR` | - | From the message | A Codex SDK `error` stream event. |
| `CODEX_SDK_ERROR` | - | From the message | The Codex SDK threw. |
| `CODEX_SDK_INPUT_NOT_DELIVERED` | - | No | Codex did not read the prompt from stdin: it closed stdin while it kept running (the driver stops it), it exited 0 without reading it, or a process it started kept the pipe without reading. A Codex that exits non-zero before reading reports `CODEX_SDK_ERROR` with its stderr instead. Neither ends the host process; see [Codex SDK prompt delivery](#codex-sdk-prompt-delivery). |
| `CODEX_ITEM_ERROR` | - | From the message | A Codex SDK `error` item. |

"From the message" means `classifyRecoverable` sorts the message. Auth,
billing, quota and missing-binary failures are not recoverable; rate limits,
timeouts and other transport failures are, and so is any message that matches
nothing. For the SDK codes above, a message that matches a known failure
reports that failure's code instead (for example `RATE_LIMIT` or
`QUOTA_EXHAUSTED`); the CLI exit codes stay as shown, and for them only the
last stderr line is sorted. A Codex CLI that writes to stderr and exits 0 only
logs a `CODEX_CLI_STDERR` warning.

### Codex SDK prompt delivery

`@openai/codex-sdk` writes the prompt to the codex process's stdin without
an `error` listener on that stream. If the process is gone before it has read
the whole prompt (it exited early, the run was aborted, or it closed stdin),
the failed write would be an uncaught `EPIPE` that ends the host process. With
a prompt larger than the pipe buffer this happens at any exit time, not only
right after the start.

`CodexSdkDriver` therefore replaces the exec of the client it uses (the one it
builds and a prebuilt `sdk` client) with a copy of the SDK's exec path that
handles the error. The copy sends the same arguments and environment and uses
the same binary and abort signal. The result:

- An abort is reported as before.
- A non-zero exit of codex's own is `CODEX_SDK_ERROR` with its stderr, as
  before.
- A prompt codex did not read in any other way is `CODEX_SDK_INPUT_NOT_DELIVERED`.
  A codex that closed stdin and kept running is stopped.

The copy follows `@openai/codex-sdk` 0.167.0, and the driver uses it only on
that version. The optional peer is exactly `0.167.0`, and on each run the
driver also reads the installed SDK's version (from the `package.json` beside
the resolved `@openai/codex-sdk` entry, once per process), because a package
manager can still install another one. The run is refused with
`EXTERNAL_AGENT_DEPENDENCY_MISSING`, before codex starts, when:

- the installed version is another one, such as 0.167.1. Its exec may build a
  different command line, so the driver does not run the 0.167.0 copy for it.
  The message names the supported version, the installed one and the ways
  forward: install `@openai/codex-sdk@0.167.0`, set
  `allowUncontainedCodexSdk: true`, or use `CodexCliDriver`;
- the version cannot be read. The driver finds the SDK with
  `import.meta.resolve`, so a bundler that rewrites or drops that call (or
  inlines the SDK without its `package.json`) makes every Codex SDK run fail
  closed with this message. Keep `@openai/codex-sdk` external to the bundle;
- the version is 0.167.0 but the client's exec does not have the 0.167.0
  fields.

The version checked is the one the bridge resolves, not the copy a prebuilt
`sdk` client came from: a prebuilt client must come from the same
`@openai/codex-sdk` install the bridge resolves. A client from another copy
(a second version nested under the host's own dependencies) is checked only
by the shape of its exec, not by its version.

A client with no SDK exec (for example a test double) is used as is.
`CodexCliDriver` writes the prompt through its own spawn helper, which already
handles the error.

#### Running another SDK version uncontained

`allowUncontainedCodexSdk: true` lets a host run an installed SDK version the
driver cannot contain (a patch release such as 0.167.1, or a version it cannot
read) instead of being refused. Such a run goes through the SDK's own exec
**without the containment**: a codex that exits, is aborted or closes stdin
before it has read the prompt can again end the host process with an uncaught
`EPIPE`. The driver logs one `CODEX_SDK_UNCONTAINED` warning per driver
instance. On 0.167.0 the option changes nothing: the contained copy is still
used, and a client whose exec does not match 0.167.0 is still refused.

The optional peer is exactly `0.167.0`, so npm (7 and later) fails with
`ERESOLVE` when another version is installed beside the bridge. With npm,
override the bridge's peer with the version the host installs:

```json
{
  "dependencies": {
    "adk-llm-bridge": "^0.7.0",
    "@openai/codex-sdk": "0.167.1"
  },
  "overrides": {
    "adk-llm-bridge": {
      "@openai/codex-sdk": "$@openai/codex-sdk"
    }
  }
}
```

or install with `npm install --legacy-peer-deps`. Bun and pnpm install it
without failing on the peer.

#### Supporting a new SDK version

A new 0.167.x patch (or a later release) becomes supported when it is added to
the verified list, `SUPPORTED_CODEX_SDK_VERSIONS` in
`src/agents/driver/codex-sdk-exec.ts`, together with the exact peer range. That
happens only after the copied `CodexExec.run` is compared with the new SDK's,
and the pin test (`tests/agents/driver/codex-sdk-exec.test.ts`) and the fault
tests (`tests/agents/driver/codex-sdk-epipe.test.ts`) pass on it.

The copy is temporary. It stays until `@openai/codex-sdk` handles stdin errors
itself, and is removed once an SDK version with that fix is verified: the
fault tests pass on it with the SDK's own exec.

A prebuilt `sdk` client is changed in place: its exec is replaced on the first
run, so the host's own later uses of that client go through the contained
copy too.

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
`"invalid-resume"`). `"llm-calls-limit"` covers both a thrown
`LlmCallsLimitExceededError` and the error event a real `LlmAgent` yields when
it goes over the shared `maxLlmCalls`. The registries throw `InputValidationError` from
`@google/adk` for an empty provider id or an unknown provider.
