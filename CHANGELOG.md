# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] - 2026-11-09

0.7.0 is the first npm release after 0.5.3: 0.6.0 was published on GitHub only.
It contains everything from [0.6.0](#060---2026-06-20) plus the changes below.
See [docs/migration-0.7.md](./docs/migration-0.7.md) to upgrade from 0.5.3 or
from the 0.6.0 tag.

### Breaking

- **Model checks on the external agent drivers** (`EXTERNAL_AGENT_MODEL_*`,
  see [Model](./docs/external-agent-isolation.md#model)):
  - `ClaudeCliDriver` with a blank `model` throws `ExternalAgentPolicyError`
    `EXTERNAL_AGENT_MODEL_INVALID` instead of `InputValidationError`.
  - `ClaudeAgentSdkDriver` and `CodexSdkDriver` reject `model: ""` (it used to
    run the default model silently), and every driver rejects ids with
    whitespace or a leading `-` (`EXTERNAL_AGENT_MODEL_INVALID`).
  - `args`/`config` that set, remap or route the model are refused even with
    `allowPolicyOverrideArgs` (`EXTERNAL_AGENT_MODEL_OVERRIDE`): Claude CLI
    `--model`, `--fallback-model`; Codex CLI `--model`/`-m`, `--oss`,
    `--local-provider`, `--profile`/`-p`, and `-c` keys `model`,
    `model_provider`, `model_providers`, `oss_provider`, `openai_base_url`,
    `chatgpt_base_url`, `model_catalog_json`, `model_catalog_url`, `profile`,
    `profiles`; the same keys anywhere in the Codex SDK `config`.
  - A run whose environment would carry a model-selection variable
    (`ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_*_MODEL`,
    `ANTHROPIC_SMALL_FAST_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`,
    `GEMINI_MODEL`, and for Codex `OPENAI_BASE_URL`, `CODEX_OSS_BASE_URL`,
    `CODEX_OSS_PORT`) through a custom provider `envAllowlist` is refused
    (`EXTERNAL_AGENT_MODEL_OVERRIDE`).
  - `GeminiCliDriver` refuses a read-only run (`--approval-mode=plan`) when
    `model` is set or `requireExplicitModel` is true, because plan mode may
    route turns to another model (`EXTERNAL_AGENT_MODEL_OVERRIDE`).
- **OpenAI-compatible `candidatesTokenCount` no longer includes reasoning
  tokens.** It is now `completion_tokens` minus
  `completion_tokens_details.reasoning_tokens`, as genai and Gemini define it,
  and `thoughtsTokenCount` keeps the reasoning part. Candidates plus thoughts
  equals `completion_tokens`; `totalTokenCount` is unchanged. ADK main adds
  the two for `gen_ai.usage.output_tokens`, which double counted reasoning
  before. ADK 2.4 writes only `candidatesTokenCount` to that attribute, so on
  2.4 it no longer counts reasoning tokens, the same as for Gemini.
- **`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` (or `1`) keeps
  content off the bridge's spans.** As on ADK main, the old boolean form means
  `EVENT_ONLY` (content on log records only). Only `SPAN_ONLY` and
  `SPAN_AND_EVENT` put content on spans. When the variable is unset, the
  bridge still follows `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS`.
- **Node.js `>=22.0.0` is now required** (`openai` 7 requires it).
- **AI Gateway reads only `AI_GATEWAY_API_KEY` and `AI_GATEWAY_URL`.** It no
  longer falls back to `OPENAI_API_KEY` / `OPENAI_BASE_URL`. A host that set
  only an OpenAI key now gets `[ai-gateway] API key is required`; set
  `AI_GATEWAY_API_KEY` or pass `apiKey`.
- **OpenAI sends `max_completion_tokens`, and GPT-6 and later are reasoning
  models.** The OpenAI provider sends `maxOutputTokens` as
  `max_completion_tokens` for every model (OpenAI deprecates `max_tokens`).
  On every provider, `gpt-<N>` with N of 5 or more and the o-series `o<N>` are
  OpenAI reasoning models: they get `max_completion_tokens` and
  `reasoning_effort`, and lose `temperature`, `top_p`, stop sequences,
  penalties and logprobs.
- **Peers:**
  - `@google/adk` is now `>=2.4.0 <3`. ADK 0.x and 1.x are no longer supported.
  - `@google/genai` (`>=2.29.1 <3`) and `@opentelemetry/api` (`>=1.9.1 <2`) are
    now required peers. `@opentelemetry/api` was a regular dependency before.
  - `zod` is an optional peer at `^4` (ADK 2.4 requires zod 4); zod 3 is no
    longer supported.
  - `@anthropic-ai/claude-agent-sdk` `>=0.3.319 <0.4` and `@openai/codex-sdk`
    exactly `0.167.0` (optional, for `adk-llm-bridge/agents`). The Codex SDK
    range narrows from `>=0.167.0 <0.168` to `0.167.0`, because the contained
    exec copy (see Fixed) is verified against that exact version.
  - `quickjs-emscripten-core` and `@jitl/quickjs-wasmfile-release-sync`
    `>=0.32.0 <0.33.0` (optional, new, for `ScriptWorkflowAgent`).
- **Providers throw by default.** With the new `errorMode: "throw"` default, a
  failed provider call throws `ProviderLlmError` instead of returning an
  `LlmResponse` with `errorCode`. This enables ADK's `onModelErrorCallback` and
  `RoutedLlm` failover. `afterModelCallback` no longer sees provider errors in
  this mode. Use `errorMode: "response"` for the previous behavior.
- Truncated or invalid tool-call arguments now produce
  `finishReason: MALFORMED_FUNCTION_CALL` with an `errorCode`, instead of
  running the tool with `{}`.
- Warnings go through ADK's logger (`setLogger`) with stable codes and the
  `[adk-llm-bridge]` prefix; `console.warn` is no longer used.
- Invalid configuration (for example a missing API key, an empty model or an
  invalid base URL) throws ADK's `InputValidationError`, with credentials
  redacted from the message. `registerCustomProvider` validation failures throw
  it too. It extends `Error`, so existing `catch` blocks keep working.
- Anthropic `promptTokenCount` now includes cache-read and cache-creation
  tokens.
- `candidateCount` other than `1` is rejected on OpenAI-compatible providers
  ([#88](https://github.com/pailat/adk-llm-bridge/issues/88)) with
  `InputValidationError`, thrown before any provider call in every
  `errorMode` (never a `ProviderLlmError` or an error response).
- `timeout`, `maxRetries` and Anthropic's `maxTokens` must be integers: a
  fraction, `NaN`, `Infinity` or a non-number throws `InputValidationError`
  (from the model constructor and from `register*()`) instead of being passed
  on or falling back to the default. `timeout` can be at most 2147483647 ms,
  because a larger value overflows the timer and aborted every request at
  once. Integers below the minimum are still clamped, and `null` counts as
  unset.
- A streamed reply that ends before its final chunk (no `finish_reason`,
  including a `[DONE]` without one, or no Anthropic `message_stop`) fails with
  `INCOMPLETE_STREAM` (thrown by default; a terminal error response with
  `errorMode: "response"`) instead of ending after the partials.
- **External agents** (`adk-llm-bridge/agents`):
  - the native `transfer_to_agent` call uses `{ agent_name }` (ADK 2.1+)
    instead of `{ agentName }`;
  - the default delegation is `delegation: { finalAnswer: "subagent" }`: the
    `transfer_to_agent` response carries `skipSummarization: true` and the
    sub-agent's answer is final. Use `finalAnswer: "coordinator"` to let the
    coordinator write the final answer (fan-out, aggregation);
  - the Codex and Gemini CLI definitions no longer declare `tools` or
    `mcpServers` support.
  - `ClaudeAgent` with its default Claude Agent SDK driver no longer inherits
    the host's Claude Code setup. The agent gets the built-in tools in
    `DEFAULT_CLAUDE_TOOLS` (alias `DEFAULT_CLAUDE_SDK_TOOLS`; Read, Glob, Grep, Edit, Write, NotebookEdit,
    Bash, WebFetch, WebSearch, TodoWrite) plus the bridge's own tools. Host
    tools (Task, Skill, cron, worktrees, Workflow, ToolSearch, messaging), MCP
    servers from other config and claude.ai connectors are off, and bundled
    skills are hidden from the model. Pass
    `driver: new ClaudeAgentSdkDriver({ tools: [...] })` to choose the built-in
    tools, or `driver: new ClaudeAgentSdkDriver({ inheritHostConfig: true })`
    to restore the host setup;
  - under a `read-only` policy, the Claude Agent SDK driver removes write and
    shell tools (Edit, Write, MultiEdit, NotebookEdit, Bash, PowerShell) from
    the model's tool list. WebFetch/WebSearch are removed from the default
    tool list in every mode unless `allowNetwork: true`. Calls to removed
    tools are still denied. A Claude agent whose `tools` name WebFetch or
    WebSearch (in any case) while the network is off is refused at run start
    with `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE` instead of running without
    them;
  - external agent spans changed shape: a delegation is one
    `execute_tool transfer_to_agent` span instead of a call/response pair of
    0 ms spans, Codex item progress no longer has its own
    `execute_tool <itemType>` span, and bridge tool spans set
    `llm_request`/`llm_response` to `"{}"`, as ADK's tool spans do.
  - `ClaudeCliDriver` is isolated from the host's Claude Code configuration
    by default, like the SDK driver: an explicit tool list
    (`DEFAULT_CLAUDE_TOOLS`), no MCP servers, settings files, skills or
    claude.ai connectors. New options `tools` and `inheritHostConfig: true`
    (restores the previous behavior);
  - network is off unless the policy sets `allowNetwork: true`. An unset
    `allowNetwork`, or no `permissions` at all, now means `false` everywhere:
    at the root, in workflow steps (a root `WorkflowAgent` applies no
    ceiling, so a step with `allowNetwork: true` keeps network), in delegated
    children (a child under an `ExternalAgent` cannot turn network on) and in
    a driver run directly. Agents that need the network must set
    `allowNetwork: true`. Without it, shell commands and MCP tools are kept
    off the network (see Security): Claude agents run Bash in the Claude Code
    sandbox; the run fails at start where the sandbox cannot run (Windows,
    Linux without bubblewrap), unless the driver has
    `allowUnsandboxedShell: true`. Codex agents in `full-access` mode, and
    Codex drivers given a prebuilt `sdk` client, are refused with
    `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE` unless the driver has
    `allowUnenforcedNetwork: true`. In the other modes every Codex run lists
    the host MCP servers with `codex mcp list --json` to turn them off, and is
    refused with the same error when the listing fails or a server name
    cannot be turned off;
  - Gemini CLI agents without `allowNetwork: true` are refused with
    `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE` in every mode, because Gemini's web
    tools and MCP servers cannot be kept off the network. Set
    `allowNetwork: true` in the agent's permissions (the error message says
    so), or build `GeminiCliDriver` with `allowUnenforcedNetwork: true`;
  - `ClaudeAgentSdkDriver` throws `InputValidationError` when
    `requiredMcpServers` names a server other than `adk_bridge` without
    `inheritHostConfig: true`; such a server could never connect in an
    isolated run. The tools of every required server count as expected in the
    isolation check;
  - a missing optional dependency is an error event instead of an exception
    from the agent: `EXTERNAL_AGENT_DEPENDENCY_MISSING` for
    `@anthropic-ai/claude-agent-sdk` or `@openai/codex-sdk`, `MISSING_BINARY`
    (`EXTERNAL_AGENT_MISSING_BINARY`) for the `claude`, `codex` or `gemini`
    binary. The message names the install command.
- **Agent invocation gateway:**
  - `AgentInvocationResult.output` is the text of the last final response, as
    with ADK's Runner and `AgentTool`. The previous concatenation of all text is
    now `transcript`;
  - `sessionHistoryMode` defaults to `replace` (was `inherit`), and `merge`
    mode passes a deep copy of the parent state (values that cannot be cloned
    are omitted);
  - `AgentInvocationErrorKind` has a new `"invalid-resume"` member (exhaustive
    switches must handle it).
- **Workflows** (`adk-llm-bridge/workflows`):
  - no longer re-exports `BaseAgent`; import it from `@google/adk`;
  - new `"waiting"` status, `step_waiting`/`workflow_waiting` events and the
    `WORKFLOW_STEP_INTERRUPTED` error code (exhaustive switches must handle
    them). Checkpoints that contain a waiting step cannot be read by earlier
    versions;
  - a step whose agent stops on an ADK interrupt (for example a tool
    confirmation) ends the run as `waiting`, instead of completing with empty
    output;
  - a change commit or integration journaled by a 0.7.0 pre-release build and
    retried after upgrading fails closed with an intent mismatch. Let in-flight
    `WorkflowValidatedCommitter` / `WorkflowValidatedIntegrator` operations
    finish before upgrading, and do not retry one under a new `operationId`
    without checking the target ref;
  - the workflow control plane validates every command payload (exact keys,
    types, enums, bounds, JSON limits) before calling a controller. Malformed
    payloads that used to reach a controller now fail earlier with
    `WorkflowControlPlaneError` code `WORKFLOW_CONTROL_INVALID_REQUEST`, where
    they used to give `WORKFLOW_EXECUTION_INVALID_REQUEST`,
    `WORKFLOW_ORCHESTRATION_INVALID_REQUEST`, `WORKFLOW_TASK_INVALID_REQUEST`
    or a `TypeError`. Empty `executionId`/`artifactId` strings are rejected.
    Cross-field plan rules keep `WORKFLOW_ORCHESTRATION_INVALID_REQUEST`;
  - `QuickJSModuleLoader` returns `Promise<QuickJSModuleLike>` (a new
    structural type) instead of `QuickJSWASMModule`, so the published
    declarations no longer import the optional `quickjs-emscripten-core` peer.
    Loaders that return a real module still type-check.

- **External agent surface and codes** (`adk-llm-bridge/agents`):
  - error codes are provider neutral: `AUTH_ERROR`, `BILLING_ERROR`,
    `QUOTA_EXHAUSTED`, `MAX_BUDGET_EXCEEDED`, `MAX_TURNS_EXCEEDED`,
    `MAX_STRUCTURED_OUTPUT_RETRIES`, `MAX_OUTPUT_TOKENS`, `INVALID_REQUEST`,
    `MISSING_BINARY`, `RATE_LIMIT`, `SERVER_ERROR`, `TRANSPORT_ERROR` (type
    `RecoverableErrorCode`). They replace `CLAUDE_AUTH_ERROR`,
    `CLAUDE_AUTH_STATUS`, `CODEX_AUTH_ERROR`, `CLAUDE_BILLING_ERROR`,
    `CODEX_QUOTA_EXHAUSTED`, `error_max_budget_usd`, `error_max_turns`,
    `error_max_structured_output_retries`, `max_output_tokens`,
    `CLAUDE_INVALID_REQUEST`, `CODEX_MISSING_BINARY`, `CLAUDE_RATE_LIMIT`,
    `CLAUDE_SERVER_ERROR` and `TRANSIENT_ERROR`; the old codes are documented
    aliases (`LEGACY_RECOVERABLE_ERROR_CODES`, `normalizeRecoverableErrorCode`).
    A usage cap is `QUOTA_EXHAUSTED` for every runtime. Explicit codes the
    classifier knows are reported as the neutral code (a Codex line with
    `code: "rate_limit"` reports `RATE_LIMIT`; an old code reports its
    replacement). Unknown Claude SDK error subtypes report
    `CLAUDE_AGENT_SDK_ERROR` / `CLAUDE_AGENT_SDK_RESULT_ERROR` instead of the
    raw subtype. The undocumented subtypes `transport`, `transient` and
    `missing_binary` are gone: `{ code: "transport" }` keeps its raw code and
    is not recoverable by default;
  - `ExternalAgentDefinition.capabilities` is removed; read
    `agent.driver.capabilities?.()`. The Claude CLI and Codex CLI drivers
    implement `capabilities()`;
  - `ExternalAgentDefinition.createDriver` takes the agent's `driverOptions`;
    `createExternalAgent()`, `createExternalAgentConfig()` and
    `registry.create()` apply them and throw `InputValidationError` for
    `driver` plus `driverOptions`, or `driverOptions` with a definition that
    has no `createDriver`;
  - `ExternalAgentAuthKind` no longer includes `"custom"`. A credential of any
    kind other than `env` or `none` ends the turn with
    `EXTERNAL_AGENT_CREDENTIAL_UNSUPPORTED`;
  - `CodexAgent` reads credentials with `EnvCredentialProvider` by default
    (allow-listed `CODEX_*` variables), like `ClaudeAgent` and
    `GeminiCliAgent`;
  - `ExternalAgent` no longer sends `runtimeSession` to the driver (it carried
    the invocation id, not a runtime session id); the SDK drivers resume
    `request.runtimeSession.id` when a host sets it (Claude:
    `resumeSessionId`, then `runtimeSession.id`, then session state, then
    memory; Codex: `runtimeSession.id`, then session state).
    `ExternalAgentRunRequest.tools`, `ToolGateway.listSubAgents()` and
    `AgentRuntimeRequestMetadata` are removed;
  - a parent's relative `allowedPaths` roots no longer pass to a delegated
    agent; a child of a parent with only relative roots gets `[]`, and a
    child's own relative roots stay only when the parent sets no
    `allowedPaths`. `ExternalAgentPermissionPolicy` has a new optional
    `pathBounds` field, validated with the rest of the policy (a malformed
    value throws `InputValidationError`);
  - `adk-llm-bridge/agents` no longer exports `SubprocessJsonlDriver`,
    `SubprocessJsonlDriverConfig`, `contentsToSdkMessages`,
    `summarizeHistoryForColdStart`, `userContentToCodexInput`,
    `CodexInputMapperOptions`, `CodexInputMapping`,
    `collectContents`, `flattenContentsToPrompt`,
    `mapPolicyToClaudeSdkPermission`, `mapPolicyToCodexArgs`,
    `mapPolicyToCodexSdkThreadOptions`, `mapClaudePermissionArgs`,
    `mapGeminiPermissionArgs`, `buildGeminiArgs`,
    `mapPermissionPolicyToFlags`, `ProviderPermissionFlags`,
    `externalAgentProviderRegistry` or `externalAgentDefinitionRegistry`.
- **Workflow surface, identifiers, paths and codes**
  (`adk-llm-bridge/workflows`, `adk-llm-bridge/workflows/node`):
  - `WorkflowControlPlane` rejects `execution.*`, `artifact.*` and
    `integration.validate` without an authorized actor unless
    `trustedHostMode` is on, and actor failures use the new
    `WORKFLOW_CONTROL_UNAUTHORIZED` instead of
    `WORKFLOW_CONTROL_INVALID_REQUEST` (see Security);
  - artifacts are keyed by execution: `WorkflowArtifactStore` stores an
    artifact under `(executionId, artifactId)`, so the same id in two
    executions names two artifacts and never conflicts. `get` takes
    `{ executionId, artifactId }` and `list` requires `executionId`, and so
    do the `artifact.get` and `artifact.list` payloads (an `artifact.list`
    without `executionId` is `WORKFLOW_CONTROL_INVALID_REQUEST`, even in
    trusted host mode). Artifact execution ids use the record grammar. A
    missing or invalid execution or artifact id throws the new
    `WorkflowArtifactIdentityError` (`WORKFLOW_ARTIFACT_IDENTITY_INVALID`, a
    `TypeError`). Custom stores must key by both ids; see the migration guide;
  - both entries export explicit lists. Internal helpers are no longer
    exported: `immutableJson`, `immutableTaskJson`,
    `immutableWorkflowOrchestrationJson`, the
    `DEFAULT_WORKFLOW_{EXECUTION,TASK,ORCHESTRATION}_JSON_LIMITS` constants and
    their `Workflow{Execution,Task,Orchestration}JsonLimits` types,
    `validateExecutionId`, `validateIdentifier`, `validateTaskHandle`,
    `isTerminalTaskStatus`, `workflowCheckpointKey`,
    `toDurableWorkflowCheckpoint`, `isWorkflowCheckpointV1`, `canonicalJson`,
    `optionalJsonObject`, `requiredResourceIdentity`, `snapshotJson`,
    `throwIfResourceAborted`, `workflowMutationReservations`,
    `validateWorkflowPath`, `verifyWorkflowChangeSet`,
    `normalizeAuthoritativeIntegrationRequest` and
    `requireWorkflowActorContext`;
  - `WorkflowDefinitionRegistry` is keyed by id and version: `get`, `has`,
    `require` and `delete` take `(id, version)`, `versions(id)` is new, and
    `require` throws the new `WORKFLOW_DEFINITION_NOT_FOUND` (was
    `WORKFLOW_DEFINITION_INVALID`);
  - workflow definition ids and versions must match `A-Z a-z 0-9 . _ : + / -`,
    start with a letter or digit, and be at most 256 characters
    (`Code Review`, `pkg@1.2.3`, `café`, `_a` and `" a "` are rejected with
    `WORKFLOW_DEFINITION_INVALID`);
  - one identifier grammar set: actor `agentId`, `executionId` and `taskId`,
    message, grant and proposal ids, and change-set execution, task, agent,
    grant and reservation ids accept only `A-Z a-z 0-9 . _ : -` (up to 256);
    `actorId` still allows `@` and `/` but not `+`; resource ids allow 256
    characters (were 128); `plan.baseRevision` uses the revision grammar (no
    spaces); `InMemoryWorkspaceProvisioner` requires record ids for
    `executionId` and `taskId`;
  - one portable path grammar for leases, change sets, claims and the Git
    driver: `normalizeWorkspacePath` rejects `\` (it used to convert it to
    `/`), backslashes, NUL, `..` segments, paths over 4096 characters, and a
    first segment of one letter and a colon (a drive prefix, so `C:x`, `x:y`
    and `a:b.txt` are rejected);
  - an unauthorized orchestration actor throws
    `WORKFLOW_ORCHESTRATION_UNAUTHORIZED` (was
    `WORKFLOW_ORCHESTRATION_INVALID_REQUEST`); `details.reason:
    "unauthorized"` is kept for this release;
  - `WORKFLOW_PLAN_STALE` is the one stale-revision code, raised when an actor
    or task is bound to a revision older than the active plan (a task bound to
    an inactive revision used `WORKFLOW_OWNERSHIP_STALE`); an actor bound to
    another revision (one not active yet, or an older one it asks to read)
    gets `WORKFLOW_ORCHESTRATION_UNAUTHORIZED`;
  - `WorkflowTaskDispatcher.sweep` throws `WorkflowTaskControlError` with
    `WORKFLOW_TASK_INVALID_REQUEST` for a bad request, limit or cursor (was
    `TypeError`);
  - `WorkspaceLeaseLossReason.code` is `WORKSPACE_LEASE_LOST` or
    `WORKSPACE_ADAPTER_DISPOSED` (was lower case);
  - `NodeGitWorktreeError` adds `GIT_COMMAND_FAILED` (a failed `git` process,
    raised as a raw `ExecException` until now, or unreadable Git output, with
    `cause`) and `GIT_ENTRY_UNSUPPORTED` (unsupported tree or filesystem
    entry, including an untracked nested Git repository in a worktree). Both
    used `GIT_CONFIGURATION_INVALID` before, which now covers caller input
    only: a `repoRoot` outside a repository, an unknown `baseRevision` and an
    invalid `commandTimeoutMs` are `GIT_CONFIGURATION_INVALID` instead of a
    raw `ExecException` or `TypeError`;
  - a recorded step failure is replayed when the execution is entered again
    (a `step_failed` event with `failure.replayed: true`, and the same error
    code, message and details), instead of throwing a new
    `WORKFLOW_EXECUTION_ERROR` "requires resumePolicy retry". A turn that
    answers a waiting step always replays it, even with `retryFailedSteps` or
    `resumePolicy: "retry"`; other re-entries still re-run it with either.
    `WorkflowStepResolution` gains the `"replay-failure"` action and
    `WorkflowStepFailure` the optional `replayed` flag;
  - `WORKFLOW_INPUT_MISMATCH`, `WORKFLOW_VERSION_MISMATCH`,
    `WORKFLOW_SOURCE_MISMATCH` and the id mismatches of
    `validateWorkflowCheckpoint` name the stored value `details.checkpoint`
    and the value of the current turn `details.current` (were `actual` and
    `expected`, which read backwards);
  - `WorkflowAgent` and `ScriptWorkflowAgent` deliver events with
    back-pressure: the run continues only after the consumer has handled an
    event and asked for the next one, as with any ADK agent. A consumer that
    stops reading pauses the run.

- **Drivers that cannot check tool paths refuse `allowedPaths`.**
  `ClaudeCliDriver`, `CodexSdkDriver`, `CodexCliDriver` and `GeminiCliDriver`
  run file tools without asking the bridge, so `allowedPaths` (and the
  `pathBounds` a parent agent passes to a delegated child) were never
  enforced on them. A run with either now ends with the new non-recoverable
  error `EXTERNAL_AGENT_PATHS_UNENFORCEABLE`, exported from
  `adk-llm-bridge/agents`. Use `ClaudeAgentSdkDriver`, drop `allowedPaths`,
  or build the driver with the new option `allowUnenforcedPaths: true` to run
  anyway. The `basic-agent-codex` and `codex-workflow` examples no longer set
  `allowedPaths`; the Codex sub-agent of `external-agents` opts in, because it
  inherits the Claude root's paths.
- **The guard exempts only registered bridge tools from the MCP network
  denial.** Without `allowNetwork: true`, the confirmation guard denied every
  `mcp__*` tool except names starting with `mcp__adk_bridge__`, so a host
  server named `adk_bridge__x` was exempt. It now exempts only the tools
  `ExternalAgent` bridged for the run.
- **New `interrupted` workflow step status and `step_interrupted` event.**
  `WorkflowCheckpointStepStatus` and `WorkflowEvent` each gain a member, so an
  exhaustive `switch` over either stops compiling until it handles the new
  case. Workflow checkpoints are new in 0.7.0 (0.6.0 has no workflows), so
  no earlier release reads them. A step stopped by an abort or by the
  workflow execution timeout is stored as `interrupted`, and a re-run without
  `retryFailedSteps` or `resumePolicy: "retry"` fails with
  `WORKFLOW_INDETERMINATE_STEP`. Checkpoints written before keep an aborted
  step as `failed` with `WORKFLOW_ABORTED` and still replay it as that failure.
  The new `WorkflowStepInterruptedEvent` type is exported from
  `adk-llm-bridge/workflows`.
- **Boolean driver options must be booleans.** Every `?: boolean` option of
  `ClaudeAgentSdkDriver`, `ClaudeCliDriver`, `CodexSdkDriver`, `CodexCliDriver`
  and `GeminiCliDriver` (for example `allowUnsandboxedShell`,
  `inheritHostConfig`, `allowLocalBinding`, `allowUnenforcedPaths`,
  `allowUnenforcedNetwork`, `allowPolicyOverrideArgs`,
  `allowUncontainedCodexSdk`, `strictBinaryResolution`, `requireExplicitModel`,
  `forkSession`, `debugEvents`, `skipGitRepoCheck`, `webSearchEnabled`) now
  throws `InputValidationError` naming the driver and the option when it is
  set to anything but `true` or `false`. Before, the driver read the value as
  truthy, so an untyped host that passed the string `"false"` (an env var, a
  JSON file) turned the escape hatch ON. Most of these options are new in
  0.7.0; `skipGitRepoCheck` and `webSearchEnabled` on `CodexSdkDriver` exist in
  0.6.0 and only a non-boolean from untyped JavaScript is refused.
- **Unknown options are refused where a typo drops a host limit** (`ExternalAgentWorkflowFactory`
  and `FileSystemWorkflowCheckpointStore`, both new in 0.7.0; see
  [Unknown options](./docs/external-agent-isolation.md#unknown-options)):
  - `new ExternalAgentWorkflowFactory(...)` throws `WorkflowAgentFactoryError`
    `WORKFLOW_AGENT_INVALID_REQUEST` for an unknown top-level option (for
    example `allowFullAccess`, which belongs under `policy`) or an unknown
    `limits` key (for example `maxTurnz`). The message names the key.
  - `new FileSystemWorkflowCheckpointStore(...)` and
    `FileSystemWorkflowCheckpointProvider` throw `WorkflowError`
    `WORKFLOW_DEFINITION_INVALID` (`unknown checkpoint store option: <key>`)
    for an option that is not `root`, `lockTimeoutMs`, `lockRetryMs`, `signal`
    or `maxCheckpointBytes` (the provider also takes `operationTimeoutMs`,
    `retry` and `onOperation`). A misspelled `maxCheckpointBytes` or
    `lockTimeoutMs` used to keep the default silently.

### Security

- **A Claude agent under `allowedPaths` can read its own large tool
  outputs.** Claude Code saves a tool output too large to return inline to
  the session's `tool-results` directory and tells the model to `Read` it;
  the path guard denied that read, so the agent lost its own command output.
  `ClaudeAgentSdkDriver` now lets through `Read` of a file in the
  `tool-results` directory of the session the run started, derived from the
  runtime (session id from `system/init`, transcript path from the hook
  input, config directory from the child environment), never from the
  model. Writes there, other tools, and other sessions' directories stay
  denied; anything that does not match exactly fails closed.
- **A shell tool named in any case gets the no-network sandbox.** Claude Code
  matches built-in tool names case-insensitively, but the Claude drivers
  checked for a shell by exact name, so `tools: ["bash"]` (or `"BASH"`,
  `"powershell"`) ran shell commands without the sandbox while the network was
  off. Built-in names in `tools` are now passed on in their canonical
  spelling (`bash` becomes `Bash`, duplicates collapse), and every check sees
  that spelling.
- **`SqliteSessionStore` refuses an unsafe database path.** A symlink at the
  path (dangling or not) is refused instead of followed, a new file is
  `0600` whatever the umask, and the store refuses a file owned by another
  user or a directory owned by another user (root excepted) or writable by
  others without the sticky bit, with the new `SESSION_STORE_UNSAFE_PATH`.
  An existing directory or file is not re-moded.
- **The SDK drivers no longer run a `claude` or `codex` binary from the run's
  working directory.** `ClaudeAgentSdkDriver` and `CodexSdkDriver` searched
  `<workingDirectory>/node_modules` for the runtime binary before the bridge's
  own install. The agent can write its working directory, so a binary left
  there by one run would start the next run outside the runtime's sandbox.
  The lookup now skips every candidate whose real path (symlinks resolved) is
  at or under a directory the agent may write: the run's `workingDirectory`
  (the process directory when it is unset, the default setup) and its
  `allowedPaths`. That covers `PATH` entries such as the `node_modules/.bin`
  a package-manager script adds, `executableSearchPaths`, and the bridge's
  own install when it lies inside the workspace. `CodexSdkDriver` with the
  network off refuses with `MISSING_BINARY` instead of listing MCP servers
  through a bare `codex` on `PATH`. Explicit paths (`CLAUDE_CODE_EXECUTABLE`,
  `CODEX_EXECUTABLE`, `pathToClaudeCodeExecutable`, `codexPathOverride`) are
  used as given; set one if the only copy lives in the workspace. When the
  bridge finds nothing, the SDK still falls back to the binary bundled with
  its own install, so a host installed inside a workspace the agent can
  write remains exposed: install it outside, give the run another
  `workingDirectory`, or turn on `strictBinaryResolution` to refuse such
  runs.
- **The CLI drivers no longer start a `claude`, `codex` or `gemini` from the
  run's working directory.** `ClaudeCliDriver`, `CodexCliDriver` and
  `GeminiCliDriver` started a bare `command` through the child's `PATH`,
  which under `npm run` / `bun run` starts with `<cwd>/node_modules/.bin`, so
  with the default `workingDirectory` a binary the agent planted there ran
  on the host the next run. With the built-in spawn a bare `command` is now
  resolved to an absolute path, skipping every `PATH` entry whose real path
  is at or under the run's `workingDirectory` (the process directory when it
  is unset) or `allowedPaths`, and every relative or empty entry; the Codex
  MCP listing uses the same path. When nothing is left the run ends with
  `MISSING_BINARY`. A `command` with a path separator and a custom `spawn`
  get `command` as given.
- **A prompt cannot set CLI flags or run a CLI subcommand.** `CodexCliDriver`
  and `ClaudeCliDriver` passed the prompt as a bare argument, so a user
  message such as `--dangerously-skip-permissions` (Claude) or
  `--dangerously-bypass-approvals-and-sandbox` (Codex) was parsed as a flag.
  `CodexCliDriver` now passes `--` before the prompt. `ClaudeCliDriver` writes
  the prompt to `claude -p --input-format text` on stdin and passes no prompt
  argument, because Claude Code runs a subcommand named by its first operand
  even after `--` (a prompt of `update` ran `claude update`). `GeminiCliDriver`
  passes `--prompt=<prompt>` instead of `-p <prompt>`, so `--yolo` stays text.
- **Driver `args` cannot override the policy flags.** `ClaudeCliDriver` and
  `CodexCliDriver` append `args` after the flags they set from the permission
  policy and isolation, so an entry such as `--permission-mode
  bypassPermissions`, `--settings`, `--mcp-config` (Claude) or
  `-c sandbox_workspace_write.network_access=true`, `--sandbox`, `--profile`
  (Codex) could undo them. Such an entry now makes the constructor throw an
  `ExternalAgentPolicyError` with code `EXTERNAL_AGENT_OPTION_UNSUPPORTED`,
  unless the driver is built with `allowPolicyOverrideArgs: true`. A non-string
  `args` entry throws `InputValidationError`. Checked against the real CLIs
  (Claude Code 2.1.322, codex-cli 0.167.0), the list also refuses flags that
  widen the run another way: Claude `--agents`/`--agent` (subagents with their
  own tools and permission mode), `--plugin-url`, `--permission-prompts`,
  `--worktree`/`-w`, `--remote-control`, `--cloud`, `--teleport`,
  `--environment`; Codex `--approve-for-me` (and its hidden alias
  `--not-so-yolo`), `--dangerously-bypass-hook-trust`, `--ignore-rules`
  (it drops the execpolicy rules), `--worktree` and `-c` overrides of
  `approvals_reviewer`, `default_permissions`, `permissions` and `agents`.
  One-letter flag clusters (`-pw`, `-hs danger-full-access`) are split
  before the match. A test pins the CLI versions the list was reviewed
  against. `CodexCliDriver` also refuses a positional word in `args` (an
  entry that is not an option or an option's value, `-` and `--`): `codex
  exec` would read it as a subcommand (`review`, `resume`, `fork`, `help`) or as
  the prompt. Repeat `-i` for several images.
- **`CodexSdkDriver` refuses a thread id that starts with `-`.** The SDK
  passes the id to resume as its own argv entry after `resume`, where codex
  reads `-`-prefixed entries as options, so an id from session state such as
  `--dangerously-bypass-approvals-and-sandbox` would have changed the run's
  policy. Such an id now ends the run with `EXTERNAL_AGENT_OPTION_UNSUPPORTED`
  before anything starts.
- **Codex runs pin the approvals reviewer.** `approvals_reviewer =
  "auto_review"` in `~/.codex/config.toml` turned the CLI's `--ask-for-approval
  never` into `on-request` with a model reviewer, which could approve a
  command outside the sandbox. Both Codex drivers now pass
  `-c approvals_reviewer="user"` outside `full-access`.
- **Dangling symlinks no longer pass the path guard.** A link inside an
  allowed root whose target does not exist yet was compared by its own path,
  so a write through it could land outside the root. The guard now follows
  such links (and denies a symlink loop).
- **`ClaudeAgentSdkDriver` keeps `workspace-write` inside `allowedPaths`.**
  `workspace-write` runs as `acceptEdits`, which approves edits inside the
  working directory without asking, and the Bash sandbox let commands write
  anywhere under the working directory. An agent with
  `allowedPaths: ["<repo>/lib/data"]` in `<repo>` could write `<repo>/app/...`
  with Write and `<repo>/components/...` with Bash. A `PreToolUse` hook now
  runs the path guard on every tool call (Write, Edit, MultiEdit,
  NotebookEdit and the rest), in every permission mode, and the sandbox may
  write only to the allowed roots and the temp directories it always keeps
  writable (below). Claude Code always lets the sandbox write
  to the working directory, so with a shell tool on offer a run whose working
  directory is outside `allowedPaths`, or whose shell runs unsandboxed
  (`allowNetwork: true`, `allowUnsandboxedShell`), is refused with
  `EXTERNAL_AGENT_PATHS_UNENFORCEABLE`. So is a run with `inheritHostConfig:
  true` (host settings merge into the sandbox's writable paths) or whose
  working directory or allowed roots lie in a temp directory the sandbox
  always keeps writable (`/tmp`, the host temp directory, `TMPDIR`). `Glob`
  and `Grep` without a search path, and any relative glob without one (such
  as Gemini `read_many_files` `include`), are checked against the working
  directory. The sandbox confines Bash writes, not reads.
- **The workflow agent factory resolves symlinks before checking roots.**
  `workingDirectory` and `allowedPaths` were checked against
  `workingDirectoryRoots` by lexical path, so a symlink inside a root could
  point outside it. Both sides are now compared as real paths.
- **No polynomial-time regular expressions on caller input.** The
  `errorPrefix` check and the trailing-whitespace trim of a flattened prompt
  backtracked on long runs of `0` or spaces (CodeQL
  `js/polynomial-redos`). They now run in linear time, with the same results.
- **Read-only Claude agents cannot use host MCP tools.** With
  `inheritHostConfig: true`, a host MCP tool that host settings pre-approve
  ran without a prompt, so a `read-only` agent could write through it.
  `ClaudeCliDriver` now always denies `mcp__*` under `read-only`, and
  `ClaudeAgentSdkDriver` adds a `PreToolUse` hook that denies every MCP tool
  except the bridge's own. A `read-only` agent with `requiredMcpServers`
  cannot call those servers' tools. The same denial now applies with
  `inheritHostConfig: true` in `ask`, `workspace-write` and `full-access`
  whenever the policy does not set `allowNetwork: true`: a host MCP server
  runs outside the shell sandbox, so its tools (pre-approved ones too) would
  have reached the network. Set `allowNetwork: true` to use them.
- **AI Gateway no longer sends an OpenAI key to Vercel.** With only
  `OPENAI_API_KEY` set, the gateway sent that key to `ai-gateway.vercel.sh`, a
  host it was not issued for (and `OPENAI_BASE_URL` could redirect gateway
  traffic). Each provider now reads only its own environment variables. The
  OpenAI SDK's own defaults are off for every provider except OpenAI:
  `OPENAI_ORG_ID` / `OPENAI_PROJECT_ID` no longer reach AI Gateway, OpenRouter,
  xAI or custom endpoints as `OpenAI-Organization` / `OpenAI-Project` headers,
  and `OPENAI_ADMIN_KEY` / `OPENAI_WEBHOOK_SECRET` are never read. A
  manually configured `OpenAICompatibleLlm` without `baseURL` throws
  `InputValidationError` instead of using `OPENAI_BASE_URL`.
- **Permission inheritance:** an agent's effective policy is the intersection
  of its own policy and the one it inherits. This holds through ADK
  Sequential/Parallel/Loop agents, `LlmAgent` transfer, `clone()`, ADK
  `Workflow` edges, `runNode`, `NodeTool`, workflow steps, nested gateways,
  state-writing tools and the separate dist bundles. A nested `ExternalAgent`
  never runs wider than the `ExternalAgent`s above it, even when ADK resumes it
  directly. Policies inherited through a session, and the effective policy
  derived from them, are deep-frozen, and the policy registry rejects
  look-alike objects. ADK `AgentTool` still starts a new permission
  chain (documented).
- **Confirmations (human in the loop):**
  - a confirmation never widens the effective policy;
  - `read-only` is never confirmable;
  - paths are normalized and symlink-resolved, and file-tool inputs are
    checked against `allowedPaths`;
  - an answer is bound to its exact call and cannot be replayed.
- In `read-only` mode, a toolset that fails to list its tools is skipped
  instead of being exposed unfiltered.
- `settingSources: []` did not isolate `ClaudeAgent`: the Claude Code CLI still
  loaded its full default tool set, and on a subscription login claude.ai
  connectors could reach the agent through ToolSearch, which put unrelated
  instructions in the agent's context. The Claude Agent SDK driver now passes
  an explicit `tools` list, `strictMcpConfig: true`, `skills: []` and
  `disableClaudeAiConnectors` (see Breaking). `ClaudeCliDriver` is isolated
  the same way through its flags.
- `ExternalAgent` ancestors are detected by a `Symbol.for` brand instead of
  `instanceof`, so a duplicated install or a bundle split can no longer skip an
  ancestor's policy. An ancestor's policy is read through a frozen, validated
  reader; an unreadable policy counts as `ask`.
- With `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=NO_CONTENT` (or
  `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false`), the bridge's spans carry no
  prompts, tool arguments or results, not even in span names or
  `gcp.vertex.agent.event_title`.
- Dynamic scripts have no imports or host globals. Each execution receives a
  fresh QuickJS runtime with CPU, memory, stack, source, message, and step
  limits; ADK work runs outside the VM through a JSON generator/yield protocol.
- Both Claude drivers check the tools and MCP servers the runtime reports at
  start, and every tool the model is about to use. Anything outside the
  configured set ends the run with the non-recoverable error
  `EXTERNAL_AGENT_ISOLATION_VIOLATED`, unless `inheritHostConfig` is set. An
  outside tool is denied before it runs in every permission mode (a
  `PreToolUse` hook in `ClaudeAgentSdkDriver`, a `permissions.deny` rule for
  MCP tools in `ClaudeCliDriver`); the bridge's own tools are matched by their
  registered names. A host admin or managed policy that adds tools or
  connectors, at start or later, no longer goes unnoticed. On
  `ClaudeAgentSdkDriver` a call to a tool the model was not offered, which the
  runtime refuses without running, is reported on its `tool_result` event
  (`metadata.isolation: "EXTERNAL_AGENT_TOOL_NOT_OFFERED"`, new export
  `EXTERNAL_AGENT_TOOL_NOT_OFFERED`) and the run goes on; the third one in a
  run stops it.
- Network is off unless the policy sets `allowNetwork: true`; an unset
  `allowNetwork`, or no policy, is `false`. Keeping it off covers shell
  commands and MCP tools. Claude agents run
  Bash in the Claude Code sandbox with every host denied, in every permission
  mode. The confirmation guard denies MCP tools of other servers and shell
  calls that are not sandboxed, before the approver sees them.
- Without `allowNetwork: true`, `CodexCliDriver` and `CodexSdkDriver` turn off
  every MCP server in the host's Codex config (they run outside the Codex
  sandbox). The servers are listed with `codex mcp list --json`, using the same
  npm-installed binary and `PATH` as the SDK; if the listing fails, or a
  prebuilt `sdk` client is passed, the run is refused with
  `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE` (opt in with
  `allowUnenforcedNetwork: true`). New option `listMcpServers`.
- `CodexCliDriver` pins `sandbox_workspace_write.network_access` and
  `web_search` to the policy, and `CodexSdkDriver` disables network access and
  web search unless `allowNetwork: true`, so a host `config.toml` cannot widen
  them.
- The confirmation path guard checks the path arguments of file tools of every
  runtime (Claude Code, Codex and Gemini CLI names, nested file changes,
  `apply_patch` file headers), and the base of globs that leave the working
  directory (`Glob`, `Grep`'s `glob`, Gemini `glob` and `read_many_files`),
  including brace alternatives and globs relative to the tool's own search
  root (`path`, `dir_path`). Its denial is final: it runs before the approver
  and the ADK confirmation, and no approval overrides it. It does not check
  paths inside shell commands; those rely on the runtime sandbox or the
  `read-only` mode. `PermissionRequest` gains `networkSandbox`.
- `WorkflowControlPlane` no longer serves `execution.*`, `artifact.*` and
  `integration.validate` without a host-authenticated actor unless
  `trustedHostMode` is on. With an actor, these operations are limited to the
  actor's execution; `execution.*` also requires an actor that is not bound to
  a task, and `artifact.put` / `integration.validate` the actor's task when it
  has one. `execution.list` needs `trustedHostMode`.
- The control plane no longer lets one execution use or probe another's
  artifacts. Artifacts are keyed by execution, so another execution can
  neither take an id nor learn that it is used; `artifact.get` for another
  execution returns `undefined` without reading the store, an artifact of
  another execution that a store returns is dropped from `artifact.get` and
  `artifact.list`, and `IntegrationGate` reports another execution's
  artifact like a missing one.
- The Git repository mutation lock can no longer be held by two processes:
  it is published atomically, a dead owner's lock is retired under a
  token-keyed name, and a lock with an unreadable owner is never taken over.
- Git subprocesses ignore `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and
  related variables inherited from the host, the pathspec variables
  (`GIT_GLOB_PATHSPECS`, `GIT_NOGLOB_PATHSPECS`, `GIT_ICASE_PATHSPECS`), hook
  quarantine (`GIT_QUARANTINE_PATH`) and history rewrites
  (`GIT_REPLACE_REF_BASE`, `GIT_GRAFT_FILE`, `GIT_SHALLOW_FILE`); they run
  with `GIT_NO_REPLACE_OBJECTS=1` and treat paths as literal pathspecs.
- Orchestration messages, plans and state, and the in-memory execution, task,
  event and mailbox stores, validate and store one frozen snapshot, so a getter
  or proxy can no longer pass validation with one value and be stored with
  another.
- Script workflows can no longer crash the host or alter host messages by
  replacing `JSON` or generator methods; malformed turns and operations with
  unknown fields fail with `WORKFLOW_SCRIPT_INVALID`. The sandbox checks that
  the compiled factory is a generator function and drives every turn with the
  generator `next` captured before guest code runs, so a forged factory or
  iterator fails with `WORKFLOW_SCRIPT_INVALID`.
- Codex image attachments are written to a private per-run temporary
  directory (mode 0700) with exclusive, owner-only files, and the directory is
  removed when the run ends, including on error and abort. Before, they used a
  predictable shared path that concurrent runs overwrote and that followed
  pre-planted symbolic links.
- A delegated agent's `allowedPaths` are intersected by containment on
  canonical paths (`["/repo"]` with `["/repo/src"]` gives `["/repo/src"]`; it
  gave `[]`). Both sides' roots stay as `pathBounds`, and the guard resolves
  and checks them on every request, so a symlink created or retargeted after
  delegation, or `..`, cannot leave a parent root. A delegated agent no longer
  resolves its parent's relative roots against its own working directory.
- A credential provider that returns an unsupported credential `kind` no
  longer lets the run fall back to the runtime's own login: the credential is
  read once into a frozen copy, and `""`, `"ENV"`, a missing kind or a
  malformed `env` end the turn with `EXTERNAL_AGENT_CREDENTIAL_UNSUPPORTED`
  before the driver starts.
- **Isolated Claude runs turn Claude Code auto-memory off.**
  `ClaudeAgentSdkDriver` and `ClaudeCliDriver` pass `autoMemoryEnabled: false`
  in the flag settings when they isolate, so the agent is no longer told to
  read or write the host's `~/.claude/projects/.../memory/` directory.
  `inheritHostConfig: true` keeps the host's setting. Known limit: Claude Code
  still adds the signed-in account's email to isolated sessions; no SDK option
  or documented setting removes it.
- **The Claude SDK `PreToolUse` hooks deny a call with no tool name.** The
  isolation hook and the read-only MCP hook used to allow it; under isolation
  the run now stops with `EXTERNAL_AGENT_ISOLATION_VIOLATED`. The hook's
  violation message quotes tool names, like the per-message check.

### Added

- **Claude sessions on ADK artifacts (experimental).** `adkArtifactSessionStore()`
  from the new `adk-llm-bridge/agents/session-store/adk-artifacts` subpath keeps
  Claude transcripts in the ADK artifact service of the run (in-memory, file or
  GCS), scoped to the ADK session, with no extra database. `sessionStore` on
  `ClaudeAgentSdkDriver` (and `driverOptions` of `ClaudeAgent`) now also takes a
  `SessionStoreFactory` (type exported from `adk-llm-bridge/agents`), called once
  per run with the invocation context. A run whose context has no artifact
  service ends before the SDK starts with the new non-recoverable
  `CLAUDE_SESSION_STORE_UNAVAILABLE` event (exported from
  `adk-llm-bridge/agents`). `ClaudeCliDriver` still refuses any `sessionStore`.
  See [Persisting Claude sessions](./docs/claude-session-store.md#adk-artifacts).
- **Cost of gateway model calls.** The cost a provider reports on a call (AI
  Gateway and OpenRouter `usage.cost`, streaming and not) is in
  `customMetadata.costUsd`, and `customMetadata.costSource` names the field it
  came from (`cost`, `cost+upstream` or `market_cost`). A BYOK gateway key
  reports `cost: 0`: `costUsd` then adds `cost_details.upstream_inference_cost`
  when that is positive, otherwise it is the gateway's `market_cost`, also
  kept as `marketCostUsd`. A call that is not BYOK keeps `cost`.
  `AgentInvocationUsage` and `WorkflowStepUsage` gain an optional `costUsd` (a
  sum of the reported values, absent when none was reported, so an
  `ExternalAgent` step has none), and the model-call span gets
  `adk_llm_bridge.usage.cost_usd`. Before, a run's cost counted only the
  external agents. See [Prompt caching](./docs/prompt-caching.md#reading-the-cache-usage).
- **`agentKind` on workflow step events and spans.** `step_started` and
  `step_completed` carry `agentKind: "llm" | "external" | "host" | "workflow"`
  (`WorkflowAgentKind`), derived from the step's agent before it runs:
  `ExternalAgent` is `external`, `LlmAgent` (subclasses included) is `llm`, the
  bridge's workflow agents and ADK's `Workflow`, `SequentialAgent`,
  `ParallelAgent` and `LoopAgent` are `workflow`, and any other `BaseAgent` is
  `host`. The same value is the span attribute
  `gcp.vertex.agent.agent_kind`, always on the step's parent `execute_node` span and on `invoke_agent` only for
  `ExternalAgent` runs: ADK 2.4 creates the `invoke_agent` span of `llm`,
  `workflow` and `host` agents privately in `BaseAgent.runAsync`, and the bridge
  has no hook inside it. Additive: events recorded before this have no
  `agentKind` and are still valid. See
  [Which agent ran a step](./docs/workflow-orchestration.md#which-agent-ran-a-step).
- **Prompt caching for Anthropic models** (see [Prompt caching](./docs/prompt-caching.md)):
  a `promptCaching` option, `boolean | { ttl?: "5m" | "1h" }`, on `AnthropicProviderConfig`,
  `AIGatewayProviderConfig` and `OpenRouterProviderConfig`, and on their register options.
  - cache writes are reported in `customMetadata.cacheCreationTokenCount` (Anthropic,
    AI Gateway, OpenRouter, `ExternalAgent`) and on the model-call span as
    `gen_ai.usage.cache_creation.input_tokens`; reads also set
    `gen_ai.usage.cache_read.input_tokens`;
  - `AgentInvocationUsage.cacheCreationTokens` and `WorkflowStepUsage.cacheCreationTokens`
    (optional, absent when no provider reported a write; old checkpoints still load).
- Claude drivers: `smallFastModel` pins the runtime's small/fast model
  (`ANTHROPIC_SMALL_FAST_MODEL`: WebFetch page processing, tool summaries,
  titles, ...); the driver sets it after the model environment check, so a host
  cannot forward the variable. It is required, as a full model id, with
  `requireExplicitModel`. Runs report every model they billed
  (`externalAgentModel.used`, from `usage.byModel`, or from `completed.model`
  for a trusted driver with one billed model) and the ones nobody requested
  (`unexpected`, with an `UNEXPECTED_MODEL` warning under
  `requireExplicitModel`), on events, spans and workflow steps
  (`result.models.used`, `unexpected`). The workflow factory takes
  `config.smallFastModel`. `ExternalAgentDriver` gains the optional members
  `smallFastModel` and `requireExplicitModel`, and `completed` gains
  `modelFromInit`. See [The small/fast model](docs/external-agent-isolation.md#the-smallfast-model-claude).
- Workflow replay records the model each step's agent requested (`model.requested`
  on the checkpoint step) and reports a change on a replayed or resumed step: a
  `step_model_changed` event and a `WORKFLOW_STEP_MODEL_CHANGED` warning.
  `replay.modelChange: "mismatch"` makes it a `WORKFLOW_STEP_MISMATCH` instead
  (both models must be known). A saved step without a record is not compared;
  the turn logs one `WORKFLOW_STEP_MODEL_UNRECORDED` with the count. See
  [Model and input changes on replayed steps](docs/workflow-durability.md#model-and-input-changes-on-replayed-steps).
- `WORKFLOW_STEP_MISMATCH` details gain `mismatch` (the differing parts). An
  input mismatch also gives the host a hint (input lengths and the first
  differing window of the canonical input, with a structural path, never
  input text) through `replay.onStepMismatch` or a
  `WORKFLOW_STEP_MISMATCH_HINT` warning, and never in events, the persisted
  error or the checkpoint. It comes from a per-step input fingerprint
  (`inputLength`, `inputDigest`); `replay.inputDigest: false` turns that off.
  The new `workflowStepInputCanonicalForm()` returns the text the window
  refers to. The residual of the fingerprint is documented in the durability
  guide.
- `replay.acceptChanges`: host-approved input or model changes for completed
  steps, so a relaunch keeps a step's saved result after a known-equivalent
  change. Each entry is bound to the execution, the step and the exact saved
  and current values, with a reason; entries are checked against the
  checkpoint before any step runs (`WORKFLOW_REPLAY_ACCEPTANCE_INVALID`, never
  saved) and applied in one save with an audit entry on the step
  (`acceptances`, `step_change_accepted`, `WORKFLOW_REPLAY_CHANGE_ACCEPTED`).
  A relaunch with the same entry is a no-op. `parseWorkflowReplayAcceptances()`
  validates an operator file. Acceptances must come from a host-only source,
  never a file an agent can write; see
  [Accepting a known-equivalent change](docs/workflow-durability.md#accepting-a-known-equivalent-change).
- **Opt-in strict binary resolution for the SDK drivers.**
  `ClaudeAgentSdkDriver` and `CodexSdkDriver` take `strictBinaryResolution`
  (default `false`, behaviour unchanged). When it is on, no explicit path is
  set and the lookup finds no binary outside the workspace, the run is
  refused with `MISSING_BINARY` instead of letting the SDK fall back to its
  bundled binary, if the bridge's install, the SDK package or the package
  holding its binary overlaps the run's `workingDirectory` or
  `allowedPaths` (at or under one, or containing one), or the SDK package
  cannot be located. An SDK module the host injects is not inspected. `CodexSdkDriver`
  throws `EXTERNAL_AGENT_OPTION_UNSUPPORTED` for the option with a prebuilt
  `sdk` client. It narrows the bundled-binary residual, it does not close
  it: the agent can still edit the installed JavaScript. See
  [Strict binary resolution](docs/external-agent-isolation.md#strict-binary-resolution).
- `QUICKJS_MAX_STACK_BYTES` (32768) from `adk-llm-bridge/workflows`, the largest
  `stackBytes` the bundled script runtime accepts. `WorkflowScriptRuntime` has an
  optional `validateLimits(limits)`; `ScriptWorkflowAgent` calls it when it is
  built, so a `stackBytes` above the maximum throws `WORKFLOW_DEFINITION_INVALID`
  at construction, not at the first run.
- Workflow factory `config.model`: `ExternalAgentWorkflowFactory` forwards it
  to the driver as the `model` option, checks it as applied
  (`WORKFLOW_AGENT_MODEL_NOT_APPLIED`: nothing is registered when the driver
  does not keep exactly that id) and records it in the agent descriptor. The
  revision leaves out the top-level `config.model`, so an agent keeps its
  revision whatever model it names (see Changed below). With a model, the
  definition's `createDriver` receives `{ model }` (and `requireExplicitModel`)
  where it received no options: a custom definition must merge them into its
  own defaults.
- `requireExplicitModel` on `ExternalAgentWorkflowFactory`: a request without
  `config.model`, or with a router or default alias of a built-in provider id
  (`claude`, `gemini-cli`), fails with `WORKFLOW_AGENT_MODEL_REQUIRED` before
  the driver is created. The option is forwarded to the driver, whose refusal
  is rethrown with the same code and the original as `cause`.
- Run rules `allowedModelsByRole` (keys `architect`, `worker`, `integration`,
  `critic`, `reviewer`) narrow `allowedModels` per role; a merge narrows each
  key. A run spec with a missing, empty or blank agent or reviewer `model`
  reports `RUN_SPEC_MODEL_REQUIRED` (it used to be a generic shape code).
- Run spec model ids may end in one bracket suffix of letters and digits
  (`opus[1m]`, `claude-opus-5-5[1m]`), in lanes, reviewers, `allowedModels`
  and `allowedModelsByRole`; 256 characters in all.
- `model` option on `CodexCliDriver` and `GeminiCliDriver`, sent as
  `--model=<id>` and reported as `gen_ai.request.model`.
- `requireExplicitModel` on every built-in driver: refuses a driver without a
  model or with a router/default alias (`default`, `best`, `opusplan`, Gemini
  `auto`) with `EXTERNAL_AGENT_MODEL_REQUIRED`.
- `ExternalAgentDriver.reportsResolvedModel` (`true` on the Claude drivers),
  and the policy codes `EXTERNAL_AGENT_MODEL_INVALID`,
  `EXTERNAL_AGENT_MODEL_REQUIRED` and `EXTERNAL_AGENT_MODEL_OVERRIDE`.
- `ExternalAgentStartedEvent.modelRouting` (`"plan-mode"`), set on a Gemini
  CLI read-only run without a model.
- `customMetadata.externalAgentModel` (`ExternalAgentModelInfo`: `requested`,
  `resolved`, `status` of `reported`, `not-reported` or `unsupported`) on an
  external agent run's final event, or its last error event when it has no
  final text, and `modelVersion` on that event when a trusted runtime reported
  the model. Only a driver with `reportsResolvedModel: true` is trusted, and a
  `modelRouting: "plan-mode"` run is always `unsupported`.
- Workflow `step_started.requestedModel`, and `step_completed`
  `result.models` (`requested`, `resolved`, `unknown`) on every step whose
  agent names or reports a model, also on `AgentInvocationResult.models`. A
  Codex or Gemini step has an empty `resolved` and `unknown: true`, and so does
  a step whose `LlmAgent` inherits its model. Checkpoints written before this
  have no `models` and still load; a malformed `models` is rejected as corrupt.
- **Run spec, `adk-llm-bridge/workflows/spec` (experimental).** Validation,
  planning and the JSON Schema of a lanes job submitted as data: `validateRunSpec`,
  `resolveRunPlan`, `mergeRunRules`, `layerRunSpecLanes`, `runSpecHash` and
  `runSpecJsonSchema`, with documented `RUN_SPEC_*` issue codes (stability
  policy in the doc), the zod schemas, limits and constants listed under
  "Exports" in the doc. The plan carries the effective `deniedPathPatterns`,
  which the host enforces on writes (`run-spec.denied-paths`). Rule sets also name the workflows a spec may run
  (`allowedWorkflows`) and the refs it may merge into (`allowedTargetRefs`);
  both are required and an empty list allows nothing. A lane agent may name
  MCP providers by id only (`agent.mcp`, at most 16, unique ignoring case,
  no URL, header, command or token shape), checked against the required rule
  `allowedMcpProviders` (deny by default, intersection on merge;
  `RUN_SPEC_MCP_PROVIDER_NOT_ALLOWED`, `RUN_SPEC_MCP_PROVIDER_DUPLICATE`), and
  an `mcp__` tool name in `tools` must name a granted provider
  (`RUN_SPEC_MCP_TOOL_NOT_GRANTED`); the
  plan lists the grant on each agent and the host resolves ids to servers and
  credentials (`run-spec.mcp-providers`). Needs `zod` >= 4; no
  other subpath changes. Conservative by design: lane ids that differ only in
  case, path segments shaped like Windows 8.3 short names (`GIT~1`) and paths
  deeper than 64 segments are rejected; string lengths count code points, as
  JSON Schema does; schema ids live in a registry of the module, not in zod's
  global one. See [docs/workflow-run-spec.md](./docs/workflow-run-spec.md).
- **Checkpoint size diagnostics.** A `checkpoint_size_limit_exceeded` error
  raised while saving now also carries `details.stepId` (the step whose
  transition triggered the save) and `details.largestContributors` (the five
  largest parts of the checkpoint as `{ path, bytes }`), and its message names
  the step and the sizes. A run emits one typed `checkpoint_size_warning`
  event per checkpoint key once a saved checkpoint reaches 80%
  (`WORKFLOW_CHECKPOINT_SIZE_WARNING_RATIO`) of the store's limit, for stores
  that expose the new optional `WorkflowCheckpointStore.maxCheckpointBytes`
  (both bundled stores do). New `WorkflowCheckpointSizeWarningEvent` and
  `WorkflowCheckpointSizeContributor` types. See "Checkpoint size" in
  docs/workflow-durability.md.
- **Checkpoints store a step's text once.** A completed step whose `content`
  is exactly `{ role: "model", parts: [{ text: output }] }` is stored with
  `contentFromOutput: true` instead of `content`, and `content` is rebuilt
  from `output` on replay, so text-heavy checkpoints are about half the size
  and a replayed step returns the same result. Other `content` is stored as
  is. Checkpoints written by earlier 0.7.0 builds load unchanged and are
  compacted on their next save. Read stored results with the new
  `workflowStepResultFromCheckpoint()`; new `WorkflowCheckpointStepResultV1`
  type. See "How a step's text is stored" in docs/workflow-durability.md.
- **`ExternalAgentPermissionPolicy.readPaths`: read wider than you write.**
  Extra roots for read tools only, on top of `allowedPaths` (which it
  requires). The guard knows an explicit set of read tools (Claude Code
  `Read`, `Glob`, `Grep`, `LS`, `NotebookRead`; Gemini CLI `read_file`,
  `read_many_files`, `list_directory`, `glob`, `grep`, `grep_search`,
  `search_file_content`). Every other tool, an unknown one included, counts as
  a write and stays inside `allowedPaths`. `ClaudeAgentSdkDriver` approves
  reads there in every mode. It does not pass them as
  `additionalDirectories`, and they never become writable for the sandboxed
  shell. The other drivers refuse such a run with
  `EXTERNAL_AGENT_PATHS_UNENFORCEABLE` unless built with
  `allowUnenforcedPaths: true`. A delegated agent reads only where both it and
  its parent may read. New `readPathBounds` holds the inherited read bounds,
  as `pathBounds` does for writes.
- **`allowLocalBinding` on `ClaudeAgentSdkDriver` and `ClaudeCliDriver`.**
  Opt-in (default `false`) to let shell commands bind loopback ports inside
  the no-network sandbox, for tools such as Turbopack's PostCSS worker or
  test servers. macOS only (Claude Code ignores it on Linux). Remote hosts
  stay denied, but services already listening on loopback ports may become
  reachable, so treat it as network access. The local-port limit of the
  sandbox is now documented.
- **`interpreter` and `entry` on `ClaudeCliDriver`, `CodexCliDriver` and
  `GeminiCliDriver`**, so a CLI that ships as a JavaScript package runs as
  `<interpreter> <entry> <flags>`: Gemini CLI on Windows, where the npm
  `.cmd` shim is refused, now runs without a custom `spawn`. Only the native
  Node binary is accepted: the interpreter's real path must be
  `node`/`node.exe` and a native executable (PE, Mach-O thin or fat, ELF,
  checked from the file header), because Bun and version-manager shims, the
  symlink kind (mise, volta) and the script kind (asdf, nodenv), read
  configuration from the agent's working directory. The built-in spawn starts
  the real path it checked. The interpreter itself never starts in the
  agent's working directory: it starts in the entry's directory (host-owned,
  not in a sandbox temp directory), and a fixed `--import` preload changes
  into the workspace before the entry runs, reading the path from
  `ADK_LLM_BRIDGE_AGENT_CWD`, so no shim or interpreter reads configuration
  the agent wrote. The entry and the interpreter are started by the canonical
  paths that were checked, so a symlink through an agent-writable directory
  cannot be re-pointed in between. The interpreter goes through the same lookup as `command` (native `.exe`/`.com` only on
  Windows, never `cmd.exe`, no `PATH` entry inside the run's writable roots).
  An entry, or an interpreter path, inside the run's working directory or
  `allowedPaths` (symlinks resolved), or a non-Node interpreter, refuses the
  run with the new `EXTERNAL_AGENT_INTERPRETER_UNSAFE`; a missing entry is `MISSING_BINARY`.
  Codex lists its MCP servers the same way (`CodexMcpListOptions.entry`). The
  Windows CI job runs a fake entry through the native `node.exe` under Bun
  and Node.
- **`resumeReason` (`"interrupted" | "retry"`) on `step_started` events and
  checkpoint step records**, so consumers can tell a resume after an interruption
  from a retry after a failure. Unset on a first attempt and on the
  `step_started` of a waiting step that continues with its answer (same attempt
  number); the step record keeps the reason while it waits. A stored value
  outside the union is rejected. New `WorkflowStepResumeReason` type.
- **Persist Claude sessions (experimental).** `ClaudeAgentSdkDriver` (and
  `ClaudeAgent` through `driverOptions`) takes `sessionStore`, passed to the
  Claude Agent SDK's `query()` on every run, resumes included, so every
  session is mirrored to durable storage and a resume loads it from there.
  `SqliteSessionStore` from the new `adk-llm-bridge/agents/session-store/sqlite`
  subpath keeps transcripts in a SQLite file through the built-in
  `node:sqlite` (Node 22.13+, Bun; no new dependency): uuid-idempotent appends
  in order, a new database file created `0600` (an existing file keeps its
  mode), WAL mode, safe across processes. The
  `SessionStore`, `SessionKey` and `SessionStoreEntry` types are exported from
  `adk-llm-bridge/agents`. A batch the SDK drops after its retries is reported
  as a recoverable `CLAUDE_SESSION_STORE_MIRROR_ERROR` event, and
  `ClaudeCliDriver` refuses a `sessionStore` with the new
  `EXTERNAL_AGENT_OPTION_UNSUPPORTED` code. An entry with an empty `uuid` is
  appended like one without a `uuid`. An entry JSON cannot represent, or whose
  `toJSON()` gives something other than a JSON object, is refused with
  `SESSION_STORE_INVALID_ENTRY`, and an out-of-range `busyTimeoutMs` with the
  new `SESSION_STORE_INVALID_OPTION`. Follows the SDK's `@alpha` contract. See
  `docs/claude-session-store.md`.
- **A warning when parallel steps share a sub-agent.** `ctx.parallel` logs
  `WORKFLOW_PARALLEL_STEPS_SHARE_AGENT` once per run and sub-agent when two
  or more steps name the same sub-agent, which runs them one at a time.
- **Aggregate `usage` on workflow step results.** `step_completed` and
  `step_replayed` results now carry `usage` (`WorkflowStepUsage`: tokens, tool
  calls, and events that reported usage) summed over the successful attempt's
  agent run, including nested workflow agents. Failed attempts that were
  retried and failed steps are not counted. `llmCalls` is one per model
  response for an `LlmAgent` and one per run for an `ExternalAgent` that ends
  with a final response; `cachedTokens` is part of `promptTokens`. Cost is not
  computed. `usage` is absent from checkpoints written by 0.7.0 pre-release builds.
  `AgentInvocationResult` gains `usage`, and `AgentInvocationUsage` and
  `WorkflowStepUsage` are exported from `adk-llm-bridge/workflows`.
- **`ExternalAgentConfig.beforeToolCallback` and `afterToolCallback`** for
  bridged ADK tools, with the same types and order as on `LlmAgent` (after the
  plugins' callbacks).
- **`AdkToolExecutionResult` status `"pending"`** (with `pending.functionCallId`
  and `pending.toolName`) for a long-running tool that returned no result, and
  error codes `CALLBACK_FAILED` and `CREDENTIAL_REQUIRED` in
  `AdkToolErrorCode`, with `AdkToolActions.requestedAuthConfigs`. Code that
  switches over `status` or `AdkToolErrorCode` exhaustively must handle them.
- **Error codes `EXTERNAL_AGENT_CONFIRMATION_UNUSED`,
  `EXTERNAL_AGENT_TOOL_CREDENTIAL_REQUIRED` and
  `EXTERNAL_AGENT_TOOL_RESULT_TOO_LARGE`**, exported from
  `adk-llm-bridge/agents`.
- **`ClaudeCliDriver` options `model`, `maxTurns` and `systemPrompt`**
  (`--model`, `--max-turns`, `--system-prompt`), as on `ClaudeAgentSdkDriver`.
  `model` is reported as `gen_ai.request.model`.
- **External agent usage and model:** `ExternalAgentStartedEvent.model` and
  `ExternalAgentCompletedEvent.{model, usage, numTurns, durationMs}` (new
  `ExternalAgentUsage` type), filled by the Claude SDK and CLI drivers and,
  for usage only, the Codex SDK and CLI drivers. Run tokens (including cache
  read and creation), cost and turns go on the agent's `invoke_agent` span
  (`gen_ai.usage.*`, `gcp.vertex.agent.external_agent.*`), and the run's final
  text event carries `usageMetadata` (`promptTokenCount` includes cache
  tokens). On a resumed Claude Agent SDK session the driver reports this
  run's usage and cost: it subtracts the previous result of the same session
  and marks the usage `scope: "run"`. The baseline is kept in memory (the last
  256 sessions). When there is none, or a counter went down, the run reports
  the session total, marked `scope: "session"`. That happens on the first run
  of a session resumed from outside the driver instance (restart, another
  replica, `resumeSessionId`, `runtimeSession.id`) and on a `forkSession` run.
  `ExternalAgentUsage.scope` is the new field; the final ADK event carries it
  as `customMetadata.externalAgentUsageScope`. The Claude CLI driver never
  resumes, so its usage is `scope: "run"`.
- **External agent tool calls:** the Claude SDK and Codex drivers emit
  `tool_call`/`tool_result` events for the runtime's own tools
  (`metadata.builtin: true`). They appear as function call and response
  events (`customMetadata.builtin: true`) and as `execute_tool <name>` spans;
  the content capture rules apply to the spans. The results are stored in the
  session as they are (a `Read` result holds the file content). Codex
  `file_change` and `web_search` items are now reported, and the Codex command
  result includes its output.
- `ClaudeAgentSdkDriverConfig.tools` and `.inheritHostConfig`,
  `DEFAULT_CLAUDE_SDK_TOOLS`, and `model` getters on `ClaudeAgentSdkDriver` and
  `CodexSdkDriver`.
- **First-class workflows** (`adk-llm-bridge/workflows`) as native ADK
  `BaseAgent` implementations:
  - `WorkflowAgent` for trusted TypeScript handlers.
  - `ScriptWorkflowAgent` for dynamic synchronous-generator scripts in a
    bounded QuickJS VM.
  - Sequential and bounded-parallel agent steps, ordered results, retries,
    fail-fast/all-settled behavior, cancellation, timeouts, and normalized
    workflow lifecycle events.
  - Durable checkpoints through ADK session `stateDelta`, with injectable
    stores, stable execution IDs, crash-safe replay, and explicit
    input/version/step/source mismatch protection.
  - Human-in-the-loop steps (`WorkflowInterruptedError`,
    `WorkflowStepInterrupt`) that resume exactly once.
  - ADK node options: `retryConfig`, `timeout`, `rerunOnResume` (default
    `true`) and `retryFailedSteps`; workflows interoperate as ADK 2.4
    `Workflow` nodes.
  - Durable tasks, mailboxes and a workflow control plane, plus orchestration
    host APIs and a Node Git worktree host adapter
    (`adk-llm-bridge/workflows/node`).
  - OpenTelemetry spans `invoke_workflow` and `execute_node` (tracer
    `gcp.vertex.agent`).
- A reusable ADK agent invocation gateway shared by workflows and the external
  agent tool gateway, with an interrupt/resume contract
  (`AgentInvocationResult.interrupt`, `AgentInvocationRequest.resume`) and
  `transcript`.
- **External agents:**
  - `confirmation`: an in-process approver (denies by default) and the
    ADK-native `adk_request_confirmation` flow;
  - ADK `FunctionTool`/`BaseToolset` tools for the Claude SDK runtime
    (`tools`, `readOnlyTools`);
  - the Claude SDK session id is persisted in session state
    (`claudeSdkSessionStateKey`), and child `escalate` is propagated;
  - `RunSubAgentResult.interrupt` (type `RunSubAgentInterrupt`),
    `ToolGatewayConfig.onInterrupt` and `AgentRuntimeCapabilities.approvals`;
  - `CodexCliDriver` option `skipGitRepoCheck`; the CLI subprocess interfaces
    get an optional `kill()`.
- **Custom providers:** `registerCustomProvider` for safe named
  OpenAI-compatible providers
  ([#84](https://github.com/pailat/adk-llm-bridge/issues/84)), and endpoint
  configuration from `CUSTOM_LLM_BASE_URL`, `CUSTOM_LLM_API_KEY` and
  `OPENAI_BASE_URL`
  ([#85](https://github.com/pailat/adk-llm-bridge/issues/85)).
  `CUSTOM_LLM_API_KEY` is sent only to the `CUSTOM_LLM_BASE_URL` host: a
  custom provider with an explicit `baseURL` and no `apiKey` sends no key, as
  before.
- `ProviderLlmError` (`code`, `status`, `provider`, `detail`, `cause`) and the
  `errorMode` option (per model or through `setProviderConfig`). `provider` is
  the provider id (`openai`, `anthropic`, `custom`, ...); the prefix is in
  `code`. The types `ProviderLlmErrorInit`, `CustomProviderRegistrationConfig`
  and `ErrorMode` are exported.
- Usage metadata reports `cachedContentTokenCount`.
- Provider spans get `gen_ai.provider.name`, `gen_ai.response.model`,
  `gen_ai.response.id` and `server.address`, and ERROR status on failure.
  `gen_ai.provider.name` uses the OpenTelemetry semantic-convention value
  where one exists (`openai`, `anthropic`, `x_ai`); OpenRouter, AI Gateway and
  custom providers keep the bridge id.
- Runtime conformance fixtures and profiles
  ([#86](https://github.com/pailat/adk-llm-bridge/issues/86)), and the
  OpenAI-compatible feature degradation matrix
  ([#89](https://github.com/pailat/adk-llm-bridge/issues/89)).
- `workflowCheckpointRevisionMatches(checkpoint, revision)` and
  `workflowArtifactRevisionMatches(artifact, revision)` for durable store
  implementations; both also accept revisions written by 0.7.0 pre-release
  builds.
- `workflowArtifactStoragePath({ executionId, artifactId })` resolves to a
  per-execution, traversal-free relative path for file-backed artifact
  stores, with each segment at most 255 characters (a longer escaped id
  becomes `~` and its SHA-256 hex digest), and `WorkflowArtifactKey` names
  the two ids.
- `CHANGELOG.md` is included in the published package.
- `adk-llm-bridge/package.json` is exported, so tools can read the installed
  version with `import pkg from "adk-llm-bridge/package.json" with { type: "json" }`.
- `"sideEffects": false` in `package.json`: no module runs code on import
  (registration is explicit), so a bundler can drop the modules a consumer
  does not use. The bridge's own build output is the same with or without it.
- A runnable Codex-only planner → implementer → reviewer workflow smoke example.
- `ClaudeAgent`, `CodexAgent` and `GeminiCliAgent` accept `driverOptions`, the
  options of their default driver (for example Claude `tools`,
  `inheritHostConfig`, `allowUnsandboxedShell`; Gemini `killGraceMs`; Codex and
  Gemini `allowUnenforcedNetwork`). Passing both `driver` and `driverOptions`
  throws `InputValidationError`.
- `adk-llm-bridge/agents` exports `ExternalAgentPolicyError`,
  `ExternalAgentPolicyErrorCode`, `EXTERNAL_AGENT_ISOLATION_VIOLATED`,
  `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE`, `EXTERNAL_AGENT_DEPENDENCY_MISSING`,
  `EXTERNAL_AGENT_MISSING_BINARY`, `DEFAULT_CLAUDE_TOOLS` and the type
  `CodexMcpLister`.
- `AgentInvocationRequest.appendInput` (default `true`): with `false` the input
  becomes the child's `userContent` without a new user event.
- `ToolGatewayConfig.waitForTimeline`, `ToolGateway.transferToAgent()`,
  `ToolGateway.canTransferTo()`, `AdkToolExecutionResult.confirmation.origin`,
  and the error code `EXTERNAL_AGENT_TRANSFER_FAILED` (a transfer target threw).
- Confirmation answers keep `payload` and `hint`, wrapped
  `{ response: "<json>" }` answers are accepted (a malformed one is a
  rejection), and an approver's `PermissionDecision` can carry `payload`, which
  reaches bridged ADK tools as `toolConfirmation.payload`.
- Driver options `killGraceMs` (CLI drivers), `allowUnenforcedNetwork` (Codex
  and Gemini), `allowUnsandboxedShell`, `tools` and `inheritHostConfig`
  (Claude), and `listMcpServers` (Codex).
- `WORKFLOW_CONTROL_UNAUTHORIZED` in `WorkflowControlPlaneErrorCode`.
- Types `WorkflowExecutionRecordErrorCode`, `WorkflowTaskRecordErrorCode`,
  `WorkflowCheckpointFailureReason`, `WorkflowChangeMismatchErrorCode`,
  `WorkflowChangeAuthorityErrorCode` and `WorkflowScriptHost`.
- Error code tables in docs/workflow-control-plane.md,
  docs/workflow-orchestration.md and docs/workflow-durability.md.
- `EXTERNAL_AGENT_ERROR`, `EXTERNAL_AGENT_TRANSFER_FAILED` and
  `EXTERNAL_AGENT_NOT_CONFIGURED` constants, `RunSubAgentResult.errorKind`,
  `AgentInvocationErrorKind`, and the bridge and gateway types a custom driver
  uses (`AdkToolBridge`, `AdkToolExecutionResult`,
  `ToolGatewayDelegationTracer` and others) from `adk-llm-bridge/agents`. The
  error codes are listed in docs/external-agent-isolation.md.
- `BaseRegisterOptions` (`timeout`, `maxRetries`) for every register
  function; `registerOpenAI`, `registerXAI` and `registerAnthropic` accept
  `baseURL`.
- `PROVIDER_ERROR_NO_CHOICE`, `PROVIDER_ERROR_MALFORMED_FUNCTION_CALL` and the
  `ProviderErrorCode` type; the README lists the provider error codes.
- `PROVIDER_ERROR_INCOMPLETE_STREAM` and the `INCOMPLETE_STREAM` member of
  `ProviderErrorCode`.
- `OpenAIClientConfig.providerId` and `OpenAIClientConfig.errorPrefix`
  (validated: a non-blank id and an UPPER_SNAKE prefix), so a subclass using
  the manual constructor names its errors without overriding
  `getErrorPrefix()`.
- `caseInsensitivePaths` on `InMemoryWorkspaceAdapter` and
  `FileSystemWorkspaceAdapter` (off by default; full case fold, so `ß`/`ss`,
  `ς`/`σ`, `ſ`/`s` and `µ`/`μ` match) and the `caseInsensitive` option of
  `findWorkspacePathOverlaps` (`WorkspacePathOverlapOptions`).
- `authorizeWorkflowActor` takes an optional
  `WorkflowActorAuthorizationContext`; `NodeGitWorktreeError` accepts
  `ErrorOptions`.
- `RecoverableErrorCode`, `LEGACY_RECOVERABLE_ERROR_CODES`,
  `normalizeRecoverableErrorCode()` and `EXTERNAL_AGENT_CREDENTIAL_UNSUPPORTED`
  in `adk-llm-bridge/agents`. `CLAUDE_PROVIDER` lives in its own module; the
  old import path still works.
- Providers send `llmRequest.model` when a `beforeModelCallback` or plugin
  changes it to an id the provider accepts (its model patterns, matched on the
  whole id like `LLMRegistry`). A prefixed or foreign id is not sent: the
  provider uses its own model and warns once with `REQUEST_MODEL_IGNORED`.
- Responses carry `modelVersion` (the model the provider reports), and the
  last streamed response has `partial: false`.
- A content-filter finish (`content_filter`, Anthropic `refusal`) with no
  content carries `errorCode: "SAFETY"` and an `errorMessage`, so the blank
  turn is detectable, as ADK does for Gemini.
- `docs/provider-requests-and-responses.md` (finish-reason and tool-call id
  mapping, `LLMRegistry` matching and cache, tracking headers, telemetry
  provider names) and `examples/keyless`, which runs an agent without an API
  key or network.

- `WorkflowAgent` and `ScriptWorkflowAgent` accept ADK's `waitForOutput`,
  `beforeAgentCallback`, `afterAgentCallback` and `parentAgent`, like any ADK
  agent.
- `ClaudeAgentSdkDriver` options `sessionStoreFlush` (`"batched"` or
  `"eager"`) and `sessionStoreLoadTimeoutMs` (the SDK's `loadTimeoutMs`); both
  need a `sessionStore`, and `ClaudeCliDriver` refuses them with
  `EXTERNAL_AGENT_OPTION_UNSUPPORTED`. Type `ClaudeSessionStoreFlush`.
- `PortableToolDeclaration.outputSchema`: a bridged ADK tool's declared result
  schema (`responseJsonSchema`, or a `FunctionTool` `response`), kept as
  information; the built-in drivers do not advertise it.
- `ExternalAgentModelUsage`, the type of an `ExternalAgentUsage.byModel` entry.
- `WORKFLOW_STEP_MISMATCH` details include the saved step's `savedStatus` and
  `savedAttempts`.
- Workflow storage providers. Checkpoint and event providers are chosen by
  injection (`checkpointStore`) or by URI (`getWorkflowCheckpointStoreFromUri`,
  `getWorkflowEventExporterFromUri`), with custom schemes through
  `registerWorkflowStorageProvider`. Events export through
  `WorkflowEventExportPlugin` and `WorkflowSpanExportProcessor`. The SQLite
  providers load from `adk-llm-bridge/workflows/checkpoint/sqlite` and
  `adk-llm-bridge/workflows/events/sqlite`, and the conformance suite from
  `adk-llm-bridge/workflows/storage/conformance`. The default checkpoint
  store does not change: it was `ADKSessionCheckpointStore` before this
  addition and still is; a provider is used only when you pass or select one.
  Known limitation: concurrent multi-process saves to the file-system
  checkpoint provider are not yet supported on Windows, and its
  `capabilities.multiProcess` is `false` there
  ([#117](https://github.com/pailat/adk-llm-bridge/issues/117)).
  On Windows the SQLite stores and the JSONL exporter set no owner-only mode and
  refuse symbolic links from `lstat`. The Claude SQLite session store now
  opens through the same shared helper: it still takes the write lock
  (`BEGIN IMMEDIATE`) on open, also for a schema that is already current, as
  before; on Windows a symbolic link at the database path is now refused
  before the open, and no mode is set or checked there. The JSONL exporter
  flushes its directory with the same helper as the file-system stores: a
  failed directory flush after it creates or removes a file now fails the call
  instead of being ignored, except on Windows, which cannot flush a
  directory. The SQLite session store now sets `PRAGMA synchronous = FULL`
  explicitly, and a storage URI longer than 8192 characters
  (`MAX_WORKFLOW_STORAGE_URI_LENGTH`) is rejected with
  `WORKFLOW_STORAGE_INVALID_URI`. See
  [Choosing storage providers](./docs/storage-providers.md) and
  [Workflow durability](./docs/workflow-durability.md).

### Changed

- **CLI drivers refuse `runtimeSession`.** `ClaudeCliDriver`, `CodexCliDriver` and
  `GeminiCliDriver` used to ignore `request.runtimeSession`. They now fail the run with
  `EXTERNAL_AGENT_SESSIONS_UNSUPPORTED` (exported from `adk-llm-bridge/agents`) before any
  process starts. `ClaudeAgentSdkDriver` now declares `capabilities().sessions = true`,
  matching what it already did.
- **Prompt caching is on by default for Anthropic models** (fixes zero cache reads on
  AI Gateway, where every turn paid the full prompt again):
  - native `AnthropicLlm`: `promptCaching` was opt-in and marked only the system block and
    the last tool; it is now on and also marks the last message block, so later turns read
    earlier turns from the cache;
  - AI Gateway `anthropic/*`: sends `providerOptions.gateway.caching = "auto"`;
  - OpenRouter stays opt-in (`promptCaching: true`), and OpenAI, xAI and custom endpoints
    are unchanged;
  - a cache write costs 1.25x the input price and a read 0.1x or less, so it pays off from
    the second turn; one-shot calls that are never reused pay the 25% write surcharge on
    the cached part: set `promptCaching: false` for them.

- **`ExternalAgent` no longer drops ADK tools silently** (see
  [Read-only agents and host tools](./docs/external-agent-isolation.md#read-only-agents-and-host-tools)):
  - a `read-only` agent with tools not listed in `readOnlyTools` throws
    `EXTERNAL_AGENT_TOOL_NOT_READ_ONLY`;
  - `readOnlyTools` entries that name no tool, or more than one tool, throw
    `EXTERNAL_AGENT_READ_ONLY_TOOL_UNKNOWN`;
  - a listed name that resolves to more than one tool at run time exposes none
    of them and is reported as `ambiguous`;
  - tools on a driver that cannot host them (Codex, Gemini CLI, Claude CLI)
    throw `EXTERNAL_AGENT_TOOLS_UNSUPPORTED`;
  - tools hidden by a `read-only` policy (an inherited one included) are
    reported by one `EXTERNAL_AGENT_TOOLS_HIDDEN` warning per run, on the final
    event (`customMetadata.externalAgentTools`) and on the span.
- **An approver or ADK confirmation on a driver that never asks is refused**
  (see
  [Approvers and ADK confirmation](./docs/external-agent-isolation.md#approvers-and-adk-confirmation-need-a-driver-that-asks)):
  `confirmation.approver` or `confirmation.adk` on the Claude CLI, Codex or
  Gemini CLI drivers used to be ignored silently (the runtime decided alone and
  denied what needed approval). It now throws `EXTERNAL_AGENT_APPROVALS_UNSUPPORTED`
  when the agent is built, also on `clone()`. Only `ClaudeAgent` asks the host.
- The Claude drivers refuse every forwarded environment variable whose name
  contains `MODEL`, plus `CLAUDE_CODE_CLIENT_DATA_URL` and `CLAUDE_CODE_3P_*`,
  instead of a fixed list; `ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION` is the one
  exception (a region, not a model). A drift test reads the bundled Claude Code
  binary and fails on a model variable the rule misses. The Codex drivers
  refuse every `config` key containing `model`, except the tuning keys
  (`model_reasoning_effort`, `model_reasoning_summary`, `model_verbosity`,
  `model_context_window`, `model_auto_compact_token_limit`,
  `model_auto_compact_token_limit_scope`). A workflow step is `unknown` when an
  external run in it reported no `used`.
- **Sub-agents, `permissions`, `delegation` and `tools` entries are checked
  when an `ExternalAgent` is built**, instead of being ignored silently (see
  [Sub-agents need a driver that exposes them](./docs/external-agent-isolation.md#sub-agents-need-a-driver-that-exposes-them)):
  - `subAgents` on the Claude CLI, Codex CLI, Codex SDK or Gemini CLI driver
    (any driver whose `capabilities()` lacks `subagents`) throws
    `EXTERNAL_AGENT_SUBAGENTS_UNSUPPORTED`, also on `clone()`. Those drivers
    never exposed the sub-agents, so they were never called. Use
    `ClaudeAgent`, or put the sub-agents on an ADK `LlmAgent` parent.
  - `permissions` with a key that is not a policy field throws
    `InputValidationError` naming the key(s). Before, the key was dropped: a
    misspelled `allowedPaths` left paths unrestricted.
  - `delegation` throws `InputValidationError` unless it is a plain object
    with only `finalAnswer: "subagent" | "coordinator"` (a misspelled value
    used to mean `"coordinator"`, a misspelled key the default).
  - A `tools` entry that is not an ADK tool or toolset throws
    `InputValidationError` naming its index, before the capability check.

- **The script sandbox stack limit is lower and capped.**
  `DEFAULT_WORKFLOW_EXECUTION_LIMITS.stackBytes` is 32 KiB (32768, was
  512 KiB), and a script workflow whose `stackBytes` is above 32 KiB is refused
  with `WORKFLOW_DEFINITION_INVALID`. With 512 KiB, ordinary deep recursion
  overflowed the host stack before QuickJS reported its limit; see Fixed. At
  32 KiB the 22 recursion patterns measured end in QuickJS's own limit error
  (clean up to 64 KiB on Node 22, 24 and 26 and Bun), and a script gets about
  190 nested calls. The limit does not cover the QuickJS parser: a deeply
  nested source given to `eval` can exhaust the host stack from 32 KiB (24 KiB
  on Bun). That case is contained, not prevented; see Fixed.
- `ExternalAgentWorkflowFactory` leaves the top-level `config.model` out of the
  agent revision: a model change no longer changes the revision (and so no
  longer stops completed steps from replaying); it is reported by the replay
  model check. A `model` key nested elsewhere in `config` stays in the revision.
- The Claude CLI driver emits `started` on the first output line, with the
  resolved model from `system/init` (still first on every path, including
  failures before any output; the timestamp is still the start of the run).
- Documented the code comment standard (docs/contributing/comments.md) and added
  check-comments and check-export-docs to ci and prepublishOnly: no internal
  tracking ids, valid TSDoc, no per-file license headers (LICENSE is the single
  source).
- `check:comments` also rejects backlog, fix, verification, request and audit
  tracking ids (`BF-*`, `BL-*`, `FS-*`, `V-<n>`, `REQ-<n>`, `H-<letter>`) in
  comments and test names; see [comments.md](./docs/contributing/comments.md).
- License holder is now "adk-llm-bridge contributors" (MIT, unchanged); per-file
  license headers were removed, LICENSE is the single source.
- **Dependency upgrade.** Built and tested against `@google/adk` 2.4.0,
  `openai` 7, `@anthropic-ai/sdk` 1.6, TypeScript 7 and Biome 2.6; CI uses
  Node 22, 24 and 26 and Bun 1.4.4.
- Providers accept ADK's `parametersJsonSchema` (and `responseJsonSchema`) and
  pass it through as JSON Schema, and follow ADK 2.4 request handling
  (for example, the Anthropic provider no longer returns 400 on empty or
  assistant-final turns).
- Reasoning round trips: OpenAI-compatible `reasoning_details` with ADK
  planners, and namespaced Anthropic thought signatures
  (`adk-llm-bridge:anthropic:v1:`). Sessions stored with older signatures still
  replay, and foreign signatures are never sent. An integer beyond
  `Number.MAX_SAFE_INTEGER` in an echoed `reasoning_details` entry is sent as a
  string of its exact digits, not rounded.
- `AgentInvocationGateway` shares the `maxLlmCalls` counter and the ADK 2
  context fields (`isolationScope`, `nodeToolDepth`, ...) between a parent and
  its child agents, and writes child events through ADK session semantics.
- `ExternalAgent` is a first-class ADK 2.4 node (`BaseAgentConfig`, `clone()`,
  `output` and `nodeInfo` on final events).
- `ClaudeCliDriver` uses `--permission-mode manual` instead of the undocumented
  `default` alias. An aborted CLI run now ends without the trailing exit error
  or `completed` event.
- `normalizeSchema` copies `default`, `example`, `examples`, `enum` and `const`
  verbatim (it no longer rewrites `type` inside instance data), and returns
  `undefined` for array input.
- **Workflows use one canonical hash:** `sha256:` over JSON with object keys
  sorted by UTF-16 code unit at every depth. Before, depending on the site, keys
  were sorted with `localeCompare` (which depends on the locale and ignores
  case) or kept in insertion order. This covers checkpoint input/source hashes
  and revisions, artifact digests and revisions, change-set and intent digests,
  external agent revisions and git worktree directory names. Digests stored
  by 0.7.0 pre-release builds are still accepted when read (0.6.0 and earlier
  have no workflows and wrote none of these digests), so existing checkpoints
  (including the file store), artifacts, change sets, agent revisions and
  worktrees keep resuming and verifying; only new digests use the canonical
  form. The internal canonical JSON form sorts keys by code unit as well, so
  integer-like keys are no longer listed first.
- OpenAI-compatible providers stop emitting responses as soon as the
  `AbortSignal` is aborted, even if the server keeps sending data.
- **CI and release:** a Node 22/24/26 matrix, a non-blocking canary against
  ADK `main`, dependency audit, CodeQL, Dependabot, and npm trusted publishing
  with provenance. `ci` and `prepublishOnly` check the published declarations
  and permission inheritance in the built bundles.
- `CodexCliDriver.parseLine` now throws for `codex exec --json` lines that
  carry no bridge event (lifecycle and unknown events), as
  the other CLI drivers' `parseLine` does, instead of returning them as
  `output`. The new `CodexCliDriver.parseEvent` returns `undefined` for them.
- `WorkflowControlPlane.dispatch` forwards a validated, frozen copy of JSON
  payload fields (members set to `undefined` are dropped, as the stores already
  did). It revalidates every result as JSON with the operation's shape, returns
  a frozen copy, and throws `WORKFLOW_CONTROL_INVALID_RESULT` (new
  `WorkflowControlPlaneErrorCode` member) when a host-injected service returns
  anything else.
- ADK tools exposed to an external agent follow ADK semantics for the actions
  they set. Before, these actions were dropped and such a confirmation failed
  closed:
  - `escalate`, `skipSummarization` and `transferToAgent` ride on the tool's
    function response;
  - `escalate` alone does not end the external turn; an enclosing `LoopAgent`
    stops after this agent's turn;
  - `skipSummarization` and `transferToAgent` end the turn (ADK's
    `ExitLoopTool` sets both `escalate` and `skipSummarization`);
  - a transfer runs the target agent in the same invocation, with the caller's
    policy as ceiling. The target sees the caller's events up to the tool's
    response and reuses the invocation's user message, without adding it
    twice. When the invocation has no user message, a
    `Transferred from <name>.` user event is added for the target;
  - `artifactDelta` is published on the timeline;
  - `toolContext.requestConfirmation()` inside `execute` goes through the
    agent's `confirmation` (approver or ADK `adk_request_confirmation`). The
    tool re-runs with the decision in `toolContext.toolConfirmation`, including
    its `payload` (for example an edited amount) and the answer's `hint`. ADK
    answers in the wrapped `{ response: "<json>" }` shape are accepted; a
    malformed one is a rejection. `PermissionDecision` (object form) accepts an
    optional `payload`.
- On an ADK-protocol resume, a tool that asked for confirmation runs once, with
  the human's decision (before, it ran once more without it first).
- A missing or forged actor, or an actor bound to another task or execution,
  fails with `WORKFLOW_CONTROL_UNAUTHORIZED` instead of
  `WORKFLOW_CONTROL_INVALID_REQUEST` on every control-plane operation.
- Step retry policies are validated strictly (objects with known keys, finite
  non-negative numbers, delays at most 2^31-1 ms); the sandbox applies the
  same step shape check.
- The repository lock never takes over a lock with an unreadable owner
  (waiters time out with `GIT_MUTATION_AMBIGUOUS`). Released locks remain as
  `.retired.*` directories under `<git common dir>/adk-workflow-locks`, as for
  the workspace adapter; they are safe to delete only when no workflow process
  runs (documented in docs/workflow-orchestration.md, with the Git driver's
  environment).
- `PlaceholderExternalAgentDriver` reports `EXTERNAL_AGENT_NOT_CONFIGURED` and
  is not recoverable. An unknown sub-agent or transfer target sets
  `RunSubAgentResult.errorKind` to `agent-error`; an error event with an empty
  code is reported as `EXTERNAL_AGENT_ERROR`.
- `ExternalAgentDefinitionRegistry` and `ExternalAgentProviderRegistry` throw
  `InputValidationError` (still an `Error`).
- `OpenAI`, `OpenRouter`, `XAI` and `AIGateway` factories, classes and
  register functions take their provider's own options type, so an unknown or
  misspelled option is a compile error.
- A user tool named `json_output` together with structured output on
  Anthropic throws `InputValidationError` from `generateContentAsync` in every
  `errorMode`, before any API call.
- `PROVIDER_IDS` includes `OPENAI`, `XAI` and `ANTHROPIC`.
- Warnings name their code in the message
  (`[adk-llm-bridge] [BUILTIN_TOOLS_DROPPED] ...`) instead of passing
  `{ code }` as a second logger argument, which ADK's default logger printed as
  `[object Object]`.

- ADK tools an `ExternalAgent` cannot use are logged, once per tool for each
  run, with a stable code: `ADK_TOOL_IN_MODEL_SKIPPED` for in-model tools
  (`GOOGLE_SEARCH`, `URL_CONTEXT`), now reported in `skipped` as `in-model`;
  `ADK_TOOL_REQUEST_PROCESSING_SKIPPED` for a tool or toolset whose
  `processLlmRequest` cannot run (`PRELOAD_MEMORY` is skipped as
  `request-processor`; `LoadArtifactsTool` is exposed without its request
  instructions); `ADK_TOOLSET_FAILED` when a toolset's `getTools` throws, with
  the error as the `skipped` entry's `cause`.
- `ExternalAgentUsage.byModel` entries no longer allow a `scope` of their own;
  the usage's `scope` covers them.
- An abandoned workflow step event stream ends its `execute_node` span with
  `adk.node.status` `cancelled` (ADK's `NodeStatus.CANCELLED`) instead of
  `completed`.

### Deprecated

- Config type names follow one scheme: `<Provider>ProviderConfig` for a
  model's config and `<Provider>RegisterOptions` for a `register*()`
  function. New names, exported from the package root:
  `AIGatewayProviderConfig`, `AIGatewayRegisterOptions`,
  `OpenRouterProviderConfig`, `CustomProviderConfig` and
  `CustomRegisterOptions`. The old names are `@deprecated` aliases of the same
  types and stay until the next major version: `AIGatewayConfig`,
  `RegisterOptions`, `OpenRouterConfig`, `CustomLlmConfig`,
  `CustomLlmProviderConfig` and `CustomProviderRegistrationConfig`.
- `AdkSessionCheckpointStore` and `AdkSessionCheckpointStoreOptions` in
  `adk-llm-bridge/workflows` replace `ADKSessionCheckpointStore` and
  `ADKSessionCheckpointStoreOptions`, matching `AdkWorkflowTaskDriver` and
  `AdkToolBridge`. The old names are `@deprecated` aliases of the same class
  and type.
- `DEFAULT_CLAUDE_SDK_TOOLS` in `adk-llm-bridge/agents` is `@deprecated`: use
  `DEFAULT_CLAUDE_TOOLS`, the same list.
- `LEGACY_RECOVERABLE_ERROR_CODES` in `adk-llm-bridge/agents` is
  `@deprecated`: use `normalizeRecoverableErrorCode()`, which maps every code
  in it.

### Fixed

- **A delegated sub-agent's model and tool reports reach the host.** Its
  `externalAgentModel` and `externalAgentTools` now ride on the sub-agent's own
  final event (author = the sub-agent). The native-shape delegation stripped all
  of its `customMetadata`, so a coordinator's host saw neither the models the
  sub-agent billed (`used`, `unexpected`) nor its hidden tools. The reports stay
  on the sub-agent's events and are not merged into the coordinator's report, but
  the run's `models` (and a workflow step's `result.models`) now include the
  sub-agent's `used` and `unexpected`. See
  [Reports under delegation](./docs/external-agent-isolation.md#reports-under-delegation).

- **A resumed Claude Agent SDK run no longer completes empty without running
  its input.** Claude Code can write a "model-less" result (success,
  `num_turns` 0, empty `result`) when display rows arrive while no turn is
  under way, for example at the start of a resumed session before the new
  input is queued; the turn that runs the input follows in the same query.
  `ClaudeAgentSdkDriver` ended the run at that first result, so a second
  workflow step of the same Claude agent could complete with empty output and
  no error. The driver now reads past a model-less result that comes before
  any turn activity, and a run whose stream ends after only model-less
  results fails with `EXTERNAL_AGENT_NO_TURN` (recoverable) and exit code 1.
  A real result still ends the run at once.

- **A Codex SDK run can no longer end the host process with `EPIPE`.**
  `@openai/codex-sdk` writes the prompt to codex's stdin with no error
  handler. When codex was gone before it read the whole prompt (it exited
  early, the run was aborted, or it closed stdin), the failed write was an
  uncaught exception that ended the host. With a prompt larger than the pipe
  buffer (256 KiB on Linux, 1 MiB on macOS) this happened at any exit time.
  `CodexSdkDriver` now replaces the client's exec with a copy of the SDK
  0.167.0 exec path that handles the error, with the same arguments,
  environment, binary and abort signal. An abort and a non-zero exit of
  codex's own are reported as before (`CODEX_SDK_ERROR` with stderr). A prompt
  codex did not read in any other way is the new `CODEX_SDK_INPUT_NOT_DELIVERED`
  (not recoverable), and a codex that closed stdin and kept running is
  stopped. The copy is used only on `@openai/codex-sdk` 0.167.0, read from the
  installed package at run time. Another version, an unreadable version, or a
  client whose exec differs from 0.167.0 is refused with
  `EXTERNAL_AGENT_DEPENDENCY_MISSING` before codex starts; the message names
  the supported and the installed version and the ways forward. The new
  opt-in `CodexSdkDriver` option `allowUncontainedCodexSdk: true` runs another
  version through the SDK's own exec without the containment, so an `EPIPE`
  from that SDK can end the host again; the driver logs one
  `CODEX_SDK_UNCONTAINED` warning per driver. The copy is temporary, until the
  SDK handles stdin errors itself. The adapted code is Apache-2.0: its legal
  comment stays in `dist`, and the package ships `THIRD-PARTY-NOTICES`.
- **A script that exhausted the host stack could leave the sandbox unable to
  run scripts.** QuickJS runs on the host's own stack inside a WebAssembly
  module. When the host stack overflowed first (deep recursion under the old
  512 KiB limit, or a deeply nested source given to `eval`), the host
  `RangeError` unwound the module without freeing the guest's objects. Freeing
  the runtime then asserted (`Aborted(Assertion failed:
  list_empty(&rt->gc_obj_list)...)` on stderr) and the runtime stayed in the
  process-wide module; after about fifteen such runs a healthy script failed to
  start. Now any host stack overflow or WebAssembly abort, in a turn, in the
  parser at set-up, while reading an error or while freeing the runtime, ends
  that run with `WORKFLOW_LIMIT_EXCEEDED` (the message says the host stack was
  exhausted and the sandbox was reset). The module is marked poisoned. Every
  other session on it fails its next turn with `WORKFLOW_EXECUTION_ERROR`, a
  new session never starts on it (`WORKFLOW_SANDBOX_UNAVAILABLE` when a custom
  `loader` returns it again), and the default loader builds a new module for
  the next session. One hostile overflow therefore fails the other live script
  sessions of the process: they would otherwise run on a module whose heap may
  be corrupted.
- **A poisoned sandbox module is no longer freed, which could block the host
  thread.** After a host stack overflow or a WebAssembly abort, the runtime
  still freed the turn's argument, the context and the runtime on the poisoned
  module, for the failing session and for every other session on it. A free
  walks the module's untrusted heap without any interrupt check, so it could
  loop and block the host thread. Now the runtime never calls into a poisoned
  module again: its sessions only drop their references, and its memory is
  released when the module is garbage-collected. This is a possible cause of
  one CI run that hung in the forced-overflow tests; that hang was not
  reproduced locally. That a script can never block the host longer than its
  `cpuTimeMs` budget remains unproven: the budget is checked between bytecode
  operations, a single native builtin call (`sort`, `join`,
  `JSON.stringify`) runs to completion, and a host that needs a hard bound must
  run workflows in a process it can kill (see "Time bound" in
  `docs/workflow-orchestration.md`).
- **Headless Claude runs no longer report success while their own background
  job is still running.** `ClaudeAgentSdkDriver` and `ClaudeCliDriver` set
  `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` for Claude Code, so the Bash tool
  has no `run_in_background` and subagents run in the foreground. A run whose
  result arrives while Claude Code still reports a background task ends with
  an `EXTERNAL_AGENT_BACKGROUND_TASK_PENDING` error (not recoverable) and exit
  code 1. `allowBackgroundTasks: true` on either driver leaves background
  tasks on; the check still applies.
- **Each Claude run gets a private temp directory.** Both Claude drivers create
  a fresh `0700` directory under `/tmp` for each run, pass it as
  `CLAUDE_CODE_TMPDIR` (Claude Code's temp root, kept writable in its sandbox)
  and its per-user directory as `TMPDIR`, and remove it when the run ends.
  Runs no longer share `/tmp/claude-<uid>`, and the child no longer runs
  without a `TMPDIR` (shell commands then used the platform default, such as
  `/var/folders/.../T` on macOS). Not used on Windows. On macOS, a bare
  `mktemp` and `diff <(...)` still fail in the sandbox (they ignore `TMPDIR`
  and write to shared temp directories, which stay read-only); use
  `mktemp -p "$TMPDIR"` and `cmp` or files.
- **The build output no longer depends on the entry list.** `bunup.config.ts`
  sets `sourceBase: "./src"`, so every entry builds to the `dist/` path that
  `package.json` `exports` names; before, Bun used the lowest common ancestor
  of the entries and a change to the list could move every file to
  `dist/src/`.
- **`AgentInvocationGateway` reports `errorKind: "llm-calls-limit"` for a real
  `LlmAgent` that goes over `maxLlmCalls`.** ADK catches the limit error inside
  `LlmAgent` and yields an error event, so the gateway reported `agent-error`.
  It now recognises that event (`errorCode` `UNKNOWN_ERROR` and ADK's message
  for the run's own `maxLlmCalls`) as `llm-calls-limit`; any other error event
  stays `agent-error`.
- **A checkpoint mismatch inside `ctx.parallel` fails the run.** With
  `failureMode: "all-settled"` too, it now throws at the changed step after a
  `step_failed` event, instead of returning a failed outcome.
- **A workflow run that failed after a step began waiting for input keeps that
  wait answerable.** The checkpoint keeps the original input, and a resume that
  re-reaches the wait stores it and the `running` status again, so answering it
  no longer fails with `WORKFLOW_INPUT_MISMATCH`.
- **`limits.maxSteps` no longer counts steps replayed from the checkpoint.**
  It bounds the steps one turn executes, so a long-lived run no longer fails
  with `WORKFLOW_LIMIT_EXCEEDED` on a resume because of its earlier steps. The
  new `limits.maxReplayedSteps` (default ten times `maxSteps`) bounds the
  replayed steps of a turn. Both are checked before a step is saved `running`,
  for handler and script workflows alike, and the error details carry
  `limit`, `limitName`, `stepId`, `executedSteps`, `replayedSteps`, `maxSteps`
  and `maxReplayedSteps`. `runWorkflowScript` takes `replaysFromCheckpoint`
  for a host that replays steps; it then enforces only the sum of both bounds
  and the host each bound (see docs/workflow-durability.md "Step limit on a
  resumed run").
- **A recorded failure replayed in an all-settled `ctx.parallel` is marked
  `replayed: true`.** Its outcome is the stored failure record, as
  `WorkflowStepFailure.replayed` documents, instead of a new record without
  the flag.
- **A wall-clock step no longer ends in-process waits early or stretches
  them.** The workspace, checkpoint and repository mutation lock waits, the
  delegated-run abort grace and the sandbox `cpuTimeMs` budget measure elapsed
  time on a monotonic clock instead of `Date.now()`. Before, an NTP correction
  or the jump on waking from sleep could fail a lock wait at once, and a
  backward step could let a sandbox turn run past its CPU budget. Durable lease
  expiry stays wall time; what a sleeping host does to leases and timeouts is in
  docs/workflow-durability.md ("Host sleep and wall-clock steps").
- **A nested workflow's outcome decides its parent step.** A run that completed
  or is waiting is no longer reported as failed because of a retried inner attempt.
- **The CLI drivers never run a Windows `.cmd` or `.bat` file.** The command is resolved over `.com` and `.exe` on `PATH`; a batch shim ends the run with `EXTERNAL_AGENT_BATCH_COMMAND_REFUSED` (use the native `.exe`, or `interpreter` + `entry` for Gemini CLI; see docs/external-agent-isolation.md), and a Windows CI job checks it with fake `.cmd` files on Bun and Node.
- **Aborting a workflow run records an explicit `interrupted` state.** The
  execution is `cancelled` and each in-flight step is checkpointed as
  `interrupted` with a `step_interrupted` event, instead of `failed`, including
  a step whose `running` record was being saved when the abort landed. An
  abort during the delay before an in-run retry records no new attempt: the
  previous attempt keeps its `failed` record. A checkpoint whose `interrupted`
  step lacks a `WORKFLOW_ABORTED` error, `completedAt`, or carries a result or
  interrupt is rejected as corrupt. A resume re-runs the step when
  `retryFailedSteps` or `resumePolicy: "retry"` is set; otherwise, and on a
  turn that answers a waiting step, it fails with
  `WORKFLOW_INDETERMINATE_STEP`. An abort whose reason is a `WorkflowError`
  with another code is handled the same way and fails the run with
  `WORKFLOW_ABORTED`, keeping the reason's code as `details.reasonCode` and
  its details. `docs/workflow-durability.md` documents the
  supported way to stop a run (abort the signal, wait for the workflow to
  record it, then exit) and how to recover an answer turn.
- **A `ctx.parallel` sibling stopped by a fail-fast failure is `interrupted`.**
  When one step fails in `failureMode: "fail-fast"`, a sibling still in flight
  was checkpointed `failed` with the other step's error, so a resume replayed
  a failure the sibling never had. It is now `interrupted` with
  `WORKFLOW_ABORTED` (`details.reasonCode` is the failing step's code,
  `details.failedStepId` its id) and a `step_interrupted` event, like any
  aborted step: a resume re-runs it with `retryFailedSteps` or
  `resumePolicy: "retry"`, and fails with `WORKFLOW_INDETERMINATE_STEP`
  without them. A step still queued behind `concurrency` is no longer started
  and is not recorded, so a resume runs it fresh. The run itself still fails
  with the failing step's error and its checkpoint is `failed`.
- **A `Runner` abort is recorded with the default ADK session store.** The
  workflow appends its final checkpoints, and those of a workflow it delegated
  to, to the session. State then shows the step `interrupted` instead of
  `running`. A failed append logs `WORKFLOW_CHECKPOINT_ABORT_RECORD_FAILED`.
- **A `read-only` agent with `allowNetwork: true` can use its web tools.**
  The confirmation guard denied every call under `read-only`, so WebFetch and
  WebSearch were refused even with the network on and a research agent could
  not read documentation. They now run without a confirmation (no approver is
  asked): the guard lets the exact runtime names through (`WebFetch`,
  `WebSearch`, `web_fetch`, `web_search`, `google_web_search`), and the Claude
  CLI driver adds a `permissions.allow` rule for them, since `dontAsk` denies
  anything that would prompt. Every other read-only denial is unchanged, and
  another spelling or an MCP tool with the same name is still denied, as is a
  path outside `allowedPaths` in a web tool's input. Read-only does not stop
  data leaving: such an agent can send what it reads to any host without an
  approver, so turn the network on only for agents whose inputs you trust.
  Codex and Gemini CLI web tools never went through the guard and are
  unchanged.
- **The Claude isolation stop message names what the bridge saw.** The
  `EXTERNAL_AGENT_ISOLATION_VIOLATED` message of the Claude drivers no longer
  always blames host settings: a tool the runtime offered at start points to a
  host or managed setting; a built-in it did not offer is reported as the model
  requesting a tool that was not offered; an MCP tool it did not offer may also
  come from a server or connector that connected after start; a call seen
  before `system/init` gets a neutral message. The code, recoverability and
  event shape are unchanged, and the run still stops.
- **ADK `temp:` state keys never reach a delegated result or a checkpoint.**
  `AgentInvocationResult.stateDelta`, `WorkflowStepResult.stateDelta` and a
  waiting step's stored events drop them, even with an ADK that keeps them.
- **Delegated runs count each function call once.** `AgentInvocationUsage.toolCalls`,
  `AgentInvocationExecutionSummary.toolCalls` and `WorkflowStepUsage.toolCalls`
  now count function calls on non-partial events only, the same events whose
  `usageMetadata` is summed. A function call streamed on a partial event and
  repeated on the final event was counted twice.
- **A checkpoint with a malformed step `usage` is rejected as corrupt.** On
  read, `WorkflowStepResult.usage` must hold every `WorkflowStepUsage` field as
  a finite, non-negative number; otherwise the load fails with the existing
  corrupt-checkpoint error (`WORKFLOW_EXECUTION_ERROR`, and
  `checkpoint_file_corrupt` from `FileSystemWorkflowCheckpointStore`).
  Checkpoints saved without `usage` still load.
- A workflow error whose `details` hold `undefined` values (for example a
  `WORKFLOW_STEP_MISMATCH` on a step saved without `agentRevision`) made the
  failed checkpoint invalid, so the run failed with "Cannot persist an invalid
  workflow checkpoint" and the real error was lost. `WorkflowError.toJSON()`
  now returns `details` as a JSON projection (`undefined` and functions
  dropped, non-finite numbers as `null`, a `bigint` as a string), and
  `withWorkflowFailed` / `withWorkflowStepFailed` store a JSON-safe copy of
  any error, with an empty message replaced by `Workflow error <code>`. The
  original code and message are recorded.
- **No false isolation stop on an offered tool.** The Claude isolation check
  no longer stops a run with `EXTERNAL_AGENT_ISOLATION_VIOLATED` when the
  model or SDK reports an offered built-in under another spelling (for
  example `bash` for `Bash`). Tools added at start or later, built-ins that
  were not offered, unknown names in any case, and MCP names (never
  case-folded) are still caught.
- **A `tool_use` with an empty or missing name stops an isolated Claude run.**
  The check used to skip it. It now ends the run with
  `EXTERNAL_AGENT_ISOLATION_VIOLATED`, and the error message quotes each name.
- **One copy of each class across the entry points.** Each subpath was
  bundled on its own, so 10 classes existed twice in `dist`. For example,
  `WorkflowChangeAuthorityError`, `WorkflowChangeMismatchError` and
  `WorkflowHostMutationConflictError` thrown from inside
  `adk-llm-bridge/workflows/node` came from a second copy of the class, so
  `instanceof` against the class exported by `adk-llm-bridge/workflows` was
  false. The `.d.ts` files had the same problem: `ExternalAgent`,
  `ExternalAgentDefinitionRegistry` and `ToolGateway` were declared in both
  `adk-llm-bridge/agents` and `adk-llm-bridge/workflows`, and their `#private`
  members made the copies unrelated types, so
  `new ExternalAgentWorkflowFactory({ registry: new ExternalAgentDefinitionRegistry() })`
  failed to compile (TS2322) with the registry from `/agents`. Shared modules
  and their declarations are now emitted once under `dist/shared/`, and the
  package is smaller unpacked. `bun run ci` fails if a class is defined in
  more than one `dist` JavaScript file or declared in more than one `.d.ts`
  file, and the NodeNext consumer check passes an `/agents` registry to the
  `/workflows` factory.
- **Plugin and agent tool callbacks run for ADK tools given to an
  `ExternalAgent`.** Each bridged call runs the invocation's plugin
  `beforeToolCallback`, `onToolErrorCallback` and `afterToolCallback`, and the
  agent's own tool callbacks, in ADK's order; before, they never ran, so
  plugin guardrails, redaction and audit were skipped silently. A before
  callback's response replaces the call, an after callback's the result, and
  a throwing callback fails the call with `CALLBACK_FAILED` (a throwing before
  callback means the tool does not run).
- **A bridged tool's credential request no longer looks like success.**
  `toolContext.requestCredential()` returns a `CREDENTIAL_REQUIRED` error to
  the runtime (the request is in `actions.requestedAuthConfigs`), and the
  turn ends with an `EXTERNAL_AGENT_TOOL_CREDENTIAL_REQUIRED` error event.
  ADK's `adk_request_credential` flow is not supported for bridged tools.
- **Long-running bridged tools pause the turn.** A tool with `isLongRunning`
  (such as `LongRunningFunctionTool`) that returns no result is no longer
  reported as finished with `{ result: null }`: the agent emits the call with
  its id in `longRunningToolIds` and ends the turn, as ADK pauses an
  `LlmAgent`. A later `functionResponse` with that id resumes the agent. The
  runtime gets the result as a tool result in its user message, never in its
  instruction (a system prompt for the Claude SDK), and the instruction gets
  only a fixed note. Each call id is used once per turn and once overall.
  The runtime sees only the accepted answers: every other `functionResponse`
  part of the user's messages (a duplicate id, an unknown or another agent's
  id, a re-sent answer, a confirmation answer, earlier turns' results) is
  removed from what the driver gets. A result over 64 KiB (UTF-8 bytes of
  JSON), or more than 256 KiB in one turn, ends the turn with an
  `EXTERNAL_AGENT_TOOL_RESULT_TOO_LARGE` error event before the runtime
  starts; a smaller answer for the same call can follow.
- **The current user turn is sent once in a flattened prompt.** The history
  builder (Claude SDK prompt string, Codex input) added `userContent` again
  after the session's copy of the same message, because it compared the two by
  object identity while the history holds normalized copies; every flattened
  prompt carried the user's message twice. It now skips `userContent` only when
  the user's last message was written by the current invocation
  (`invocationId`) and has the same parts, so a repeated message ("yes",
  "continue") that the session does not hold yet is still sent as the current
  turn.
- **Array tool results are wrapped as `{ results: [...] }`**, as ADK does, for
  bridged ADK tools, their callback responses and the runtime's own tool
  results on the timeline (before: `{ result: [...] }`). Other non-object
  values stay `{ result }`.
- **An approved ADK confirmation that the runtime does not use fails the
  turn.** When the human approved a call and the runtime did not make it
  again on the answer turn, the call never ran but the turn looked
  successful. It now ends with an `EXTERNAL_AGENT_CONFIRMATION_UNUSED` error
  event naming the tool. An unused rejection is not an error.
- **Claude CLI runs report why they stopped and get tool spans.** A failed
  `result` line (for example `error_max_turns`) or an assistant `error` is now
  one `error` event classified from its subtype (`MAX_TURNS_EXCEEDED`, ...),
  not `CLAUDE_CLI_EXIT`. `tool_use` and `tool_result` blocks become
  `tool_call` and `tool_result` events, so each tool use gets an
  `execute_tool` span and each model call its own `call_llm`. Tool results are
  no longer emitted as model output text.
- **Claude SDK error subtypes are classified.** `model_not_found` is
  `INVALID_REQUEST`; `account_on_hold`, `verification_required` and
  `cloud_credential_error` are `AUTH_ERROR` (none recoverable), and
  `overloaded` is a recoverable `SERVER_ERROR`. Before, they were recoverable
  `CLAUDE_AGENT_SDK_ERROR`, so retries spent attempts on a bad model id. The
  error message keeps the SDK's readable text after the subtype.
- **`ClaudeAgentSdkDriver` releases the run's abort signal.** The listener on
  the run's abort signal is removed when the run ends, and the driver aborts
  its own controller after the SDK's teardown.
- **OpenAI-compatible requests always end with a user turn.** Like Anthropic
  and ADK's `GoogleLlm`, the OpenAI-compatible providers now apply ADK's
  `maybeAppendUserContent`: empty contents, or a history that ends on a model
  turn, get ADK's user turn. Both providers drop contents with no parts first.
- **Streamed tool calls and reasoning from loose gateways.** A tool-call name
  repeated on every fragment is no longer doubled. A fragment without `index`
  continues the last call (or starts one when its `id` is new), and a
  `reasoning_details` fragment without `index` continues the last entry of the
  same type. A tool call with an empty `id` gets a generated one.
- **A blank `apiKey` no longer hides a valid one.** For providers that require
  a key, an empty or blank instance or global `apiKey` counts as unset, so the
  global key or the environment applies. An instance option set to
  `undefined` (for example `organization`) no longer erases the global value
  in the provider headers.
- **Thought-only events are not collected as history.** An event whose only
  text is a thought no longer becomes an empty turn in the prompt an external
  agent receives.
- **A read-only denial names the path when the path is the reason.** A
  `read-only` request for a path outside `allowedPaths` was denied with the
  read-only message only; it now says the path is outside the allowed paths.
  The request is still denied either way.
- **A missing Codex SDK package is reported as such.** With the network off,
  `CodexSdkDriver` listed Codex's MCP servers before loading
  `@openai/codex-sdk`, so a host without the package and without a `codex`
  binary got `MISSING_BINARY` instead of `EXTERNAL_AGENT_DEPENDENCY_MISSING`
  with the install command. The package is now loaded first.
- **Read-only Claude CLI agents run the configured model.** `ClaudeCliDriver`
  mapped `read-only` to `--permission-mode plan`, and the CLI's plan mode runs
  a different model: a `--model haiku` run answered with Sonnet at about 25
  times the cost. `read-only` now maps to `--permission-mode dontAsk`, which
  keeps the model. Read-only still holds: the write and shell tools are
  removed, and every MCP tool is denied, also with `inheritHostConfig: true`
  (a host `permissions.allow` rule cannot let one through).
- **Token and reasoning parameters for current models.** `gpt-6-astra`,
  `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-luna` and later releases fell through
  to `max_tokens` and lost `reasoning_effort`, because detection was a fixed
  list (`gpt-5*`, `o1`/`o3`/`o4`). It now parses the family and version.
  Fine-tuned ids (`ft:o4-mini-...:org::id`) are matched by their base model.
  `grok-*-non-reasoning` no longer receives `reasoning_effort`.
- External agent spans carry the real model: `gen_ai.request.model` is the
  configured model (never the provider id, such as `"claude"`), and
  `gen_ai.response.model` is the model the runtime reports.
- Coordinator mode no longer emits each sub-agent model call twice, and
  state-only events no longer produce `call_llm` spans.
- External agent `call_llm` and `execute_tool` spans have real durations (one
  model step; a tool call to its result), and the delegated sub-agent's
  `invoke_agent` span nests under the `execute_tool transfer_to_agent` span.
- No more `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning on every coordinator run
  with sub-agents.
- Workflow HITL: with the default execution id, every turn while a run waits
  for input now goes to that run instead of starting a fresh one. A turn that
  answers nothing is rejected with `WORKFLOW_INPUT_MISMATCH`, or, if it repeats
  the original input, replays the finished steps and keeps waiting. A
  long-running tool call now counts as an interrupt even when it is not on the
  last event (as with ADK 2.4's `LlmAgent` and `LongRunningFunctionTool`), so
  the step waits instead of completing. ADK `NodeTool` calls are not
  interrupts themselves; a paused node's own request is. Gateway,
  `ToolGateway` and `ExternalAgent` delegations report the same interrupt.
- `CodexCliDriver` no longer emits raw `codex exec --json` lifecycle or unknown
  events (for example `{"type":"turn.started"}`) as assistant text. CLI errors
  go through the same classifier as the SDK driver: a usage cap is one
  non-recoverable `QUOTA_EXHAUSTED` event, and a `turn.failed` that
  repeats the previous `error` is dropped.
- `outputSchema` and tool parameter schemas with zod length or count
  constraints (`.min()`/`.max()` on arrays, strings and records) no longer fail
  with 400 on OpenAI and xAI. ADK emits these counts as strings
  (`minItems: "2"`); the bridge now sends integers on every provider path.
  Numeric bounds given as strings become numbers, and instance data (`default`,
  `example`, `examples`, `enum`, `const`) is copied verbatim.
- Tool-call IDs are synthesized and correlated so they never collide
  ([#87](https://github.com/pailat/adk-llm-bridge/issues/87)).
- Thought parts never carry empty text. ADK dropped such events from the
  context, which lost function calls on xAI and Anthropic reasoning turns.
- Anthropic: thinking with tools and `BuiltInPlanner` no longer returns 400,
  and streamed `redacted_thinking` blocks reach the final event.
- External agents:
  - the CLI drivers run on Node (they crashed with "Bun is not defined") and
    stop their subprocess on abort;
  - `ClaudeCliDriver` no longer emits the final answer twice;
  - Codex: `turn.failed` becomes an error event, "usage limit" errors are
    non-recoverable `QUOTA_EXHAUSTED`, and one failure gives one error
    event;
  - Gemini CLI: the native `stream-json` schema is parsed;
  - clones no longer share driver session state;
  - a sub-agent waiting for confirmation is reported to the coordinator as an
    interrupt, never as a successful empty result;
  - `readOnlyTools` matches tools by their original name.
- Workflows:
  - nested `WorkflowAgent`s work on the default checkpoint store;
  - steps left `running` after an abort or timeout are recorded as `interrupted`;
  - unbounded recursion in a script reports `WORKFLOW_LIMIT_EXCEEDED`;
  - `ownership.validate` accepts change entries with the optional `mode` field,
    which the Git worktree driver always sets.
- The published declaration files no longer contain a bare `private;` member
  (TS7008 under `strict` with `skipLibCheck: false`).
- Workflow HITL: a `NodeTool` call is no longer reported as a pending
  interrupt when the calling `LlmAgent` is a graph node of a
  `NodeTool`-wrapped ADK `Workflow` (at any depth) or when the `NodeTool` comes
  from a toolset. The interrupt scan recognizes the node run by ADK's
  `<tool>@<call id>` branch.
- Workflow HITL: re-entering a step that is still waiting, without an answer,
  emits its pending request and `step_waiting` again (long-running tool calls
  as an id-only marker, so the model never sees a call twice). An outer
  workflow or gateway delegation that re-enters a waiting inner workflow now
  waits on that request instead of completing.
- Workflow HITL: a step that failed earlier in the run no longer runs again on
  the answer turn. Re-running it changed the inputs of the later steps, so the
  answer failed with `WORKFLOW_STEP_MISMATCH` and the approval was lost.
- A failed workflow step's error `details` carry the agent's `causeCode` (the
  `errorCode` of its error event, for example `MODEL_NOT_FOUND`) and the
  gateway's `errorKind`.
- `step_started` reaches the consumer before the step's agent starts; it came
  after the agent's first event when the consumer awaited I/O per event.
- `FileSystemWorkflowCheckpointStore`: a lock release whose rename or
  directory sync fails after the checkpoint was written no longer fails the
  save (which left the coordinator on a stale revision, so later saves failed
  the CAS check); it logs `WORKFLOW_CHECKPOINT_LOCK_RELEASE_FAILED`. A lock
  lost to another owner still fails the save with
  `checkpoint_lock_ownership_lost`, and a lock with no valid owner with
  `checkpoint_lock_corrupt`. A load opens the file once with
  `O_NOFOLLOW` and reads through that handle, so a checkpoint swapped for a
  symlink after the check is rejected (`checkpoint_file_unsafe`) instead of
  read; a FIFO is rejected without blocking.
- The file-system checkpoint store, workspace adapter and Git lock remove the
  tombstone of a lock their owner released, so the state directories no
  longer grow by one directory per save or lease. A recoverer re-reads the
  owner after finding it dead and retires only a lock that still carries the
  dead token; tombstones of recovered locks are kept and collected offline.
- The canonical workflow hash throws on a boxed BigInt (`Object(1n)`), as
  `JSON.stringify` does, instead of hashing it as `{}`.
- Delegation (`run_adk_subagent` / native `transfer_to_agent`) and transfer
  targets see the coordinator's latest events (its text, the call and the
  transfer response) in their session view. A transfer target sees the user
  message once.
- Cancelling a Claude, Codex or Gemini CLI run kills the CLI's whole process
  group on macOS and Linux (shells, MCP servers and other children it
  started), with SIGKILL after `killGraceMs` (default 2000 ms) if SIGTERM is
  ignored. Ctrl-C, SIGTERM and SIGHUP of the host reach the CLI's group, and
  the host still ends by that signal unless it handles it itself, with
  `process.on` or `process.once` (a `once` listener no longer made the bridge
  re-raise the signal and end the host before it drained). Process
  groups still running when the host exits are killed too. On Windows only
  the CLI process is signaled.
- `CodexCliDriver`: an empty `turn.failed` has a readable message; a non-JSON
  stdout line is logged as a warning instead of ending the run (also in
  `ClaudeCliDriver` and `GeminiCliDriver`); an explicit code such as
  `quota_exhausted` is classified as `QUOTA_EXHAUSTED`.
- The usage-cap rule no longer classifies resource limits ("memory usage limit
  exceeded") as `QUOTA_EXHAUSTED`. A subtype named like an
  `Object.prototype` member (`toString`) is no longer classified by accident.
- int64 count keywords given as digit strings (`minItems: "2"`, `maxLength`,
  ...) in `responseJsonSchema` and a tool's `parametersJsonSchema` are sent as
  integers on OpenAI-compatible providers and Anthropic, including nested
  sub-schemas; the rest of the schema is forwarded unchanged.
- A schema property named `__proto__` is no longer dropped (also for
  Gemini-style `responseSchema` / `parameters`).
- A file that is moved and edited can be committed by the Git worktree driver
  (inspect and prepare both report a deletion plus an addition; exact moves
  stay renames, paired in code-unit order).
- Git driver: owner-only execute bit as Git records it, and
  `core.fileMode=false` is honored; dangling in-tree symlinks are accepted
  consistently; `:name` paths are handled literally; a `\` in a worktree path
  fails with `GIT_WORKTREE_PATH_ESCAPE`; an invalid target ref fails with
  `GIT_CONFIGURATION_INVALID` instead of a raw exec error.
- A task whose driver throws an error with a throwing `code` getter or a
  Proxy finishes as `failed` instead of staying `running`; a task sweep
  reports such a store error as a failure instead of throwing, and the
  controllers rethrow the original error.
- `isWorkflowDefinition` returns `false` for fields of the wrong type or fields
  that throw when read, and `defineWorkflow` / `defineScriptWorkflow` throw
  `WORKFLOW_DEFINITION_INVALID`.
- A checkpoint whose stored interrupt events have malformed resume fields, or
  a non-object `actions` / `actions.stateDelta`, is rejected at load
  (`checkpoint_file_corrupt`) instead of crashing the resume; the checkpoint
  error-code allowlist is exhaustive by type.
- Workflow JSON snapshots reject symbol keys and sparse arrays and read each
  getter once; an own `__proto__` key (for example in an execution input from
  `JSON.parse`) stays a plain key instead of becoming the copy's prototype and
  blocking every later transition; a limits object with missing fields is
  rejected.
- Malformed ADK Content from a script (a `null` or scalar part, a non-string
  `role`) fails with `WORKFLOW_SCRIPT_INVALID` instead of a host `TypeError`;
  a journaled replay with such content fails with `WORKFLOW_ATTEMPT_MISMATCH`.
- Recorded error messages and codes are never cut inside a surrogate pair.
- `WorkflowOrchestrationControlError.details` is deep-frozen; default
  ownership ids use `crypto.randomUUID()`.
- Codex CLI and Gemini CLI send the user's message, not only the
  instruction.
- A missing Claude Code executable in the Claude SDK driver is
  `MISSING_BINARY` and not recoverable, as in the other drivers.
- CLI exit errors are classified: auth, billing and quota failures are no
  longer marked recoverable. They are sorted by the last stderr line, so an
  earlier warning no longer makes a transient failure non-recoverable; the
  message keeps the last 4096 characters, and a stderr line without a newline
  is capped while it arrives. Codex CLI reports `CODEX_CLI_EXIT` for a failed
  exit without an error event, or after `turn.completed`, and sends one
  `completed` with the turn's usage.
- A `null` or non-object JSON line from a CLI, or an `error` line with a
  `null` or non-string detail, no longer crashes the run.
- A child process's `started`, `completed` / `complete` / `result` and
  `state_delta` lines no longer end the turn or change state: the run ends
  when the process exits, with one `completed`. Legacy `output` and
  `tool_call` lines are still read.
- `ExternalAgent` rejects an invalid `permissions` policy at construction
  (`InputValidationError`) and keeps a frozen copy; the gateway and the flag
  mapper treat an unknown policy as read-only.
- Array, scalar, `Date`, `Map` and class-instance results of bridged ADK tools
  are wrapped as `{ result }`.
- Bridged tool results are paired by exact name, so another MCP server's tool
  with the same suffix no longer takes the tool's actions.
- A retried call with malformed arguments no longer uses up the human's
  confirmation answer.
- With an `outputSchema`, integers beyond `Number.MAX_SAFE_INTEGER` in the
  agent's JSON answer (object, array or scalar) arrive as strings of their
  exact digits; declare such fields as `z.string()` or a union.
- The Claude, Codex and Gemini CLI drivers and `SubprocessJsonlDriver.parseLine`
  keep integers beyond `Number.MAX_SAFE_INTEGER` exact, as strings, in the
  tool inputs and results they read from stdout.
- Sub-agent event titles show the query or tool name like the other titles.
- CLI and Claude SDK drivers validate `command`, `killGraceMs` and `maxTurns`
  at construction (`InputValidationError`).
- Anthropic honors `baseURL` from the instance, `setProviderConfig` and
  `registerAnthropic` (and `ANTHROPIC_BASE_URL`), and passes `timeout` and
  `maxRetries` to the SDK; the base URL is validated (`InputValidationError`,
  value not echoed).
- Base URLs and API keys from environment variables are trimmed, and a blank
  one counts as unset, as the provider SDKs do.
- An array `parametersJsonSchema` is ignored on Anthropic, as on
  OpenAI-compatible providers, instead of being sent as `input_schema` (which
  the API rejected with a 400).
- Anthropic `model_context_window_exceeded` is reported as `MAX_TOKENS`; a
  non-object tool input is a malformed call instead of `{}`.
- An OpenAI-compatible reply with no choices, or a 200 body without `choices`
  (an error object), is `NO_CHOICE` and, in `errorMode: "throw"`, a
  `ProviderLlmError`.
- Non-streaming Anthropic replies keep integers beyond
  `Number.MAX_SAFE_INTEGER` exact, as strings, in tool input and structured
  output, as streaming already did; declare such structured-output fields as
  `z.string()` or a union. An empty or malformed body is `ANTHROPIC_ERROR`.
- A connection that drops after the finish chunk, before the trailing usage
  chunk or `[DONE]`, no longer turns a complete streamed reply into
  `<PREFIX>_ERROR`: the final response is kept, without the missing usage.
- `FileSystemWorkspaceAdapter` drops expired leases written by older releases
  whose paths the new grammar rejects; a live one fails with
  `WORKFLOW_WORKSPACE_STATE_INCOMPATIBLE`.
- A task sweep without `limit` defaults to `min(100, maxSweepTasks)`.
- Git: an abort during a command rejects with the signal's reason; a timeout
  says "timed out after N ms".
- Codex CLI stderr on a successful exit is logged as a `CODEX_CLI_STDERR`
  warning instead of an error event.
- A `null` credential and `driverOptions: null` count as unset instead of
  throwing a TypeError.
- `normalizeSchema` lowercases each name in a `type` array
  (`["STRING", "NULL"]` becomes `["string", "null"]`), not only a single
  `type` string.
- `AgentInvocationGateway` joins the text parts of one event with a newline,
  as ADK's `AgentTool` does, instead of with nothing.

- `WorkflowAgent.clone()` and `ScriptWorkflowAgent.clone()` threw a
  TypeError: the agents passed only part of their config to `BaseAgent`. The
  whole config is forwarded now, so a clone keeps the definition and adapters.

- Windows: a workspace or repository mutation lock taken by another process
  between the occupancy check and the publishing rename is waited for instead
  of failing the mutation. Windows reports a rename onto a non-empty directory
  as `EPERM`, which the checkpoint store already treated as contention.
- Windows: a delayed recovery of an abandoned lock (the checkpoint store, and
  the workspace and repository mutation locks) failed with `EPERM` when another
  recoverer had already retired the same lock, instead of waiting for the new
  owner. `MoveFileExW` never replaces a directory, so Windows reports a rename
  onto the existing tombstone as `EPERM`, not `EEXIST`. That `EPERM` now counts
  as the collision when a directory (the tombstone) is at that path; any other
  `EPERM` still fails.
- Windows: loading a checkpoint could read through a symlink swapped in after
  the store checked the path, because Windows has no `O_NOFOLLOW` and the open
  follows it. On every platform the load now checks the path with `lstat`
  (refusing a symlink before opening it) and reads only when the path names
  the opened file (device and inode; volume and file id on Windows). A file a
  concurrent save renamed over the path is read; a path that became a symlink
  or names another file fails with `checkpoint_file_unsafe` everywhere. On
  Linux kernels older than about 4.19, overlayfs can report different device
  and inode numbers to `stat` and `fstat`, which fails every load there; keep
  the checkpoint root on a volume.
- Windows: releasing a lock (the checkpoint store, and the workspace and
  repository mutation locks) retries a rename that a waiter's open `owner.json`
  blocks (`EPERM`, `EBUSY`, `EACCES`; within a time budget, see the entry on
  the checkpoint publish below) instead of leaving the lock behind under a live
  process.
- Linux and Windows: a checkpoint save that waited while the lock was
  released and taken by another writer could fail with
  `checkpoint_lock_corrupt`. The new lock directory often reuses the old one's
  inode number (ext4, NTFS), so the store took it for the same lock without
  its owner. The store now holds the lock directory open while it reads the
  owner, so its number cannot be reused in between.
- Windows: the file-system checkpoint store failed every save
  (`checkpoint_lock_candidate_failed`, `EPERM` from `fsync`), because Windows
  cannot flush a directory. The checkpoint store, the workspace adapter and the
  repository mutation lock now skip the directory flush on Windows only, where
  NTFS journals the rename; a save that already resolved can still be lost to a
  power failure right after it. File contents are flushed on every platform.
  Elsewhere a failed directory flush is an error, including the codes the
  workspace and repository locks used to ignore; a lock whose flush fails
  right after it is taken is released instead of left behind.
- Windows: saving a checkpoint failed with `checkpoint_write_failed` when
  another process held the checkpoint file open, such as a reader or another
  saver, because the rename that publishes the file is refused (`EPERM`,
  `EBUSY`, `EACCES`) while the handle is open. The file-system checkpoint store
  and the file-system workspace adapter now retry that rename. The checkpoint
  lock release, which retried a fixed 5 times 20 ms apart, uses the same retry:
  a 5 second budget with jittered exponential backoff (5 ms doubling to
  250 ms), so many polling waiters cannot exhaust it. Any other error fails at
  once, and a rename still blocked after the budget fails with its own error.
  On macOS and Linux a rename is not blocked by an open file, so the retry
  does not run in the normal path; but `EPERM` and `EACCES` there are also real
  permission errors (a read-only directory, say), and a save that hits one now
  fails with the same error after the 5 second budget, not at once.
  On Windows a save waits up to 5 s for other processes that hold the
  checkpoint file open (readers, other savers) to release it, then fails with
  `checkpoint_write_failed` (`details.causeCode` `EPERM`, `EBUSY` or
  `EACCES`; `details.waitedMs` is the time waited). A reader that keeps the
  file open almost continuously can make saves fail: read with open, read,
  close, and do other work between reads. Antivirus scanners, indexers and
  editors that watch the checkpoint directory can hold files open too.
  See [Checkpoint commit semantics](docs/workflow-durability.md#checkpoint-commit-semantics).
  Known limitation on Windows: several saves of the same checkpoint at once
  (from one or more processes) can fail to take the lock
  (`checkpoint_lock_acquire_failed`, `EPERM`) instead of waiting; see
  [issue 117](https://github.com/pailat/adk-llm-bridge/issues/117).

### Docs

- `docs/external-agent-isolation.md`: the per-run `/tmp/adk-claude-*` temp
  directory of the Claude drivers stays behind when the host is killed with
  `SIGKILL` before the run ends; how a host cleans stale ones safely.
- `docs/workflow-durability.md`: writing your own checkpoint store, with
  `workflowCheckpointRevision`, `assertWorkflowCheckpointSize`,
  `workflowCheckpointByteLength`, `workflowCheckpointSizeLimitError` and
  `stableSerializeWorkflowValue`; a step tool can write the parent's
  checkpoint in session state (who can write the checkpoint); and re-sending
  an answer after a resumed step's continuation failed can run the approved
  tool again.
- `AgentInvocationResume`: the gateway trusts `resume.events` from the caller
  and does not guard against replay; consume each interrupt once.
- `docs/external-agent-isolation.md`: how bridged ADK tool names are rewritten
  (`adk_tool__` prefix, sanitized, 64 characters, `_2` suffixes); how the
  confirmation protocol differs from ADK's (bridge ids and payload, matching
  by tool name and arguments, one request per turn); which `EXTERNAL_AGENT_*`
  codes are policy refusals and which are agent events; and that the
  case-insensitive built-in name match also applies to the start check, the
  `PreToolUse` hook and the `canUseTool` wrapper.
- `docs/workflow-control-plane.md`: which error class carries which code type.
- `docs/workflow-durability.md`: how to clear a stuck checkpoint lock while
  writers may run (rename the `.lock` directory away, then delete it; a
  recursive delete in place makes a concurrent writer fail with
  `checkpoint_lock_corrupt`).
- `docs/external-agent-isolation.md` and `docs/migration-0.7.md`: a "Planned
  changes" note: 0.8 is planned to replace the CLI drivers' `args` denylist
  with an allowlist, so other flags would need `allowPolicyOverrideArgs`.

## [0.6.0] - 2026-06-20

Released on GitHub only; first npm release containing it is 0.7.0.

### Added

- **External agents bridge** (`adk-llm-bridge/agents`). A new subsystem that wraps
  full external coding agents as native ADK agents, preserving multi-agent
  orchestration, tool calling, and streaming:
  - Anthropic Claude via the Claude Agent SDK (`ClaudeAgent`).
  - OpenAI Codex via the Codex SDK/CLI (`CodexAgent`).
  - Google Gemini via the Gemini CLI (`GeminiCliAgent`).
  - A driver abstraction (SDK / CLI / subprocess modes), credential providers,
    permission-policy mapping, runtime sessions, a tool gateway, and a native
    ADK event stream (`ExternalAgentEvent`).
- Examples: `basic-agent-claude`, `basic-agent-codex`, `basic-agent-gemini`, and
  the combined `external-agents` showcase.

### Changed

- SDK pins: `@openai/codex-sdk` `^0.141.0` and
  `@anthropic-ai/claude-agent-sdk` `^0.3.183`.

### Fixed

- **Codex driver:** availability detection now keys on `CODEX_API_KEY` /
  `$CODEX_HOME/auth.json` instead of a `codex` binary on `PATH` (the SDK bundles
  its own); errors are classified (auth/billing/missing-binary non-recoverable,
  transport/rate-limit recoverable); the thread id is captured from
  `thread.started` so resumability survives a mid-turn failure; and proxy/cert/
  `CODEX_HOME`/`CODEX_ACCESS_TOKEN` vars are forwarded through the replacement env.
- **Claude driver:** a read-only policy maps to `permissionMode: "default"`
  (no longer the interactive `"plan"` mode); `settingSources` defaults to `[]`
  (SDK isolation) so host `~/.claude`/project settings no longer leak in; the
  spawned CLI is cancelled via `abortController` + `interrupt()`/`return()` on
  early break or error; and errors are classified from the SDK's typed subtypes.

## [0.5.3] - 2026-06-19

### Added

- **Native model config passthrough** ([#76]). The provider converters now
  forward the full `LlmRequest.config` (a `@google/genai` `GenerateContentConfig`)
  to each provider instead of dropping everything but `systemInstruction`,
  `contents`, and tool `functionDeclarations`. Covers both the OpenAI-compatible
  family (OpenAI/xAI/OpenRouter/AI Gateway/Custom) and the Anthropic native
  provider:
  - Sampling/generation config (`temperature`, `topP`, `topK`,
    `maxOutputTokens`, `stopSequences`, `seed`, presence/frequency penalties,
    `candidateCount`, logprobs).
  - `tool_choice` (from `toolConfig.functionCallingConfig`).
  - `finishReason` (provider finish/stop reason → ADK `FinishReason`).
  - Streaming token usage (OpenAI `stream_options.include_usage`).
  - Multimodal image input (`inlineData`/`fileData` → OpenAI `image_url` /
    Anthropic image + document blocks).
  - Structured output (`responseSchema` → OpenAI `response_format` json_schema /
    Anthropic forced `json_output` tool).
  - Reasoning/thinking input + output (`thinkingConfig` → OpenAI
    `reasoning_effort`, model-gated with `max_completion_tokens`; Anthropic
    extended thinking with a signed thinking-block round-trip), surfaced as ADK
    thought parts + `thoughtsTokenCount`.
  - Anthropic prompt caching (opt-in instance config).
  - Gemini-only tools/config are filtered cleanly with a one-time warning.
  Provider-API forbidden combinations are reconciled and verified against the
  live APIs (e.g. Anthropic drops sampling params and forced `tool_choice` when
  thinking is enabled). Public API is additive; no existing signatures changed.

### Changed

- Tested and built against `@google/adk@1.2.0` ([#75]): dev dependency bumped to
  `^1.2.0`, peer range tightened to `>=0.5.0 <2`, and all examples updated to
  `@google/adk@^1.2.0`. `src/` is compatible with both 0.5.x and 1.2.x.
- Examples: `express-server` uses the `Context` type (the non-existent
  `ToolContext` import is gone) and reports `updatedAt` from `listSessions`; all
  examples bumped `zod` to `^4.2.1` for ADK 1.2.0 type compatibility.

### Fixed

- Hardening from an internal review of the passthrough feature (all additive,
  no public API change):
  - **Anthropic structured output now works with ADK `outputSchema`/`outputKey`.**
    The emulated `json_output` tool result is surfaced as JSON **text** (not a
    dispatchable `functionCall`), so ADK populates `session.state[outputKey]`
    and treats the turn as final — matching the OpenAI path.
  - Anthropic `maxOutputTokens <= 0` no longer sends `max_tokens: 0` (rejected
    by the API); it falls back to the instance default.
  - Anthropic `thinkingConfig.thinkingBudget <= 0` now disables thinking
    (consistent with the OpenAI path) instead of forcing it on at the minimum
    budget.
  - OpenAI-compatible: `candidateCount`/`n` is dropped for reasoning models
    (gpt-5/o-series reject `n > 1`), and `top_logprobs` is clamped to `0..20`.
  - A one-time warning is emitted when image parts on a non-user turn are
    dropped, and when a forced `tool_choice` is downgraded under Anthropic
    extended thinking.

### Docs

- Documented the upstream `@google/adk-devtools` web-UI "Sessions" tab
  limitation and clarified the `LLMRegistry.register` vs factory-pattern
  distinction.

## [0.5.2] - 2026-06-18

### Fixed

- **Runtime import from the package entry now works again** ([#73]). `0.5.1`'s
  `dist/index.js` was a single `export { ... }` statement referencing ~40
  symbols that were never declared, so `import { Custom } from "adk-llm-bridge"`
  failed at runtime (`Export 'AIGateway' is not defined` on Node, `"Custom" is
  not declared in this file` on Bun). Root cause: the build bundled+minified the
  pure re-export barrel `src/index.ts` into one file with `"sideEffects": false`,
  so dead-code elimination dropped the bindings while keeping the export list.

### Changed

- Build migrated from a hand-rolled `Bun.build()` script to
  [`bunup`](https://bunup.dev), which emits the JS and matching `.d.ts` from one
  plan (no more JS/types structure mismatch).
- Removed `"sideEffects": false` from `package.json`. **Note for consumers:** the
  package no longer asserts it is side-effect-free, so bundlers are more
  conservative when tree-shaking unused re-exports. Registration is still
  explicit (no import-time side effects), so this is safe; it only affects how
  aggressively a downstream bundler can drop unused modules.
- `prepublishOnly` and `ci` now run packaging gates: `publint --strict` and
  `@arethetypeswrong/cli --pack --profile esm-only`.
- Pinned the toolchain to Bun 1.3.14 / Node 25.9.0 via `mise.toml`.
- Examples refreshed to each provider's current model (AI Gateway / Anthropic
  `claude-sonnet-4.6`, OpenAI `gpt-5.5`, xAI `grok-4.3`, OpenRouter
  `z-ai/glm-5.2`) and bumped to depend on `^0.5.2`.

### Removed

- `scripts/build.ts` and `scripts/fix-declaration-imports.mjs` (superseded by
  `bunup`, which emits correct ESM import specifiers).

[0.7.0]: https://github.com/pailat/adk-llm-bridge/releases/tag/v0.7.0
[0.6.1]: https://github.com/pailat/adk-llm-bridge/releases/tag/v0.6.1
[0.6.0]: https://github.com/pailat/adk-llm-bridge/releases/tag/v0.6.0
[0.5.3]: https://github.com/pailat/adk-llm-bridge/releases/tag/v0.5.3
[0.5.2]: https://github.com/pailat/adk-llm-bridge/releases/tag/v0.5.2
[#73]: https://github.com/pailat/adk-llm-bridge/issues/73
[#75]: https://github.com/pailat/adk-llm-bridge/pull/75
[#76]: https://github.com/pailat/adk-llm-bridge/pull/76
