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
parent sets no `allowedPaths`, and only for that child: a session created
from the child's session (a workflow step, for example) gets `[]` for them.
Use absolute or `~` roots for delegated agents. An empty intersection, or an
empty list on either side, allows no path.

The derived policy also keeps both sides' absolute roots as `pathBounds`, and
the guard checks every bound when a request arrives. A kept root that a
symlink later points outside the parent's roots (a link created or retargeted
after delegation) is therefore still denied.

### Reading wider than you write

`allowedPaths` is one list for reads and writes. The path guard checks the
path arguments of read tools (`Read`, `Glob`, `Grep`, `read_file`,
`read_many_files`) against it exactly as it checks write tools, so a writer
confined to `out/` cannot read `src/`: the call is denied with "outside the
paths allowed by this agent's policy". There is no separate read root, and a
delegated agent cannot get roots wider than its parent's (the intersection
in the previous paragraphs). The only reads the guard does not see are the ones inside a shell
command, which is a gap, not a way to grant read access.

To give a step more read access than write access:

- **Split the step.** Run a `read-only` agent whose `allowedPaths` cover what it
  must read (it can write nothing), and pass what the writer needs as the
  writer's step input or session state. The writer keeps roots that cover only
  what it may change.
- **Put the material inside the writer's roots.** Copy (not symlink: a link
  that leaves the roots is denied) what it must read into a directory that its
  `allowedPaths` include. The guard does not make that copy read-only, so use
  the first option when the writer must not change it.
- **One agent with wide roots.** If its `allowedPaths` cover both, it can also
  write everywhere they cover. Choose this only when that is acceptable.

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
  the workspace, or give the run a separate `workingDirectory`.
- With `full-access` the agent can write anywhere the host user can.

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
| Gemini | Gemini CLI ships only as an npm package, so there is no `.exe`. Pass a `spawn` that runs `process.execPath` (Node) with the package's JavaScript entry, the file named by `bin.gemini` in `@google/gemini-cli`'s `package.json`. A custom `spawn` does not go through the bridge's own spawn, so nothing runs through `cmd.exe`. |

The Gemini route, as code:

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
fake process. The policy (`allowNetwork`, paths) applies as for any other
run; the custom `spawn` only replaces how the process starts.

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
| `EXTERNAL_AGENT_BATCH_COMMAND_REFUSED` | `EXTERNAL_AGENT_BATCH_COMMAND_REFUSED` | No | On Windows, the CLI command is or resolves to a `.cmd` or `.bat` file (for example an npm shim). Remedy per CLI: [Windows: batch files and npm installs](#windows-batch-files-and-npm-installs). |
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
