# External Agents Example

This example shows the **opt-in** external agent runtime API:

```ts
import { CodexAgent, ClaudeAgent, GeminiCliAgent } from "adk-llm-bridge/agents";
```

The root package import remains focused on LLM providers:

```ts
import { AIGateway } from "adk-llm-bridge";
```

## What this example demonstrates

- Adding external runtime agents as ADK `subAgents`
- Using `EnvCredentialProvider` to pass only provider-allowlisted environment variables
- Selecting permission presets such as `read-only`, `ask`, and `workspace-write`
- Keeping provider-specific authentication owned by each native runtime/CLI
- Keeping external runtime APIs opt-in through the `adk-llm-bridge/agents` subpath

## Quick Start

```bash
cd examples/external-agents
cp .env.example .env
# Edit .env with at least AI_GATEWAY_API_KEY for the coordinator model
bun install
bun run web
```

You can also type-check the example directly:

```bash
bun run typecheck
```

> Note: in this repository, `package.json` uses `"adk-llm-bridge": "file:../.."` so the example validates against the local checkout that contains the `/agents` subpath. The example `tsconfig.json` also maps `adk-llm-bridge`, `adk-llm-bridge/agents`, and `@google/adk` for local type-checking, avoiding duplicate nominal ADK symbols while using a file dependency. If you copy this example into another project, replace the local file dependency with a published `adk-llm-bridge` version that includes `/agents` and remove the local `paths` override if it is no longer needed.

## Runtime setup

This example coordinates three external runtime agents:

- `CodexAgent` for Codex CLI-style implementation work
- `ClaudeAgent` for Claude Code / Claude Agent SDK-style review work
- `GeminiCliAgent` for Gemini CLI-style codebase exploration

The bridge does **not** install provider CLIs or persist provider secrets for you. Install and authenticate each runtime using its native documentation when you want that runtime to execute real work.

### Coordinator LLM

The root `LlmAgent` uses:

```ts
AIGateway("anthropic/claude-sonnet-4")
```

Set `AI_GATEWAY_API_KEY` in `.env` for the coordinator.

### External runtime credentials

External runtimes own their normal auth flows. You can rely on native CLI login/cache for local use, or provide environment variables that `EnvCredentialProvider` passes through only when allowlisted by the provider definition.

Common variables are listed in [.env.example](./.env.example), including:

- Codex / OpenAI-compatible: `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_HOME`
- Claude: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`
- Gemini: `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS`

## Important runtime note

The `/agents` API is intentionally separate from the root LLM provider API. Normal LLM usage remains under:

```ts
import { AIGateway, OpenRouter, OpenAI } from "adk-llm-bridge";
```

External runtime usage is opt-in:

```ts
import { CodexAgent, ClaudeAgent, GeminiCliAgent } from "adk-llm-bridge/agents";
```

If a concrete runtime driver is unavailable or not configured, the agent should fail as a recoverable runtime configuration error rather than silently running with broad permissions.
