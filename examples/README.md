# Examples

Examples of using `adk-llm-bridge` with Google ADK and Vercel AI Gateway.

## Available Examples

| Example                           | Description                                      |
| --------------------------------- | ------------------------------------------------ |
| [basic-agent](./basic-agent)      | ADK DevTools with FunctionTool                   |
| [express-server](./express-server)| HTTP API Server with Express                     |

## Quick Start

### basic-agent

Uses ADK DevTools web interface (for development/testing):

```bash
cd examples/basic-agent
cp .env.example .env
# Edit .env with your AI_GATEWAY_API_KEY
bun install
bun run web
```

### express-server

HTTP API server exposing agent as REST endpoints (production pattern):

```bash
cd examples/express-server
cp .env.example .env
# Edit .env with your AI_GATEWAY_API_KEY
bun install
bun run start
```

Then test with curl:

```bash
# Run agent (JSON response)
curl -X POST http://localhost:3000/run \
  -H "Content-Type: application/json" \
  -d '{"userId": "user-1", "message": "Hello!"}'

# Run agent with SSE streaming (event-level)
curl -X POST http://localhost:3000/run_sse \
  -H "Content-Type: application/json" \
  -d '{"userId": "user-1", "message": "Tell me a story"}'

# Run agent with token-level streaming (real-time tokens)
curl -X POST http://localhost:3000/run_sse \
  -H "Content-Type: application/json" \
  -d '{"userId": "user-1", "message": "Tell me a story", "streaming": true}'
```

## Important: adk-devtools Bundling

When using `adk-devtools` (CLI or web interface), you **must** register `AIGatewayLlm` with `LLMRegistry` and use string model names instead of `AIGateway()` instances.

This is because `adk-devtools` bundles `@google/adk` separately, which causes `instanceof BaseLlm` checks to fail when passing instances directly.

```typescript
// Required for adk-devtools
import { LlmAgent, LLMRegistry } from "@google/adk";
import { AIGatewayLlm } from "adk-llm-bridge";

LLMRegistry.register(AIGatewayLlm);

export const rootAgent = new LlmAgent({
  name: "my_agent",
  model: "anthropic/claude-sonnet-4", // Use string, NOT AIGateway()
  instruction: "You are helpful.",
});
```

For programmatic usage (without adk-devtools), you can use `AIGateway()` directly:

```typescript
import { LlmAgent } from "@google/adk";
import { AIGateway } from "adk-llm-bridge";

const agent = new LlmAgent({
  name: "my_agent",
  model: AIGateway("anthropic/claude-sonnet-4"), // Works in programmatic usage
  instruction: "You are helpful.",
});
```

## Important: Run from example directory

Bun loads `.env` files from the current working directory. Always `cd` into the example folder before running:

```bash
# Correct
cd examples/basic-agent && bun run web

# Wrong - .env won't be loaded
bun run examples/basic-agent/agent.ts
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway API key |
| `OPENAI_API_KEY` | OpenAI API key (alternative) |
