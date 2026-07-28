/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

export type WorkflowChangeEntryKind =
  | "file"
  | "directory"
  | "symlink"
  | "submodule";

interface WorkflowChangeEntryBase {
  entryKind: WorkflowChangeEntryKind;
  /** Digest of the entry at the side of the change being proposed. */
  contentDigest: string;
}

export interface WorkflowAddedChange extends WorkflowChangeEntryBase {
  kind: "added";
  path: string;
}

export interface WorkflowModifiedChange extends WorkflowChangeEntryBase {
  kind: "modified";
  path: string;
}

export interface WorkflowDeletedChange extends WorkflowChangeEntryBase {
  kind: "deleted";
  path: string;
}

export interface WorkflowRenamedChange extends WorkflowChangeEntryBase {
  kind: "renamed";
  fromPath: string;
  toPath: string;
}

export type WorkflowChangeEntry =
  | WorkflowAddedChange
  | WorkflowModifiedChange
  | WorkflowDeletedChange
  | WorkflowRenamedChange;

export interface WorkflowChangeSetInput {
  executionId: string;
  taskId: string;
  planRevision: number;
  workspaceRevision: string;
  baseRevision: string;
  entries: readonly WorkflowChangeEntry[];
}

/** JSON-only snapshot returned by a read-only workspace inspection. */
export interface WorkflowChangeSet extends WorkflowChangeSetInput {
  changeSetDigest: string;
}

export interface WorkflowOwnershipFence {
  grantId: string;
  fencingToken: number;
}

export interface WorkflowExpectedTarget {
  targetId: string;
  revision: string;
}

/**
 * Immutable evidence that a particular inspected snapshot was accepted.
 * It is deliberately JSON-only; host workspace handles never belong here.
 */
export interface WorkflowAcceptedChangeReceipt {
  receiptId: string;
  verdict: "accepted";
  executionId: string;
  taskId: string;
  planRevision: number;
  workspaceRevision: string;
  baseRevision: string;
  changeSetDigest: string;
  ownership: readonly WorkflowOwnershipFence[];
  issuedAt: number;
  expectedTarget: WorkflowExpectedTarget;
}

export interface WorkflowChangeInspectionRequest {
  executionId: string;
  taskId: string;
  planRevision: number;
  workspaceRevision: string;
  baseRevision: string;
}

export interface WorkflowChangeOperationOptions {
  signal?: AbortSignal;
}

/** Read-only host port. Implementations must not mutate the workspace. */
export interface WorkflowChangeInspector<HostWorkspace = unknown> {
  inspect(
    workspace: HostWorkspace,
    request: WorkflowChangeInspectionRequest,
    options?: WorkflowChangeOperationOptions,
  ): Promise<WorkflowChangeSet>;
}

export interface WorkflowCommitRequest {
  receipt: WorkflowAcceptedChangeReceipt;
  message: string;
}

/** Input visible to a host commit implementation after reinspection. */
export interface WorkflowCommitDriverInput {
  changeSet: WorkflowChangeSet;
  receipt: WorkflowAcceptedChangeReceipt;
  message: string;
}

export interface WorkflowCommitResult {
  commitId: string;
  receiptId: string;
  changeSetDigest: string;
  workspaceRevision: string;
  baseRevision: string;
  committedAt: number;
}

/** Mutation port. Call through WorkflowValidatedCommitter. */
export interface WorkflowCommitDriver<HostWorkspace = unknown> {
  commit(
    workspace: HostWorkspace,
    input: WorkflowCommitDriverInput,
    options?: WorkflowChangeOperationOptions,
  ): Promise<WorkflowCommitResult>;
}

export interface WorkflowIntegrationRequest {
  executionId: string;
  taskId: string;
  commitId: string;
  receiptId: string;
  changeSetDigest: string;
  expectedTarget: WorkflowExpectedTarget;
}

export interface WorkflowIntegrationResult {
  integrationId: string;
  commitId: string;
  targetId: string;
  previousRevision: string;
  integratedRevision: string;
  integratedAt: number;
}

/**
 * Explicit host mutation port. Implementations must atomically compare
 * expectedTarget.revision and integrate exactly commitId; no mutable branch
 * name may be resolved after the comparison.
 */
export interface WorkflowIntegrationDriver<HostRepository = unknown> {
  integrate(
    repository: HostRepository,
    request: WorkflowIntegrationRequest,
    options?: WorkflowChangeOperationOptions,
  ): Promise<WorkflowIntegrationResult>;
}

/**
 * Enforces the anti-TOCTOU boundary before a host commit can run.
 * The inspector is invoked for every commit, even when the receipt is fresh.
 */
export class WorkflowValidatedCommitter<HostWorkspace = unknown> {
  readonly #inspector: WorkflowChangeInspector<HostWorkspace>;
  readonly #driver: WorkflowCommitDriver<HostWorkspace>;

  constructor(
    inspector: WorkflowChangeInspector<HostWorkspace>,
    driver: WorkflowCommitDriver<HostWorkspace>,
  ) {
    this.#inspector = inspector;
    this.#driver = driver;
  }

  async commit(
    workspace: HostWorkspace,
    request: WorkflowCommitRequest,
    options: WorkflowChangeOperationOptions = {},
  ): Promise<WorkflowCommitResult> {
    throwIfAborted(options.signal);
    const receipt = normalizeAcceptedChangeReceipt(request.receipt);
    const message = requiredNonEmptyString(request.message, "commit message");
    const changeSet = await this.#inspector.inspect(
      workspace,
      inspectionRequestFromReceipt(receipt),
      options,
    );
    throwIfAborted(options.signal);
    const verified = await verifyWorkflowChangeSet(changeSet);
    assertChangeSetMatchesReceipt(verified, receipt);
    const result = await this.#driver.commit(
      workspace,
      Object.freeze({ changeSet: verified, receipt, message }),
      options,
    );
    throwIfAborted(options.signal);
    return normalizeCommitResult(result, verified, receipt);
  }
}

/** Creates a canonical, frozen change set and computes its SHA-256 digest. */
export async function createWorkflowChangeSet(
  input: WorkflowChangeSetInput,
): Promise<WorkflowChangeSet> {
  const normalized = normalizeChangeSetInput(input);
  const changeSetDigest = await digestCanonicalJson(normalized);
  return Object.freeze({ ...normalized, changeSetDigest });
}

/** Rejects forged or stale change set digests and returns a frozen snapshot. */
export async function verifyWorkflowChangeSet(
  input: WorkflowChangeSet,
): Promise<WorkflowChangeSet> {
  assertExactObject(input, CHANGE_SET_KEYS, "change set");
  const normalized = normalizeChangeSetInput({
    executionId: input.executionId,
    taskId: input.taskId,
    planRevision: input.planRevision,
    workspaceRevision: input.workspaceRevision,
    baseRevision: input.baseRevision,
    entries: input.entries,
  });
  const declaredDigest = requiredDigest(
    input.changeSetDigest,
    "changeSetDigest",
  );
  const actualDigest = await digestCanonicalJson(normalized);
  if (declaredDigest !== actualDigest) {
    throw new WorkflowChangeMismatchError(
      "CHANGE_SET_DIGEST_MISMATCH",
      "Change set digest does not match its canonical contents",
    );
  }
  return Object.freeze({ ...normalized, changeSetDigest: declaredDigest });
}

export function normalizeAcceptedChangeReceipt(
  input: WorkflowAcceptedChangeReceipt,
): WorkflowAcceptedChangeReceipt {
  assertExactObject(input, RECEIPT_KEYS, "accepted change receipt");
  if (input.verdict !== "accepted") {
    throw new TypeError("Change receipt verdict must be accepted");
  }
  if (!Array.isArray(input.ownership) || input.ownership.length === 0) {
    throw new TypeError("Change receipt requires ownership fencing evidence");
  }
  const seen = new Set<string>();
  const ownership = input.ownership.map((fence, index) => {
    assertExactObject(
      fence,
      OWNERSHIP_FENCE_KEYS,
      `accepted change receipt ownership[${index}]`,
    );
    const grantId = requiredIdentity(fence.grantId, "grantId");
    if (seen.has(grantId)) {
      throw new TypeError(`Duplicate ownership grant: ${grantId}`);
    }
    seen.add(grantId);
    return Object.freeze({
      grantId,
      fencingToken: requiredPositiveInteger(fence.fencingToken, "fencingToken"),
    });
  });
  const expectedTarget = normalizeExpectedTarget(input.expectedTarget);
  return Object.freeze({
    receiptId: requiredIdentity(input.receiptId, "receiptId"),
    verdict: "accepted",
    executionId: requiredIdentity(input.executionId, "executionId"),
    taskId: requiredIdentity(input.taskId, "taskId"),
    planRevision: requiredPositiveInteger(input.planRevision, "planRevision"),
    workspaceRevision: requiredRevision(
      input.workspaceRevision,
      "workspaceRevision",
    ),
    baseRevision: requiredRevision(input.baseRevision, "baseRevision"),
    changeSetDigest: requiredDigest(input.changeSetDigest, "changeSetDigest"),
    ownership: Object.freeze(ownership),
    issuedAt: requiredNonNegativeInteger(input.issuedAt, "issuedAt"),
    expectedTarget,
  });
}

export function assertChangeSetMatchesReceipt(
  changeSet: WorkflowChangeSet,
  receipt: WorkflowAcceptedChangeReceipt,
): void {
  const comparisons: ReadonlyArray<
    readonly [keyof WorkflowChangeSet, keyof WorkflowAcceptedChangeReceipt]
  > = [
    ["executionId", "executionId"],
    ["taskId", "taskId"],
    ["planRevision", "planRevision"],
    ["workspaceRevision", "workspaceRevision"],
    ["baseRevision", "baseRevision"],
    ["changeSetDigest", "changeSetDigest"],
  ];
  for (const [changeSetKey, receiptKey] of comparisons) {
    if (changeSet[changeSetKey] !== receipt[receiptKey]) {
      throw new WorkflowChangeMismatchError(
        "CHANGE_RECEIPT_MISMATCH",
        `Change receipt does not match ${String(changeSetKey)}`,
      );
    }
  }
}

export class WorkflowChangeMismatchError extends Error {
  readonly code:
    | "CHANGE_SET_DIGEST_MISMATCH"
    | "CHANGE_RECEIPT_MISMATCH"
    | "COMMIT_RESULT_MISMATCH";

  constructor(
    code:
      | "CHANGE_SET_DIGEST_MISMATCH"
      | "CHANGE_RECEIPT_MISMATCH"
      | "COMMIT_RESULT_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "WorkflowChangeMismatchError";
    this.code = code;
  }
}

function normalizeChangeSetInput(
  input: WorkflowChangeSetInput,
): WorkflowChangeSetInput {
  assertExactObject(input, CHANGE_SET_INPUT_KEYS, "change set");
  if (!Array.isArray(input.entries)) {
    throw new TypeError("Change set entries must be an array");
  }
  const entries = input.entries.map(normalizeChangeEntry);
  const seen = new Set<string>();
  for (const entry of entries) {
    const affected =
      entry.kind === "renamed" ? [entry.fromPath, entry.toPath] : [entry.path];
    for (const path of affected) {
      if (seen.has(path)) {
        throw new TypeError(`Change set contains an ambiguous path: ${path}`);
      }
      seen.add(path);
    }
  }
  entries.sort((left, right) =>
    changeEntryKey(left).localeCompare(changeEntryKey(right)),
  );
  return Object.freeze({
    executionId: requiredIdentity(input.executionId, "executionId"),
    taskId: requiredIdentity(input.taskId, "taskId"),
    planRevision: requiredPositiveInteger(input.planRevision, "planRevision"),
    workspaceRevision: requiredRevision(
      input.workspaceRevision,
      "workspaceRevision",
    ),
    baseRevision: requiredRevision(input.baseRevision, "baseRevision"),
    entries: Object.freeze(entries),
  });
}

function normalizeChangeEntry(
  input: WorkflowChangeEntry,
  index: number,
): WorkflowChangeEntry {
  if (!input || typeof input !== "object") {
    throw new TypeError(`Change set entry[${index}] must be an object`);
  }
  const entryKind = requiredEntryKind(input.entryKind);
  const contentDigest = requiredDigest(input.contentDigest, "contentDigest");
  if (input.kind === "renamed") {
    assertExactObject(input, RENAMED_ENTRY_KEYS, `change set entry[${index}]`);
    const fromPath = normalizePortablePath(input.fromPath);
    const toPath = normalizePortablePath(input.toPath);
    if (fromPath === toPath) {
      throw new TypeError("Renamed change paths must be different");
    }
    return Object.freeze({
      kind: "renamed",
      fromPath,
      toPath,
      entryKind,
      contentDigest,
    });
  }
  if (
    input.kind !== "added" &&
    input.kind !== "modified" &&
    input.kind !== "deleted"
  ) {
    throw new TypeError(`Unsupported change kind at entry[${index}]`);
  }
  assertExactObject(input, PATH_ENTRY_KEYS, `change set entry[${index}]`);
  return Object.freeze({
    kind: input.kind,
    path: normalizePortablePath(input.path),
    entryKind,
    contentDigest,
  });
}

function inspectionRequestFromReceipt(
  receipt: WorkflowAcceptedChangeReceipt,
): WorkflowChangeInspectionRequest {
  return Object.freeze({
    executionId: receipt.executionId,
    taskId: receipt.taskId,
    planRevision: receipt.planRevision,
    workspaceRevision: receipt.workspaceRevision,
    baseRevision: receipt.baseRevision,
  });
}

function normalizeCommitResult(
  input: WorkflowCommitResult,
  changeSet: WorkflowChangeSet,
  receipt: WorkflowAcceptedChangeReceipt,
): WorkflowCommitResult {
  assertExactObject(input, COMMIT_RESULT_KEYS, "commit result");
  const normalized = Object.freeze({
    commitId: requiredRevision(input.commitId, "commitId"),
    receiptId: requiredIdentity(input.receiptId, "receiptId"),
    changeSetDigest: requiredDigest(input.changeSetDigest, "changeSetDigest"),
    workspaceRevision: requiredRevision(
      input.workspaceRevision,
      "workspaceRevision",
    ),
    baseRevision: requiredRevision(input.baseRevision, "baseRevision"),
    committedAt: requiredNonNegativeInteger(input.committedAt, "committedAt"),
  });
  if (
    normalized.receiptId !== receipt.receiptId ||
    normalized.changeSetDigest !== changeSet.changeSetDigest ||
    normalized.workspaceRevision !== changeSet.workspaceRevision ||
    normalized.baseRevision !== changeSet.baseRevision
  ) {
    throw new WorkflowChangeMismatchError(
      "COMMIT_RESULT_MISMATCH",
      "Commit result does not match the accepted change receipt",
    );
  }
  return normalized;
}

function normalizeExpectedTarget(
  input: WorkflowExpectedTarget,
): WorkflowExpectedTarget {
  assertExactObject(input, EXPECTED_TARGET_KEYS, "expected target");
  return Object.freeze({
    targetId: requiredIdentity(input.targetId, "targetId"),
    revision: requiredRevision(input.revision, "target revision"),
  });
}

async function digestCanonicalJson(
  value: WorkflowChangeSetInput,
): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function changeEntryKey(entry: WorkflowChangeEntry): string {
  return entry.kind === "renamed"
    ? `${entry.fromPath}\0${entry.toPath}`
    : entry.path;
}

function normalizePortablePath(input: string): string {
  if (typeof input !== "string" || !input.trim() || input.includes("\0")) {
    throw new TypeError("Change paths must be non-empty portable strings");
  }
  const path = input.replaceAll("\\", "/");
  if (path.startsWith("/") || /^[A-Za-z]:\//u.test(path)) {
    throw new TypeError(`Change paths must be relative: ${input}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new TypeError(`Change paths must not traverse parents: ${input}`);
  }
  const normalized = segments
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
  if (!normalized) {
    throw new TypeError("Change paths must identify a workspace entry");
  }
  return normalized;
}

function requiredEntryKind(value: unknown): WorkflowChangeEntryKind {
  if (
    value !== "file" &&
    value !== "directory" &&
    value !== "symlink" &&
    value !== "submodule"
  ) {
    throw new TypeError("Invalid change entryKind");
  }
  return value;
}

const SAFE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,255}$/u;
const SAFE_REVISION = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,511}$/u;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;

function requiredIdentity(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_IDENTITY.test(value)) {
    throw new TypeError(`${field} must be a safe identity`);
  }
  return value;
}

function requiredRevision(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_REVISION.test(value)) {
    throw new TypeError(`${field} must be an immutable revision identity`);
  }
  return value;
}

function requiredDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
    throw new TypeError(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requiredNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value as number;
}

function requiredNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function assertExactObject(
  input: unknown,
  expectedKeys: readonly string[],
  field: string,
): asserts input is Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`${field} must be a plain JSON object`);
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${field} must be a plain JSON object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Object.keys(descriptors).sort();
  const expected = [...expectedKeys].sort();
  if (
    Reflect.ownKeys(input).some((key) => typeof key === "symbol") ||
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    keys.some((key) => {
      const descriptor = descriptors[key];
      return !descriptor?.enumerable || !("value" in descriptor);
    })
  ) {
    throw new TypeError(`${field} contains unknown or non-JSON properties`);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new Error("Workflow change operation aborted");
}

const CHANGE_SET_INPUT_KEYS = [
  "executionId",
  "taskId",
  "planRevision",
  "workspaceRevision",
  "baseRevision",
  "entries",
] as const;
const CHANGE_SET_KEYS = [...CHANGE_SET_INPUT_KEYS, "changeSetDigest"] as const;
const PATH_ENTRY_KEYS = ["kind", "path", "entryKind", "contentDigest"] as const;
const RENAMED_ENTRY_KEYS = [
  "kind",
  "fromPath",
  "toPath",
  "entryKind",
  "contentDigest",
] as const;
const OWNERSHIP_FENCE_KEYS = ["grantId", "fencingToken"] as const;
const EXPECTED_TARGET_KEYS = ["targetId", "revision"] as const;
const RECEIPT_KEYS = [
  "receiptId",
  "verdict",
  "executionId",
  "taskId",
  "planRevision",
  "workspaceRevision",
  "baseRevision",
  "changeSetDigest",
  "ownership",
  "issuedAt",
  "expectedTarget",
] as const;
const COMMIT_RESULT_KEYS = [
  "commitId",
  "receiptId",
  "changeSetDigest",
  "workspaceRevision",
  "baseRevision",
  "committedAt",
] as const;
