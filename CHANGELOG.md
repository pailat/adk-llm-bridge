# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] - Unreleased

0.7.0 is the first npm release after 0.5.3: 0.6.0 was published on GitHub only.
It contains everything from [0.6.0](#060---2026-06-20) plus the changes below.
See [docs/migration-0.7.md](./docs/migration-0.7.md) to upgrade from 0.5.3 or
from the 0.6.0 tag.

### Breaking

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
    `>=0.167.0 <0.168` (optional, for `adk-llm-bridge/agents`).
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
  ([#88](https://github.com/pailat/adk-llm-bridge/issues/88)).
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
    the model's tool list. WebFetch/WebSearch are removed in every mode unless
    `allowNetwork: true`. Calls to removed tools are still denied;
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
  - a change commit or integration journaled before 0.7.0 and retried after
    upgrading fails closed with an intent mismatch. Let in-flight
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
    `pathBounds` field, which `assertPermissionPolicy` validates;
  - `adk-llm-bridge/agents` no longer exports `SubprocessJsonlDriver`,
    `SubprocessJsonlDriverConfig`, `contentsToSdkMessages`,
    `ClaudeContentBlockParam`, `ClaudeMessageParam`, `SDKUserMessage`,
    `summarizeHistoryForColdStart`, `userContentToCodexInput`,
    `CodexInputMapperOptions`, `CodexInputMapping`, `CodexInputPart`,
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
    raw `ExecException` or `TypeError`.

### Security

- **Read-only Claude agents cannot use host MCP tools.** With
  `inheritHostConfig: true`, a host MCP tool that host settings pre-approve
  ran without a prompt, so a `read-only` agent could write through it.
  `ClaudeCliDriver` now always denies `mcp__*` under `read-only`, and
  `ClaudeAgentSdkDriver` adds a `PreToolUse` hook that denies every MCP tool
  except the bridge's own. A `read-only` agent with `requiredMcpServers`
  cannot call those servers' tools.
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
  directly. Inherited and derived policies are frozen, and the policy registry
  rejects look-alike objects. ADK `AgentTool` still starts a new permission
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
  connectors, at start or later, no longer goes unnoticed.
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

### Added

- **External agent usage and model:** `ExternalAgentStartedEvent.model` and
  `ExternalAgentCompletedEvent.{model, usage, numTurns, durationMs}` (new
  `ExternalAgentUsage` type), filled by the Claude SDK and CLI drivers and,
  for usage only, the Codex SDK and CLI drivers. Run tokens (including cache
  read and creation), cost and turns go on the agent's `invoke_agent` span
  (`gen_ai.usage.*`, `gcp.vertex.agent.external_agent.*`), and the run's final
  text event carries `usageMetadata` (`promptTokenCount` includes cache
  tokens).
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
- `ProviderLlmError` (`code`, `status`, `provider`, `detail`, `cause`) and the
  `errorMode` option (per model or through `setProviderConfig`). `provider` is
  the provider id (`openai`, `anthropic`, `custom`, ...); the prefix is in
  `code`. The types `ProviderLlmErrorInit`, `CustomProviderRegistrationConfig`
  and `ErrorMode` are exported.
- Usage metadata reports `cachedContentTokenCount`.
- Provider spans get `gen_ai.provider.name`, `gen_ai.response.model`,
  `gen_ai.response.id` and `server.address`, and ERROR status on failure.
- Runtime conformance fixtures and profiles
  ([#86](https://github.com/pailat/adk-llm-bridge/issues/86)), and the
  OpenAI-compatible feature degradation matrix
  ([#89](https://github.com/pailat/adk-llm-bridge/issues/89)).
- `workflowCheckpointRevisionMatches(checkpoint, revision)` and
  `workflowArtifactRevisionMatches(artifact, revision)` for durable store
  implementations; both accept pre-0.7.0 revisions.
- `workflowArtifactStoragePath({ executionId, artifactId })` resolves to a
  per-execution, traversal-free relative path for file-backed artifact
  stores, with each segment at most 255 characters (a longer escaped id
  becomes `~` and its SHA-256 hex digest), and `WorkflowArtifactKey` names
  the two ids.
- `CHANGELOG.md` is included in the published package.
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

### Changed

- Documented the code comment standard (docs/contributing/comments.md) and added
  check-comments and check-export-docs to ci and prepublishOnly: no internal
  tracking ids, valid TSDoc, no per-file license headers (LICENSE is the single
  source).
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
  replay, and foreign signatures are never sent.
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
  before 0.7.0 are still accepted when read, so existing checkpoints
  (including the file store), artifacts, change sets, agent revisions and
  worktrees keep resuming and verifying; only new digests use the canonical
  form. `canonicalJson` from `adk-llm-bridge/workflows` sorts keys by code unit
  as well, so integer-like keys are no longer listed first.
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

### Fixed

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
  - steps left `running` after an abort or timeout are recorded as `failed`;
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
  the host still ends by that signal unless it handles it itself. Process
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

[0.6.1]: https://github.com/pailat/adk-llm-bridge/releases/tag/v0.6.1
[0.6.0]: https://github.com/pailat/adk-llm-bridge/releases/tag/v0.6.0
[0.5.3]: https://github.com/pailat/adk-llm-bridge/releases/tag/v0.5.3
[0.5.2]: https://github.com/pailat/adk-llm-bridge/releases/tag/v0.5.2
[#73]: https://github.com/pailat/adk-llm-bridge/issues/73
[#75]: https://github.com/pailat/adk-llm-bridge/pull/75
[#76]: https://github.com/pailat/adk-llm-bridge/pull/76
