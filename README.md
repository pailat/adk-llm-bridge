# adk-llm-bridge

[![npm version](https://img.shields.io/npm/v/adk-llm-bridge.svg)](https://www.npmjs.com/package/adk-llm-bridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Connect [Google ADK](https://github.com/google/adk-typescript) to [Vercel AI Gateway](https://vercel.com/ai-gateway) and 100+ LLM models.

## Why?

[Google ADK TypeScript](https://github.com/google/adk-typescript) only supports Gemini models natively (unlike the Python version which has LiteLLM integration). This package bridges that gap, letting you use **any model** from Vercel AI Gateway (Claude, GPT-4, Llama, Mistral, etc.) while keeping all ADK features like multi-agent orchestration, tool calling, and streaming.

## Installation

```bash
bun add adk-llm-bridge @google/adk
```

```bash
pnpm add adk-llm-bridge @google/adk
```

```bash
npm install adk-llm-bridge @google/adk
```

## Quick Start

```typescript
import { LlmAgent, LLMRegistry, Runner, InMemorySessionService } from '@google/adk';
import { AIGatewayLlm } from 'adk-llm-bridge';

// Register once at startup
LLMRegistry.register(AIGatewayLlm);

const agent = new LlmAgent({
  name: 'assistant',
  model: 'anthropic/claude-sonnet-4', // String model name
  instruction: 'You are a helpful assistant.',
});

// Run with Runner (programmatic usage)
const sessionService = new InMemorySessionService();
const runner = new Runner({ agent, appName: 'my-app', sessionService });

const session = await sessionService.createSession({ appName: 'my-app', userId: 'user-1' });

for await (const event of runner.runAsync({
  userId: 'user-1',
  sessionId: session.id,
  newMessage: { role: 'user', parts: [{ text: 'Hello!' }] },
})) {
  console.log(event);
}
```

## Configuration

### Environment Variables (Recommended)

```bash
AI_GATEWAY_API_KEY=your-api-key
AI_GATEWAY_URL=https://ai-gateway.vercel.sh/v1  # optional
```

### Global Configuration

Configure defaults when registering:

```typescript
import { LlmAgent, LLMRegistry } from '@google/adk';
import { AIGatewayLlm, registerAIGateway } from 'adk-llm-bridge';

// Option 1: Register with defaults from env vars
LLMRegistry.register(AIGatewayLlm);

// Option 2: Register with custom config
registerAIGateway({
  apiKey: process.env.MY_API_KEY,
  baseURL: 'https://my-gateway.example.com/v1',
});

const agent = new LlmAgent({
  name: 'assistant',
  model: 'anthropic/claude-sonnet-4',
  instruction: 'You are helpful.',
});
```

### Using with adk-devtools

Works out of the box with `adk-devtools` (CLI or web interface):

```typescript
import { LlmAgent, LLMRegistry } from '@google/adk';
import { AIGatewayLlm } from 'adk-llm-bridge';

LLMRegistry.register(AIGatewayLlm);

export const rootAgent = new LlmAgent({
  name: 'assistant',
  model: 'anthropic/claude-sonnet-4',
  instruction: 'You are helpful.',
});
```

Then run:
```bash
bunx @google/adk-devtools dev agent.ts
```

## Known Issue: Direct Instance Usage

### The Problem

Ideally, you should be able to pass an LLM instance directly:

```typescript
import { LlmAgent } from '@google/adk';
import { AIGateway } from 'adk-llm-bridge';

// ⚠️ This may fail in bundled environments
const agent = new LlmAgent({
  name: 'assistant',
  model: AIGateway('anthropic/claude-sonnet-4'),
});
```

However, this fails with `Error: No model found for assistant` in bundled environments (like `adk-devtools`, webpack, esbuild).

### Why It Happens

ADK's `LlmAgent` uses `instanceof BaseLlm` to check if the model is valid. When code is bundled:

1. The bundler creates a copy of `BaseLlm` inside the bundle
2. Your external package (`adk-llm-bridge`) imports `BaseLlm` from `node_modules`
3. These are two different class identities in memory
4. `instanceof` returns `false` even though `AIGatewayLlm` correctly extends `BaseLlm`

```
Bundled code:     BaseLlm[A] ← LlmAgent checks against this
External package: BaseLlm[B] ← AIGatewayLlm extends this

AIGatewayLlm instanceof BaseLlm[A] → false ❌
```

### The Fix

We've submitted a PR to ADK that adds a duck typing fallback: [google/adk-js#35](https://github.com/google/adk-js/pull/35)

**Current status:** Waiting for review

### Workaround (Use This)

Use `LLMRegistry.register()` with string model names instead of instances:

```typescript
import { LlmAgent, LLMRegistry } from '@google/adk';
import { AIGatewayLlm } from 'adk-llm-bridge';

// ✅ This works everywhere
LLMRegistry.register(AIGatewayLlm);

const agent = new LlmAgent({
  name: 'assistant',
  model: 'anthropic/claude-sonnet-4', // String, not AIGateway()
  instruction: 'You are helpful.',
});
```

Once the PR is merged, `AIGateway()` direct instances will work and become the recommended approach.

## Model Format

Use the `provider/model` format:

```
anthropic/claude-sonnet-4
openai/gpt-4o
google/gemini-2.0-flash
xai/grok-2
deepseek/deepseek-chat
zai/glm-4.6
```

**Any model available in [Vercel AI Gateway](https://sdk.vercel.ai/docs/ai-sdk-core/ai-gateway#supported-models) will work.**

### Popular Providers

| Provider | Examples |
|----------|----------|
| Anthropic | `anthropic/claude-sonnet-4`, `anthropic/claude-haiku` |
| OpenAI | `openai/gpt-4o`, `openai/gpt-4o-mini` |
| Google | `google/gemini-2.0-flash` |
| Meta | `meta/llama-3.1-70b-instruct` |
| Mistral | `mistral/mistral-large` |
| xAI | `xai/grok-2` |
| DeepSeek | `deepseek/deepseek-chat` |
| Zhipu AI | `zai/glm-4.6`, `zai/glm-4.5` |
| Groq | `groq/llama-3.1-70b` |
| Perplexity | `perplexity/sonar-pro` |

## Features

- **Text generation** - Simple prompt/response
- **Streaming** - Real-time token streaming
- **Tool calling** - Function calling with automatic conversion
- **Multi-turn** - Full conversation history support
- **Usage metadata** - Token counts for monitoring

## Tool Calling Example

```typescript
import { FunctionTool, LlmAgent, LLMRegistry } from '@google/adk';
import { AIGatewayLlm } from 'adk-llm-bridge';
import { z } from 'zod';

LLMRegistry.register(AIGatewayLlm);

const getWeather = new FunctionTool({
  name: 'get_weather',
  description: 'Get current weather for a city',
  parameters: z.object({
    city: z.string().describe('City name'),
  }),
  execute: ({ city }) => {
    return { status: 'success', weather: 'sunny', city };
  },
});

const agent = new LlmAgent({
  name: 'weather-assistant',
  model: 'anthropic/claude-sonnet-4',
  instruction: 'You help users check the weather.',
  tools: [getWeather],
});
```

## Production Usage (HTTP API Server)

See [examples/express-server](./examples/express-server) for a complete example with:
- Session management with state persistence
- Artifact storage
- Memory service
- FunctionTool with ToolContext
- Token-level streaming (SSE)

```typescript
import express from "express";
import { LlmAgent, LLMRegistry, Runner, InMemorySessionService } from "@google/adk";
import { AIGatewayLlm } from "adk-llm-bridge";

LLMRegistry.register(AIGatewayLlm);

const agent = new LlmAgent({
  name: "assistant",
  model: "anthropic/claude-sonnet-4",
  instruction: "You are a helpful assistant.",
});

const sessionService = new InMemorySessionService();
const runner = new Runner({ agent, appName: "my-app", sessionService });

const app = express();
app.use(express.json());

app.post("/run", async (req, res) => {
  const { userId, sessionId, message } = req.body;
  
  let session = sessionId 
    ? await sessionService.getSession({ appName: "my-app", userId, sessionId }).catch(() => null)
    : null;
  
  if (!session) {
    session = await sessionService.createSession({ appName: "my-app", userId });
  }

  const events = [];
  for await (const event of runner.runAsync({
    userId,
    sessionId: session.id,
    newMessage: { role: "user", parts: [{ text: message }] },
  })) {
    events.push(event);
  }

  res.json({ sessionId: session.id, events });
});

app.listen(3000);
```

## API Reference

### `AIGatewayLlm`

The main LLM class for use with `LLMRegistry`:

```typescript
import { LLMRegistry } from '@google/adk';
import { AIGatewayLlm } from 'adk-llm-bridge';

LLMRegistry.register(AIGatewayLlm);
```

### `registerAIGateway(options?)`

Helper to register with custom configuration:

```typescript
import { registerAIGateway } from 'adk-llm-bridge';

registerAIGateway({ apiKey: 'sk-...' });
```

### `AIGateway(model, options?)`

Creates an LLM instance directly. See [Known Issue](#known-issue-direct-instance-usage) above.

```typescript
import { AIGateway } from 'adk-llm-bridge';

AIGateway('anthropic/claude-sonnet-4')
AIGateway('openai/gpt-4o', { apiKey: 'sk-...' })
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `model` | `string` | Model identifier (e.g., `anthropic/claude-sonnet-4`) |
| `options.apiKey` | `string` | API key (default: `process.env.AI_GATEWAY_API_KEY`) |
| `options.baseURL` | `string` | Gateway URL (default: `https://ai-gateway.vercel.sh/v1`) |
| `options.timeout` | `number` | Request timeout in ms (default: `60000`) |
| `options.maxRetries` | `number` | Max retry attempts (default: `2`) |

## Requirements

- Node.js >= 18.0.0
- `@google/adk` >= 0.2.0

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

[MIT](LICENSE)
