# External Agents HelpDesk Example

This example mirrors the OpenRouter HelpDesk example, but makes Claude Code the root ADK agent and mixes external runtime subagents with a normal OpenRouter-backed `LlmAgent`.

```txt
ClaudeCodeRoot: ClaudeAgent
  -> CodexBillingSpecialist: CodexAgent
  -> OpenRouterSupportSpecialist: LlmAgent + OpenRouter(...)
```

## What This Demonstrates

- `ClaudeAgent` can be the ADK `rootAgent`.
- `CodexAgent` can be a normal ADK subagent even though it is an external runtime.
- `LlmAgent` using `OpenRouter(...)` from `adk-llm-bridge` can be a subagent of Claude Code.
- Claude Code delegates to both subagents through the runtime MCP bridge tool `run_adk_subagent`.
- `run_adk_subagent` remains bounded RPC semantics: Claude calls a tool, the bridge runs a subagent, then Claude receives the result.
- External runtime APIs stay opt-in through `adk-llm-bridge/agents`, while model providers stay in the root `adk-llm-bridge` import.

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
# Edit .env with OPENROUTER_API_KEY for the OpenRouterSupportSpecialist.
# Env-based Claude/Codex auth is optional when native runtime auth is already configured.
bun install
bun run smoke:helpdesk
bun run web
```

You can also type-check the example directly:

```bash
bun run typecheck
```

## Smoke Tests

Billing smoke delegates from Claude Code to Codex:

```bash
bun run smoke:helpdesk
```

Support smoke delegates from Claude Code to the OpenRouter-backed `LlmAgent`:

```bash
bun run smoke:helpdesk:support
```

Both smoke tests execute the exported `rootAgent` through ADK `Runner` and fail if Claude Code does not call `run_adk_subagent`, if the expected subagent does not emit visible events, or if the bridge does not emit the matching function response.

## Example Prompts

Billing, routed to `CodexBillingSpecialist`:

```txt
Can you check the status of invoice INV-001?
```

```txt
I need to request a refund for invoice INV-002 because I forgot to cancel.
```

Support, routed to `OpenRouterSupportSpecialist`:

```txt
What's the current status of the auth service?
```

```txt
I need to reset my password for user@example.com.
```

For lower-level bridge diagnostics, you can force the tool call explicitly:

```txt
Use run_adk_subagent to delegate to OpenRouterSupportSpecialist. Ask it to check auth status and reset user@example.com.
```

## Runtime Setup

The exported `rootAgent` is a `ClaudeAgent`, so normal chat in ADK DevTools is handled by Claude Code through the official `@anthropic-ai/claude-agent-sdk` TypeScript path.

The example constructs two specialist ADK subagents:

- `CodexBillingSpecialist` — a read-only `CodexAgent` that answers billing, invoice, payment, refund, and subscription questions from fixed demo data.
- `OpenRouterSupportSpecialist` — a standard ADK `LlmAgent` using `OpenRouter(...)`, with `check_system_status` and `reset_password` tools.

`CodexAgent` uses `@openai/codex-sdk` by default. The SDK controls the local Codex runtime and reuses Codex native authentication/configuration. Use `codex login` for local auth or provide `CODEX_API_KEY` for API-key automation. If optional Codex binary discovery fails, set `CODEX_EXECUTABLE` or `CODEX_CLI_PATH` to an existing `codex` executable.

For local usage, Claude Code can use the credentials already configured on your machine. The SDK driver passes the minimal native-auth environment (`HOME`, `PATH`, `USER`, `SHELL`, `CLAUDE_CONFIG_DIR`, and `XDG_CONFIG_HOME`) so Claude can find its native config/cache. If needed, set `CLAUDE_CODE_EXECUTABLE` or `CLAUDE_CODE_PATH` in `.env`.

The OpenRouter subagent requires `OPENROUTER_API_KEY` unless your environment already provides it. You can change the model with:

```bash
OPENROUTER_MODEL=google/gemini-2.0-flash-001
```

The default is `google/gemini-2.0-flash-001` because the free DeepSeek route can return intermittent OpenRouter provider `429` errors during tool-heavy support flows.

The bridge does not persist provider secrets. Install and authenticate each runtime using its native documentation when you want that runtime to execute real work.

## Important Runtime Note

The `/agents` API is intentionally separate from the root LLM provider API. Normal LLM usage remains under:

```ts
import { OpenRouter } from "adk-llm-bridge";
```

External runtime usage is opt-in:

```ts
import { CodexAgent, ClaudeAgent } from "adk-llm-bridge/agents";
```

Claude Agent SDK execution is side-effectful and uses the permissions configured on the `ClaudeAgent`; this example defaults to `ask` mode and limits allowed paths to the current working directory plus any paths in `ARCHITECTURE_ANALYSIS_PATHS`. Subagent permissions are inherited conservatively, so `CodexBillingSpecialist` cannot expand beyond the root agent restrictions.

The example `tsconfig.json` maps `adk-llm-bridge`, `adk-llm-bridge/agents`, and `@google/adk` for local type-checking, avoiding duplicate nominal ADK symbols while using a file dependency. The agent imports the ADK runtime ESM build directly so Bun does not execute declaration files at runtime.
