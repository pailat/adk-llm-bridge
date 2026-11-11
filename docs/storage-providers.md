# Choosing storage providers

> **Experimental.** The storage API is marked `@experimental` in its TSDoc.
> Import paths and option names can change until the API is marked stable.

Workflows keep two kinds of data outside the run: **checkpoints**, which let an
execution resume after a restart, and **events**, the log of what an execution
did. Each kind has a provider you choose. This page lists the providers, how to
select one, how events are exported, and the limits of each. The durability
rules are in [Workflow durability](workflow-durability.md).

## Import paths

| Import path | Contents | Runtime needed |
| --- | --- | --- |
| `adk-llm-bridge/workflows` | The base classes, the in-memory, file-system and ADK-session checkpoint providers, the JSONL and in-memory exporters, the registry functions, the Runner plugin and span processor | none beyond the peers |
| `adk-llm-bridge/workflows/checkpoint/sqlite` | `SqliteWorkflowCheckpointStore` | `node:sqlite` |
| `adk-llm-bridge/workflows/events/sqlite` | `SqliteWorkflowEventExporter` | `node:sqlite` |
| `adk-llm-bridge/workflows/storage/conformance` | The conformance suite | none |

The root, agents and workflows entries import without `node:sqlite`. The SQLite
classes load `node:sqlite` when a database is first opened, and a `sqlite://` URI
loads the subpath on first use.

## Providers

### Checkpoint providers

Every checkpoint provider extends `BaseWorkflowCheckpointStore` and reports
what it guarantees in `capabilities`. The runtime reads these flags, and a
provider never claims more than it enforces.

| Class | URI | Optional peer or runtime | `compareAndSet` | `leases` | `durable` | `multiProcess` | `listing` | `pruning` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `InMemoryWorkflowCheckpointStore` | `memory://` | none | `atomic` | yes | no | no | yes | yes |
| `FileSystemWorkflowCheckpointProvider` | `file:///absolute/root` | none | `atomic` | no | yes | yes, one host | yes | no |
| `SqliteWorkflowCheckpointStore` | `sqlite:///absolute/path.db` | `node:sqlite` (Node 22.13 or later, or Bun) | `atomic` | yes | yes | yes, one host | yes | yes |
| `AdkSessionServiceWorkflowCheckpointStore` over an ADK `DatabaseSessionService` | `adk-session+<uri>`, `postgres://`, `postgresql://`, `mysql://`, `mariadb://`, `mssql://`, `vertexai://` | `@google/adk` (peer) and the database driver ADK needs | `atomic` | yes | yes | yes | yes | yes |
| `AdkSessionServiceWorkflowCheckpointStore` over an ADK in-memory service | `adk-session+memory://` | `@google/adk` (peer) | `advisory` | no | no | no | yes | yes |

The table reads the default settings. `durable` for the ADK provider comes from
its `durable` option. It defaults to `false` for ADK's `InMemorySessionService`
and to `true` for every other service. `compareAndSet` and `leases` for the ADK
provider come from its `concurrency` option. The default is
`stale-session-reject` for a `DatabaseSessionService` that rejects stale
sessions (ADK's default `staleSession: "reject"`) and `none` otherwise. If the
setting cannot be read, the default is `none`, so the provider claims less.
Setting `concurrency: "stale-session-reject"` (or
`?concurrency=stale-session-reject`) is refused with
`WORKFLOW_STORAGE_INVALID_OPTION` over a service that does not reject stale
sessions: ADK's `InMemorySessionService` (so `adk-session+memory://`),
`VertexAiSessionService`, or a `DatabaseSessionService` created with another
`staleSession` setting. For a service of your own, the option is your statement
that it rejects stale sessions.

`LeasedWorkflowCheckpointStore` is a decorator, not a URI. It wraps a provider
whose `capabilities.leases` is `true`; wrapping any other provider throws
`WORKFLOW_STORAGE_UNSUPPORTED`. Its lease lasts
`DEFAULT_WORKFLOW_CHECKPOINT_LEASE_TTL_MS` (30000 ms) unless you set `ttlMs`. See
[Checkpoint providers](workflow-durability.md#checkpoint-providers) in the
durability guide for lease behavior.

Two classes sit behind these providers. `FileSystemWorkflowCheckpointProvider`
stores through `FileSystemWorkflowCheckpointStore`, which you can also use
directly. `AdkSessionCheckpointStore` (also exported as
`ADKSessionCheckpointStore`) is the store the workflow runtime uses when
no `checkpointStore` is given. It keeps checkpoints in ADK session state and
enforces the `maxCheckpointBytes` limit, 4 MiB by default. Its capabilities are
not in the table above.

Every checkpoint provider reports `maxCheckpointBytes` in its capabilities: the
largest checkpoint, in UTF-8 JSON bytes. Set it with the `maxCheckpointBytes`
option, or the `maxCheckpointBytes` URI parameter.

### Event exporters

Every event exporter extends `BaseWorkflowEventExporter`.

| Class | URI | Optional peer or runtime | `durable` | `multiProcess` | `listing` | `pruning` |
| --- | --- | --- | --- | --- | --- | --- |
| `InMemoryWorkflowEventExporter` | `memory://` | none | no | no | yes | yes |
| `JsonlWorkflowEventExporter` | `file:///absolute/directory` | none | yes | no | yes | yes |
| `SqliteWorkflowEventExporter` | `sqlite:///absolute/path.db` | `node:sqlite` (Node 22.13 or later, or Bun) | yes | yes, one host | yes | yes |

The event side also has two runtime hooks that send records to any exporter:
`WorkflowEventExportPlugin` (an ADK Runner plugin) and
`WorkflowSpanExportProcessor` (an OpenTelemetry span processor). They are
described under [Event export](#event-export).

### Reference: other stores

These stores are not workflow checkpoint providers, but they are often chosen
alongside them.

| Store | What it keeps | Where it is documented |
| --- | --- | --- |
| `SqliteSessionStore` (`adk-llm-bridge/agents/session-store/sqlite`) | Claude Agent SDK session transcripts, mirrored to a SQLite file | [Persisting Claude sessions](claude-session-store.md) |
| ADK `InMemorySessionService` | ADK sessions, in process memory only | ADK documentation |
| ADK `DatabaseSessionService` | ADK sessions in a SQL database; the backend of `adk-session+` URIs | ADK documentation |

## Injection or URI

Pick one of two ways to choose a checkpoint provider.

**Inject an instance.** Pass the provider to the `checkpointStore` option of the
agent. The agent uses that instance directly, and you own its lifetime. The
SQLite class lives in its own subpath:

```ts
import { WorkflowAgent } from "adk-llm-bridge/workflows";
import { SqliteWorkflowCheckpointStore } from "adk-llm-bridge/workflows/checkpoint/sqlite";

const checkpointStore = new SqliteWorkflowCheckpointStore({
  path: "/var/lib/app/workflows.db",
});
const agent = new WorkflowAgent({ name: "release", definition, agents, checkpointStore });
```

**Select by URI.** Call `getWorkflowCheckpointStoreFromUri` with a URI. It
returns a provider and throws if the scheme is unknown. The same
`getWorkflowEventExporterFromUri` selects an event exporter.

```ts
import { getWorkflowCheckpointStoreFromUri, WorkflowAgent } from "adk-llm-bridge/workflows";

const checkpointStore = await getWorkflowCheckpointStoreFromUri(
  "sqlite:///var/lib/app/workflows.db?busyTimeoutMs=10000&synchronous=normal",
);
const agent = new WorkflowAgent({ name: "release", definition, agents, checkpointStore });
```

URI query parameters are checked. An unknown name, a value out of range, or a
repeated name throws `WORKFLOW_STORAGE_INVALID_URI`, and so does a file path
with a `.` or `..` segment (also when percent-encoded) or a NUL byte. Passwords
in a URI, query parameters whose name looks secret (`api_key`, `access_token`,
`sslpassword` and the like) and the fragment are replaced by `***` in logs and
errors; `redactWorkflowStorageUri` does the same for any string you log.

When no `checkpointStore` is given and no URI is used, `WorkflowAgent` keeps
checkpoints in ADK session state through `ADKSessionCheckpointStore`. The file
system provider is used only when you select it. The default did not change in
this release: before the storage providers were added it was
`ADKSessionCheckpointStore`, and it still is.

## Custom schemes

`registerWorkflowStorageProvider(scheme, factory)` adds a scheme to the registry
that every entry point of the package shares. The factory can provide a
checkpoint store, an event exporter, or both.

```ts
import { registerWorkflowStorageProvider, getWorkflowCheckpointStoreFromUri } from "adk-llm-bridge/workflows";

const unregister = registerWorkflowStorageProvider("dynamodb", {
  checkpointStore: (uri, options) => new DynamoCheckpointStore({ table: uri.path, ...options }),
});

const store = await getWorkflowCheckpointStoreFromUri("dynamodb://workflow-checkpoints");
```

`DynamoCheckpointStore` is your class, a `BaseWorkflowCheckpointStore` subclass.

Rules, from the code:

- A scheme starts with a letter and uses only letters, digits, `+`, `-` and `.`.
  It is compared in lower case.
- A second registration of a taken scheme throws
  `WORKFLOW_STORAGE_SCHEME_ALREADY_REGISTERED`. Pass `{ replace: true }` to replace
  a scheme, including a built-in one.
- The function returns an `unregister` callback. It removes the registration and
  restores the scheme it replaced.
- `listWorkflowStorageSchemes()` lists every registered scheme, its capabilities
  (`checkpoints`, `events`) and whether it is built in.
- A scheme with no factory for the requested capability throws
  `WORKFLOW_STORAGE_UNSUPPORTED`.

Built-in checkpoint URI schemes (`WORKFLOW_CHECKPOINT_URI_SCHEMES`):
`memory://`, `file://`, `sqlite://`, `adk-session+memory://`,
`adk-session+sqlite://`, `adk-session+postgres://`, `adk-session+postgresql://`,
`adk-session+mysql://`, `adk-session+mariadb://`, `adk-session+mssql://`,
`adk-session+vertexai://`, `postgres://`, `postgresql://`, `mysql://`,
`mariadb://`, `mssql://` and `vertexai://`. The last six are the same as the
`adk-session+` form with that URI.

Built-in event URI schemes (`WORKFLOW_EVENT_URI_SCHEMES`): `memory://`, `file://`
and `sqlite://`.

Use `WORKFLOW_CHECKPOINT_URI_SCHEMES` and `WORKFLOW_EVENT_URI_SCHEMES` in code
to read these lists at run time.

## Event export

Events reach an exporter in one of two ways. Use one or both. Neither changes
how a workflow runs.

### Runner plugin

`WorkflowEventExportPlugin` is an ADK Runner plugin. It observes every event the
Runner yields and turns it into records. It returns no change to the event and
never delays it.

```ts
import { Runner } from "@google/adk";
import { getWorkflowEventExporterFromUri, WorkflowEventExportPlugin } from "adk-llm-bridge/workflows";

const exporter = await getWorkflowEventExporterFromUri("file:///var/lib/app/events");
const runner = new Runner({
  appName,
  agent,
  sessionService,
  plugins: [new WorkflowEventExportPlugin({ exporter })],
});
```

The plugin's name defaults to `WORKFLOW_EVENT_EXPORT_PLUGIN_NAME`. Its
`includePartial` option defaults to `false`, so streaming chunks are not exported
unless you set it. At the end of a run it waits up to `flushOnRunEndMs` (default
2000 ms) for buffered records.

The plugin takes an existing `pipeline` or the options to create one, so you can
share one pipeline between the plugin and the span processor.

### OpenTelemetry span processor

`WorkflowSpanExportProcessor` has the shape of an OpenTelemetry `SpanProcessor`.
It exports finished spans in the `gcp.vertex.agent` scope by default; set
`scopes` to change it. Each finished span becomes one record of kind `span`.
It only reads spans, never throws, and does nothing when no tracer provider is
registered.

```ts
import { maybeSetOtelProviders } from "@google/adk";
import { WorkflowSpanExportProcessor, WorkflowEventExportPipeline } from "adk-llm-bridge/workflows";

const pipeline = new WorkflowEventExportPipeline({ exporter });
const processor = new WorkflowSpanExportProcessor({ pipeline });
maybeSetOtelProviders([{ spanProcessors: [processor] }]);
```

Pass the same `pipeline` to `WorkflowEventExportPlugin` to write both kinds of
record through one buffer. A span's execution id comes from the
`WORKFLOW_EXECUTION_ID_SPAN_ATTRIBUTE` attribute, which the workflow runtime sets
on its `invoke_workflow` span. Spans of the same trace without that attribute go
to `trace:` plus the trace id.

### Record shape

Each record is a JSON object with these fields:

| Field | Meaning |
| --- | --- |
| `id` | Idempotency key, unique within the execution. The ADK event id for events, `span:` plus the span id for spans. Appending an id the execution already holds stores nothing. |
| `executionId` | The execution. A record made outside a workflow uses `invocation:` plus the ADK invocation id, or `trace:` plus the trace id. |
| `kind` | `workflow`, `step`, `agent_run`, `span` or `warning`. |
| `type` | Event type inside the kind, for example `step_completed`. |
| `timestamp` | Epoch milliseconds of the event. For a span, its end time. |
| `sequence` | Position in the execution's log, assigned by the exporter. |
| `workflowId`, `stepId`, `attempt`, `agentName`, `invocationId`, `traceId`, `spanId`, `parentSpanId` | Optional context, present when known. |
| `payload` | The event itself, clipped to the size limit. |
| `clipped` | Present when the payload was shortened: `originalBytes`, `sha256`, `paths`, `payloadDropped` and an optional `reference`. |

`workflowEventRecordsFromAdkEvent` turns one ADK event into records before
clipping, and `workflowEventRecordFromSpan` does the same for one finished span.
`WorkflowEventRecordInput` is the record without `sequence`. A `checkpoint_saved`
record holds the checkpoint key in its payload, never the checkpoint: the values
of the event's state delta are replaced by their sizes.

### Sequence

The exporter assigns `sequence`. The first record of an execution is 1, and each
new record is one more than the last, with no gaps and no repeats. Records of one
execution are appended in the order they were offered. A retried batch adds no
duplicates, because the exporter skips ids it already holds. `append` reports
`lastSequence` after each call.

### Clipping

`clipWorkflowEventRecord` shortens a record to `maxRecordBytes`. The rules apply in
this order:

1. A record within `maxRecordBytes` is unchanged. The exporter default is
   `DEFAULT_WORKFLOW_EVENT_RECORD_MAX_BYTES`, 256 KiB.
2. Otherwise each string in `payload` longer than `maxStringBytes` is cut at a
   character boundary and ends with `…[clipped N bytes]`, longest first, until the
   record fits. `clipped.paths` lists the JSON pointers of the cut strings.
   `maxStringBytes` defaults to `DEFAULT_WORKFLOW_EVENT_STRING_MAX_BYTES`, 16 KiB.
3. If the record still does not fit, `payload` becomes `{}` and
   `clipped.payloadDropped` is `true`.

`clipped.originalBytes` and `clipped.sha256` describe the payload before
clipping. The ids, `kind`, `type` and the other envelope fields are never changed.

An `overflow` handler can store the full payload of a clipped record, for example
as an ADK artifact. `createArtifactOverflowHandler` builds one. The store runs in
the background; if it throws or runs past `appendTimeoutMs`, the record is
exported clipped, without a `reference`. A record whose envelope alone exceeds
`maxRecordBytes` throws `WORKFLOW_STORAGE_PAYLOAD_TOO_LARGE`.

### Failure policy

The pipeline never affects the run. Its rules, each enforced by the code:

- `offer` is synchronous, never throws, and never waits for storage.
- A failing `append` is retried with backoff. Defaults: 5 tries, 100 ms initial
  delay, doubling up to 5 s. Each try is limited by `appendTimeoutMs` (default
  5000 ms).
- The first failure raises a `WORKFLOW_EVENT_EXPORT_DEGRADED` warning.
- When the retries run out, or the error cannot be retried, the batch is dropped
  and a `WORKFLOW_EVENT_EXPORT_DROPPED` warning is raised. `reason` is one of
  `retries_exhausted`, `non_retryable`, `buffer_full`, `closed` or
  `invalid_record`.
- When the buffer is full (`maxBufferedRecords`, default
  `DEFAULT_WORKFLOW_EVENT_BUFFER_RECORDS`, 10,000, or `maxBufferedBytes`, default
  `DEFAULT_WORKFLOW_EVENT_BUFFER_BYTES`, 32 MiB), the newest record is dropped and
  counted.
  One `WORKFLOW_EVENT_EXPORT_DROPPED` warning is raised per burst.
- When appends succeed again, a `WORKFLOW_EVENT_EXPORT_RECOVERED` warning is
  raised.
- Dropped records are reported in the log: one record of kind `warning` is
  appended per burst once the exporter accepts writes again. It takes the next
  sequence, so the log has no gap and states how many records are missing.
  `close` also appends warnings that no later record has reported.
- `flush` and `close` wait at most their time limit and never reject.

Warnings reach the host three ways: the `onWarning` option, a line in ADK's logger
with the code in brackets, and the `warning` record above.

Other pipeline defaults: `maxBatchRecords` 200, `flushIntervalMs` 100,
`appendTimeoutMs` 5000. Pass `maxBufferedRecords`, `maxBufferedBytes`,
`maxBatchRecords`, `flushIntervalMs`, `appendTimeoutMs`, `retry`, `overflow`,
`onWarning` or `maxStringBytes` to change them.

### What is lost on kill -9

Records waiting in the pipeline buffer when the process is killed are lost. The
stored log stays valid and has no gaps, because a record is only stored by an
`append` that completed. For the JSONL exporter, a last line cut short by the
kill is skipped by readers and removed by the next writer when it first appends
to that execution. Other malformed lines are
reported as `WORKFLOW_STORAGE_CORRUPT`. A checkpoint is not affected in the same
way: a process killed during a SQLite save leaves the previous checkpoint.

## Shutdown

The pipeline's batching, retry and timeout timers do not keep the process alive,
so an idle pipeline never holds a process open. An awaited `flush` or `close`
does keep the process alive until it ends or its time limit passes. This also
holds for the plugin's end-of-run flush (`flushOnRunEndMs`) and for the span
processor's `forceFlush` and `shutdown`. A script whose only work is the run
therefore exports its records and reaches the code after its run loop. A time
limit above 2147483647 ms (the largest delay a timer honors) is capped to that
value, so a very large limit means "wait as long as it takes", not "do not wait".

Records offered after the last flush are still buffered. Before the process
exits, close in this order:

```ts
for await (const event of runner.runAsync({ userId, sessionId, newMessage })) {
  // ...
}
await plugin.pipeline.close(5_000); // exports what is left, then stops
await exporter.close(); // the pipeline leaves its exporter open
await store.close(); // a LeasedWorkflowCheckpointStore releases its leases
```

- `pipeline.close(timeoutMs)` flushes first. Records still buffered when the
  limit passes are dropped with reason `closed` and reported by a warning. Use
  `flush(timeoutMs)` instead when the pipeline stays in use.
- `exporter.close()` and `store.close()` release files, database handles and the
  JSONL directory lock. Later calls reject with `WORKFLOW_STORAGE_CLOSED`.
- A process that exits without these steps, for example on `process.exit()` or
  a signal, loses its buffered records as described in
  [What is lost on kill -9](#what-is-lost-on-kill--9).

## Errors

Storage providers and the registry throw `WorkflowStorageError`. Its `code` is one
of the 16 values of `WorkflowStorageErrorCode`. `isWorkflowStorageError` tests for
the class. Check `code`, not the message.

| Code | Meaning |
| --- | --- |
| `WORKFLOW_STORAGE_UNKNOWN_SCHEME` | No provider is registered for the URI scheme. |
| `WORKFLOW_STORAGE_INVALID_URI` | The URI cannot be parsed, or the provider rejects its path or query parameters. |
| `WORKFLOW_STORAGE_DRIVER_MISSING` | A runtime module or optional peer is not available. `details.driver` names it. |
| `WORKFLOW_STORAGE_SCHEME_ALREADY_REGISTERED` | A scheme was registered twice without `replace: true`. |
| `WORKFLOW_STORAGE_INVALID_OPTION` | A provider option is out of range. |
| `WORKFLOW_STORAGE_UNSUPPORTED` | The provider does not implement the operation; its capability flag is `false`. |
| `WORKFLOW_STORAGE_UNAVAILABLE` | A transient backend failure, such as a busy database. Retried by default. |
| `WORKFLOW_STORAGE_TIMEOUT` | An operation passed its time limit. The write may or may not have been applied. Retried by default. |
| `WORKFLOW_STORAGE_CORRUPT` | Stored data failed an integrity check. |
| `WORKFLOW_STORAGE_SCHEMA_UNSUPPORTED` | The stored data was written by a newer version of the provider. |
| `WORKFLOW_STORAGE_UNSAFE_PATH` | A storage path, the directory that holds a SQLite file, or a file-system checkpoint root is a symbolic link or not a regular file, or its mode could not be made owner-only. |
| `WORKFLOW_STORAGE_LEASE_HELD` | Another owner holds an unexpired lease. |
| `WORKFLOW_STORAGE_LEASE_LOST` | The caller's lease or fencing token is no longer current. The write was not applied. |
| `WORKFLOW_STORAGE_PAYLOAD_TOO_LARGE` | A record exceeds the provider limit after clipping. |
| `WORKFLOW_STORAGE_INVALID_RECORD` | A record is not JSON-safe or lacks a required field. |
| `WORKFLOW_STORAGE_CLOSED` | The provider was used after `close()`. |

A revision conflict on a checkpoint save is `WorkflowCheckpointConflictError`,
not a `WorkflowStorageError`. Reload and retry.

## Conformance suite

Any provider can be checked against the same cases the bundled providers pass.
The suite is in its own subpath, `adk-llm-bridge/workflows/storage/conformance`,
which has no runtime dependency.

- `workflowCheckpointStoreConformanceCases(options)` builds the checkpoint cases.
  `createStore` returns a new, empty provider for each case. `reopenStore`, when
  given, returns a second provider over the same storage; the durability and
  multi-writer cases are skipped without it.
- `workflowEventExporterConformanceCases(options)` builds the event cases, with
  `createExporter` and the optional `reopenExporter`.
- `defineWorkflowStorageConformanceTests(cases, runner)` registers the cases with
  a test runner. `runner` needs `test` and may use `skip`. A failing case throws
  `WorkflowStorageConformanceFailure`.

```ts
import { test } from "bun:test";
import {
  defineWorkflowStorageConformanceTests,
  workflowCheckpointStoreConformanceCases,
} from "adk-llm-bridge/workflows/storage/conformance";

const cases = await workflowCheckpointStoreConformanceCases({
  createStore: () => new MyCheckpointStore({ dsn: testDsn() }),
  reopenStore: () => new MyCheckpointStore({ dsn: testDsn() }),
});
defineWorkflowStorageConformanceTests(cases, { test });
```

`MyCheckpointStore` is your `BaseWorkflowCheckpointStore` subclass. Its
`capabilities` must match what it enforces.

## Runtimes and the SQLite one-host limit

- The package requires Node 22.0 or later (`engines`).
- The SQLite providers use the runtime's built-in `node:sqlite`, so they add no
  dependency. They need Node 22.13 or later, or Bun. On Node 22.5 to 22.12, run with
  `--experimental-sqlite`. On an older runtime, the first use throws
  `WORKFLOW_STORAGE_DRIVER_MISSING`.
- The SQLite providers are for **one host**. Several processes on that host can
  share one database file: each save and append is one `BEGIN IMMEDIATE`
  transaction. Two hosts must not share one SQLite file. For several hosts, use an
  ADK database session service or your own provider.
- The `file://` checkpoint provider has the same limit: `multiProcess` is true for
  one host and one local file system. Known limitation: concurrent saves from
  several processes on Windows are not yet supported
  ([#117](https://github.com/pailat/adk-llm-bridge/issues/117)).
- The JSONL event exporter takes one writer per directory. A second writer is
  refused with `WORKFLOW_STORAGE_UNAVAILABLE`. A process that only reads,
  checks health or lists never takes the directory lock, changes the
  directory's permissions or edits a file, so it never blocks a writer. The
  lock of a writer that died is taken over by one process at most, also when a
  process dies in the middle of that takeover.
- Opening a SQLite store whose schema is current takes no write lock, so it
  does not wait for another process's write. Opening a file that still needs a
  schema migration waits up to `busyTimeoutMs` for the write lock, blocking the
  event loop while it waits.
- The modules load on first use. The root, agents and workflows entries import
  without `node:sqlite` or the SQLite subpaths.

## Deprecation

Storage exports are `@experimental`, and each TSDoc block says so. The repository
has no written deprecation schedule for them yet. A removed or renamed export is
listed under **Breaking** in [CHANGELOG.md](../CHANGELOG.md). An export that is
still available but superseded is marked `@deprecated` in its TSDoc.

## Known limits

- **Not durable in process memory.** `memory://` and ADK's in-memory session
  service keep nothing after the process ends.
- **Advisory writes on ADK's in-memory service.** Its `compareAndSet` is
  `advisory`, so another writer can commit between the revision check and the
  write. `leases` and `multiProcess` are false.
- **ADK database route costs.** Each save appends one event that holds a full
  checkpoint, and the event stays until the session is deleted. `list` scans every
  session of the app on each page. Use a native provider where this matters.
- **Clipped payloads.** A record over `maxRecordBytes` loses text: its long
  strings are cut, and if that is not enough the payload is dropped. Only an
  overflow handler keeps the full payload.
- **Buffered records are lost on a kill.** See [What is lost on kill -9](#what-is-lost-on-kill--9).
- **`file://` list cost.** `list` of `FileSystemWorkflowCheckpointProvider`
  opens, reads and parses every checkpoint file under the root for each page,
  whatever the filters and the cursor, so a page costs time in proportion to
  all stored checkpoints. Prune old executions, or use the SQLite provider,
  when the root holds many.
- **SQLite lease rows.** `SqliteWorkflowCheckpointStore` keeps one row in its
  `leases` table for each execution that has been leased, so that fencing
  tokens only grow. `delete` and `prune` remove the row of each execution they
  delete. `prune` also removes up to `limit` rows of leases that nobody holds
  (released or expired) whose execution has no checkpoint, such as a run whose
  process died before its first save. Run `prune` regularly and the table stays
  about as large as the checkpoint table. A removed row cannot let an old token
  write again: the store keeps the largest removed token, and every new lease
  gets a larger one.
- **Single host for SQLite and the file-system providers.** See
  [the one-host limit](#runtimes-and-the-sqlite-one-host-limit).
