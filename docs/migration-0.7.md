# Migrating to 0.7.0

0.7.0 is the first npm release after 0.5.3. Version 0.6.0 was published on
GitHub only, so npm users go straight from 0.5.3 to 0.7.0. This guide covers
that whole step. If you installed the 0.6.0 GitHub tag, see
[Coming from the 0.6.0 tag](#coming-from-the-060-tag) at the end.

The full list of changes is in the [CHANGELOG](../CHANGELOG.md#070---2026-11-09).

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
Shared code and its type declarations now live in `dist/shared/` chunks
(`.js` and `.d.ts`). Import only the documented
subpaths (`adk-llm-bridge`, `/agents`, `/agents/session-store/sqlite`,
`/workflows`, `/workflows/node`, `/package.json`), never a file under `dist/`: chunk names change between
builds. The package declares `"sideEffects": false`, so bundlers can drop the
modules you do not import.

Upgrade ADK first by following ADK's own 2.x notes. ADK 2 changes
`InvocationContext` and the event types that custom agents and plugins use.
User code that only builds `LlmAgent`, `FunctionTool` and `Context` tools
compiles on ADK 2.4 unchanged.

### `*Llm` classes and `LLMRegistry`

The provider classes (`AIGatewayLlm`, `OpenRouterLlm`, `OpenAILlm`, `XAILlm`,
`AnthropicLlm`, `CustomLlm`) are still exported, and registering one with ADK's
`LLMRegistry` still works. Use it when a tool such as `adk-devtools` creates the
model from a model-name string:

```typescript
import { LLMRegistry, LlmAgent } from '@google/adk';
import { AIGatewayLlm } from 'adk-llm-bridge';

LLMRegistry.register(AIGatewayLlm);

const agent = new LlmAgent({
  name: 'assistant',
  model: 'anthropic/claude-sonnet-5.5',
  instruction: 'Answer briefly.',
});
```

The `register*()` functions (for example `registerAIGateway()`) do the same and
also store global provider options. The factory functions (`AIGateway(...)`)
need no registration.

`LLMRegistry` matches the whole model name and caches each result, so register
every class at startup; see
[How `LLMRegistry` finds a class](provider-requests-and-responses.md#how-llmregistry-finds-a-class).

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

// Per model. The key comes from the environment (AI_GATEWAY_API_KEY) or from
// the `apiKey` option:
const model = AIGateway('openai/gpt-6.1-sol', { errorMode: 'response' });

// Or globally, for one provider:
setProviderConfig('ai-gateway', { errorMode: 'response' });
```

Related behavior changes:

- Truncated or invalid tool-call arguments now end the turn with
  `finishReason: MALFORMED_FUNCTION_CALL` (and an `errorCode`), instead of
  calling the tool with `{}`. ADK's `ReflectAndRetryModelPlugin` can retry
  them.
- `candidateCount` other than `1` is rejected on OpenAI-compatible providers
  with `InputValidationError`, thrown in every `errorMode` before any request.
  A `RoutedLlm` router receives it as `lastError`; do not fail over on it.
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
- Custom providers may take their endpoint from `CUSTOM_LLM_BASE_URL` and
  `CUSTOM_LLM_API_KEY`. The key goes only with the URL from the environment:
  `Custom(model, { baseURL })` and `registerCustomProvider` with a `baseURL`
  but no `apiKey` still send no key. Pass `apiKey` for such an endpoint.
- The OpenAI provider sends `maxOutputTokens` as `max_completion_tokens` for
  every model. A proxy behind `OPENAI_BASE_URL` that only knows `max_tokens`
  needs `registerCustomProvider` instead. `gpt-<N>` with N of 5 or more
  (`gpt-6.1-sol`, ...) and `o<N>` are reasoning models on every provider:
  `temperature`, `top_p`, stop sequences, penalties and logprobs are dropped
  for them, and `thinkingConfig` maps to `reasoning_effort`.

### Model and response fields

- A `beforeModelCallback` that sets `llmRequest.model` now changes the model
  sent, when the id is one the provider accepts (for example `o4-mini` on
  `OpenAILlm`, `claude-*` on `AnthropicLlm`). Before, the provider always sent
  its own model. An id the provider does not accept is ignored with a
  `[REQUEST_MODEL_IGNORED]` warning. See
  [Provider requests and responses](provider-requests-and-responses.md#which-model-is-sent).
- Responses carry `modelVersion`, and the last streamed response has
  `partial: false`.
- A content-filter finish with no content now has `errorCode: "SAFETY"`. Code
  that treats any `errorCode` as a failed call will see these turns as
  failures, which is what they are.

## 4. Usage metadata

- Anthropic `promptTokenCount` now includes cache-read and cache-creation
  tokens, as ADK expects. Cached tokens are also reported in
  `cachedContentTokenCount`. If you added the cache counts yourself, stop
  doing so.
- Claude Agent SDK: a resumed session reports usage and cost per run instead
  of the session total, marked `usage.scope: "run"`. When the driver has no
  baseline for the session (first run after a restart or on another replica,
  `resumeSessionId`, `runtimeSession.id`, `forkSession`), the usage is still
  the session total, marked `scope: "session"`; the final ADK event carries
  the same label in `customMetadata.externalAgentUsageScope`. If you sum run
  usage, skip or reconcile `"session"` values instead of adding them.
- On OpenAI-compatible providers, `candidatesTokenCount` no longer includes
  reasoning tokens: it is `completion_tokens` minus the reasoning tokens, as
  genai and Gemini define it, and `thoughtsTokenCount` reports the reasoning
  part. To get OpenAI's `completion_tokens`, add the two. ADK main adds them
  for `gen_ai.usage.output_tokens`; ADK 2.4 reports only
  `candidatesTokenCount` there.
- OpenAI-compatible requests get ADK's user turn when the contents are empty
  or end on a model turn (as on Anthropic and Gemini), and contents with no
  parts are dropped first.
- For providers that require a key, a blank `apiKey` counts as unset, so a
  global key or the environment variable applies instead of an
  `API key is required` error.

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

`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` (or `1`) no longer
puts content on the bridge's spans. As on ADK main, it means `EVENT_ONLY`. To
keep content on spans, set `SPAN_ONLY` or `SPAN_AND_EVENT`.

`gen_ai.provider.name` uses the OpenTelemetry semantic-convention value where
one exists: xAI is `x_ai`, not `xai`. OpenAI is `openai`, Anthropic is
`anthropic`, and OpenRouter, AI Gateway and custom providers keep the bridge id
(`openrouter`, `ai-gateway`, `custom`). Update dashboards that filter on
`xai`.

ADK always writes the agent's `description` to `gen_ai.agent.description` on
its `invoke_agent` spans, whatever these variables say: it is agent
configuration, not message content. Do not put prompt text or secrets in
`description`.

## 6. External agents (`adk-llm-bridge/agents`)

External agents were added in 0.6.0 (GitHub only), so for npm users they are
new in 0.7.0. If you already use them, these changes apply:

- **Bridged ADK tools run tool callbacks.** Runner plugins
  (`beforeToolCallback`, `afterToolCallback`, `onToolErrorCallback`) now run
  for ADK tools given to an `ExternalAgent`, and the agent takes
  `beforeToolCallback` / `afterToolCallback` like `LlmAgent`. A plugin that
  blocks or rewrites tool calls now applies to these tools too; a throwing
  callback fails the call with `CALLBACK_FAILED`.
- **Long-running tools pause.** A `LongRunningFunctionTool` that returns no
  result ends the turn with the call in `longRunningToolIds`, instead of
  telling the runtime it finished with `null`. Answer it with a
  `functionResponse` of the same id to resume; the runtime gets the result as
  a tool result in its user message. Other `functionResponse` parts of the
  user's messages (duplicates, unknown ids, re-sent answers, confirmation
  answers, earlier turns' results) are not passed to the runtime. Keep
  results under 64 KiB of UTF-8 JSON (256 KiB per turn), or the turn ends
  with `EXTERNAL_AGENT_TOOL_RESULT_TOO_LARGE`.
  A tool that finishes at once should be a plain `FunctionTool`.
- **ADK tools an external runtime cannot use are logged.** In-model tools
  (`GOOGLE_SEARCH`, `URL_CONTEXT`) are reported in `skipped` as `in-model`
  (was `no-declaration`) and logged as `ADK_TOOL_IN_MODEL_SKIPPED`. A tool
  without a declaration that only edits the model request (`PRELOAD_MEMORY`)
  is skipped as `request-processor` and logged as
  `ADK_TOOL_REQUEST_PROCESSING_SKIPPED`; a declared tool or toolset with its
  own `processLlmRequest` (`LoadArtifactsTool`, a skill toolset) is exposed
  without it and logged with the same code. A toolset whose `getTools`
  throws is logged as `ADK_TOOLSET_FAILED`, and its `skipped` entry has the
  error as `cause`. Each warning is logged once per tool for each run;
  silence them with ADK's `setLogLevel` or a custom logger. Code that
  switches on `SkippedTool.reason` must handle `in-model` and
  `request-processor`.
- **`ExternalAgentUsage.byModel` entries have no `scope`** (type
  `ExternalAgentModelUsage`); the usage's own `scope` covers them. The
  drivers never set one there.
- **Array tool results** are `{ results: [...] }` (as in ADK), not
  `{ result: [...] }`, in function responses of bridged ADK tools and of the
  runtime's own tools. Update code that reads them.
- **Credential requests fail.** A bridged tool that calls
  `toolContext.requestCredential()` gets a `CREDENTIAL_REQUIRED` error, and
  the turn ends with an `EXTERNAL_AGENT_TOOL_CREDENTIAL_REQUIRED` error event.
  Give such tools their credentials up front.
- **Unused approvals fail.** With `confirmation: { adk: true }`, an approved
  call that the runtime does not make again on the answer turn ends the turn
  with an `EXTERNAL_AGENT_CONFIRMATION_UNUSED` error event, instead of a
  success with the approved call never run.
- **`AdkToolExecutionResult`** has a new status `"pending"` and
  `AdkToolErrorCode` the codes `CALLBACK_FAILED` and `CREDENTIAL_REQUIRED`;
  update exhaustive switches.

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
- **`allowedPaths` on CLI, Codex and Gemini drivers.** `ClaudeCliDriver`,
  `CodexSdkDriver`, `CodexCliDriver` and `GeminiCliDriver` cannot check tool
  paths, so a run whose policy sets `allowedPaths` (or inherits `pathBounds`
  from a parent agent) is refused with `EXTERNAL_AGENT_PATHS_UNENFORCEABLE`.
  This includes a Codex or Gemini sub-agent of a Claude agent with
  `allowedPaths`. Run the agent on `ClaudeAgentSdkDriver`, drop
  `allowedPaths`, or pass `allowUnenforcedPaths: true` to the driver (for
  example `new CodexAgent({ driverOptions: { allowUnenforcedPaths: true } })`)
  to rely on the runtime's own sandbox. On `ClaudeAgentSdkDriver` the path
  guard now also checks the calls Claude Code approves without asking, so an
  edit inside the working directory but outside `allowedPaths` is denied, and
  Bash may write only inside `allowedPaths`. When Bash (or another shell
  tool) is on offer, the working directory must be inside `allowedPaths` and
  the shell must run in the sandbox (no `allowNetwork: true`, no
  `allowUnsandboxedShell`); otherwise the run is refused with
  `EXTERNAL_AGENT_PATHS_UNENFORCEABLE`. The same refusal applies with
  `inheritHostConfig: true`, and when the working directory or an allowed
  root is inside a temp directory the sandbox always keeps writable (`/tmp`,
  the host temp directory, `TMPDIR`). Set `workingDirectory` inside
  `allowedPaths` and outside the temp directories, or pass `tools` without
  `Bash`. `Glob` and `Grep` without a search path, and any relative glob
  without one (such as Gemini `read_many_files` `include`), are now checked
  against the working directory. The sandbox confines Bash writes, not reads.
  One read outside `allowedPaths` is allowed: `Read` of the run's own
  session `tool-results` directory, where Claude Code saves a tool output
  too large to return inline. Nothing to change; see
  [External agent isolation](external-agent-isolation.md).
- **Reading wider than you write (`readPaths`, new).** A writer confined
  with `allowedPaths` could not read outside it. Give it
  `readPaths: [...]` next to `allowedPaths` to add roots that read tools
  (`Read`, `Glob`, `Grep`, `read_file`, ...) may reach and nothing may write.
  On `ClaudeAgentSdkDriver` this replaces the split into a `read-only` reader
  and a narrow writer. The other drivers refuse it unless built with
  `allowUnenforcedPaths: true`. `readPaths` without `allowedPaths` throws
  `InputValidationError`. A hand-built policy that sets `readPathBounds` is
  checked against it for reads instead of `pathBounds`. Policies without
  `readPaths` behave as before. See docs/external-agent-isolation.md,
  "Reading wider than you write".
- **Bridge tools and the MCP network denial.** With the network off, only the
  tools `ExternalAgent` bridged for the run are exempt from the `mcp__*`
  denial. A host MCP server whose name starts with `adk_bridge` is no longer
  exempt.
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
  `tools: [...]` to choose the built-in tools. Both Claude drivers also turn
  Claude Code auto-memory off for isolated runs (`autoMemoryEnabled: false`),
  so an agent no longer gets instructions to read or write your
  `~/.claude/projects/.../memory/` directory. A `read-only` agent now runs
  with `--permission-mode dontAsk` instead of `plan`, so it uses the model you
  configured. Its write and shell tools are removed, and MCP tools are
  denied, also with `inheritHostConfig: true` (both Claude drivers). The same
  denial applies in every mode while the network is off, since a host MCP
  server runs outside the shell sandbox: give a host MCP server's tools to an
  `ask`, `workspace-write` or `full-access` agent with `allowNetwork: true`.
- **Isolation check.** If a run stops with `EXTERNAL_AGENT_ISOLATION_VIOLATED`,
  a tool outside the isolated set appeared. The message says which case the
  bridge saw: a host or managed setting added tools or MCP servers (remove
  that setting, or pass `inheritHostConfig: true` if you trust it), or the
  model asked for a tool it was not offered (a model error; retrying the step
  usually works). On `ClaudeAgentSdkDriver` a call the runtime refuses on its
  own (an error result, no hook reached) no longer stops the run: it is
  tagged `metadata.isolation: "EXTERNAL_AGENT_TOOL_NOT_OFFERED"` on its
  `tool_result` event, and the third one in a run stops it. The check accepts an offered
  built-in under another case (`bash` for `Bash`); any other name outside the
  offered set stops the run, including an unknown name, an `mcp__` name in
  another case (`MCP__x`), and a `tool_use` with an empty or missing name. A tool call
  whose `PreToolUse` hook input has no tool name is denied and stops the run
  too. Tool names in the message are quoted (`tried to use "mcp__x__y"`).
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
    driver. Either remedy also works on Linux. The sandbox also forbids
    binding local ports (Turbopack's PostCSS worker, test servers); pass
    `allowLocalBinding: true` to the Claude driver to allow loopback ports
    only (macOS only; Claude Code ignores it on Linux). Treat it as network
    access: loopback services may become reachable.
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
  - A Claude agent whose `tools` name `WebFetch` or `WebSearch` (in any
    case) while the network is off is refused at run start with
    `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE`; before, the tools were dropped
    without a word. Set `allowNetwork: true`, or remove the web tools. The
    default tool list is still trimmed without a refusal.
  - A `read-only` agent with `allowNetwork: true` now runs its web tools
    (`WebFetch`, `WebSearch`, and the Codex and Gemini CLI names) without a
    confirmation; before, the guard denied every call. An approver is not
    asked for them, so such an agent can send what it reads to any host:
    turn the network on only for agents whose inputs you trust, or use `ask`
    mode so web calls go to an approver. Every other read-only denial is
    unchanged, and a path outside `allowedPaths` is still denied.
- **CLI prompts.** The Codex CLI driver passes `--` before the prompt, and
  the Gemini CLI driver passes `--prompt=<prompt>` (`buildGeminiArgs` returns
  that form). The Claude CLI driver passes no prompt argument: it writes the
  prompt to stdin (`claude -p --input-format text`), so `buildArgs` no longer
  contains it. A custom `ClaudeCliDriver` `spawn` must write
  `options.input` to the process's stdin and close it; otherwise `claude -p`
  gets no prompt and the run fails. A prompt that starts with `-` is text,
  never a flag. If you append your own `args`, they still come after the
  driver's flags (and, for Codex, before the prompt).
- **CLI `args` that override the policy flags.** `ClaudeCliDriver` and
  `CodexCliDriver` now throw `EXTERNAL_AGENT_OPTION_UNSUPPORTED` at
  construction when an `args` entry would override a flag they set from the
  permission policy or isolation: for Claude `--permission-mode`,
  `--dangerously-skip-permissions`, `--settings`, `--setting-sources`,
  `--tools`, `--allowedTools`, `--disallowedTools`, `--mcp-config`,
  `--add-dir`, `--plugin-dir`, `--ide` or `--chrome`; for Codex `--sandbox`,
  `--ask-for-approval`, `--full-auto`, `--yolo`, `--add-dir`, `--cd`,
  `--profile`, `--enable`, `--disable`, `--search`, or a `-c` override of the
  sandbox, approval, web search, tools, MCP server, feature or profile keys.
  Also refused, because they widen the run: Claude `--agents`, `--agent`,
  `--plugin-url`, `--permission-prompts`, `--worktree`/`-w`,
  `--remote-control`, `--cloud`, `--teleport`, `--environment`; Codex
  `--approve-for-me` (and its hidden alias `--not-so-yolo`),
  `--dangerously-bypass-hook-trust`, `--ignore-rules`, `--worktree`, and a
  `-c` override of `approvals_reviewer`, `default_permissions`, `permissions`
  or `agents`. One-letter flag clusters such as `-pw` are split first.
  `CodexCliDriver` also refuses a positional word (an entry that is neither
  an option nor the value of the option before it, and `-` or `--`), which
  `codex exec` would run as a subcommand such as `review` or `resume`, or
  read as the prompt. Pass several images as `-i a.png -i b.png`, not
  `-i a.png b.png`. See
  [External agent isolation](./external-agent-isolation.md#extra-args).
  Express the setting through the permission policy or a driver option
  instead, or build the driver with `allowPolicyOverrideArgs: true` to keep
  passing it (the CLI's handling of the repeated flag then decides, and the
  run may not keep the policy). A non-string entry throws
  `InputValidationError`.
- **Codex SDK thread ids.** `CodexSdkDriver` refuses a thread id to resume
  that starts with `-` (from `runtimeSession.id` or session state) with
  `EXTERNAL_AGENT_OPTION_UNSUPPORTED`: codex would read it as an option.
  Codex's own thread ids never start with `-`, so only a forged or corrupted
  id is affected. Clear it from session state to start a new thread.
- **Codex SDK prompt delivery.** `CodexSdkDriver` runs codex through a
  copy of the `@openai/codex-sdk` 0.167.0 exec path that handles a failed
  write of the prompt (see [Codex SDK prompt delivery](external-agent-isolation.md#codex-sdk-prompt-delivery)).
  A prompt codex did not read is the new error code
  `CODEX_SDK_INPUT_NOT_DELIVERED` instead of an uncaught `EPIPE` that ended
  the process.
  - **The optional peer range narrows** from `>=0.167.0 <0.168` to exactly
    `0.167.0`, because the contained copy is verified against that exact
    version. Install exactly `@openai/codex-sdk@0.167.0`.
  - Another installed version, one the driver cannot read, or a prebuilt
    `sdk` client whose exec differs from 0.167.0 is refused with
    `EXTERNAL_AGENT_DEPENDENCY_MISSING`, naming the supported and the
    installed version. To run another version anyway, set
    `allowUncontainedCodexSdk: true`: the run then uses the SDK's own exec
    without the containment (an `EPIPE` from it can end the host again) and
    logs one `CODEX_SDK_UNCONTAINED` warning per driver. Or use
    `CodexCliDriver`. npm refuses another version beside the exact peer
    (`ERESOLVE`): add `"overrides": { "adk-llm-bridge": { "@openai/codex-sdk":
    "$@openai/codex-sdk" } }` to the host's `package.json`, or install with
    `--legacy-peer-deps` (see [Running another SDK version uncontained](external-agent-isolation.md#running-another-sdk-version-uncontained)).
  - A bundled host must keep `@openai/codex-sdk` external, or the version
    cannot be read and every run is refused; a prebuilt `sdk` client must
    come from the same SDK install the bridge resolves.
- **Codex approvals reviewer.** `CodexCliDriver` and `CodexSdkDriver` pass
  `-c approvals_reviewer="user"` outside `full-access`, so an
  `approvals_reviewer = "auto_review"` in `~/.codex/config.toml` no longer
  turns a `never` approval policy into automatic model approval. A host that
  wants the model reviewer passes `-c approvals_reviewer=...` in `args` with
  `allowPolicyOverrideArgs: true` (CLI driver; it comes after the pin).
- **Claude CLI driver.** New `model`, `maxTurns` and `systemPrompt` options
  replace `args: ["--model", ...]`. A failed run reports the error code from
  its `result` line (`MAX_TURNS_EXCEEDED`, `INVALID_REQUEST`, ...) instead of
  `CLAUDE_CLI_EXIT`, which remains for other non-zero exits. Tool results are
  `tool_result` events now, not output text.
- **Claude SDK error codes.** `model_not_found` is `INVALID_REQUEST`;
  `account_on_hold`, `verification_required` and `cloud_credential_error` are
  `AUTH_ERROR`; `overloaded` is `SERVER_ERROR`. Retry handlers that matched
  `CLAUDE_AGENT_SDK_ERROR` for these should match the new codes. The message
  is `<subtype>: <SDK text>`.
- **Missing SDKs and binaries.** A missing `@anthropic-ai/claude-agent-sdk`,
  `@openai/codex-sdk`, or `claude`/`codex`/`gemini` binary is now an error
  event (`EXTERNAL_AGENT_DEPENDENCY_MISSING` or `MISSING_BINARY`) with the
  install command, not an exception from `runAsync`. `CodexSdkDriver`
  checks for its package before it lists Codex's MCP servers, so a missing
  package reports `EXTERNAL_AGENT_DEPENDENCY_MISSING` even when no `codex`
  binary is installed.
- **Binary lookup skips the workspace.** The SDK drivers no longer use a
  `claude` or `codex` binary found at or under the run's `workingDirectory`
  (the process directory when unset) or its `allowedPaths`, including through
  `PATH`, `executableSearchPaths` or a symlink. If your only copy is there
  (for example `node_modules/.bin` of the project the host runs from), set
  `CLAUDE_CODE_EXECUTABLE` or `CODEX_EXECUTABLE` to it, or install the binary
  outside the workspace. `CodexSdkDriver` with the network off now reports
  `MISSING_BINARY` when it finds no binary outside the workspace. The CLI
  drivers (`ClaudeCliDriver`, `CodexCliDriver`, `GeminiCliDriver`) follow
  the same rule for a bare `command` on `PATH`, and also skip relative `PATH`
  entries. A CLI installed as a devDependency of the host's project and found
  through `<cwd>/node_modules/.bin` under `npm run` / `bun run` now ends the
  run with `MISSING_BINARY`. To keep it working, pass an absolute `command`
  (for example `resolve("node_modules/.bin/claude")`), or install the CLI
  outside the workspace. See
  [Missing dependencies](external-agent-isolation.md#missing-dependencies).
- **Strict binary resolution (opt-in).** Nothing changes unless you set
  `strictBinaryResolution: true` on `ClaudeAgentSdkDriver` or
  `CodexSdkDriver`. With it, a run whose lookup finds no binary outside the
  workspace is refused with `MISSING_BINARY` when the host install (the
  bridge, the SDK or the package holding its binary) is inside the run's
  `workingDirectory` or `allowedPaths`, instead of the SDK starting its
  bundled binary from there. If your host runs from the repository the agent
  edits, set `CLAUDE_CODE_EXECUTABLE` / `pathToClaudeCodeExecutable` or
  `CODEX_EXECUTABLE` / `codexPathOverride` before turning it on. It cannot be
  combined with a prebuilt Codex `sdk` client. See
  [Strict binary resolution](external-agent-isolation.md#strict-binary-resolution).
- **Background tasks are off for Claude runs.** `ClaudeAgentSdkDriver` and
  `ClaudeCliDriver` set `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`: a headless
  run ends at its result, and nothing would deliver a background task's
  completion, so a model that backgrounded a command stopped while waiting
  for it and the run reported success with the work undone. Bash no longer
  offers `run_in_background`, and subagents run in the foreground. A run
  whose result arrives while Claude Code still reports a background task now
  ends with `EXTERNAL_AGENT_BACKGROUND_TASK_PENDING` (not recoverable) and
  exit code 1. To keep background tasks, pass `allowBackgroundTasks: true`
  (for example `new ClaudeAgent({ driverOptions: { allowBackgroundTasks:
  true } })`); the check stays on.
- **Private temp directory per Claude run.** Both Claude drivers create a
  fresh `0700` directory under `/tmp` for each run and set
  `CLAUDE_CODE_TMPDIR` to it and `TMPDIR` to the `claude-<uid>` directory
  inside it; the directory is removed when the run ends. Temp files an agent
  makes do not outlive the run: write anything the host needs inside the
  working directory. Not used on Windows. On macOS, tell agents to use
  `mktemp -p "$TMPDIR"` (a bare `mktemp` writes to `/var/folders/.../T`) and
  not to pass pipes to `diff` (it copies them to `/tmp`); both fail in the
  sandbox, which does not make shared temp directories writable.
- **Session store (new, experimental).** `driverOptions.sessionStore` mirrors
  Claude Agent SDK sessions to durable storage, and `SqliteSessionStore`
  (`adk-llm-bridge/agents/session-store/sqlite`) is a ready adapter; see
  [Persisting Claude sessions](claude-session-store.md). Nothing changes
  without it. `sessionStoreFlush` and `sessionStoreLoadTimeoutMs` tune it, and
  the SDK's `importSessionToStore` copies existing local sessions into it.
  `ClaudeCliDriver` throws `EXTERNAL_AGENT_OPTION_UNSUPPORTED` when given any
  of the three options.
- **Cancel.** CLI processes get `killGraceMs` (default 2000 ms) to exit after
  SIGTERM before SIGKILL. On macOS and Linux the whole process group of the
  CLI is killed, and host signals are forwarded to it.
- **Windows batch shims.** `ClaudeCliDriver`, `CodexCliDriver` and
  `GeminiCliDriver` resolve their command over `.com` and `.exe` only and never
  run a `.cmd` or `.bat` file (it would go through `cmd.exe` and re-parse the
  prompt). A shim such as `gemini.cmd` ends the run with
  `EXTERNAL_AGENT_BATCH_COMMAND_REFUSED`. Use the native `claude.exe` or
  `codex.exe`, or, for Gemini CLI, `interpreter` (a native `node.exe`) and
  `entry` (the package's JavaScript entry); see
  [Windows: batch files and npm installs](./external-agent-isolation.md#windows-batch-files-and-npm-installs).
- **`interpreter` and `entry` (new, optional).** The three CLI drivers can
  run `<interpreter> <entry> <flags>` instead of `command`. Nothing changes
  without them. If you used a custom `spawn` only to run Gemini CLI through
  Node on Windows, you can replace it with these two options; the custom
  `spawn` keeps working. The interpreter must be the native Node binary (its
  real path named `node` or `node.exe` and a native executable; not Bun, and
  not a version-manager shim such as mise, volta, asdf or nodenv), and the entry (and
  an interpreter given as a path) must be outside the run's working directory
  and `allowedPaths` (and not in a temp directory), or the run ends with
  `EXTERNAL_AGENT_INTERPRETER_UNSAFE`. The interpreter starts in the entry's
  directory and Node changes into the run's working directory before the
  entry runs; a custom `spawn` must keep the `cwd` and `env` it receives; see
  [Interpreter and entry](./external-agent-isolation.md#interpreter-and-entry).

### Explicit models

The external agent drivers now check their model, and nothing but the
driver's `model` option may set it. See
[Model](./external-agent-isolation.md#model).

Breaking changes:

- **`ClaudeCliDriver` blank `model`:** it now throws `ExternalAgentPolicyError`
  (`EXTERNAL_AGENT_MODEL_INVALID`), not `InputValidationError`. Branch on
  `code`. Other invalid option values (for example `maxTurns`) still throw
  `InputValidationError`.
- **`model: ""` on the Claude SDK or Codex SDK driver** now throws when the
  driver is built. Before, the account, host or Codex default model ran.
  Remove the key or set an id.
- **Ids with whitespace or a leading `-`** now throw when the driver is
  built.
- **Model-setting `args`/`config`** are now refused, **even with
  `allowPolicyOverrideArgs`**. That covers:
  - Claude CLI `--model` and `--fallback-model`;
  - Codex CLI `--model`/`-m`, `--oss`, `--local-provider`, `--profile`/`-p`,
    and `-c`/`--config` keys `model`, `model_provider`, `model_providers`,
    `oss_provider`, `openai_base_url`, `chatgpt_base_url`, `model_catalog_json`,
    `model_catalog_url`, `profile` and `profiles`;
  - those keys at any depth of the Codex SDK `config`.

  Set the driver's `model` option instead. Fallback models and Codex
  profiles are no longer reachable through the bridge. For another endpoint,
  use the Codex SDK driver's `baseUrl` option.
- **Custom provider definitions** whose `envAllowlist` forwards
  `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_*_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`,
  `CLAUDE_CODE_SUBAGENT_MODEL`, `GEMINI_MODEL`, `OPENAI_BASE_URL`,
  `CODEX_OSS_BASE_URL` or `CODEX_OSS_PORT`: runs that would carry one are
  refused. Remove the name and set `model`.
- **Gemini read-only runs** (`--approval-mode=plan`, which may route turns to
  another model) are refused when `model` is set or `requireExplicitModel` is
  true (`EXTERNAL_AGENT_MODEL_OVERRIDE`). Choices:
  - Run read-only **without** a model; the CLI then picks the model.
  - Or switch to `ask` or `workspace-write` with a model. **These modes widen
    permissions:** `ask` lets the agent write files after approval, and
    `workspace-write` lets it write in the workspace without asking. Choose
    them only if the agent may write.

Opt-in behavior:

- **`requireExplicitModel: true`** refuses a driver without a model, and
  router or default aliases: Claude `default`, `best`, `opusplan` and
  `opusplan[1m]`; Gemini `auto` and `auto-*`. Use a concrete id or a plain
  alias (`opus`, `sonnet`).

Not covered by the guarantee:

- **Codex CLI and Gemini CLI users** who relied on `~/.codex/config.toml` or
  `~/.gemini/settings.json` for the model: set `model` on the driver.
  Without it the host file still decides. Codex also reads a trusted
  workspace's `.codex/config.toml`, which the agent can write.
- **Claude settings, agents and plugins you load on purpose**
  (`inheritHostConfig`, `settingSources`, or `--settings`,
  `--setting-sources`, `--agent`, `--agents`, `--plugin-dir` or
  `--plugin-url` in `args` with `allowPolicyOverrideArgs`) can still remap,
  restrict or replace the model (`availableModels`, `fallbackModel`,
  settings `env`, a main-thread agent's `model`). With a full-id
  `model`, the `started` event shows the model the run started with.
- **A model mismatch is a reliable signal only with a full id.** With an
  alias (`opus`), the requested and reported ids always differ. A settings
  or env remap of the alias is therefore not detectable, and a mid-run
  `fallbackModel` switch shows only in the usage per model.

Event changes:

- **`ClaudeCliDriver` `started`** now arrives with the first output line, so
  it can carry the model of `system/init`. Its timestamp is still the start
  of the run, and it is still the first event on every path.
- **New fields.** An external agent's final event (or its last error event)
  carries `customMetadata.externalAgentModel` and, when a trusted runtime
  reported the model, `modelVersion`. Workflow `step_started` has
  `requestedModel`, and `step_completed` `result.models`; the gateway's
  `AgentInvocationResult` has `models`. Nothing existing changed shape. An
  external agent's last error event is now delivered after any state-only event
  that arrives right behind it (as the final text already was), so the model
  info can ride on it. Checkpoints from before this change load without
  `models`.

Recommended for hosts:

- Set `requireExplicitModel: true` on drivers.
- Use **full model ids** (`claude-opus-5-5`, not `opus`), so a substituted
  model shows as a reported id that differs from the requested one.

### Read-only agents and tools

`ExternalAgent` now refuses configurations that used to drop ADK tools
silently. See
[Read-only agents and host tools](./external-agent-isolation.md#read-only-agents-and-host-tools).

- List the tools that are safe in a `read-only` agent in `readOnlyTools`, by
  their original names. A `read-only` agent with an unlisted direct tool throws
  `EXTERNAL_AGENT_TOOL_NOT_READ_ONLY`; an entry that names no tool, or more
  than one tool, throws `EXTERNAL_AGENT_READ_ONLY_TOOL_UNKNOWN`.
- Remove `tools` from Codex, Gemini CLI and Claude CLI agents: they never
  reached the runtime, and now throw `EXTERNAL_AGENT_TOOLS_UNSUPPORTED`. Use
  `ClaudeAgent` to host ADK tools.
- The bridge cannot verify that a host function is read-only. The declaration
  is yours.

### Approvers and confirmation

`confirmation: { approver }` and `confirmation: { adk: true }` now throw
`EXTERNAL_AGENT_APPROVALS_UNSUPPORTED` when the agent is built on a driver that
never asks the host for permission: the Claude CLI, Codex SDK, Codex CLI and
Gemini CLI drivers. Before, the setting was ignored and the runtime denied
whatever needed approval. Remove `confirmation` from those agents, or use
`ClaudeAgent` (the Claude Agent SDK driver), the only built-in driver that
routes prompts to the approver. See
[Approvers and ADK confirmation](./external-agent-isolation.md#approvers-and-adk-confirmation-need-a-driver-that-asks).

### Coming in 0.8

0.8 is planned to replace the `args` denylist of `ClaudeCliDriver` and
`CodexCliDriver` with an allowlist of known-safe flags. Any other flag would
need `allowPolicyOverrideArgs: true`. See
[Planned changes](./external-agent-isolation.md#planned-changes) for who is
affected and what to do now.

## 7. Agent invocation gateway

If you call `AgentInvocationGateway` (or `ToolGateway`) directly:

- `result.output` is now the text of the **last final response**, as with
  ADK's Runner and `AgentTool`. The previous concatenation of all text is in
  `result.transcript`.
- The text parts of one event are joined with a newline, as `AgentTool` does
  (they were joined with nothing).
- `sessionHistoryMode` defaults to `replace` (was `inherit`), so the child
  sees only the delegated message. Pass `sessionHistoryMode: "inherit"` to
  share the parent's history.
- In `merge` state mode the child gets a deep copy of the parent state; values
  that cannot be cloned (such as functions) are omitted.
- A child that stops on an ADK interrupt (for example a confirmation) is
  reported in `result.interrupt`. Resume it with
  `resume: { events: result.interrupt.events }`. The gateway trusts those
  events as given and does not guard against replay: resume each interrupt
  once, and keep the events where tools cannot write them.
- `result.errorKind` is `"llm-calls-limit"` when a child `LlmAgent` goes over
  the shared `RunConfig.maxLlmCalls` budget. ADK reports that overflow as an
  error event, and the gateway used to classify it as `"agent-error"`. Match on
  `errorKind`, not on the error text. Any other error event is still
  `"agent-error"`.

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
- `WorkflowAgent` and `ScriptWorkflowAgent` now take ADK's `waitForOutput`,
  `beforeAgentCallback`, `afterAgentCallback` and `parentAgent`, and
  `clone()` works (it threw before). A `beforeAgentCallback` that returns
  content skips the whole workflow, as for any ADK agent.
- `WORKFLOW_STEP_MISMATCH` details also carry `savedStatus` and
  `savedAttempts`, so a caller can tell a step left `running` by a crash from
  a completed one before giving the changed step a new id.
- A workflow step span whose event stream was abandoned ends with
  `adk.node.status` `cancelled`, not `completed`.
- `ExternalAgentWorkflowFactory` checks `workingDirectoryRoots` on real
  paths: a `workingDirectory` or `allowedPaths` entry that leaves the roots
  through a symlink is rejected with `WORKFLOW_AGENT_POLICY_EXCEEDED`.
- **Explicit models in the factory and in run specs** (see also
  [Explicit models](#explicit-models) for the drivers):
  - `config.model` is forwarded to the driver, recorded as
    `descriptor.model`; it is not part of the revision (a model change is
    reported by the replay model check, see
    [Model and input changes on replayed steps](#model-and-input-changes-on-replayed-steps)).
    The factory fails closed with
    `WORKFLOW_AGENT_MODEL_NOT_APPLIED` when the driver does not keep exactly
    that id, or the definition has no `createDriver`. A custom definition that
    turns an alias into a full id must be given the id the driver keeps.
  - With `config.model`, `createDriver` receives `{ model }` (and
    `requireExplicitModel`) where it received no options before. **A custom
    definition must merge these into its own defaults:**
    `createDriver: (o) => new MyDriver({ ...hardening, ...o })`. A definition
    written as `new MyDriver(o ?? hardening)` loses `hardening` as soon as a
    request sets a model; the factory cannot detect it.
  - `requireExplicitModel: true` on the factory refuses a request without a
    model (`WORKFLOW_AGENT_MODEL_REQUIRED`), and a router or default alias for
    the built-in ids `claude` and `gemini-cli`. For a custom provider id the
    factory relies on the driver, which must refuse such aliases and report a
    `model`.
  - Run specs: a missing, empty or blank agent or reviewer `model` is
    `RUN_SPEC_MODEL_REQUIRED` (before: `RUN_SPEC_MISSING_KEY`,
    `RUN_SPEC_STRING_TOO_SHORT` or `RUN_SPEC_INVALID_FORMAT`). The run spec is
    new in 0.7.0. A model id may end in one bracket suffix (`opus[1m]`).
  - `allowedModelsByRole` narrows `allowedModels` per role. Nothing in the
    bridge executes a `RunPlan`: the run-spec checks protect only hosts that
    validate before they build agents, and the factory's `requireExplicitModel`
    and the drivers' checks are the run-time guard.
- If you call the workflow control plane with hand-built payloads: every
  payload is now validated first, and malformed ones fail with
  `WORKFLOW_CONTROL_INVALID_REQUEST` instead of a controller-specific code.
- If you call a custom `QuickJSModuleLoader` yourself, its result is typed as
  `QuickJSModuleLike`; cast it if you need the full `QuickJSWASMModule` API.
- If you upgrade with workflow change operations in flight: a commit or
  integration journaled by a 0.7.0 pre-release build and retried afterwards
  fails closed with an intent mismatch. Let `WorkflowValidatedCommitter` /
  `WorkflowValidatedIntegrator` operations finish first. If you retry one with
  a new `operationId` instead, check the target ref first: the earlier attempt
  may already have applied the change. Checkpoints,
  artifacts, change sets and worktrees from earlier versions keep working.
- Custom control-plane services must return plain JSON. Class instances,
  `Date`, `Map` and non-finite numbers are rejected at the control plane with
  `WORKFLOW_CONTROL_INVALID_RESULT` instead of reaching the transport.
- `WorkflowError.toJSON()` returns a JSON projection of `details`: keys whose
  value is `undefined` are absent, non-finite numbers are `null` and a
  `bigint` is a string. Recorded errors (`withWorkflowFailed`,
  `withWorkflowStepFailed`) are copied the same way, with an empty message
  replaced by `Workflow error <code>`. Read optional detail keys with `?.` or
  `in`, not by comparing to `undefined` after a JSON round trip.
- **Run spec rule sets** (`adk-llm-bridge/workflows/spec`, experimental) need
  the key `allowedMcpProviders`. Add `allowedMcpProviders: []` to a rule set
  written for an earlier 0.7.0 build (deny every MCP provider), or list the
  provider ids your host resolves. A rule set without it is
  `RUN_SPEC_RULES_INVALID`, and `mergeRunRules` throws on it. `RunPlanAgent`
  has a new `mcp` field.
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
- **Recorded step failures replay.** A step that failed earlier in the same
  execution is replayed as that failure: a `step_failed` event with
  `failure.replayed: true`, and the same error as before. Code that caught
  `WORKFLOW_EXECUTION_ERROR` "requires resumePolicy retry" on a re-entry now
  gets the step's original error. To run failed steps again on a re-entry,
  set `retryFailedSteps: true` or `resumePolicy: "retry"`; neither applies on
  a turn that answers a waiting step. Handle the new `"replay-failure"`
  action if you switch over `WorkflowStepResolution`. An `{ action: "execute" }`
  result also carries `resumeReason` (`"interrupted"` or `"retry"`) when the
  step ran before; compare `action` and `attempt` instead of the whole object.
- **Aborted and timed-out steps are `interrupted`, not `failed`.** A step
  stopped by an abort (a closed ADK run, a node `timeout` or the workflow
  execution timeout) is stored as `interrupted` and a `step_interrupted` event
  is emitted. A re-entry without `retryFailedSteps` or `resumePolicy: "retry"`
  fails with `WORKFLOW_INDETERMINATE_STEP`. An abort whose reason is a
  `WorkflowError` with another code now fails the run with `WORKFLOW_ABORTED`;
  read that code from `details.reasonCode`.
  Add the `"interrupted"` member of `WorkflowCheckpointStepStatus` and the
  `step_interrupted` member of `WorkflowEvent` to exhaustive switches (and the
  `checkpoint_size_warning` member, see docs/workflow-durability.md).
  Workflow checkpoints are new in 0.7.0, so no earlier release reads them.
  Checkpoints written by 0.7.0 pre-release builds before this change keep an
  aborted step as `failed` with `WORKFLOW_ABORTED`; they still load, and the
  step is replayed as that failure.
- **A fail-fast sibling is `interrupted`, not `failed`.** When a step fails in
  `ctx.parallel` with `failureMode: "fail-fast"` (the default), a sibling still
  in flight is stored as `interrupted` with `WORKFLOW_ABORTED`
  (`details.reasonCode` is the failing step's code, `details.failedStepId` its
  id) and emits `step_interrupted`, instead of `failed` with the other step's
  error. A resume of such a run now needs `retryFailedSteps` or
  `resumePolicy: "retry"`; without them it fails with
  `WORKFLOW_INDETERMINATE_STEP` instead of replaying the failure. A step still
  queued behind `concurrency` when the failure happens is no longer started:
  before, it ran once a slot was free and was then recorded `failed` with the
  other step's error. Now it is not recorded, so a resume runs it fresh as its
  first attempt. These changes only affect the resume of fail-fast runs
  checkpointed by a 0.7.0 pre-release build: their siblings stay `failed` and
  are replayed as that failure, as before. Read the failing step's code from
  the run's error, not from a sibling's record.
- **A step's text is stored once.** A completed step result in a stored
  checkpoint may have no `content` and `contentFromOutput: true` instead.
  Code that reads checkpoints directly should read step results with
  `workflowStepResultFromCheckpoint()`, which rebuilds `content`; replay does
  this for you. Checkpoints written by an earlier 0.7.0 build load and replay
  unchanged. A build from before this change reads a compact step as having
  no `content`, so do not roll back across it with checkpoints in flight.
- **Checkpoint mismatch details.** Read `details.checkpoint` (stored value)
  and `details.current` (this turn) instead of `details.actual` /
  `details.expected` on `WORKFLOW_INPUT_MISMATCH`, `WORKFLOW_VERSION_MISMATCH`
  and `WORKFLOW_SOURCE_MISMATCH`.
- **Event back-pressure.** Workflow agents wait for the consumer to take each
  event before going on. Keep reading the event stream while a run is in
  progress; a consumer that pauses reading pauses the run.
- **Lock tombstones.** Released locks no longer leave `*.retired.*`
  directories; only recovered locks of dead processes do. The offline
  collectors are unchanged. Watch for the warning
  `WORKFLOW_CHECKPOINT_LOCK_RELEASE_FAILED`: the save succeeded, but the next
  save of that execution fails with `checkpoint_lock_timeout` while the lock
  is left behind. A lock lost to another owner still fails the save with
  `checkpoint_lock_ownership_lost`.
- **Replay mismatches stop the run in `ctx.parallel`.** A checkpoint mismatch
  (`WORKFLOW_STEP_MISMATCH`, `WORKFLOW_INPUT_MISMATCH`,
  `WORKFLOW_VERSION_MISMATCH`, `WORKFLOW_SOURCE_MISMATCH` or
  `WORKFLOW_ATTEMPT_MISMATCH`) is no longer a `failed` outcome of
  `failureMode: "all-settled"`; the run fails at the step that changed. Remove
  code that inspects `*_MISMATCH` outcomes after a fan-out.
- **Nested workflow outcome.** A `WorkflowAgent` used as a step reports its
  final status to the parent. Before, an error event of a retried inner
  attempt could turn a completed nested run into a failed parent step. Code
  that worked around it (for example by re-running the "failed" step) can go.
- **Step limits on a resumed run.** `limits.maxSteps` counts only the steps
  a turn executes; steps replayed from the checkpoint count toward the new
  `limits.maxReplayedSteps` (default ten times `maxSteps`). A run that hit
  `WORKFLOW_LIMIT_EXCEEDED` on resume only because of its replays now
  resumes. Read `details.limitName` (`"maxSteps"` or `"maxReplayedSteps"`) to
  tell which bound stopped the run; the details also carry `executedSteps`,
  `replayedSteps`, `maxSteps` and `maxReplayedSteps`. A step a `beforeStep` or
  `beforeAttempt` hook answers still counts as executed. Callers of
  `runWorkflowScript` replace the `replayedSteps` callback with
  `replaysFromCheckpoint: true`; the host then enforces both bounds and the
  runner only their sum.
- **Host sleep.** Lock wait timeouts (`lockAcquireTimeoutMs`, `lockTimeoutMs`,
  `acquireTimeoutMs`) and the sandbox `cpuTimeMs` budget ignore wall-clock
  steps now, so waking from sleep no longer fails a lock wait at once.
  Workspace and task leases still expire by wall time: a sleep longer than
  `leaseTtlMs` loses the lease (`WORKFLOW_WORKSPACE_LEASE_LOST`). Keep long
  runs awake (`caffeinate -i` on macOS) and resume with the same execution id;
  see
  [Host sleep and wall-clock steps](./workflow-durability.md#host-sleep-and-wall-clock-steps).

### Script sandbox stack limit

- **`stackBytes` default is 32 KiB and the maximum is 32 KiB.** A script
  workflow with a larger `stackBytes` (the default was 512 KiB) throws
  `WORKFLOW_DEFINITION_INVALID` when its `ScriptWorkflowAgent` is built; remove
  the override or set 32768 or less. `QUICKJS_MAX_STACK_BYTES` is exported from
  `adk-llm-bridge/workflows`. The limit allows about 190 nested calls; flatten a
  deeper recursion into a loop. A custom `WorkflowScriptRuntime` can implement
  `validateLimits` to be checked at construction too.
- **A host stack overflow resets the sandbox.** A script that exhausts the host
  stack (for example `eval` of a deeply nested source) ends with
  `WORKFLOW_LIMIT_EXCEEDED`. Other script sessions running at that moment fail
  their next turn with `WORKFLOW_EXECUTION_ERROR`; start them again. See
  [Script sandbox stack](./workflow-orchestration.md#script-sandbox-stack).

### Model and input changes on replayed steps

- Nothing breaks. Older checkpoints load: their steps have no model record and
  no fingerprint, so a model change on them is not reported per step (the turn
  logs one `WORKFLOW_STEP_MODEL_UNRECORDED` with the count) and an input hint
  says `not-recorded` until the step runs again.
- A changed model on a replayed step is now a `step_model_changed` event and a
  `WORKFLOW_STEP_MODEL_CHANGED` warning; the saved result is still used. If you
  match on events exhaustively, handle the new type.
- `ExternalAgentWorkflowFactory` no longer puts `config.model` in the agent
  revision. If you relied on a model change stopping replay, set
  `replay: { modelChange: "mismatch" }` with `requireExplicitModel` and full
  model ids, or put the model in `agentRevision` yourself.
- Strict mode on an execution started before the upgrade fails on every reused
  step, because the saved steps have no model record. Resume such executions in
  the default `warn` mode.
- Step inputs are fingerprinted by default (`inputLength`, and `inputDigest`
  for inputs over 256 UTF-16 code units). Keep secrets out of step inputs, or
  set `replay.inputDigest: false`; see the residual in the durability guide.
- `WORKFLOW_STEP_MISMATCH` details gain `mismatch`. To see what changed in an
  input, set `replay.onStepMismatch` (or read the
  `WORKFLOW_STEP_MISMATCH_HINT` warning) and look at the window with
  `workflowStepInputCanonicalForm(input).slice(start, end)`.
- Recipe for an input that changed but is known to be equivalent (the
  "edited a prompt file mid-run" case): read the hint to see what changed. If
  it is equivalent, copy `savedInputHash` and `inputHash` from the mismatch
  details into a `replay.acceptChanges` entry (`kind: "input"`, with a
  reason), in an operator-only file, and relaunch. The step replays and the
  checkpoint records the acceptance. Do not edit the checkpoint.
- Acceptances come only from a host-only source: never read them from a file
  inside an agent's `workingDirectory`, `allowedPaths` or `readPaths`, or a
  lane worktree. An agent that can write that file can make a gate replay an
  old verdict for changed code. The new event type `step_change_accepted` joins
  `WorkflowEvent`; if you match on events exhaustively, handle it.

## 9. Deprecated names

These names still work: each is a `@deprecated` alias of the same type, class
or value, kept until the next major version. Rename them when convenient; the
new names have the same shape, so the change is a find-and-replace.

| Deprecated | Use | Entry point |
| --- | --- | --- |
| `AIGatewayConfig` | `AIGatewayProviderConfig` | `adk-llm-bridge` |
| `RegisterOptions` | `AIGatewayRegisterOptions` | `adk-llm-bridge` |
| `OpenRouterConfig` | `OpenRouterProviderConfig` | `adk-llm-bridge` |
| `CustomLlmConfig`, `CustomLlmProviderConfig` | `CustomProviderConfig` | `adk-llm-bridge` |
| `CustomProviderRegistrationConfig` | `CustomRegisterOptions` | `adk-llm-bridge` |
| `ADKSessionCheckpointStore` | `AdkSessionCheckpointStore` | `adk-llm-bridge/workflows` |
| `ADKSessionCheckpointStoreOptions` | `AdkSessionCheckpointStoreOptions` | `adk-llm-bridge/workflows` |
| `DEFAULT_CLAUDE_SDK_TOOLS` | `DEFAULT_CLAUDE_TOOLS` | `adk-llm-bridge/agents` |
| `LEGACY_RECOVERABLE_ERROR_CODES` | `normalizeRecoverableErrorCode()` | `adk-llm-bridge/agents` |

The config types now follow one scheme: `<Provider>ProviderConfig` for a
model's config and `<Provider>RegisterOptions` for a `register*()` function.
`setConfig`, `getConfig` and `resetConfig` were already deprecated in favor
of `setProviderConfig`, `getProviderConfig` and `resetProviderConfig`.

## Coming from the 0.6.0 tag

0.6.0 added external agents and was released on GitHub only. Everything above
applies. The external-agent APIs are not new to you: sections 6 and 7 list the
changes in their behavior. The runtime and peer changes in section 1 apply
from 0.6.0 as well: 0.6.0 still supported ADK below 2.
