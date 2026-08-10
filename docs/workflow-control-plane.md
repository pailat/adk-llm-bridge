# Workflow control plane

`adk-llm-bridge/workflows` separates orchestration from transport. The core
does not open an HTTP socket or start an MCP server; instead,
`WorkflowControlPlane.dispatch()` accepts one JSON request. An HTTP route, an
MCP tool, a CLI, or another ADK agent can all forward the same envelope.

```text
JSON / MCP adapter
       |
WorkflowControlPlane
       |-- execution controller (start, cancel, resume, events)
       |-- task controller (spawn, join, awaitAny, mailbox)
       `-- artifacts + integration gates
```

Provider credentials, `BaseAgent` instances, workspace host handles, and
`AbortSignal` objects never enter the JSON payload. Drivers and adapters remain
host-owned capabilities.

## Construct the host services

```typescript
import {
  InMemoryWorkflowArtifactStore,
  InMemoryWorkflowExecutionEventStore,
  InMemoryWorkflowExecutionStore,
  InMemoryWorkflowTaskMessageStore,
  InMemoryWorkflowTaskStore,
  IntegrationGate,
  WorkflowControlPlane,
  WorkflowExecutionController,
  WorkflowTaskController,
} from "adk-llm-bridge/workflows";

const artifacts = new InMemoryWorkflowArtifactStore();
const executions = new WorkflowExecutionController({
  store: new InMemoryWorkflowExecutionStore(),
  eventStore: new InMemoryWorkflowExecutionEventStore(),
  driver: executionDriver,
});
const tasks = new WorkflowTaskController({
  store: new InMemoryWorkflowTaskStore(),
  messageStore: new InMemoryWorkflowTaskMessageStore(),
  driver: taskDriver,
});
const integration = new IntegrationGate(artifacts, integrationDriver);

const control = new WorkflowControlPlane({
  executions,
  tasks,
  artifacts,
  integration,
  // Private, fully trusted in-process transport only. Agent-facing MCP/RPC
  // hosts must configure taskAccess and pass a host-authenticated actor.
  trustedHostMode: true,
});
```

The two drivers are the only provider-specific pieces. An execution driver may
run an ADK `WorkflowAgent` or `ScriptWorkflowAgent`. A task driver maps
`task.agentId` to Codex, Claude Code, another ADK agent, a queue worker, or a
remote service.

## Expose one MCP-style JSON tool

The exact MCP SDK is intentionally left to the application. Its handler only
needs to pass the validated arguments and the request cancellation signal:

```typescript
async function workflowControlTool(
  args: {
    protocol: "adk-llm-bridge/workflow-control";
    version: 1;
    operation: string;
    payload: Record<string, unknown>;
  },
  signal: AbortSignal,
  actor: WorkflowActorContext,
) {
  return await control.dispatch(args as never, { signal, actor });
}
```

The host creates `actor` only after authenticating the connection. It is an
opaque capability and never comes from `args`. Agent-facing hosts configure
`taskAccess` and remain deny-by-default; never use `trustedHostMode` for an MCP
tool reachable by untrusted agents.

Use one JSON schema whose `operation` is an enum and whose `payload` is the
matching object. The core rejects unknown envelopes and stable controller error
codes can be projected into the MCP error response.

Representative calls are:

```json
{"protocol":"adk-llm-bridge/workflow-control","version":1,"operation":"execution.start","payload":{"executionId":"issue-82","workflowId":"implementation","workflowVersion":"1","input":{"issue":82}}}
```

```json
{"protocol":"adk-llm-bridge/workflow-control","version":1,"operation":"task.spawn","payload":{"executionId":"issue-82","taskId":"review-api","agentId":"codex","input":{"scope":"src/api"},"operationId":"spawn-review-api-1"}}
```

```json
{"protocol":"adk-llm-bridge/workflow-control","version":1,"operation":"task.mailbox.send","payload":{"executionId":"issue-82","taskId":"review-api","payload":{"need":"contract artifact"},"operationId":"send-contract-1"}}
```

The sender is derived from the authenticated actor. `orchestration`,
`parentTaskId`, and `senderTaskId` are rejected at this JSON boundary.

The complete operation families are:

- `execution.start|resume|status|cancel|list|events`
- `task.spawn|resume|dispatch|recover|sweep|status|cancel|list|join|awaitAny`
- `task.mailbox.send|read|wait`
- `artifact.put|get|list`
- `integration.validate`
- `plan.put|get|list|activate`
- `ownership.claim|propose|approve|reject|transfer|release|list|validate`

`task.mailbox.wait`, `task.join`, and `task.awaitAny` use the host cancellation
signal. Mailbox wait is a long-poll: it returns immediately for unread messages
or wakes when a new message arrives.

## Recursive dynamic tasks

A task driver receives bounded capabilities scoped to its execution. It can
create more tasks at runtime, wait for one or all of them, exchange durable
messages, and cancel work it no longer needs:

```typescript
const taskDriver = {
  async execute(ctx) {
    if (ctx.task.agentId !== "orchestrator") {
      return runSelectedAgent(ctx.task, ctx.signal);
    }

    const implementation = await ctx.spawn({
      taskId: "implementation",
      agentId: "codex",
      input: ctx.task.input,
    });
    const review = await ctx.spawn({
      taskId: "review",
      agentId: "codex",
      input: { waitFor: implementation.taskId },
    });
    await ctx.send({
      taskId: review.taskId,
      payload: { implementation },
    });

    const first = await ctx.awaitAny([implementation, review]);
    const implementationResult = await ctx.join(implementation);
    const reviewResult = await ctx.join(review);
    return { output: { first, implementationResult, reviewResult } };
  },
};
```

Handles and mailbox cursors are plain JSON. Knowing their IDs is not authority;
task reads and mutations still require the host actor. `join` and `cancel` refuse to claim
ownership of an in-flight task running in another process; a distributed host
must route those operations to the current owner or implement its own durable
driver/store coordination.

## Replay identity and agent revisions

Dynamic agent descriptors include a deterministic `revision`. The bundled
external-agent factory hashes the normalized provider configuration without
credentials or host handles. Pass that value into a step so a checkpoint or
outbox result cannot be replayed after the agent configuration changes:

```javascript
const worker = yield ctx.spawnAgent({
  providerId: "codex",
  name: "worker",
  config: { instruction: "Implement the bounded task." }
});
const result = yield ctx.run({
  id: "implement",
  agentName: worker.name,
  agentRevision: worker.revision,
  input: ctx.input
});
```

Legacy steps without a revision remain explicitly `unversioned`; they only
match other unversioned records.

## Durability boundary

The controllers are store-backed and define CAS, cursor, transition, and
capacity contracts. The bundled execution, task, mailbox, and artifact stores
are bounded **single-process reference implementations**. They do not become
durable merely because their records are serializable.

For production, inject store implementations backed by a transactional
database or queue. Preserve atomic compare-and-set, monotonic event/message
sequence numbers, immutable artifact revisions, and scoped cursors. The
filesystem checkpoint and workspace adapters solve local checkpoint and lease
coordination; they are not substitutes for a distributed task database.

See [Multi-agent workflow orchestration](./workflow-orchestration.md) for the
versioned ownership, publication, and recovery architecture.

Checkpoint payloads are compacted before persistence, deeply validated, and
limited to 4 MiB by default. Runtime-only event histories are excluded. See
[Workflow durability](./workflow-durability.md) for commit, fencing, outbox,
and recovery semantics.
