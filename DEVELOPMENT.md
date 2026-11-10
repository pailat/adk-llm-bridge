# Development Guide

This document covers setup, commands, architecture decisions and troubleshooting for contributors. For the contribution workflow, pull requests and project policies, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Project Structure

```
adk-llm-bridge/
├── src/
│   ├── index.ts            # Main entry point, exports the public API
│   ├── config.ts           # Global configuration management
│   ├── constants.ts        # Shared constants
│   ├── types.ts            # Shared types
│   ├── core/               # Base classes, provider definitions, config resolution
│   ├── converters/         # ADK <-> OpenAI request and response conversion
│   ├── providers/          # ai-gateway, openrouter, openai, anthropic, xai, custom
│   ├── agents/             # External agents (Claude, Codex, Gemini CLI)
│   ├── workflows/          # Workflow engine, control plane, durability
│   ├── runtime/            # Agent invocation gateway
│   └── utils/              # JSON, logging, URI and validation helpers
├── tests/                  # Tests, mirroring src/
├── examples/               # Example projects (see examples/README.md)
├── docs/                   # Guides and references (see docs/README.md)
├── scripts/                # Build checks, comment check, conformance runner
├── bunup.config.ts         # Build config (bunup)
└── dist/                   # Built output (generated)
```

## Development Setup

### Prerequisites

- [Bun](https://bun.sh/) >= 1.4.4
- Node.js >= 22.0.0 (CI tests 22, 24 and 26; `mise.toml` pins 26.13.0 for local dev)

### Initial setup

```bash
git clone https://github.com/pailat/adk-llm-bridge.git
cd adk-llm-bridge
bun install
```

### Available commands

| Command | Description |
|---------|-------------|
| `bun run build` | Build the package to `dist/` and fix the private declarations |
| `bun run test` | Run all tests |
| `bun run typecheck` | Type check `src/` only |
| `bun run typecheck:all` | Type check `src/` and `tests/` |
| `bun run typecheck:conformance` | Type check the runtime conformance runner |
| `bun run typecheck:compat:nodenext` | Build, then type check a NodeNext consumer |
| `bun run check:compat:nodenext` | Type check the NodeNext consumer against the current `dist/` (no build) |
| `bun run lint` | Run the Biome linter (whole repo) |
| `bun run lint:fix` | Auto-fix lint issues |
| `bun run format` | Check formatting |
| `bun run format:fix` | Fix formatting |
| `bun run check` | Biome lint, format and import order (enforced by CI) |
| `bun run check:fix` | Auto-fix lint and formatting |
| `bun run check:comments` | Check the [code comment standard](docs/contributing/comments.md) |
| `bun run check:export-docs` | After a build, check that every public export has a TSDoc summary |
| `bun run check:links` | Check relative links and anchors in Markdown files (offline) |
| `bun run lint:publish` | Check the package with `publint` and `attw` |
| `bun run ci` | Full CI: typechecks, Biome check, comment check, link check, tests, one build, package checks and the NodeNext consumer check on that build |

Run a single test file with `bun test <file>`.

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

`@google/adk` reads no `DEBUG` variable. Set the level in your code:

```typescript
import { LogLevel, setLogLevel } from "@google/adk";

setLogLevel(LogLevel.DEBUG);
```

### Common Issues

**1. "Model not found" error**

Check model patterns in provider constants:

```typescript
// src/providers/anthropic/anthropic-llm.ts
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

### OpenAI-compatible provider

OpenAI-compatible providers are declarative: a `ProviderDefinition` plus factory
functions.

1. Create `src/providers/my-provider/definition.ts` with a `ProviderDefinition`
   (`id`, `errorPrefix`, `defaultBaseURL`, `envKeys`, `modelPatterns`, ...).
2. Create `src/providers/my-provider/index.ts` that calls `createProviderClass`,
   `createProviderFactory` and `createRegisterFunction`. Copy
   `src/providers/openai/index.ts` as a template.
3. Export the new symbols from `src/index.ts`.
4. Add tests in `tests/providers/my-provider/`.
5. Create an example in `examples/basic-agent-my-provider/`.

### Provider with a native SDK

Extend `BaseProviderLlm` (see `src/providers/anthropic/`) and add request and
response converters for the SDK format. Then follow steps 3 to 5 above.

## Release Checklist

Releases are tag-driven: pushing a `vX.Y.Z` tag runs `.github/workflows/release.yml`,
which verifies the tag, runs `bun run ci`, publishes to npm with trusted
publishing and provenance, and creates the GitHub release from `CHANGELOG.md`.

1. Update `version` in `package.json`.
2. Bump the `adk-llm-bridge` dependency in every `examples/*/package.json` to the
   new version when an example pins a published version.
3. Add a `CHANGELOG.md` section `## [X.Y.Z]` for the new version.
4. Run `bun run ci`.
5. Test an example against the packed build (see
   [Running Examples Locally](#running-examples-locally)):
   ```bash
   ./scripts/test-example.sh basic-agent-anthropic
   ```
6. Commit everything together on `main`: `chore(release): X.Y.Z`.
7. Create an annotated tag on that commit and push it:
   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin main && git push origin vX.Y.Z
   ```
8. Wait for the Release workflow to finish.
9. If a previously published version is broken, deprecate it:
   ```bash
   npm deprecate adk-llm-bridge@<broken> "Broken; upgrade to >=X.Y.Z. See #NN."
   ```

> **Build note:** the package is built with [`bunup`](https://bunup.dev)
> (`bunup.config.ts`).

## Resources

- [Google ADK Documentation](https://google.github.io/adk-docs/)
- [Google ADK GitHub](https://github.com/google/adk-js)
- [OpenAI API Reference](https://platform.openai.com/docs/api-reference)
- [Anthropic API Reference](https://docs.anthropic.com/en/api)
