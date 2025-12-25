# Examples

Examples of using `adk-llm-bridge` with Google ADK and multiple LLM providers.

## Available Examples

| Example | Provider | Description |
|---------|----------|-------------|
| [basic-agent-ai-gateway](./basic-agent-ai-gateway) | Vercel AI Gateway | Multi-agent HelpDesk with AI Gateway |
| [basic-agent-openrouter](./basic-agent-openrouter) | OpenRouter | Multi-agent HelpDesk with OpenRouter |
| [basic-agent-openai](./basic-agent-openai) | OpenAI | Weather assistant with OpenAI GPT models |
| [basic-agent-anthropic](./basic-agent-anthropic) | Anthropic | Weather assistant with Claude models |
| [basic-agent-xai](./basic-agent-xai) | xAI | Weather assistant with Grok models |
| [basic-agent-lmstudio](./basic-agent-lmstudio) | LM Studio | Weather assistant with local models |
| [express-server](./express-server) | AI Gateway | Full HTTP API with tools, state & streaming |

## Quick Start

### basic-agent-ai-gateway

Uses ADK DevTools with Vercel AI Gateway:

```bash
cd examples/basic-agent-ai-gateway
cp .env.example .env
# Edit .env with your AI_GATEWAY_API_KEY
bun install
bun run web
```

### basic-agent-openrouter

Uses ADK DevTools with OpenRouter:

```bash
cd examples/basic-agent-openrouter
cp .env.example .env
# Edit .env with your OPENROUTER_API_KEY
bun install
bun run web
```

### basic-agent-openai

Direct OpenAI API access with GPT models:

```bash
cd examples/basic-agent-openai
cp .env.example .env
# Edit .env with your OPENAI_API_KEY
bun install
bun run web
```

### basic-agent-anthropic

Direct Anthropic API access with Claude models:

```bash
cd examples/basic-agent-anthropic
cp .env.example .env
# Edit .env with your ANTHROPIC_API_KEY
bun install
bun run web
```

### basic-agent-xai

Direct xAI API access with Grok models:

```bash
cd examples/basic-agent-xai
cp .env.example .env
# Edit .env with your XAI_API_KEY
bun install
bun run web
```

### basic-agent-lmstudio

Local models via LM Studio (no API key required):

```bash
# First, start LM Studio and load a model
cd examples/basic-agent-lmstudio
bun install
bun run web
```

### express-server

Full-featured HTTP API server demonstrating ADK best practices:

**Features:**
- Session management with state persistence
- FunctionTool with ToolContext (state access)
- Artifact and memory services
- Token-level streaming
- Session history endpoints

```bash
cd examples/express-server
cp .env.example .env
# Edit .env with your AI_GATEWAY_API_KEY
bun install
bun run start
```

Then test with curl:

```bash
# Basic chat
curl -X POST http://localhost:3000/run \
  -H "Content-Type: application/json" \
  -d '{"userId": "user-1", "message": "Hello!"}'

# Use the notepad tool to save notes (persists in state)
curl -X POST http://localhost:3000/run \
  -H "Content-Type: application/json" \
  -d '{"userId": "user-1", "message": "Save a note that my favorite color is blue"}'

# Ask what time it is (uses get_current_time tool)
curl -X POST http://localhost:3000/run \
  -H "Content-Type: application/json" \
  -d '{"userId": "user-1", "message": "What time is it?"}'

# SSE streaming (event-level)
curl -X POST http://localhost:3000/run_sse \
  -H "Content-Type: application/json" \
  -d '{"userId": "user-1", "message": "Tell me a story"}'

# Token-level streaming (real-time tokens)
curl -X POST http://localhost:3000/run_sse \
  -H "Content-Type: application/json" \
  -d '{"userId": "user-1", "message": "Tell me a story", "streaming": true}'

# List user sessions
curl http://localhost:3000/sessions/user-1

# Get session history
curl "http://localhost:3000/session/SESSION_ID?userId=user-1"
```

## Important: adk-devtools Bundling

When using `adk-devtools`, you **must** import `LLMRegistry` from `@google/adk` directly and register the LLM class manually. This is because `adk-devtools` bundles its own copy of `@google/adk`.

### AI Gateway

```typescript
import { LlmAgent, LLMRegistry } from "@google/adk";
import { AIGatewayLlm } from "adk-llm-bridge";

// Register with LLMRegistry from YOUR @google/adk import
LLMRegistry.register(AIGatewayLlm);

export const rootAgent = new LlmAgent({
  name: "my_agent",
  model: "anthropic/claude-sonnet-4",
  instruction: "You are helpful.",
});
```

### OpenRouter

```typescript
import { LlmAgent, LLMRegistry } from "@google/adk";
import { OpenRouterLlm } from "adk-llm-bridge";

// Register with LLMRegistry from YOUR @google/adk import
LLMRegistry.register(OpenRouterLlm);

export const rootAgent = new LlmAgent({
  name: "my_agent",
  model: "anthropic/claude-sonnet-4",
  instruction: "You are helpful.",
});
```

### OpenAI

```typescript
import { LlmAgent, LLMRegistry } from "@google/adk";
import { OpenAILlm } from "adk-llm-bridge";

// Register with LLMRegistry from YOUR @google/adk import
LLMRegistry.register(OpenAILlm);

export const rootAgent = new LlmAgent({
  name: "assistant",
  model: "gpt-4.1",
  instruction: "You are helpful.",
});
```

### Anthropic

```typescript
import { LlmAgent, LLMRegistry } from "@google/adk";
import { AnthropicLlm } from "adk-llm-bridge";

// Register with LLMRegistry from YOUR @google/adk import
LLMRegistry.register(AnthropicLlm);

export const rootAgent = new LlmAgent({
  name: "assistant",
  model: "claude-sonnet-4-5-20250929",
  instruction: "You are helpful.",
});
```

### xAI (Grok)

```typescript
import { LlmAgent, LLMRegistry } from "@google/adk";
import { XAILlm } from "adk-llm-bridge";

// Register with LLMRegistry from YOUR @google/adk import
LLMRegistry.register(XAILlm);

export const rootAgent = new LlmAgent({
  name: "assistant",
  model: "grok-3-beta",
  instruction: "You are helpful.",
});
```

### Local Models (LM Studio, Ollama)

Use the Custom provider for any OpenAI-compatible API:

```typescript
import { LlmAgent } from "@google/adk";
import { Custom } from "adk-llm-bridge";

export const localAgent = new LlmAgent({
  name: "assistant",
  model: Custom("local-model", {
    baseURL: "http://localhost:1234/v1", // LM Studio
    // baseURL: "http://localhost:11434/v1", // Ollama
  }),
  instruction: "You are helpful.",
});
```

### Programmatic Usage (without adk-devtools)

For programmatic usage with ADK's `Runner` class (not using adk-devtools), you can use the convenience functions:

```typescript
import { registerAIGateway, registerOpenRouter } from "adk-llm-bridge";

// These work when not using adk-devtools bundling
registerAIGateway();
registerOpenRouter();
```

## Important: Run from example directory

Bun loads `.env` files from the current working directory. Always `cd` into the example folder before running:

```bash
# Correct
cd examples/basic-agent-ai-gateway && bun run web

# Wrong - .env won't be loaded
bun run examples/basic-agent-ai-gateway/agent.ts
```

## Environment Variables

| Variable | Provider | Description |
|----------|----------|-------------|
| `AI_GATEWAY_API_KEY` | AI Gateway | Vercel AI Gateway API key |
| `OPENAI_API_KEY` | OpenAI / AI Gateway | OpenAI API key |
| `ANTHROPIC_API_KEY` | Anthropic | Anthropic API key |
| `XAI_API_KEY` | xAI | xAI API key |
| `OPENROUTER_API_KEY` | OpenRouter | OpenRouter API key |
| `OPENROUTER_SITE_URL` | OpenRouter | Your site URL (for ranking) |
| `OPENROUTER_APP_NAME` | OpenRouter | Your app name (for ranking) |
| `LMSTUDIO_BASE_URL` | LM Studio | Local server URL (default: http://localhost:1234/v1) |
