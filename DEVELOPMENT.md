# Development Guide

This document covers internal development workflows, architecture decisions, and troubleshooting for contributors.

## Project Structure

```
adk-llm-bridge/
├── src/
│   ├── index.ts                 # Main entry point, exports all public APIs
│   ├── config.ts                # Global configuration management
│   ├── constants.ts             # Shared constants (URLs, patterns)
│   ├── types.ts                 # TypeScript type definitions
│   ├── core/
│   │   ├── base-provider-llm.ts # Abstract base class for all providers
│   │   └── openai-compatible-llm.ts # Base class for OpenAI-compatible APIs
│   ├── converters/
│   │   ├── request.ts           # ADK → OpenAI request conversion
│   │   └── response.ts          # OpenAI → ADK response conversion
│   └── providers/
│       ├── ai-gateway/          # Vercel AI Gateway provider
│       ├── openrouter/          # OpenRouter provider
│       ├── openai/              # OpenAI direct provider
│       ├── anthropic/           # Anthropic direct provider (native SDK)
│       ├── xai/                 # xAI direct provider
│       └── custom/              # Custom/generic provider
├── tests/                       # Test files (mirrors src/ structure)
├── examples/                    # Example projects
│   ├── basic-agent-anthropic/
│   ├── basic-agent-ai-gateway/
│   ├── basic-agent-openai/
│   ├── basic-agent-xai/
│   ├── basic-agent-openrouter/
│   ├── basic-agent-lmstudio/
│   └── express-server/
├── bunup.config.ts             # Build config (bunup)
├── scripts/
│   └── test-example.sh          # Test examples with npm pack
└── dist/                        # Built output (generated)
```

## Development Environment Setup

### Prerequisites

- [Bun](https://bun.sh/) >= 1.4.4
- Node.js >= 22.0.0

### Initial Setup

```bash
git clone https://github.com/pailat/adk-llm-bridge.git
cd adk-llm-bridge
bun install
```

### Available Commands

| Command | Description |
|---------|-------------|
| `bun run build` | Build the package to `dist/` |
| `bun run test` | Run all tests |
| `bun run typecheck` | Type check `src/` only |
| `bun run typecheck:all` | Type check `src/` + `tests/` |
| `bun run lint` | Run Biome linter (whole repo) |
| `bun run check` | Biome lint + format + import order (enforced by CI, 0 warnings) |
| `bun run lint:fix` | Auto-fix lint issues |
| `bun run check:fix` | Auto-fix lint + formatting |
| `bun run ci` | Full CI: typecheck + Biome check + test + build |

## Running Examples Locally

### The Problem with `file:../..`

Examples use `"adk-llm-bridge": "file:../..` for local development. This creates **duplicate copies** of `@google/adk`:

```
example/node_modules/
├── @google/adk@2.4.0          # Copy 1
└── adk-llm-bridge/
    └── node_modules/
        └── @google/adk@2.4.0  # Copy 2 (symlink to root)
```

This causes TypeScript errors because ADK uses a private symbol (`BASE_MODEL_SYMBOL`) for type checking:

```
Type 'AnthropicLlm' is not assignable to type 'BaseLlm'.
Property '[BASE_MODEL_SYMBOL]' is missing in type 'AnthropicLlm'
```

**Important:** This is a **development-only issue**. In production (npm install), `peerDependencies` correctly deduplicate the package.

### Solution: Use `npm pack`

The `test-example.sh` script simulates production by using `npm pack`:

```bash
# Test any example
./scripts/test-example.sh basic-agent-anthropic

# What it does:
# 1. Builds the library
# 2. Creates tarball with npm pack (simulates npm publish)
# 3. Installs tarball in example (peerDeps work correctly)
# 4. Runs the example
```

### Manual Testing

```bash
# 1. Build and pack
bun run build
npm pack

# 2. Install in example
cd examples/basic-agent-anthropic
rm -rf node_modules package-lock.json bun.lock
npm install ../../adk-llm-bridge-*.tgz

# 3. Verify single @google/adk
npm ls @google/adk
# Should show "deduped"

# 4. Run
bun run web
```

### Quick Testing (Accept IDE Errors)

If you just want to quickly test without fixing types:

```bash
cd examples/basic-agent-anthropic
bun install
bun run web  # Works at runtime despite IDE errors
```

The TypeScript errors in your IDE are cosmetic; the code runs correctly.

## Architecture Decisions

### ADR 001: Factory Functions vs Registry Pattern

**Context:** Users can create LLM instances two ways:

1. **Factory Functions** (recommended):
   ```typescript
   import { Anthropic } from "adk-llm-bridge";
   const agent = new LlmAgent({ model: Anthropic("claude-sonnet-4-5") });
   ```

2. **Registry Pattern** (for adk-devtools):
   ```typescript
   import { LLMRegistry } from "@google/adk";
   import { AnthropicLlm } from "adk-llm-bridge";
   LLMRegistry.register(AnthropicLlm);
   const agent = new LlmAgent({ model: "claude-sonnet-4-5" });
   ```

**Decision:** Support both, but recommend Factory for most users.

**Rationale:**
- Factory is more explicit and type-safe
- Registry is needed for adk-devtools integration
- Both work correctly in production

### ADR 002: TypeScript Type Compatibility

**Context:** ADK's `BaseLlm` uses a private symbol:

```typescript
// In @google/adk (NOT exported)
const BASE_MODEL_SYMBOL = Symbol.for('google.adk.baseModel');

export abstract class BaseLlm {
  readonly [BASE_MODEL_SYMBOL] = true;
}
```

When there are duplicate `@google/adk` packages, TypeScript sees two different symbols and fails type checking.

**Decision:**
- Factories return specific types (e.g., `AnthropicLlm`), not `any`
- Use `peerDependencies` in package.json (already configured)
- Provide `npm pack` workflow for local testing

**Rejected Alternatives:**
- `return type any` - Loses type safety
- `as unknown as BaseLlm` - Code smell, doesn't solve root cause
- Module augmentation - Doesn't work with `unique symbol`

### ADR 003: Provider Architecture

**Context:** Need to support multiple LLM providers with different APIs.

**Decision:** Three-layer architecture:

```
BaseProviderLlm (abstract)
├── OpenAICompatibleLlm (for OpenAI-format APIs)
│   ├── AIGatewayLlm
│   ├── OpenRouterLlm
│   ├── OpenAILlm
│   ├── XAILlm
│   └── CustomLlm
└── AnthropicLlm (native Anthropic SDK)
```

**Rationale:**
- Most providers use OpenAI-compatible format
- Anthropic has a native SDK with better features
- Easy to add new providers by extending appropriate base

## Debugging

### Enable Debug Logs

```bash
DEBUG=adk:* bun run web
```

### Common Issues

**1. "Model not found" error**

Check model patterns in provider constants:

```typescript
// src/providers/anthropic/constants.ts
export const ANTHROPIC_MODEL_PATTERNS = [/claude-.*/];
```

ADK's `LLMRegistry` adds `^...$` anchors automatically, so patterns should NOT include them.

**2. Tool calls not working**

Enable request/response logging:

```typescript
// Add to your code temporarily
console.log('Request:', JSON.stringify(llmRequest, null, 2));
```

**3. Streaming issues**

Check if the provider supports streaming and the client handles SSE correctly.

**4. Web UI "Sessions" tab empty / `TypeError: i.sort is not a function`**

Upstream `@google/adk-devtools` bug (not ours): the dev-ui frontend calls `.sort()` on
the paginated `listSessions` response object instead of `response.sessions`. Sessions
still persist; verify via `curl http://localhost:8000/apps/<app>/users/<user>/sessions`
or the `express-server` example. Tracked upstream against `google/adk-js`.

### Running Specific Tests

```bash
# Single file
bun test tests/providers/anthropic/factory.test.ts

# Watch mode
bun test --watch

# With pattern
bun test --grep "Anthropic"
```

## Adding a New Provider

1. Create provider directory:
   ```
   src/providers/my-provider/
   ├── constants.ts      # MODEL_PATTERNS, ENV vars
   ├── my-provider-llm.ts
   ├── factory.ts        # MyProvider() function
   ├── register.ts       # registerMyProvider()
   └── index.ts          # Re-exports
   ```

2. Extend appropriate base class:
   ```typescript
   // For OpenAI-compatible APIs
   export class MyProviderLlm extends OpenAICompatibleLlm { ... }

   // For native SDKs
   export class MyProviderLlm extends BaseProviderLlm { ... }
   ```

3. Add to `src/index.ts`:
   ```typescript
   export { MyProvider, MyProviderLlm, registerMyProvider } from "./providers/my-provider";
   ```

4. Add tests in `tests/providers/my-provider/`

5. Create example in `examples/basic-agent-my-provider/`

## Release Checklist

1. Update `version` in `package.json`
2. Bump the `adk-llm-bridge` dependency in every `examples/*/package.json` to the
   new version (keep the caret range, e.g. `^0.5.2`)
3. Add a `CHANGELOG.md` entry for the new version
4. Run full CI: `bun run ci` (typecheck + lint + test + build + `publint`/`attw` gates)
5. Test an example with `npm pack` (simulates production install, dedupes `@google/adk`):
   ```bash
   ./scripts/test-example.sh basic-agent-anthropic
   ```
6. Commit everything together: `chore: release vX.Y.Z`
7. Create an annotated git tag on that commit and push both:
   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin main && git push origin vX.Y.Z
   ```
8. Publish to npm (the `prepublishOnly` hook re-runs build + `publint`/`attw`):
   ```bash
   npm publish --provenance --access public
   ```
9. Create the GitHub Release from the tag (`gh release create vX.Y.Z --generate-notes`)
10. If a previously published version is broken, deprecate it:
    ```bash
    npm deprecate adk-llm-bridge@<broken> "Broken; upgrade to >=X.Y.Z. See #NN."
    ```

> **Build note:** the package is built with [`bunup`](https://bunup.dev)
> (`bunup.config.ts`); there is no longer a `scripts/build.ts`. `scripts/` now
> contains only `test-example.sh`.

## Resources

- [Google ADK Documentation](https://google.github.io/adk-docs/)
- [Google ADK GitHub](https://github.com/google/adk-js)
- [OpenAI API Reference](https://platform.openai.com/docs/api-reference)
- [Anthropic API Reference](https://docs.anthropic.com/en/api)
