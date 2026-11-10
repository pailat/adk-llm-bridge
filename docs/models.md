# Models

`adk-llm-bridge` does not keep its own model list: any model id the provider
accepts can be passed to its factory. This page lists current ids so you can
copy the right one for each provider path.

Verified on **2026-11-09** against:

- the AI Gateway model list (`https://ai-gateway.vercel.sh/v1/models`);
- the OpenRouter model list (`https://openrouter.ai/api/v1/models`);
- the Anthropic [models overview](https://platform.claude.com/docs/en/about-claude/models/overview);
- the OpenAI [models page](https://developers.openai.com/api/docs/models);
- the xAI [models page](https://docs.x.ai/docs/models).

Providers add and retire models often. Check the provider's list before you
pin an id.

## Model ids per provider path

The same model has a different id on each path:

- **Direct providers** (`Anthropic`, `OpenAI`, `XAI`) use the provider's own
  id, for example `claude-opus-5-5`.
- **AI Gateway** (`AIGateway`) uses `vendor/model`, with dots in version
  numbers, for example `anthropic/claude-opus-5.5`. xAI models are under
  `spacexai/`.
- **OpenRouter** (`OpenRouter`) also uses `vendor/model`, but some vendor
  prefixes differ: `x-ai/`, `z-ai/`, `qwen/`, `mistralai/`.

Both gateways also list batch variants (`-batch` on AI Gateway, `:batch` on
OpenRouter) and AI Gateway lists `-fast` variants of some models. They are not
listed here.

## Anthropic

| Model | `Anthropic()` | `AIGateway()` | `OpenRouter()` |
|---|---|---|---|
| Claude Fable 5.1 (most capable) | `claude-fable-5-1` | `anthropic/claude-fable-5.1` | `anthropic/claude-fable-5.1` |
| Claude Opus 5.5 | `claude-opus-5-5` | `anthropic/claude-opus-5.5` | `anthropic/claude-opus-5.5` |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | `anthropic/claude-sonnet-5.5` | `anthropic/claude-sonnet-5.5` |
| Claude Haiku 5.5 (fastest) | `claude-haiku-5-5` | `anthropic/claude-haiku-5.5` | `anthropic/claude-haiku-5.5` |

Anthropic recommends Claude Opus 5.5 for most workloads and Claude Fable 5.1
for demanding reasoning and long-horizon agentic work. Earlier models (Claude
Fable 5, Opus 5, Sonnet 5, Opus 4.x, Sonnet 4.6, Haiku 4.5) are still
available as legacy models.

## OpenAI

| Model | `OpenAI()` | `AIGateway()` | `OpenRouter()` |
|---|---|---|---|
| GPT-6 Astra (most capable) | `gpt-6-astra` | `openai/gpt-6-astra` | `openai/gpt-6-astra` |
| GPT-6.1 Sol (reasoning, coding) | `gpt-6.1-sol` | `openai/gpt-6.1-sol` | `openai/gpt-6.1-sol` |
| GPT-6.1 Terra (fast) | `gpt-6.1-terra` | `openai/gpt-6.1-terra` | `openai/gpt-6.1-terra` |
| GPT-6 Luna (efficient, high volume) | `gpt-6-luna` | `openai/gpt-6-luna` | `openai/gpt-6-luna` |

## xAI

| Model | `XAI()` | `AIGateway()` | `OpenRouter()` |
|---|---|---|---|
| Grok 4.7 | `grok-4.7` | `spacexai/grok-4.7` | `x-ai/grok-4.7` |
| Grok 4.6 | `grok-4.6` | `spacexai/grok-4.6` | `x-ai/grok-4.6` |
| Grok 4.5 | `grok-4.5` | `spacexai/grok-4.5` | `x-ai/grok-4.5` |

## Other vendors (gateways only)

These vendors have no direct factory in this package. Use them through a
gateway, or through `Custom()` with the vendor's OpenAI-compatible endpoint.

| Vendor | Model | `AIGateway()` | `OpenRouter()` |
|---|---|---|---|
| Google | Gemini 4 Argon | `google/gemini-4-argon` | `google/gemini-4-argon` |
| Google | Gemini 3.8 Flash | `google/gemini-3.8-flash` | `google/gemini-3.8-flash` |
| DeepSeek | DeepSeek V4 Pro | `deepseek/deepseek-v4-pro` | `deepseek/deepseek-v4-pro` |
| DeepSeek | DeepSeek V4.1 Flash | `deepseek/deepseek-v4.1-flash` | `deepseek/deepseek-v4.1-flash` |
| Moonshot AI | Kimi K3.1 Pro | `moonshotai/kimi-k3.1-pro` | `moonshotai/kimi-k3.1-pro` |
| Z.ai | GLM 5.3 | `zai/glm-5.3` | `z-ai/glm-5.3` |
| Z.ai | GLM 5.3 Flash | `zai/glm-5.3-flash` | `z-ai/glm-5.3-flash` |
| Alibaba | Qwen 3.8 Flash | `alibaba/qwen3.8-flash` | `qwen/qwen3.8-flash` |
| Mistral | Mistral Large 4 | `mistral/mistral-large-4` | `mistralai/mistral-large-4-0` |
| Mistral | Mistral Medium 3.5 | `mistral/mistral-medium-3.5` | `mistralai/mistral-medium-3-5` |
| Meta | Muse Spark 1.3 | `meta/muse-spark-1.3` | `meta/muse-spark-1.3` |

Gemini models also run natively in ADK (`model: "gemini-..."`) without this
package.

## Local models

Local servers (LM Studio, Ollama, vLLM) serve whatever model you load. Pass
the id the server reports to `Custom()`:

```typescript
import { Custom } from "adk-llm-bridge";

const model = Custom("qwen3", { baseURL: "http://localhost:11434/v1" });
```

## Feature support

A model id says nothing about which ADK features a provider supports for it.
See the [OpenAI-compatible feature matrix](openai-compatible-feature-matrix.md)
for structured output, tool choice, reasoning and media.
