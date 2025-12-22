# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

adk-llm-bridge connects [Google ADK](https://google.github.io/adk-docs/) ([GitHub](https://github.com/google/adk-js)) to [Vercel AI Gateway](https://vercel.com/ai-gateway), enabling 100+ LLM models (Claude, GPT-4, Llama, etc.) with ADK agents while preserving features like multi-agent orchestration, tool calling, and streaming.

## Commands

```bash
bun install          # Install dependencies
bun run build        # Build package (bundles to dist/)
bun run test         # Run all tests
bun test <file>      # Run specific test file
bun run typecheck    # Type check src only
bun run typecheck:all # Type check src + tests
bun run lint         # Run Biome linter
bun run lint:fix     # Auto-fix lint issues
bun run check:fix    # Auto-fix lint + formatting
bun run ci           # Full CI: typecheck:all + lint + test + build
```

## Architecture

The package bridges ADK's LLM interface to the OpenAI-compatible AI Gateway API:

```
ADK LlmRequest → converters/request.ts → OpenAI format
                         ↓
                  OpenAI API call
                         ↓
ADK LlmResponse ← converters/response.ts ← OpenAI response
```

### Key Components

- **`AIGatewayLlm`** (`src/ai-gateway-llm.ts`): Main LLM class extending `BaseLlm` from ADK. Handles both streaming and non-streaming generation via the OpenAI client.

- **`AIGateway()`** (`src/ai-gateway.ts`): Factory function for creating LLM instances with a clean API.

- **`registerAIGateway()`** (`src/register.ts`): Registers with ADK's `LLMRegistry` for string-based model names. Required for `adk-devtools` compatibility.

- **Converters** (`src/converters/`):
  - `request.ts`: Converts ADK `LlmRequest` to OpenAI message format, including tool/function declarations and Gemini-style schema normalization (UPPERCASE → lowercase types)
  - `response.ts`: Converts OpenAI responses to ADK `LlmResponse`, handling both regular and streaming responses with tool call accumulation

### Model Pattern

Models use `provider/model` format (e.g., `anthropic/claude-sonnet-4`). The pattern `/^.+\/.+$/` matches any valid model string; AI Gateway validates availability at runtime.

### Configuration Priority

API keys/URLs resolve in order: instance config → global config (via `setConfig`) → environment variables (`AI_GATEWAY_API_KEY` or `OPENAI_API_KEY`).

## Testing

Tests use Bun's test runner with mocking. Test structure mirrors `src/`:

```bash
bun test tests/register.test.ts  # Single file
bun test --watch                  # Watch mode
```

## Running Examples

Examples require running from their directory (Bun loads `.env` from cwd):

```bash
cd examples/basic-agent && bun install && bun run web  # DevTools UI
cd examples/programmatic && bun run start              # CLI usage
```
