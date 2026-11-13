# Documentation

Guides and references for `adk-llm-bridge`. The package overview is in the
[README](../README.md); how to contribute is in [CONTRIBUTING](../CONTRIBUTING.md).

## Using the package

| Document | Description |
|----------|-------------|
| [Migrating to 0.7.0](migration-0.7.md) | Breaking changes and upgrade steps for 0.7.0 |
| [Models](models.md) | Current model ids per provider path, with the date they were verified |
| [Prompt caching](prompt-caching.md) | Anthropic prompt caching: defaults per provider, the `promptCaching` option, cost, cache usage fields |
| [Custom provider configuration](custom-provider-configuration.md) | Connect any OpenAI-compatible endpoint |
| [OpenAI-compatible feature matrix](openai-compatible-feature-matrix.md) | Which ADK features each provider supports and how they degrade |
| [Provider requests and responses](provider-requests-and-responses.md) | The model sent, `LLMRegistry` matching, finish reasons, tool-call ids, telemetry names, a keyless sample |
| [External agent isolation](external-agent-isolation.md) | Host configuration, network off by default per driver, the confirmation guard |
| [Persisting Claude sessions](claude-session-store.md) | Mirror Claude Agent SDK sessions to durable storage, SQLite included (experimental) |
| [Runtime conformance](runtime-conformance.md) | How local runtimes (Ollama, vLLM, LM Studio) are tested |
| [Span names and ADK 2.5](telemetry-span-names.md) | Which spans ADK creates (ADK 2.5 names) and which the bridge creates (ADK 2.4 names), and the content capture rule |

## Workflows

| Document | Description |
|----------|-------------|
| [Multi-agent workflow orchestration](workflow-orchestration.md) | Versioned, fenced multi-agent workflows |
| [Workflow control plane](workflow-control-plane.md) | Starting, observing, answering and cancelling executions |
| [Workflow durability](workflow-durability.md) | Checkpoints, resume and storage |
| [Choosing storage providers](storage-providers.md) | Checkpoint and event providers, URIs, custom schemes, event export and limits |
| [Workflows and ADK's `Workflow`](workflow-adk-interop.md) | Using workflows with ADK agents, interrupts and delegation |
| [Workflow run spec](workflow-run-spec.md) | Run specs for lanes jobs: validation, plan, error codes and JSON Schema (experimental, needs zod >= 4) |

## Contributing

| Document | Description |
|----------|-------------|
| [Code comment standard](contributing/comments.md) | TSDoc, comment rules and the `check:comments` check |
| [Glossary](glossary.md) | Terms used the same way in docs, code and reviews |

Every Markdown file under `docs/` is listed here, uses kebab-case in its file
name and has exactly one H1.
