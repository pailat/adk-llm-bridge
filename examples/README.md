# Examples

Examples of using `adk-llm-bridge` with Google ADK and multiple LLM providers.

## Available Examples

| Example | Provider | Description |
|---------|----------|-------------|
| [basic-agent-ai-gateway](./basic-agent-ai-gateway) | Vercel AI Gateway | Multi-agent HelpDesk with AI Gateway |
| [basic-agent-openrouter](./basic-agent-openrouter) | OpenRouter | Multi-agent HelpDesk with OpenRouter |
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
| `OPENAI_API_KEY` | AI Gateway | OpenAI API key (alternative) |
| `OPENROUTER_API_KEY` | OpenRouter | OpenRouter API key |
| `OPENROUTER_SITE_URL` | OpenRouter | Your site URL (for ranking) |
| `OPENROUTER_APP_NAME` | OpenRouter | Your app name (for ranking) |
