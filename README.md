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
import { LlmAgent, Runner, InMemorySessionService } from '@google/adk';
import { AIGateway } from 'adk-llm-bridge';

const agent = new LlmAgent({
  name: 'assistant',
  model: AIGateway('anthropic/claude-sonnet-4'),
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

### With Options

```typescript
import { AIGateway } from 'adk-llm-bridge';

const agent = new LlmAgent({
  name: 'assistant',
  model: AIGateway('openai/gpt-4o', {
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 30000,
    maxRetries: 3,
  }),
  instruction: 'You are helpful.',
});
```

### Multiple Agents with Different Configs

Each agent can have its own API key or configuration:

```typescript
import { LlmAgent } from '@google/adk';
import { AIGateway } from 'adk-llm-bridge';

// Agent with production API key
const prodAgent = new LlmAgent({
  name: 'prod-assistant',
  model: AIGateway('anthropic/claude-sonnet-4', { 
    apiKey: process.env.PROD_API_KEY 
  }),
  instruction: 'You are a production assistant.',
});

// Agent with development API key
const devAgent = new LlmAgent({
  name: 'dev-assistant',
  model: AIGateway('openai/gpt-4o', { 
    apiKey: process.env.DEV_API_KEY 
  }),
  instruction: 'You are a development assistant.',
});
```

### Using with adk-devtools

When using `adk-devtools` (CLI or web interface), you must register with `LLMRegistry` due to how the tool bundles dependencies:

```typescript
import { LlmAgent, LLMRegistry } from '@google/adk';
import { AIGatewayLlm } from 'adk-llm-bridge';

// Required for adk-devtools
LLMRegistry.register(AIGatewayLlm);

export const rootAgent = new LlmAgent({
  name: 'assistant',
  model: 'anthropic/claude-sonnet-4', // Use string, not AIGateway()
  instruction: 'You are helpful.',
});
```

### Using String Model Names (Alternative)

If you prefer string-based model names, register once at startup:

```typescript
import { LlmAgent } from '@google/adk';
import { registerAIGateway } from 'adk-llm-bridge';

// Register once (uses AI_GATEWAY_API_KEY from env)
registerAIGateway();

const agent = new LlmAgent({
  name: 'assistant',
  model: 'anthropic/claude-sonnet-4', // String works after registration
  instruction: 'You are helpful.',
});
```

## Model Format

Use the `provider/model` format supported by AI Gateway:

```typescript
AIGateway('anthropic/claude-sonnet-4')
AIGateway('openai/gpt-4o')
AIGateway('google/gemini-2.0-flash')
AIGateway('zai/glm-4.6')
AIGateway('xai/grok-2')
AIGateway('deepseek/deepseek-chat')
```

**Any model available in [Vercel AI Gateway](https://sdk.vercel.ai/docs/ai-sdk-core/ai-gateway#supported-models) will work** - no code changes needed when new providers are added.

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

Browse all models at [Vercel AI Gateway Models](https://sdk.vercel.ai/docs/ai-sdk-core/ai-gateway#supported-models).

## Features

- **Text generation** - Simple prompt/response
- **Streaming** - Real-time token streaming
- **Tool calling** - Function calling with automatic conversion
- **Multi-turn** - Full conversation history support
- **Usage metadata** - Token counts for monitoring

## Production Usage (HTTP API Server)

ADK doesn't include an HTTP server. For production, create your own API server using Express or similar:

```typescript
import express from "express";
import { LlmAgent, Runner, InMemorySessionService } from "@google/adk";
import { AIGateway } from "adk-llm-bridge";

const agent = new LlmAgent({
  name: "assistant",
  model: AIGateway("anthropic/claude-sonnet-4"),
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

See [examples/express-server](./examples/express-server) for a complete example with SSE streaming and token-level streaming support.

## Tool Calling Example

```typescript
import { FunctionTool, LlmAgent } from '@google/adk';
import { AIGateway } from 'adk-llm-bridge';
import { z } from 'zod';

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
  model: AIGateway('anthropic/claude-sonnet-4'),
  instruction: 'You help users check the weather.',
  tools: [getWeather],
});
```

## API Reference

### `AIGateway(model, options?)`

Creates an LLM instance for use with ADK agents.

```typescript
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

### `registerAIGateway(options?)`

Registers AI Gateway with ADK's LLM registry for string-based model names.

```typescript
registerAIGateway()
registerAIGateway({ apiKey: 'sk-...' })
```

### `AIGatewayLlm`

Direct LLM class for advanced usage (same options as `AIGateway`).

```typescript
import { AIGatewayLlm } from 'adk-llm-bridge';

const llm = new AIGatewayLlm({
  model: 'anthropic/claude-sonnet-4',
  apiKey: 'sk-...',
});
```

## Requirements

- Node.js >= 18.0.0
- `@google/adk` >= 0.2.0

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

[MIT](LICENSE)
