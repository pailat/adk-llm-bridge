# External Agents Example

This example shows the **opt-in** external agent runtime API with Claude Code as the root ADK agent and Codex as the only subagent:

```ts
import { ClaudeAgent, CodexAgent } from "adk-llm-bridge/agents";
```

The root package import remains focused on LLM providers for other examples:

```ts
import { AIGateway } from "adk-llm-bridge";
```

## What this example demonstrates

- Running `ClaudeAgent` as the `rootAgent`
- Using the official Claude Agent SDK driver by default
- Using the official `@openai/codex-sdk` driver for `CodexAgent` by default
- Using `EnvCredentialProvider` only as a pass-through for provider-allowlisted environment variables
- Selecting permission presets such as `ask` and `workspace-write`
- Exposing `CodexImplementer` to Claude Agent SDK through the in-process MCP `run_adk_subagent` bridge tool
- Keeping external runtime APIs opt-in through the `adk-llm-bridge/agents` subpath

## Quick Start

First make sure Claude Code and Codex are authenticated with their native tooling.

```bash
claude --version
codex --version
# If needed, run each runtime's native login/auth flow first.
```

Then run the example:

```bash
cd examples/external-agents
cp .env.example .env
# Optional: edit .env only if you want env-based auth instead of native runtime auth.
# If Bun reports blocked Claude SDK postinstalls, set CLAUDE_CODE_EXECUTABLE to your local claude path.
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

The file also constructs one specialist ADK subagent:

- `CodexImplementer` — a `CodexAgent` for scoped repository analysis and implementation work

When `ClaudeAgent` runs through the SDK driver, `CodexImplementer` is exposed to Claude through an in-process MCP tool named `run_adk_subagent`. For smoke tests, make the delegation explicit:

```txt
Use run_adk_subagent to delegate to CodexImplementer. Ask it to analyze src/agents and explain in 5 bullets how the Agent Runtime Bridge is implemented. Do not modify files.
```

`CodexAgent` uses `@openai/codex-sdk` by default. The SDK controls the local Codex runtime and reuses Codex native authentication/configuration. Use `codex login` for local auth or provide `CODEX_API_KEY` for API-key automation. If you need the lower-level CLI fallback, pass `new CodexCliDriver()` explicitly.

The bridge does **not** persist provider secrets for you. Install and authenticate each runtime using its native documentation when you want that runtime to execute real work.

### Claude native / OAuth auth

For local usage, Claude Code can use the credentials already configured on your machine. The SDK driver passes the minimal native-auth environment (`HOME`, `PATH`, `USER`, `SHELL`, `CLAUDE_CONFIG_DIR`, and `XDG_CONFIG_HOME`) so Claude can find its native config/cache.

If your package manager blocks the SDK's native binary postinstall, set `CLAUDE_CODE_EXECUTABLE` in `.env` to an existing Claude Code executable, for example `/Users/you/.local/bin/claude`. If this variable is unset, the example uses the Claude Agent SDK default driver setup.

You can also pass allowlisted env credentials when needed. Common variables are listed in [.env.example](./.env.example), including:

- Claude: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`
- Codex: `CODEX_API_KEY`, `CODEX_HOME`

## Important runtime note

The `/agents` API is intentionally separate from the root LLM provider API. Normal LLM usage remains under:

```ts
import { AIGateway, OpenRouter, OpenAI } from "adk-llm-bridge";
```

External runtime usage is opt-in:

```ts
import { CodexAgent, ClaudeAgent } from "adk-llm-bridge/agents";
```

Claude Agent SDK execution is side-effectful and uses the permissions configured on the `ClaudeAgent`; this example defaults to `ask` mode and limits allowed paths to the current working directory. Subagent permissions are inherited conservatively, so `CodexImplementer` cannot expand beyond the root agent restrictions.

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
