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

## 3. Logging and validation

- Warnings no longer use `console.warn`. They go through ADK's logger with the
  `[adk-llm-bridge]` prefix and a stable code (for example
  `BUILTIN_TOOLS_DROPPED`). Use ADK's `setLogger` / `setLogLevel` to capture or
  silence them.
- Invalid configuration (for example an empty API key or model id) throws
  ADK's `InputValidationError`. Credentials are redacted from the message.

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
- **Errors.** "Usage limit" errors from Codex are now non-recoverable
  `CODEX_QUOTA_EXHAUSTED`.
- **Capabilities.** The Codex and Gemini CLI definitions no longer declare
  `tools` / `mcpServers` support.
- **Isolated Claude agents.** `ClaudeAgent` no longer inherits the host's
  Claude Code setup. If your agent relied on host tools (Task sub-agents,
  Skill, cron, worktrees...), on MCP servers from your user or project
  config, or on claude.ai connectors, pass a driver:
  `driver: new ClaudeAgentSdkDriver({ inheritHostConfig: true })`, or list the
  built-in tools you need with
  `driver: new ClaudeAgentSdkDriver({ tools: [...DEFAULT_CLAUDE_SDK_TOOLS, "Task"] })`.
  `settingSources` still defaults to `[]`. Under `read-only`, write, shell and
  web tools are no longer offered to the model (calls to them were already
  denied).
- **Spans.** External agent spans carry the real model and run usage, and a
  delegation is one `execute_tool transfer_to_agent` span around the
  sub-agent's run. If you query traces for the previous 0 ms span pairs or for
  `gen_ai.request.model = "claude"`, update those queries.

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

## Coming from the 0.6.0 tag

0.6.0 added external agents and was released on GitHub only. Everything above
applies. The external-agent APIs are not new to you: sections 6 and 7 list the
changes in their behavior. The runtime and peer changes in section 1 apply
from 0.6.0 as well: 0.6.0 still supported ADK below 2.
