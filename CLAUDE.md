# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

adk-llm-bridge connects [Google ADK](https://google.github.io/adk-docs/) ([GitHub](https://github.com/google/adk-js)) to multiple LLM providers (OpenAI, Anthropic, xAI, OpenRouter, AI Gateway), enabling 100+ LLM models with ADK agents while preserving features like multi-agent orchestration, tool calling, and streaming.

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

### Core System

The library uses a **declarative provider definition pattern**: OpenAI-compatible providers are pure config objects (`ProviderDefinition`) + factory functions, eliminating class-per-provider boilerplate.

```
src/core/
├── base-provider-llm.ts      # Abstract base for all providers (extends ADK BaseLlm)
├── openai-compatible-llm.ts   # Base for OpenAI-compatible APIs (uses openai SDK)
├── provider-definition.ts     # ProviderDefinition interface
├── config-resolver.ts         # Centralized config resolution (apiKey, baseURL, headers)
├── create-provider.ts         # createProviderClass() / createProviderFactory()
├── create-register.ts         # createRegisterFunction() (singleton pattern)
└── index.ts                   # Core barrel exports
```

### Adding a New OpenAI-Compatible Provider

1. Create `src/providers/{name}/definition.ts` with a `ProviderDefinition` object
2. Create `src/providers/{name}/index.ts` using `createProviderClass` + `createProviderFactory` + `createRegisterFunction`
3. Export from `src/index.ts`

### Provider Structure

**OpenAI-compatible providers** (OpenAI, xAI, OpenRouter, AI Gateway):
```
src/providers/{name}/
├── definition.ts   # ProviderDefinition config (baseURL, envKeys, modelPatterns, etc.)
└── index.ts        # Generated LLM class, factory, and register functions
```

**Anthropic** (native SDK, not OpenAI-compatible):
```
src/providers/anthropic/
├── anthropic-llm.ts           # Custom class using @anthropic-ai/sdk
├── converters/request.ts      # ADK → Anthropic format
├── converters/response.ts     # Anthropic → ADK format (streaming accumulator)
└── index.ts                   # Factory + registration
```

### Converters (shared by OpenAI-compatible providers)

```
src/converters/
├── request.ts     # ADK LlmRequest → OpenAI ChatCompletion format
└── response.ts    # OpenAI response → ADK LlmResponse (streaming + non-streaming)
```

### Configuration Priority

API keys/URLs resolve in order: instance config → global config (via `setProviderConfig`) → environment variables.

### JSON Safety

`src/utils/json.ts` provides `safeJsonParse` which pre-processes large integers (17+ digits) to prevent IEEE 754 precision loss before `JSON.parse`.

## Testing

Tests use Bun's test runner. Shared helpers in `tests/helpers/provider-test-helpers.ts` reduce boilerplate for registration, factory, model pattern, and connect tests.

```bash
bun test tests/providers/openai/  # Provider tests
bun test tests/converters/        # Converter tests
bun test tests/utils/             # Utility tests
bun test --watch                  # Watch mode
```

## Running Examples

Examples require running from their directory (Bun loads `.env` from cwd):

```bash
cd examples/basic-agent && bun install && bun run web  # DevTools UI
cd examples/programmatic && bun run start              # CLI usage
```
