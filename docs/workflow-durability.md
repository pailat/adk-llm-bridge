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

## Retired lock tombstones

Both filesystem adapters retire lock directories to deterministic, token-bound
tombstones. Keeping those markers prevents a delayed release or recovery from
removing a newer owner's lock (the ABA problem).

Tombstones intentionally are not garbage-collected online. Remove them only
while every writer using the coordination directory is stopped, or replace the
filesystem adapter with a backend that provides native transactional locks.
Monitor the coordination directories in long-lived installations.

## Remaining failure semantics

Durable checkpoints prevent stale coordinators from committing over newer
state, but they cannot make arbitrary agent side effects exactly-once. Steps
that call external systems should use idempotency keys derived from workflow,
execution, step, and attempt identities. A process can still stop after an
external side effect and before recording step completion; the resumed workflow
will treat that step according to its configured resume policy.
