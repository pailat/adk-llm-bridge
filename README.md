# adk-llm-bridge

Use any LLM provider and external coding agents (Claude Code, Codex, Gemini
CLI, fx) with [Google ADK for TypeScript](https://github.com/google/adk-js).

[![npm version](https://img.shields.io/npm/v/adk-llm-bridge.svg)](https://www.npmjs.com/package/adk-llm-bridge)
[![CI](https://github.com/pailat/adk-llm-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/pailat/adk-llm-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)

## Contents

[What it is](#what-it-is) · [Install](#install) · [Quick start](#quick-start) ·
[Providers](#providers) · [Models](#models) · [Features](#features) ·
[External agents](#external-agents) · [Workflows](#workflows) ·
[Upgrading from 0.5.x or 0.6.0](#upgrading-from-05x-or-060) ·
[Examples](#examples) · [Documentation](#documentation) ·
[Contributing](#contributing) · [License](#license)

## What it is

- **Any LLM in ADK.** Each provider is an ADK `BaseLlm`: AI Gateway,
  OpenRouter, OpenAI, Anthropic, xAI, or any OpenAI-compatible endpoint
  (Ollama, vLLM, LM Studio). Tools, streaming, multi-agent transfer and ADK
  callbacks keep working.
- **External agents as ADK agents.** `ClaudeAgent`, `CodexAgent`,
  `GeminiCliAgent` and `FxAgent` run a coding-agent runtime as an ADK `BaseAgent`, so it can
  be a root agent, a sub-agent or a coordinator of ADK sub-agents.
- **Durable workflows.** `WorkflowAgent` (TypeScript) and
  `ScriptWorkflowAgent` (sandboxed scripts) run agent steps with checkpoints,
  replay, retries and human-in-the-loop steps that resume on the next turn.
- **OpenTelemetry.** GenAI attributes on ADK's model spans, plus spans for
  external agents and workflows, with switches to keep content out of traces.
- **Safe defaults.** Provider errors are thrown, Claude agents run isolated
  from the host's Claude setup, network is off unless a policy sets
  `allowNetwork: true`, delegated agents never get wider permissions than
  their parent, and a no-network run that cannot be enforced is refused.

## Install

```bash
npm install adk-llm-bridge @google/adk @google/genai@^2.29.1 @opentelemetry/api
```

Requirements:

- Node.js `>=22`.
- ESM only. Use `import`, or `await import()` from CommonJS;
  `require("adk-llm-bridge")` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
  `@google/adk` ships separate CommonJS and ESM builds, and mixing them breaks
  ADK's class identity checks.
- Required peers: `@google/adk` `>=2.4.0 <3`, `@google/genai` `>=2.29.1 <3`
  (3.x is not supported yet, so pin it if you add it yourself) and
  `@opentelemetry/api` `>=1.9.1 <2`.

Optional peers, only for the features that use them:

| Feature | Install |
|---|---|
| zod schemas (ADK 2.4 requires zod 4) | `zod@^4` |
| Run spec, `adk-llm-bridge/workflows/spec` (experimental) | `zod@^4`; zod >= 4 is required by this subpath only |
| `ClaudeAgent` | `@anthropic-ai/claude-agent-sdk@">=0.3.319 <0.4"` |
| `CodexAgent` | `@openai/codex-sdk@0.167.0` (exact) |
| `GeminiCliAgent` | the `gemini` CLI on `PATH` |
| `FxAgent` | the `fx` CLI on `PATH` (no peer dependency) |
| `ScriptWorkflowAgent` | `quickjs-emscripten-core@">=0.32.0 <0.33.0"` and `@jitl/quickjs-wasmfile-release-sync@">=0.32.0 <0.33.0"` |

Import only the documented subpaths: `adk-llm-bridge` (providers),
`adk-llm-bridge/agents` (external agents),
`adk-llm-bridge/agents/session-store/sqlite` (Claude session store),
`adk-llm-bridge/workflows`
(workflows), `adk-llm-bridge/workflows/node` (Node host adapters),
`adk-llm-bridge/workflows/spec` (experimental run spec, needs zod >= 4),
`adk-llm-bridge/workflows/checkpoint/sqlite` (SQLite checkpoint store, needs
`node:sqlite`), `adk-llm-bridge/workflows/events/sqlite` (SQLite event
exporter, needs `node:sqlite`),
`adk-llm-bridge/workflows/storage/conformance` (conformance suite for storage
providers) and `adk-llm-bridge/package.json`. Files under `dist/` are build output, and their
names change between releases.

**Licenses of the optional SDKs.** `ClaudeAgent` with its default driver
(`ClaudeAgentSdkDriver`) loads `@anthropic-ai/claude-agent-sdk` at run time.
That package is not open source: it is © Anthropic PBC, all rights reserved,
and its use is governed by Anthropic's legal agreements (see the package's
`LICENSE.md`). adk-llm-bridge does not bundle or redistribute it. Install it
only if you accept its terms; `ClaudeCliDriver` does not need it.
`@openai/codex-sdk` (Codex SDK driver) is Apache-2.0. Both are optional peers:
the package imports and runs without them.

## Quick start

```typescript
import { InMemoryRunner, LlmAgent } from "@google/adk";
import { AIGateway } from "adk-llm-bridge";

const agent = new LlmAgent({
  name: "assistant",
  model: AIGateway("anthropic/claude-sonnet-5.5"), // reads AI_GATEWAY_API_KEY
  instruction: "You are a helpful assistant.",
});

const runner = new InMemoryRunner({ agent, appName: "quickstart" });
const session = await runner.sessionService.createSession({
  appName: "quickstart",
  userId: "user",
});

for await (const event of runner.runAsync({
  userId: "user",
  sessionId: session.id,
  newMessage: { role: "user", parts: [{ text: "Hello!" }] },
})) {
  for (const part of event.content?.parts ?? []) {
    if (part.text) process.stdout.write(part.text);
  }
}
```

A string `instruction` is an ADK template: `{name}` is replaced from session
state, and a missing key throws "Context variable not found: `name`". Put
untrusted text (files, diffs, user input) in the message, or pass an
instruction function (`instruction: () => text`) so no templating happens.

A factory such as `AIGateway(...)` returns a model instance, so no
registration is needed. To use string model names instead, register the
provider class with ADK's registry from your own `@google/adk` import:

```typescript
import { LLMRegistry, LlmAgent } from "@google/adk";
import { AnthropicLlm } from "adk-llm-bridge";

LLMRegistry.register(AnthropicLlm); // claims model names that match claude-*

const agent = new LlmAgent({ name: "assistant", model: "claude-sonnet-5-5" });
```

## Providers

| Provider | Factory | Environment variables | Notes |
|---|---|---|---|
| [Vercel AI Gateway](https://vercel.com/ai-gateway) | `AIGateway(model, options?)` | `AI_GATEWAY_API_KEY`, `AI_GATEWAY_URL` | Model ids are `vendor/model`. Reads only `AI_GATEWAY_API_KEY` / `AI_GATEWAY_URL`; an OpenAI key is never sent to the gateway. |
| [OpenRouter](https://openrouter.ai/) | `OpenRouter(model, options?)` | `OPENROUTER_API_KEY`, `OPENROUTER_SITE_URL`, `OPENROUTER_APP_NAME` | `provider` routing preferences; `siteUrl` / `appName` for rankings. |
| [OpenAI](https://openai.com/) | `OpenAI(model, options?)` | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORGANIZATION`, `OPENAI_PROJECT` (the SDK's `OPENAI_ORG_ID` / `OPENAI_PROJECT_ID` also work) | Registry patterns `gpt-*`, `o<n>*`, `chatgpt-*`. `maxOutputTokens` is sent as `max_completion_tokens`. Other providers never send the OpenAI organization or project headers. |
| [Anthropic](https://www.anthropic.com/) | `Anthropic(model, options?)` | `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` | Native Anthropic SDK, not OpenAI-compatible. `maxTokens` defaults to 4096. |
| [xAI](https://x.ai/) | `XAI(model, options?)` | `XAI_API_KEY` | Registry pattern `grok-*`. |
| Custom (OpenAI-compatible) | `Custom(model, options?)`, `registerCustomProvider(name, config)` | `CUSTOM_LLM_BASE_URL`, `CUSTOM_LLM_API_KEY` | No default URL: set `baseURL` or `CUSTOM_LLM_BASE_URL`. The API key may be empty for local servers. `CUSTOM_LLM_API_KEY` is used only with `CUSTOM_LLM_BASE_URL`; with an explicit `baseURL`, pass `apiKey`. |
| Local (LM Studio, Ollama, vLLM) | `Custom(model, { baseURL })` | as Custom | LM Studio: `http://localhost:1234/v1`. Ollama: `http://localhost:11434/v1`. |

Configuration resolves in this order: options passed to the factory, then
`setProviderConfig(providerId, config)`, then environment variables, then the
provider default. A value set at a higher level wins even when it is invalid
(an invalid explicit URL fails instead of falling back). API key and base URL
environment values are trimmed, and a blank one counts as unset.

```typescript
import { Anthropic, Custom, OpenRouter, setProviderConfig } from "adk-llm-bridge";

const claude = Anthropic("claude-opus-5-5", { maxTokens: 8192, timeout: 120_000 });

const routed = OpenRouter("anthropic/claude-sonnet-5.5", {
  provider: { order: ["anthropic"], allow_fallbacks: false },
});

const local = Custom("qwen3", { name: "ollama", baseURL: "http://localhost:11434/v1" });

setProviderConfig("ai-gateway", { timeout: 30_000, maxRetries: 4 });
```

Common options: `apiKey`, `baseURL`, `timeout` (ms, default 60000, at most
2147483647), `maxRetries` (default 2) and `errorMode`. `timeout`,
`maxRetries` and Anthropic's `maxTokens` must be integers; anything else
throws ADK's `InputValidationError`. Custom also takes `name`, `headers`,
`queryParams` and `providerOptions` (extra request body fields).

### Named custom providers

`registerCustomProvider` lets an ADK agent resolve a custom model from a
string. Each registration owns an exact list of model ids:

```typescript
import { LlmAgent } from "@google/adk";
import { registerCustomProvider } from "adk-llm-bridge";

registerCustomProvider("ollama", {
  baseURL: "http://localhost:11434/v1",
  models: ["llama3", "qwen2.5:1.5b"],
});

const agent = new LlmAgent({ name: "local", model: "ollama/llama3" });
```

Register named custom providers before AI Gateway or OpenRouter: ADK uses the
first registered match, and both gateways claim every `vendor/model` id. See
[Custom provider configuration](docs/custom-provider-configuration.md).

## Models

Model ids differ per provider path: the direct Anthropic API uses
`claude-opus-5-5`, AI Gateway and OpenRouter use `anthropic/claude-opus-5.5`.
A short selection, verified on 2026-11-09:

| Family | Direct provider | AI Gateway | OpenRouter |
|---|---|---|---|
| Claude (most capable) | `claude-fable-5-1` | `anthropic/claude-fable-5.1` | `anthropic/claude-fable-5.1` |
| Claude (default choice) | `claude-opus-5-5` | `anthropic/claude-opus-5.5` | `anthropic/claude-opus-5.5` |
| Claude (fast) | `claude-sonnet-5-5`, `claude-haiku-5-5` | `anthropic/claude-sonnet-5.5`, `anthropic/claude-haiku-5.5` | `anthropic/claude-sonnet-5.5`, `anthropic/claude-haiku-5.5` |
| GPT (flagship) | `gpt-6-astra`, `gpt-6.1-sol` | `openai/gpt-6-astra`, `openai/gpt-6.1-sol` | `openai/gpt-6-astra`, `openai/gpt-6.1-sol` |
| GPT (fast) | `gpt-6.1-terra`, `gpt-6-luna` | `openai/gpt-6.1-terra`, `openai/gpt-6-luna` | `openai/gpt-6.1-terra`, `openai/gpt-6-luna` |
| Grok | `grok-4.7` | `spacexai/grok-4.7` | `x-ai/grok-4.7` |
| Gemini | - | `google/gemini-4-argon`, `google/gemini-3.8-flash` | `google/gemini-4-argon`, `google/gemini-3.8-flash` |

The full list, with more vendors (DeepSeek, Kimi, GLM, Qwen, Mistral, Meta)
and the sources, is in [docs/models.md](docs/models.md). Gemini models run
natively in ADK; you do not need this package for them.

## Features

What each provider and local runtime supports, and how unsupported fields
degrade, is in the
[OpenAI-compatible feature matrix](docs/openai-compatible-feature-matrix.md).
Local runtimes are tested with the
[runtime conformance fixtures](docs/runtime-conformance.md).

- **Tool calling.** ADK `FunctionTool`s with zod schemas or JSON Schema
  (`parametersJsonSchema`), and forced tool choice through `toolConfig`.
  Tool-call arguments that are not valid JSON (often cut by the output limit)
  end the turn with `finishReason: MALFORMED_FUNCTION_CALL`, so ADK's
  `ReflectAndRetryModelPlugin` can retry it; the tool is never run with `{}`.
- **Streaming.** Token streaming through ADK's streaming mode. A stream that
  ends before its final chunk fails with `INCOMPLETE_STREAM`.
- **Structured output.** `outputSchema`, `responseSchema` and
  `responseJsonSchema`. On Anthropic, integers beyond `Number.MAX_SAFE_INTEGER`
  in structured output and tool-call arguments arrive as strings of their
  exact digits. On OpenAI-compatible providers this holds for tool-call
  arguments only; structured-output text is parsed by ADK, which rounds such
  integers.
- **Reasoning.** ADK `thinkingConfig` and planners map to each provider's
  reasoning options. GPT-5 and later (`gpt-6-astra`, `gpt-6.1-sol`...), the
  o-series and their `ft:` fine-tunes are treated as reasoning models: they
  get `max_completion_tokens`, `thinkingConfig` maps to `reasoning_effort`,
  and `temperature`, `topP`, stop sequences, penalties and logprobs are
  dropped. Grok 4.x reasons on its own; on xAI only `grok-3-mini*` and
  `*-reasoning` models get `reasoning_effort`. Reasoning details
  (OpenAI-compatible) and thought signatures (Anthropic) round-trip across
  turns.
- **Multimodal input.** Image parts (inline data or http(s) URLs) where the
  provider accepts them. Unsupported media is dropped with a logged warning.
- **Sampling.** `temperature`, `topP`, `stopSequences`, `seed` and similar
  generation settings are passed through; settings a reasoning model rejects
  are dropped. `candidateCount` must be omitted or `1` on OpenAI-compatible
  providers.

### Errors

By default (`errorMode: "throw"`) a failed provider call throws a
`ProviderLlmError`. ADK then runs `onModelErrorCallback`, and `RoutedLlm` can
fail over to another model. `afterModelCallback` does not see provider errors
in this mode. Set `errorMode: "response"` per model or with
`setProviderConfig` to get an `LlmResponse` with `errorCode` and
`errorMessage` instead.

| Code | When |
|---|---|
| `API_ERROR_<status>` | The API answered with that HTTP status, for example `API_ERROR_429`. |
| `<PREFIX>_ERROR` | Any other failure (network, timeout, unreadable body): `OPENAI_ERROR`, `OPENROUTER_ERROR`, `XAI_ERROR`, `AI_GATEWAY_ERROR`, `ANTHROPIC_ERROR`, or a custom provider's name in upper case. |
| `NO_CHOICE` | An OpenAI-compatible reply had no choices. |
| `INCOMPLETE_STREAM` | A stream ended before its final chunk. Discard the partial text or retry. |
| `MALFORMED_FUNCTION_CALL` | Invalid tool-call arguments. Never thrown: it comes back as a response. |

`error.code` and `error.status` identify the failure, `error.provider` is the
provider id (`openai`, `anthropic`, `custom`...), `error.detail` has the
readable text and `error.cause` the SDK error. `error.message` is JSON,
because ADK parses it to fill the event's `errorCode`. To recover, return an
ADK `Event`, not a bare `LlmResponse`:

```typescript
import { BasePlugin, createEvent } from "@google/adk";
import { ProviderLlmError } from "adk-llm-bridge";

class FallbackPlugin extends BasePlugin {
  override async onModelErrorCallback({ error }: { error: Error }) {
    if (!(error instanceof ProviderLlmError)) return undefined;
    return createEvent({
      content: { role: "model", parts: [{ text: `Model unavailable: ${error.detail}` }] },
    });
  }
}
```

Invalid configuration (a missing API key, an empty model, a bad URL) throws
ADK's `InputValidationError`, with the configured value left out of the
message. Warnings go through ADK's logger (`setLogger`) as
`[adk-llm-bridge] [CODE] ...`.

### Usage and cache tokens

`usageMetadata` reports `promptTokenCount` (including cache-read and
cache-creation tokens), `candidatesTokenCount`, `thoughtsTokenCount`,
`cachedContentTokenCount` and `totalTokenCount`. `thoughtsTokenCount` is set
by OpenAI-compatible providers only. There, `candidatesTokenCount` includes
reasoning tokens, as OpenAI's `completion_tokens` does, and
`thoughtsTokenCount` is that reasoning part: do not add the two.

Tokens written to the prompt cache are in
`customMetadata.cacheCreationTokenCount`. Anthropic models cache by default when
the request can be reused (tools or
earlier turns; see [Prompt caching](./docs/prompt-caching.md)); set
`promptCaching: true` to always cache or `false` to turn it off.

### Telemetry

The bridge needs `@opentelemetry/api` and records nothing until you register
an OpenTelemetry provider. It adds `gen_ai.provider.name`,
`gen_ai.response.model`, `gen_ai.response.id` and `server.address` to ADK's
model span and sets ERROR status on failures. It also emits its own spans:
`call_llm` and `execute_tool <name>` for external agents (see
[Events and spans](#events-and-spans)), and `invoke_workflow` and
`execute_node` for workflows.
The `execute_node` step span carries `gcp.vertex.agent.agent_kind` (`llm`,
`external`, `host` or `workflow`), the same value as `agentKind` on workflow
`step_started` and `step_completed`; `invoke_agent` carries it only for
`ExternalAgent` runs (see
[Which agent ran a step](./docs/workflow-orchestration.md#which-agent-ran-a-step)).

To keep prompts, tool arguments and results out of traces on ADK 2.4, set
both variables:

```bash
OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=NO_CONTENT  # the bridge's spans
ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false                     # ADK's own spans
```

Content capture is on by default. External agent tool spans then export raw
tool inputs and results, for example full file contents from `Read`. These
settings apply to spans, not to session events.
`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` (or `1`) means
`EVENT_ONLY`, as on ADK main: no content on spans. Use `SPAN_ONLY` or
`SPAN_AND_EVENT` to keep it. ADK always exports the agent's `description` as
`gen_ai.agent.description`, so do not put prompt text or secrets there.

## External agents

`adk-llm-bridge/agents` runs a coding-agent runtime as an ADK agent. The
runtime keeps its own login, tools and sandbox; the bridge maps its output to
ADK events and applies the permission policy.

| Agent | Default driver | Other driver | Needs |
|---|---|---|---|
| `ClaudeAgent` | `ClaudeAgentSdkDriver` | `ClaudeCliDriver` | `@anthropic-ai/claude-agent-sdk` |
| `CodexAgent` | `CodexSdkDriver` | `CodexCliDriver` | `@openai/codex-sdk` |
| `GeminiCliAgent` | `GeminiCliDriver` | - | `gemini` CLI |
| `FxAgent` | `FxCliDriver` | - | `fx` CLI |

```typescript
import { LlmAgent } from "@google/adk";
import { AIGateway } from "adk-llm-bridge";
import { ClaudeAgent } from "adk-llm-bridge/agents";

const reviewer = new ClaudeAgent({
  name: "CodeReviewer",
  description: "Reviews code changes for correctness and safety.",
  workingDirectory: process.cwd(),
  permissions: { mode: "read-only", allowNetwork: false, allowedPaths: [process.cwd()] },
  instruction: "Review the change. Do not modify files.",
});

export const rootAgent = new LlmAgent({
  name: "Coordinator",
  model: AIGateway("anthropic/claude-sonnet-5.5"),
  instruction: "Send code review requests to CodeReviewer.",
  subAgents: [reviewer],
});
```

A missing SDK or binary is an error event (`EXTERNAL_AGENT_DEPENDENCY_MISSING`
or `MISSING_BINARY`) that names the install command, not an exception.

### Isolation (Breaking in 0.7.0)

`ClaudeAgent` no longer inherits the host's Claude Code setup. Both Claude
drivers give the agent only the built-in tools in `DEFAULT_CLAUDE_TOOLS`
(Read, Glob, Grep, Edit, Write, NotebookEdit, Bash, WebFetch, WebSearch,
TodoWrite) plus the bridge's own tools: no host MCP servers, settings files,
skills or claude.ai connectors. A tool outside that set is denied and ends the
run with `EXTERNAL_AGENT_ISOLATION_VIOLATED`. To change this:

```typescript
import { ClaudeAgent, DEFAULT_CLAUDE_TOOLS } from "adk-llm-bridge/agents";

const withSubagents = new ClaudeAgent({
  name: "Planner",
  driverOptions: { tools: [...DEFAULT_CLAUDE_TOOLS, "Agent"] }, // the SDK's sub-agent tool
});

const hostSetup = new ClaudeAgent({
  name: "HostClaude",
  driverOptions: { inheritHostConfig: true }, // trusts the host configuration
});
```

The Codex drivers (SDK and CLI), the Gemini CLI driver and the fx driver use
the host's configuration (fx needs `inheritHostConfig: true` to say so); unless
the policy sets `allowNetwork: true`, Codex turns
host MCP servers off. fx has no read-only mode: in `ask` mode it stops at the
first write or shell command unless the user's fx permission rules in
`~/.fx/settings.json` allow it, and `workspace-write` (fx `auto` mode) asks a
reviewer model whose cost is not in `usage`.
See [External agent isolation](docs/external-agent-isolation.md).

### Permissions

`permissions.mode` is `read-only`, `ask`, `workspace-write` or `full-access`,
with optional `allowNetwork` and `allowedPaths`. Each driver maps the policy
to its runtime's sandbox and flags.

- **Inheritance.** An agent's effective policy is the intersection of its own
  and every external agent above it, through ADK Sequential, Parallel and Loop
  agents, transfers, workflow steps and ADK `Workflow` nodes. `allowedPaths`
  intersect by containment on resolved paths (`["/repo"]` and
  `["/repo/src"]` give `["/repo/src"]`). Use absolute or `~` roots: relative
  roots are not passed to delegated agents. ADK `AgentTool` starts a new chain.
- **Confirmations.** In `ask` mode, `confirmation: { approver }` answers
  permission prompts in process, and `confirmation: { adk: true }` uses ADK's
  `adk_request_confirmation` flow and resumes on the next turn. With neither,
  every prompt is denied. A confirmation never widens the policy, and
  `read-only` is never confirmable. A path guard checks file-tool paths
  against `allowedPaths` before any approver sees the request; it does not
  check paths inside shell commands. Under `workspace-write`, Bash also needs
  an approver (`confirmation.approver` or ADK confirmation); without one,
  every Bash call is denied.
- **Path confinement.** With `allowedPaths`, `ClaudeAgentSdkDriver` checks
  every tool call, including edits Claude Code approves without asking and
  searches without a path, and lets Bash write only inside the allowed roots
  (Bash can still read outside them). When a shell tool is on offer, the
  working directory must be inside `allowedPaths` and outside temp
  directories, the shell must be sandboxed, and `inheritHostConfig` must be
  off; otherwise the run is refused with `EXTERNAL_AGENT_PATHS_UNENFORCEABLE`.
  The Claude CLI, Codex, Gemini CLI and fx drivers cannot check paths: they refuse
  `allowedPaths` unless built with `allowUnenforcedPaths: true`.
- **Credentials.** The four agents use `EnvCredentialProvider`: only the
  runtime's allow-listed variables reach it (for Codex, `CODEX_API_KEY`,
  `CODEX_ACCESS_TOKEN`, `CODEX_HOME` and a few others, not
  `OPENAI_API_KEY`; for fx, `AI_GATEWAY_API_KEY` and `VERCEL_OIDC_TOKEN`).
  Without them, the runtime uses its own login.

### Network policy

Network is off unless the policy sets `allowNetwork: true`. An unset
`allowNetwork`, or no `permissions` at all, means `false`: at the root, in
workflow steps, in delegated agents and in a driver run directly. Under an
`ExternalAgent` ancestor (directly, or through a delegation by
`AgentInvocationGateway`), the ancestor's policy is a ceiling: a child keeps
network only when both set `true`. A root `WorkflowAgent` applies no ceiling,
so a step with `allowNetwork: true` keeps network and a step without it has
none. The workflow agent factory (`ExternalAgentWorkflowFactory`) refuses
`allowNetwork: true` unless the host allows it. See
[External agent isolation](docs/external-agent-isolation.md). Without
`allowNetwork: true`:

| Driver | Enforcement |
|---|---|
| Claude (SDK and CLI) | Bash runs in the Claude Code sandbox with every host denied; web tools are removed from the default tool list, and naming them in `tools` refuses the run with `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE`. Where the sandbox cannot run (Windows, Linux without bubblewrap) the run fails, unless the driver has `allowUnsandboxedShell: true`. |
| Codex (SDK and CLI) | No-network sandbox, web search off and host MCP servers turned off for the run. Refused with `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE` in `full-access` mode, when the MCP server listing fails, for a server name that cannot be overridden, and for a prebuilt `sdk` client, unless `allowUnenforcedNetwork: true`. |
| Gemini CLI | Cannot be enforced: every run without `allowNetwork: true` is refused with `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE` (set `allowNetwork: true`, or build the driver with `allowUnenforcedNetwork: true`). |
| fx | Cannot be enforced: fx has no sandbox and no network block, so every run without `allowNetwork: true` is refused with `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE` (set `allowNetwork: true`, or build the driver with `allowUnenforcedNetwork: true`). |

A `read-only` agent with `allowNetwork: true` can read the web: its web tools
run without a confirmation, while write, shell and foreign MCP tools stay
denied. Use it for a research agent that must check documentation. Read-only
does not stop data leaving: the agent can send what it reads to any host
through the web tools, without an approver. Turn the network on only for
agents whose inputs you trust, or keep `ask` mode so web calls go to an
approver.

### Delegation

An external agent with `subAgents` coordinates them through a bridge tool that
runs the sub-agent in the same ADK session; only the Claude Agent SDK driver
exposes it. On the ADK timeline a delegation always looks like a native
`transfer_to_agent` call (`{ agent_name }`), followed by the sub-agent's
events. With the default `delegation: { finalAnswer: "subagent" }` the
sub-agent's answer is final; `finalAnswer: "coordinator"` lets the
coordinator write the final answer (fan-out, aggregation).

### ADK tools

ADK tools given to an external agent (`tools`; hosted by the Claude Agent SDK
driver) go through the same tool callbacks as in an `LlmAgent`: your Runner
plugins' `beforeToolCallback`, `afterToolCallback` and `onToolErrorCallback`,
then the agent's own `beforeToolCallback` and `afterToolCallback`. Guardrail,
redaction and audit plugins therefore cover these tools, and a callback that
throws blocks the call.

- **Long-running tools.** A `LongRunningFunctionTool` that returns no result
  pauses the turn, as in ADK: the call is emitted with its id in
  `longRunningToolIds`, and a `WorkflowAgent` step waits on it. A later
  `functionResponse` with the same id resumes the agent; the runtime gets the
  result as a tool result in its user message, never in its system prompt.
  Only the results the agent accepted reach the runtime. A result over 64 KiB
  (UTF-8 bytes of its JSON), or over 256 KiB in one turn, ends the turn with
  `EXTERNAL_AGENT_TOOL_RESULT_TOO_LARGE` before the runtime starts.
- **Approved calls.** With `confirmation: { adk: true }`, an approved call the
  runtime does not make again on the answer turn ends the turn with an
  `EXTERNAL_AGENT_CONFIRMATION_UNUSED` error, so an approved side effect never
  goes missing silently.
- **Credentials.** `toolContext.requestCredential()` is not supported: the
  turn ends with `EXTERNAL_AGENT_TOOL_CREDENTIAL_REQUIRED`. Give such tools
  their credentials up front.

### Persisting Claude sessions (experimental)

Pass `driverOptions: { sessionStore }` to `ClaudeAgent` to mirror every Claude
Agent SDK session to durable storage and resume from it. `SqliteSessionStore`
keeps transcripts in a SQLite file through the built-in `node:sqlite` (Node
22.13+ or Bun; no extra dependency):

```typescript
import { ClaudeAgent } from "adk-llm-bridge/agents";
import { SqliteSessionStore } from "adk-llm-bridge/agents/session-store/sqlite";

const agent = new ClaudeAgent({
  name: "coder",
  workingDirectory: process.cwd(),
  driverOptions: { sessionStore: new SqliteSessionStore({ path: "./data/claude-sessions.db" }) },
});
```

A resume finds a session only from the same working directory.
`ClaudeCliDriver` refuses the option with `EXTERNAL_AGENT_OPTION_UNSUPPORTED`.
It follows the SDK's `@alpha` session store contract. See
[Persisting Claude sessions](docs/claude-session-store.md).

### Events and spans

- `ExternalAgentStartedEvent.model` and `ExternalAgentCompletedEvent`
  (`model`, `usage`, `numTurns`, `durationMs`) report the run. The run's final
  text event carries `usageMetadata`. Claude reports session-cumulative usage
  and cost on a resumed session. The Agent SDK driver subtracts the previous
  result of a session it ran itself, so repeated runs on one driver report
  per-run usage and cost, marked `usage.scope: "run"`. When the driver has no
  baseline it reports the session total, marked `scope: "session"` (also in
  the final event's `customMetadata.externalAgentUsageScope`). That happens on
  the first run of a session resumed from outside that driver instance
  (restart, another replica, `resumeSessionId`, `runtimeSession.id`) and on a
  `forkSession` run. Do not add `"session"` values to earlier runs.
- With the Claude Agent SDK and Codex drivers, the runtime's own tool calls
  (Read, Edit, Bash, Codex commands...) appear as function call and response
  events with `customMetadata.builtin: true`.
- Spans: `invoke_agent` per run (tokens, cost, turns), `call_llm` per model
  step, `execute_tool <name>` per tool call, and one
  `execute_tool transfer_to_agent` span around each delegation.
- Error codes are provider neutral (`AUTH_ERROR`, `RATE_LIMIT`,
  `QUOTA_EXHAUSTED`...). `normalizeRecoverableErrorCode()` maps codes from
  earlier versions. The tables are in
  [External agent isolation](docs/external-agent-isolation.md#error-codes).

## Workflows

`adk-llm-bridge/workflows` adds workflows that are ADK `BaseAgent`s. A step
runs one of the workflow's sub-agents (an `LlmAgent`, `ClaudeAgent`,
`CodexAgent`...) and its result is checkpointed.

```typescript
import { LlmAgent } from "@google/adk";
import { AIGateway } from "adk-llm-bridge";
import { defineWorkflow, WorkflowAgent } from "adk-llm-bridge/workflows";

const planner = new LlmAgent({
  name: "Planner",
  model: AIGateway("anthropic/claude-opus-5.5"),
  instruction: "Write a short implementation plan.",
});
const reviewer = new LlmAgent({
  name: "Reviewer",
  model: AIGateway("openai/gpt-6.1-terra"),
  instruction: "Review the plan and list risks.",
});

export const workflow = new WorkflowAgent({
  name: "PlanAndReview",
  subAgents: [planner, reviewer],
  definition: defineWorkflow({
    id: "plan-and-review",
    version: "1",
    handler: async (ctx) => {
      const plan = await ctx.run({ id: "plan", agentName: "Planner", input: ctx.input });
      const review = await ctx.run({ id: "review", agentName: "Reviewer", input: plan.output });
      return review.output;
    },
  }),
});
```

- **Steps.** `ctx.run(...)` runs one step; `ctx.parallel(steps, options)`
  runs several with bounded concurrency, ordered results and `fail-fast` or
  `all-settled` behavior. Step ids are durable identities: keep them stable.
- **Checkpoints.** By default checkpoints go to the ADK session (`stateDelta`).
  Finished steps replay without calling their agent again, and a changed
  input, version, step or script is rejected instead of replaying stale work.
  For several processes on one host, use `FileSystemWorkflowCheckpointStore`
  and `FileSystemWorkspaceAdapter`; any `WorkflowCheckpointStore` can be
  injected. Set `resolveExecutionId` to resume across turns after a crash or a
  failed step. See [Workflow durability](docs/workflow-durability.md).
- **Human in the loop.** A step whose agent stops on an ADK interrupt (a tool
  confirmation, `adk_request_input`, a long-running tool call) is saved as
  `waiting`, and the run ends with `step_waiting` and `workflow_waiting`
  events. The next turn that answers the request resumes the step exactly
  once. Handlers must not catch `WorkflowInterruptedError`.
- **Script workflows.** `ScriptWorkflowAgent` runs a synchronous generator
  script (`yield ctx.run(...)`) in a fresh QuickJS VM with a time budget,
  memory and step limits, no imports and no host globals. Use it for
  sequences supplied at runtime. The budget is not a hard bound on the host
  thread ([Time bound](docs/workflow-orchestration.md#time-bound)). It needs
  the optional QuickJS peers.
- **Control plane.** `WorkflowControlPlane.dispatch()` takes one versioned
  JSON request to start, observe, answer and cancel executions, spawn tasks,
  exchange messages and validate artifacts, for an MCP tool or HTTP route.
  Artifacts are keyed by execution: the same artifact id in two executions
  names two artifacts, and `artifact.get` / `artifact.list` take the
  `executionId`.
  Without `trustedHostMode`, every operation needs a host-authenticated
  `WorkflowActorContext` and fails with `WORKFLOW_CONTROL_UNAUTHORIZED`
  otherwise. See [Workflow control plane](docs/workflow-control-plane.md) and
  [Multi-agent orchestration](docs/workflow-orchestration.md).
- **ADK `Workflow`.** Workflow agents can be nodes of ADK's `Workflow`
  (`edges`, `ctx.runNode`); `timeout`, `retryConfig`, `rerunOnResume`,
  `inputSchema`, `outputSchema`, `stateSchema` and `isolationScope` are
  forwarded. ADK's `Workflow` is still experimental; these workflows add the
  durable layer. See
  [Workflows and ADK's `Workflow`](docs/workflow-adk-interop.md).

## Upgrading from 0.5.x or 0.6.0

0.7.0 is the first npm release after 0.5.3; 0.6.0 was published on GitHub
only. The main breaking changes:

- Node.js `>=22`; `@google/adk` `>=2.4.0 <3`; `@google/genai` and
  `@opentelemetry/api` are required peers; zod 3 is no longer supported.
- Providers throw `ProviderLlmError` by default. Move error handling from
  `afterModelCallback` to `onModelErrorCallback`, or set
  `errorMode: "response"`.
- Invalid tool-call arguments give `MALFORMED_FUNCTION_CALL`, cut streams give
  `INCOMPLETE_STREAM`, `candidateCount` other than `1` is rejected, and
  invalid options throw `InputValidationError`.
- Anthropic `promptTokenCount` includes cache tokens.
- Warnings use ADK's logger instead of `console.warn`.
- External agents: Claude agents are isolated from the host setup, network
  is off unless the policy sets `allowNetwork: true` (an unset value means
  `false`, and a delegated agent keeps network only when parent and child
  both set `true`), a child never runs wider than its parent, the
  sub-agent's answer is final after a delegation, and error codes are
  provider neutral.

Step-by-step instructions are in the
[migration guide](docs/migration-0.7.md), and every change is in the
[CHANGELOG](CHANGELOG.md).

## Examples

Run each example from its own folder (Bun loads `.env` from the current
directory). See [examples/README.md](examples/README.md).

| Example | Shows |
|---|---|
| [basic-agent-ai-gateway](examples/basic-agent-ai-gateway) | Multi-agent help desk on AI Gateway |
| [basic-agent-openrouter](examples/basic-agent-openrouter) | The same on OpenRouter |
| [basic-agent-openai](examples/basic-agent-openai) | The same on OpenAI |
| [basic-agent-anthropic](examples/basic-agent-anthropic) | The same on Anthropic |
| [basic-agent-xai](examples/basic-agent-xai) | The same on xAI |
| [basic-agent-lmstudio](examples/basic-agent-lmstudio) | The same on a local LM Studio server |
| [native-features](examples/native-features) | Sampling, reasoning, structured output, multimodal input, tool choice and streaming |
| [express-server](examples/express-server) | HTTP API with sessions, tools, state and streaming |
| [basic-agent-claude](examples/basic-agent-claude) | Claude Code as an ADK agent |
| [basic-agent-codex](examples/basic-agent-codex) | Codex as an ADK agent |
| [basic-agent-gemini](examples/basic-agent-gemini) | Gemini CLI as an ADK agent |
| [external-agents](examples/external-agents) | A Claude coordinator with Codex and LLM sub-agents |
| [codex-workflow](examples/codex-workflow) | Planner, implementer and reviewer script workflow with Codex agents |

## Documentation

- [Migrating to 0.7.0](docs/migration-0.7.md)
- [Models](docs/models.md)
- [Custom provider configuration](docs/custom-provider-configuration.md)
- [OpenAI-compatible feature matrix](docs/openai-compatible-feature-matrix.md)
- [Runtime conformance](docs/runtime-conformance.md)
- [External agent isolation](docs/external-agent-isolation.md)
- [Persisting Claude sessions](docs/claude-session-store.md)
- [Multi-agent workflow orchestration](docs/workflow-orchestration.md)
- [Workflow control plane](docs/workflow-control-plane.md)
- [Workflow durability](docs/workflow-durability.md)
- [Choosing storage providers](docs/storage-providers.md)
- [Workflows and ADK's `Workflow`](docs/workflow-adk-interop.md)

All documents, including the [glossary](docs/glossary.md), are listed in
[docs/README.md](docs/README.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and checks. Report security
issues as described in [SECURITY.md](SECURITY.md). This project follows a
[Code of Conduct](CODE_OF_CONDUCT.md).

## License

MIT. Copyright (c) 2025-present adk-llm-bridge contributors. See [LICENSE](LICENSE).
