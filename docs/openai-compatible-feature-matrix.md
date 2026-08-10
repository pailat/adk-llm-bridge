# OpenAI-compatible feature degradation and capability matrix

This is the canonical compatibility reference for ADK requests sent through
`adk-llm-bridge`. It covers the OpenAI Chat Completions bridge used by OpenAI,
OpenRouter, xAI, Vercel AI Gateway, and Custom providers, plus the separate
native Anthropic Messages implementation.

The matrix describes both conversion behavior and the point at which a runtime
or model takes over. It does not claim that every model exposed by a provider
implements every feature.

## Classification

- **Supported** — the bridge has a faithful mapping and the provider surface is
  expected to accept it.
- **Degraded** — the bridge preserves only part of the intent, rewrites it, or
  removes conflicting fields to keep the request valid.
- **Provider-dependent** — the bridge forwards or maps the feature, but the
  selected server, routed provider, runtime version, or model decides whether it
  works.
- **Unsupported** — there is no faithful implementation on this path. The
  bridge drops or rejects the field, or the method always throws.

These labels are about the complete path. A conversion can be supported while
the end-to-end feature remains provider-dependent.

## Matrix

| Feature | OpenAI | OpenRouter | xAI | AI Gateway | Custom / Ollama | Custom / vLLM | Custom / LM Studio | Native Anthropic | Bridge behavior |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Non-streaming text | Supported | Supported | Supported | Supported | Supported | Supported | Supported | Supported | All paths convert text requests and terminal responses. |
| Token streaming | Supported | Supported | Supported | Supported | Supported | Supported | Supported | Supported | `generateContentAsync(..., true)` is unidirectional streaming; this is separate from live `connect()`. |
| Function tools: declaration, call, result, final answer | Supported | Provider-dependent | Supported | Provider-dependent | Provider-dependent | Provider-dependent | Provider-dependent | Supported | The bridge maps function schemas and correlates tool calls/results; the selected model must actually support tool use. |
| Streamed tool-call argument reconstruction | Supported | Supported | Supported | Supported | Supported | Supported | Supported | Supported | The bridge buffers fragmented arguments and emits one parsed function call. Custom-runtime fixtures exercise fragmented SSE arguments. |
| Request cancellation with `AbortSignal` | Supported | Supported | Supported | Supported | Supported | Supported | Supported | Supported | The signal is passed to the provider SDK. Custom-runtime conformance also requires no response after cancellation. |
| Structured JSON output | Provider-dependent | Provider-dependent | Provider-dependent | Provider-dependent | Provider-dependent | Provider-dependent | Provider-dependent | Degraded | OpenAI-compatible paths map schemas to `response_format`; support varies by runtime/model. Anthropic emulates schemas with a forced synthetic `json_output` tool and becomes best-effort when thinking is enabled. |
| Tool choice (`AUTO`, `NONE`, `ANY`, `VALIDATED`) | Provider-dependent | Provider-dependent | Provider-dependent | Provider-dependent | Provider-dependent | Provider-dependent | Provider-dependent | Degraded | OpenAI-compatible modes map to `auto`, `none`, `required`, or one named function. Anthropic maps to native choices, but forced choices are downgraded to `{ type: "auto" }` during extended thinking. |
| Reasoning / thinking extensions | Degraded | Provider-dependent | Degraded | Provider-dependent | Degraded | Degraded | Degraded | Degraded | Direct OpenAI/xAI and Custom bucket the budget into model-gated `reasoning_effort` and drop it for unrecognized IDs. OpenRouter/AI Gateway forward a native `reasoning` object whose execution varies by routed model. Anthropic uses extended thinking but normalizes unsupported budgets and reconciles conflicting controls. |
| Sampling controls (`temperature`, `topP`, stop, seed, penalties) | Degraded | Degraded | Provider-dependent | Degraded | Degraded | Degraded | Degraded | Degraded | Standard controls are allowlisted, but incompatible controls are removed for recognized OpenAI reasoning models. Anthropic clamps/reconciles sampling and has no seed or penalty equivalents. |
| `topK` | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Degraded | The OpenAI-compatible converter intentionally drops `topK` because Chat Completions has no equivalent. Anthropic maps `top_k`, except that extended thinking removes it. |
| Log probabilities | Degraded | Degraded | Degraded | Degraded | Degraded | Degraded | Degraded | Unsupported | The OpenAI-compatible bridge forces `logprobs: true` when needed, clamps `top_logprobs` to `0`–`20`, and removes both fields for recognized OpenAI reasoning models. Runtime acceptance may still vary. Native Anthropic does not map them. |
| Multiple candidates (`candidateCount` greater than 1) | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | OpenAI-compatible requests accept exactly `1` or omission and reject every other value before the provider call. Native Anthropic has no equivalent and drops the field. |
| User-turn inline image data | Provider-dependent | Provider-dependent | Provider-dependent | Provider-dependent | Provider-dependent | Provider-dependent | Provider-dependent | Provider-dependent | The bridge maps base64 image data; the selected model must support image input. |
| User-turn HTTP(S) image URLs | Provider-dependent | Provider-dependent | Provider-dependent | Provider-dependent | Provider-dependent | Provider-dependent | Provider-dependent | Provider-dependent | The bridge forwards HTTP(S) image URLs; the server/model must be able to fetch and understand them. |
| `gs://` or other non-HTTP `fileData` | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | The bridge emits `dropping non-http fileData URI: ...` and does not forward the URI. |
| Audio or video input | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | These paths emit `dropping unsupported inlineData mime type: ...` or `dropping unsupported fileData mime type: ...`. |
| PDF document input | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Provider-dependent | The OpenAI-compatible converter accepts images only. Native Anthropic maps inline and HTTP(S) `application/pdf` documents, subject to model/API support. |
| Images on assistant/model turns | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Provider-dependent | The OpenAI-compatible path emits `dropping image part(s) on an assistant/model turn` and keeps text/tool calls. The native Anthropic converter does not apply that OpenAI-specific drop; the Anthropic API/model remains the arbiter. |
| Gemini-only built-ins | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Only `functionDeclarations` are converted. `googleSearch`, `googleSearchRetrieval`, `codeExecution`, `urlContext`, `retrieval`, `googleMaps`, and the other recognized Gemini-only fields are dropped with one warning per request. |
| Live/bidirectional `connect()` | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Every bridge provider inherits `connect()` that throws `does not support bidirectional streaming`. Use normal streaming plus an application-managed turn loop. |
| Custom `providerOptions` request-body fields | Unsupported | Unsupported | Unsupported | Unsupported | Provider-dependent | Provider-dependent | Provider-dependent | Unsupported | `providerOptions` is a Custom-provider escape hatch. Its non-standard fields are spread into the final request body; only the target server can define their meaning. |

## Bridge behavior versus runtime capability

The bridge boundary answers “what will be sent?” The runtime boundary answers
“will this endpoint and model honor it?”

- A **bridge drop** is deterministic. Changing models cannot restore `topK` on
  an OpenAI-compatible path, Gemini-only built-ins, audio/video, `gs://` data,
  assistant-turn images on the OpenAI-compatible path, or `connect()`. Native
  Anthropic instead maps `topK` to `top_k` unless extended thinking requires it
  to be removed.
- A **degraded** reasoning or logprobs entry records a deterministic bridge
  rewrite or drop, even when the resulting request is also subject to model
  support. Strict reasoning paths bucket or omit controls; logprobs are clamped
  and are removed for recognized OpenAI reasoning models.
- A **provider-dependent** entry means the bridge produced a wire shape, not
  that the model will follow it. This is especially important for structured
  output, tool choice, image input, and gateway-routed reasoning.
- A Custom runtime name is not enough to establish support. Runtime version,
  served model ID, launch flags, chat template, and tool parser can all change
  the result.

The deterministic and real-runtime checks are documented in
[Runtime conformance](./runtime-conformance.md). The matrix is updated with
those conformance fixtures and exact runtime/model reports. Fixture success
proves bridge protocol behavior; it does not prove every model served by
Ollama, vLLM, or LM Studio. Current runtime conformance does not cover
multimodal input, reasoning extensions, logprobs, or live connections; those
rows remain grounded in converter/provider behavior and focused unit tests.

## Intentional request conversion

### Candidate count

After issue #88, every OpenAI-compatible request must omit `candidateCount` or
set it to exactly `1`. The bridge returns one ADK `LlmResponse` per provider
response and cannot represent multiple Chat Completions choices faithfully, so
all other values are rejected with:

```text
candidateCount must be exactly 1 when provided: adk-llm-bridge returns one ADK LlmResponse per provider response and cannot represent multiple Chat Completions choices. Set candidateCount to 1 or omit it.
```

Native Anthropic also cannot produce multiple ADK candidates, but its native
converter drops `candidateCount` rather than applying the OpenAI-compatible
validation.

If several alternatives are required, issue separate requests and rank their
independent responses:

```ts
// Application-level pseudocode: each call creates a separate ADK run.
const alternatives = await Promise.all(
  prompts.map((prompt) => runOnce(prompt)),
);
```

### Sampling, logprobs, and reasoning

The OpenAI-compatible converter uses a strict allowlist; ADK config is never
spread wholesale into Chat Completions.

- For recognized OpenAI reasoning IDs (`gpt-5*` and the `o1`, `o3`, and `o4`
  families), the bridge uses `max_completion_tokens` and removes `temperature`,
  `top_p`, stop sequences, presence/frequency penalties, `logprobs`, and
  `top_logprobs`, because those APIs reject the fields.
- When logprobs are otherwise allowed, setting ADK `logprobs` also sends
  OpenAI-compatible `logprobs: true` and clamps `top_logprobs` into the
  accepted `0`–`20` range.
- Direct OpenAI and xAI use a strict, model-name-gated
  `reasoning_effort`. Unknown or non-reasoning model IDs do not receive it.
- OpenRouter and AI Gateway receive the provider-native `reasoning` object.
  A positive ADK `thinkingBudget` maps to exactly one of `effort` or
  `max_tokens`; sending both would be rejected. These gateways may accept and
  ignore reasoning settings for a non-reasoning routed model.
- Custom providers use the strict `reasoning_effort` path. A local server still
  decides whether that non-standard extension exists for its selected model.
- Native Anthropic clamps `temperature` to `1`, prefers `temperature` when both
  it and `topP` are present, and drops `top_p`, `top_k`, and non-`1`
  temperature during extended thinking. `seed`, presence/frequency penalties,
  logprobs, and candidate count have no native mapping.

OpenAI-compatible responses surface `reasoning` or `reasoning_content` as ADK
thought parts. OpenRouter-style `reasoning_details` retains its structured
signature and is replayed on later assistant turns; display-only thought text
without replayable details is not folded back into normal assistant content.
Native Anthropic likewise preserves signed `thinking` and
`redacted_thinking` blocks for later turns.

Avoid combining sampling and reasoning controls as though every endpoint
supports both:

```ts
// Avoid for reasoning-model portability.
config: {
  thinkingConfig: { thinkingBudget: 4096 },
  temperature: 0.2,
  topP: 0.9,
  responseLogprobs: true,
}
```

Prefer reasoning depth alone, and add sampling/logprobs only after an exact
runtime/model conformance check:

```ts
config: {
  thinkingConfig: { thinkingBudget: 4096 },
}
```

### Structured output and tool choice

`responseJsonSchema` and `responseSchema` become a lenient OpenAI-compatible
`response_format: { type: "json_schema" }`; JSON MIME type alone becomes
`json_object`. Acceptance and enforcement vary by server and model.

Native Anthropic instead injects and selects a synthetic `json_output` tool.
Extended thinking forbids forced tool choice, so the bridge warns:

```text
[adk-llm-bridge] Anthropic forbids a forced tool_choice while extended thinking is enabled; downgrading tool_choice to { type: 'auto' }. Structured output / forced function calling is best-effort in this request. Disable thinking to force tool use.
```

An explicit Anthropic tool-choice mode of `NONE` also wins over the synthetic
tool, so no schema tool is injected for that request.

For portable code, validate returned JSON in the application and retry with a
plain-text JSON instruction when the exact runtime/model rejects
`response_format`. Disable thinking when a native Anthropic request must force a
specific tool.

### Tools

Gemini built-ins are server-owned operations, not portable function
declarations. A request that contains them produces one warning naming all
dropped fields:

```text
[adk-llm-bridge] dropping Gemini-only built-in tool(s) not supported on this provider: googleSearch, codeExecution, urlContext
```

Replace them with application-owned ADK function tools:

```ts
// Avoid: the bridge cannot execute this Gemini server-side tool.
tools: [{ googleSearch: {} }]

// Fallback: expose your own search implementation as a function declaration.
tools: [{
  functionDeclarations: [{
    name: "search_web",
    description: "Search the web and return cited results.",
    parameters: {
      type: "OBJECT",
      properties: { query: { type: "STRING" } },
      required: ["query"],
    },
  }],
}]
```

Use the same pattern for code execution, URL fetching, retrieval, and Maps:
implement a normal ADK tool with the security, credentials, and result format
owned by the application.

### Media

On user turns, use inline image bytes or a reachable HTTP(S) image:

```ts
// Inline image data.
{ inlineData: { mimeType: "image/png", data: base64Png } }

// Or a server-fetchable image.
{ fileData: { mimeType: "image/jpeg", fileUri: "https://example.com/cat.jpg" } }
```

For a `gs://` object, create an appropriately scoped HTTPS URL or download it
and send inline data. For audio/video, transcribe audio and extract selected
frames before making the LLM request. Put an image needed later on a user turn;
the OpenAI-compatible bridge intentionally removes images replayed on
assistant/model turns.

### `providerOptions`

`providerOptions` is available only on `Custom`. It carries non-standard server
fields in the request body and is merged after standard bridge fields, so a
duplicate key can override a generated value.

```ts
const model = Custom("local-model", {
  baseURL: "http://localhost:8000/v1",
  providerOptions: {
    chat_template_kwargs: { enable_thinking: true },
  },
});
```

Use it only for fields documented by the exact server version. Do not treat it
as evidence that Ollama, vLLM, or LM Studio shares another runtime's extension.

## Related configuration and verification

- [Custom provider configuration](./custom-provider-configuration.md) documents
  endpoint/key precedence and safe finite-route registration.
- [Runtime conformance](./runtime-conformance.md) documents deterministic
  fixtures, scheduled Ollama/vLLM checks, and the manual LM Studio profile.
- [`src/converters/request.ts`](../src/converters/request.ts) is the shared
  OpenAI-compatible request boundary.
- [`src/providers/anthropic/converters/request.ts`](../src/providers/anthropic/converters/request.ts)
  is the native Anthropic request boundary.
