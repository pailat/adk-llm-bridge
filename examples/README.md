# Examples

Examples of using `adk-llm-bridge` with Google ADK and Vercel AI Gateway.

## Available Examples

| Example                           | Description                                      |
| --------------------------------- | ------------------------------------------------ |
| [basic-agent](./basic-agent)      | ADK DevTools with FunctionTool                   |
| [express-server](./express-server)| Full-featured HTTP API with tools, state & streaming |

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

**Note:** This bundling issue also affects programmatic usage with `Runner`. Always use `LLMRegistry.register()` + string model names when using ADK's `Runner` class. See `express-server/index.ts` for the recommended pattern.

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
