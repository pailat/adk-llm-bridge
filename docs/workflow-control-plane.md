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

### Authorization

Without `trustedHostMode`, every operation needs the host-authenticated
`actor`. A missing actor, or a value that is not a `WorkflowActorContext`
created by the host, fails with `WORKFLOW_CONTROL_UNAUTHORIZED` and no
service runs. The payload is validated first, so a malformed payload still
fails with `WORKFLOW_CONTROL_INVALID_REQUEST`.

- `task.*` operations are then authorized by `taskAccess`; without it they fail
  with `WORKFLOW_CONTROL_CAPABILITY_UNAVAILABLE`.
- `plan.*` and `ownership.*` operations pass the actor to their controller,
  which applies its `WorkflowAuthorizer`.
- `execution.start`, `resume`, `status`, `cancel` and `events` act on the
  whole execution. They need an actor bound to that execution and **not** to
  one of its tasks (no `taskId`). A task-bound actor reads its own state with
  the `task.*` operations; it cannot read the execution's status or events.
- `artifact.*` and `integration.validate` are scoped to the actor's
  execution: the payload's `executionId` must be the actor's, and when the
  actor is bound to a task, the `taskId` of `artifact.put` and
  `integration.validate` must be that task. Task-bound actors may list and
  read the artifacts of their execution, because artifacts are how tasks
  exchange results.
- `execution.list` cannot be scoped to one execution, so it needs
  `trustedHostMode`.

A failed check throws `WORKFLOW_CONTROL_UNAUTHORIZED`.

#### Artifacts are keyed by execution

`WorkflowArtifactStore` stores each artifact under its execution id and
artifact id. Every `artifact.*` payload names its `executionId`
(`artifact.get` takes `{ "executionId", "artifactId" }`, and `artifact.list`
requires `executionId`), so:

- the same artifact id in two executions names two different artifacts:
  neither overwrites nor blocks the other, and an id never reveals that
  another execution uses it;
- `artifact.get` for another execution than the actor's returns `undefined`
  without reading the store, the same as an id that does not exist. It also
  returns `undefined` when a store hands back an artifact of another
  execution, so a store that ignores the execution id fails closed;
- `artifact.list` returns only the request's execution: it drops any
  artifact of another execution from the store's page and keeps the store's
  `nextCursor`. A page without an `artifacts` array fails with
  `WORKFLOW_CONTROL_INVALID_RESULT`;
- `integration.validate` reads only the request's execution and reports
  another execution's artifact exactly like a missing one, before comparing
  revisions.

A missing or invalid id is rejected before the store reads or writes
anything: the control plane answers `WORKFLOW_CONTROL_INVALID_REQUEST` for a
payload without `executionId`, and the store throws
`WorkflowArtifactIdentityError` (code `WORKFLOW_ARTIFACT_IDENTITY_INVALID`)
for an execution id outside the record grammar or an artifact id outside the
opaque grammar.

`trustedHostMode: true` skips the actor checks of `execution.*`, `artifact.*`,
`integration.validate` and `task.*` (including `taskAccess`); use it only for a
private transport whose callers are all trusted. `plan.*` and `ownership.*`
still need an actor, because their controllers authorize it.

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

```json
{"protocol":"adk-llm-bridge/workflow-control","version":1,"operation":"task.awaitAny","payload":{"handles":[{"executionId":"issue-82","taskId":"review-api"},{"executionId":"issue-82","taskId":"review-ui"}]}}
```

The sender is derived from the authenticated actor. `orchestration`,
`parentTaskId`, and `senderTaskId` are rejected at this JSON boundary.

`task.awaitAny` takes `{ "handles": [...] }`: a non-empty list of task handles
from one execution (at most 1,000). `task.join` takes a single handle.

### `operationId` and replays

`task.spawn` and `task.mailbox.send` require an `operationId`. It is an
idempotency key only when the task controller runs in orchestration mode
(constructed with an authority port and a command store): a replay with the
same `operationId` returns the original handle or message. Without
orchestration mode, which includes `trustedHostMode`, the id is checked but
not stored. Spawning the same `taskId` again then fails with
`WORKFLOW_TASK_DUPLICATE`, and a repeated `task.mailbox.send` appends a second
message. Hosts that retry without orchestration mode should treat
`WORKFLOW_TASK_DUPLICATE` as "already spawned" and read the task with
`task.status`.

### Payload validation

The control plane checks every payload before it calls a controller: exact
keys, field types, required fields, enums, and integer bounds (`limit` and
revisions are positive safe integers, sequences are non-negative). Free-form
JSON fields (`input`, `metadata`, `content`, `context`, and the mailbox
`payload`) must be plain JSON: finite numbers, plain objects (no symbol keys), arrays
without holes, no cycles, at most 32 levels deep, 20,000 nodes, and 1 MiB per string. A failure throws
`WorkflowControlPlaneError` with code `WORKFLOW_CONTROL_INVALID_REQUEST`, and
no controller runs. Identifier formats, store-specific limits (such as the
maximum `limit`), and cross-field plan rules stay in the controllers and keep
their own error codes.

Controllers receive a validated, deep-frozen copy of each free-form JSON
field, never the caller's object. Each getter is read once, during
validation, and later changes by the caller do not reach the controller.
Object members set to `undefined` are dropped from the copy, as the stores
drop them. A controller must not mutate its input.

### Result validation

`dispatch` also checks what each service returns before handing it to the
transport. The result must be plain JSON: finite numbers, plain objects and
arrays, no cycles, no functions, and no class instances such as `Date`, `Map`
or `bigint` values. Its top level must match the operation:

- an array for `plan.list` and `ownership.list`;
- an object, or `undefined` when nothing is found, for `artifact.get`;
- an object for every other operation.

`dispatch` returns a deep-frozen copy, so the transport never holds a
service's live object. Results are limited to 64 levels of depth and have no
node or string cap, because a page of records can exceed the request limits.
The built-in controllers and stores always return plain JSON. A custom
(host-injected) service that returns anything else makes `dispatch` throw
`WorkflowControlPlaneError` with code `WORKFLOW_CONTROL_INVALID_RESULT`. The
service's work has already run at that point, so treat this code as a host
bug, not a retryable request error. Errors thrown by the services themselves
propagate unchanged.

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

## Error codes

`dispatch` throws `WorkflowControlPlaneError` with one of these codes
(`WorkflowControlPlaneErrorCode`):

| Code | Meaning |
| --- | --- |
| `WORKFLOW_CONTROL_INVALID_REQUEST` | The envelope or the payload is invalid. No service ran. |
| `WORKFLOW_CONTROL_UNAUTHORIZED` | No host-authenticated actor, or the actor is bound to another execution or task. No service ran. |
| `WORKFLOW_CONTROL_UNKNOWN_OPERATION` | The operation name is not known. |
| `WORKFLOW_CONTROL_CAPABILITY_UNAVAILABLE` | The control plane was built without the service the operation needs (`plans`, `ownership`, `changeValidation`, `dispatcher` or `taskAccess`). |
| `WORKFLOW_CONTROL_INVALID_RESULT` | A host-injected service returned a value that is not plain JSON or has the wrong shape. The service's work already ran. |

Errors of the services propagate unchanged. The execution controller and its
stores throw `WorkflowExecutionControlError`
(`WorkflowExecutionControlErrorCode`):

| Code | Meaning |
| --- | --- |
| `WORKFLOW_EXECUTION_INVALID_REQUEST` | An identifier, limit or JSON value is invalid. |
| `WORKFLOW_EXECUTION_NOT_FOUND` | The execution does not exist. |
| `WORKFLOW_EXECUTION_DUPLICATE` | An execution with this id already exists. |
| `WORKFLOW_EXECUTION_CONFLICT` | A compare-and-set write lost to a concurrent update. |
| `WORKFLOW_EXECUTION_CAPACITY_EXCEEDED` | The execution's event capacity was reached. |
| `WORKFLOW_EXECUTION_INVALID_TRANSITION` | The execution's status does not allow the operation. |
| `WORKFLOW_EXECUTION_NOT_OWNED` | Another process owns the running execution. |

A failed or cancelled execution records `error.code`: the `code` of the error
the driver threw, or one of `WorkflowExecutionRecordErrorCode`:
`WORKFLOW_EXECUTION_FAILED` and `WORKFLOW_EXECUTION_CANCELLED`. The driver's
code is kept only when it is a string of at most 128 characters matching
`^[A-Z][A-Z0-9_]*$`; any other value (missing, not a string, longer, or
another format) records `WORKFLOW_EXECUTION_FAILED`. Messages are cut to
4,096 characters.

The task controller, dispatcher and stores throw `WorkflowTaskControlError`
(`WorkflowTaskControlErrorCode`):

| Code | Meaning |
| --- | --- |
| `WORKFLOW_TASK_INVALID_REQUEST` | An identifier, limit, JSON value or request field is invalid, including a `task.sweep` request, limit or cursor (or a cursor issued for another execution). |
| `WORKFLOW_TASK_NOT_FOUND` | The task does not exist. |
| `WORKFLOW_TASK_DUPLICATE` | A task with this id already exists. |
| `WORKFLOW_TASK_CONFLICT` | A compare-and-set write lost to a concurrent update. |
| `WORKFLOW_TASK_CLAIM_CONFLICT` | The claim does not match the stored attempt, or a claimed task changed without its claim fence. |
| `WORKFLOW_TASK_LEASE_EXPIRED` | The claim's lease expired or was recovered. |
| `WORKFLOW_TASK_INVALID_TRANSITION` | The task's status does not allow the operation. |
| `WORKFLOW_TASK_NOT_OWNED` | The running task is not owned by this controller or worker. |
| `WORKFLOW_TASK_MAILBOX_FULL` | The target mailbox reached its message limit. |
| `WORKFLOW_TASK_DELEGATION_LIMIT` | The parent task reached its lifetime child limit. |
| `WORKFLOW_TASK_WAIT_ABORTED` | A join, awaitAny or mailbox wait was aborted. |

A failed or cancelled task records `error.code`: the `code` of the error that
was thrown, or one of `WorkflowTaskRecordErrorCode`:
`WORKFLOW_TASK_DRIVER_FAILED` and `WORKFLOW_TASK_CANCELLED`. Unlike the
execution controller, the task controller accepts any non-blank string code
and cuts it to 256 characters; a missing, blank or non-string code records
`WORKFLOW_TASK_DRIVER_FAILED`. Messages are cut to 64 KiB, and a thrown string
becomes the message. A sweep reports the same way, with
`WORKFLOW_TASK_DISPATCH_FAILED` as the fallback code.

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
sequence numbers, immutable artifact revisions keyed by execution, and
scoped cursors. The
filesystem checkpoint and workspace adapters solve local checkpoint and lease
coordination; they are not substitutes for a distributed task database.

See [Multi-agent workflow orchestration](./workflow-orchestration.md) for the
versioned ownership, publication, and recovery architecture.

Checkpoint payloads are compacted before persistence, deeply validated, and
limited to 4 MiB by default. Runtime-only event histories are excluded. See
[Workflow durability](./workflow-durability.md) for commit, fencing, outbox,
and recovery semantics.
