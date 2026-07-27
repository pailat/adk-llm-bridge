# Custom provider configuration

Custom OpenAI-compatible providers use the same configuration precedence as
the declarative providers:

1. explicit constructor or named-registration configuration;
2. global provider configuration, where the provider exposes it;
3. environment variables;
4. the provider default.

A defined higher-priority value always wins. In particular, an invalid
explicit URL fails immediately instead of falling back to an environment
variable. Custom providers do not have a default URL, so construction fails
unless either `baseURL` or `CUSTOM_LLM_BASE_URL` resolves to a valid absolute
URL.

The Custom-specific environment variables are:

- `CUSTOM_LLM_BASE_URL` — fallback OpenAI-compatible API base URL.
- `CUSTOM_LLM_API_KEY` — optional fallback credential. It may be absent for
  unauthenticated local servers such as Ollama, LM Studio, or vLLM.

For example:

```sh
export CUSTOM_LLM_BASE_URL=http://localhost:11434/v1
```

```ts
const local = Custom("llama3");
```

Explicit configuration overrides both variables, including an explicitly
empty `apiKey` for a local server:

```ts
const local = Custom("llama3", {
  baseURL: "http://localhost:11434/v1",
  apiKey: "",
});
```

Named registrations resolve and deep-copy their endpoint configuration before
registration. This makes the registration stable if its source object or the
process environment changes later, while preserving the finite-route collision
checks:

```ts
registerCustomProvider("ollama", {
  models: ["llama3"],
  // baseURL and apiKey may come from the Custom environment variables.
});
```

The OpenAI provider follows the same declarative resolution and supports
`OPENAI_BASE_URL` after explicit and global OpenAI configuration but before its
`https://api.openai.com/v1` default.

Configuration errors identify the failing source and the supported remedies,
but do not include configured URL values because URLs can contain credentials
or other secrets.
