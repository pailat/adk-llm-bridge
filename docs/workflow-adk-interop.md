# Workflows and ADK's `Workflow`

`@google/adk` 2.x ships its own graph engine (`Workflow`, `FunctionNode`,
`ParallelWorker`, `JoinNode`, `ctx.runNode`). It is marked `@experimental`
(ADK logs a warning when you create one) and its API may still change inside
2.x. `adk-llm-bridge/workflows` does **not** build on it; the two are
complementary and compose.

## Which one to use

| Need | Use |
|---|---|
| Graph of nodes with routes, joins, fan-out over a list, human-in-the-loop (`RequestInput`), per-node `timeout`/`retryConfig`, ADK dev-UI graph | ADK `Workflow` |
| Durable, resumable multi-agent runs: checkpoint with compare-and-swap, `inputHash` / `agentRevision` checks on replay, idempotency keys, `resumePolicy`, external checkpoint stores, workspace leases | `WorkflowAgent` |
| Sequences supplied at runtime as untrusted code (QuickJS sandbox) | `ScriptWorkflowAgent` |

ADK resumes a node from its cached session events keyed by node path and run
id; it does not check that the input or the agent build is the same. Our
runtime does, and fails with `WORKFLOW_INPUT_MISMATCH` / `WORKFLOW_STEP_MISMATCH`
instead of replaying stale work.

## Naming

Our `WorkflowAgent` is **not** ADK's `Workflow`: it is a `BaseAgent` that runs a
handler against declared sub-agents. ADK removed its own `WorkflowAgent` class
in 2.x, so the exported names do not collide. Likewise, the "task" in
`adk-llm-bridge/workflows` (durable task queue and dispatcher) is unrelated to
`mode: 'task'` on ADK's `LlmAgent`.

## Using our agents as ADK nodes

An ADK agent is a node, so `WorkflowAgent` and `ScriptWorkflowAgent` can go
straight into `edges` or `ctx.runNode(...)`:

```typescript
import { FunctionNode, Workflow } from "@google/adk";
import { WorkflowAgent } from "adk-llm-bridge/workflows";

const durable = new WorkflowAgent({
  name: "durable",
  definition,
  subAgents: [worker],
  timeout: 120, // seconds; ADK node setting
  // Stable across turns, see below.
  resolveExecutionId: (ctx) => `${ctx.session.id}:durable`,
});

const graph = new Workflow({
  name: "pipeline",
  edges: [
    ["START", durable, new FunctionNode("after", (_ctx, text) => ({ text }))],
  ],
});
```

What you get:

- The workflow's final answer is the node output (`event.output`, with
  `nodeInfo.messageAsOutput`), so the next node and `ctx.runNode(...).output`
  receive it. A `Content` result is reduced to its visible (non-thought) text;
  without text, the `Content` itself is passed. With an `outputSchema`, the
  final text is parsed as JSON (kept as text if it is not valid JSON), like an
  ADK `LlmAgent`, so the handler should return JSON text; a `Content` without
  text skips schema validation.
- `timeout`, `inputSchema`, `outputSchema`, `stateSchema` and `isolationScope`
  in the agent config are forwarded to ADK. They only apply when the agent runs
  as a node, not as the Runner's root agent.
- Inside a `Workflow`, ADK aborts the node's invocation signal when the graph
  fails or a node `timeout` expires. When the consumer closes the event stream
  (`break`, `iterator.return()`) or the agent runs through `ctx.runNode` without
  a parent `Workflow`, only the generator is closed; the workflow runtime then
  aborts itself and waits for in-flight steps to settle, so no step keeps
  running.
- Checkpoint keys contain `:` and are therefore exempt from a strict
  `stateSchema`.

Things to know:

- ADK gives a non-LLM agent its conversation, not the node input. Our
  workflows read the user message from the session (`ctx.input` /
  `ctx.inputText`); the `input` passed to `ctx.runNode(agent, input)` is not
  used.
- The default execution id is the ADK invocation id. The TypeScript Runner
  creates a new invocation id for every turn, so a node resumed in a later turn
  would start a new execution and find no checkpoint. Provide a stable
  `resolveExecutionId` (for example from the session id and node name) when the
  workflow must resume across turns.
- Running the same workflow agent several times in one invocation (several
  `ctx.runNode` calls) shares the invocation id. Use `useSubBranch: true` with
  distinct `runId`s and include `ctx.branch` in `resolveExecutionId` so each run
  has its own checkpoint.
- Steps that end in an ADK interrupt (human input) are not propagated yet.
