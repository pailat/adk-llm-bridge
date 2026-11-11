# Prompt caching

Anthropic models bill a repeated prompt prefix at a fraction of the normal input price, but only when the request marks where the cache breakpoints go. A multi-turn `LlmAgent` re-sends its system instruction, tools and earlier turns on every call, so without markers each turn pays the full prompt again.

Since 0.7.0 the bridge adds those markers for Anthropic models by default, but only on a request that can be reused (see [Automatic by default](#automatic-by-default)). It changes the HTTP body only: the `LlmRequest` that ADK callbacks and plugins see (contents, roles, tool order) is not touched.

## What is on by default

With `promptCaching` unset the default is automatic: markers go out only when the request declares a tool or already holds an earlier model turn.

| Provider | Default | What is sent |
|----------|---------|--------------|
| `AnthropicLlm` (native) | Automatic | `cache_control` on the system block, the last tool and the last block of the last message (3 of the 4 allowed breakpoints; one stays free) |
| `AIGateway`, `anthropic/*` models | Automatic | `providerOptions.gateway.caching = "auto"`; the gateway places the markers |
| `OpenRouter`, `anthropic/*` models | Off (opt-in) | with `promptCaching: true`, a top-level `cache_control` |
| OpenAI, xAI, custom endpoints | Not applicable | Nothing: OpenAI and xAI cache implicitly, and `cached_tokens` is already reported |

## Automatic by default

With `promptCaching` unset, the bridge decides on each call. It sends markers when the request:

- declares at least one tool supplied by the caller (the synthetic `json_output` tool used for structured output does not count), or
- already holds an earlier model turn in its contents (including one that only carries tool calls).

Every call of a tool loop declares tools, so a loop caches from its first call and the second call reads it. A one-shot call (no tools, no earlier model turn, for example a workflow step with `includeContents: "none"`) sends no marker, and its body is identical to `promptCaching: false`: a write that nothing can read back would only add the 25% surcharge.

Things to know:

- Several one-shot calls that share a large instruction within 5 minutes can read each other's cache. Set `promptCaching: true` to keep markers on for them.
- A chat with history but no tools writes from its second turn, so turn 2 pays one write and turn 3 onward reads.
- An agent that shares a session and sees other agents' model turns counts as reusable; set `promptCaching: false` on it, or use `includeContents: "none"`, if its prefix is never read back.

OpenRouter is opt-in because the top-level `cache_control` is documented but has not been probed against every backend OpenRouter can route `anthropic/*` to (Bedrock, Vertex), where an unsupported marker may be rejected with a 400. The bridge never retries on a 400, because a silent retry would double the spend.

## The `promptCaching` option

```ts
import { AIGateway, AnthropicLlm, OpenRouter } from "adk-llm-bridge";

AIGateway("anthropic/claude-haiku-5.5"); // automatic
AIGateway("anthropic/claude-haiku-5.5", { promptCaching: true }); // always on
AIGateway("anthropic/claude-haiku-5.5", { promptCaching: false }); // off
new AnthropicLlm({ model: "claude-sonnet-5-5", promptCaching: { ttl: "1h" } });
OpenRouter("anthropic/claude-sonnet-5.5", { promptCaching: true }); // opt-in
```

- Unset (native, AI Gateway): automatic, see above. 5-minute lifetime.
- `true`: on for every call, 5-minute lifetime.
- `{ ttl: "5m" | "1h" }`: on for every call with that lifetime. The same TTL goes on every marker.
- `false`: no marker of any kind.
- It resolves as instance config, then `setProviderConfig` / `register*` options, then the default.
- On AI Gateway and OpenRouter an explicit `true` also applies to models that are not `anthropic/*`.
- AI Gateway's chat endpoint supports the 5-minute lifetime only. `ttl: "1h"` logs the warning `PROMPT_CACHE_TTL_IGNORED` once and uses 5 minutes.

## Cost

A cache write costs 1.25x the base input price (2x with the 1-hour lifetime) and a cache read costs 0.1x or less (0.05x on Sonnet 5.5 and Opus 5.5). For a prefix of `P` tokens reused `k` times within the lifetime:

- cached: `1.25P + 0.1kP`
- not cached: `(k + 1)P`

Caching wins from the first reuse (the second turn). With the 1-hour lifetime it wins from the second reuse. A call that is never reused pays the 25% write surcharge on the input it writes, for nothing. The automatic default skips markers on one-shot calls for that reason; set `promptCaching: false` to turn them off everywhere.

Below the model's minimum cacheable size (512 tokens on Haiku 5.5, Sonnet 5.5 and Opus 5.5; 1,024 on Sonnet 5 and 4.x and Opus 4.8; 2,048 on Opus 4.7; 4,096 on Haiku 4.5 and Opus 4.6 and 4.5; check the [Anthropic prompt caching page](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) for other models) the request is processed without caching, with no error and no surcharge.

The cache looks back at most 20 positions from a breakpoint, and a run of consecutive `tool_use` blocks counts as one position, as does a run of consecutive `tool_result` blocks, so a parallel tool fan-out does not push the previous entry out of the window. A turn that adds more than 20 positions of other content (many text or image blocks, or a long sequential tool loop inside one request) can; the conversation part then misses, and the system and tools prefix still hits.

### Measured on AI Gateway

One probe on 2026-11-11: `LlmAgent` on `AIGateway("anthropic/claude-haiku-5.5")` with one `read_file` tool, a deterministic 3,000-token instruction and three files of about 2,000 tokens, read one per turn (four model calls). Costs are the gateway's `usage.cost_details.upstream_inference_cost`.

| Call | Prompt | Without caching | With caching (automatic, tool loop) | Read | Written |
|------|--------|-----------------|------------------------|------|---------|
| 1 | 6,320 | $0.000690 | $0.000848 | 0 | 6,316 |
| 2 | 8,466 | $0.000872 | $0.000357 | 6,316 | 2,148 |
| 3 | 10,619 | $0.001087 | $0.000379 | 8,464 | 2,153 |
| 4 | 12,772 | $0.001290 | $0.000387 | 10,617 | 2,153 |
| Total | | $0.003938 | $0.001971 | | |

The first call cost 23% more; the four calls together cost half. This is one model and one task, not a benchmark.

## Reading the cache usage

- `usageMetadata.cachedContentTokenCount`: tokens read from the cache.
- `customMetadata.cacheCreationTokenCount`: tokens written to the cache. genai has no cache-write field, so it rides on the ADK `customMetadata`, next to `logprobs`. The count comes from the provider response before callbacks run; an `afterModelCallback` that replaces `customMetadata` drops it.
  - Anthropic: `cache_creation_input_tokens`.
  - AI Gateway: the top-level `usage.cache_creation_input_tokens`.
  - OpenRouter: `usage.prompt_tokens_details.cache_write_tokens`.
  - `ExternalAgent`: `cacheCreationInputTokens` of the run's usage.
- `promptTokenCount` includes reads and writes on Anthropic and on AI Gateway (verified in the probe: 8,466 = 6,316 read + 2,148 written + 2 uncached). On other providers it is as the provider reports.
- Span attributes on the model-call span: `gen_ai.usage.cache_read.input_tokens` and `gen_ai.usage.cache_creation.input_tokens`, set only when the provider reported them.
- `AgentInvocationUsage` and `WorkflowStepUsage` gain an optional `cacheCreationTokens`, summed on non-partial events only. It is absent when no provider in the run reported a write, and it is part of `promptTokens`, not added on top.
