# Workflow durability

`adk-llm-bridge/workflows` has two persistence modes:

- The default `ADKSessionCheckpointStore` emits ADK `stateDelta` values and
  coordinates pending revisions inside one process.
- `FileSystemWorkflowCheckpointStore` commits checkpoint revisions to a local
  filesystem and performs compare-and-swap under a cross-process lock.

Workspace write ownership follows the same split:

- `InMemoryWorkspaceAdapter` coordinates one JavaScript process.
- `FileSystemWorkspaceAdapter` coordinates cooperating processes on one host,
  expires abandoned leases, renews live leases, and issues monotonic fencing
  tokens.

## Operational boundary

The filesystem adapters require all writers to share one local filesystem and
observe the same process namespace. Do not use them over NFS, object storage,
or independent container filesystems. For multi-host deployments, implement
`WorkflowCheckpointStore` and `WorkspaceAdapter` over a transactional service
such as PostgreSQL or another backend with atomic compare-and-set semantics.

Configure absolute, host-controlled directories. Do not place either directory
inside a workspace that workflow agents may modify. Back up checkpoint data;
workspace lease state is coordination metadata and can normally be rebuilt only
after all writers have stopped.

## Checkpoint commit semantics

The checkpoint coordinator publishes a candidate revision internally only
after `WorkflowCheckpointStore.save()` succeeds. A failed save or CAS conflict
leaves the previous revision available for a clean retry. Event notification
occurs after that store commit and does not roll it back.

The filesystem store writes and syncs a temporary file, verifies lock
ownership, atomically renames the file, and syncs the containing directory.
Checkpoint contents and their deterministic revision are validated on load.
New writes remove runtime-only step events and replay markers before hashing or
persistence. Both bundled checkpoint stores reject malformed durable graphs
and enforce a configurable 4 MiB UTF-8 JSON limit by default.

## Workspace leases and fencing

`FileSystemWorkspaceAdapter` assigns every acquired lease a monotonic
`fencingToken`, an expiry, and a `renew()` operation. Its local heartbeat keeps
the lease alive while the adapter and event loop are healthy. After process
death, another process can purge the expired lease and continue.

A fencing token is metadata, not enforcement. Any storage service or external
writer that can outlive a lease must reject operations carrying a token older
than the latest token it has accepted. Without that check, a paused process can
resume after expiry and still write to the external resource.

Call `release()` in normal completion paths and `dispose()` when shutting down
an adapter. Workflow runtime releases step leases in `finally`; `dispose()` is
owned by the host that created the shared adapter.

Durable leases expose `lossSignal`. The runtime combines it with workflow
cancellation and stops the active attempt if ownership expires, renewal proves
that the lease is stale, or the adapter is disposed. The resulting
`WORKFLOW_WORKSPACE_LEASE_LOST` error includes the JSON-safe lease-loss reason.
This closes the local execution window, but the external writer must still
enforce `fencingToken` before every durable write.

## Retired lock tombstones

Both filesystem adapters retire lock directories to deterministic, token-bound
tombstones. Keeping those markers prevents a delayed release or recovery from
removing a newer owner's lock (the ABA problem).

Tombstones intentionally are not garbage-collected online. After stopping
every writer, use the explicit offline collectors:

```typescript
import {
  collectFileSystemCheckpointTombstonesOffline,
  collectFileSystemWorkspaceTombstonesOffline,
} from "adk-llm-bridge/workflows";

await collectFileSystemCheckpointTombstonesOffline({
  root: "/var/lib/my-app/workflow-checkpoints",
  confirmNoActiveWriters: true,
});
collectFileSystemWorkspaceTombstonesOffline({
  root: "/var/lib/my-app/workspace-leases",
  confirmNoActiveWriters: true,
});
```

The collectors scan and validate the complete tree before deleting anything.
They refuse active locks or candidates, symlinks, special files, malformed or
misplaced tombstones, and owner/token changes. There is deliberately no
age-based mode. Unknown safe entries are preserved.

## Attempt idempotency and durable outboxes

Durable checkpoints prevent stale coordinators from committing over newer
state, but they cannot make arbitrary agent side effects exactly-once. Both
`WorkflowAgent` and `ScriptWorkflowAgent` accept `runtimeHooks` for a host-owned
attempt journal:

- `beforeAttempt(context)` may return a previously confirmed result and skip
  agent invocation.
- `afterAttempt(context, result)` is the durable outbox boundary and completes
  before the successful workflow checkpoint is committed.
- `attemptFailed(context, failure)` records a failed attempt before its failure
  checkpoint.

`context.idempotencyKey` is stable across retries and resumes for the same
workflow version, execution, step, agent, agent revision, and input. It
intentionally excludes the attempt number. The same JSON-safe context is
projected into the child ADK session under
`WORKFLOW_ATTEMPT_CONTEXT_STATE_KEY`; the parent session is not mutated.

For side-effecting agents, atomically store the external outcome under that key
and return it from `beforeAttempt` after a crash. `afterAttempt` must not report
success until the host can durably replay the result. This makes the uncertain
window recoverable, but true exactly-once still depends on the external system
honoring the idempotency key or on a transactional outbox controlled by the
host.

## Execution, task, and artifact stores

The execution controller, recursive task controller, mailbox, artifact store,
and integration gate are transport-neutral ports. Their bundled in-memory
implementations are bounded test/development references, not process-restart
durability. Production adapters must preserve CAS transitions, monotonic
cursors, mailbox capacity, and immutable artifact revisions. See the
[workflow control-plane guide](./workflow-control-plane.md) for the JSON/MCP
boundary and the exact single-process limitations.

## Multi-agent authority and publication

Durable orchestration additionally requires transactional plan/ownership
state, task claims, the task command ledger, accepted-receipt storage,
publication reservations, and the host mutation journal. A persistent task
command adapter must validate `expectedParentAuthority` in the same transaction
as child creation, mailbox append, or cancellation. Splitting that check and
mutation across non-transactional stores reintroduces an authority TOCTOU.

`WorkflowTaskDispatcher.sweep()` uses an opaque resumable cursor and a bounded
global budget so queued, expired-running, and expired-cancelling pages cannot
starve one another. After a crash, a new worker requeues an expired claim; later
commands and terminal writes remain fenced by both claim and live ownership.

Git publication is a separate durable boundary. The Node adapter prepares an
immutable tree, commits exactly that tree, and journals intent before mutating
Git. Production hosts inject a durable journal and route ref-moving/check-out
operations through its repository mutation lock. Arbitrary external Git
processes cannot be forced to honour an application lock.
