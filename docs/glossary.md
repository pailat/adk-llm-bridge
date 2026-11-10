# Glossary

These terms mean the same thing in the README, the docs, the code comments and
code reviews. If you need a new meaning, add a new term instead of reusing one.

| Term | Meaning |
|------|---------|
| **Provider** | A source of LLM models behind `adk-llm-bridge` (AI Gateway, OpenRouter, OpenAI, Anthropic, xAI, a custom endpoint). A provider is used through an ADK model (`BaseLlm`). |
| **ExternalAgent** | An ADK agent (`BaseAgent`) whose work is done by an external coding-agent runtime (Claude Code, Codex, Gemini CLI) instead of a model call. `ClaudeAgent`, `CodexAgent` and `GeminiCliAgent` are `ExternalAgent`s. |
| **Runtime** | The external program or SDK that an `ExternalAgent` controls, for example the Claude Code CLI or the Codex SDK. Not to be confused with the *workflow runtime*. |
| **Driver** | The adapter that starts one turn on a runtime and maps its output to ADK events (`ExternalAgentDriver`). One driver per way of talking to a runtime (SDK or CLI). |
| **Gateway** | A host-side boundary that mediates access. The *tool gateway* (`ToolGateway`) runs ADK sub-agents for an external runtime and reports the delegation; `AgentInvocationGateway` runs a delegated ADK agent on behalf of a workflow or an external agent. Which tools a runtime may call is decided by the permission policy, not by a gateway. |
| **Workflow** | A durable, versioned program that coordinates agents and tasks (`adk-llm-bridge/workflows`). A workflow is an ADK agent and can also run inside ADK's `Workflow`. |
| **Workflow runtime** | The engine that executes a workflow: it runs steps, writes checkpoints and resumes executions. |
| **Step** | One unit of work of a workflow execution, for example one `ctx.run(...)` call that invokes an agent. Steps have a status such as `running` or `waiting`. |
| **Checkpoint** | A committed snapshot of workflow execution state in a `WorkflowCheckpointStore`, used to resume after a restart. |
| **Interrupt** | A stop that needs a person or the host to answer before work can continue, for example an unanswered `adk_request_input` or a permission confirmation. A step that raised an interrupt is stored as `waiting`; this is not the `interrupted` step status, which marks a step stopped by an abort, nor `resumeReason: "interrupted"`, which names why an attempt was entered. |
| **Control plane** | The host-owned API that starts, observes, answers and cancels workflow executions. |
| **Error mode** | How a provider reports a failed model call: `"throw"` (default, a `ProviderLlmError`) or `"response"` (an error `LlmResponse`). |

For the exact types and options, see the TSDoc of each symbol and the guides
listed in [docs/README.md](README.md).
