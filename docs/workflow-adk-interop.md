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
- `timeout`, `retryConfig`, `rerunOnResume`, `waitForOutput`, `inputSchema`,
  `outputSchema`, `stateSchema` and `isolationScope` in the agent config are
  forwarded to ADK. They only apply when the agent runs as a node, not as the
  Runner's root agent. `beforeAgentCallback`, `afterAgentCallback` and
  `parentAgent` work as for any ADK agent, in both cases, and `clone()`
  rebuilds the agent from its whole config.
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
- The default execution id is the ADK invocation id, except while a run waits
  for input (see below): every turn then reuses the id of the waiting run. The
  TypeScript Runner creates a new invocation id for every turn, so any other
  workflow that must resume across turns (for example after a crash or a
  failed step) needs a stable `resolveExecutionId` (for example from the
  session id and node name).
- ADK's `Workflow` accepts at most one terminal output per run. Edges that fan
  out from `START` to two nodes with no outgoing edges fail once both produce
  output (`multiple terminal nodes produced output (2). A workflow must have at
  most one terminal output.`). Chain the nodes, as in the example above, or
  end the branches in a `JoinNode`.
- Running the same workflow agent several times in one invocation (several
  `ctx.runNode` calls) shares the invocation id. Use `useSubBranch: true` with
  distinct `runId`s and include `ctx.branch` in `resolveExecutionId` so each run
  has its own checkpoint.
- Events are delivered with back-pressure, as from any ADK agent: the workflow
  goes on only after the consumer has handled an event and asked for the next
  one. A `step_started` therefore reaches the consumer before the step's agent
  starts, even when the consumer awaits I/O for each event. A consumer that
  stops reading pauses the run; closing the stream aborts it.
- `step_started` carries `resumeReason` (`"interrupted"` or `"retry"`) when a
  step runs again after an attempt that did not complete. It is unset on a
  first attempt and when a waiting step continues with its answer (same
  attempt number); see
  [Re-entered steps](./workflow-durability.md#re-entered-steps).

## Retries and timeouts of a node

ADK retries a node (`retryConfig`) or stops it (`timeout`) by re-entering or
closing the agent with the same invocation id, so the same execution id and
checkpoint are used:

- A closed run aborts its steps and waits for them to settle. A step that was
  mid-flight is recorded as `interrupted` (never left `running`), and a re-entry
  waits for the previous run of the same agent instance to finish first.
  Without `retryFailedSteps` or `resumePolicy: "retry"`, re-entering an
  `interrupted` step fails with `WORKFLOW_INDETERMINATE_STEP` because it may
  have had side effects; it is not replayed as `step_failed`.
- On re-entry finished steps replay from the checkpoint. Steps whose last
  attempt failed run again as the next attempt when `retryFailedSteps` is on
  or the step declares `resumePolicy: "retry"`. `retryFailedSteps` defaults
  to `true` when `retryConfig` is set and to `false` otherwise. Without
  either, the recorded failure is replayed: a `step_failed` event with
  `failure.replayed: true`, and the step throws the same error (code, message
  and details) it threw when it failed, so `ctx.parallel` with
  `failureMode: "all-settled"` returns the same outcome. A sibling stopped by
  an abort is returned to the handler as a `WorkflowStepFailure` with
  `status: "failed"` and code `WORKFLOW_ABORTED`, while the checkpoint stores
  it as `interrupted`. With `failureMode: "fail-fast"`, a sibling stopped
  because another step failed is `interrupted` the same way
  (`details.reasonCode` is the failing step's code), so it needs the same
  opt-in to run again.
- A checkpoint that no longer matches the workflow (changed step input, agent,
  version or source) is not a step outcome. It fails the run at the step that
  changed, with a `step_failed` event, in every `failureMode`.
- A step recorded `running` by a crash is still `WORKFLOW_INDETERMINATE_STEP`;
  only recorded failures are retried automatically, and an `interrupted` step
  runs again only on the same opt-in.
- The node `timeout` and ADK's retry delay apply per attempt, so leave room for
  replaying the finished steps.

## Steps that wait for input (HITL)

When a sub-agent stops on an ADK interrupt (an unanswered `adk_request_input`,
`adk_request_confirmation` or `adk_request_credential` call, or an unanswered
long-running tool call), the workflow does not fail. A long-running call is any
id in an event's `longRunningToolIds`, wherever that event is in the turn: ADK
2.4's `LlmAgent` emits the call, the tool's own pending response and then keeps
going (often with a text event), and the call still counts as waiting. Only a
later `functionResponse` with the same id from the user answers it. A
`LongRunningFunctionTool` therefore always pauses the step, even when it returns
its final result at once; a tool that finishes immediately should be a plain
`FunctionTool`. ADK `NodeTool` calls are the exception: ADK marks them
long-running only so a paused node can resume, so they never pause the step by
themselves. When the wrapped node pauses, its own request (for example an
`adk_request_input` call) is what the step waits on. A `NodeTool` call is
recognized wherever the calling `LlmAgent` sits: the step's agent, one of its
sub-agents, or a graph node of an ADK `Workflow` wrapped in a `NodeTool`
(nested to any depth). The tool is looked up by name in that agent's `tools`
list; a listed tool that is not a `NodeTool` keeps the call pending. A
`NodeTool` provided by a toolset is not listed, and the interrupt scan never
calls `getTools` (it may do I/O), so it is recognized by the branch ADK runs
the node on (`<tool name>@<call id>`): any event of the delegation on that
branch shows the call ran a node. A wrapped node that emits no event at all
leaves no such branch, and its call still counts as long-running.

1. The step is saved as `waiting` in the checkpoint, together with the
   interrupt (kind, function-call ids, the delegation events) and the original
   workflow input. Other steps of a `ctx.parallel` call run to completion.
2. The run ends cleanly with `step_waiting` and `workflow_waiting` events
   (`summary.status` is `"waiting"`). The sub-agent's own events, which carry
   `longRunningToolIds`, were already forwarded, so an ADK Runner or UI can
   show and answer the request, and an ADK `Workflow` marks the node as waiting.
3. The next turn answers with `functionResponse` parts whose ids match. The
   workflow restores its original input, replays finished steps and continues
   the waiting step with the answer; it may complete, fail or wait again.
   Steps that failed on an earlier turn are replayed as the same failure (see
   [Retries and timeouts of a node](#retries-and-timeouts-of-a-node)), even
   with `retryFailedSteps` or `resumePolicy: "retry"`: re-running one would
   change the inputs of the later steps, and the answer turn would fail with
   `WORKFLOW_STEP_MISMATCH`.
   Every other turn goes to the same waiting run and runs no agent: a different
   message, or a `functionResponse` that answers nothing, is rejected with
   `WORKFLOW_INPUT_MISMATCH` (no `workflow_started`, the run keeps waiting); the
   original message again replays the finished steps, emits the waiting
   step's pending request events and its `step_waiting` event again, and ends
   with `workflow_waiting`. Because the request is emitted on every such turn,
   a caller that only sees that turn still gets the interrupt: an outer
   workflow or `AgentInvocationGateway` delegation that re-enters a
   still-waiting inner workflow (for example a fresh outer run after the
   first one failed) waits on the same request instead of completing, and
   answering it resumes the inner run.

The default execution id finds the waiting run from the most recent
`step_waiting` event this workflow agent emitted in the session, so no custom
`resolveExecutionId` is needed. That run counts as waiting while its
checkpoint is `running` with a `waiting` step and has the current workflow
version. Once it completed, failed or was cancelled, or the workflow version
changed, a turn that does not answer it starts a fresh run; a turn that still
answers its call ids is routed to it and rejected (a completed run with
`WORKFLOW_INPUT_MISMATCH`, a new version with `WORKFLOW_VERSION_MISMATCH`), so
a stale answer never reaches an agent.

While a run waits, the session stays on it until the request is answered. This
also holds when the workflow agent is a sub-agent of a coordinator `LlmAgent`:
ADK sends a plain-text turn to the coordinator, and if it transfers to the
workflow again (even with a new request), the workflow is routed to the waiting
run and rejects the turn with `WORKFLOW_INPUT_MISMATCH`. The same happens for a
gateway delegation with `sessionHistoryMode: "inherit"`, whose history contains
the earlier `step_waiting` event; with the default `replace` mode the child does
not see it and starts a fresh run. To get out of a waiting run:

- answer it with a `functionResponse` that carries a refusal or an error, so
  the agent ends the step;
- start a new session; or
- set a custom `resolveExecutionId` that keys runs the way you need.

`rerunOnResume` is `true` by default for workflow agents so ADK re-enters them
on resume.
`ctx.run` rejects with `WorkflowInterruptedError`: handlers must not catch it.
The resumed delegation is not retried automatically. Checkpoints with `waiting`
steps are not readable by earlier versions.

## Step usage in workflow events

`step_completed.result.usage` and `step_replayed.result.usage`
(`WorkflowStepUsage`) aggregate the agent run of the step's successful attempt,
so consumers need not re-derive totals from child events:

| Field | Meaning |
|---|---|
| `promptTokens`, `completionTokens`, `totalTokens` | Summed from `usageMetadata` of non-partial events; `totalTokens` falls back to prompt + completion |
| `cachedTokens` | Summed `cachedContentTokenCount`; part of `promptTokens`, not added on top |
| `toolCalls` | Function calls requested on non-partial events |
| `llmCalls` | Events that reported usage: one per model response for an `LlmAgent`, one per run for an `ExternalAgent` that ends with a final response. A Claude Code step that made 100 native model calls reports `llmCalls: 1`; the run's turn count is the `gcp.vertex.agent.external_agent.num_turns` span attribute |
| `costUsd` | Optional. Summed cost the providers reported for the step's model calls (AI Gateway and OpenRouter `usage.cost`; for a BYOK gateway call the upstream cost or `market_cost`, see Prompt caching). Absent when no call reported one, so a step of an `ExternalAgent` has none: its cost is `totalCostUsd` on the driver usage and the `usage.cost_usd` span attribute |

- Only the successful attempt is counted. Failed attempts that were retried are
  not, and a failed or interrupted step (`step_failed`, `step_interrupted`)
  carries no `usage`, so summing step usage undercounts the cost of failures
  and aborts.
- When the step runs a nested workflow agent, its sub-steps' events are part of
  the run, so the total includes them.
- Values are summed as each runtime reports them; any double counting in a
  runtime's report carries into the totals. A Claude `ExternalAgent` that
  resumes a session without a baseline (a new driver given `resumeSessionId`,
  a fork, or a restart) reports the session total, and its final event carries
  `customMetadata.externalAgentUsageScope: "session"`; check that field before
  summing such a step.
- The value is stored in the checkpoint, so a replayed step reports the same
  totals. Checkpoints written before 0.7 have no `usage`. A stored `usage` that
  lacks a field, or holds a negative or non-finite number, makes the checkpoint
  load as corrupt.
- Cost is not computed: `costUsd` adds up what the providers reported, and
  there is no price table. A step that mixes a gateway `LlmAgent` and an
  `ExternalAgent` needs both sources to get a run total.
- `promptTokens` counts input, cache reads and cache writes (Anthropic
  semantics), so it is above a count that leaves the writes out.

## Future work

Rebuilding the durable runtime on ADK's `Workflow` was considered and dropped:
it is `@experimental`, resumes without checking the input or agent revision,
and has no checkpoint stores, leases or sandbox. A possible follow-up is an
optional adapter, in its own experimental subpath, that exposes a durable step
as an ADK `BaseNode`.
