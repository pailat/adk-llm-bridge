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
- **External agents** (`adk-llm-bridge/agents`):
  - the native `transfer_to_agent` call uses `{ agent_name }` (ADK 2.1+)
    instead of `{ agentName }`;
  - the default delegation is `delegation: { finalAnswer: "subagent" }`: the
    `transfer_to_agent` response carries `skipSummarization: true` and the
    sub-agent's answer is final. Use `finalAnswer: "coordinator"` to let the
    coordinator write the final answer (fan-out, aggregation);
  - the Codex and Gemini CLI definitions no longer declare `tools` or
    `mcpServers` support.
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

### Security

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

### Added

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
  `errorMode` option (per model or through `setProviderConfig`).
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
- `CHANGELOG.md` is included in the published package.
- A runnable Codex-only planner → implementer → reviewer workflow smoke example.

### Changed

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
  `SubprocessJsonlDriver.parseLine` does, instead of returning them as
  `output`. The new `CodexCliDriver.parseEvent` returns `undefined` for them.

### Fixed

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
  non-recoverable `CODEX_QUOTA_EXHAUSTED` event, and a `turn.failed` that
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
    non-recoverable `CODEX_QUOTA_EXHAUSTED`, and one failure gives one error
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
