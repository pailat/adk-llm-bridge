# External Agents Example

This example shows the **opt-in** external agent runtime API with a `ClaudeAgent` as the root ADK agent:

```ts
import { ClaudeAgent, CodexAgent, GeminiCliAgent } from "adk-llm-bridge/agents";
```

The root package import remains focused on LLM providers for other examples:

```ts
import { AIGateway } from "adk-llm-bridge";
```

## What this example demonstrates

- Running `ClaudeAgent` as the `rootAgent`
- Using the official Claude Agent SDK TypeScript driver by default
- Using `EnvCredentialProvider` only as a pass-through for provider-allowlisted environment variables
- Selecting permission presets such as `read-only`, `ask`, and `workspace-write`
- Keeping external runtime APIs opt-in through the `adk-llm-bridge/agents` subpath

## Quick Start

First make sure Claude Code is authenticated. The SDK can use its bundled native Claude Code binary, and it can also use your existing Claude Code login/OAuth credentials.

If needed, authenticate with your local Claude Code install first:

```bash
claude --version
# If needed, run Claude Code's native login/auth flow first.
```

Then run the example:

```bash
cd examples/external-agents
cp .env.example .env
# Optional: edit .env only if you want env-based auth instead of native Claude login.
bun install
bun run web
```

You can also type-check the example directly:

```bash
bun run typecheck
```

> Note: in this repository, `package.json` uses `"adk-llm-bridge": "file:../.."` so the example validates against the local checkout that contains the `/agents` subpath. The example `tsconfig.json` also maps `adk-llm-bridge`, `adk-llm-bridge/agents`, and `@google/adk` for local type-checking, avoiding duplicate nominal ADK symbols while using a file dependency. If you copy this example into another project, replace the local file dependency with a published `adk-llm-bridge` version that includes `/agents` and remove the local `paths` override if it is no longer needed.

## Runtime setup

The exported `rootAgent` is a `ClaudeAgent`, so normal chat in ADK DevTools is handled by Claude Code through the official `@anthropic-ai/claude-agent-sdk` TypeScript path.

The file also constructs specialist agents to demonstrate the import/configuration shape:

- `CodexAgent` for Codex CLI-style implementation work
- `GeminiCliAgent` for Gemini CLI-style codebase exploration

The bridge does **not** install provider CLIs or persist provider secrets for you. Install and authenticate each runtime using its native documentation when you want that runtime to execute real work.

### Claude native / OAuth auth

For local usage, Claude Code can use the credentials already configured on your machine. The SDK driver passes the minimal native-auth environment (`HOME`, `PATH`, `USER`, `SHELL`, `CLAUDE_CONFIG_DIR`, and `XDG_CONFIG_HOME`) so Claude can find its native config/cache.

You can also pass allowlisted env credentials when needed. Common variables are listed in [.env.example](./.env.example), including:

- Claude: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`
- Codex / OpenAI-compatible: `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_HOME`
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

Claude Agent SDK execution is side-effectful and uses the permissions configured on the `ClaudeAgent`; this example defaults to `ask` mode and limits allowed paths to the current working directory.

If you need an explicit CLI fallback instead of the SDK driver, pass `new ClaudeCliDriver()` manually:

```ts
import { ClaudeAgent, ClaudeCliDriver } from "adk-llm-bridge/agents";

export const rootAgent = new ClaudeAgent({
  name: "ClaudeCodeRoot",
  driver: new ClaudeCliDriver(),
});
```
