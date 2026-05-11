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
- Exposing ADK `subAgents` to Claude Agent SDK through the in-process MCP `run_adk_subagent` bridge tool
- Using the official `@openai/codex-sdk` TypeScript driver for `CodexAgent` by default, with `CodexCliDriver` available as an explicit fallback
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
# If Bun reports blocked postinstalls, set CLAUDE_CODE_EXECUTABLE to your local claude path.
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

The file also constructs specialist agents and registers them as ADK subagents:

- `CodexAgent` for Codex CLI-style implementation work
- `GeminiCliAgent` for Gemini CLI-style codebase exploration

When `ClaudeAgent` runs through the SDK driver, those ADK subagents are exposed to Claude through an in-process MCP tool named `run_adk_subagent`. You can ask Claude to delegate explicitly, for example:

```txt
Ask CodexImplementer to inspect this repository and propose a minimal patch for the failing test.
```

`CodexAgent` uses `@openai/codex-sdk` by default. The SDK still controls the local Codex runtime and reuses Codex native authentication/configuration. Use `codex login` for local ChatGPT-managed auth or provide `CODEX_API_KEY` for API-key automation. If you need the lower-level CLI fallback, pass `new CodexCliDriver()` explicitly.

The bridge does **not** persist provider secrets for you. Install and authenticate each runtime using its native documentation when you want that runtime to execute real work.

### Claude native / OAuth auth

For local usage, Claude Code can use the credentials already configured on your machine. The SDK driver passes the minimal native-auth environment (`HOME`, `PATH`, `USER`, `SHELL`, `CLAUDE_CONFIG_DIR`, and `XDG_CONFIG_HOME`) so Claude can find its native config/cache.

If your package manager blocks the SDK's native binary postinstall, set `CLAUDE_CODE_EXECUTABLE` in `.env` to an existing Claude Code executable, for example `/Users/you/.local/bin/claude`.

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

If you need an explicit Claude CLI fallback instead of the SDK driver, pass `new ClaudeCliDriver()` manually:

```ts
import { ClaudeAgent, ClaudeCliDriver } from "adk-llm-bridge/agents";

export const rootAgent = new ClaudeAgent({
  name: "ClaudeCodeRoot",
  driver: new ClaudeCliDriver(),
});
```

For Codex, the equivalent fallback is:

```ts
import { CodexAgent, CodexCliDriver } from "adk-llm-bridge/agents";

const codexImplementer = new CodexAgent({
  name: "CodexImplementer",
  driver: new CodexCliDriver(),
});
```
