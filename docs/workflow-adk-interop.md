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
- `timeout`, `retryConfig`, `rerunOnResume`, `inputSchema`, `outputSchema`,
  `stateSchema` and `isolationScope` in the agent config are forwarded to ADK. They only apply when the agent runs
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
- The default execution id is the ADK invocation id, except on a turn that
  answers a waiting step (see below), which reuses the id of the run that
  raised it. The TypeScript Runner creates a new invocation id for every turn,
  so any other workflow that must resume across turns needs a stable
  `resolveExecutionId` (for example from the session id and node name).
- Running the same workflow agent several times in one invocation (several
  `ctx.runNode` calls) shares the invocation id. Use `useSubBranch: true` with
  distinct `runId`s and include `ctx.branch` in `resolveExecutionId` so each run
  has its own checkpoint.

## Retries and timeouts of a node

ADK retries a node (`retryConfig`) or stops it (`timeout`) by re-entering or
closing the agent with the same invocation id, so the same execution id and
checkpoint are used:

- A closed run aborts its steps and waits for them to settle. A step that was
  mid-flight is recorded as `failed` (never left `running`), and a re-entry
  waits for the previous run of the same agent instance to finish first.
- On re-entry finished steps replay from the checkpoint. Steps whose last
  attempt failed run again as the next attempt when `retryFailedSteps` is on.
  It defaults to `true` when `retryConfig` is set and to `false` otherwise (a
  failed step then requires `resumePolicy: "retry"`, as before).
- A step recorded `running` by a crash is still `WORKFLOW_INDETERMINATE_STEP`;
  only recorded failures are retried automatically.
- The node `timeout` and ADK's retry delay apply per attempt, so leave room for
  replaying the finished steps.

## Steps that wait for input (HITL)

When a sub-agent stops on an ADK interrupt (`adk_request_input`,
`adk_request_confirmation`, `adk_request_credential`, or a long-running tool
call), the workflow does not fail:

1. The step is saved as `waiting` in the checkpoint, together with the
   interrupt (kind, function-call ids, the delegation events) and the original
   workflow input. Other steps of a `ctx.parallel` call run to completion.
2. The run ends cleanly with `step_waiting` and `workflow_waiting` events
   (`summary.status` is `"waiting"`). The sub-agent's own events, which carry
   `longRunningToolIds`, were already forwarded, so an ADK Runner or UI can
   show and answer the request, and an ADK `Workflow` marks the node as waiting.
3. The next turn answers with `functionResponse` parts whose ids match. The
   workflow restores its original input, replays finished steps and continues
   the waiting step with the answer; it may complete, fail or wait again. A
   turn without a matching answer keeps waiting without running the agent, and
   a response that answers nothing is rejected with `WORKFLOW_INPUT_MISMATCH`.

The default execution id finds the waiting run from the `step_waiting` event in
the session, so no custom `resolveExecutionId` is needed. `rerunOnResume` is
`true` by default for workflow agents so ADK re-enters them on resume.
`ctx.run` rejects with `WorkflowInterruptedError`: handlers must not catch it.
The resumed delegation is not retried automatically. Checkpoints with `waiting`
steps are not readable by earlier versions.

## Future work

Rebuilding the durable runtime on ADK's `Workflow` was considered and dropped:
it is `@experimental`, resumes without checking the input or agent revision,
and has no checkpoint stores, leases or sandbox. A possible follow-up is an
optional adapter, in its own experimental subpath, that exposes a durable step
as an ADK `BaseNode`.
