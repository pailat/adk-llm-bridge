# adk-llm-bridge

[![npm version](https://img.shields.io/npm/v/adk-llm-bridge.svg)](https://www.npmjs.com/package/adk-llm-bridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Use **any LLM** with [Google ADK TypeScript](https://github.com/google/adk-js) in just a few lines of code.

## Why?

Google ADK TypeScript comes with built-in Gemini support. This bridge extends it to work with **any model** from providers like Anthropic, OpenAI, Meta, and more—while keeping all ADK features like multi-agent orchestration, tool calling, and streaming.

### Key Benefits

- **Simple** — 3 lines to integrate any model
- **Battle-tested** — Built on the official OpenAI and Anthropic SDKs
- **Compatible** — Works with any OpenAI-compatible API (AI Gateway, OpenRouter, etc.)

## Supported Providers

| Provider | Models | Features |
|----------|--------|----------|
| **[Vercel AI Gateway](https://vercel.com/ai-gateway)** | 100+ models (Claude, GPT, Llama, Gemini, etc.) | Simple, fast |
| **[OpenRouter](https://openrouter.ai/)** | 100+ models | Provider routing, fallbacks, price optimization |
| **[OpenAI](https://openai.com/)** | GPT-4, o1, o3, etc. | Direct API access |
| **[Anthropic](https://anthropic.com/)** | Claude models | Direct API access |
| **[xAI](https://x.ai/)** | Grok models | Direct API access |
| **Custom (OpenAI-compatible)** | Any model | Ollama, vLLM, Azure OpenAI, LM Studio, etc. |

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
import { LlmAgent } from '@google/adk';
import { AIGateway } from 'adk-llm-bridge';

const agent = new LlmAgent({
  name: 'assistant',
  model: AIGateway('anthropic/claude-sonnet-4'),
  instruction: 'You are a helpful assistant.',
});
```

That's it. All ADK features work: tools, streaming, multi-agent, etc.

### Other Providers

```typescript
import { OpenRouter, OpenAI, Anthropic, XAI, Custom } from 'adk-llm-bridge';

// OpenRouter - 100+ models with routing
model: OpenRouter('anthropic/claude-sonnet-4')

// OpenAI - Direct API
model: OpenAI('gpt-4.1')

// Anthropic - Direct API  
model: Anthropic('claude-sonnet-4-5')

// xAI - Direct API
model: XAI('grok-3-beta')

// Local models (LM Studio, Ollama, etc.)
model: Custom('your-model', { baseURL: 'http://localhost:1234/v1' })
```

See the [examples](./examples) directory for complete implementations.

### Using LLMRegistry (Alternative)

You can also register providers with ADK's LLMRegistry to use string-based model names:

```typescript
import { LlmAgent, LLMRegistry } from '@google/adk';
import { AnthropicLlm } from 'adk-llm-bridge';

LLMRegistry.register(AnthropicLlm);

const agent = new LlmAgent({
  name: 'assistant',
  model: 'claude-sonnet-4-5',  // String-based model name
  instruction: 'You are a helpful assistant.',
});
```

## Configuration

### Environment Variables

**AI Gateway:**
```bash
AI_GATEWAY_API_KEY=your-api-key
AI_GATEWAY_URL=https://ai-gateway.vercel.sh/v1  # optional
```

**OpenRouter:**
```bash
OPENROUTER_API_KEY=your-api-key
OPENROUTER_SITE_URL=https://your-site.com  # optional, for ranking
OPENROUTER_APP_NAME=Your App Name          # optional, for ranking
```

**Direct Providers:**
```bash
OPENAI_API_KEY=your-openai-key
ANTHROPIC_API_KEY=your-anthropic-key
XAI_API_KEY=your-xai-key
```

### Programmatic Configuration

Pass options directly to the factory functions:

```typescript
import { AIGateway, OpenRouter, Anthropic } from 'adk-llm-bridge';

// AI Gateway with custom URL
model: AIGateway('anthropic/claude-sonnet-4', {
  apiKey: process.env.MY_API_KEY,
  baseURL: 'https://my-gateway.example.com/v1',
})

// OpenRouter with site info
model: OpenRouter('anthropic/claude-sonnet-4', {
  apiKey: process.env.OPENROUTER_API_KEY,
  siteUrl: 'https://your-site.com',
  appName: 'Your App',
})

// Anthropic with custom max tokens
model: Anthropic('claude-sonnet-4-5', {
  apiKey: process.env.ANTHROPIC_API_KEY,
  maxTokens: 8192,
})
```

## Model Format

Use the `provider/model` format:

```
anthropic/claude-sonnet-4
openai/gpt-5
google/gemini-3-flash
meta/llama-4-maverick
mistral/mistral-large-3
xai/grok-4.1
deepseek/deepseek-chat
```

### Popular Models

| Provider | Models |
|----------|--------|
| Anthropic | `anthropic/claude-sonnet-4`, `anthropic/claude-opus-4.5` |
| OpenAI | `openai/gpt-5`, `openai/gpt-5-mini`, `openai/o3` |
| Google | `google/gemini-3-flash`, `google/gemini-3-pro`, `google/gemini-2.5-pro` |
| Meta | `meta/llama-4-maverick`, `meta/llama-4-scout`, `meta/llama-3.3-70b-instruct` |
| Mistral | `mistral/mistral-large-3`, `mistral/ministral-3-14b` |
| xAI | `xai/grok-4.1`, `xai/grok-4`, `xai/grok-3` |
| DeepSeek | `deepseek/deepseek-chat`, `deepseek/deepseek-reasoner` |

Browse all models:
- [Vercel AI Gateway Models](https://vercel.com/ai-gateway/models)
- [OpenRouter Models](https://openrouter.ai/models)

## Features

- **Text generation** - Simple prompt/response
- **Streaming** - Real-time token streaming
- **Tool calling** - Function calling with automatic conversion
- **Multi-turn** - Full conversation history support
- **Multi-agent** - Sub-agents and agent transfer
- **Usage metadata** - Token counts for monitoring

## Tool Calling Example

```typescript
import { FunctionTool, LlmAgent } from '@google/adk';
import { Anthropic } from 'adk-llm-bridge';
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
  model: Anthropic('claude-sonnet-4-5'),
  instruction: 'You help users check the weather.',
  tools: [getWeather],
});
```

## API Reference

### Factory Functions

| Function | Description |
|----------|-------------|
| `AIGateway(model, options?)` | Vercel AI Gateway (100+ models) |
| `OpenRouter(model, options?)` | OpenRouter (100+ models) |
| `OpenAI(model, options?)` | OpenAI direct API |
| `Anthropic(model, options?)` | Anthropic direct API |
| `XAI(model, options?)` | xAI direct API |
| `Custom(model, options)` | Any OpenAI-compatible API |

### Configuration Options

**AIGateway:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | `process.env.AI_GATEWAY_API_KEY` | API key |
| `baseURL` | `string` | `https://ai-gateway.vercel.sh/v1` | Gateway URL |
| `timeout` | `number` | `60000` | Request timeout (ms) |
| `maxRetries` | `number` | `2` | Max retry attempts |

**OpenRouter:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | `process.env.OPENROUTER_API_KEY` | API key |
| `baseURL` | `string` | `https://openrouter.ai/api/v1` | API URL |
| `siteUrl` | `string` | `process.env.OPENROUTER_SITE_URL` | Your site URL (for ranking) |
| `appName` | `string` | `process.env.OPENROUTER_APP_NAME` | Your app name (for ranking) |
| `provider` | `object` | - | Provider routing preferences |
| `timeout` | `number` | `60000` | Request timeout (ms) |
| `maxRetries` | `number` | `2` | Max retry attempts |

**OpenAI:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | `process.env.OPENAI_API_KEY` | API key |
| `organization` | `string` | `process.env.OPENAI_ORGANIZATION` | Organization ID |
| `project` | `string` | `process.env.OPENAI_PROJECT` | Project ID |
| `timeout` | `number` | `60000` | Request timeout (ms) |
| `maxRetries` | `number` | `2` | Max retry attempts |

**Anthropic:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | `process.env.ANTHROPIC_API_KEY` | API key |
| `maxTokens` | `number` | `4096` | Max tokens in response |
| `timeout` | `number` | `60000` | Request timeout (ms) |
| `maxRetries` | `number` | `2` | Max retry attempts |

**XAI:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | `process.env.XAI_API_KEY` | API key |
| `timeout` | `number` | `60000` | Request timeout (ms) |
| `maxRetries` | `number` | `2` | Max retry attempts |

**Custom:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `model` | `string` | - | Model name (required) |
| `baseURL` | `string` | - | API base URL (required) |
| `name` | `string` | `"custom"` | Provider name for logs/errors |
| `apiKey` | `string` | - | API key for authentication |
| `headers` | `Record<string, string>` | - | Additional HTTP headers |
| `queryParams` | `Record<string, string>` | - | Query parameters for all requests |
| `providerOptions` | `Record<string, unknown>` | - | Additional options for request body |
| `timeout` | `number` | `60000` | Request timeout (ms) |
| `maxRetries` | `number` | `2` | Max retry attempts |

## Examples

See the [examples](./examples) directory:

- **[basic-agent-ai-gateway](./examples/basic-agent-ai-gateway)** - Multi-agent HelpDesk with AI Gateway
- **[basic-agent-openrouter](./examples/basic-agent-openrouter)** - Multi-agent HelpDesk with OpenRouter
- **[basic-agent-openai](./examples/basic-agent-openai)** - Multi-agent HelpDesk with OpenAI
- **[basic-agent-anthropic](./examples/basic-agent-anthropic)** - Multi-agent HelpDesk with Anthropic
- **[basic-agent-xai](./examples/basic-agent-xai)** - Multi-agent HelpDesk with xAI
- **[basic-agent-lmstudio](./examples/basic-agent-lmstudio)** - Multi-agent HelpDesk with LM Studio
- **[express-server](./examples/express-server)** - Production HTTP API with sessions, streaming, tools

## Requirements

- Node.js >= 18.0.0
- `@google/adk` >= 0.2.2

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

[MIT](LICENSE)
