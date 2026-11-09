# Migrating to 0.7.0

0.7.0 is the first npm release after 0.5.3. Version 0.6.0 was published on
GitHub only, so npm users go straight from 0.5.3 to 0.7.0. This guide covers
that whole step. If you installed the 0.6.0 GitHub tag, see
[Coming from the 0.6.0 tag](#coming-from-the-060-tag) at the end.

The full list of changes is in the [CHANGELOG](../CHANGELOG.md#070---unreleased).

## 1. Runtime and peers

| Requirement | 0.5.3 | 0.7.0 |
|---|---|---|
| Node.js | `>=18` | **`>=22`** (`openai` 7 requires it) |
| `@google/adk` | `>=0.5.0 <2` | **`>=2.4.0 <3`** |
| `@google/genai` | not declared (comes with ADK) | **required peer** `>=2.29.1 <3` (3.x is not supported yet) |
| `@opentelemetry/api` | not used | **required peer** `>=1.9.1 <2` |
| `zod` | not declared | optional peer **`^4`** (ADK 2.4 requires zod 4) |

```bash
npm install adk-llm-bridge@0.7.0 @google/adk@^2.4.0 @google/genai@^2.29.1 @opentelemetry/api
```

Most package managers install a matching `@google/genai` together with ADK. If
you add it yourself, pin it to the supported range (`@google/genai@^2.29.1`): an unpinned install
can pick 3.x, which is outside the supported range.

The package is ESM only. Use `import`, or `await import()` from CommonJS.

Upgrade ADK first by following ADK's own 2.x notes. ADK 2 changes
`InvocationContext` and the event types that custom agents and plugins use.

## 2. Provider errors are thrown by default

In 0.5.3, a failed provider call came back as an `LlmResponse` with
`errorCode` and `errorMessage`. In 0.7.0 the default is
`errorMode: "throw"`: the provider throws a `ProviderLlmError`. That is what
ADK's `onModelErrorCallback` and `RoutedLlm` failover need.

What to change:

- **If you handled errors in `afterModelCallback`**, move that logic to
  `onModelErrorCallback`. In throw mode `afterModelCallback` no longer sees
  provider errors.
- **To recover from an error**, return an ADK `Event` built with
  `createEvent(...)` from `onModelErrorCallback`, not a bare `LlmResponse`.
  ADK 2.4 reads `actions` from the returned value and fails on a plain object.
- **Read the text from `error.detail`.** `error.message` is a JSON string
  (`{"error":{"code":...,"message":...}}`) because ADK parses it to fill the
  event's `errorCode`. `error.code`, `error.status`, `error.provider` and
  `error.cause` are also available.
- **To keep the old behavior**, set `errorMode: "response"`:

```typescript
import { AIGateway, setProviderConfig } from 'adk-llm-bridge';

// Per model:
const model = AIGateway('openai/gpt-5', { errorMode: 'response' });

// Or globally, for one provider:
setProviderConfig('ai-gateway', { errorMode: 'response' });
```

Related behavior changes:

- Truncated or invalid tool-call arguments now end the turn with
  `finishReason: MALFORMED_FUNCTION_CALL` (and an `errorCode`), instead of
  calling the tool with `{}`. ADK's `ReflectAndRetryModelPlugin` can retry
  them.
- `candidateCount` other than `1` is rejected on OpenAI-compatible providers.
  Send separate requests if you need several candidates.
- **Streams cut short now fail.** A stream that ends before its final chunk
  reports `INCOMPLETE_STREAM` (`PROVIDER_ERROR_INCOMPLETE_STREAM`). Discard the
  partial text, or retry, when you see it.

## 3. Logging and validation

- Warnings no longer use `console.warn`. They go through ADK's logger with the
  `[adk-llm-bridge]` prefix and a stable code (for example
  `BUILTIN_TOOLS_DROPPED`). Use ADK's `setLogger` / `setLogLevel` to capture or
  silence them.
- Invalid configuration (for example an empty API key or model id) throws
  ADK's `InputValidationError`. Credentials are redacted from the message.
- **Integer options are checked.** `timeout`, `maxRetries` and Anthropic
  `maxTokens` throw `InputValidationError` for a non-integer (for example
  `1500.5`, or `Number(process.env.X)` when X is unset, which is `NaN`), and
  `timeout` throws above 2147483647 ms. `register*()` checks them too. Round or
  validate values before passing them; `null` still means the default.
- Each warning names its stable code in the message:
  `[adk-llm-bridge] [BUILTIN_TOOLS_DROPPED] dropping ...`. A custom logger
  that read the code from the second argument (`{ code }`) reads it from the
  message instead, for example with `/^\[adk-llm-bridge\] \[([^\]]+)\]/`.
- Register functions are typed per provider (`registerOpenAI(options:
  OpenAIRegisterOptions)` and so on). Code that passed options of another
  provider, or misspelled keys, no longer compiles.
- On Anthropic, a user tool named `json_output` together with
  `responseSchema` / `responseJsonSchema` throws `InputValidationError`.
  Rename the tool.
- Anthropic structured output (non-streaming) carries integers beyond 2^53 as
  strings, as streaming did. Declare such fields as `z.string()` or a union.
- AI Gateway reads only `AI_GATEWAY_API_KEY` and `AI_GATEWAY_URL`. It no
  longer falls back to `OPENAI_API_KEY` / `OPENAI_BASE_URL`, so it never sends
  an OpenAI key to `ai-gateway.vercel.sh`. Set `AI_GATEWAY_API_KEY` (or pass
  `apiKey`) if you relied on the fallback. AI Gateway, OpenRouter, xAI and
  custom providers no longer send `OPENAI_ORG_ID` / `OPENAI_PROJECT_ID` as
  `OpenAI-Organization` / `OpenAI-Project` headers. A custom endpoint that
  needs them can set them in its `headers` option.
- The OpenAI provider sends `maxOutputTokens` as `max_completion_tokens` for
  every model. A proxy behind `OPENAI_BASE_URL` that only knows `max_tokens`
  needs `registerCustomProvider` instead. `gpt-<N>` with N of 5 or more
  (`gpt-6.1-sol`, ...) and `o<N>` are reasoning models on every provider:
  `temperature`, `top_p`, stop sequences, penalties and logprobs are dropped
  for them, and `thinkingConfig` maps to `reasoning_effort`.

## 4. Usage metadata

- Anthropic `promptTokenCount` now includes cache-read and cache-creation
  tokens, as ADK expects. Cached tokens are also reported in
  `cachedContentTokenCount`. If you added the cache counts yourself, stop
  doing so.
- On OpenAI-compatible providers, `candidatesTokenCount` follows OpenAI's
  `completion_tokens` and includes reasoning tokens; `thoughtsTokenCount`
  reports the reasoning part. Do not add the two.

## 5. Telemetry

`@opentelemetry/api` is now a peer: install it (see section 1). Nothing is
recorded until you register an OpenTelemetry provider.

To keep message content out of traces on ADK 2.4, set both variables:

```bash
OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=NO_CONTENT  # the bridge's spans
ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false                     # ADK's own spans
```

When the `OTEL_...` variable is not set, the bridge's spans follow
`ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS` too.

## 6. External agents (`adk-llm-bridge/agents`)

External agents were added in 0.6.0 (GitHub only), so for npm users they are
new in 0.7.0. If you already use them, these changes apply:

- **Delegation result.** By default (`delegation: { finalAnswer: "subagent" }`)
  the delegated sub-agent's answer is final: the `transfer_to_agent` response
  carries `skipSummarization: true`, as with ADK's native transfer. To let the
  coordinator write the final answer after delegating (fan-out, aggregation),
  set `delegation: { finalAnswer: "coordinator" }`.
- **`transfer_to_agent` arguments** are `{ agent_name }` (ADK 2.1+), not
  `{ agentName }`. Update code that reads these events.
- **Delegation events** always have the native ADK shape: a
  `transfer_to_agent` call and response, and the sub-agent's events on the
  root branch. `ExternalAgent` has no option for the old `run_adk_subagent`
  shape. `nativeDelegationShape: false` exists only on `ToolGatewayConfig`,
  for hosts that build a `ToolGateway` themselves.
- **Permissions.** A child agent can no longer run wider than the agents above
  it, even through intermediate ADK agents or a direct resume. If a child
  relied on a wider policy than its parent, widen the parent or run the child
  outside that chain. ADK `AgentTool` still starts a new permission chain.
- **Confirmations.** The new `confirmation` option (an in-process approver, or
  ADK's `adk_request_confirmation` flow) can ask a person before a tool runs.
  It never widens the policy, and `read-only` is never confirmable.
- **Codex outside a git repository.** Codex refuses to run outside a trusted
  git repository. Pass `skipGitRepoCheck: true` to `CodexSdkDriver` or
  `CodexCliDriver` if you run it from a temporary directory.
- **Errors.** Error codes no longer name a provider. A usage cap from any
  runtime is the non-recoverable `QUOTA_EXHAUSTED` (was
  `CODEX_QUOTA_EXHAUSTED` for Codex only); `CLAUDE_RATE_LIMIT` is
  `RATE_LIMIT`, `CLAUDE_AUTH_ERROR` is `AUTH_ERROR`, `error_max_turns` is
  `MAX_TURNS_EXCEEDED`. To compare stored codes, pass them through
  `normalizeRecoverableErrorCode()`; the full table is in
  [External agent isolation](external-agent-isolation.md), "Classified
  codes". Codex CLI stderr on exit 0 is a logged `CODEX_CLI_STDERR` warning,
  not an error event.
- **Capabilities** are declared only by drivers (`driver.capabilities?.()`);
  definitions no longer have a `capabilities` field
  (`CLAUDE_AGENT_DEFINITION.capabilities` becomes
  `new ClaudeAgentSdkDriver().capabilities()`).
- **Definitions.** A custom `ExternalAgentDefinition` whose `createDriver`
  takes no argument still works; to accept `driverOptions`, type it
  `ExternalAgentDefinition<MyOptions>` and use
  `createDriver(options) { return new MyDriver(options); }`.
  `registry.create(id, { name, driverOptions })` configures the default
  driver.
- **Credentials.** Return `{ kind: "env", env }`, `{ kind: "none" }` or
  `undefined` from a credential provider; any other kind (including the old
  `"custom"`) ends the turn with `EXTERNAL_AGENT_CREDENTIAL_UNSUPPORTED`.
  `CodexAgent` now uses `EnvCredentialProvider`; to keep the runtime login
  only, pass `credentialProvider: new NoopCredentialProvider()`.
- **Custom drivers.** `ExternalAgent` no longer fills `request.runtimeSession`;
  read the runtime's session id from your own state. A host that runs a
  driver directly can pass `runtimeSession: { id }` to resume a known Codex
  thread or Claude session. `request.tools` is gone; use `request.adkTools`.
- **Imports.** The driver mappers and input converters are internal;
  `mapPermissionModeToPolicy` stays. Replace `externalAgentDefinitionRegistry`
  / `externalAgentProviderRegistry` with
  `createDefaultExternalAgentDefinitionRegistry()` /
  `createDefaultExternalAgentProviderRegistry()`; extend a CLI driver class
  instead of `SubprocessJsonlDriver`.
- **Delegated paths.** Nested parent and child roots now intersect to the
  narrower root instead of nothing. Use absolute or `~` roots in a parent's
  `allowedPaths`: relative roots are not passed to delegated agents, and a
  child of a parent with only relative roots can reach no path. The derived
  policy carries `pathBounds`; the guard enforces them.
- **Isolated Claude agents.** `ClaudeAgent` no longer inherits the host's
  Claude Code setup. If your agent relied on host tools (Task sub-agents,
  Skill, cron, worktrees...), on MCP servers from your user or project
  config, or on claude.ai connectors, pass a driver:
  `driver: new ClaudeAgentSdkDriver({ inheritHostConfig: true })`, or list the
  built-in tools you need with
  `driver: new ClaudeAgentSdkDriver({ tools: [...DEFAULT_CLAUDE_TOOLS, "Task"] })`.
  `settingSources` still defaults to `[]`. Under `read-only`, write, shell and
  web tools are no longer offered to the model (calls to them were already
  denied).
- **Spans.** External agent spans carry the real model and run usage, and a
  delegation is one `execute_tool transfer_to_agent` span around the
  sub-agent's run. If you query traces for the previous 0 ms span pairs or for
  `gen_ai.request.model = "claude"`, update those queries.
- **ADK tool actions.** A bridged ADK tool that sets `skipSummarization` or
  `transferToAgent` now ends the external agent's turn after the call. A tool
  that sets only `escalate` no longer has it ignored: it is published, and an
  enclosing `LoopAgent` stops after the turn. Stop setting an action if you
  relied on it being dropped.
- **`requestConfirmation()` in a bridged tool** is now confirmed instead of
  failing. The tool runs a second time with `toolContext.toolConfirmation` set
  (including the human's `payload`), and the first run's response and state
  changes are dropped, as in ADK.
- **Driver options.** `ClaudeAgent({ driver: new ClaudeAgentSdkDriver({ tools }) })`
  can be written `ClaudeAgent({ driverOptions: { tools } })`. Passing both
  throws `InputValidationError`.
- **Claude CLI isolation.** `ClaudeCliDriver` no longer loads your Claude
  Code tools, MCP servers, skills, settings files or claude.ai connectors. Pass
  `new ClaudeCliDriver({ inheritHostConfig: true })` to keep them, or
  `tools: [...]` to choose the built-in tools. A `read-only` agent now runs
  with `--permission-mode dontAsk` instead of `plan`, so it uses the model you
  configured. Its write and shell tools are removed, and MCP tools are
  denied, also with `inheritHostConfig: true` (both Claude drivers). Give a
  host MCP server's tools to an `ask` or `workspace-write` agent instead.
- **Isolation check.** If a run stops with `EXTERNAL_AGENT_ISOLATION_VIOLATED`,
  a host or managed setting added tools or MCP servers to an isolated Claude
  agent, at start or during the run. Remove that setting, or pass
  `inheritHostConfig: true` if you trust it.
- **`requiredMcpServers`.** Requiring a host MCP server now needs
  `inheritHostConfig: true` on `ClaudeAgentSdkDriver` (or in `ClaudeAgent`'s
  `driverOptions`); without it the constructor throws `InputValidationError`.
  Before, such a run always failed with "Required Claude MCP server
  unavailable".
- **Network is off unless `allowNetwork: true`.** An unset `allowNetwork`,
  or no `permissions` at all, now means `false` everywhere: at the root, in
  workflow steps, in delegated children and in a driver run directly. An
  agent that needs the network (web tools, a shell that downloads, remote MCP
  servers) must set `allowNetwork: true` in its own policy. Under an
  `ExternalAgent` ancestor (directly or through the session registry that
  `AgentInvocationGateway` copies), the ancestor's policy is a ceiling, so a
  child keeps network only when both set `true`. A root `WorkflowAgent` with
  no external ancestor applies no ceiling: a step with `allowNetwork: true`
  keeps network, a step without it has none. See
  [External agent isolation](external-agent-isolation.md).
  - Claude agents run Bash in a sandbox with no network, and the run fails
    at start where the sandbox cannot run. On Linux install bubblewrap (and
    socat). On Windows the sandbox is not available: set
    `allowNetwork: true`, or pass `allowUnsandboxedShell: true` to the
    driver. Either remedy also works on Linux.
  - Codex agents in `full-access` mode are refused: use `workspace-write` or
    `ask`, set `allowNetwork: true`, or pass `allowUnenforcedNetwork: true`.
    In the other modes Codex turns off the MCP servers of your Codex config
    for the run, and refuses the run if `codex mcp list --json` fails.
  - `new CodexSdkDriver({ sdk })` (a prebuilt client) is refused, because the
    driver cannot turn off that client's host MCP servers. Let the driver
    build the client, set `allowNetwork: true`, or pass
    `allowUnenforcedNetwork: true`.
  - Gemini CLI agents without `allowNetwork: true` are refused in every mode,
    so a Gemini CLI agent with no `permissions` no longer runs. Set
    `allowNetwork: true` for them, or pass `allowUnenforcedNetwork: true` to
    `GeminiCliDriver` (or `GeminiCliAgent`'s `driverOptions`) to run with the
    network reachable.
  - Approvers no longer see MCP tools of other servers, or unsandboxed shell
    calls; the guard denies them first.
- **Missing SDKs and binaries.** A missing `@anthropic-ai/claude-agent-sdk`,
  `@openai/codex-sdk`, or `claude`/`codex`/`gemini` binary is now an error
  event (`EXTERNAL_AGENT_DEPENDENCY_MISSING` or `MISSING_BINARY`) with the
  install command, not an exception from `runAsync`.
- **Cancel.** CLI processes get `killGraceMs` (default 2000 ms) to exit after
  SIGTERM before SIGKILL. On macOS and Linux the whole process group of the
  CLI is killed, and host signals are forwarded to it.

## 7. Agent invocation gateway

If you call `AgentInvocationGateway` (or `ToolGateway`) directly:

- `result.output` is now the text of the **last final response**, as with
  ADK's Runner and `AgentTool`. The previous concatenation of all text is in
  `result.transcript`.
- `sessionHistoryMode` defaults to `replace` (was `inherit`), so the child
  sees only the delegated message. Pass `sessionHistoryMode: "inherit"` to
  share the parent's history.
- In `merge` state mode the child gets a deep copy of the parent state; values
  that cannot be cloned (such as functions) are omitted.
- A child that stops on an ADK interrupt (for example a confirmation) is
  reported in `result.interrupt`. Resume it with
  `resume: { events: result.interrupt.events }`.

## 8. Workflows (`adk-llm-bridge/workflows`)

Workflows are new in 0.7.0 (they were not in the 0.6.0 tag), so there is
nothing to migrate. Two things to know if you write exhaustive switches or keep
checkpoints:

- Handle the `"waiting"` status, the `step_waiting` / `workflow_waiting`
  events and the `WORKFLOW_STEP_INTERRUPTED` error code. A step whose agent
  stops on an ADK interrupt (for example a tool confirmation) ends the run as
  `waiting`, and it resumes when the user answers.
- Import `BaseAgent` from `@google/adk`; the workflows entry point does not
  re-export it.
- If you call the workflow control plane with hand-built payloads: every
  payload is now validated first, and malformed ones fail with
  `WORKFLOW_CONTROL_INVALID_REQUEST` instead of a controller-specific code.
- If you call a custom `QuickJSModuleLoader` yourself, its result is typed as
  `QuickJSModuleLike`; cast it if you need the full `QuickJSWASMModule` API.
- If you upgrade with workflow change operations in flight: a commit or
  integration journaled before 0.7.0 and retried afterwards fails closed with an
  intent mismatch. Let `WorkflowValidatedCommitter` /
  `WorkflowValidatedIntegrator` operations finish first. If you retry one with
  a new `operationId` instead, check the target ref first: the earlier attempt
  may already have applied the change. Checkpoints,
  artifacts, change sets and worktrees from earlier versions keep working.
- Custom control-plane services must return plain JSON. Class instances,
  `Date`, `Map` and non-finite numbers are rejected at the control plane with
  `WORKFLOW_CONTROL_INVALID_RESULT` instead of reaching the transport.
- **Registry.** Replace `registry.get(id)` / `require(id)` / `has(id)` /
  `delete(id)` with the `(id, version)` form; catch
  `WORKFLOW_DEFINITION_NOT_FOUND` for an unknown workflow.
- **Ids.** Workflow definition ids and versions follow the opaque id grammar
  (letters, digits, `. _ : + / -`, starting with a letter or digit, up to
  256). Agent, task, execution and message ids use `A-Z a-z 0-9 . _ : -` (no
  `/`, `@` or `+`); keep `@` and `/` for the actor's `actorId` only, and map
  `user+tag@example.com` to another principal id. Plan base revisions must not
  contain spaces. Executions or checkpoints stored under other ids still load
  but cannot be resumed on 0.7; finish them first. Stored Git workspace
  descriptors with `+` or `/` in `taskId` or `executionId`, and
  host-persisted orchestration messages with `@` or `/` in their ids, fail to
  load; drain them before upgrading.
- **Paths.** Pass `/`-separated paths to workspace leases: a `\` is rejected
  instead of converted, and a first segment of one letter and a colon
  (`x:y`, `a:b.txt`) is rejected as a drive prefix; rename such files. Set
  `caseInsensitivePaths: true` on the workspace adapter for a workspace on a
  case-insensitive filesystem (default macOS APFS, Windows).
- **Workspace leases.** Drain or delete workspace `stateDirectory` lease files
  before upgrading. Expired legacy leases with rejected paths are dropped; a
  live one fails with `WORKFLOW_WORKSPACE_STATE_INCOMPATIBLE` until it is
  released or expires. Compare lease loss `reason.code` with
  `WORKSPACE_LEASE_LOST` / `WORKSPACE_ADAPTER_DISPOSED`.
- **Orchestration authorization.** Branch on
  `code === "WORKFLOW_ORCHESTRATION_UNAUTHORIZED"`;
  `details.reason === "unauthorized"` still works in 0.7 but will be removed.
  Refresh an actor's or task's binding only on `WORKFLOW_PLAN_STALE`;
  `WORKFLOW_ORCHESTRATION_UNAUTHORIZED` for a revision mismatch means the
  actor is used outside its scope.
- **`task.sweep`.** Catch `WorkflowTaskControlError` with
  `WORKFLOW_TASK_INVALID_REQUEST` instead of `TypeError`.
- **Git driver errors.** Handle `GIT_COMMAND_FAILED` (process failures, with
  `cause`) and `GIT_ENTRY_UNSUPPORTED` where `GIT_CONFIGURATION_INVALID` or a
  raw `ExecException` was handled, and catch `NodeGitWorktreeError`
  `GIT_CONFIGURATION_INVALID` instead of `TypeError` around `create()`.
  Remove untracked nested repositories from worktrees or add them as
  submodules.
- **Removed helpers.** The internal workflow helpers listed in the CHANGELOG
  have no public replacement. Hosts that need JSON snapshots copy and freeze
  values themselves; store implementations validate their own ids.
- **Control plane without an actor, or with a task-bound actor.** Without
  `trustedHostMode`, `execution.*`, `artifact.*` and `integration.validate`
  need the host-authenticated `WorkflowActorContext` of the execution, and
  `execution.*` needs one that is not bound to a task (task agents read their
  own state with `task.*`). Otherwise they fail with
  `WORKFLOW_CONTROL_UNAUTHORIZED`. `execution.list` always needs
  `trustedHostMode`. Code that matched
  `WORKFLOW_CONTROL_INVALID_REQUEST` to detect a missing or mismatched actor
  should match `WORKFLOW_CONTROL_UNAUTHORIZED`; payload errors keep
  `WORKFLOW_CONTROL_INVALID_REQUEST`.
- **Artifacts are keyed by execution.** `WorkflowArtifactStore.get` takes
  `{ executionId, artifactId }` and `list` requires `executionId`, as do the
  `artifact.get` and `artifact.list` control payloads (without it they fail
  with `WORKFLOW_CONTROL_INVALID_REQUEST`, even in trusted host mode). The
  same artifact id in two executions names two artifacts. A missing or
  invalid id throws `WorkflowArtifactIdentityError`
  (`WORKFLOW_ARTIFACT_IDENTITY_INVALID`, a `TypeError`); artifact execution
  ids use the record grammar, so `/` and `+` are rejected there.
- **Custom artifact stores** must key by both ids and return only artifacts
  of the requested execution. Records written by earlier versions already
  carry their `executionId`, and the old store held each artifact id once,
  so re-keying every record under `(executionId, artifactId)` is a one-time
  migration without collisions; revisions do not change. Until a store is
  re-keyed, the control plane and `IntegrationGate` fail closed: an artifact
  returned for another execution reads as absent from `artifact.get`, is
  dropped from an `artifact.list` page, and is reported as missing by
  `integration.validate`. A file-backed store can use the async
  `workflowArtifactStoragePath` for a per-execution layout whose file names
  stay within 255 characters.
- **Retry policies** with unknown keys, non-finite or negative numbers, or
  delays above 2^31-1 ms are rejected at definition time.
- **Git driver environment.** The driver no longer honors `GIT_*` pathspec,
  quarantine, replace, graft and shallow variables from the host, and always
  sets `GIT_NO_REPLACE_OBJECTS=1`.

## Coming from the 0.6.0 tag

0.6.0 added external agents and was released on GitHub only. Everything above
applies. The external-agent APIs are not new to you: sections 6 and 7 list the
changes in their behavior. The runtime and peer changes in section 1 apply
from 0.6.0 as well: 0.6.0 still supported ADK below 2.
