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
- Using `EnvCredentialProvider` to pass only provider allowlisted environment variables
- Selecting permission presets such as `read-only`, `ask`, and `workspace-write`
- Keeping provider-specific driver/runtime logic outside this package

## Important runtime note

The foundation layer exports public shapes and placeholder agents. It does **not** bundle provider-specific CLI drivers or install Codex, Claude Code, or Gemini CLI for you. If no driver is supplied, the placeholder driver emits a recoverable configuration error instead of executing a provider runtime.

## Auth

External runtimes own their normal authentication flows. This package does not persist secrets by default. `EnvCredentialProvider` can pass allowlisted variables such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY`, `GEMINI_API_KEY`, or `GOOGLE_API_KEY` to a driver. You can provide your own credential provider when you need a different secret manager.
