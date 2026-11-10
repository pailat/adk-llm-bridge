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
That rename is the commit. If the release then fails only on I/O (the rename
of the lock or the directory sync), `save` still resolves and logs the warning
`[adk-llm-bridge] [WORKFLOW_CHECKPOINT_LOCK_RELEASE_FAILED]` through ADK's
logger. If the lock now belongs to another owner, `save` rejects with
`checkpoint_lock_ownership_lost`: another process recovered the lock and may
have written the same checkpoint, so the revision check no longer holds. A
lock with no valid owner at that point rejects with `checkpoint_lock_corrupt`.
A lock left behind by a live process makes the next save of that execution
fail with `checkpoint_lock_timeout`. A load opens the checkpoint file
once without following symlinks (`O_NOFOLLOW`, where the platform has it) and
checks and reads it through that handle, so a path swapped for a symlink after
the check is never read.
Checkpoint contents and their deterministic revision are validated on load.
New writes remove runtime-only step events and replay markers before hashing or
persistence. Both bundled checkpoint stores reject malformed durable graphs
and enforce a configurable 4 MiB UTF-8 JSON limit by default.

### Checkpoint failure reasons

Checkpoint stores throw `WorkflowError` with code `WORKFLOW_EXECUTION_ERROR`
and a `details.reason` from the exported `WorkflowCheckpointFailureReason`
union. `details.checkpointKey` names the checkpoint; file system failures also
carry `details.causeCode` (the system error code) and, when available,
`details.causeMessage`.

| `details.reason` | Meaning |
| --- | --- |
| `checkpoint_revision_conflict` | A compare-and-swap write found another revision (`WorkflowCheckpointConflictError`, with `expectedRevision` and `actualRevision`). Reload and retry. |
| `checkpoint_size_limit_exceeded` | The checkpoint is larger than the configured limit (`maxBytes`, `actualBytes`, `direction`). |
| `checkpoint_revision_invalid` | The supplied revision does not match the checkpoint, or a stored file carries an invalid revision. |
| `checkpoint_schema_invalid` | A save was given an invalid checkpoint. |
| `checkpoint_file_corrupt` | A stored file is not valid JSON or not a valid checkpoint file. |
| `checkpoint_file_unsafe` | The checkpoint path is a symlink or not a regular file (a directory, a FIFO). |
| `checkpoint_directory_create_failed`, `checkpoint_read_failed`, `checkpoint_stat_failed`, `checkpoint_write_failed` | A file system call on the checkpoint failed. |
| `checkpoint_lock_timeout` | The per-checkpoint lock was not acquired in time. |
| `checkpoint_lock_corrupt` | The lock is not a safe directory or has no valid owner; it is never taken over automatically. |
| `checkpoint_lock_ownership_lost` | Another writer took the lock, before the commit or before the release that follows it; the save fails. |
| `checkpoint_lock_acquire_failed`, `checkpoint_lock_candidate_failed`, `checkpoint_lock_candidate_cleanup_failed`, `checkpoint_lock_read_failed`, `checkpoint_lock_recovery_failed`, `checkpoint_lock_release_failed`, `checkpoint_lock_cleanup_failed` | A file system call on the lock failed. A `checkpoint_lock_release_failed` after a committed write is only logged (see above). |

## Stopping a run

Abort the `AbortSignal` you passed to the run, wait for the workflow to record
the abort, then exit. Do not call `process.exit` while a run is in flight: the
execution is left `running` forever and its in-flight step is left `running`,
which a resume reports as indeterminate.

```ts
const controller = new AbortController();
const running = (async () => {
  // Drain the runner; it ends normally once the signal aborts.
  for await (const _ of runner.runAsync({
    userId,
    sessionId,
    newMessage,
    abortSignal: controller.signal,
  })) {
    // handle events
  }
})();
// ...later, for example from a budget guard:
controller.abort(new Error("budget exceeded"));
// The iterator ends once the workflow has recorded the abort, with either
// checkpoint store (see below); a delegated workflow gets at most 500 ms.
await running.catch(() => undefined);
process.exit(0); // safe now
```

While a Claude, Codex or Gemini CLI agent runs, the bridge forwards the host's
SIGINT, SIGTERM and SIGHUP to the CLI's process group. A host listener for the
signal, registered with `process.on` or `process.once`, keeps control: abort
from it and drain as above. Without one, the host ends by the signal as usual.

`runner.runAsync` ends normally after an abort (no `WORKFLOW_ABORTED`
rejection), and the runner stops forwarding events once the signal aborts, so
`step_interrupted` and the terminal `error` event reach only a consumer of
`agent.runAsync` directly. The abort is still recorded in the checkpoint.
`FileSystemWorkflowCheckpointStore` writes it to disk. With the default ADK
session store, the workflow appends one event that carries the final
checkpoints to the session itself, before the runner seals the aborted
invocation, so session state shows the run `cancelled` and the step
`interrupted`.

That event also covers a workflow delegated from this one. The root waits up to
500 ms for it to settle. A delegated workflow still going after that, such as a
handler awaiting something that ignores the signal, is recorded as it stood:
its run, and any step it had not recorded yet, stay `running`. What it records
later does not reach the session, and a resume reports that step as
indeterminate.

If the session service rejects that append, the workflow logs
`WORKFLOW_CHECKPOINT_ABORT_RECORD_FAILED` and the session keeps the step
`running`, which a later resume reports as indeterminate.

The workflow execution timeout aborts the same way (`WORKFLOW_ABORTED`), so a
step that was in flight at the timeout is also recorded `interrupted` and a
resume needs `retryFailedSteps` or `resumePolicy: "retry"`. Unlike a caller
abort, the timeout rejects `runAsync` with `WORKFLOW_ABORTED`.

An ADK node `timeout` rejects `runAsync` with ADK's `NodeTimeoutError` before
the workflow has recorded the abort. The `interrupted` record is written
shortly after, so do not exit the process right after that error.

Any abort reason is accepted, except a `WorkflowError` with another code,
which is rethrown as is and ends the execution and step as `failed`. Once the
workflow has settled:

- The checkpoint is `cancelled` with `completedAt` and a `WORKFLOW_ABORTED`
  error.
- Each in-flight step is `interrupted` (not `failed` or `running`), and a
  `step_interrupted` event precedes the terminal `error` event.
- A later resume of the same execution id starts the workflow again, which
  clears the `cancelled` state. When `retryFailedSteps` (or the step's
  `resumePolicy: "retry"`) is set, an `interrupted` step is re-run as the next
  attempt and its `interrupted` status is cleared. Without the opt-in, and on
  a turn that answers a waiting step, the resume fails with
  `WORKFLOW_INDETERMINATE_STEP`, because the aborted step may have had side
  effects; it is not replayed as a failure.
- A step whose `running` record was being saved when the abort landed is
  `interrupted` too, even if its agent never started.
- An abort during the delay before an in-run retry records no new attempt: the
  step keeps the previous attempt's `failed` record and error, and a resume
  without opt-in replays that failure.

If the turn that fails with `WORKFLOW_INDETERMINATE_STEP` was answering a
waiting step, do not send the same answer again: it fails the same way. First
re-enter the execution with a turn that does not carry the answer, with
`retryFailedSteps` (or `resumePolicy: "retry"`) set. That turn re-runs the
`interrupted` step and, when it reaches the waiting step, emits its pending
request again; the next answer turn then proceeds.

### Stopping on Ctrl+C (SIGINT)

Ctrl+C in a terminal or pane sends SIGINT to the foreground process group.
Node and Bun end a process that has no SIGINT listener at once, so nothing
unwinds and no abort is recorded. To stop cleanly, register a listener with
`process.on`, abort the run on the first signal, drain the run, then exit.
Handle repeats yourself: a second Ctrl+C may exit at once, knowingly, and
accepts the state described below.

```ts
const controller = new AbortController();
let signals = 0;
process.on("SIGINT", () => {
  signals += 1;
  if (signals === 1) controller.abort(new Error("SIGINT"));
  else process.exit(130); // second Ctrl+C: stop now, knowingly
});
// Pass controller.signal as `abortSignal` to the run, for example
// `runner.runAsync({ userId, sessionId, newMessage, abortSignal: controller.signal })`,
// drain it, then:
process.exit(0); // after the drain, never inside the first-signal branch
```

Use `process.on` rather than `process.once` because the listener stays
registered, so it also receives the second Ctrl+C. With `process.once` the
first signal aborts the run and drains it as above, but a second signal finds no
host listener and ends the host as it would without any handler.

On macOS and Linux, external CLI agents run in their own process group, so the
terminal does not signal them. While one is live, the bridge forwards the
host's SIGINT, SIGTERM and SIGHUP to it. When the host has its own SIGINT
listener (`process.on` or `process.once`), that listener decides what happens to
the host; the bridge ends the host itself only when no host listener is
registered. On Windows the CLIs are not placed in a separate process group.

If the process tree is killed before the abort unwinds (SIGKILL, a second
forced stop, a crash, a pane that is closed), the store keeps the last
checkpoint it wrote before the kill:

- The execution is still `running` and each in-flight step is `running`, with
  its attempt number; nothing records the stop.
- A resume of that execution id reports `WORKFLOW_INDETERMINATE_STEP` for the
  step, with `stepId` and `attempts`, and runs nothing, because the killed
  attempt may have had side effects.
- A step declared with `resumePolicy: "retry"` runs again as the next
  attempt. `retryFailedSteps` applies to `interrupted` and `failed` steps, not
  to a `running` one.
- A step input hash is checked on resume for every recorded step, so a step
  cannot be resumed with a corrected input; give the step a new id instead.

## Waiting steps

A step whose sub-agent asks for input is stored with `status: "waiting"` and an
`interrupt` (kind, function-call ids, requests and the delegation events, all
JSON). The checkpoint also keeps the original workflow `input` until the
workflow ends, because the turn that answers the step carries only the answer.
A run that fails after a step began waiting keeps that input, so the wait can
still be answered. A resume that re-reaches a recorded wait without an answer
stores the checkpoint as `running` with its input again, which also repairs a
checkpoint written by an earlier release that lost the input.
Both fields are optional, so existing checkpoints load unchanged; a checkpoint
that contains a waiting step cannot be read by earlier versions. Interrupt
events count toward the checkpoint size limit. On load, the fields that
resuming reads from each stored event (`author`, `branch`, `longRunningToolIds`, `content.role`,
`content.parts`, each part's `functionCall`, `actions` and
`actions.stateDelta`) must have their ADK types; a
checkpoint that fails this check is rejected as `checkpoint_file_corrupt`.

## Step limit on a resumed run

`limits.maxSteps` bounds the steps one turn of the workflow may invoke. Steps
replayed from the checkpoint count too. A resumed turn replays every recorded
step through the handler, so in effect the limit bounds every step the
execution has ever run, and a long-lived run reaches `WORKFLOW_LIMIT_EXCEEDED`
on a later resume even though each turn ran few new steps. The error details
carry `limit`, `stepId` and `replayedSteps`, for handler and script workflows
alike, and the execution summary reports `steps` and `replayedSteps`. A script
workflow also bounds its yielded messages at twice `maxSteps` plus one, so a
raised limit raises that bound too.

To continue the run, raise `limits.maxSteps` in the definition (the limit is not
part of the checkpoint identity) and resume the same execution id: finished
steps replay and the run goes on from where it stopped.

## Re-entered steps

When a step runs again, the `step_started` event and the step record in the
checkpoint carry `resumeReason`:

| Value | Meaning |
| --- | --- |
| `interrupted` | The checkpoint had the step as `running` (the process ended before the attempt settled) or as `interrupted` (an abort or timeout stopped it). |
| `retry` | The previous attempt failed (an in-run retry, `retryFailedSteps`, or `resumePolicy: "retry"`). |

A first attempt has no `resumeReason`, and neither do checkpoints written
before this field existed. When a waiting step continues with its answer,
`step_started` is emitted again with the **same** attempt number and no
`resumeReason`: it is the same attempt, not a new one. The step record keeps
the reason that attempt was entered with (for example `interrupted`) while it
waits and after it completes. A stored `resumeReason` outside the two values
is rejected as `checkpoint_file_corrupt`. A `running` step is re-entered only
when its `resumePolicy` is `retry`; otherwise the resume fails with
`WORKFLOW_INDETERMINATE_STEP`.

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
enforce `fencingToken` before every durable write. The reason's `code` is
`WORKSPACE_LEASE_LOST` when the lease expired or was taken over, and
`WORKSPACE_ADAPTER_DISPOSED` when the adapter was disposed.

Lease files written by an older release may hold write paths the
[portable path grammar](./workflow-orchestration.md#identifiers-and-paths)
rejects, such as `x:y` or a path longer than 4096 characters. An expired lease
with such a path is dropped. A live one makes `acquire` and `conflicts` throw
`WorkflowError` with code `WORKFLOW_WORKSPACE_STATE_INCOMPATIBLE` (details:
`workspaceId`, `leaseId`, `ownerId`, `expiresAt`) instead of guessing at its
scope; release it or let it expire.

### Path case

Both adapters compare write paths case-sensitively by default, so on a
case-insensitive filesystem (the macOS and Windows defaults) `Src/a` and
`src/a` would not conflict although they are the same file. Set
`caseInsensitivePaths: true` on `InMemoryWorkspaceAdapter` or
`FileSystemWorkspaceAdapter` for such a workspace: paths then conflict after
Unicode NFC normalization and a full case fold, so `Straße` meets `STRASSE`,
`ς` meets `σ`, and the long s and micro sign meet `s` and `μ`. The fold is
conservative: it may report an overlap the filesystem would not (dotless `ı`
meets `i`), but never fewer. Leases keep the caller's spelling. Every
`FileSystemWorkspaceAdapter` that shares a `stateDirectory` must use the same
setting. Write paths follow the
[portable path grammar](./workflow-orchestration.md#identifiers-and-paths).

## Retired lock tombstones

Both filesystem adapters retire lock directories to deterministic, token-bound
tombstones. When a recoverer retires the lock of a dead owner, the tombstone is
kept: it makes a delayed second recoverer of the same owner fail instead of
moving a newer owner's lock away (the ABA problem). A recoverer reads the owner
again after finding its process dead and retires only a lock that still
carries that owner's token.

A live owner that releases its lock removes its own tombstone, so normal
saves and lease operations leave nothing behind. Only crashes (dead-owner
recoveries) and a crash in the middle of a release add tombstones. Those are
not garbage-collected online. After stopping every writer, use the explicit
offline collectors:

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
cursors, mailbox capacity, and immutable artifact revisions. An artifact
store keys each artifact by execution id and artifact id, and returns only
artifacts of the execution it is asked for; a file-backed store can use
`await workflowArtifactStoragePath({ executionId, artifactId })` for a
`<executionId>/<artifactId>` layout in which each id is one escaped, portable
segment of at most 255 characters (an id whose escaped form is longer becomes
`~` and its SHA-256 hex digest). The last segment is the complete file
name, so do not append an extension; use it as a directory for fixed, short
file names if the store needs several files. An invalid id throws
`WorkflowArtifactIdentityError` with code `WORKFLOW_ARTIFACT_IDENTITY_INVALID`.
See the
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
