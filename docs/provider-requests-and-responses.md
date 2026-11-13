# Provider requests and responses

How the bridge's model classes (`OpenAILlm`, `XAILlm`, `OpenRouterLlm`,
`AIGatewayLlm`, `CustomLlm` and `AnthropicLlm`) choose the model they send,
how ADK's `LLMRegistry` finds them, and how each provider's reply maps to
ADK's `LlmResponse`. Feature support per provider is in the
[OpenAI-compatible feature matrix](openai-compatible-feature-matrix.md).

## Which model is sent

ADK sets `llmRequest.model` to the agent's model before each call, so by
default the provider receives the model you created the class with. A
`beforeModelCallback` or a plugin may change `llmRequest.model`; the bridge
sends the new id when the provider accepts it:

| Provider | A rewritten `llmRequest.model` is sent when it matches |
|----------|--------------------------------------------------------|
| OpenAI | `gpt-*`, `o<N>*`, `chatgpt-*` |
| xAI | `grok-*` |
| OpenRouter, AI Gateway | `vendor/model` (any id with a `/`) |
| Anthropic | `claude-*` |
| Custom | any id |

The patterns match the whole id, as `LLMRegistry` does. Any other id (a
prefixed id such as `openai/gpt-4o` on `OpenAILlm`, or `gpt-4o` on
`AnthropicLlm`) is not sent: the call uses the class's own model and logs
`[REQUEST_MODEL_IGNORED]` once per process. A blank `llmRequest.model` also
means the class's own model.

```typescript
const agent = new LlmAgent({
  name: 'assistant',
  model: OpenAI('gpt-4o'),
  beforeModelCallback: ({ request }) => {
    if (needsReasoning(request)) request.model = 'o4-mini'; // sent as o4-mini
    return undefined;
  },
});
```

Request options that depend on the model, such as `max_completion_tokens` for
OpenAI reasoning models, follow the id that is sent.

## How `LLMRegistry` finds a class

`LLMRegistry.register(OpenRouterLlm)` (or a `register*()` function) adds the
class's patterns to ADK's registry. When an agent's `model` is a string, ADK
resolves it like this (ADK 2.5):

- Each pattern is matched against the **whole** model name, as
  `^(?:pattern)$`. `gpt-4o` does not match `openai/gpt-4o`.
- Patterns are tried in the order they were registered, and the first match
  wins. OpenRouter and AI Gateway both claim `vendor/model`, so register only
  the one you use for those ids.
- The result is cached per model name (the last 32 names, per process).
  Registering another class later does not change a name that already
  resolved. Register every class at startup, before the first agent runs.

Passing a model instance (`model: OpenRouter('openai/gpt-4o')`) skips the
registry.

## Finish reasons

| ADK `finishReason` | OpenAI-compatible `finish_reason` | Anthropic `stop_reason` |
|--------------------|-----------------------------------|-------------------------|
| `STOP` | `stop`, `tool_calls`, `function_call` | `end_turn`, `stop_sequence`, `tool_use` |
| `MAX_TOKENS` | `length` | `max_tokens`, `model_context_window_exceeded` |
| `SAFETY` | `content_filter` | `refusal` |
| `MALFORMED_FUNCTION_CALL` | tool-call arguments that are not a JSON object | the same, or a tool call cut by `max_tokens` |
| not set | any other value a gateway sends | `pause_turn`, unknown values |

A `SAFETY` finish with **no content** also carries `errorCode: "SAFETY"` and
the message `The provider blocked the response (content filter) and returned
no content.`, as ADK does for Gemini. A filter that cut an answer part way
keeps the text and has no error code. `MALFORMED_FUNCTION_CALL` always
carries an error code of the same name.

## Other response fields

- `modelVersion` is the model the provider reports in its reply (`model` on
  OpenAI-compatible responses and chunks, `message.model` on Anthropic). It
  can differ from the model sent, for example after gateway routing or alias
  resolution.
- The last response of a stream has `partial: false` and `turnComplete:
  true`; earlier streamed responses have `partial: true`. Responses that are
  not streamed have no `partial` field.
- Token usage is described in the README's "Usage and cache tokens" section
  and in [Migrating to 0.7.0](migration-0.7.md#4-usage-metadata).

## Tool-call ids

ADK pairs each `functionResponse` with its `functionCall` by id.

| | OpenAI-compatible | Anthropic |
|-|-------------------|-----------|
| Id on a call the model makes | The provider's id. An empty id is replaced by `call_` and 32 hex characters. | The `tool_use` id (`toolu_...`). |
| Call in history with no id (ADK removes its own `adk-*` ids for non-Claude models) | A generated `call_...` id; the response that answers it gets the same id, matched by name. | The same, with a generated id. |
| Explicit id in history | Sent as is. | Sent as is when it matches `^[a-zA-Z0-9_-]{1,64}$`; otherwise replaced by a generated id, the same one for the call and its response. |

ADK keeps its `adk-*` ids for Claude models, which match the Anthropic format.

## Headers ADK would add

ADK's `BaseLlm.trackingHeaders` (`x-goog-api-client` and `user-agent` with
ADK's client labels) are meant for Google endpoints. The bridge does not send
them to other providers; ADK's own Claude integration does not either. Each
provider SDK sends its own `User-Agent`. To add your own headers to a
`CustomLlm` endpoint, use its `headers` option.

## Telemetry provider names

The bridge writes `gen_ai.provider.name` on ADK's model span with the
OpenTelemetry GenAI semantic-convention value where one exists:

| Provider | `gen_ai.provider.name` |
|----------|------------------------|
| OpenAI | `openai` |
| Anthropic | `anthropic` |
| xAI | `x_ai` |
| OpenRouter | `openrouter` |
| AI Gateway | `ai-gateway` |
| Custom | `custom`, or the custom provider's id |

OpenRouter, AI Gateway and custom endpoints have no convention value, so they
keep the bridge's id. The model that served the call is in
`gen_ai.response.model`.

## Running without an API key

[examples/keyless](../examples/keyless) runs an `LlmAgent` against a small
OpenAI-compatible server on `127.0.0.1`, with no key and no network access.
Point the same `Custom` model at Ollama, vLLM or LM Studio to use a real local
model without a key.
