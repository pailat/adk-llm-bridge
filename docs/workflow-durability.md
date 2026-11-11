# Workflow durability

`adk-llm-bridge/workflows` has two persistence modes:

- The default `AdkSessionCheckpointStore` emits ADK `stateDelta` values and
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
That rename is the commit. Windows cannot sync a directory (it refuses the
flush with `EPERM`), so there the store skips that one step: NTFS journals the
rename, so after a crash it is there whole or not at all, but a save that
already resolved can be lost to a power failure right after it. File contents
are synced on every platform. Off Windows, a failed directory sync after the
commit rename fails the save. The workspace and repository mutation locks
follow the same rule; a lock whose directory sync fails right after it is
taken is released, and the operation fails. If the release after a commit
fails only on I/O (the rename of the lock or its directory sync), `save` still
resolves and logs the warning
`[adk-llm-bridge] [WORKFLOW_CHECKPOINT_LOCK_RELEASE_FAILED]` through ADK's
logger. If the lock now belongs to another owner, `save` rejects with
`checkpoint_lock_ownership_lost`: another process recovered the lock and may
have written the same checkpoint, so the revision check no longer holds. A
lock with no valid owner at that point rejects with `checkpoint_lock_corrupt`.
A lock left behind by a live process makes the next save of that execution
fail with `checkpoint_lock_timeout`. The store publishes a lock by renaming a
directory that already holds its owner file onto the lock path, and retires it
by renaming the whole directory away, so a concurrent writer never sees a lock
without its owner. To clear a stuck lock by hand while writers may run, rename
the `.lock` directory away first and delete it afterwards: a recursive delete
of the lock path removes the owner file before the directory, and a writer
that looks in between fails with `checkpoint_lock_corrupt`. On Windows a
directory cannot be renamed while another process has a file inside it open,
so a release retries a blocked rename (for up to 5 s, see below) before it
gives up with the `checkpoint_lock_release_failed` warning. A load
refuses a symlink at the checkpoint path before opening it, opens the file
once (without following symlinks where the platform has `O_NOFOLLOW`), and
reads through that handle only when the path names the opened file (device and
inode; volume and file id on Windows). A load takes no lock, so a save can
rename a new checkpoint over the path while it runs: that file is read. A path
that has become a symlink or names another file is refused, so a path swapped
for a symlink after the check is never read, also on Windows, where the open
follows symlinks. On Linux kernels older than about 4.19, `stat` and `fstat`
of a file on overlayfs (container image layers) can report different device
and inode numbers; there every load fails with `checkpoint_file_unsafe`, so keep
the checkpoint root on a volume, not in the image layers.
Checkpoint contents and their deterministic revision are validated on load.
New writes remove runtime-only step events and replay markers before hashing or
persistence. Both bundled checkpoint stores reject malformed durable graphs
and enforce a configurable 4 MiB UTF-8 JSON limit by default.

#### Saving while another process has the checkpoint open (Windows)

On Windows a rename is refused (`EPERM`, `EBUSY` or `EACCES`) while another
process holds the destination, or a file inside the renamed directory, open.
A save publishes the checkpoint with a rename, so it retries a refused rename
with jittered exponential backoff (5 ms doubling to 250 ms) for up to 5 s.
The workspace store's state commit and a lock release use the same wait. A
save therefore waits up to 5 s for other processes that hold the checkpoint
file open, such as readers and other savers, to release it. If one still holds
it after that, the save fails with `checkpoint_write_failed` and
`details.causeCode` `EPERM`, `EBUSY` or `EACCES`; it leaves no temporary file
and the previous revision stays in place. Any other error is not retried.
The wait is bounded, not a guarantee: a reader that re-opens the file with no
gap, so that it is open almost all the time, can make saves fail. A host
should read with open, read, close (the bridge's own `load` does) and do other
work between reads. Tools that tail or watch the checkpoint directory on
Windows, such as antivirus scanners, indexers and editors, can hold files open
too; the error names the cause: `details.causeCode` is `EPERM`, `EBUSY` or
`EACCES`, and `details.waitedMs` is the time the save waited. The wait holds the
checkpoint lock, so under contention a waiting writer may reach
`lockTimeoutMs` first and fail with `checkpoint_lock_timeout`. On macOS and
Linux an open file does not block a rename, so the wait does not run in the
normal path; a real permission error there (`EPERM` or `EACCES`, such as a
read-only directory) now fails after the 5 s instead of at once. The workspace
store and the lock release block the thread while they wait.

### Checkpoint failure reasons

Checkpoint stores throw `WorkflowError` with code `WORKFLOW_EXECUTION_ERROR`
and a `details.reason` from the exported `WorkflowCheckpointFailureReason`
union. `details.checkpointKey` names the checkpoint; file system failures also
carry `details.causeCode` (the system error code) and, when available,
`details.causeMessage`.

| `details.reason` | Meaning |
| --- | --- |
| `checkpoint_revision_conflict` | A compare-and-swap write found another revision (`WorkflowCheckpointConflictError`, with `expectedRevision` and `actualRevision`). Reload and retry. |
| `checkpoint_size_limit_exceeded` | The checkpoint is larger than the configured limit (`maxBytes`, `actualBytes`, `direction`; on a save during a run also `stepId` and `largestContributors`). See [Checkpoint size](#checkpoint-size). |
| `checkpoint_revision_invalid` | The supplied revision does not match the checkpoint, or a stored file carries an invalid revision. |
| `checkpoint_schema_invalid` | A save was given an invalid checkpoint. |
| `checkpoint_file_corrupt` | A stored file is not valid JSON or not a valid checkpoint file. |
| `checkpoint_file_unsafe` | The checkpoint path is a symlink or not a regular file (a directory, a FIFO), or it changed to a symlink or another file while it was read. |
| `checkpoint_directory_create_failed`, `checkpoint_read_failed`, `checkpoint_stat_failed`, `checkpoint_write_failed` | A file system call on the checkpoint failed. |
| `checkpoint_lock_timeout` | The per-checkpoint lock was not acquired in time. |
| `checkpoint_lock_corrupt` | The lock is not a safe directory or has no valid owner; it is never taken over automatically. |
| `checkpoint_lock_ownership_lost` | Another writer took the lock, before the commit or before the release that follows it; the save fails. |
| `checkpoint_lock_acquire_failed`, `checkpoint_lock_candidate_failed`, `checkpoint_lock_candidate_cleanup_failed`, `checkpoint_lock_read_failed`, `checkpoint_lock_recovery_failed`, `checkpoint_lock_release_failed`, `checkpoint_lock_cleanup_failed` | A file system call on the lock failed. A `checkpoint_lock_release_failed` after a committed write is only logged (see above). |

Storage providers that extend `BaseWorkflowCheckpointStore` (see
[Checkpoint providers](#checkpoint-providers)) report their own failures as
`WorkflowStorageError`, with a `WORKFLOW_STORAGE_*` code. The codes and their
meanings are listed in [Choosing storage providers](storage-providers.md#errors).
A revision conflict on save is still `WorkflowCheckpointConflictError`.

## Checkpoint providers

A checkpoint store is a provider the host chooses. Each provider extends
`BaseWorkflowCheckpointStore` and reports what it guarantees in its
`capabilities`:

- `compareAndSet`: `atomic` when the revision check and the write are one
  storage transaction, so exactly one of several concurrent writers wins.
  `advisory` when another writer can commit between the check and the write.
- `leases`: whether leases with fencing tokens are granted and checked in the
  same transaction as a save.
- `durable`: whether a saved checkpoint survives the process.
- `multiProcess`: whether writers in several processes can share the storage.
- `listing` and `pruning`: whether `list` and `delete`/`prune` are implemented.
- `maxCheckpointBytes`: the largest checkpoint, 4 MiB by default.

| Provider | `compareAndSet` | `leases` | `durable` | `multiProcess` |
| --- | --- | --- | --- | --- |
| `InMemoryWorkflowCheckpointStore` | `atomic` | yes | no | no |
| `FileSystemWorkflowCheckpointProvider` | `atomic` | no | yes | yes, one host |
| `SqliteWorkflowCheckpointStore` | `atomic` | yes | yes | yes, one host |
| `AdkSessionServiceWorkflowCheckpointStore` over `DatabaseSessionService` | `atomic` | yes | yes | yes |
| `AdkSessionServiceWorkflowCheckpointStore` over ADK's in-memory service | `advisory` | no | no | no |

`FileSystemWorkflowCheckpointProvider` stores checkpoints through
`FileSystemWorkflowCheckpointStore`, the file-system store described in
[Checkpoint commit semantics](#checkpoint-commit-semantics).

`LeasedWorkflowCheckpointStore` is a decorator. It wraps a provider whose
`capabilities.leases` is `true` and grants an execution lease with a fencing
token. A save that carries a stale token fails with `WORKFLOW_STORAGE_LEASE_LOST`
and is not applied. The lease lasts `DEFAULT_WORKFLOW_CHECKPOINT_LEASE_TTL_MS`
(30 seconds) by default and is renewed every third of that time while the
execution is active. Wrapping a provider with `leases` set to `false` throws
`WORKFLOW_STORAGE_UNSUPPORTED`.

Choose a provider by injecting it through the `checkpointStore` option or by URI
with `getWorkflowCheckpointStoreFromUri`. The full guide, with URIs, custom
schemes, event export and the limits of each provider, is in
[Choosing storage providers](storage-providers.md).

**Migration.** When no `checkpointStore` is given, the workflow runtime keeps
checkpoints in ADK session state through `ADKSessionCheckpointStore`. The
file-system provider is used only when you select it by injection or by a
`file://` URI. A host that does not select a provider gets the runtime default
above.

### Windows: SQLite stores and the JSONL exporter

The SQLite checkpoint store, the SQLite event exporter, the SQLite session
store and the JSONL exporter run on Windows with these differences. How the
file-system store and the exporters sync a directory on Windows is written once,
with the file-system store fix; this section does not repeat it.

- **No owner-only protection.** NTFS has no POSIX mode. Nothing is set to
  `0600` or `0700`, and a database or directory that others can read is left as
  it is, not tightened and not refused. Access follows the ACL of the parent
  directory, so keep the database and the JSONL directory in a directory only
  the account can open.
- **Symbolic links are still refused**, from `lstat` before the open, because
  Windows has no `O_NOFOLLOW`. The refusal holds for a link or junction at the
  database path of the SQLite checkpoint store and event exporter and, for
  those two, at the `-wal` and `-shm` files and the directory. The Claude
  session store refuses a link at its database path only; it follows a link
  in its directory and companion files, as it always did. A link swapped in
  between that check and the open is not caught.
- **No FIFOs.** The checks for a FIFO at the path apply only to POSIX.
- **Open files.** Windows cannot delete or rename a file another process has
  open. The JSONL exporter keeps no file open between calls, so this only
  matters when something else holds a file at the moment `prune` deletes it:
  that call rejects with the file system error and can be repeated. Releasing
  the writer lock ignores a failed delete, as on POSIX.

### Known limits of the JSONL exporter lock

- **Leftover takeover files are not swept.** A process killed in the middle of
  a lock takeover can leave a `.writer.lock.takeover-*` claim or a `*.tmp`
  staging file in the directory. They are harmless and are removed by hand: no
  process deletes a file another process created, because that rule is what
  keeps a crash from leaving two writers.
- **A paused claimer can remove a new lock.** A process that wins a takeover
  and is then paused for more than 60 seconds between its last check of the
  stale lock and the delete can remove a lock a new writer created in the
  meantime. Deleting a file only if it still holds a given token is not
  possible with the file system calls Node offers, and the writer notices the
  loss at its next heartbeat or write and stops.

## Checkpoint size

One execution has one checkpoint, and it grows with every step that
completes: each step result is kept in full, so a later step can be
replayed without running again. A step that returns N bytes of text adds
about N bytes: its text is stored once, in `result.output`. Step inputs are
stored as hashes only, and
step events and replay markers are removed before a save. The original
workflow input is kept only while a step waits for input. Both bundled stores
refuse a checkpoint larger than `maxCheckpointBytes` (4 MiB by default,
`DEFAULT_WORKFLOW_CHECKPOINT_MAX_BYTES`), on save and on load.

### How a step's text is stored

A completed step result carries the text as `output` and the final model
message as `content`. When `content` is exactly
`{ role: "model", parts: [{ text: output }] }` (the usual case for a step that
answers with text), the checkpoint stores `contentFromOutput: true` instead of
`content`. On replay the runtime rebuilds `content` from `output`, so
`ctx.run()` returns the same result as when the step ran. Any other `content`
(several parts, a function call, another role, extra fields) is stored as is.

Code that reads a checkpoint directly (a custom store, an inspection tool)
reads a step result with `workflowStepResultFromCheckpoint(step.result)`,
which rebuilds `content` and drops the marker. A checkpoint written before
this form (an earlier 0.7.0 build) stores both fields; it loads and replays
unchanged, and the next save stores it in the compact form, with a new
revision. A build that does not know `contentFromOutput` reads such a step as
having no `content`.

### When the limit is hit

The size is checked when the step's result is saved, after the step has run.
Whatever the step did (files written, tools called, money spent) has happened,
but its result is not stored: the step is recorded as `failed` with the size
error, and the run fails with `WORKFLOW_EXECUTION_ERROR`,
`details.reason: "checkpoint_size_limit_exceeded"`. The error names the step
(`details.stepId`), the sizes (`actualBytes`, `maxBytes`) and the five largest
parts of the checkpoint (`details.largestContributors`, each
`{ path, bytes }`, such as `["steps", "diff", "result", "output"]`); the
message repeats them. The store's original error is kept as the error's
`cause` (not serialized). The step's recorded failure carries the same details.

A resume after raising the limit cannot recover the lost result:

- with the same store configuration and no retry option, the recorded failure
  is replayed and the step does not run again;
- with a larger `maxCheckpointBytes` and no retry option, the same: the
  failure is replayed, the run fails again with the same error;
- with a larger `maxCheckpointBytes` and `retryFailedSteps: true` or the
  step's `resumePolicy: "retry"`, the step runs again as its next attempt (its
  side effects happen again) and the run continues. Steps completed before it
  are replayed from the checkpoint.

A checkpoint that is already larger than the limit of the store that loads
it fails on load (`direction: "load"`); load it with a store whose limit is at
least as large.

### Warning at 80%

When the store exposes its limit (`WorkflowCheckpointStore.maxCheckpointBytes`;
`ADKSessionCheckpointStore` and `FileSystemWorkflowCheckpointStore` do), a
run emits one `checkpoint_size_warning` event the first time a saved
checkpoint reaches 80% of it (`WORKFLOW_CHECKPOINT_SIZE_WARNING_RATIO`). The
event follows that save's `checkpoint_saved` event and carries
`checkpointKey`, `stepId` (when a step triggered the save), `bytes`,
`maxBytes` and `largestContributors`. It is emitted at most once per
checkpoint key per run (one `WorkflowAgent` invocation); a resumed run can
emit it again. The run is not stopped. A custom store without
`maxCheckpointBytes` gets no warning, and its own size error is still enriched
with `stepId` and `largestContributors` when it uses
`workflowCheckpointSizeLimitError`.

### Keeping checkpoints small

- Return a reference, not the payload. A step that produces a large result (a
  full diff, a corpus, a log, a binary) should write it to an artifact (ADK's
  artifact service, a file, an object store) and return its name, path or
  URL, with a digest when the content must be verified later. The checkpoint
  then stays small and the payload survives a failed run.
- Cap what a step returns. Truncate text that is only read by a later prompt,
  and say where the rest is.
- Watch for `checkpoint_size_warning` and treat it as a design signal, not a
  number to raise.
- Raise the limit only when large results are expected:
  `new FileSystemWorkflowCheckpointStore({ root, maxCheckpointBytes })` or
  `new ADKSessionCheckpointStore({ maxCheckpointBytes })`. Every checkpoint is
  written in full on every save, so a larger limit means more I/O per step, and
  an ADK session service may have its own size limit on state.
- To resume a run that failed on the limit, raise the limit and re-run the
  same execution id with `retryFailedSteps: true` (or give the failed step
  `resumePolicy: "retry"`), accepting that the step runs again.

### Writing your own checkpoint store

A store over another backend implements `WorkflowCheckpointStore`. These
exports from `adk-llm-bridge/workflows` keep it consistent with the bundled
stores:

- `workflowCheckpointRevision(checkpoint)` computes the revision to store with
  a checkpoint, and `workflowCheckpointRevisionMatches(checkpoint, stored)`
  checks a stored revision on load (it also accepts the digest form written
  by 0.7.0 pre-release builds). Throw `WorkflowCheckpointConflictError` when a save's
  `expectedRevision` does not match.
- `assertWorkflowCheckpointSize(checkpoint, key, maxBytes, direction)` rejects
  a checkpoint over the limit, on save and on load.
  `DEFAULT_WORKFLOW_CHECKPOINT_MAX_BYTES` is the bundled stores' 4 MiB
  default. When the store measures the size itself:
  - `workflowCheckpointByteLength(checkpoint)` is the size the limit applies
    to: the UTF-8 byte length of `JSON.stringify(checkpoint)`.
  - `workflowCheckpointSizeLimitError(key, maxBytes, actualBytes, direction)`
    builds the error the bundled stores throw: `WorkflowError` with code
    `WORKFLOW_EXECUTION_ERROR` and `details.reason`
    `checkpoint_size_limit_exceeded`, so callers handle every store alike.
- `stableSerializeWorkflowValue(value)` returns the canonical JSON the
  workflow hashes are computed from (keys sorted by UTF-16 code unit). Use it
  where the store needs a byte-stable form of a JSON value, for example to
  compare two values or as a database key. It throws `WorkflowError`
  (`WORKFLOW_EXECUTION_ERROR`) for a value that is not JSON.

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

Any abort reason is accepted. A `WorkflowError` with another code becomes
`WORKFLOW_ABORTED` and keeps its code as `details.reasonCode`, so it is
recorded like any other abort. Once the workflow has settled:

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

`ctx.parallel` in `failureMode: "fail-fast"` (the default) stops the other
steps the same way when one step fails. The run fails with that step's error
and the checkpoint is `failed`, not `cancelled`; the failing step is `failed`,
and each sibling still in flight is `interrupted` with `WORKFLOW_ABORTED`
(`details.reasonCode` is the failing step's code, `details.failedStepId` its
id) and a `step_interrupted` event. A step still queued behind `concurrency`
is not started and not recorded, so a resume runs it as a first attempt. A resume therefore needs `retryFailedSteps` or
`resumePolicy: "retry"`: with it, the failed step and the interrupted
siblings run again as their next attempt; without it, the resume fails with
`WORKFLOW_INDETERMINATE_STEP` for the interrupted sibling, which may have had
side effects.

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
  The `WORKFLOW_STEP_MISMATCH` error's details name the saved step's
  `savedStatus` and `savedAttempts` next to the saved and current agent,
  revision and input hash, so you can see whether the old step was left
  `running` (its side effects are unknown) before you replace it. There is no
  API to drop a recorded step.

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

An answer resumes the waiting step once. If the resumed delegation then
throws instead of finishing (the run is aborted or times out, the workspace
lease is lost, or a checkpoint save or a hook fails), the step stays `waiting`
with the same interrupt, so the answer can be sent again. The tool the answer
approved may already have run by then: sending the same answer again resumes
the delegation from the same interrupt and can run that tool a second time.
A delegation that finishes with an error is different: the step is recorded
as failed. Before re-sending an answer after such a failure, check whether the
approved action took effect, or make the tool idempotent (see
[Attempt idempotency and durable outboxes](#attempt-idempotency-and-durable-outboxes)).

### Who can write the checkpoint

The default `AdkSessionCheckpointStore` keeps the checkpoint, including the
stored interrupt events of a waiting step, in ADK session state. Session
state is not private to the workflow. The events of a step's sub-agent reach
the Runner with their `stateDelta` unchanged, which nested workflows rely on;
only the step's result has the checkpoint keys removed. A tool that runs in a
step can therefore write any state key, including the parent workflow's
checkpoint key, and replace the checkpoint or its stored interrupt. The
checkpoint's revision does not prevent this: a tool can write a valid
checkpoint with a matching revision.

The key is `WORKFLOW_CHECKPOINT_STATE_PREFIX`, the workflow id and the
execution id, joined by `:`. Code has to choose that key to write it: a model
cannot reach it unless a tool lets the model choose state keys, so do not give
steps such a tool. When steps run tools you do not trust, use
`FileSystemWorkflowCheckpointStore` or your own store: they load the
checkpoint from their own storage, so a write to session state does not change
what a resume reads. (The file system store also puts a copy in session state;
a resume ignores it.)

## Step limit on a resumed run

A turn has two step bounds, and both are checked before a step is saved
`running` or its agent starts, also inside `ctx.parallel`:

| Limit | Counts | Default |
| --- | --- | --- |
| `limits.maxSteps` | Steps whose agent may run in this turn: a new or retried step, a waiting step that continues with the turn's answer, and a step a `beforeStep` or `beforeAttempt` hook answers (it is admitted before the hook runs). | 100 |
| `limits.maxReplayedSteps` | Steps answered from the checkpoint: a recorded result, or a recorded failure replayed as that failure. | Ten times the effective `maxSteps` (1000 with the default) |

A resumed turn replays every step the execution recorded before, so a
long-lived run needs no larger `maxSteps` on a later resume: only the steps it
executes in that turn count. The replay bound still grows with the life of the
run and guards against a script that loops over recorded steps.

On `WORKFLOW_LIMIT_EXCEEDED` the details carry `limit` (the bound that was
passed), `limitName` (`"maxSteps"` or `"maxReplayedSteps"`), `stepId` (the
first step over it), `executedSteps` and `replayedSteps` (the counts before
that step), `maxSteps` and `maxReplayedSteps`, for handler and script
workflows alike. The execution summary reports `steps` and `replayedSteps`;
its `replayedSteps` also counts the steps a hook answered.

A script workflow follows the same rule: `ScriptWorkflowAgent` with a
checkpoint store lets the workflow runtime count each step, and bounds the
guest's yielded messages at twice `maxSteps + maxReplayedSteps` plus one
(twice `maxSteps` plus one without a checkpoint store). Called directly,
`runWorkflowScript` counts every requested step toward `maxSteps` before the
host runs it, unless the host passes `replaysFromCheckpoint: true`. Then the
runner cannot know which steps replay, so it only refuses a request that would
take the turn past `maxSteps + maxReplayedSteps` (`limitName:
"maxSteps + maxReplayedSteps"`, with `requestedSteps` instead of the per-kind
counts), and the host must enforce each bound before running a step's agent,
as the workflow runtime does.

To continue a run stopped by either bound, raise that limit in the definition
(limits are not part of the checkpoint identity) and resume the same execution
id: finished steps replay and the run goes on from where it stopped.

## Stored step models

A completed step's checkpoint result may carry `models` (`requested`,
`resolved` as arrays of non-empty strings, `unknown` as a boolean), next to
`usage`. A checkpoint written before 0.7, or for a step whose agent has no
model information, has none and loads as before. A stored `models` that is not
exactly that shape makes the checkpoint corrupt, like a malformed `usage`.

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

## Model and input changes on replayed steps

A step's identity is its agent name, agent revision and input hash. Any
difference is `WORKFLOW_STEP_MISMATCH`. The model is **not** identity:

| Part | Role |
| --- | --- |
| `agentName`, `agentRevision`, input hash | Identity. A difference stops the run. |
| `model.requested` | Recorded when each attempt starts. Reported when it changes, or compared in strict mode. |
| `result.models` | Recorded when the step completes: `requested`, `resolved`, `unknown`. History only. |
| `acceptances` | Audit entries of host-accepted changes on a completed step (see below). Audit only, never authority. |
| Workflow input, version, script source | Identity of the whole execution. |

A completed step's result is history: the model the checkpoint recorded
produced it, and replaying it does not claim the new model did. Changing the
model table to tune cost between runs is normal, so by default it is a report,
not a stop. `agentRevision` stays the explicit, host-chosen "a different build
must not replay" signal. `ExternalAgentWorkflowFactory` leaves its top-level
`config.model` out of the revision for this reason.

### Warn (default) and strict

`replay: { modelChange: "warn" | "mismatch" }` on `WorkflowAgent` and
`ScriptWorkflowAgent`:

- `warn`: the step replays; the runtime emits `step_model_changed` and logs
  `WORKFLOW_STEP_MODEL_CHANGED`. A replayed or resumed step whose checkpoint
  has no model record (written before the field existed) cannot be compared:
  it gets no event, and the turn logs one `WORKFLOW_STEP_MODEL_UNRECORDED`
  with the count and the first ten step ids.
- `mismatch`: the same situation throws `WORKFLOW_STEP_MISMATCH` with
  `mismatch: ["model"]`, `savedRequestedModel` and `requestedModel`. Strict
  mode needs both models known: a missing record, or an agent with no model,
  also throws. Pair it with `requireExplicitModel` and full model ids, since an
  alias hides a remap. An execution started before the field existed fails on
  every reused step in strict mode: resume it in `warn` mode.

Only a step whose saved outcome is reused is checked (a completed step, a
recorded failure, a waiting step). A step that runs again uses the current
model. Only the step's own agent is compared (see the residuals below).

`WORKFLOW_STEP_MISMATCH` details name every differing part in `mismatch`, in
the order `agentName`, `agentRevision`, `input`, `model`. When a host
acceptance named another current value for a differing kind, the details also
list that kind in `acceptanceToDoesNotMatch`. The details never carry input
text, lengths of the input or any hint about where it changed.

### Finding what changed in an input

A step whose input changed after it completed (for example a prompt file read
into the input was edited) stops with `mismatch: ["input"]`. To find the
change, the checkpoint stores a fingerprint of each step input while
`replay.inputDigest` is on (the default): `inputLength` for every step, and
`inputDigest` (`chunkSize` and 2 to 32 digests of 12 hex characters) for an
input longer than 256 UTF-16 code units. On a mismatch the host gets a hint:
both lengths, the first differing window (a whole chunk) and a structural path
such as `parts[2].text`, built only from a fixed list of `Content` field names
(any other key is `?`). Truncation at a chunk boundary gives an empty window
at the end of the current input. The window refers to
`workflowStepInputCanonicalForm(input)`: read it locally with
`.slice(start, end)`.

The hint goes to **host-only** channels, never into the error: the mismatch
details are saved as the execution's error and emitted in `step_failed` and
`error` events, where a parent agent can read them.

- `replay.onStepMismatch(hint)`: called once and awaited before the error is
  thrown, so the host has the hint first. A callback that never settles holds
  the turn, like any host hook. Its own errors are logged and ignored; the
  mismatch is thrown regardless. The hint is `{ stepId, diff }`, where `diff`
  is `{ available: true, savedLength, length, chunkSize?, firstDifference:
  { start, end }, path? }` or `{ available: false, reason }`, with `reason`
  `not-recorded` (an older or legacy-form step, saved without a fingerprint), `disabled` or
  `inconclusive` (every compared chunk equal although the hashes differ).
- Without a callback, a `WORKFLOW_STEP_MISMATCH_HINT` warning with the same
  lengths, window and path. If your logs land where agents can read them (a
  workspace `run.log`), set the callback or `inputDigest: false`.

**Residual, exactly.**

- At rest: for a multi-chunk input, an unsalted 48-bit digest per chunk of at
  least 256 code units, at known offsets. A reader of the checkpoint can
  confirm guesses one chunk at a time. That matters for a low-entropy secret in
  an otherwise predictable chunk (a 6-digit code in a template chunk is about
  10^6 hashes); the whole-input `inputHash` alone does not allow that unless
  every other byte is known. The same reader already sees every completed
  step's output.
- At rest: `inputLength` is stored for every step while the option is on,
  including single-chunk inputs, which store no digest.
- Online: whoever sees the hint and can shape a step's input learns which chunk
  first differs. Each guess costs a relaunch by the host, and the hint stays on
  the host-only channels above.
- Mitigations: keep secrets out of step inputs (credentials go through the
  credential environment, not prompts); `replay.inputDigest: false` writes
  nothing and the hint says `disabled`; a single-chunk input stores no digest.
  There is no salt: one stored in the checkpoint would not stop its reader.
- Only the step's own agent's requested model is compared. Models of nested
  agents are recorded in `result.models` and shown as `savedResolvedModels`,
  but a change in them neither warns nor fails strict mode. Put nested models
  in the step agent's `agentRevision` if they must be identity.
- Resolved models are not compared: nothing runs on a replay, so the current
  resolved model is unknown.
- The saved record keeps the model the step ran with, so after a warning it
  still names the old model. A step that waited and resumes keeps the model its
  attempt started with.

### Accepting a known-equivalent change

When the change is known to be equivalent (whitespace in a prompt file, a model
swap you have checked), the host can keep a completed step's saved result with
`replay.acceptChanges`. Do not edit the checkpoint.

```ts
const acceptChanges = parseWorkflowReplayAcceptances(
  JSON.parse(await readFile(operatorFile, "utf8")), // a host-only file, see below
);
new WorkflowAgent({ ..., replay: { acceptChanges } });
```

Each entry is exact: `executionId`, `stepId`, `kind` (`input` or `model`),
`from` (the saved value), `to` (the current value) and a `reason` (1 to 512
characters, no control characters), plus an optional `approvedBy` label. For
`input`, `from` and `to` are the `savedInputHash` and `inputHash` of the
mismatch details. For `model`, they are model ids. There are no wildcards,
prefixes or "accept all".

- **Checked before any step runs.** Entries for this execution are matched to
  the loaded checkpoint first. A step that does not exist or is not
  `completed`, a `from` that is not the saved value, a `model` entry for a step
  without a recorded model, or a step that would hold more than 32 accepted
  changes fails the turn with `WORKFLOW_REPLAY_ACCEPTANCE_INVALID` (details:
  `executionId`, `stepId`, `kind`, `reason`, `savedStatus`, `count`; never the
  reason text). Nothing is saved: the execution keeps its status and resumes
  with a corrected entry. Entries for other executions are ignored; their
  count is logged at debug level (`WORKFLOW_REPLAY_ACCEPTANCE_OTHER_EXECUTION`),
  so a typo in `executionId` is findable.
- **Applied in one save.** When the step is reached, its agent name and
  revision are unchanged and its current value equals `to`, the change and its
  audit entry are saved together, then the step replays: `checkpoint_saved`,
  `step_change_accepted`, `step_replayed`, and a `WORKFLOW_REPLAY_CHANGE_ACCEPTED`
  warning. A failed save means no replay. A `to` that does not match is the
  ordinary `WORKFLOW_STEP_MISMATCH`.
- **What is recorded.** After an accepted input change, the step's `inputHash`
  is the accepted input's hash (and its fingerprint is the new input's); the
  audit entry keeps the old hash. An accepted model change leaves
  `model.requested` as the step ran; the entry's `to` becomes the model every
  later comparison uses.
- **Idempotent.** A relaunch with the same entry is a no-op; without it the
  step replays, because the saved value now equals the current one. An entry
  this turn did not apply (a step not reached, or a value that did not change)
  is logged once as `WORKFLOW_REPLAY_ACCEPTANCE_UNUSED`.
- **Never acceptable:** agent name, agent revision, step status, workflow
  input, workflow version and script source. The host owns the revision and
  can set it back.

**Where acceptances come from.** Acceptances must come from a host-only
source: the operator's command line, or a file outside every agent's
`workingDirectory`, `allowedPaths` and `readPaths`, outside every lane
worktree, and writable only by the operator. No code check can tell where the
host read them. An agent that can write the acceptance file can turn a changed
input into a replay of the old result. Example: a review step's input is the
code diff. An agent changes the code, then writes an acceptance from the old
diff hash to the new one. On relaunch, the old PASS verdict replays for the new
code, and the gate is defeated.

- `approvedBy` is a label for the audit, not authentication. Nothing checks
  it. Two-person approval is the host's job, before it builds the config.
- Workflow code (a trusted handler or a sandboxed script), hooks, agents and
  the run spec cannot add, change or read acceptances. The list is validated
  and copied when the agent is built, so changing the caller's array later has
  no effect.
- The checkpoint store is trusted. Stored entries are audit, not authority: a
  stored entry grants nothing on a later turn. Someone who can write the store
  can forge any checkpoint anyway.
- The `step_change_accepted` event carries the whole audit entry, reason and
  full `from`/`to` included: give event consumers the same trust as the
  checkpoint. The warning and the span event (`step_change_accepted`, with
  kind, `from`, `to`, `approvedBy` and the reason length) never carry the
  reason, and show an input digest only as `sha256:` and its first 12 hex
  characters: an unsalted digest of a short input (a yes/no decision) can be
  reversed by guessing. Model ids appear whole.

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

## Host sleep and wall-clock steps

A run on a host that sleeps (a closed laptop lid, macOS or Linux suspend) looks
hung: no JavaScript timer fires and no heartbeat renews anything until the host
wakes. The wall clock keeps moving, so on wake `Date.now()` has jumped forward
by the time spent asleep. Whether that time also counts toward a pending timer
delay depends on the runtime and the operating system; do not rely on either.
The bridge uses two clocks on purpose:

- Durable expiry shared between processes is wall time (epoch milliseconds),
  because it is persisted and compared by other processes. Time asleep counts.
- Waits and budgets that start and end in one process use a monotonic clock, so
  a wall-clock step (an NTP correction, a manual change, or the jump on wake)
  neither ends them early nor stretches them. That covers the workspace state
  lock wait (`lockAcquireTimeoutMs`), the checkpoint lock wait
  (`lockTimeoutMs`), the repository mutation lock wait (`acquireTimeoutMs`),
  the 500 ms grace for delegated runs after an abort, and the sandbox CPU
  budget (`cpuTimeMs`).

What a sleep longer than the relevant limit does:

| Mechanism | Clock | After wake |
| --- | --- | --- |
| `FileSystemWorkspaceAdapter` lease (`leaseTtlMs`) | wall | Expired. The next heartbeat or expiry timer finds it purged and aborts `lossSignal` with `WORKSPACE_LEASE_LOST`; the step fails with `WORKFLOW_WORKSPACE_LEASE_LOST`. Another process may already hold the paths with a higher `fencingToken`. |
| Task claim lease (`WorkflowTaskController`, `leaseDurationMs`) | wall | Expired. The next heartbeat or settle fails with `WORKFLOW_TASK_LEASE_EXPIRED`, and a dispatcher sweep returns the task to the queue. |
| Mutation reservation (`WorkflowLiveChangeReceiptAuthority`, `reservationTtlMs`, default 60 s) | wall | Expired after a sleep longer than the TTL. On wake the reservation is marked `expired` and the change is reconciled as `ambiguous`; the ownership and plan controllers no longer count it as active. Raise `reservationTtlMs` on hosts that sleep, at the cost of slower recovery from a crashed holder. |
| Checkpoint lock and repository mutation lock | none | Not time-based: a lock is held while its owner process is alive, so sleep does not release it. |
| Lock wait timeouts, delegated-run grace, sandbox `cpuTimeMs` | monotonic | Unaffected by the wall-clock jump. |
| Execution `timeoutMs`, node `timeout`, retry backoff delays | runtime timers | Fire on wake at the earliest, possibly later. An execution or node timeout that fires aborts the run as described in [Stopping a run](#stopping-a-run). |
| External agent runs (Claude, Codex, Gemini CLIs) | none of the bridge's | The bridge sets no run timeout of its own; the CLI process is suspended with the host. On wake it continues, or fails if its provider connection dropped, and the step fails or retries by its policy. |

Between wake and the first heartbeat, local code can still run with a
workspace lease that durable state already dropped. That is the same window as
any paused process, and a writer that enforces `fencingToken` (see
[Workspace leases and fencing](#workspace-leases-and-fencing)) rejects its
writes.

What the operator should do:

- Keep the host awake for long runs. On macOS run the host under
  `caffeinate -i` (for example `caffeinate -i bun run my-workflow.ts`); on
  Linux use `systemd-inhibit --what=sleep`; on Windows keep the power plan from
  sleeping while the run lasts.
- After a sleep, resume with the same execution id, as after any interruption.
  Completed steps replay from the checkpoint. A step that was in flight is
  recorded `interrupted` (or left `running` if the process ended), so the resume
  needs `retryFailedSteps` or `resumePolicy: "retry"`; see
  [Re-entered steps](#re-entered-steps).
- Size `leaseTtlMs` for process death, not for sleep: a TTL long enough to cover
  a closed lid also delays recovery from a crashed writer by that long.

## Retired lock tombstones

Both filesystem adapters retire lock directories to deterministic, token-bound
tombstones. When a recoverer retires the lock of a dead owner, the tombstone is
kept: it makes a delayed second recoverer of the same owner fail instead of
moving a newer owner's lock away (the ABA problem). That recoverer's rename
onto the tombstone fails with `EEXIST` or `ENOTEMPTY`, or with `EPERM` on
Windows, and it goes back to waiting for the lock. A recoverer reads the owner
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
