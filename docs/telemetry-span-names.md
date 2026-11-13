# Span names and ADK 2.5

ADK 2.5 changed its OpenTelemetry span tree. adk-llm-bridge 0.7.0 requires
ADK 2.5 but keeps the span names and attributes of ADK 2.4 for the spans it
creates itself. One trace can therefore hold spans of both shapes. This page
lists which spans come from where.

## ADK's own spans (ADK 2.5 names)

ADK creates these spans, whatever model or agent runs:

| Span | When |
|---|---|
| `invoke_workflow <root agent>` | Each Runner run |
| `invoke_agent <agent>` | Each agent run, including an `ExternalAgent` or a `WorkflowAgent` |
| `generate_content <model>` | Each model call of an `LlmAgent`, including calls to a bridge provider |
| `execute_tool <tool>` | Each tool call an `LlmAgent` makes |
| `invoke_workflow <name>`, `invoke_node <name>` | ADK's own `Workflow` and its nodes |

ADK 2.5 no longer writes message content as span attributes
(`gcp.vertex.agent.llm_request` and the like): content goes to GenAI log
records, when capture is on.

The bridge adds `gen_ai.provider.name`, `gen_ai.response.model`,
`gen_ai.response.id`, `server.address` and an ERROR status to ADK's
`generate_content` span of a bridge provider. It creates no span of its own for
those calls.

## The bridge's spans (ADK 2.4 names)

| Span | Created by | Attributes |
|---|---|---|
| `call_llm` | `ExternalAgent`, one per model call of the runtime | `gen_ai.operation.name=call_llm`, `gcp.vertex.agent.llm_request`, `gcp.vertex.agent.llm_response` |
| `execute_tool <tool>` | `ExternalAgent`, one per tool call of the runtime and per delegation | `gen_ai.tool.*`, `gcp.vertex.agent.tool_call_args`, `gcp.vertex.agent.tool_response` |
| `invoke_workflow <name>` | The bridge's workflow runtime | `adk.workflow.name`, `adk.node.path`, `gen_ai.conversation.id` |
| `execute_node <step>` | The bridge's workflow runtime, one per step attempt | `adk.node.path`, `adk.node.run_id`, `adk.node.attempt`, `adk.node.status`, `adk.node.interrupt_count`, `gcp.vertex.agent.agent_kind` |

They nest under ADK's `invoke_agent` span of the agent that runs them. When a
`WorkflowAgent` is the Runner's root agent, a trace therefore holds two
`invoke_workflow <name>` spans: ADK's span of the Runner run and, under its
`invoke_agent` span, the bridge's span of the workflow. Only the bridge's span
carries `adk_llm_bridge.workflow.execution_id`. The
bridge never opens a second span for a call ADK already traces: an
`ExternalAgent` runs ADK tools through the tool itself, not through
`LlmAgent`, so each tool call has one `execute_tool` span.

## Message content

One rule covers both kinds of span: content goes on a span only when
`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` is `SPAN_ONLY` or
`SPAN_AND_EVENT`. Without it the `gcp.vertex.agent.*` content attributes of the
bridge's spans hold `{}`, and tool details stay out of span names. See
[Telemetry](../README.md#telemetry).

## What changes later

A later release will move the bridge's spans to the ADK 2.5 names and
attributes (`invoke_node` instead of `execute_node`, `generate_content` instead
of `call_llm`, content in log records instead of span attributes) in a single
step, together with the trace views that read them. Queries and dashboards that
select the bridge's spans by name will need the new names then.
