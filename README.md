# adk-llm-bridge

[![npm version](https://img.shields.io/npm/v/adk-llm-bridge.svg)](https://www.npmjs.com/package/adk-llm-bridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Use **any LLM** — and now **any coding agent** — with [Google ADK TypeScript](https://github.com/google/adk-js) in just a few lines of code.

> **🆕 New in 0.7.0 — First-class Dynamic Workflows.** Compose ADK agents with trusted TypeScript handlers or bounded QuickJS generator scripts, including checkpoints, replay, retries, cancellation, and parallel steps. [Jump to the workflows guide →](#dynamic-workflows)

## Contents

- [Why?](#why)
- [Supported Providers](#supported-providers)
- [Compatibility and Feature Degradation](#compatibility-and-feature-degradation)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [**External Coding Agents** 🆕](#external-coding-agents)
- [**Dynamic Workflows** 🆕](#dynamic-workflows)
- [Configuration](#configuration)
- [Model Format](#model-format)
- [Features](#features)
- [Errors, Telemetry and Usage](#errors-telemetry-and-usage)
- [API Reference](#api-reference)
- [Examples](#examples)

## Why?

Google ADK TypeScript comes with built-in Gemini support. This bridge extends it to work with **any model** from providers like Anthropic, OpenAI, Meta, and more — and to embed **provider-owned coding agents** (Claude Code, Codex, Gemini CLI) directly in your agent graph — all while keeping ADK features like multi-agent orchestration, tool calling, and streaming.

### Key Benefits

- **Simple** — 3 lines to integrate any model
- **Battle-tested** — Built on the official OpenAI and Anthropic SDKs
- **Compatible** — Works with any OpenAI-compatible API (AI Gateway, OpenRouter, etc.)
- **Agent-ready** 🆕 — Wrap external coding agents as ADK `BaseAgent` sub-agents
- **Workflow-ready** 🆕 — Orchestrate versioned, durable agent workflows as ADK agents

## Supported Providers

| Provider | Models | Features |
|----------|--------|----------|
| **[Vercel AI Gateway](https://vercel.com/ai-gateway)** | 100+ models (Claude, GPT, Llama, Gemini, etc.) | Simple, fast |
| **[OpenRouter](https://openrouter.ai/)** | 100+ models | Provider routing, fallbacks, price optimization |
| **[OpenAI](https://openai.com/)** | GPT-4, o1, o3, etc. | Direct API access |
| **[Anthropic](https://anthropic.com/)** | Claude models | Direct API access |
| **[xAI](https://x.ai/)** | Grok models | Direct API access |
| **Custom (OpenAI-compatible)** | Any model | Ollama, vLLM, Azure OpenAI, LM Studio, etc. |

## Compatibility and Feature Degradation

Provider availability is not the same as feature parity. See the
**[OpenAI-compatible feature degradation and capability matrix](./docs/openai-compatible-feature-matrix.md)**
for the canonical comparison across OpenAI, OpenRouter, xAI, AI Gateway,
Ollama, vLLM, LM Studio, and native Anthropic.

The matrix separates deterministic bridge behavior from runtime/model
capability. It records dropped Gemini-only fields and media, reasoning-model
restrictions, structured-output and tool-choice variation, `candidateCount`,
`providerOptions`, and the unsupported bidirectional `connect()` API. It is
updated with the project's
[conformance fixtures and exact runtime profiles](./docs/runtime-conformance.md);
a fixture pass does not claim support for every model a runtime can serve.

## Coding Agents 🆕

Beyond chat models, you can embed full **coding agents** as ADK `BaseAgent` sub-agents via the `adk-llm-bridge/agents` subpath:

| Agent | Runtime | Import |
|-------|---------|--------|
| **Claude Code** | `@anthropic-ai/claude-agent-sdk` | `ClaudeAgent` |
| **OpenAI Codex** | `@openai/codex-sdk` (or `codex` CLI) | `CodexAgent` |
| **Gemini CLI** | `gemini` CLI | `GeminiCliAgent` |

See [External Coding Agents](#external-coding-agents) for the full guide.

## Installation

```bash
bun add adk-llm-bridge @google/adk
```

```bash
pnpm add adk-llm-bridge @google/adk
```

```bash
npm install adk-llm-bridge @google/adk
```

## Quick Start

```typescript
import { LlmAgent } from '@google/adk';
import { AIGateway } from 'adk-llm-bridge';

const agent = new LlmAgent({
  name: 'assistant',
  model: AIGateway('anthropic/claude-sonnet-4.6'),
  instruction: 'You are a helpful assistant.',
});
```

That's it for core text generation. Tools, streaming, multi-agent orchestration,
and other ADK features remain available where the selected provider/runtime and
model support their mapped wire behavior. Check the
[capability matrix](./docs/openai-compatible-feature-matrix.md) before relying
on structured output, forced tool choice, reasoning, logprobs, or multimodal
input.

### Other Providers

```typescript
import { OpenRouter, OpenAI, Anthropic, XAI, Custom } from 'adk-llm-bridge';

// OpenRouter - 100+ models with routing
model: OpenRouter('anthropic/claude-sonnet-4.6')

// OpenAI - Direct API
model: OpenAI('gpt-4.1')

// Anthropic - Direct API
model: Anthropic('claude-sonnet-4-6')

// xAI - Direct API
model: XAI('grok-4.3')

// Local models (LM Studio, Ollama, etc.)
model: Custom('your-model', { baseURL: 'http://localhost:1234/v1' })
```

See the [examples](./examples) directory for complete implementations.

### Using LLMRegistry (Alternative)

You can also register providers with ADK's LLMRegistry to use string-based model names:

```typescript
import { LlmAgent, LLMRegistry } from '@google/adk';
import { AnthropicLlm } from 'adk-llm-bridge';

LLMRegistry.register(AnthropicLlm);

const agent = new LlmAgent({
  name: 'assistant',
  model: 'claude-sonnet-4-6',  // String-based model name
  instruction: 'You are a helpful assistant.',
});
```

## External Coding Agents

> 🆕 **New in 0.6.0.** Embed provider-owned coding agents — Claude Code, OpenAI Codex, and Gemini CLI — as native ADK sub-agents.

Most bridges stop at chat models. `adk-llm-bridge` also lets an ADK agent graph delegate to **full coding agents** that own their own tools, sandbox, and auth — so a coordinator LLM can hand a task to Claude Code, Codex, or Gemini CLI and get the result back as a normal ADK agent response.

| Agent | Default driver | CLI fallback |
|-------|----------------|--------------|
| `ClaudeAgent` | `@anthropic-ai/claude-agent-sdk` | `ClaudeCliDriver` |
| `CodexAgent` | `@openai/codex-sdk` | `CodexCliDriver` |
| `GeminiCliAgent` | `gemini` CLI | — |

The agents API lives behind an explicit subpath, so the root import stays focused on LLM providers and existing code is unchanged:

```typescript
import { CodexAgent, ClaudeAgent, GeminiCliAgent } from "adk-llm-bridge/agents";
```

The agent layer provides shared configuration, credential, permission, provider-registry, and runtime drivers, while each external runtime keeps ownership of its own auth and sandbox. `CodexAgent` uses the official `@openai/codex-sdk` driver by default; pass `new CodexCliDriver()` explicitly when you need the lower-level CLI fallback.

```typescript
import { LlmAgent } from "@google/adk";
import { AIGateway } from "adk-llm-bridge";
import { ClaudeAgent, EnvCredentialProvider } from "adk-llm-bridge/agents";

const reviewer = new ClaudeAgent({
  name: "CodeReviewer",
  credentialProvider: new EnvCredentialProvider(),
  workingDirectory: process.cwd(),
  permissions: {
    mode: "ask",
    allowNetwork: false,
    allowedPaths: [process.cwd()],
  },
  instruction: "Review this change for correctness and safety.",
});

export const rootAgent = new LlmAgent({
  name: "Coordinator",
  model: AIGateway("anthropic/claude-sonnet-4.6"),
  instruction: "Route code review tasks to the reviewer sub-agent.",
  subAgents: [reviewer],
});
```

### External Agent Auth and Permissions

- **Provider-owned auth** — Codex, Claude Code, Gemini CLI, or a custom runtime should continue to own its normal authentication flow.
- **No default secret persistence** — the default credential provider stores nothing. Use `EnvCredentialProvider` to pass only provider-allowlisted environment variables, or provide your own `ExternalAgentCredentialProvider` for a secret manager.
- **Optional runtime dependencies** — importing `adk-llm-bridge/agents` does not install or execute provider CLIs. Wire a driver/runtime explicitly in applications that need one.
- **Permission presets** — use `read-only`, `ask`, `workspace-write`, or `full-access` policies, plus optional `allowNetwork` and `allowedPaths`, so provider drivers can map ADK intent to provider-specific sandbox flags.
- **Isolated Claude agents** — `ClaudeAgent` with its default Claude Agent SDK driver does not inherit the host's Claude Code setup. The agent gets only the built-in tools in `DEFAULT_CLAUDE_SDK_TOOLS` (Read, Glob, Grep, Edit, Write, NotebookEdit, Bash, WebFetch, WebSearch, TodoWrite) plus the bridge's own tools. Host tools (Task, Skill, cron, worktrees, Workflow, ToolSearch, messaging), MCP servers from other config and claude.ai connectors are off, and bundled skills are hidden from the model. To change this, pass `driver: new ClaudeAgentSdkDriver({ tools: [...DEFAULT_CLAUDE_SDK_TOOLS, "Task"] })` or `driver: new ClaudeAgentSdkDriver({ inheritHostConfig: true })`. `ClaudeCliDriver` is not isolated this way: it still loads the host's tool set.
- **Read-only tool list** — under `read-only`, the Claude Agent SDK driver also removes write and shell tools (Edit, Write, MultiEdit, NotebookEdit, Bash, PowerShell) from the model's tool list. It removes WebFetch and WebSearch unless `allowNetwork: true`; with `allowNetwork: false` they are removed in every mode. Calls to removed tools are still denied if the model tries them.

### Delegation from an external coordinator

An external agent can itself coordinate ADK sub-agents (`subAgents: [...]` on a
`ClaudeAgent`). This works differently from `LlmAgent` transfer, because the
bridge cannot make the external runtime's model call ADK's `transfer_to_agent`
directly:

1. The bridge gives the coordinator an MCP tool,
   `mcp__adk_bridge__run_adk_subagent` (`agentName`, `task`). Among the
   built-in drivers, only the Claude Agent SDK driver exposes it.
2. When the model calls it, the bridge runs the sub-agent through ADK in the
   same session: the sub-agent sees the session state and history, its state
   changes merge back, and its permissions are at most the coordinator's.
3. On the ADK timeline, the call appears as a native `transfer_to_agent`
   function call and response, followed by the sub-agent's own events. In
   traces, each delegation is one `execute_tool transfer_to_agent` span that
   contains the sub-agent's `invoke_agent` span. With
   `nativeDelegationShape: false`, the events are `run_adk_subagent` calls and
   responses instead, and the span is `execute_tool run_adk_subagent → <agent>`.
4. The coordinator's turn keeps running while the sub-agent works, and it gets
   the sub-agent's answer as the tool result. With the default
   `delegation: { finalAnswer: "subagent" }`, the sub-agent's answer is final
   and the coordinator's re-narration is dropped. With
   `finalAnswer: "coordinator"`, the coordinator writes the final answer.

Each tool call runs one sub-agent. Use the events and spans, not the
coordinator's own summary, to see what ran and in what order: a model may
describe sub-agent runs as "in parallel" when the events show they ran one
after another.

### Runnable examples

Each example typechecks and builds without credentials, and prints a clear "set `<KEY>` to run" hint when run without one:

- **[basic-agent-claude](./examples/basic-agent-claude)** — Claude Code as an ADK agent (Claude Agent SDK)
- **[basic-agent-codex](./examples/basic-agent-codex)** — OpenAI Codex as an ADK agent (Codex SDK)
- **[basic-agent-gemini](./examples/basic-agent-gemini)** — Gemini CLI as an ADK agent
- **[external-agents](./examples/external-agents)** — coordinator + external sub-agents (HelpDesk / architecture review)

## Dynamic Workflows

> 🆕 **New in 0.7.0.** A workflow is itself an ADK `BaseAgent`, so it can be used
> anywhere a normal agent can. Its steps may invoke any direct subagent,
> including `CodexAgent`, `ClaudeAgent`, `GeminiCliAgent`, or an ADK `LlmAgent`.

The stable API lives at `adk-llm-bridge/workflows`; the root import remains
focused on model providers.

### Trusted TypeScript workflows

Use `WorkflowAgent` when the workflow is application-owned code:

```typescript
import { defineWorkflow, WorkflowAgent } from "adk-llm-bridge/workflows";

const workflow = new WorkflowAgent({
  name: "ImplementationWorkflow",
  subAgents: [planner, implementer, reviewer],
  definition: defineWorkflow({
    id: "implementation",
    version: "1",
    handler: async (ctx) => {
      const plan = await ctx.run({
        id: "plan",
        agentName: "Planner",
        input: ctx.input,
      });
      const implementation = await ctx.run({
        id: "implement",
        agentName: "Implementer",
        input: plan.output,
      });
      const review = await ctx.run({
        id: "review",
        agentName: "Reviewer",
        input: implementation.output,
      });
      return review.output;
    },
  }),
});
```

`ctx.parallel(steps, options)` adds bounded concurrency with ordered results and
`fail-fast` or `all-settled` behavior. Step IDs are durable identities: keep them
stable across retries and resumes.

### Dynamic script workflows

Use `ScriptWorkflowAgent` when the sequence is supplied dynamically. Scripts
run inside a fresh bounded QuickJS VM and communicate with the host only by
yielding JSON operations:

```typescript
import {
  defineScriptWorkflow,
  ScriptWorkflowAgent,
} from "adk-llm-bridge/workflows";

const workflow = new ScriptWorkflowAgent({
  name: "DynamicWorkflow",
  subAgents: [planner, implementer],
  definition: defineScriptWorkflow({
    id: "dynamic-implementation",
    version: "1",
    source: `
      const plan = yield ctx.run({
        id: "plan",
        agentName: "Planner",
        input: ctx.input
      });
      const result = yield ctx.run({
        id: "implement",
        agentName: "Implementer",
        input: plan.output
      });
      return result.output;
    `,
  }),
});
```

Script bodies are synchronous generators: use `yield ctx.run(...)`,
`yield ctx.parallel(...)`, and `yield ctx.emit(...)`. Imports, host globals, and
async callbacks are unavailable inside the VM. Install the optional sandbox
peers when using script workflows:

```bash
bun add quickjs-emscripten-core @jitl/quickjs-wasmfile-release-sync
```

The host can also opt into per-invocation dynamic agents. The script receives
only secret-free descriptors; agent handles and provider credentials remain on
the host:

```typescript
import { ExternalAgentWorkflowFactory } from "adk-llm-bridge/workflows";

const workflow = new ScriptWorkflowAgent({
  name: "DynamicWorkflow",
  definition,
  createAgentFactory: () =>
    new ExternalAgentWorkflowFactory({
      registry: externalAgentRegistry,
      allowedProviderIds: ["codex"],
      policy: { workingDirectoryRoots: ["/srv/worktrees"] },
    }),
});
```

Guest scripts can then `yield ctx.spawnAgent(request)`,
`yield ctx.listAgents()`, invoke the returned name with `ctx.run`, and
`yield ctx.releaseAgent(name)`. Factories and names are isolated per ADK
invocation; all remaining dynamic handles are released when execution ends.
The returned descriptor includes a deterministic `revision`; pass it as the
step's `agentRevision` to prevent checkpoint or outbox replay after the dynamic
agent configuration changes.

For a JSON or MCP-facing orchestration service, compose
`WorkflowControlPlane` with execution, task/mailbox, artifact, and integration
services. Its single versioned `dispatch({ protocol, version, operation,
payload }, { signal, actor })` entry point
lets an agent start executions, create additional tasks at runtime, wait for
them, exchange long-polled messages, and validate immutable artifacts without
exposing host handles. The actor is a host-authenticated capability, never JSON.
See the **[workflow control-plane guide](./docs/workflow-control-plane.md)** and
**[multi-agent orchestration architecture](./docs/workflow-orchestration.md)**.

Both workflow agents persist checkpoints through ADK session `stateDelta` by
default. Completed steps replay without reinvoking their agents; changed input,
version, step identity, or script source is rejected explicitly. A custom
`WorkflowCheckpointStore` and stable `resolveExecutionId` may be injected for
external durability.

For multiple Node processes on one host, use the dependency-free filesystem
adapters instead of the process-local defaults:

```typescript
import {
  FileSystemWorkflowCheckpointStore,
  FileSystemWorkspaceAdapter,
  WorkflowAgent,
} from "adk-llm-bridge/workflows";

const workflow = new WorkflowAgent({
  name: "DurableImplementationWorkflow",
  subAgents: [planner, implementer, reviewer],
  definition,
  checkpointStore: new FileSystemWorkflowCheckpointStore({
    root: "/var/lib/my-app/workflow-checkpoints",
  }),
  workspace: {
    workspaceId: "repository-main",
    adapter: new FileSystemWorkspaceAdapter({
      stateDirectory: "/var/lib/my-app/workspace-leases",
    }),
  },
});
```

These adapters coordinate cooperating processes on one local filesystem. They
are not distributed database adapters, and workspace fencing tokens must be
enforced by the host that performs external writes. See the
**[workflow durability guide](./docs/workflow-durability.md)** for recovery,
filesystem, and tombstone requirements.

See **[codex-workflow](./examples/codex-workflow)** for a runnable dynamic
planner → implementer → reviewer flow using only Codex agents.

### Using workflows with ADK's `Workflow`

`WorkflowAgent` and `ScriptWorkflowAgent` are `BaseAgent`s, so they can be nodes
of an ADK `Workflow` (`edges` or `ctx.runNode`): their final answer is the node
output, and `timeout`, `inputSchema`, `outputSchema`, `stateSchema` and
`isolationScope` are forwarded to ADK. ADK's `Workflow` is still
`@experimental`; ours is the durable layer (checkpoints, replay checks, leases,
sandboxed scripts), not a replacement. See
**[workflows and ADK's `Workflow`](./docs/workflow-adk-interop.md)** for when to
use each, retries and timeouts of a node, human-in-the-loop steps that wait
for input and resume on the next turn, and caveats.

## Configuration

### Environment Variables

**AI Gateway:**
```bash
AI_GATEWAY_API_KEY=your-api-key
AI_GATEWAY_URL=https://ai-gateway.vercel.sh/v1  # optional
```

**OpenRouter:**
```bash
OPENROUTER_API_KEY=your-api-key
OPENROUTER_SITE_URL=https://your-site.com  # optional, for ranking
OPENROUTER_APP_NAME=Your App Name          # optional, for ranking
```

**Direct Providers:**
```bash
OPENAI_API_KEY=your-openai-key
OPENAI_BASE_URL=https://api.openai.com/v1  # optional
ANTHROPIC_API_KEY=your-anthropic-key
XAI_API_KEY=your-xai-key
```

**Custom OpenAI-compatible endpoints:**
```bash
CUSTOM_LLM_BASE_URL=http://localhost:11434/v1
CUSTOM_LLM_API_KEY=optional-key
```

For Custom and OpenAI endpoint settings, precedence is:

1. explicit constructor or named-registration configuration;
2. global provider configuration, where exposed;
3. environment variables;
4. the provider default.

A defined higher-priority value is authoritative: an invalid explicit URL
fails instead of falling through to an environment value. Custom has no default
URL, so `baseURL` or `CUSTOM_LLM_BASE_URL` is required; its API key may be
omitted for unauthenticated local servers. OpenAI reads `OPENAI_BASE_URL` after
explicit/global configuration and otherwise uses
`https://api.openai.com/v1`. See
[Custom provider configuration](./docs/custom-provider-configuration.md) for
the complete precedence and security behavior.

### Programmatic Configuration

Pass options directly to the factory functions:

```typescript
import { AIGateway, OpenRouter, Anthropic } from 'adk-llm-bridge';

// AI Gateway with custom URL
model: AIGateway('anthropic/claude-sonnet-4.6', {
  apiKey: process.env.MY_API_KEY,
  baseURL: 'https://my-gateway.example.com/v1',
})

// OpenRouter with site info
model: OpenRouter('anthropic/claude-sonnet-4.6', {
  apiKey: process.env.OPENROUTER_API_KEY,
  siteUrl: 'https://your-site.com',
  appName: 'Your App',
})

// Anthropic with custom max tokens
model: Anthropic('claude-sonnet-4-6', {
  apiKey: process.env.ANTHROPIC_API_KEY,
  maxTokens: 8192,
})
```

### Safe Named Custom Providers

Use `registerCustomProvider` only when an ADK agent must resolve a Custom model
from a string. Each registration owns a finite allowlist of exact remote model
IDs; open-ended prefix ownership is intentionally unsupported because ADK's
public registry cannot prove arbitrary regular-expression routes do not
overlap.

```typescript
import { LlmAgent } from "@google/adk";
import { registerCustomProvider } from "adk-llm-bridge";

registerCustomProvider("ollama", {
  baseURL: "http://localhost:11434/v1",
  models: ["llama3", "qwen2.5:1.5b"],
});

const agent = new LlmAgent({
  name: "local-assistant",
  model: "ollama/llama3",
  instruction: "You are helpful.",
});
```

Registration validates every exact route before changing `LLMRegistry`, rejects
reserved or already claimed routes, and captures a deep-copied, fully resolved
endpoint configuration. Register named custom providers **before** broad
AI Gateway or OpenRouter registrations; ADK uses first-match ordering, and a
broad provider registered first makes overlap safety impossible to prove. See
[Custom provider configuration](./docs/custom-provider-configuration.md).

## Model Format

Gateways use the `provider/model` format. Model ids are gateway-specific; these
are from the [Vercel AI Gateway](https://vercel.com/ai-gateway/models) list:

```
anthropic/claude-sonnet-4.6
openai/gpt-5
google/gemini-3-flash
meta/llama-4-maverick
mistral/mistral-large-3
spacexai/grok-4.3
deepseek/deepseek-v3.2
```

### Popular Models

| Provider | AI Gateway ids |
|----------|----------------|
| Anthropic | `anthropic/claude-sonnet-4.6`, `anthropic/claude-opus-4.5` |
| OpenAI | `openai/gpt-5`, `openai/gpt-5-mini`, `openai/o3` |
| Google | `google/gemini-3-flash`, `google/gemini-2.5-pro` |
| Meta | `meta/llama-4-maverick`, `meta/llama-4-scout` |
| Mistral | `mistral/mistral-large-3` |
| xAI | `spacexai/grok-4.3`, `spacexai/grok-4.7` |
| DeepSeek | `deepseek/deepseek-v3.2`, `deepseek/deepseek-r1` |

Other gateways name the same models differently. For example, xAI models are
`spacexai/grok-*` on AI Gateway, `x-ai/grok-*` on OpenRouter, and plain
`grok-*` with the direct `XAI()` provider. Check the gateway's list before
copying an id.

Browse all models:
- [Vercel AI Gateway Models](https://vercel.com/ai-gateway/models)
- [OpenRouter Models](https://openrouter.ai/models)

## Features

- **Text generation** - Simple prompt/response
- **Streaming** - Real-time token streaming
- **Tool calling** - Function calling with automatic conversion
- **Multi-turn** - Full conversation history support
- **Multi-agent** - Sub-agents and agent transfer
- **External coding agents** 🆕 - Claude Code, Codex, and Gemini CLI as ADK sub-agents
- **Usage metadata** - Token counts for monitoring

Feature support is not uniform across runtimes and models. The
[capability matrix](./docs/openai-compatible-feature-matrix.md) is the source of
truth for supported, degraded, provider-dependent, and unsupported behavior.
Notably, OpenAI-compatible requests accept `candidateCount` only when it is
omitted or exactly `1`; use separate requests when multiple independent
candidates are required.

For local servers, consult the
[runtime conformance matrix](./docs/runtime-conformance.md). Deterministic
fixtures run in normal CI, Ollama and vLLM have scheduled exact-version/model
profiles, and LM Studio uses the same runner manually. Conformance results are
fed back into the capability matrix.

## Errors, Telemetry and Usage

### Provider errors

By default (`errorMode: "throw"`), a failed provider call throws a
`ProviderLlmError`. ADK then runs `onModelErrorCallback`, and `RoutedLlm` can
fail over. Note that in this mode `afterModelCallback` does not see provider
errors. Set `errorMode: "response"` (per model or with `setProviderConfig`) to
get the pre-0.7 behavior, an `LlmResponse` with `errorCode`/`errorMessage`.

- `error.code`, `error.status` and `error.provider` identify the failure.
- `error.detail` has the human-readable text. `error.message` is a JSON string
  (`{"error":{"code":...,"message":...}}`) because ADK parses it to fill the
  event's `errorCode`.
- `error.cause` is the original SDK error.

To recover from an error, return an ADK `Event` built with `createEvent`, not a
bare `LlmResponse`. ADK 2.4 reads `actions` from the returned value and fails on
a plain object.

```typescript
import { BasePlugin, createEvent } from '@google/adk';
import { ProviderLlmError } from 'adk-llm-bridge';

class FallbackPlugin extends BasePlugin {
  async onModelErrorCallback({ error }: { error: Error }) {
    if (!(error instanceof ProviderLlmError)) return undefined;
    return createEvent({
      content: { role: 'model', parts: [{ text: `Model unavailable: ${error.detail}` }] },
    });
  }
}
```

### Telemetry

The bridge adds GenAI attributes to ADK's model span and emits its own spans
for external agents and workflows. It needs `@opentelemetry/api` (a peer
dependency) and records nothing until you register an OpenTelemetry provider.

Message content in spans is controlled by two variables:

- `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` controls the bridge's own
  spans. With `NO_CONTENT`, they carry no prompts, tool arguments or results,
  not even in span names.
- `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false` controls ADK's own spans, for
  example the model-call span (`call_llm` in ADK 2.4). On ADK 2.4, the
  `OTEL_...` variable does **not** remove prompts from ADK's spans. When the
  `OTEL_...` variable is not set, the bridge's spans follow this variable too.

To keep all content out of traces on ADK 2.4, set both.

External agents (Claude Code, Codex, Gemini CLI) get their own spans:

- `call_llm` covers one model step, from the start of the step (the run start
  or the last tool result) to the model's first output in it.
- `execute_tool <name>` covers one of the runtime's own tool calls (Read,
  Edit, Bash, Codex commands...), from the call to its result. A delegation is
  one `execute_tool transfer_to_agent` span around the sub-agent's run.
- `gen_ai.request.model` is the configured model (it is left out when none is
  configured) and `gen_ai.response.model` is the model the runtime reports.
- The runtimes report usage per run, not per model call, so the run's tokens,
  cost and turns go on the agent's `invoke_agent` span, and the run's final
  text event carries `usageMetadata`. When the coordinator's own final text is
  dropped after a delegation (`finalAnswer: "subagent"`), its usage is only on
  the span.

The runtime's tool calls also appear as function call and response events
(`customMetadata.builtin: true`). Their results are stored in the session as
they are, for example a `Read` result holds the file content. The capture
variables above apply to spans, not to session events.

With content capture on (the default), the `execute_tool` spans of these
tools export the raw tool inputs and results, including absolute file paths
and full file contents from `Read`. To keep them out of traces, set
`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=NO_CONTENT` and
`ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false`.

### Usage metadata

`usageMetadata` reports `promptTokenCount` (including cached and
cache-creation tokens), `candidatesTokenCount`, `thoughtsTokenCount`,
`cachedContentTokenCount` and `totalTokenCount`.

On OpenAI-compatible providers, `candidatesTokenCount` follows OpenAI's
`completion_tokens` and **includes** reasoning tokens; `thoughtsTokenCount`
reports the reasoning part separately. Gemini models used directly through ADK
exclude thoughts from `candidatesTokenCount`. Do not add the two counts
together on OpenAI-compatible providers, or reasoning tokens are counted twice.

## Tool Calling Example

```typescript
import { FunctionTool, LlmAgent } from '@google/adk';
import { Anthropic } from 'adk-llm-bridge';
import { z } from 'zod';

const getWeather = new FunctionTool({
  name: 'get_weather',
  description: 'Get current weather for a city',
  parameters: z.object({
    city: z.string().describe('City name'),
  }),
  execute: ({ city }) => {
    return { status: 'success', weather: 'sunny', city };
  },
});

const agent = new LlmAgent({
  name: 'weather-assistant',
  model: Anthropic('claude-sonnet-4-6'),
  instruction: 'You help users check the weather.',
  tools: [getWeather],
});
```

## API Reference

### Factory Functions

| Function | Description |
|----------|-------------|
| `AIGateway(model, options?)` | Vercel AI Gateway (100+ models) |
| `OpenRouter(model, options?)` | OpenRouter (100+ models) |
| `OpenAI(model, options?)` | OpenAI direct API |
| `Anthropic(model, options?)` | Anthropic direct API |
| `XAI(model, options?)` | xAI direct API |
| `Custom(model, options)` | Any OpenAI-compatible API |

### Configuration Options

**AIGateway:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | `process.env.AI_GATEWAY_API_KEY` | API key |
| `baseURL` | `string` | `https://ai-gateway.vercel.sh/v1` | Gateway URL |
| `timeout` | `number` | `60000` | Request timeout (ms) |
| `maxRetries` | `number` | `2` | Max retry attempts |

**OpenRouter:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | `process.env.OPENROUTER_API_KEY` | API key |
| `baseURL` | `string` | `https://openrouter.ai/api/v1` | API URL |
| `siteUrl` | `string` | `process.env.OPENROUTER_SITE_URL` | Your site URL (for ranking) |
| `appName` | `string` | `process.env.OPENROUTER_APP_NAME` | Your app name (for ranking) |
| `provider` | `object` | - | Provider routing preferences |
| `timeout` | `number` | `60000` | Request timeout (ms) |
| `maxRetries` | `number` | `2` | Max retry attempts |

**OpenAI:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | `process.env.OPENAI_API_KEY` | API key |
| `organization` | `string` | `process.env.OPENAI_ORGANIZATION` | Organization ID |
| `project` | `string` | `process.env.OPENAI_PROJECT` | Project ID |
| `timeout` | `number` | `60000` | Request timeout (ms) |
| `maxRetries` | `number` | `2` | Max retry attempts |

**Anthropic:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | `process.env.ANTHROPIC_API_KEY` | API key |
| `maxTokens` | `number` | `4096` | Max tokens in response |
| `timeout` | `number` | `60000` | Request timeout (ms) |
| `maxRetries` | `number` | `2` | Max retry attempts |

**XAI:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | `process.env.XAI_API_KEY` | API key |
| `timeout` | `number` | `60000` | Request timeout (ms) |
| `maxRetries` | `number` | `2` | Max retry attempts |

**Custom:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `model` | `string` | - | Model name (required) |
| `baseURL` | `string` | - | API base URL (required) |
| `name` | `string` | `"custom"` | Provider name for logs/errors |
| `apiKey` | `string` | - | API key for authentication |
| `headers` | `Record<string, string>` | - | Additional HTTP headers |
| `queryParams` | `Record<string, string>` | - | Query parameters for all requests |
| `providerOptions` | `Record<string, unknown>` | - | Additional options for request body |
| `timeout` | `number` | `60000` | Request timeout (ms) |
| `maxRetries` | `number` | `2` | Max retry attempts |

## Examples

See the [examples](./examples) directory:

- **[basic-agent-ai-gateway](./examples/basic-agent-ai-gateway)** - Multi-agent HelpDesk with AI Gateway
- **[basic-agent-openrouter](./examples/basic-agent-openrouter)** - Multi-agent HelpDesk with OpenRouter
- **[basic-agent-openai](./examples/basic-agent-openai)** - Multi-agent HelpDesk with OpenAI
- **[basic-agent-anthropic](./examples/basic-agent-anthropic)** - Multi-agent HelpDesk with Anthropic
- **[basic-agent-xai](./examples/basic-agent-xai)** - Multi-agent HelpDesk with xAI
- **[basic-agent-lmstudio](./examples/basic-agent-lmstudio)** - Multi-agent HelpDesk with LM Studio
- **[native-features](./examples/native-features)** - Showcase of native model capabilities (sampling, reasoning, structured output, multimodal, tool_choice, streaming) across all 5 providers
- **[express-server](./examples/express-server)** - Production HTTP API with sessions, streaming, tools

### External coding agents 🆕

- **[basic-agent-claude](./examples/basic-agent-claude)** - Claude Code as an ADK agent (Claude Agent SDK)
- **[basic-agent-codex](./examples/basic-agent-codex)** - OpenAI Codex as an ADK agent (Codex SDK)
- **[basic-agent-gemini](./examples/basic-agent-gemini)** - Gemini CLI as an ADK agent
- **[external-agents](./examples/external-agents)** - Coordinator + external runtime sub-agents

### Dynamic workflows 🆕

- **[codex-workflow](./examples/codex-workflow)** - Dynamic planner → implementer → reviewer workflow using only Codex agents

## Requirements

- Node.js >= 22.0.0. The package is **ESM only**: use `import` (or
  `await import()` from CommonJS). `require("adk-llm-bridge")` fails with
  `ERR_PACKAGE_PATH_NOT_EXPORTED`. This is deliberate: `@google/adk` ships
  separate CommonJS and ESM builds, and loading the bridge through `require`
  would mix the two and break ADK's class identity checks.
- Required peers:
  - `@google/adk` (`>=2.4.0 <3`; tested against 2.4.0)
  - `@google/genai` (`>=2.29.1 <3`). Version 3.x is not supported yet. Most
    package managers install a matching version with ADK; if you add it
    yourself, pin it to the supported range, for example `@google/genai@^2.29.1`.
  - `@opentelemetry/api` (`>=1.9.1 <2`)
- Optional peers:
  - `zod` (`^4`) — only if you use zod schemas (ADK 2.4 requires zod 4)
  - for external coding agents (`adk-llm-bridge/agents`):
    - `@anthropic-ai/claude-agent-sdk` (`>=0.3.319 <0.4`) — for `ClaudeAgent`
    - `@openai/codex-sdk` (`>=0.167.0 <0.168`) — for `CodexAgent`
    - `gemini` CLI on `PATH` — for `GeminiCliAgent`
  - for dynamic script workflows (`ScriptWorkflowAgent`):
    - `quickjs-emscripten-core` (`>=0.32 <0.33`)
    - `@jitl/quickjs-wasmfile-release-sync` (`>=0.32 <0.33`)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

[MIT](LICENSE)
