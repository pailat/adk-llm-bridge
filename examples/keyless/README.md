# Keyless example

Runs an ADK `LlmAgent` through `adk-llm-bridge` with no API key and no network
access. A small OpenAI-compatible endpoint on `127.0.0.1` answers every request
with a fixed reply, and a `Custom` model points at it.

```bash
cd examples/keyless && bun install && bun run start
# assistant: Hello from a local model.
```

To use a real local model instead, remove the fake server and set `baseURL` to
your Ollama (`http://localhost:11434/v1`), vLLM or LM Studio endpoint. No key is
needed for those either.

`tests/docs/keyless-example.test.ts` runs this file in CI, so it stays working.
