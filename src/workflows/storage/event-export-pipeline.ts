import { createHash, randomBytes } from "node:crypto";
import { type BaseArtifactService, type Event, logger } from "@google/adk";
import { isWorkflowStorageError, WorkflowStorageError } from "./errors.js";
import {
  type AppendWorkflowEventRecordsResult,
  assertWorkflowEventJsonSafe,
  type BaseWorkflowEventExporter,
  MAX_WORKFLOW_EVENT_APPEND_BATCH,
  validateWorkflowEventRecord,
  type WorkflowEventPayloadReference,
  type WorkflowEventRecordClipping,
  type WorkflowEventRecordInput,
} from "./event-exporter.js";
import type {
  WorkflowStorageJsonObject,
  WorkflowStorageRetryPolicy,
} from "./support.js";

/** Default largest size of one string inside a record payload: 16 KiB. */
export const DEFAULT_WORKFLOW_EVENT_STRING_MAX_BYTES = 16 * 1024;
/** Default largest number of records waiting for export. */
export const DEFAULT_WORKFLOW_EVENT_BUFFER_RECORDS = 10_000;
/** Default largest total size of the records waiting for export: 32 MiB. */
export const DEFAULT_WORKFLOW_EVENT_BUFFER_BYTES = 32 * 1024 * 1024;

/**
 * Codes of {@link WorkflowEventExportWarning}.
 *
 * - `WORKFLOW_EVENT_EXPORT_DEGRADED`: an append failed and is being retried;
 *   records are waiting in the buffer.
 * - `WORKFLOW_EVENT_EXPORT_RECOVERED`: appends succeed again.
 * - `WORKFLOW_EVENT_EXPORT_DROPPED`: records were discarded; `reason` says
 *   why and `droppedRecords` how many.
 *
 * @experimental
 */
export type WorkflowEventExportWarningCode =
  | "WORKFLOW_EVENT_EXPORT_DEGRADED"
  | "WORKFLOW_EVENT_EXPORT_RECOVERED"
  | "WORKFLOW_EVENT_EXPORT_DROPPED";

/**
 * Typed notice that the export of workflow events is failing or lost
 * records. The run itself is never affected.
 *
 * @remarks
 * A warning reaches the host three ways: the `onWarning` option, a line in
 * ADK's logger with the code in brackets, and, for
 * `WORKFLOW_EVENT_EXPORT_DROPPED`, a record of kind `warning` appended to
 * the execution as soon as the exporter accepts writes again. That record
 * takes the next sequence, so the log keeps no gap and states how many
 * records are missing.
 *
 * @experimental
 */
export interface WorkflowEventExportWarning {
  /** Warning code. */
  code: WorkflowEventExportWarningCode;
  /** Execution the warning is about. */
  executionId: string;
  /** Epoch milliseconds when the warning was raised. */
  timestamp: number;
  /**
   * Why records were dropped: the buffer was full, the retries were used up,
   * the exporter rejected the batch with an error that a retry cannot fix,
   * the pipeline was closed before they were exported, or a record could not
   * be made JSON-safe.
   */
  reason?:
    | "buffer_full"
    | "retries_exhausted"
    | "non_retryable"
    | "closed"
    | "invalid_record";
  /** Number of records dropped, for `WORKFLOW_EVENT_EXPORT_DROPPED`. */
  droppedRecords?: number;
  /** Code of the storage error behind the warning, when there is one. */
  errorCode?: string;
  /** Number of tries made for the failing batch. */
  attempts?: number;
}

/**
 * Stores the full payload of a record that had to be clipped and returns
 * where it went. It runs in the background; when it throws or exceeds the
 * append time limit the record is exported clipped, without a reference.
 *
 * @experimental
 */
export type WorkflowEventPayloadOverflowHandler = (overflow: {
  /** Execution of the record. */
  executionId: string;
  /** Id of the record. */
  recordId: string;
  /** The full payload as JSON text. */
  serialized: string;
  /** SHA-256 (hex) of `serialized`. */
  sha256: string;
}) => Promise<WorkflowEventPayloadReference>;

/**
 * Options of {@link WorkflowEventExportPipeline}.
 *
 * @experimental
 */
export interface WorkflowEventExportPipelineOptions {
  /** Exporter that stores the records. */
  exporter: BaseWorkflowEventExporter;
  /**
   * Largest serialized size of one record, in bytes; larger records are
   * clipped.
   *
   * @defaultValue the exporter's `capabilities.maxRecordBytes`
   */
  maxRecordBytes?: number;
  /**
   * Largest UTF-8 size of one string in a clipped payload, in bytes.
   *
   * @defaultValue {@link DEFAULT_WORKFLOW_EVENT_STRING_MAX_BYTES}
   */
  maxStringBytes?: number;
  /**
   * Largest number of records waiting for export.
   *
   * @defaultValue {@link DEFAULT_WORKFLOW_EVENT_BUFFER_RECORDS}
   */
  maxBufferedRecords?: number;
  /**
   * Largest total serialized size of the records waiting for export, in
   * bytes.
   *
   * @defaultValue {@link DEFAULT_WORKFLOW_EVENT_BUFFER_BYTES}
   */
  maxBufferedBytes?: number;
  /**
   * Largest number of records sent in one `append`.
   *
   * @defaultValue 200
   */
  maxBatchRecords?: number;
  /**
   * Longest time a record waits before its batch is sent, in milliseconds.
   *
   * @defaultValue 100
   */
  flushIntervalMs?: number;
  /**
   * Time limit of one `append` call, in milliseconds.
   *
   * @defaultValue 5000
   */
  appendTimeoutMs?: number;
  /**
   * Retry rules for a failing batch.
   *
   * @defaultValue 5 tries, 100 ms initial delay, doubling up to 5 s
   */
  retry?: WorkflowStorageRetryPolicy;
  /** Stores the full payload of clipped records, for example as ADK artifacts. */
  overflow?: WorkflowEventPayloadOverflowHandler;
  /** Receives every warning. A throwing callback is ignored. */
  onWarning?: (warning: WorkflowEventExportWarning) => void;
}

/**
 * Counters of a {@link WorkflowEventExportPipeline}.
 *
 * @experimental
 */
export interface WorkflowEventExportPipelineStats {
  /** Records handed to `offer`. */
  offered: number;
  /** Records the exporter stored. */
  exported: number;
  /** Records the exporter reported as already stored. */
  duplicates: number;
  /** Records discarded. */
  dropped: number;
  /** Records whose payload was clipped. */
  clipped: number;
  /** Appends repeated after a failure. */
  retries: number;
  /** Records waiting for export now. */
  buffered: number;
}

/**
 * Context for turning an ADK event into records.
 *
 * @experimental
 */
export interface WorkflowEventRecordMappingContext {
  /**
   * Execution id to use when the event names none. The pipeline remembers
   * the execution of the last workflow event per invocation id.
   */
  executionId?: string;
  /**
   * Export events marked `partial` (streaming chunks).
   *
   * @defaultValue `false`
   */
  includePartial?: boolean;
}

/**
 * Turns one ADK event into export records, without clipping.
 *
 * @remarks
 * - An event whose `customMetadata.workflowEvent` is a workflow event gives
 *   one record of kind `workflow` or `step`, with the workflow event as
 *   payload. A `checkpoint_saved` payload holds the checkpoint key, never the
 *   checkpoint: `actions.stateDelta` values are replaced by their sizes.
 * - An event with `customMetadata.externalAgent` gives one `agent_run` record
 *   typed after the external agent event.
 * - Any other event gives one `agent_run` record of type `adk_event`.
 * - A `partial` event gives no record unless `includePartial` is set.
 *
 * The record id is the ADK event id. The execution id is the one of the
 * workflow event, else `context.executionId`, else `invocation:` plus the
 * invocation id.
 *
 * @param event - The ADK event.
 * @param context - Fallback execution id and the partial-event rule.
 * @returns Zero or one record.
 *
 * @experimental
 */
export function workflowEventRecordsFromAdkEvent(
  event: Event,
  context: WorkflowEventRecordMappingContext = {},
): WorkflowEventRecordInput[] {
  if (event.partial === true && context.includePartial !== true) return [];
  const custom = (event.customMetadata ?? {}) as Record<string, unknown>;
  const workflowEvent = custom.workflowEvent;
  const invocationId = event.invocationId;
  const fallbackExecution = `invocation:${invocationId}`;
  const base = {
    id: event.id,
    timestamp: event.timestamp,
    ...(typeof invocationId === "string" && invocationId !== ""
      ? { invocationId }
      : {}),
  };

  if (isRecord(workflowEvent) && typeof workflowEvent.type === "string") {
    const type = workflowEvent.type;
    const executionId =
      stringOf(workflowEvent.executionId) ??
      context.executionId ??
      fallbackExecution;
    let payload = toJson(workflowEvent) as Record<string, unknown>;
    if (type === "checkpoint_saved") {
      // The checkpoint travels in the state delta; only its sizes are kept.
      const delta = event.actions?.stateDelta;
      if (isRecord(delta) && Object.keys(delta).length > 0) {
        const sizes: Record<string, number> = {};
        for (const [key, value] of Object.entries(delta)) {
          sizes[key] = JSON.stringify(value ?? null).length;
        }
        payload = { ...payload, stateDeltaSizes: sizes };
      }
    }
    const nested = (name: string): Record<string, unknown> =>
      isRecord(workflowEvent[name])
        ? (workflowEvent[name] as Record<string, unknown>)
        : {};
    const stepId =
      stringOf(workflowEvent.stepId) ??
      stringOf(nested("step").id) ??
      stringOf(nested("result").id) ??
      stringOf(nested("failure").id);
    const agentName =
      stringOf(workflowEvent.agentName) ??
      stringOf(nested("step").agentName) ??
      stringOf(nested("result").agentName) ??
      stringOf(nested("failure").agentName);
    const workflowId = stringOf(workflowEvent.workflowId);
    const attempt =
      typeof workflowEvent.attempt === "number" &&
      Number.isSafeInteger(workflowEvent.attempt) &&
      workflowEvent.attempt >= 0
        ? workflowEvent.attempt
        : undefined;
    return [
      {
        ...base,
        executionId,
        kind: STEP_EVENT_TYPES.has(type) ? "step" : "workflow",
        type,
        timestamp:
          typeof workflowEvent.timestamp === "number" &&
          Number.isFinite(workflowEvent.timestamp)
            ? workflowEvent.timestamp
            : event.timestamp,
        ...(workflowId === undefined ? {} : { workflowId }),
        ...(stepId === undefined ? {} : { stepId }),
        ...(attempt === undefined ? {} : { attempt }),
        ...(agentName === undefined ? {} : { agentName }),
        payload: payload as WorkflowStorageJsonObject,
      },
    ];
  }

  const executionId = context.executionId ?? fallbackExecution;
  const agentName = stringOf(event.author);
  const common = {
    ...base,
    executionId,
    kind: "agent_run" as const,
    ...(agentName === undefined ? {} : { agentName }),
  };
  if (custom.externalAgent) {
    const { type, payload } = externalAgentPayload(event, custom);
    return [{ ...common, type, payload }];
  }
  const actions = event.actions;
  const payload: Record<string, unknown> = {
    author: event.author,
    content: event.content,
    errorCode: event.errorCode,
    errorMessage: event.errorMessage,
    turnComplete: event.turnComplete,
    partial: event.partial,
    stateDelta: nonEmpty(actions?.stateDelta),
    artifactDelta: nonEmpty(actions?.artifactDelta),
    transferToAgent: actions?.transferToAgent,
    escalate: actions?.escalate,
    customMetadata: event.customMetadata,
  };
  return [
    {
      ...common,
      type: "adk_event",
      payload: toJson(payload) as WorkflowStorageJsonObject,
    },
  ];
}

const STEP_EVENT_TYPES: ReadonlySet<string> = new Set([
  "step_started",
  "step_completed",
  "step_failed",
  "step_interrupted",
  "step_replayed",
  "step_waiting",
]);

const EXTERNAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "started",
  "output",
  "tool_call",
  "tool_result",
  "state_delta",
  "error",
  "completed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function nonEmpty(value: unknown): unknown {
  return isRecord(value) && Object.keys(value).length > 0 ? value : undefined;
}

/** Copies a value as JSON: functions and `undefined` fields disappear. */
function toJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null));
}

function externalAgentPayload(
  event: Event,
  custom: Record<string, unknown>,
): { type: string; payload: WorkflowStorageJsonObject } {
  const parts = event.content?.parts ?? [];
  const hint = custom.externalAgentEventType;
  const delta = nonEmpty(event.actions?.stateDelta);
  let type: string;
  if (typeof hint === "string" && EXTERNAL_EVENT_TYPES.has(hint)) {
    type = hint;
  } else if (event.errorCode || event.errorMessage) {
    type = "error";
  } else if (parts.some((part) => part.functionCall)) {
    type = "tool_call";
  } else if (parts.some((part) => part.functionResponse)) {
    type = "tool_result";
  } else if (parts.some((part) => typeof part.text === "string")) {
    type = "output";
  } else if (delta !== undefined) {
    type = "state_delta";
  } else {
    type = "completed";
  }
  const payload: Record<string, unknown> = {
    content: event.content,
    errorCode: event.errorCode,
    errorMessage: event.errorMessage,
    stateDelta: delta,
    turnComplete: event.turnComplete,
    title: custom.title,
  };
  return { type, payload: toJson(payload) as WorkflowStorageJsonObject };
}

/**
 * Shortens a record to a size limit. The rules, in order:
 *
 * 1. A record whose serialized size is within `maxRecordBytes` is returned
 *    unchanged.
 * 2. Otherwise every string in `payload` longer than `maxStringBytes` is cut
 *    at a character boundary and ends with `…[clipped N bytes]`, longest
 *    first, until the record fits. `clipped.paths` lists the JSON pointers.
 * 3. If it still does not fit, `payload` becomes `{}` and
 *    `clipped.payloadDropped` is `true`.
 *
 * `clipped.originalBytes` and `clipped.sha256` describe the payload before
 * clipping. Ids, kind, type and the other envelope fields are never changed.
 *
 * @param record - The record to fit.
 * @param limits - Record and string limits, in bytes.
 * @returns The record, clipped when needed, and the full payload text when
 * it was clipped.
 * @throws `WorkflowStorageError` with code `WORKFLOW_STORAGE_INVALID_RECORD`
 * when the payload is not JSON-safe, or `WORKFLOW_STORAGE_PAYLOAD_TOO_LARGE`
 * when the envelope alone exceeds `maxRecordBytes`.
 *
 * @experimental
 */
export function clipWorkflowEventRecord(
  record: WorkflowEventRecordInput,
  limits: { maxRecordBytes: number; maxStringBytes?: number },
): { record: WorkflowEventRecordInput; overflow?: string } {
  const { maxRecordBytes } = limits;
  const maxStringBytes =
    limits.maxStringBytes ?? DEFAULT_WORKFLOW_EVENT_STRING_MAX_BYTES;
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) {
    throw invalidOption("maxRecordBytes");
  }
  if (!Number.isSafeInteger(maxStringBytes) || maxStringBytes < 1) {
    throw invalidOption("maxStringBytes");
  }
  const payload = (record as { payload?: unknown } | null)?.payload;
  if (!isRecord(payload)) {
    throw new WorkflowStorageError(
      "WORKFLOW_STORAGE_INVALID_RECORD",
      "Invalid event record: payload must be an object",
    );
  }
  assertWorkflowEventJsonSafe(payload, "payload");
  if (utf8(JSON.stringify(record)) <= maxRecordBytes) return { record };

  const payloadText = JSON.stringify(payload);
  // Measured and hashed once: the loop below asks for the metadata size after
  // every cut, and hashing a large payload each time made clipping quadratic.
  const originalBytes = utf8(payloadText);
  const sha256 = createHash("sha256").update(payloadText).digest("hex");
  const metadata = (
    paths: readonly string[],
    payloadDropped: boolean,
  ): WorkflowEventRecordClipping => ({
    originalBytes,
    sha256,
    paths,
    payloadDropped,
  });
  const { payload: _payload, clipped: _clipped, ...envelope } = record;
  const dropped = {
    ...envelope,
    payload: {},
    clipped: metadata([], true),
  };
  if (utf8(JSON.stringify(dropped)) > maxRecordBytes) {
    throw new WorkflowStorageError(
      "WORKFLOW_STORAGE_PAYLOAD_TOO_LARGE",
      `The envelope of an event record exceeds the limit of ${maxRecordBytes} bytes`,
      { details: { maxRecordBytes } },
    );
  }

  const copy = JSON.parse(payloadText) as WorkflowStorageJsonObject;
  const candidates = collectStrings(copy, maxStringBytes).sort(
    (a, b) => b.bytes - a.bytes,
  );
  let size = utf8(JSON.stringify({ ...envelope, payload: copy }));
  const paths: string[] = [];
  // The metadata size grows by each listed pointer; it is tracked, not
  // serialized again after every cut.
  let overhead = utf8(`,"clipped":${JSON.stringify(metadata([], false))}`);
  for (const candidate of candidates) {
    if (size + overhead <= maxRecordBytes) break;
    const cut = cutString(candidate.value, candidate.bytes, maxStringBytes);
    if (utf8(cut) >= candidate.bytes) continue;
    size += utf8(JSON.stringify(cut)) - utf8(JSON.stringify(candidate.value));
    (candidate.holder as Record<string, unknown>)[candidate.key] = cut;
    overhead +=
      utf8(JSON.stringify(candidate.pointer)) + (paths.length > 0 ? 1 : 0);
    paths.push(candidate.pointer);
  }
  if (paths.length > 0) {
    const clipped = {
      ...envelope,
      payload: copy,
      clipped: metadata(paths, false),
    };
    if (utf8(JSON.stringify(clipped)) <= maxRecordBytes) {
      return { record: clipped, overflow: payloadText };
    }
  }
  return { record: dropped, overflow: payloadText };
}

function invalidOption(name: string): WorkflowStorageError {
  return new WorkflowStorageError(
    "WORKFLOW_STORAGE_INVALID_OPTION",
    `${name} must be a positive safe integer`,
    { details: { option: name } },
  );
}

function utf8(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

interface StringSlot {
  holder: object;
  key: string;
  pointer: string;
  value: string;
  bytes: number;
}

/** Finds the strings above a size, with the JSON pointer of each. */
function collectStrings(root: object, minBytes: number): StringSlot[] {
  const found: StringSlot[] = [];
  const visit = (node: object, pointer: string): void => {
    for (const [key, value] of Object.entries(node)) {
      const next = `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      if (typeof value === "string") {
        const bytes = utf8(value);
        if (bytes > minBytes) {
          found.push({ holder: node, key, pointer: next, value, bytes });
        }
      } else if (typeof value === "object" && value !== null) {
        visit(value, next);
      }
    }
  };
  visit(root, "");
  return found;
}

/** Keeps the start of a string and appends the marker, within a byte size. */
function cutString(value: string, bytes: number, maxBytes: number): string {
  const marker = (removed: number): string => `…[clipped ${removed} bytes]`;
  // The marker for the whole length has at least as many digits as the real one.
  const budget = Math.max(0, maxBytes - utf8(marker(bytes)));
  let used = 0;
  let end = 0;
  for (const character of value) {
    const size = utf8(character);
    if (used + size > budget) break;
    used += size;
    end += character.length;
  }
  return value.slice(0, end) + marker(bytes - used);
}

/**
 * Builds an overflow handler that stores full payloads through an ADK
 * artifact service, one artifact per record.
 *
 * @param artifactService - Any ADK `BaseArtifactService`.
 * @param scope - App name and user id the artifacts are stored under; the
 * session id is derived from the execution id.
 * @returns A handler for the `overflow` option; its references have
 * `store: "adk-artifact"`.
 *
 * @experimental
 */
export function createArtifactOverflowHandler(
  artifactService: BaseArtifactService,
  scope: { appName: string; userId: string },
): WorkflowEventPayloadOverflowHandler {
  return async ({ executionId, recordId, serialized }) => {
    const digest = (text: string): string =>
      createHash("sha256").update(text).digest("hex");
    const filename = `workflow-event-${digest(`${executionId}\0${recordId}`).slice(0, 40)}.json`;
    const version = await artifactService.saveArtifact({
      appName: scope.appName,
      userId: scope.userId,
      sessionId: `workflow-events-${digest(executionId).slice(0, 32)}`,
      filename,
      artifact: { text: serialized },
    });
    return { store: "adk-artifact", key: filename, version };
  };
}

/**
 * Buffers records and exports them in order, in the background, so that a
 * slow or failing exporter never delays or fails a workflow.
 *
 * @remarks
 * Failure policy, each line a test:
 *
 * - `offer` is synchronous, never throws and never waits on storage.
 * - Records of one execution are appended in the order they were offered,
 *   one batch at a time. The exporter assigns the sequence, so retried
 *   batches add no duplicates and the stored log has no gaps.
 * - A failing `append` is retried with backoff (`retry`), each try limited
 *   by `appendTimeoutMs`. The first failure raises
 *   `WORKFLOW_EVENT_EXPORT_DEGRADED`.
 * - When the retries are used up, or the error is not retryable, the batch
 *   is dropped and `WORKFLOW_EVENT_EXPORT_DROPPED` is raised.
 * - When the buffer is full (`maxBufferedRecords` or `maxBufferedBytes`),
 *   the newest record is dropped and counted; one
 *   `WORKFLOW_EVENT_EXPORT_DROPPED` is raised per burst.
 * - Dropped records are reported in the log itself by one `warning` record
 *   per burst, appended when the exporter works again.
 * - `flush` and `close` wait at most their time limit and never reject.
 *
 * `close` appends the warning records of drops that no later record has
 * reported yet; `flush` does not. A try that times out may still complete in
 * the exporter after its retry was sent; the batch id check of the exporter
 * keeps that harmless for the log. When the last try times out, the batch
 * is reported as dropped at once, but the execution sends nothing more until
 * that try settles: a late landing never puts earlier records after later
 * ones, and when it lands the records are counted as exported again and get
 * no warning record.
 *
 * Records still in the buffer when the process is killed are lost; the
 * stored log stays valid and without gaps.
 *
 * @experimental
 */
export class WorkflowEventExportPipeline {
  /** The exporter records are sent to. */
  readonly exporter: BaseWorkflowEventExporter;

  readonly #maxRecordBytes: number;
  readonly #maxStringBytes: number;
  readonly #maxBufferedRecords: number;
  readonly #maxBufferedBytes: number;
  readonly #maxBatchRecords: number;
  readonly #flushIntervalMs: number;
  readonly #appendTimeoutMs: number;
  readonly #retry: Required<WorkflowStorageRetryPolicy>;
  readonly #overflow: WorkflowEventPayloadOverflowHandler | undefined;
  readonly #onWarning:
    | ((warning: WorkflowEventExportWarning) => void)
    | undefined;
  readonly #instance = randomBytes(6).toString("hex");
  readonly #queues = new Map<string, ExecutionQueue>();
  readonly #executionByInvocation = new Map<string, string>();
  readonly #idleWaiters = new Set<() => void>();
  readonly #sleepers = new Set<() => void>();
  // Appends that outlived their timeout, keyed by the timeout error.
  readonly #lateAppends = new WeakMap<
    object,
    Promise<AppendWorkflowEventRecordsResult>
  >();
  readonly #burst = new Set<string>();
  readonly #counters = {
    offered: 0,
    exported: 0,
    duplicates: 0,
    dropped: 0,
    clipped: 0,
    retries: 0,
  };
  #buffered = 0;
  #bufferedBytes = 0;
  #entries = 0;
  #warningCount = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  /**
   * Creates a pipeline. Nothing is sent until a record is offered.
   *
   * @param options - Exporter, limits, retry rules and callbacks.
   * @throws `WorkflowStorageError` with code `WORKFLOW_STORAGE_INVALID_OPTION`
   * for a limit that is not a positive safe integer.
   */
  constructor(options: WorkflowEventExportPipelineOptions) {
    this.exporter = options.exporter;
    const positive = (
      name: string,
      value: number | undefined,
      fallback: number,
    ): number => {
      const chosen = value ?? fallback;
      if (!Number.isSafeInteger(chosen) || chosen < 1) {
        throw invalidOption(name);
      }
      return chosen;
    };
    // A record the exporter would reject must be clipped here instead.
    this.#maxRecordBytes = Math.min(
      positive(
        "maxRecordBytes",
        options.maxRecordBytes,
        options.exporter.capabilities.maxRecordBytes,
      ),
      options.exporter.capabilities.maxRecordBytes,
    );
    this.#maxStringBytes = positive(
      "maxStringBytes",
      options.maxStringBytes,
      DEFAULT_WORKFLOW_EVENT_STRING_MAX_BYTES,
    );
    this.#maxBufferedRecords = positive(
      "maxBufferedRecords",
      options.maxBufferedRecords,
      DEFAULT_WORKFLOW_EVENT_BUFFER_RECORDS,
    );
    this.#maxBufferedBytes = positive(
      "maxBufferedBytes",
      options.maxBufferedBytes,
      DEFAULT_WORKFLOW_EVENT_BUFFER_BYTES,
    );
    this.#maxBatchRecords = Math.min(
      positive("maxBatchRecords", options.maxBatchRecords, 200),
      MAX_WORKFLOW_EVENT_APPEND_BATCH - 1,
    );
    this.#flushIntervalMs = positive(
      "flushIntervalMs",
      options.flushIntervalMs,
      100,
    );
    this.#appendTimeoutMs = positive(
      "appendTimeoutMs",
      options.appendTimeoutMs,
      5_000,
    );
    const retry = options.retry ?? {};
    const delay = (
      name: string,
      value: number | undefined,
      fallback: number,
    ): number => {
      const chosen = value ?? fallback;
      if (!Number.isFinite(chosen) || chosen < 0) throw invalidOption(name);
      return chosen;
    };
    const jitter = retry.jitter ?? 0.2;
    if (!(jitter >= 0 && jitter <= 1)) throw invalidOption("retry.jitter");
    this.#retry = {
      maxAttempts: positive("retry.maxAttempts", retry.maxAttempts, 5),
      initialDelayMs: delay("retry.initialDelayMs", retry.initialDelayMs, 100),
      maxDelayMs: delay("retry.maxDelayMs", retry.maxDelayMs, 5_000),
      jitter,
    };
    this.#overflow = options.overflow;
    this.#onWarning = options.onWarning;
  }

  /** Current counters. */
  get stats(): WorkflowEventExportPipelineStats {
    return { ...this.#counters, buffered: this.#buffered };
  }

  /**
   * Queues one record for export.
   *
   * @param record - The record; it is clipped to the size limit first.
   * @returns `true` when the record was queued, `false` when it was dropped.
   */
  offer(record: WorkflowEventRecordInput): boolean {
    try {
      return this.#offer(record);
    } catch {
      return false;
    }
  }

  /**
   * Maps an ADK event with {@link workflowEventRecordsFromAdkEvent} and
   * queues the records. Use it when iterating `runner.runAsync` without the
   * plugin.
   *
   * @param event - The ADK event.
   * @param context - Fallback execution id and the partial-event rule.
   * @returns The number of records queued.
   */
  offerAdkEvent(
    event: Event,
    context?: WorkflowEventRecordMappingContext,
  ): number {
    try {
      if (typeof event !== "object" || event === null) return 0;
      const invocationId = event.invocationId;
      const remembered =
        typeof invocationId === "string"
          ? this.#executionByInvocation.get(invocationId)
          : undefined;
      const records = workflowEventRecordsFromAdkEvent(event, {
        ...context,
        ...(context?.executionId === undefined && remembered !== undefined
          ? { executionId: remembered }
          : {}),
      });
      const workflowEvent = event.customMetadata?.workflowEvent as
        | { executionId?: unknown }
        | undefined;
      if (
        typeof invocationId === "string" &&
        typeof workflowEvent?.executionId === "string"
      ) {
        this.#executionByInvocation.delete(invocationId);
        this.#executionByInvocation.set(
          invocationId,
          workflowEvent.executionId,
        );
        if (this.#executionByInvocation.size > MAX_REMEMBERED_INVOCATIONS) {
          const oldest = this.#executionByInvocation.keys().next().value;
          if (oldest !== undefined) this.#executionByInvocation.delete(oldest);
        }
      }
      let queued = 0;
      for (const record of records) if (this.offer(record)) queued += 1;
      return queued;
    } catch {
      return 0;
    }
  }

  /**
   * Waits until the buffered records are exported or dropped, or the time
   * limit passes. While it waits it holds the process open, so a script whose
   * only remaining work is this flush does not exit before it ends.
   *
   * @param timeoutMs - Longest wait, in milliseconds. Defaults to 5000.
   * @returns The number of records still buffered; `0` when everything was
   * handled.
   */
  async flush(timeoutMs?: number): Promise<number> {
    try {
      const limit =
        typeof timeoutMs === "number" &&
        Number.isFinite(timeoutMs) &&
        timeoutMs >= 0
          ? timeoutMs
          : DEFAULT_WAIT_MS;
      this.#schedule(true);
      if (this.#entries > 0 && limit > 0) await this.#waitIdle(limit);
    } catch {
      // flush never rejects.
    }
    return this.#buffered;
  }

  /**
   * Flushes, then stops the pipeline; records still buffered after the time
   * limit are dropped with reason `closed`. The exporter stays open. Later
   * offers are dropped. Like {@link WorkflowEventExportPipeline.flush}, it holds
   * the process open while it waits.
   *
   * @param timeoutMs - Longest wait, in milliseconds. Defaults to 5000.
   */
  async close(timeoutMs?: number): Promise<void> {
    if (this.#closed) return;
    try {
      // Drops with no later record still get their warning record in the log.
      for (const queue of this.#queues.values()) {
        if (!queue.pending) continue;
        this.#push(queue, this.#warningEntry(queue, queue.pending));
        queue.pending = undefined;
      }
      await this.flush(timeoutMs);
    } catch {
      // close never rejects.
    }
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const wake of [...this.#sleepers]) wake();
    for (const queue of this.#queues.values()) {
      const left = queue.entries;
      if (left.length === 0) continue;
      queue.entries = [];
      let records = 0;
      for (const entry of left) {
        entry.gone = true;
        this.#entries -= 1;
        if (!entry.warning) {
          records += 1;
          this.#buffered -= 1;
          this.#bufferedBytes -= entry.bytes;
        }
      }
      if (records > 0) {
        this.#counters.dropped += records;
        this.#raise({
          code: "WORKFLOW_EVENT_EXPORT_DROPPED",
          executionId: queue.executionId,
          reason: "closed",
          droppedRecords: records,
        });
      }
    }
    this.#notifyIdle();
  }

  #offer(record: WorkflowEventRecordInput): boolean {
    this.#counters.offered += 1;
    const executionId = (record as { executionId?: unknown } | null)
      ?.executionId;
    if (this.#closed) {
      this.#counters.dropped += 1;
      return false;
    }
    let entry: Entry;
    let overflow: string | undefined;
    try {
      const reserve = this.#overflow ? OVERFLOW_RESERVE_BYTES : 0;
      const clipped = clipWorkflowEventRecord(record, {
        maxRecordBytes:
          this.#maxRecordBytes > reserve * 2
            ? this.#maxRecordBytes - reserve
            : this.#maxRecordBytes,
        maxStringBytes: this.#maxStringBytes,
      });
      overflow = clipped.overflow;
      const bytes = validateWorkflowEventRecord(
        clipped.record,
        clipped.record.executionId,
        this.#maxRecordBytes,
      );
      entry = {
        record: clipped.record,
        bytes,
        ready: true,
        warning: false,
        gone: false,
      };
    } catch (error) {
      this.#dropOne(
        typeof executionId === "string" && executionId !== ""
          ? executionId
          : undefined,
        "invalid_record",
        error,
      );
      return false;
    }
    if (
      this.#buffered + 1 > this.#maxBufferedRecords ||
      this.#bufferedBytes + entry.bytes > this.#maxBufferedBytes
    ) {
      this.#dropOne(entry.record.executionId, "buffer_full");
      return false;
    }
    this.#burst.clear();
    const queue = this.#queueFor(entry.record.executionId);
    if (queue.pending) {
      this.#push(queue, this.#warningEntry(queue, queue.pending));
      queue.pending = undefined;
    }
    if (overflow !== undefined) this.#counters.clipped += 1;
    this.#buffered += 1;
    this.#bufferedBytes += entry.bytes;
    this.#push(queue, entry);
    if (overflow !== undefined && this.#overflow) {
      this.#storeOverflow(entry, overflow);
    }
    this.#schedule(queue.entries.length >= this.#maxBatchRecords);
    return true;
  }

  #queueFor(executionId: string): ExecutionQueue {
    let queue = this.#queues.get(executionId);
    if (!queue) {
      queue = {
        executionId,
        entries: [],
        running: false,
        degraded: false,
        pending: undefined,
      };
      this.#queues.set(executionId, queue);
    }
    return queue;
  }

  #push(queue: ExecutionQueue, entry: Entry): void {
    queue.entries.push(entry);
    this.#entries += 1;
  }

  /** Builds the warning record that reports a gap in an execution's log. */
  #warningEntry(queue: ExecutionQueue, pending: PendingDrop): Entry {
    this.#warningCount += 1;
    const payload: Record<string, unknown> = {
      code: "WORKFLOW_EVENT_EXPORT_DROPPED",
      droppedRecords: pending.count,
      reasons: { ...pending.reasons },
      ...(pending.errorCode === undefined
        ? {}
        : { errorCode: pending.errorCode }),
      ...(pending.attempts === undefined ? {} : { attempts: pending.attempts }),
    };
    const record: WorkflowEventRecordInput = {
      id: `warning:${this.#instance}:${this.#warningCount}`,
      executionId: queue.executionId,
      kind: "warning",
      type: "WORKFLOW_EVENT_EXPORT_DROPPED",
      timestamp: Date.now(),
      payload: payload as WorkflowStorageJsonObject,
    };
    return {
      record,
      bytes: 0,
      ready: true,
      warning: true,
      gone: false,
      pending,
    };
  }

  /** Counts a record that never entered the buffer. */
  #dropOne(
    executionId: string | undefined,
    reason: "buffer_full" | "invalid_record",
    error?: unknown,
  ): void {
    this.#counters.dropped += 1;
    const errorCode = isWorkflowStorageError(error) ? error.code : undefined;
    if (executionId !== undefined) {
      this.#addPending(this.#queueFor(executionId), {
        count: 1,
        reasons: { [reason]: 1 },
        errorCode,
        attempts: undefined,
      });
    }
    this.#trimIdleQueues();
    if (this.#burst.has(reason)) return;
    this.#burst.add(reason);
    this.#raise({
      code: "WORKFLOW_EVENT_EXPORT_DROPPED",
      executionId: executionId ?? "",
      reason,
      droppedRecords: 1,
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  }

  #addPending(queue: ExecutionQueue, extra: PendingDrop): void {
    const pending = queue.pending ?? {
      count: 0,
      reasons: {},
      errorCode: undefined,
      attempts: undefined,
    };
    pending.count += extra.count;
    for (const [reason, count] of Object.entries(extra.reasons)) {
      pending.reasons[reason] = (pending.reasons[reason] ?? 0) + count;
    }
    pending.errorCode = extra.errorCode ?? pending.errorCode;
    pending.attempts = extra.attempts ?? pending.attempts;
    queue.pending = pending;
  }

  /** Stores the full payload in the background; the record waits for it. */
  #storeOverflow(entry: Entry, serialized: string): void {
    const handler = this.#overflow;
    if (!handler) return;
    entry.ready = false;
    const { executionId, id } = entry.record;
    void (async () => {
      let reference: WorkflowEventPayloadReference | undefined;
      try {
        reference = await this.#withTimeout(
          handler({
            executionId,
            recordId: id,
            serialized,
            sha256: createHash("sha256").update(serialized).digest("hex"),
          }),
        );
      } catch {
        // The record is exported clipped, without a reference.
      }
      if (entry.gone) return;
      if (reference && entry.record.clipped) {
        const withReference: WorkflowEventRecordInput = {
          ...entry.record,
          clipped: { ...entry.record.clipped, reference },
        };
        if (utf8(JSON.stringify(withReference)) <= this.#maxRecordBytes) {
          entry.record = withReference;
        }
      }
      entry.ready = true;
      this.#schedule(true);
    })();
  }

  #withTimeout<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new WorkflowStorageError(
              "WORKFLOW_STORAGE_TIMEOUT",
              `The operation exceeded ${this.#appendTimeoutMs} ms`,
            ),
          ),
        this.#appendTimeoutMs,
      );
      timer.unref?.();
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  #schedule(immediate: boolean): void {
    if (this.#closed) return;
    if (this.#timer) {
      if (!immediate) return;
      clearTimeout(this.#timer);
    }
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined;
        this.#start();
      },
      immediate ? 0 : this.#flushIntervalMs,
    );
    this.#timer.unref?.();
  }

  /** Starts the sender of every execution that has a batch ready. */
  #start(): void {
    for (const queue of this.#queues.values()) {
      if (queue.running || !queue.entries[0]?.ready) continue;
      queue.running = true;
      void this.#drain(queue);
    }
  }

  async #drain(queue: ExecutionQueue): Promise<void> {
    try {
      while (!this.#closed) {
        if (queue.late !== undefined) {
          await queue.late;
          continue;
        }
        const batch: Entry[] = [];
        const ids = new Set<string>();
        for (const entry of queue.entries) {
          // A repeated id (an event replayed before the flush) starts the next
          // batch: exporters reject a batch that holds an id twice, and the
          // next batch stores it as a duplicate that writes nothing.
          if (
            !entry.ready ||
            entry.gone ||
            batch.length >= this.#maxBatchRecords ||
            ids.has(entry.record.id)
          ) {
            break;
          }
          ids.add(entry.record.id);
          batch.push(entry);
        }
        if (batch.length === 0) break;
        await this.#send(queue, batch);
      }
    } catch {
      // The sender never fails the process.
    } finally {
      queue.running = false;
      this.#trimIdleQueues();
    }
  }

  async #send(queue: ExecutionQueue, batch: Entry[]): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      let result: AppendWorkflowEventRecordsResult;
      try {
        result = await this.#appendOnce(
          queue.executionId,
          batch.map((entry) => entry.record),
        );
      } catch (error) {
        if (batch[0]?.gone) return;
        const retryable = isWorkflowStorageError(error) && error.retryable;
        const errorCode = isWorkflowStorageError(error)
          ? error.code
          : undefined;
        if (!queue.degraded) {
          queue.degraded = true;
          this.#raise({
            code: "WORKFLOW_EVENT_EXPORT_DEGRADED",
            executionId: queue.executionId,
            ...(errorCode === undefined ? {} : { errorCode }),
            attempts: attempt,
          });
        }
        if (retryable && attempt < this.#retry.maxAttempts) {
          this.#counters.retries += 1;
          const completed = await this.#sleep(this.#delayBefore(attempt));
          if (!completed || batch[0]?.gone) return;
          continue;
        }
        this.#dropBatch(
          queue,
          batch,
          retryable ? "retries_exhausted" : "non_retryable",
          errorCode,
          attempt,
          this.#lateAppends.get(error as object),
        );
        return;
      }
      if (batch[0]?.gone) return;
      this.#complete(queue, batch, result);
      return;
    }
  }

  #appendOnce(
    executionId: string,
    records: WorkflowEventRecordInput[],
  ): Promise<AppendWorkflowEventRecordsResult> {
    return new Promise((resolve, reject) => {
      let pending: Promise<AppendWorkflowEventRecordsResult> | undefined;
      const timer = setTimeout(() => {
        const error = new WorkflowStorageError(
          "WORKFLOW_STORAGE_TIMEOUT",
          `The append exceeded ${this.#appendTimeoutMs} ms`,
          { details: { timeoutMs: this.#appendTimeoutMs } },
        );
        if (pending !== undefined) this.#lateAppends.set(error, pending);
        reject(error);
      }, this.#appendTimeoutMs);
      timer.unref?.();
      try {
        pending = this.exporter.append({ executionId, records });
      } catch (error) {
        clearTimeout(timer);
        reject(error);
        return;
      }
      pending.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /**
   * Waits for an append that outlived its timeout; `done` is `false` when the
   * pipeline closes first.
   */
  #settle(
    pending: Promise<AppendWorkflowEventRecordsResult>,
  ): Promise<
    | { done: true; ok: true; value: AppendWorkflowEventRecordsResult }
    | { done: true; ok: false; error: unknown }
    | { done: false }
  > {
    return new Promise((resolve) => {
      const wake = () => {
        this.#sleepers.delete(wake);
        resolve({ done: false });
      };
      this.#sleepers.add(wake);
      pending.then(
        (value) => {
          this.#sleepers.delete(wake);
          resolve({ done: true, ok: true, value });
        },
        (error: unknown) => {
          this.#sleepers.delete(wake);
          resolve({ done: true, ok: false, error });
        },
      );
    });
  }

  #delayBefore(attempt: number): number {
    const { initialDelayMs, maxDelayMs, jitter } = this.#retry;
    const base = Math.min(maxDelayMs, initialDelayMs * 2 ** (attempt - 1));
    return base * (1 - jitter * Math.random());
  }

  /** Resolves `true` after the delay, `false` when the pipeline closes first. */
  #sleep(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.#sleepers.delete(wake);
        resolve(false);
      };
      const timer = setTimeout(() => {
        this.#sleepers.delete(wake);
        resolve(true);
      }, ms);
      timer.unref?.();
      this.#sleepers.add(wake);
    });
  }

  /** Takes a batch out of its queue; returns how many records it held. */
  #remove(queue: ExecutionQueue, batch: Entry[]): number {
    if (queue.entries[0] === batch[0]) {
      queue.entries.splice(0, batch.length);
    } else {
      const removed = new Set(batch);
      queue.entries = queue.entries.filter((entry) => !removed.has(entry));
    }
    let records = 0;
    for (const entry of batch) {
      entry.gone = true;
      this.#entries -= 1;
      if (!entry.warning) {
        records += 1;
        this.#buffered -= 1;
        this.#bufferedBytes -= entry.bytes;
      }
    }
    return records;
  }

  #complete(
    queue: ExecutionQueue,
    batch: Entry[],
    result: AppendWorkflowEventRecordsResult,
  ): void {
    batch.forEach((entry, index) => {
      if (entry.warning) return;
      if (result?.records?.[index]?.duplicate === true) {
        this.#counters.duplicates += 1;
      } else {
        this.#counters.exported += 1;
      }
    });
    this.#remove(queue, batch);
    if (queue.degraded) {
      queue.degraded = false;
      this.#raise({
        code: "WORKFLOW_EVENT_EXPORT_RECOVERED",
        executionId: queue.executionId,
      });
    }
    this.#notifyIdle();
  }

  #dropBatch(
    queue: ExecutionQueue,
    batch: Entry[],
    reason: "retries_exhausted" | "non_retryable",
    errorCode: string | undefined,
    attempts: number,
    late?: Promise<AppendWorkflowEventRecordsResult>,
  ): void {
    const records = this.#remove(queue, batch);
    this.#counters.dropped += records;
    // A warning record that was in the lost batch is reported again.
    for (const entry of batch) {
      if (entry.pending) this.#addPending(queue, entry.pending);
    }
    if (records > 0) {
      const drop: PendingDrop = {
        count: records,
        reasons: { [reason]: records },
        errorCode,
        attempts,
      };
      if (late === undefined) {
        this.#addPending(queue, drop);
      } else {
        // The last try timed out but may still land. The execution sends
        // nothing more until it settles, so a late landing cannot put these
        // records after later ones; when it lands they are counted as
        // exported and get no warning record.
        queue.late = this.#settle(late).then((outcome) => {
          queue.late = undefined;
          if (outcome.done && outcome.ok) {
            this.#counters.dropped -= records;
            this.#counters.exported += records;
          } else {
            this.#addPending(queue, drop);
          }
          this.#schedule(true);
        });
      }
      this.#raise({
        code: "WORKFLOW_EVENT_EXPORT_DROPPED",
        executionId: queue.executionId,
        reason,
        droppedRecords: records,
        ...(errorCode === undefined ? {} : { errorCode }),
        attempts,
      });
    }
    if (queue.pending && queue.entries.length > 0) {
      // The log continues with the records still queued: say what is missing
      // right before them.
      queue.entries.unshift(this.#warningEntry(queue, queue.pending));
      this.#entries += 1;
      queue.pending = undefined;
    }
    this.#notifyIdle();
  }

  /**
   * Forgets idle queues: all of them when they hold nothing, and the oldest
   * ones beyond a bound when they only remember a pending drop report.
   */
  #trimIdleQueues(): void {
    let remembered = 0;
    for (const [id, queue] of this.#queues) {
      if (queue.running || queue.entries.length > 0) continue;
      if (!queue.pending && !queue.degraded && !queue.late) {
        this.#queues.delete(id);
      } else remembered += 1;
    }
    for (const [id, queue] of this.#queues) {
      if (remembered <= MAX_IDLE_REMEMBERED_QUEUES) break;
      if (queue.running || queue.entries.length > 0 || queue.late) continue;
      this.#queues.delete(id);
      remembered -= 1;
    }
  }

  #notifyIdle(): void {
    if (this.#entries > 0) return;
    for (const waiter of [...this.#idleWaiters]) waiter();
  }

  #waitIdle(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#idleWaiters.delete(done);
        resolve();
      };
      // This timer stays referenced: it is the handle that keeps the process
      // alive while a flush or close is awaited. The pipeline's other timers
      // are unreferenced, so an idle pipeline never holds the process.
      const timer = setTimeout(done, Math.min(timeoutMs, MAX_TIMER_MS));
      this.#idleWaiters.add(done);
    });
  }

  #raise(fields: Omit<WorkflowEventExportWarning, "timestamp">): void {
    const warning: WorkflowEventExportWarning = {
      ...fields,
      timestamp: Date.now(),
    };
    try {
      const detail = [
        warning.reason && `reason=${warning.reason}`,
        warning.droppedRecords !== undefined &&
          `droppedRecords=${warning.droppedRecords}`,
        warning.errorCode && `errorCode=${warning.errorCode}`,
        warning.attempts !== undefined && `attempts=${warning.attempts}`,
      ]
        .filter(Boolean)
        .join(" ");
      logger.warn(
        `[${warning.code}] workflow event export, execution ${warning.executionId}${detail ? ` ${detail}` : ""}`,
      );
    } catch {
      // Logging never fails the pipeline.
    }
    try {
      this.#onWarning?.(warning);
    } catch {
      // A throwing callback is ignored.
    }
  }
}

/** Largest delay `setTimeout` honors; longer delays fire after about 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const DEFAULT_WAIT_MS = 5_000;
/** Idle executions whose pending drop report is kept in memory. */
const MAX_IDLE_REMEMBERED_QUEUES = 1_000;
const MAX_REMEMBERED_INVOCATIONS = 1_000;
/** Room left in a record for the reference an overflow handler returns. */
const OVERFLOW_RESERVE_BYTES = 384;

interface PendingDrop {
  count: number;
  reasons: Record<string, number>;
  errorCode: string | undefined;
  attempts: number | undefined;
}

interface Entry {
  record: WorkflowEventRecordInput;
  /** Serialized size counted against the buffer; `0` for a warning record. */
  bytes: number;
  /** `false` while an overflow handler still holds the record. */
  ready: boolean;
  /** The record is the pipeline's own report of dropped records. */
  warning: boolean;
  /** The entry left the buffer; late results are ignored. */
  gone: boolean;
  /** For a warning record, the drops it reports. */
  pending?: PendingDrop;
}

interface ExecutionQueue {
  executionId: string;
  entries: Entry[];
  running: boolean;
  degraded: boolean;
  /** Drops not yet reported by a warning record in the log. */
  pending: PendingDrop | undefined;
  /** Settles when a timed-out append of this execution has landed or failed. */
  late?: Promise<void> | undefined;
}
