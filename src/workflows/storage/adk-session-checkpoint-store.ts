import { createHash, randomUUID } from "node:crypto";
import {
  type BaseSessionService,
  createEvent,
  createEventActions,
  DatabaseSessionService,
  InMemorySessionService,
  isStaleSessionError,
  type Session,
  VertexAiSessionService,
} from "@google/adk";
import type {
  WorkflowCheckpointStatus,
  WorkflowCheckpointV1,
} from "../checkpoint/schema.js";
import {
  DEFAULT_WORKFLOW_CHECKPOINT_MAX_BYTES,
  WorkflowCheckpointConflictError,
  type WorkflowCheckpointLocator,
  workflowCheckpointKey,
} from "../checkpoint/store.js";
import {
  type AcquireWorkflowCheckpointLeaseInput,
  BaseWorkflowCheckpointStore,
  type BaseWorkflowCheckpointStoreOptions,
  type DeleteWorkflowCheckpointInput,
  type ListWorkflowCheckpointsInput,
  type ListWorkflowCheckpointsResult,
  type PruneWorkflowCheckpointsInput,
  type PruneWorkflowCheckpointsResult,
  type StoredWorkflowCheckpoint,
  type WorkflowCheckpointLease,
  type WorkflowCheckpointStoreCapabilities,
  type WorkflowCheckpointSummary,
  type WorkflowCheckpointWriteRequest,
} from "./checkpoint-store.js";
import { WorkflowStorageError } from "./errors.js";

/** Session-state key holding the checkpoint record of an execution. */
const RECORD_KEY = "adk_llm_bridge_workflow_checkpoint";
/** Session-state key holding the lease record of an execution. */
const LEASE_KEY = "adk_llm_bridge_workflow_lease";
const EVENT_AUTHOR = "adk-llm-bridge.workflow-checkpoints";
/** Longest user or session id ADK services accept in this layout. */
const MAX_ADK_ID_LENGTH = 191;
const HASHED_ID_PREFIX = "~h";
/**
 * Memory one page of a scan may hold. `DatabaseSessionService.listSessions`
 * returns each session's whole state, which holds the checkpoint, so the page
 * size is this budget divided by the checkpoint size limit.
 */
const SCAN_PAGE_BUDGET_BYTES = 64 * 1024 * 1024;
const MIN_SCAN_PAGE_SIZE = 5;
const MAX_SCAN_PAGE_SIZE = 100;
/** Pages read again after a scan to pick up sessions saved during it. */
const MAX_CATCH_UP_PAGES = 20;
const MAX_CURSOR_LENGTH = 8192;
/** Tries of one write or lease change that lost a race and can be retried. */
const MAX_STALE_RETRIES = 8;

interface CheckpointRecord {
  workflowId: string;
  executionId: string;
  /** `JSON.stringify` of the durable checkpoint. */
  serialized: string;
  revision: string;
  status: WorkflowCheckpointStatus;
  bytes: number;
  updatedAt: number;
}

interface LeaseRecord {
  ownerId: string | null;
  fencingToken: number;
  expiresAt: number;
}

/** Default ADK app name the checkpoint sessions are stored under. */
export const DEFAULT_WORKFLOW_CHECKPOINT_APP_NAME =
  "adk-llm-bridge.workflow-checkpoints";

/**
 * Options of {@link AdkSessionServiceWorkflowCheckpointStore}.
 *
 * @experimental
 */
export interface AdkSessionServiceWorkflowCheckpointStoreOptions
  extends BaseWorkflowCheckpointStoreOptions {
  /**
   * The ADK session service that persists the checkpoints: any
   * `BaseSessionService`, for example a `DatabaseSessionService`.
   */
  sessionService: BaseSessionService;
  /**
   * ADK app name the checkpoint sessions are stored under. Use a name no
   * agent application uses, so listings never mix.
   *
   * @defaultValue {@link DEFAULT_WORKFLOW_CHECKPOINT_APP_NAME}
   */
  appName?: string;
  /**
   * What the session service guarantees for concurrent `appendEvent` calls
   * on one session.
   *
   * - `stale-session-reject`: the service rejects an append made from a
   *   stale session inside a transaction, as ADK's `DatabaseSessionService`
   *   does with `staleSession: "reject"`. The provider then reports
   *   `compareAndSet: "atomic"`, `leases: true` and `multiProcess: true`.
   * - `none`: no such check (ADK's in-memory and Vertex AI services). The
   *   provider reports `compareAndSet: "advisory"`, `leases: false` and
   *   `multiProcess: false`.
   *
   * `stale-session-reject` is refused for a service known not to reject stale
   * sessions: an ADK `InMemorySessionService` or `VertexAiSessionService`
   * (the classes themselves, not subclasses) and a `DatabaseSessionService`
   * created with a `staleSession` setting other than `"reject"`. For any other
   * service it is the host's statement about that service.
   *
   * @defaultValue `stale-session-reject` when `sessionService` is an ADK
   * `DatabaseSessionService`, else `none`
   */
  concurrency?: "stale-session-reject" | "none";
  /**
   * Whether the service keeps data after the process ends.
   *
   * @defaultValue `false` when `sessionService` is an ADK
   * `InMemorySessionService`, else `true`
   */
  durable?: boolean;
}

/**
 * Checkpoint provider built on ADK's `BaseSessionService` contract, so any
 * ADK session backend (SQLite, PostgreSQL, MySQL, MariaDB or SQL Server
 * through `DatabaseSessionService`) persists workflow checkpoints with no SQL
 * in this package. URI: `adk-session+` followed by an ADK session service
 * URI, or a bare `postgres://`, `postgresql://`, `mysql://`, `mariadb://`,
 * `mssql://` or `vertexai://` URI.
 *
 * @remarks
 * Each execution is one ADK session in a dedicated app: the user id encodes
 * the workflow id and the session id encodes the execution id. A save reads
 * the session, compares the revision and the fencing token kept in session
 * state, and appends one event whose `stateDelta` holds the new checkpoint.
 * The event timestamp is always later than the session's last update time,
 * so a service that rejects stale sessions turns two concurrent saves into
 * one winner and one `WorkflowCheckpointConflictError`.
 *
 * Costs of this route, compared with a native provider: the service keeps
 * one event per save, each holding a full checkpoint, until the session is
 * deleted (`delete` and `prune` delete whole sessions); `list` scans every
 * session of the app on each page and then reads one session per row it
 * returns (a delete or prune running at the same time can shift the service's
 * paging so that one unread row is missed by that listing); `delete` and `prune` read the record and then delete the session,
 * so a save that lands in between is deleted too, which ADK's
 * `deleteSession` cannot prevent; and the database drivers are optional peers of
 * `@google/adk` (`@mikro-orm/sqlite`, `@mikro-orm/postgresql` and others)
 * that the host installs. A missing driver surfaces as
 * `WORKFLOW_STORAGE_DRIVER_MISSING` on first use.
 *
 * It differs from `ADKSessionCheckpointStore`, which returns a `stateDelta`
 * for the session of the running invocation and leaves persistence to the
 * ADK Runner: this provider owns its sessions and writes them itself.
 *
 * @experimental
 */
export class AdkSessionServiceWorkflowCheckpointStore extends BaseWorkflowCheckpointStore {
  /** Provider name: `adk-session`. */
  readonly providerName = "adk-session";
  /** Depends on the `concurrency` and `durable` options. */
  readonly capabilities: WorkflowCheckpointStoreCapabilities;

  readonly #service: BaseSessionService;
  readonly #appName: string;
  #ready: Promise<void> | undefined;

  /**
   * Creates the provider over a session service.
   *
   * @param options - The session service, the app name, what the service
   * guarantees and the shared provider options.
   * @throws `WorkflowStorageError` with code `WORKFLOW_STORAGE_INVALID_OPTION`
   * for an empty `appName`, or for `concurrency: "stale-session-reject"` over
   * a service known not to reject stale sessions.
   */
  constructor(options: AdkSessionServiceWorkflowCheckpointStoreOptions) {
    super(options);
    if (options.appName !== undefined && options.appName.trim() === "") {
      throw new WorkflowStorageError(
        "WORKFLOW_STORAGE_INVALID_OPTION",
        "appName must not be empty",
        { details: { option: "appName" } },
      );
    }
    if (
      options.concurrency === "stale-session-reject" &&
      cannotRejectStaleSessions(options.sessionService)
    ) {
      throw new WorkflowStorageError(
        "WORKFLOW_STORAGE_INVALID_OPTION",
        'concurrency "stale-session-reject" needs a session service that rejects stale sessions; this one does not',
        { details: { option: "concurrency" } },
      );
    }
    this.#service = options.sessionService;
    this.#appName = options.appName ?? DEFAULT_WORKFLOW_CHECKPOINT_APP_NAME;
    const atomic =
      (options.concurrency ?? defaultConcurrency(options.sessionService)) ===
      "stale-session-reject";
    this.capabilities = Object.freeze({
      compareAndSet: atomic ? "atomic" : "advisory",
      leases: atomic,
      durable:
        options.durable ??
        !(options.sessionService instanceof InMemorySessionService),
      multiProcess: atomic,
      listing: true,
      pruning: true,
      maxCheckpointBytes:
        options.maxCheckpointBytes ?? DEFAULT_WORKFLOW_CHECKPOINT_MAX_BYTES,
    });
  }

  protected async readCheckpoint(
    locator: WorkflowCheckpointLocator,
  ): Promise<StoredWorkflowCheckpoint | undefined> {
    const session = await this.#getSession(locator);
    const record = session ? recordOf(session) : undefined;
    if (!record) return undefined;
    let checkpoint: WorkflowCheckpointV1;
    try {
      checkpoint = JSON.parse(record.serialized) as WorkflowCheckpointV1;
    } catch (error) {
      throw new WorkflowStorageError(
        "WORKFLOW_STORAGE_CORRUPT",
        "The stored checkpoint is not valid JSON",
        { cause: error },
      );
    }
    return {
      checkpoint,
      revision: record.revision,
      updatedAt: record.updatedAt,
    };
  }

  protected async writeCheckpoint(
    request: WorkflowCheckpointWriteRequest,
  ): Promise<number> {
    for (let attempt = 0; attempt < MAX_STALE_RETRIES; attempt++) {
      const session = await this.#getOrCreateSession(request);
      const record = recordOf(session);
      if (request.fencingToken !== undefined) {
        const current = leaseOf(session)?.fencingToken ?? 0;
        if (request.fencingToken < current) {
          throw leaseLost(request.fencingToken, current);
        }
      }
      const actual = record?.revision ?? null;
      if (
        request.expectedRevision !== undefined &&
        actual !== request.expectedRevision
      ) {
        throw new WorkflowCheckpointConflictError(
          request.checkpointKey,
          request.expectedRevision,
          actual,
        );
      }
      const updatedAt = this.currentTime();
      const next: CheckpointRecord = {
        workflowId: request.workflowId,
        executionId: request.executionId,
        serialized: request.serialized,
        revision: request.revision,
        status: request.checkpoint.status,
        bytes: request.bytes,
        updatedAt,
      };
      try {
        await this.#append(session, { [RECORD_KEY]: next });
        return updatedAt;
      } catch (error) {
        if (!isStaleSessionError(error)) throw error;
      }
      // The service rejected the append because the session changed after it
      // was read. Report the revision that is stored now when it differs; a
      // change that left the checkpoint alone (a lease) is retried.
      const latest = await this.#getSession(request);
      const latestRevision = (latest ? recordOf(latest) : undefined)?.revision;
      if (
        request.expectedRevision !== undefined &&
        (latestRevision ?? null) !== request.expectedRevision
      ) {
        throw new WorkflowCheckpointConflictError(
          request.checkpointKey,
          request.expectedRevision,
          latestRevision ?? null,
        );
      }
    }
    throw staleExhausted();
  }

  protected override async listCheckpoints(
    input: ListWorkflowCheckpointsInput & { limit: number },
  ): Promise<ListWorkflowCheckpointsResult> {
    const after =
      input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    // Rows are ordered by decoded ids, which the session ids carry, so the
    // scan keeps only ids. The rows of one page are then read one by one.
    const filtered =
      input.status !== undefined || input.updatedBefore !== undefined;
    const ordered = (await this.#scan(input.workflowId))
      .filter((row) => after === undefined || compareRows(row, after) > 0)
      .sort(compareRows);
    // Without a filter the page is known from the ids alone, so exactly one
    // session is read per row returned. A filter needs the record of every
    // candidate until the page is full.
    const candidates = filtered ? ordered : ordered.slice(0, input.limit);
    const items: WorkflowCheckpointSummary[] = [];
    let more = !filtered && ordered.length > input.limit;
    for (const row of candidates) {
      const session = await this.#getSession(row);
      const record = session ? recordOf(session) : undefined;
      if (!record) continue;
      if (
        (input.status !== undefined && record.status !== input.status) ||
        (input.updatedBefore !== undefined &&
          record.updatedAt >= input.updatedBefore)
      ) {
        continue;
      }
      if (items.length === input.limit) {
        more = true;
        break;
      }
      items.push({
        workflowId: record.workflowId,
        executionId: record.executionId,
        revision: record.revision,
        status: record.status,
        updatedAt: record.updatedAt,
        bytes: record.bytes,
      });
    }
    const last = items[items.length - 1];
    return more && last ? { items, nextCursor: encodeCursor(last) } : { items };
  }

  protected override async deleteCheckpoint(
    input: DeleteWorkflowCheckpointInput,
  ): Promise<boolean> {
    const session = await this.#getSession(input);
    const record = session ? recordOf(session) : undefined;
    if (input.expectedRevision !== undefined) {
      const actual = record?.revision ?? null;
      if (actual !== input.expectedRevision) {
        throw new WorkflowCheckpointConflictError(
          workflowCheckpointKey(input.workflowId, input.executionId),
          input.expectedRevision,
          actual,
        );
      }
    }
    if (!session) return false;
    await this.#deleteSession(input);
    return record !== undefined;
  }

  protected override async pruneCheckpoints(
    input: Required<
      Pick<
        PruneWorkflowCheckpointsInput,
        "updatedBefore" | "statuses" | "limit"
      >
    > &
      Pick<PruneWorkflowCheckpointsInput, "workflowId">,
  ): Promise<PruneWorkflowCheckpointsResult> {
    const rows = (await this.#scan(input.workflowId)).sort(compareRows);
    let deleted = 0;
    for (const row of rows) {
      const session = await this.#getSession(row);
      const record = session ? recordOf(session) : undefined;
      if (
        !record ||
        record.updatedAt >= input.updatedBefore ||
        !input.statuses.includes(record.status)
      ) {
        continue;
      }
      if (deleted === input.limit) return { deleted, hasMore: true };
      await this.#deleteSession(row);
      deleted += 1;
    }
    return { deleted, hasMore: false };
  }

  protected override async acquireCheckpointLease(
    input: AcquireWorkflowCheckpointLeaseInput,
    now: number,
  ): Promise<WorkflowCheckpointLease> {
    return await this.#changeLease(input, (current) => {
      if (
        current?.ownerId != null &&
        current.ownerId !== input.ownerId &&
        now < current.expiresAt
      ) {
        throw new WorkflowStorageError(
          "WORKFLOW_STORAGE_LEASE_HELD",
          "Another owner holds the lease of this execution",
          { details: { expiresAt: current.expiresAt } },
        );
      }
      return {
        ownerId: input.ownerId,
        fencingToken: (current?.fencingToken ?? 0) + 1,
        expiresAt: now + input.ttlMs,
      };
    });
  }

  protected override async renewCheckpointLease(
    lease: WorkflowCheckpointLease,
    expiresAt: number,
  ): Promise<WorkflowCheckpointLease> {
    return await this.#changeLease(lease, (current) => {
      if (
        !current ||
        current.ownerId !== lease.ownerId ||
        current.fencingToken !== lease.fencingToken
      ) {
        throw leaseLost(lease.fencingToken, current?.fencingToken ?? 0);
      }
      return { ...current, expiresAt };
    });
  }

  protected override async releaseCheckpointLease(
    lease: WorkflowCheckpointLease,
  ): Promise<void> {
    await this.#changeLease(
      lease,
      (current) => {
        if (
          current?.ownerId !== lease.ownerId ||
          current.fencingToken !== lease.fencingToken
        ) {
          return undefined;
        }
        // The token stays so the next lease still counts up.
        return {
          ownerId: null,
          fencingToken: current.fencingToken,
          expiresAt: 0,
        };
      },
      false,
    );
  }

  protected override async checkHealth(): Promise<undefined> {
    await this.#call(() =>
      this.#service.listSessions({
        appName: this.#appName,
        limit: 1,
        page: 1,
      }),
    );
    return undefined;
  }

  /**
   * Reads the lease, lets `decide` produce the next one (or `undefined` for no
   * change) and appends it, retrying when the service rejects the append as
   * stale.
   */
  async #changeLease(
    locator: WorkflowCheckpointLocator,
    decide: (current: LeaseRecord | undefined) => LeaseRecord | undefined,
    create = true,
  ): Promise<WorkflowCheckpointLease> {
    for (let attempt = 0; attempt < MAX_STALE_RETRIES; attempt++) {
      const session = create
        ? await this.#getOrCreateSession(locator)
        : await this.#getSession(locator);
      const next = decide(session ? leaseOf(session) : undefined);
      if (!session || !next) return leaseResult(locator, next);
      try {
        await this.#append(session, { [LEASE_KEY]: next });
        return leaseResult(locator, next);
      } catch (error) {
        if (!isStaleSessionError(error)) throw error;
      }
    }
    throw staleExhausted();
  }

  async #append(
    session: Session,
    stateDelta: Record<string, unknown>,
  ): Promise<void> {
    // A service that rejects stale sessions compares the event time with the
    // session's last update time, so the event must be strictly later.
    const timestamp = Math.max(this.currentTime(), session.lastUpdateTime + 1);
    await this.#call(() =>
      this.#service.appendEvent({
        session,
        event: createEvent({
          invocationId: `workflow-checkpoint-${randomUUID()}`,
          author: EVENT_AUTHOR,
          timestamp,
          actions: createEventActions({ stateDelta }),
        }),
      }),
    );
  }

  async #getSession(
    locator: WorkflowCheckpointLocator,
  ): Promise<Session | undefined> {
    return await this.#call(() =>
      this.#service.getSession({
        appName: this.#appName,
        userId: encodeId(locator.workflowId),
        sessionId: encodeId(locator.executionId),
        // The state holds everything read here, so one event is enough.
        config: { numRecentEvents: 1 },
      }),
    );
  }

  async #getOrCreateSession(
    locator: WorkflowCheckpointLocator,
  ): Promise<Session> {
    const existing = await this.#getSession(locator);
    if (existing) return existing;
    try {
      return await this.#call(() =>
        this.#service.createSession({
          appName: this.#appName,
          userId: encodeId(locator.workflowId),
          sessionId: encodeId(locator.executionId),
          state: {},
        }),
      );
    } catch (error) {
      // Another writer may have created the session first.
      const created = await this.#getSession(locator);
      if (created) return created;
      throw error;
    }
  }

  async #deleteSession(locator: WorkflowCheckpointLocator): Promise<void> {
    await this.#call(() =>
      this.#service.deleteSession({
        appName: this.#appName,
        userId: encodeId(locator.workflowId),
        sessionId: encodeId(locator.executionId),
      }),
    );
  }

  /** Ids of every checkpoint session in the app, read page by page. */
  async #scan(
    workflowId: string | undefined,
  ): Promise<WorkflowCheckpointLocator[]> {
    const pageSize = Math.max(
      MIN_SCAN_PAGE_SIZE,
      Math.min(
        MAX_SCAN_PAGE_SIZE,
        Math.floor(
          SCAN_PAGE_BUDGET_BYTES / this.capabilities.maxCheckpointBytes,
        ),
      ),
    );
    const rows = new Map<string, WorkflowCheckpointLocator>();
    // Reads one page and returns how many rows were new and how many
    // sessions the page held.
    const absorb = async (page: number) => {
      const result = await this.#call(() =>
        this.#service.listSessions({
          appName: this.#appName,
          ...(workflowId === undefined ? {} : { userId: encodeId(workflowId) }),
          limit: pageSize,
          page,
          // Services order by last update time, so a save during the scan
          // moves its session to the front with `desc` (the page boundary then
          // repeats one row, which the map drops) and to the end with `asc`
          // (the next page then skips a row).
          order: "desc",
        }),
      );
      let added = 0;
      for (const session of result.sessions) {
        const row = await this.#identify(session);
        if (!row) continue;
        const key = JSON.stringify([row.workflowId, row.executionId]);
        if (!rows.has(key)) added += 1;
        rows.set(key, row);
      }
      return {
        added,
        more: result.sessions.length >= pageSize && page < result.totalPages,
      };
    };
    for (let page = 1; (await absorb(page)).more; page++) {
      // Keep reading until the last page.
    }
    // A session saved during the scan that was still unread moved to the
    // front, behind the scan. Read the front again until nothing new shows up.
    for (let page = 1, round = 0; round < MAX_CATCH_UP_PAGES; round++, page++) {
      const { added, more } = await absorb(page);
      if (added === 0 || !more) break;
    }
    return [...rows.values()];
  }

  // The session ids carry the ids, except when they were too long to encode:
  // those rows are read once to learn them. A session this layout did not
  // create is not a row.
  async #identify(
    session: Pick<Session, "id" | "userId" | "state">,
  ): Promise<WorkflowCheckpointLocator | undefined> {
    const workflowId = decodeId(session.userId);
    const executionId = decodeId(session.id);
    if (workflowId !== undefined && executionId !== undefined) {
      return { workflowId, executionId };
    }
    if (
      !session.userId.startsWith(HASHED_ID_PREFIX) &&
      !session.id.startsWith(HASHED_ID_PREFIX)
    ) {
      return undefined;
    }
    const record = recordOf(session) ?? (await this.#recordByIds(session));
    if (
      record &&
      encodeId(record.workflowId) === session.userId &&
      encodeId(record.executionId) === session.id
    ) {
      return { workflowId: record.workflowId, executionId: record.executionId };
    }
    return undefined;
  }

  async #recordByIds(
    session: Pick<Session, "id" | "userId">,
  ): Promise<CheckpointRecord | undefined> {
    const full = await this.#call(() =>
      this.#service.getSession({
        appName: this.#appName,
        userId: session.userId,
        sessionId: session.id,
        config: { numRecentEvents: 1 },
      }),
    );
    return full ? recordOf(full) : undefined;
  }

  /**
   * Runs a service call, naming a missing database driver. The first call of
   * a store waits for one read to finish: ADK's database service creates its
   * schema on first use and does not guard against two callers doing that at
   * once, which concurrent first saves would otherwise do.
   */
  async #call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      await this.#warmUp();
      return await operation();
    } catch (error) {
      throw missingDriverError(error) ?? error;
    }
  }

  #warmUp(): Promise<void> {
    this.#ready ??= this.#service
      .listSessions({ appName: this.#appName, limit: 1, page: 1 })
      .then(
        () => undefined,
        (error: unknown) => {
          this.#ready = undefined;
          throw error;
        },
      );
    return this.#ready;
  }
}

/**
 * Whether `service` is known not to reject an append from a stale session.
 * Subclasses are not judged: they may add the check.
 */
function cannotRejectStaleSessions(service: BaseSessionService): boolean {
  const own = Object.getPrototypeOf(service) as unknown;
  if (
    own === InMemorySessionService.prototype ||
    own === VertexAiSessionService.prototype
  ) {
    return true;
  }
  if (service instanceof DatabaseSessionService) {
    const setting = staleSessionSetting(service);
    return setting !== undefined && setting !== "reject";
  }
  return false;
}

/**
 * ADK's `staleSession` setting of a `DatabaseSessionService`. The field is
 * private in ADK's types; when a release renames it the answer is
 * `undefined`, and the default concurrency becomes `none`, which claims less.
 */
function staleSessionSetting(
  service: DatabaseSessionService,
): string | undefined {
  const value = (service as unknown as { staleSession?: unknown }).staleSession;
  return typeof value === "string" ? value : undefined;
}

function defaultConcurrency(
  service: BaseSessionService,
): "stale-session-reject" | "none" {
  return service instanceof DatabaseSessionService &&
    staleSessionSetting(service) === "reject"
    ? "stale-session-reject"
    : "none";
}

/**
 * Encodes an id into the characters ADK ids allow (`A-Za-z0-9._~-`): every
 * other byte becomes `~` and two hex digits, so the encoding is reversible
 * and two ids never share one. An id whose encoding is longer than ADK
 * services accept is replaced by `~h` and the SHA-256 of the id; the
 * checkpoint record keeps the real id.
 */
function encodeId(id: string): string {
  let encoded = "";
  for (const byte of Buffer.from(id, "utf8")) {
    const char = String.fromCharCode(byte);
    encoded += /[A-Za-z0-9._-]/u.test(char)
      ? char
      : `~${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded.length <= MAX_ADK_ID_LENGTH
    ? encoded
    : `${HASHED_ID_PREFIX}${createHash("sha256").update(id).digest("hex")}`;
}

/** Reverses {@link encodeId}; `undefined` for hashed or foreign ids. */
function decodeId(encoded: string): string | undefined {
  if (!/^[A-Za-z0-9._~-]+$/u.test(encoded)) return undefined;
  if (encoded.startsWith(HASHED_ID_PREFIX)) return undefined;
  const bytes: number[] = [];
  for (let index = 0; index < encoded.length; index++) {
    const char = encoded.charAt(index);
    if (char !== "~") {
      bytes.push(char.charCodeAt(0));
      continue;
    }
    const hex = encoded.slice(index + 1, index + 3);
    if (!/^[0-9A-F]{2}$/u.test(hex)) return undefined;
    bytes.push(Number.parseInt(hex, 16));
    index += 2;
  }
  const decoded = Buffer.from(bytes).toString("utf8");
  return encodeId(decoded) === encoded ? decoded : undefined;
}

function recordOf(
  session: Pick<Session, "state">,
): CheckpointRecord | undefined {
  const value = session.state[RECORD_KEY];
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Partial<CheckpointRecord>;
  return typeof record.serialized === "string" &&
    typeof record.revision === "string" &&
    typeof record.workflowId === "string" &&
    typeof record.executionId === "string" &&
    typeof record.status === "string" &&
    typeof record.updatedAt === "number" &&
    typeof record.bytes === "number"
    ? (record as CheckpointRecord)
    : undefined;
}

function leaseOf(session: Pick<Session, "state">): LeaseRecord | undefined {
  const value = session.state[LEASE_KEY];
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Partial<LeaseRecord>;
  return typeof record.fencingToken === "number" &&
    typeof record.expiresAt === "number" &&
    (record.ownerId === null || typeof record.ownerId === "string")
    ? (record as LeaseRecord)
    : undefined;
}

function leaseResult(
  locator: WorkflowCheckpointLocator,
  record: LeaseRecord | undefined,
): WorkflowCheckpointLease {
  return {
    workflowId: locator.workflowId,
    executionId: locator.executionId,
    ownerId: record?.ownerId ?? "",
    fencingToken: record?.fencingToken ?? 0,
    expiresAt: record?.expiresAt ?? 0,
  };
}

function leaseLost(given: number, current: number): WorkflowStorageError {
  return new WorkflowStorageError(
    "WORKFLOW_STORAGE_LEASE_LOST",
    "The lease of this execution was replaced; the write was not applied",
    { details: { fencingToken: given, currentFencingToken: current } },
  );
}

function staleExhausted(): WorkflowStorageError {
  return new WorkflowStorageError(
    "WORKFLOW_STORAGE_UNAVAILABLE",
    "The session service kept rejecting the write as stale",
    { retryable: true },
  );
}

/**
 * Recognizes the error ADK's `DatabaseSessionService` throws when an optional
 * MikroORM driver package is not installed.
 */
function missingDriverError(error: unknown): WorkflowStorageError | undefined {
  const chain: unknown[] = [];
  for (
    let current: unknown = error;
    current instanceof Error && chain.length < 5;
    current = current.cause
  ) {
    chain.push(current);
  }
  const notFound = chain.some((entry) => {
    const code = (entry as { code?: unknown }).code;
    return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND";
  });
  const text = chain.map((entry) => (entry as Error).message).join("\n");
  const named =
    /optional peer dependency "([^"]+)"/u.exec(text) ??
    /Cannot find (?:module|package) '(@mikro-orm\/[^']+)'/u.exec(text);
  const driver = named?.[1];
  if (!driver || !(notFound || /optional peer dependency/u.test(text))) {
    return undefined;
  }
  return new WorkflowStorageError(
    "WORKFLOW_STORAGE_DRIVER_MISSING",
    `The ADK session service needs the optional package "${driver}", which is not installed; install it next to @google/adk`,
    { details: { driver }, cause: error },
  );
}

function compareRows(
  a: { workflowId: string; executionId: string },
  b: { workflowId: string; executionId: string },
): number {
  if (a.workflowId !== b.workflowId) {
    return a.workflowId < b.workflowId ? -1 : 1;
  }
  if (a.executionId !== b.executionId) {
    return a.executionId < b.executionId ? -1 : 1;
  }
  return 0;
}

function encodeCursor(row: {
  workflowId: string;
  executionId: string;
}): string {
  return Buffer.from(
    JSON.stringify([row.workflowId, row.executionId]),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(cursor: string): {
  workflowId: string;
  executionId: string;
} {
  const invalid = () =>
    new WorkflowStorageError(
      "WORKFLOW_STORAGE_INVALID_OPTION",
      "cursor is not a cursor this provider returned",
      { details: { option: "cursor" } },
    );
  if (cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(cursor)) {
    throw invalid();
  }
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return { workflowId: parsed[0], executionId: parsed[1] };
    }
  } catch {
    // Falls through to the error below.
  }
  throw invalid();
}
