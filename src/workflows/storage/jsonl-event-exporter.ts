import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  type FileHandle,
  lstat,
  lutimes,
  mkdir,
  open,
  readdir,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isWorkflowStorageError, WorkflowStorageError } from "./errors.js";
import {
  type AppendWorkflowEventRecordsResult,
  BaseWorkflowEventExporter,
  type BaseWorkflowEventExporterOptions,
  DEFAULT_WORKFLOW_EVENT_RECORD_MAX_BYTES,
  decodeWorkflowEventListCursor,
  encodeWorkflowEventListCursor,
  type ListWorkflowEventExecutionsInput,
  type ListWorkflowEventExecutionsResult,
  type PruneWorkflowEventRecordsInput,
  type PruneWorkflowEventRecordsResult,
  type ReadWorkflowEventRecordsInput,
  type ReadWorkflowEventRecordsResult,
  type WorkflowEventExecutionSummary,
  type WorkflowEventExporterCapabilities,
  type WorkflowEventRecord,
  type WorkflowEventRecordInput,
} from "./event-exporter.js";

/** Format marker in the header line of every JSONL event file. */
export const WORKFLOW_EVENT_JSONL_FORMAT =
  "adk-llm-bridge/workflow-events-jsonl";
/** Format version {@link JsonlWorkflowEventExporter} writes. */
export const WORKFLOW_EVENT_JSONL_FORMAT_VERSION = 1;

/**
 * Options of {@link JsonlWorkflowEventExporter}.
 *
 * @experimental
 */
export interface JsonlWorkflowEventExporterOptions
  extends BaseWorkflowEventExporterOptions {
  /**
   * Absolute host-controlled directory. Created with mode `0700` when
   * missing; each execution gets one file created with mode `0600`.
   */
  directory: string;
  /**
   * When appended lines are synced to disk. `batch` syncs once per `append`
   * call, before it resolves; `none` leaves it to the operating system, so a
   * power loss can lose the newest lines (a killed process cannot).
   *
   * @defaultValue `"batch"`
   */
  sync?: "batch" | "none";
}

/**
 * Event exporter that appends records to one JSON Lines file per execution.
 * URI: `file:///absolute/directory`.
 *
 * @remarks
 * The file name is the SHA-256 of the execution id plus `.jsonl`. The first
 * line is a header with the format, its version and the execution id; every
 * other line is one record with its sequence. Files and the directory are
 * never followed when they are symbolic links.
 *
 * One process writes a directory at a time: `multiProcess` is `false`, and a
 * second writer is refused through an exclusive lock file with
 * `WORKFLOW_STORAGE_UNAVAILABLE`. The writer refreshes the lock every 10
 * seconds and checks it before each write; a lock whose process is gone, or
 * that was not refreshed for 60 seconds (its pid may have been reused), is
 * taken over by one process only. A directory that others can read or write
 * is set to `0700` before use. When an execution is first used, its file
 * is read once to recover the last sequence and the stored ids. A last line
 * cut short by a killed process is removed then; any other malformed line
 * rejects with `WORKFLOW_STORAGE_CORRUPT`. A file with a newer format
 * version rejects with `WORKFLOW_STORAGE_SCHEMA_UNSUPPORTED`.
 *
 * @experimental
 */
export class JsonlWorkflowEventExporter extends BaseWorkflowEventExporter {
  /** Provider name: `jsonl`. */
  readonly providerName = "jsonl";
  /** Durable, one writer process, listing and pruning. */
  readonly capabilities: WorkflowEventExporterCapabilities;

  readonly #directory: string;
  readonly #sync: "batch" | "none";
  readonly #states = new Map<string, ExecutionState>();
  readonly #readStates = new Map<
    string,
    { key: string; state: ExecutionState }
  >();
  readonly #unsynced = new Set<string>();
  #ready: Promise<void> | undefined;
  #lockToken: string | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  /**
   * Creates the exporter over a directory. No file is touched until the
   * first call.
   *
   * @param options - Directory, sync rule and the shared exporter options.
   * @throws `WorkflowStorageError` with code `WORKFLOW_STORAGE_INVALID_OPTION`
   * when `directory` is not absolute.
   */
  constructor(options: JsonlWorkflowEventExporterOptions) {
    super(options);
    if (
      typeof options.directory !== "string" ||
      !isAbsolute(options.directory)
    ) {
      throw new WorkflowStorageError(
        "WORKFLOW_STORAGE_INVALID_OPTION",
        "directory must be an absolute path",
        { details: { option: "directory" } },
      );
    }
    if (
      options.sync !== undefined &&
      options.sync !== "batch" &&
      options.sync !== "none"
    ) {
      throw new WorkflowStorageError(
        "WORKFLOW_STORAGE_INVALID_OPTION",
        'sync must be "batch" or "none"',
        { details: { option: "sync" } },
      );
    }
    this.#directory = options.directory;
    this.#sync = options.sync ?? "batch";
    this.capabilities = Object.freeze({
      durable: true,
      multiProcess: false,
      listing: true,
      pruning: true,
      maxRecordBytes:
        options.maxRecordBytes ?? DEFAULT_WORKFLOW_EVENT_RECORD_MAX_BYTES,
    });
  }

  protected override appendRecords(
    executionId: string,
    records: readonly WorkflowEventRecordInput[],
  ): Promise<AppendWorkflowEventRecordsResult> {
    return this.#exclusive(async () => {
      await this.#ensureReady();
      await this.#confirmLock();
      const state = await this.#load(executionId);
      const result: Array<{
        id: string;
        sequence: number;
        duplicate: boolean;
      }> = [];
      const chunks: Buffer[] = [];
      const added: Array<{ id: string; sequence: number; offset: number }> = [];
      let sequence = state.lastSequence;
      let size = state.size;
      let firstTimestamp = state.firstTimestamp;
      let lastTimestamp = state.lastTimestamp;
      if (!state.hasHeader) {
        const header = Buffer.from(`${headerLine(executionId)}\n`, "utf8");
        chunks.push(header);
        size += header.length;
      }
      const headerEnd = size;
      for (const record of records) {
        const known = state.ids.get(record.id);
        if (known !== undefined) {
          result.push({ id: record.id, sequence: known, duplicate: true });
          continue;
        }
        sequence += 1;
        const line = Buffer.from(
          `${JSON.stringify({ ...record, sequence })}\n`,
          "utf8",
        );
        chunks.push(line);
        added.push({ id: record.id, sequence, offset: size });
        size += line.length;
        firstTimestamp ??= record.timestamp;
        lastTimestamp = record.timestamp;
        result.push({ id: record.id, sequence, duplicate: false });
      }
      if (added.length === 0) {
        return { records: result, lastSequence: state.lastSequence };
      }
      const created = !state.fileExists;
      let handle: FileHandle | undefined;
      try {
        handle = await open(
          state.path,
          created
            ? constants.O_WRONLY |
                constants.O_CREAT |
                constants.O_EXCL |
                NO_FOLLOW
            : constants.O_WRONLY | constants.O_APPEND | NO_FOLLOW,
          0o600,
        );
        if (created) await handle.chmod(0o600);
        await writeFully(handle, Buffer.concat(chunks));
        if (this.#sync === "batch") await handle.sync();
      } catch (error) {
        // Put the file back as it was, so a failed batch leaves no partial
        // lines; when even that fails, the next use scans the file again.
        if (handle) await handle.truncate(state.size).catch(() => undefined);
        this.#states.delete(executionId);
        throw error;
      } finally {
        await handle?.close().catch(() => undefined);
      }
      if (this.#sync === "none") this.#unsynced.add(state.path);
      if (created) await syncDirectory(this.#directory);
      for (const entry of added) {
        state.ids.set(entry.id, entry.sequence);
        if ((entry.sequence - 1) % MARK_INTERVAL === 0) {
          state.marks[(entry.sequence - 1) / MARK_INTERVAL] = entry.offset;
        }
      }
      if (state.marks.length === 0) state.marks[0] = headerEnd;
      state.hasHeader = true;
      state.fileExists = true;
      state.size = size;
      state.lastSequence = sequence;
      state.firstTimestamp = firstTimestamp;
      state.lastTimestamp = lastTimestamp;
      return { records: result, lastSequence: sequence };
    });
  }

  protected override readRecords(
    input: ReadWorkflowEventRecordsInput & {
      afterSequence: number;
      limit: number;
    },
  ): Promise<ReadWorkflowEventRecordsResult> {
    return this.#exclusive(async () => {
      const state = await this.#stateForRead(input.executionId);
      const empty = {
        records: [],
        nextAfterSequence: input.afterSequence,
        hasMore: false,
      };
      if (state.lastSequence <= input.afterSequence) return empty;
      const mark = Math.floor(input.afterSequence / MARK_INTERVAL);
      const offset = state.marks[mark];
      if (offset === undefined) throw corrupt("the offset index is incomplete");
      const handle = await open(state.path, constants.O_RDONLY | NO_FOLLOW);
      try {
        const reader = new LineReader(handle, offset, state.size);
        const page: WorkflowEventRecord[] = [];
        let hasMore = false;
        let sequence = mark * MARK_INTERVAL;
        for (;;) {
          const item = await reader.next();
          if (!item) break;
          sequence += 1;
          if (sequence <= input.afterSequence) continue;
          const record = parseRecord(item.line, sequence, input.executionId);
          if (input.kinds && !input.kinds.includes(record.kind)) continue;
          if (input.types && !input.types.includes(record.type)) continue;
          if (page.length === input.limit) {
            hasMore = true;
            break;
          }
          page.push(record);
        }
        const last = page[page.length - 1];
        return {
          records: page,
          nextAfterSequence: last ? last.sequence : input.afterSequence,
          hasMore,
        };
      } finally {
        await handle.close().catch(() => undefined);
      }
    });
  }

  protected override listExportedExecutions(
    input: ListWorkflowEventExecutionsInput & { limit: number },
  ): Promise<ListWorkflowEventExecutionsResult> {
    return this.#exclusive(async () => {
      if (!(await this.#directoryExists())) return { items: [] };
      const after =
        input.cursor === undefined
          ? undefined
          : decodeWorkflowEventListCursor(input.cursor);
      const files = (await this.#eventFiles()).filter(
        (file) => after === undefined || file.executionId > after,
      );
      const page = files.slice(0, input.limit);
      const items: WorkflowEventExecutionSummary[] = [];
      for (const file of page) {
        const summary = await summarize(file.path, file.executionId);
        if (summary) items.push({ executionId: file.executionId, ...summary });
      }
      const last = page[page.length - 1];
      return files.length > page.length && last
        ? {
            items,
            nextCursor: encodeWorkflowEventListCursor(last.executionId),
          }
        : { items };
    });
  }

  protected override pruneRecords(
    input: PruneWorkflowEventRecordsInput,
  ): Promise<PruneWorkflowEventRecordsResult> {
    return this.#exclusive(async () => {
      await this.#ensureReady();
      await this.#confirmLock();
      let targets: Array<{ executionId: string; path: string }>;
      let hasMore = false;
      if ("executionId" in input) {
        const path = this.#fileFor(input.executionId);
        const info = await lstat(path).catch((error: unknown) => {
          if (errorCode(error) === "ENOENT") return undefined;
          throw error;
        });
        if (info && !info.isFile()) throw unsafePath(path);
        targets = info ? [{ executionId: input.executionId, path }] : [];
      } else {
        const limit = input.limit ?? DEFAULT_PRUNE_LIMIT;
        const old: typeof targets = [];
        for (const file of await this.#eventFiles()) {
          const summary = await summarize(file.path, file.executionId);
          if (!summary || summary.lastTimestamp < input.lastRecordBefore) {
            old.push(file);
          }
        }
        targets = old.slice(0, limit);
        hasMore = old.length > targets.length;
      }
      let records = 0;
      for (const target of targets) {
        // A file that cannot be summarized is still removed; its records are
        // then not counted.
        const summary = await summarize(target.path, target.executionId).catch(
          () => undefined,
        );
        records += summary?.lastSequence ?? 0;
        await unlink(target.path);
        this.#states.delete(target.executionId);
        this.#unsynced.delete(target.path);
      }
      if (targets.length > 0) await syncDirectory(this.#directory);
      return { executions: targets.length, records, hasMore };
    });
  }

  protected override checkHealth(): Promise<number | undefined> {
    return this.#exclusive(async () => {
      // A process that does not write must not take the writer lock to probe.
      if (this.#lockToken === undefined) {
        if (await this.#directoryExists()) {
          await access(this.#directory, constants.R_OK | constants.W_OK);
        }
        return WORKFLOW_EVENT_JSONL_FORMAT_VERSION;
      }
      await access(this.#directory, constants.R_OK | constants.W_OK);
      return WORKFLOW_EVENT_JSONL_FORMAT_VERSION;
    });
  }

  protected override flushExporter(): Promise<void> {
    return this.#exclusive(async () => {
      for (const path of [...this.#unsynced]) {
        let handle: FileHandle | undefined;
        try {
          handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
          await handle.sync();
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        } finally {
          await handle?.close().catch(() => undefined);
        }
        this.#unsynced.delete(path);
      }
    });
  }

  protected override async closeExporter(): Promise<void> {
    // Operations already queued finish before the lock is released.
    await this.#queue.catch(() => undefined);
    this.#states.clear();
    this.#readStates.clear();
    const token = this.#lockToken;
    this.#lockToken = undefined;
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    if (token !== undefined) HELD_LOCK_TOKENS.delete(token);
    this.#ready = undefined;
    if (token === undefined) return;
    const lockPath = join(this.#directory, LOCK_NAME);
    const holder = await readLockHolder(lockPath);
    if (holder?.token === token) await unlink(lockPath).catch(() => undefined);
  }

  /** Runs one operation at a time and maps file system errors. */
  #exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run, run).catch((error: unknown) => {
      throw isWorkflowStorageError(error) ? error : fileFailure(error);
    });
    this.#queue = next.catch(() => undefined);
    return next;
  }

  #fileFor(executionId: string): string {
    const name = createHash("sha256").update(executionId).digest("hex");
    return join(this.#directory, `${name}.jsonl`);
  }

  #ensureReady(): Promise<void> {
    if (!this.#ready) {
      this.#ready = this.#prepare().catch((error: unknown) => {
        this.#ready = undefined;
        throw error;
      });
    }
    return this.#ready;
  }

  async #prepare(): Promise<void> {
    const check = async (): Promise<boolean> => {
      const info = await lstat(this.#directory).catch((error: unknown) => {
        if (errorCode(error) === "ENOENT") return undefined;
        throw error;
      });
      if (!info) return false;
      if (!info.isDirectory()) throw unsafePath(this.#directory);
      // A directory others can read or write is made owner-only before any
      // event is written into it; one that cannot be changed is refused.
      if ((info.mode & 0o077) !== 0) {
        await chmod(this.#directory, 0o700).catch(() => {
          throw unsafePath(this.#directory);
        });
      }
      return true;
    };
    if (!(await check())) {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      if (!(await check())) throw unsafePath(this.#directory);
    }
    await this.#acquireLock();
  }

  async #acquireLock(): Promise<void> {
    const lockPath = join(this.#directory, LOCK_NAME);
    const takeoverPath = join(this.#directory, TAKEOVER_NAME);
    const token = randomBytes(8).toString("hex");
    const body = JSON.stringify({ pid: process.pid, token });
    const deadline = Date.now() + TAKEOVER_WAIT_MS;
    while (Date.now() < deadline) {
      if (await createExclusive(lockPath, body)) {
        this.#holdLock(token);
        return;
      }
      const holder = await readLockHolder(lockPath);
      if (!holder) continue;
      if (holderIsAlive(holder)) throw writerBusy(holder.pid);
      // The holder is gone. Removing its lock is serialized by a second,
      // short-lived lock: without it, a process that judged the old lock
      // stale could remove the lock another process has just created, and
      // both would write.
      if (!(await createExclusive(takeoverPath, body))) {
        const other = await readLockHolder(takeoverPath);
        if (
          other !== undefined &&
          other.ageMs > TAKEOVER_STALE_MS &&
          !holderIsAlive(other)
        ) {
          // A process died in the middle of a takeover.
          await unlink(takeoverPath).catch(() => undefined);
        } else {
          await delay(TAKEOVER_POLL_MS);
        }
        continue;
      }
      try {
        const current = await readLockHolder(lockPath);
        if (
          current !== undefined &&
          current.token === holder.token &&
          current.pid === holder.pid &&
          !holderIsAlive(current)
        ) {
          await unlink(lockPath).catch((error: unknown) => {
            if (errorCode(error) !== "ENOENT") throw error;
          });
        }
        if (await createExclusive(lockPath, body)) {
          this.#holdLock(token);
          return;
        }
      } finally {
        await unlink(takeoverPath).catch(() => undefined);
      }
    }
    throw new WorkflowStorageError(
      "WORKFLOW_STORAGE_UNAVAILABLE",
      "The event directory lock could not be taken",
      { details: { provider: "jsonl" } },
    );
  }

  #holdLock(token: string): void {
    this.#lockToken = token;
    HELD_LOCK_TOKENS.add(token);
    // The lock's modification time is its heartbeat: a lock not refreshed for
    // STALE_LOCK_MS is stale even when its pid now belongs to another process.
    this.#heartbeat = setInterval(() => {
      void this.#confirmLock().catch(() => undefined);
    }, LOCK_REFRESH_MS);
    this.#heartbeat.unref?.();
  }

  /**
   * Refreshes the lock and checks it is still this exporter's. A writer that
   * was paused past the stale limit finds its lock taken over and stops
   * writing.
   */
  async #confirmLock(): Promise<void> {
    const token = this.#lockToken;
    if (token === undefined) return;
    const lockPath = join(this.#directory, LOCK_NAME);
    const holder = await readLockHolder(lockPath);
    if (holder?.token === token && holder.pid === process.pid) {
      const now = new Date();
      await lutimes(lockPath, now, now).catch(() => undefined);
      return;
    }
    if (this.#lockToken !== token) return;
    this.#lockToken = undefined;
    HELD_LOCK_TOKENS.delete(token);
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    this.#ready = undefined;
    this.#states.clear();
    throw writerBusy(holder?.pid);
  }

  async #load(executionId: string): Promise<ExecutionState> {
    const cached = this.#states.get(executionId);
    if (cached) {
      this.#states.delete(executionId);
      this.#states.set(executionId, cached);
      return cached;
    }
    const state = await recover(executionId, this.#fileFor(executionId), true);
    this.#states.set(executionId, state);
    while (this.#states.size > MAX_CACHED_EXECUTIONS) {
      const oldest = this.#states.keys().next().value;
      if (oldest === undefined) break;
      this.#states.delete(oldest);
    }
    return state;
  }

  /**
   * State for a read. An exporter that holds the directory lock uses its
   * cached state. Otherwise the file is scanned without changing it, and a
   * torn last line is removed only when the lock can be taken.
   */
  async #stateForRead(executionId: string): Promise<ExecutionState> {
    if (this.#lockToken !== undefined) return this.#load(executionId);
    const path = this.#fileFor(executionId);
    if (!(await this.#directoryExists())) return emptyState(path, false);
    const info = await lstat(path).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    });
    if (!info) return emptyState(path, false);
    const key = `${info.size}:${info.mtimeMs}`;
    const known = this.#readStates.get(executionId);
    if (known?.key === key) return known.state;
    const state = await recover(executionId, path, false);
    if (state.torn) {
      try {
        await this.#ensureReady();
        return await this.#load(executionId);
      } catch (error) {
        if (!isWorkflowStorageError(error, "WORKFLOW_STORAGE_UNAVAILABLE")) {
          throw error;
        }
        // Another process writes: read the valid part and leave the tail.
      }
    }
    if (this.#readStates.size >= MAX_CACHED_EXECUTIONS)
      this.#readStates.clear();
    this.#readStates.set(executionId, { key, state });
    return state;
  }

  async #directoryExists(): Promise<boolean> {
    const info = await lstat(this.#directory).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    });
    if (!info) return false;
    if (!info.isDirectory()) throw unsafePath(this.#directory);
    return true;
  }

  /** Execution files with a valid header, ordered by execution id. */
  async #eventFiles(): Promise<Array<{ executionId: string; path: string }>> {
    const files: Array<{ executionId: string; path: string }> = [];
    for (const name of await readdir(this.#directory)) {
      if (!FILE_NAME.test(name)) continue;
      const path = join(this.#directory, name);
      const info = await lstat(path).catch(() => undefined);
      if (!info?.isFile()) continue;
      const executionId = await readHeaderExecutionId(path);
      if (
        executionId !== undefined &&
        `${createHash("sha256").update(executionId).digest("hex")}.jsonl` ===
          name
      ) {
        files.push({ executionId, path });
      }
    }
    return files.sort((a, b) =>
      a.executionId < b.executionId
        ? -1
        : a.executionId > b.executionId
          ? 1
          : 0,
    );
  }
}

/** Tokens of the writer locks this process holds right now. */
const HELD_LOCK_TOKENS = new Set<string>();
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const LOCK_NAME = ".writer.lock";
const FILE_NAME = /^[0-9a-f]{64}\.jsonl$/;
const MARK_INTERVAL = 128;
const MAX_CACHED_EXECUTIONS = 64;
const DEFAULT_PRUNE_LIMIT = 500;
const READ_CHUNK_BYTES = 64 * 1024;
const FRESH_LOCK_MS = 5_000;
const TAKEOVER_NAME = ".writer.lock.takeover";
const TAKEOVER_WAIT_MS = 5_000;
const TAKEOVER_POLL_MS = 20;
const TAKEOVER_STALE_MS = 5_000;
const LOCK_REFRESH_MS = 10_000;
const STALE_LOCK_MS = 60_000;
const KINDS = new Set(["workflow", "step", "agent_run", "span", "warning"]);

interface ExecutionState {
  path: string;
  /** The file exists on disk. */
  fileExists: boolean;
  /** The file holds a complete header line. */
  hasHeader: boolean;
  /** The file ends in bytes that are not a complete line. */
  torn: boolean;
  /** Byte length of the valid part of the file. */
  size: number;
  lastSequence: number;
  firstTimestamp: number | undefined;
  lastTimestamp: number | undefined;
  /** Id of every stored record with its sequence. */
  ids: Map<string, number>;
  /** Byte offset of every {@link MARK_INTERVAL}th record, from the first. */
  marks: number[];
}

function emptyState(path: string, fileExists: boolean): ExecutionState {
  return {
    path,
    fileExists,
    hasHeader: false,
    torn: false,
    size: 0,
    lastSequence: 0,
    firstTimestamp: undefined,
    lastTimestamp: undefined,
    ids: new Map(),
    marks: [],
  };
}

function headerLine(executionId: string): string {
  return JSON.stringify({
    format: WORKFLOW_EVENT_JSONL_FORMAT,
    formatVersion: WORKFLOW_EVENT_JSONL_FORMAT_VERSION,
    executionId,
  });
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function unsafePath(path: string): WorkflowStorageError {
  return new WorkflowStorageError(
    "WORKFLOW_STORAGE_UNSAFE_PATH",
    "An event storage path is a symbolic link or not a regular file or directory",
    { details: { provider: "jsonl", path } },
  );
}

function corrupt(message: string): WorkflowStorageError {
  return new WorkflowStorageError(
    "WORKFLOW_STORAGE_CORRUPT",
    `The jsonl event file is corrupt: ${message}`,
    { details: { provider: "jsonl" } },
  );
}

function fileFailure(error: unknown): WorkflowStorageError {
  const code = errorCode(error);
  if (code === "ELOOP" || code === "ENOTDIR" || code === "EISDIR") {
    return new WorkflowStorageError(
      "WORKFLOW_STORAGE_UNSAFE_PATH",
      "An event storage path is a symbolic link or not a regular file or directory",
      { cause: error, details: { provider: "jsonl" } },
    );
  }
  return new WorkflowStorageError(
    "WORKFLOW_STORAGE_UNAVAILABLE",
    `The jsonl event exporter could not use its directory${code ? ` (${code})` : ""}`,
    { cause: error, details: { provider: "jsonl" } },
  );
}

async function writeFully(handle: FileHandle, buffer: Buffer): Promise<void> {
  let written = 0;
  while (written < buffer.length) {
    const { bytesWritten } = await handle.write(
      buffer,
      written,
      buffer.length - written,
    );
    written += bytesWritten;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch {
    // Not every platform can sync a directory; the file itself is synced.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Reads the lines of a byte range of a file, one complete line at a time. */
class LineReader {
  #buffer: Buffer = Buffer.alloc(0);
  #position: number;
  #lineStart: number;
  readonly #handle: FileHandle;
  readonly #end: number;

  constructor(handle: FileHandle, start: number, end: number) {
    this.#handle = handle;
    this.#position = start;
    this.#lineStart = start;
    this.#end = end;
  }

  /** Byte offset just after the last complete line returned. */
  get offset(): number {
    return this.#lineStart;
  }

  async next(): Promise<{ line: Buffer; start: number } | undefined> {
    for (;;) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline >= 0) {
        const line = this.#buffer.subarray(0, newline);
        const start = this.#lineStart;
        this.#buffer = this.#buffer.subarray(newline + 1);
        this.#lineStart += newline + 1;
        return { line, start };
      }
      if (this.#position >= this.#end) return undefined;
      const chunk = Buffer.allocUnsafe(
        Math.min(READ_CHUNK_BYTES, this.#end - this.#position),
      );
      const { bytesRead } = await this.#handle.read(
        chunk,
        0,
        chunk.length,
        this.#position,
      );
      if (bytesRead === 0) return undefined;
      this.#position += bytesRead;
      this.#buffer = Buffer.concat([
        this.#buffer,
        chunk.subarray(0, bytesRead),
      ]);
    }
  }
}

function parseHeader(line: Buffer, executionId: string): void {
  let header: unknown;
  try {
    header = JSON.parse(line.toString("utf8"));
  } catch {
    throw corrupt("the header line is not JSON");
  }
  if (
    typeof header !== "object" ||
    header === null ||
    (header as { format?: unknown }).format !== WORKFLOW_EVENT_JSONL_FORMAT
  ) {
    throw corrupt("the header names another format");
  }
  const { formatVersion, executionId: named } = header as {
    formatVersion?: unknown;
    executionId?: unknown;
  };
  if (typeof formatVersion !== "number" || !Number.isInteger(formatVersion)) {
    throw corrupt("the header has no format version");
  }
  if (formatVersion > WORKFLOW_EVENT_JSONL_FORMAT_VERSION) {
    throw new WorkflowStorageError(
      "WORKFLOW_STORAGE_SCHEMA_UNSUPPORTED",
      `The jsonl event file has format version ${formatVersion}; this build reads up to ${WORKFLOW_EVENT_JSONL_FORMAT_VERSION}`,
      { details: { provider: "jsonl", formatVersion } },
    );
  }
  if (named !== executionId) {
    throw corrupt("the header names another execution");
  }
}

function parseRecord(
  line: Buffer,
  sequence: number,
  executionId: string,
): WorkflowEventRecord {
  let value: unknown;
  try {
    value = JSON.parse(line.toString("utf8"));
  } catch {
    throw corrupt(`line of sequence ${sequence} is not JSON`);
  }
  const record = value as Partial<WorkflowEventRecord> | null;
  if (
    typeof record !== "object" ||
    record === null ||
    Array.isArray(record) ||
    record.sequence !== sequence ||
    record.executionId !== executionId ||
    typeof record.id !== "string" ||
    !KINDS.has(record.kind as string) ||
    typeof record.type !== "string" ||
    typeof record.timestamp !== "number" ||
    typeof record.payload !== "object" ||
    record.payload === null
  ) {
    throw corrupt(`the record of sequence ${sequence} is not valid`);
  }
  return record as WorkflowEventRecord;
}

/**
 * Reads a whole execution file once: checks every line, removes a torn last
 * line and returns what the exporter needs to append and read.
 */
async function recover(
  executionId: string,
  path: string,
  repair: boolean,
): Promise<ExecutionState> {
  const info = await lstat(path).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return emptyState(path, false);
  if (!info.isFile()) throw unsafePath(path);
  const handle = await open(
    path,
    (repair ? constants.O_RDWR : constants.O_RDONLY) | NO_FOLLOW,
  );
  try {
    const { size } = await handle.stat();
    const state = emptyState(path, true);
    const reader = new LineReader(handle, 0, size);
    const header = await reader.next();
    if (!header) {
      // Only part of the header was written: the file holds no record yet.
      if (size > 0) {
        state.torn = true;
        if (repair) {
          await handle.truncate(0);
          await handle.sync();
        }
      }
      return state;
    }
    parseHeader(header.line, executionId);
    state.hasHeader = true;
    state.marks[0] = reader.offset;
    for (;;) {
      const item = await reader.next();
      if (!item) break;
      const sequence = state.lastSequence + 1;
      const record = parseRecord(item.line, sequence, executionId);
      if (state.ids.has(record.id)) {
        throw corrupt(`the record id of sequence ${sequence} repeats`);
      }
      state.ids.set(record.id, sequence);
      if ((sequence - 1) % MARK_INTERVAL === 0) {
        state.marks[(sequence - 1) / MARK_INTERVAL] = item.start;
      }
      state.lastSequence = sequence;
      state.firstTimestamp ??= record.timestamp;
      state.lastTimestamp = record.timestamp;
    }
    if (reader.offset < size) {
      // A line without its newline is the write a killed process left.
      state.torn = true;
      if (repair) {
        await handle.truncate(reader.offset);
        await handle.sync();
      }
    }
    state.size = reader.offset;
    return state;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readHeaderExecutionId(
  path: string,
): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline < 0) return undefined;
    const header = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
    if (
      header?.format !== WORKFLOW_EVENT_JSONL_FORMAT ||
      typeof header.formatVersion !== "number" ||
      header.formatVersion > WORKFLOW_EVENT_JSONL_FORMAT_VERSION ||
      typeof header.executionId !== "string"
    ) {
      return undefined;
    }
    return header.executionId;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** The last complete line of a file: the bytes before its final newline. */
async function lastCompleteLine(
  handle: FileHandle,
  size: number,
): Promise<Buffer | undefined> {
  let position = size;
  let window: Buffer = Buffer.alloc(0);
  while (position > 0) {
    const start = Math.max(0, position - READ_CHUNK_BYTES);
    const chunk = Buffer.allocUnsafe(position - start);
    await handle.read(chunk, 0, chunk.length, start);
    window = Buffer.concat([chunk, window]);
    position = start;
    const last = window.lastIndexOf(0x0a);
    if (last < 0) continue;
    const previous = last === 0 ? -1 : window.lastIndexOf(0x0a, last - 1);
    if (previous >= 0 || position === 0) {
      return window.subarray(previous + 1, last);
    }
  }
  return undefined;
}

/**
 * Summary of an execution file from its first and last record, without
 * reading the middle. `undefined` when the file holds no record.
 */
async function summarize(
  path: string,
  executionId: string,
): Promise<Omit<WorkflowEventExecutionSummary, "executionId"> | undefined> {
  const handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
  try {
    const { size } = await handle.stat();
    const tail = await lastCompleteLine(handle, size);
    if (!tail) return undefined;
    let parsed: { format?: unknown; sequence?: number; timestamp?: number };
    try {
      parsed = JSON.parse(tail.toString("utf8"));
    } catch {
      throw corrupt("the last line is not JSON");
    }
    if (parsed.format !== undefined && parsed.sequence === undefined) {
      return undefined;
    }
    if (
      typeof parsed.sequence !== "number" ||
      typeof parsed.timestamp !== "number"
    ) {
      throw corrupt("the last line is not a record");
    }
    const reader = new LineReader(handle, 0, size);
    await reader.next();
    const first = await reader.next();
    if (!first) return undefined;
    const firstRecord = parseRecord(first.line, 1, executionId);
    return {
      lastSequence: parsed.sequence,
      firstTimestamp: firstRecord.timestamp,
      lastTimestamp: parsed.timestamp,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

interface LockHolder {
  pid: number | undefined;
  token: string | undefined;
  ageMs: number;
}

async function readLockHolder(path: string): Promise<LockHolder | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
    const { mtimeMs } = await handle.stat();
    const text = await handle.readFile("utf8");
    let pid: number | undefined;
    let token: string | undefined;
    try {
      const body = JSON.parse(text) as { pid?: unknown; token?: unknown };
      if (typeof body.pid === "number") pid = body.pid;
      if (typeof body.token === "string") token = body.token;
    } catch {
      // A lock still being written has no readable body yet.
    }
    return { pid, token, ageMs: Date.now() - mtimeMs };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function holderIsAlive(holder: LockHolder): boolean {
  if (holder.pid === undefined) return holder.ageMs < FRESH_LOCK_MS;
  if (holder.token !== undefined && HELD_LOCK_TOKENS.has(holder.token)) {
    return true;
  }
  // A live writer refreshes its lock every LOCK_REFRESH_MS. An older lock
  // was left by a writer that is gone, even if its pid has been reused.
  if (holder.ageMs > STALE_LOCK_MS) return false;
  // The same pid with a token this process does not hold is a lock left by an
  // earlier run that had this pid (a container restart), not a live writer.
  if (holder.pid === process.pid) {
    return holder.token !== undefined && HELD_LOCK_TOKENS.has(holder.token);
  }
  try {
    process.kill(holder.pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

/** Creates `path` with `body` unless it exists; `false` when it does. */
async function createExclusive(path: string, body: string): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

function writerBusy(pid: number | undefined): WorkflowStorageError {
  return new WorkflowStorageError(
    "WORKFLOW_STORAGE_UNAVAILABLE",
    "Another writer holds this event directory",
    {
      details: {
        provider: "jsonl",
        ...(pid === undefined ? {} : { holderPid: pid }),
      },
    },
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
