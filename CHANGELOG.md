# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.3] - 2026-06-19

### Added

- **Native model config passthrough** ([#76]). The provider converters now
  forward the full `LlmRequest.config` (a `@google/genai` `GenerateContentConfig`)
  to each provider instead of dropping everything but `systemInstruction`,
  `contents`, and tool `functionDeclarations`. Covers both the OpenAI-compatible
  family (OpenAI/xAI/OpenRouter/AI Gateway/Custom) and the Anthropic native
  provider:
  - Sampling/generation config (`temperature`, `topP`, `topK`,
    `maxOutputTokens`, `stopSequences`, `seed`, presence/frequency penalties,
    `candidateCount`, logprobs).
  - `tool_choice` (from `toolConfig.functionCallingConfig`).
  - `finishReason` (provider finish/stop reason → ADK `FinishReason`).
  - Streaming token usage (OpenAI `stream_options.include_usage`).
  - Multimodal image input (`inlineData`/`fileData` → OpenAI `image_url` /
    Anthropic image + document blocks).
  - Structured output (`responseSchema` → OpenAI `response_format` json_schema /
    Anthropic forced `json_output` tool).
  - Reasoning/thinking input + output (`thinkingConfig` → OpenAI
    `reasoning_effort`, model-gated with `max_completion_tokens`; Anthropic
    extended thinking with a signed thinking-block round-trip), surfaced as ADK
    thought parts + `thoughtsTokenCount`.
  - Anthropic prompt caching (opt-in instance config).
  - Gemini-only tools/config are filtered cleanly with a one-time warning.
  Provider-API forbidden combinations are reconciled and verified against the
  live APIs (e.g. Anthropic drops sampling params and forced `tool_choice` when
  thinking is enabled). Public API is additive; no existing signatures changed.

### Changed

- Tested and built against `@google/adk@1.2.0` ([#75]): dev dependency bumped to
  `^1.2.0`, peer range tightened to `>=0.5.0 <2`, and all examples updated to
  `@google/adk@^1.2.0`. `src/` is compatible with both 0.5.x and 1.2.x.
- Examples: `express-server` uses the `Context` type (the non-existent
  `ToolContext` import is gone) and reports `updatedAt` from `listSessions`; all
  examples bumped `zod` to `^4.2.1` for ADK 1.2.0 type compatibility.

### Fixed

- Hardening from an internal review of the passthrough feature (all additive,
  no public API change):
  - **Anthropic structured output now works with ADK `outputSchema`/`outputKey`.**
    The emulated `json_output` tool result is surfaced as JSON **text** (not a
    dispatchable `functionCall`), so ADK populates `session.state[outputKey]`
    and treats the turn as final — matching the OpenAI path.
  - Anthropic `maxOutputTokens <= 0` no longer sends `max_tokens: 0` (rejected
    by the API); it falls back to the instance default.
  - Anthropic `thinkingConfig.thinkingBudget <= 0` now disables thinking
    (consistent with the OpenAI path) instead of forcing it on at the minimum
    budget.
  - OpenAI-compatible: `candidateCount`/`n` is dropped for reasoning models
    (gpt-5/o-series reject `n > 1`), and `top_logprobs` is clamped to `0..20`.
  - A one-time warning is emitted when image parts on a non-user turn are
    dropped, and when a forced `tool_choice` is downgraded under Anthropic
    extended thinking.

### Docs

- Documented the upstream `@google/adk-devtools` web-UI "Sessions" tab
  limitation and clarified the `LLMRegistry.register` vs factory-pattern
  distinction.

## [0.5.2] - 2026-06-18

### Fixed

- **Runtime import from the package entry now works again** ([#73]). `0.5.1`'s
  `dist/index.js` was a single `export { ... }` statement referencing ~40
  symbols that were never declared, so `import { Custom } from "adk-llm-bridge"`
  failed at runtime (`Export 'AIGateway' is not defined` on Node, `"Custom" is
  not declared in this file` on Bun). Root cause: the build bundled+minified the
  pure re-export barrel `src/index.ts` into one file with `"sideEffects": false`,
  so dead-code elimination dropped the bindings while keeping the export list.

### Changed

- Build migrated from a hand-rolled `Bun.build()` script to
  [`bunup`](https://bunup.dev), which emits the JS and matching `.d.ts` from one
  plan (no more JS/types structure mismatch).
- Removed `"sideEffects": false` from `package.json`. **Note for consumers:** the
  package no longer asserts it is side-effect-free, so bundlers are more
  conservative when tree-shaking unused re-exports. Registration is still
  explicit (no import-time side effects), so this is safe; it only affects how
  aggressively a downstream bundler can drop unused modules.
- `prepublishOnly` and `ci` now run packaging gates: `publint --strict` and
  `@arethetypeswrong/cli --pack --profile esm-only`.
- Pinned the toolchain to Bun 1.3.14 / Node 25.9.0 via `mise.toml`.
- Examples refreshed to each provider's current model (AI Gateway / Anthropic
  `claude-sonnet-4.6`, OpenAI `gpt-5.5`, xAI `grok-4.3`, OpenRouter
  `z-ai/glm-5.2`) and bumped to depend on `^0.5.2`.

### Removed

- `scripts/build.ts` and `scripts/fix-declaration-imports.mjs` (superseded by
  `bunup`, which emits correct ESM import specifiers).

[0.5.3]: https://github.com/pailat/adk-llm-bridge/releases/tag/v0.5.3
[0.5.2]: https://github.com/pailat/adk-llm-bridge/releases/tag/v0.5.2
[#73]: https://github.com/pailat/adk-llm-bridge/issues/73
[#75]: https://github.com/pailat/adk-llm-bridge/pull/75
[#76]: https://github.com/pailat/adk-llm-bridge/pull/76
