/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import {
  canonicalJson,
  snapshotJson,
  type WorkflowResourceJsonValue,
} from "../resources/json.js";
import type { WorkspaceDescriptor } from "../resources/workspace-provisioner.js";
import type { WorkflowChangeOperationOptions } from "./change-driver.js";

export type WorkflowHostMutationKind = "commit" | "integration";
export type WorkflowHostMutationStatus = "pending" | "completed" | "ambiguous";

export interface WorkflowHostMutationIntent {
  operationId: string;
  intentDigest: string;
  kind: WorkflowHostMutationKind;
  executionId: string;
  taskId: string;
  startedAt: number;
}

export interface WorkflowHostMutationRecord extends WorkflowHostMutationIntent {
  revision: number;
  status: WorkflowHostMutationStatus;
  updatedAt: number;
  result?: WorkflowResourceJsonValue;
  ambiguity?: string;
}

export interface WorkflowHostMutationBeginResult {
  record: WorkflowHostMutationRecord;
  created: boolean;
}

/** Durable implementations provide idempotency by operationId + intentDigest. */
export interface WorkflowHostMutationJournal {
  begin(
    intent: WorkflowHostMutationIntent,
  ): Promise<WorkflowHostMutationBeginResult>;
  get(operationId: string): Promise<WorkflowHostMutationRecord | undefined>;
  complete(
    operationId: string,
    intentDigest: string,
    result: WorkflowResourceJsonValue,
  ): Promise<WorkflowHostMutationRecord>;
  markAmbiguous(
    operationId: string,
    intentDigest: string,
    reason: string,
  ): Promise<WorkflowHostMutationRecord>;
  list(executionId: string): Promise<readonly WorkflowHostMutationRecord[]>;
}

export class WorkflowHostMutationConflictError extends Error {
  readonly code = "WORKFLOW_HOST_MUTATION_CONFLICT" as const;

  constructor(message: string) {
    super(message);
    this.name = "WorkflowHostMutationConflictError";
  }
}

/** Single-process reference. Production hosts should persist the same CAS rules. */
export class InMemoryWorkflowHostMutationJournal
  implements WorkflowHostMutationJournal
{
  readonly #records = new Map<string, WorkflowHostMutationRecord>();

  async begin(
    intent: WorkflowHostMutationIntent,
  ): Promise<WorkflowHostMutationBeginResult> {
    const normalized = normalizeIntent(intent);
    const current = this.#records.get(normalized.operationId);
    if (current) {
      assertSameIntent(current, normalized.intentDigest);
      return Object.freeze({ record: current, created: false });
    }
    const record = freezeRecord({
      ...normalized,
      revision: 1,
      status: "pending",
      updatedAt: normalized.startedAt,
    });
    this.#records.set(record.operationId, record);
    return Object.freeze({ record, created: true });
  }

  async get(
    operationId: string,
  ): Promise<WorkflowHostMutationRecord | undefined> {
    return this.#records.get(requiredIdentity(operationId, "operationId"));
  }

  async complete(
    operationId: string,
    intentDigest: string,
    result: WorkflowResourceJsonValue,
  ): Promise<WorkflowHostMutationRecord> {
    const current = this.#required(operationId, intentDigest);
    const normalizedResult = snapshotJson(result, "mutation result");
    if (current.status === "completed") {
      if (
        canonicalJson(current.result ?? null) !==
        canonicalJson(normalizedResult)
      ) {
        throw conflict(operationId, "already has a different completed result");
      }
      return current;
    }
    const record = freezeRecord({
      ...current,
      revision: current.revision + 1,
      status: "completed",
      updatedAt: nextTimestamp(current.updatedAt),
      result: normalizedResult,
    });
    this.#records.set(operationId, record);
    return record;
  }

  async markAmbiguous(
    operationId: string,
    intentDigest: string,
    reason: string,
  ): Promise<WorkflowHostMutationRecord> {
    const current = this.#required(operationId, intentDigest);
    const ambiguity = requiredNonEmptyString(reason, "ambiguity reason");
    if (current.status === "completed") {
      throw conflict(operationId, "is already completed");
    }
    if (current.status === "ambiguous" && current.ambiguity === ambiguity) {
      return current;
    }
    const record = freezeRecord({
      ...current,
      revision: current.revision + 1,
      status: "ambiguous",
      updatedAt: nextTimestamp(current.updatedAt),
      ambiguity,
    });
    this.#records.set(operationId, record);
    return record;
  }

  async list(
    executionId: string,
  ): Promise<readonly WorkflowHostMutationRecord[]> {
    const id = requiredIdentity(executionId, "executionId");
    return Object.freeze(
      [...this.#records.values()]
        .filter((record) => record.executionId === id)
        .sort(
          (left, right) =>
            left.startedAt - right.startedAt ||
            left.operationId.localeCompare(right.operationId),
        ),
    );
  }

  #required(
    operationId: string,
    intentDigest: string,
  ): WorkflowHostMutationRecord {
    const id = requiredIdentity(operationId, "operationId");
    const current = this.#records.get(id);
    if (!current) throw conflict(id, "does not exist");
    assertSameIntent(current, requiredDigest(intentDigest));
    return current;
  }
}

export const WORKFLOW_WORKSPACE_ATTACHMENT = Symbol(
  "WorkflowWorkspaceAttachment",
);

/** Host-only attachment reconstructed from a durable JSON descriptor. */
export interface WorkflowWorkspaceAttachment<HostWorkspace = unknown> {
  readonly [WORKFLOW_WORKSPACE_ATTACHMENT]: true;
  readonly descriptor: WorkspaceDescriptor;
  readonly host: HostWorkspace;
  detach(): Promise<boolean>;
}

/** Host port used after restart to attach to or recover a durable workspace. */
export interface WorkflowWorkspaceRecoveryPort<HostWorkspace = unknown> {
  attach(
    descriptor: WorkspaceDescriptor,
    options?: WorkflowChangeOperationOptions,
  ): Promise<WorkflowWorkspaceAttachment<HostWorkspace> | undefined>;
  recover(
    descriptor: WorkspaceDescriptor,
    options?: WorkflowChangeOperationOptions,
  ): Promise<WorkflowWorkspaceAttachment<HostWorkspace>>;
}

function normalizeIntent(
  input: WorkflowHostMutationIntent,
): WorkflowHostMutationIntent {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Mutation intent must be an object");
  }
  const keys = Object.keys(input).sort();
  if (
    keys.join(",") !==
    "executionId,intentDigest,kind,operationId,startedAt,taskId"
  ) {
    throw new TypeError("Mutation intent contains unknown properties");
  }
  if (input.kind !== "commit" && input.kind !== "integration") {
    throw new TypeError("Mutation intent kind is invalid");
  }
  return Object.freeze({
    operationId: requiredIdentity(input.operationId, "operationId"),
    intentDigest: requiredDigest(input.intentDigest),
    kind: input.kind,
    executionId: requiredIdentity(input.executionId, "executionId"),
    taskId: requiredIdentity(input.taskId, "taskId"),
    startedAt: requiredTimestamp(input.startedAt, "startedAt"),
  });
}

function freezeRecord(
  input: WorkflowHostMutationRecord,
): WorkflowHostMutationRecord {
  return Object.freeze(input);
}

function assertSameIntent(
  record: WorkflowHostMutationRecord,
  intentDigest: string,
): void {
  if (record.intentDigest !== intentDigest) {
    throw conflict(
      record.operationId,
      "was reused with a different intent digest",
    );
  }
}

function requiredIdentity(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,255}$/u.test(value)
  ) {
    throw new TypeError(`${field} must be a safe identity`);
  }
  return value;
}

function requiredDigest(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError("intentDigest must be a lowercase SHA-256 digest");
  }
  return value;
}

function requiredNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requiredTimestamp(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function nextTimestamp(previous: number): number {
  return Math.max(previous + 1, Date.now());
}

function conflict(
  operationId: string,
  detail: string,
): WorkflowHostMutationConflictError {
  return new WorkflowHostMutationConflictError(
    `Mutation operation ${operationId} ${detail}`,
  );
}
