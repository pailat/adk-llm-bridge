# Persisting Claude sessions

> **Experimental.** This follows the Claude Agent SDK's `sessionStore`
> option, which the SDK marks `@alpha`: it can change in a minor SDK release.

A `ClaudeAgent` keeps one Claude session per ADK session and resumes it on the
next turn. The Claude Agent SDK writes each session's transcript to a JSONL
file under the Claude config directory (`~/.claude/projects/...`). With a
session store, the SDK also mirrors every transcript to durable storage, and a
resumed run loads it from there. That lets a session survive a lost disk or
continue in another process or on another machine.

## Use it

```ts
import { ClaudeAgent } from "adk-llm-bridge/agents";
import { SqliteSessionStore } from "adk-llm-bridge/agents/session-store/sqlite";

const sessionStore = new SqliteSessionStore({ path: "./data/claude-sessions.db" });

const agent = new ClaudeAgent({
  name: "coder",
  description: "Edits code",
  workingDirectory: process.cwd(),
  driverOptions: { sessionStore },
});
```

`driverOptions.sessionStore` (the `sessionStore` option of
`ClaudeAgentSdkDriver`) is passed to the SDK's `query()` on every run: on first
turns, and on resumed turns, where the SDK loads the transcript from the store
before Claude starts. Resume works as before: `resumeSessionId`, then
`runtimeSession.id`, then the id kept in ADK session state.

Things to know:

- **The local transcript is still written.** The store gets a second copy. To
  keep no lasting local copy, point `CLAUDE_CONFIG_DIR` at a temporary
  directory.
- **Same working directory to resume.** The SDK keys transcripts by a project
  key it derives from the working directory, so a resume finds the transcript
  only from the same path.
- **Failed writes.** The SDK tries a rejected batch 3 times in total (a timeout is not retried),
  then drops it.
  The run then reports an `error` event with code
  `CLAUDE_SESSION_STORE_MIRROR_ERROR` (recoverable) and goes on; the store is
  missing that batch. Because it is an error event, a delegated run that
  reports it counts as failed.
- **Retention is yours.** Nothing is deleted from the store unless you call
  `delete`. Transcripts can hold tool output and file contents.
- **Claude Agent SDK only.** `ClaudeCliDriver` cannot mirror transcripts: it
  throws `ExternalAgentPolicyError` with code
  `EXTERNAL_AGENT_OPTION_UNSUPPORTED` when built with a `sessionStore`,
  `sessionStoreFlush` or `sessionStoreLoadTimeoutMs`.

### Tuning

Two more driver options pass straight to the SDK. Both need a
`sessionStore`; the driver throws `InputValidationError` without one (the SDK
would ignore them) or for an invalid value.

| Option | SDK option | Meaning |
| --- | --- | --- |
| `sessionStoreFlush` | `sessionStoreFlush` | `"batched"` (SDK default) or `"eager"`: how soon transcript entries reach `append`. |
| `sessionStoreLoadTimeoutMs` | `loadTimeoutMs` | Positive integer, milliseconds each `load` / `listSubkeys` call may take on resume (SDK default 60 000); a slower store fails the run instead of hanging it. |

```ts
driverOptions: { sessionStore, sessionStoreFlush: "eager", sessionStoreLoadTimeoutMs: 10_000 }
```

### Importing existing sessions

To copy sessions that were written locally before you added a store, call the
SDK's `importSessionToStore` with the store. It reads the local transcript
under `CLAUDE_CONFIG_DIR` and appends it in batches; no model call is made.

```ts
import { importSessionToStore } from "@anthropic-ai/claude-agent-sdk";

await importSessionToStore(sessionId, sessionStore, { dir: projectDir });
```

`dir` is the working directory the session ran in (the store's `projectKey`
is derived from it). The bridge does not wrap this function: it is part of
the SDK's `@alpha` session store API, and a test pins that it works with
`SqliteSessionStore`.

## `SqliteSessionStore`

A ready adapter that keeps transcripts in a SQLite file, from
`adk-llm-bridge/agents/session-store/sqlite`. It uses the runtime's built-in
`node:sqlite` and adds no dependency.

| Runtime | Support |
| --- | --- |
| Node 22.13 and later | Yes (Node 22 prints an `ExperimentalWarning` for `node:sqlite`) |
| Node 22.5 to 22.12 | With `--experimental-sqlite` |
| Node 24, 25, 26 | Yes |
| Bun | Yes |

Elsewhere the constructor throws `SqliteSessionStoreError` with code
`SESSION_STORE_SQLITE_UNAVAILABLE`.

Behavior:

- One row per transcript line, in append order, keyed by project key, session
  id and subagent path. `load` returns the entries deep-equal to what was
  appended, or `null` for a transcript that was never written.
- A line's `uuid` is an idempotency key within its transcript: a retried or
  replayed line replaces the stored one in place and adds no row. Lines
  without a `uuid`, or with an empty one, are always added.
- `listSessions(projectKey)` lists the main transcripts with their last write
  time (epoch milliseconds); `listSubkeys` lists subagent transcripts so a
  resume restores them; `delete` of a main transcript also deletes its
  subagent transcripts.
- The database file is created with mode `0600` (set explicitly, so the
  umask cannot change it) and a missing directory with `0700`; SQLite gives
  the `-wal` and `-shm` files the same mode. An existing file or directory
  keeps its mode.
- The path is checked before SQLite opens it (POSIX): a symlink at the path
  is refused, not followed; the file must be a regular file owned by you; its
  directory (symlinks followed) must be owned by you or root and must not be
  writable by others unless it has the sticky bit, like `/tmp`. A failed
  check throws `SESSION_STORE_UNSAFE_PATH` and nothing is written.
- WAL mode, a busy timeout (`busyTimeoutMs`, an integer from 0 to
  2147483647, default 5000) and one transaction per `append`, so several
  processes can share one file. A failed `append` stores nothing and
  rethrows its original error.
- `close()` closes the database. A file that is not a SQLite database, and
  any use after `close()`, throw the plain `node:sqlite` error.

| Code | When |
| --- | --- |
| `SESSION_STORE_SQLITE_UNAVAILABLE` | The runtime has no `node:sqlite`. |
| `SESSION_STORE_INVALID_KEY` | An empty `projectKey` or `sessionId`, or an empty-string `subpath`. |
| `SESSION_STORE_INVALID_ENTRY` | An entry that is not a JSON object, that JSON cannot represent (a `bigint`, a cycle; `cause` holds the error), or whose `toJSON()` gives something other than a JSON object; nothing of the batch is stored. |
| `SESSION_STORE_INVALID_OPTION` | A `busyTimeoutMs` that is not an integer from 0 to 2147483647; checked before any file is created. |
| `SESSION_STORE_SCHEMA_UNSUPPORTED` | The file was written by a newer version of the store. |
| `SESSION_STORE_UNSAFE_PATH` | A symlink at the database path, a file that is not a regular file or is owned by another user, or a directory owned by another user (not root) or writable by others without the sticky bit. |

## ADK artifacts

A store that needs no database: the transcripts live in the ADK artifact
service of the run (`InMemoryArtifactService`, `FileArtifactService`,
`GcsArtifactService`, or any `BaseArtifactService`), scoped to the ADK
session. It comes from `adk-llm-bridge/agents/session-store/adk-artifacts`.

```ts
import { ClaudeAgent } from "adk-llm-bridge/agents";
import { adkArtifactSessionStore } from "adk-llm-bridge/agents/session-store/adk-artifacts";

const agent = new ClaudeAgent({
  name: "coder",
  description: "Edits code",
  workingDirectory: process.cwd(),
  driverOptions: { sessionStore: adkArtifactSessionStore() },
});
// new Runner({ appName, agent, sessionService, artifactService })
```

`adkArtifactSessionStore()` returns a factory (`SessionStoreFactory`, exported
from `adk-llm-bridge/agents`). `ClaudeAgentSdkDriver` calls it once per run
with the invocation context and gives the store it returns to the SDK. A plain
store object still works as before.

- **The artifact service.** The store uses `context.artifactService`, which the
  `Runner` sets. Pass `adkArtifactSessionStore({ artifactService })` to use
  another service; it is scoped by `context.session` (app, user, session id).
- **No artifact service is an error before the run starts.** The run yields an
  `error` event with code `CLAUDE_SESSION_STORE_UNAVAILABLE` (not recoverable;
  the message is the factory's) and `completed` with exit code 1. The SDK is
  not started and no model call is made. The store's own error code is
  `SESSION_STORE_NO_ARTIFACT_SERVICE`. Any throw from a factory is reported the
  same way.
- **Layout.** One artifact per transcript, named
  `claude-session.v1.<project>.<session>.<main or subagent>.jsonl` (hashed or
  encoded, never containing `/`), with one version per `append` batch. A batch
  over `maxVersionBytes` (default 4 MiB, an integer of at least 1) is split into
  consecutive versions. `load` reads every version, up to 8 in parallel, and
  has to fit `sessionStoreLoadTimeoutMs`.
- **Cost of eager flushing.** Every `append` is one `saveArtifact`, and the
  GCS and file services list all versions on each save. Keep the default
  `"batched"` flush; `sessionStoreFlush: "eager"` makes more and smaller versions and slows
  long sessions down.
- **One writer.** Two processes (or two runs) writing the same ADK session's transcript at
  the same time are not supported; appends of one run are serialized per
  artifact.
- **Another ADK session's transcript.** A `resumeSessionId` that belongs to a
  different ADK session finds nothing in this session's artifacts. When `load`
  gives nothing, the SDK does not fail: it starts the resume from the local
  transcript under `CLAUDE_CONFIG_DIR` if there is one.
- **Corrupt data.** A version that is not JSONL or has another `format` makes
  `load` reject with `SESSION_STORE_CORRUPT_VERSION`; nothing is skipped.
  Other codes: `SESSION_STORE_INVALID_KEY`, `SESSION_STORE_INVALID_ENTRY`,
  `SESSION_STORE_INVALID_OPTION`. All are `AdkArtifactSessionStoreError`.
- **Retention is yours.** The built-in ADK session services do not delete an
  ended session's artifacts, and only `delete` removes a transcript. Transcripts can hold tool
  output and file contents, and the artifact service stores them.
- **Claude Agent SDK only.** `ClaudeCliDriver` still throws
  `EXTERNAL_AGENT_OPTION_UNSUPPORTED` for any `sessionStore`, a factory too.

## Your own store

Any object that implements `SessionStore` works: `append` and `load` are
required; `listSessions`, `listSubkeys` and `delete` are optional. The
`SessionStore`, `SessionKey` and `SessionStoreEntry` types are exported from
`adk-llm-bridge/agents` (they match the SDK's types, so no SDK import is
needed), and the SDK's own `InMemorySessionStore` is accepted too.
