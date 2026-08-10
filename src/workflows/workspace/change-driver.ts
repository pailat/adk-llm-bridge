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

/** Optional for legacy adapters; Git inspectors must always provide one. */
export type WorkflowChangeEntryMode =
  | "040000"
  | "100644"
  | "100755"
  | "120000"
  | "160000";

interface WorkflowChangeEntryBase {
  entryKind: WorkflowChangeEntryKind;
  /** Exact portable entry mode when the host filesystem exposes one. */
  mode?: WorkflowChangeEntryMode;
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
  /** @deprecated Required by authoritative publication APIs. */
  agentId?: string;
  /** @deprecated Required by authoritative publication APIs. */
  orchestrationRevision?: number;
}

/** Receipt shape required at every live mutation boundary. */
export interface WorkflowAuthoritativeChangeReceipt
  extends WorkflowAcceptedChangeReceipt {
  agentId: string;
  orchestrationRevision: number;
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
  /** Required at runtime. Optional only while legacy callers migrate. */
  operationId?: string;
}

/** Input visible to a host commit implementation after reinspection. */
export interface WorkflowCommitPreparationInput {
  changeSet: WorkflowChangeSet;
  receipt: WorkflowAuthoritativeChangeReceipt;
  message: string;
  operationId: string;
}

/** JSON evidence for a host-prepared tree; host temp handles stay internal. */
export interface WorkflowCommitPreparation {
  preparationId: string;
  treeId: string;
}

export interface WorkflowCommitDriverInput
  extends WorkflowCommitPreparationInput {
  intentDigest: string;
  preparation: WorkflowCommitPreparation;
}

export interface WorkflowCommitResult {
  commitId: string;
  receiptId: string;
  changeSetDigest: string;
  /** Required at runtime. Optional only while legacy drivers migrate. */
  treeId?: string;
  workspaceRevision: string;
  baseRevision: string;
  committedAt: number;
}

export interface WorkflowAuthoritativeCommitResult
  extends WorkflowCommitResult {
  treeId: string;
}

/** Mutation port. Call through WorkflowValidatedCommitter. */
export interface WorkflowCommitDriver<HostWorkspace = unknown> {
  /** Required at runtime; optional only while legacy host drivers migrate. */
  prepareCommit?(
    workspace: HostWorkspace,
    input: WorkflowCommitPreparationInput,
    options?: WorkflowChangeOperationOptions,
  ): Promise<WorkflowCommitPreparation>;
  commit(
    workspace: HostWorkspace,
    input: WorkflowCommitDriverInput,
    options?: WorkflowChangeOperationOptions,
  ): Promise<WorkflowCommitResult>;
  discardPreparation?(
    workspace: HostWorkspace,
    preparation: WorkflowCommitPreparation,
    options?: WorkflowChangeOperationOptions,
  ): Promise<void>;
}

export interface WorkflowIntegrationRequest {
  executionId: string;
  taskId: string;
  commitId: string;
  receiptId: string;
  changeSetDigest: string;
  expectedTarget: WorkflowExpectedTarget;
  /** Required by authoritative integration callers. */
  operationId?: string;
  /** Full validation evidence; scalar fields above are legacy projections. */
  receipt?: WorkflowAcceptedChangeReceipt;
  /** Full immutable commit evidence. */
  commit?: WorkflowCommitResult;
}

export interface WorkflowAuthoritativeIntegrationRequest
  extends WorkflowIntegrationRequest {
  operationId: string;
  receipt: WorkflowAuthoritativeChangeReceipt;
  commit: WorkflowAuthoritativeCommitResult;
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

/** Enforces full evidence and live authority around host integration. */
export class WorkflowValidatedIntegrator<HostRepository = unknown> {
  readonly #driver: WorkflowIntegrationDriver<HostRepository>;
  readonly #authority: WorkflowChangeReceiptAuthority;

  constructor(
    driver: WorkflowIntegrationDriver<HostRepository>,
    authority: WorkflowChangeReceiptAuthority,
  ) {
    if (!authority) {
      throw new TypeError("Workflow integration requires receipt authority");
    }
    this.#driver = driver;
    this.#authority = authority;
  }

  async integrate(
    repository: HostRepository,
    request: WorkflowIntegrationRequest,
    options: WorkflowChangeOperationOptions = {},
  ): Promise<WorkflowIntegrationResult> {
    throwIfAborted(options.signal);
    const normalized = normalizeAuthoritativeIntegrationRequest(request);
    const intentDigest = await digestCanonicalJson({
      operationId: normalized.operationId,
      receiptId: normalized.receipt.receiptId,
      commitId: normalized.commit.commitId,
      treeId: normalized.commit.treeId,
      expectedTarget: normalized.expectedTarget,
    });
    const lease = await this.#authority.acquireIntegration(
      Object.freeze({
        operationId: normalized.operationId,
        intentDigest,
        receipt: normalized.receipt,
        commit: normalized.commit,
        expectedTarget: normalized.expectedTarget,
      }),
      options,
    );
    assertAuthorityLease(lease, normalized.operationId, intentDigest);
    try {
      throwIfAborted(options.signal);
      const result = await this.#driver.integrate(
        repository,
        normalized,
        options,
      );
      const verified = normalizeIntegrationResult(result, normalized);
      // Once the host mutation has returned, cancellation can no longer make
      // it safe to pretend that integration did not happen. Persist its
      // verified outcome and clean up the lease without the caller's signal.
      await this.#authority.completeIntegration(lease, verified);
      return verified;
    } finally {
      await this.#authority.release(lease);
    }
  }
}

export const WORKFLOW_CHANGE_AUTHORITY_LEASE = Symbol(
  "WorkflowChangeAuthorityLease",
);

/** Opaque host-only authority capability. Symbols are not JSON-serializable. */
export interface WorkflowChangeAuthorityLease {
  readonly [WORKFLOW_CHANGE_AUTHORITY_LEASE]: true;
  readonly leaseId: string;
  readonly reservationId: string;
  readonly operationId: string;
  readonly intentDigest: string;
}

export interface WorkflowCommitAuthorityRequest {
  operationId: string;
  intentDigest: string;
  receipt: WorkflowAuthoritativeChangeReceipt;
  changeSet: WorkflowChangeSet;
  treeId: string;
}

export interface WorkflowIntegrationAuthorityRequest {
  operationId: string;
  intentDigest: string;
  receipt: WorkflowAuthoritativeChangeReceipt;
  commit: WorkflowAuthoritativeCommitResult;
  expectedTarget: WorkflowExpectedTarget;
}

export interface WorkflowMutationReconcileRequest {
  kind: "commit" | "integration";
  operationId: string;
  intentDigest: string;
}

export interface WorkflowMutationReconcileResult {
  status: "pending" | "completed" | "ambiguous" | "absent";
}

/**
 * Trusted host authority. Implementations must validate the receipt against
 * live orchestration state while acquiring each mutation lease.
 */
export interface WorkflowChangeReceiptAuthority {
  acquireCommit(
    request: WorkflowCommitAuthorityRequest,
    options?: WorkflowChangeOperationOptions,
  ): Promise<WorkflowChangeAuthorityLease>;
  completeCommit(
    lease: WorkflowChangeAuthorityLease,
    result: WorkflowAuthoritativeCommitResult,
    options?: WorkflowChangeOperationOptions,
  ): Promise<void>;
  /** Explicitly releases a completed commit handoff that will not integrate. */
  abandonCommit?(
    lease: WorkflowChangeAuthorityLease,
    options?: WorkflowChangeOperationOptions,
  ): Promise<void>;
  acquireIntegration(
    request: WorkflowIntegrationAuthorityRequest,
    options?: WorkflowChangeOperationOptions,
  ): Promise<WorkflowChangeAuthorityLease>;
  completeIntegration(
    lease: WorkflowChangeAuthorityLease,
    result: WorkflowIntegrationResult,
    options?: WorkflowChangeOperationOptions,
  ): Promise<void>;
  release(
    lease: WorkflowChangeAuthorityLease,
    options?: WorkflowChangeOperationOptions,
  ): Promise<void>;
  reconcile(
    request: WorkflowMutationReconcileRequest,
    options?: WorkflowChangeOperationOptions,
  ): Promise<WorkflowMutationReconcileResult>;
}

/**
 * Enforces the anti-TOCTOU boundary before a host commit can run.
 * The inspector is invoked for every commit, even when the receipt is fresh.
 */
export class WorkflowValidatedCommitter<HostWorkspace = unknown> {
  readonly #inspector: WorkflowChangeInspector<HostWorkspace>;
  readonly #driver: WorkflowCommitDriver<HostWorkspace>;
  readonly #authority?: WorkflowChangeReceiptAuthority;

  constructor(
    inspector: WorkflowChangeInspector<HostWorkspace>,
    driver: WorkflowCommitDriver<HostWorkspace>,
    authority?: WorkflowChangeReceiptAuthority,
  ) {
    this.#inspector = inspector;
    this.#driver = driver;
    this.#authority = authority;
  }

  async commit(
    workspace: HostWorkspace,
    request: WorkflowCommitRequest,
    options: WorkflowChangeOperationOptions = {},
  ): Promise<WorkflowAuthoritativeCommitResult> {
    throwIfAborted(options.signal);
    if (!this.#authority) {
      throw new WorkflowChangeAuthorityError(
        "WORKFLOW_CHANGE_AUTHORITY_REQUIRED",
        "Workflow commits require a live change receipt authority",
      );
    }
    const operationId = requiredIdentity(request.operationId, "operationId");
    const receipt = normalizeAuthoritativeChangeReceipt(request.receipt);
    const message = requiredNonEmptyString(request.message, "commit message");
    const changeSet = await this.#inspector.inspect(
      workspace,
      inspectionRequestFromReceipt(receipt),
      options,
    );
    throwIfAborted(options.signal);
    const verified = await verifyWorkflowChangeSet(changeSet);
    assertChangeSetMatchesReceipt(verified, receipt);
    if (!this.#driver.prepareCommit) {
      throw new WorkflowChangeAuthorityError(
        "WORKFLOW_CHANGE_AUTHORITY_REQUIRED",
        "Workflow commit driver must prepare an immutable tree before reservation",
      );
    }
    const preparation = normalizeCommitPreparation(
      await this.#driver.prepareCommit(
        workspace,
        Object.freeze({
          changeSet: verified,
          receipt,
          message,
          operationId,
        }),
        options,
      ),
    );
    try {
      const intentDigest = await digestCanonicalJson({
        operationId,
        receiptId: receipt.receiptId,
        changeSetDigest: verified.changeSetDigest,
        treeId: preparation.treeId,
        message,
      });
      const lease = await this.#authority.acquireCommit(
        Object.freeze({
          operationId,
          intentDigest,
          receipt,
          changeSet: verified,
          treeId: preparation.treeId,
        }),
        options,
      );
      assertAuthorityLease(lease, operationId, intentDigest);
      try {
        throwIfAborted(options.signal);
        const result = await this.#driver.commit(
          workspace,
          Object.freeze({
            changeSet: verified,
            receipt,
            message,
            operationId,
            intentDigest,
            preparation,
          }),
          options,
        );
        const normalized = normalizeCommitResult(
          result,
          verified,
          receipt,
          preparation,
        );
        // A returned commit is authoritative evidence even when the caller
        // aborted while the host was mutating. Completion and cleanup must be
        // uncancellable so the durable journal cannot be left ambiguous.
        await this.#authority.completeCommit(lease, normalized);
        return normalized;
      } finally {
        await this.#authority.release(lease);
      }
    } finally {
      await this.#driver.discardPreparation?.(workspace, preparation);
    }
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
  const hasAuthorityFields =
    input.agentId !== undefined || input.orchestrationRevision !== undefined;
  assertExactObject(
    input,
    hasAuthorityFields ? AUTHORITATIVE_RECEIPT_KEYS : RECEIPT_KEYS,
    "accepted change receipt",
  );
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
  const normalized: WorkflowAcceptedChangeReceipt = {
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
  };
  if (hasAuthorityFields) {
    normalized.agentId = requiredIdentity(input.agentId, "agentId");
    normalized.orchestrationRevision = requiredPositiveInteger(
      input.orchestrationRevision,
      "orchestrationRevision",
    );
  }
  return Object.freeze(normalized);
}

export function normalizeAuthoritativeChangeReceipt(
  input: WorkflowAcceptedChangeReceipt,
): WorkflowAuthoritativeChangeReceipt {
  const normalized = normalizeAcceptedChangeReceipt(input);
  if (
    normalized.agentId === undefined ||
    normalized.orchestrationRevision === undefined
  ) {
    throw new WorkflowChangeAuthorityError(
      "WORKFLOW_CHANGE_AUTHORITY_REQUIRED",
      "Authoritative change receipt requires agentId and orchestrationRevision",
    );
  }
  return normalized as WorkflowAuthoritativeChangeReceipt;
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
    | "COMMIT_RESULT_MISMATCH"
    | "INTEGRATION_REQUEST_MISMATCH"
    | "INTEGRATION_RESULT_MISMATCH";

  constructor(
    code:
      | "CHANGE_SET_DIGEST_MISMATCH"
      | "CHANGE_RECEIPT_MISMATCH"
      | "COMMIT_RESULT_MISMATCH"
      | "INTEGRATION_REQUEST_MISMATCH"
      | "INTEGRATION_RESULT_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "WorkflowChangeMismatchError";
    this.code = code;
  }
}

export class WorkflowChangeAuthorityError extends Error {
  readonly code:
    | "WORKFLOW_CHANGE_AUTHORITY_REQUIRED"
    | "WORKFLOW_CHANGE_AUTHORITY_INVALID";

  constructor(
    code:
      | "WORKFLOW_CHANGE_AUTHORITY_REQUIRED"
      | "WORKFLOW_CHANGE_AUTHORITY_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "WorkflowChangeAuthorityError";
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
  const mode = normalizeEntryMode(input.mode, entryKind);
  const contentDigest = requiredDigest(input.contentDigest, "contentDigest");
  if (input.kind === "renamed") {
    assertExactObject(
      input,
      mode === undefined ? RENAMED_ENTRY_KEYS : RENAMED_ENTRY_MODE_KEYS,
      `change set entry[${index}]`,
    );
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
      ...(mode === undefined ? {} : { mode }),
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
  assertExactObject(
    input,
    mode === undefined ? PATH_ENTRY_KEYS : PATH_ENTRY_MODE_KEYS,
    `change set entry[${index}]`,
  );
  return Object.freeze({
    kind: input.kind,
    path: normalizePortablePath(input.path),
    entryKind,
    ...(mode === undefined ? {} : { mode }),
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
  receipt: WorkflowAuthoritativeChangeReceipt,
  preparation: WorkflowCommitPreparation,
): WorkflowAuthoritativeCommitResult {
  const normalized = normalizeCommitEvidence(input, receipt);
  if (
    normalized.receiptId !== receipt.receiptId ||
    normalized.changeSetDigest !== changeSet.changeSetDigest ||
    normalized.workspaceRevision !== changeSet.workspaceRevision ||
    normalized.baseRevision !== changeSet.baseRevision ||
    normalized.treeId !== preparation.treeId
  ) {
    throw new WorkflowChangeMismatchError(
      "COMMIT_RESULT_MISMATCH",
      "Commit result does not match the accepted change receipt",
    );
  }
  return normalized;
}

function normalizeCommitPreparation(
  input: WorkflowCommitPreparation,
): WorkflowCommitPreparation {
  assertExactObject(input, COMMIT_PREPARATION_KEYS, "commit preparation");
  return Object.freeze({
    preparationId: requiredIdentity(input.preparationId, "preparationId"),
    treeId: requiredRevision(input.treeId, "treeId"),
  });
}

function normalizeCommitEvidence(
  input: WorkflowCommitResult,
  receipt: WorkflowAuthoritativeChangeReceipt,
): WorkflowAuthoritativeCommitResult {
  assertExactObject(input, AUTHORITATIVE_COMMIT_RESULT_KEYS, "commit result");
  const normalized = Object.freeze({
    commitId: requiredRevision(input.commitId, "commitId"),
    treeId: requiredRevision(input.treeId, "treeId"),
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
    normalized.changeSetDigest !== receipt.changeSetDigest ||
    normalized.workspaceRevision !== receipt.workspaceRevision ||
    normalized.baseRevision !== receipt.baseRevision
  ) {
    throw new WorkflowChangeMismatchError(
      "COMMIT_RESULT_MISMATCH",
      "Commit evidence does not match the accepted change receipt",
    );
  }
  return normalized;
}

export function normalizeAuthoritativeIntegrationRequest(
  input: WorkflowIntegrationRequest,
): WorkflowAuthoritativeIntegrationRequest {
  assertExactObject(
    input,
    AUTHORITATIVE_INTEGRATION_REQUEST_KEYS,
    "integration request",
  );
  const receipt = normalizeAuthoritativeChangeReceipt(
    input.receipt as WorkflowAcceptedChangeReceipt,
  );
  const commit = normalizeCommitEvidence(
    input.commit as WorkflowCommitResult,
    receipt,
  );
  const expectedTarget = normalizeExpectedTarget(input.expectedTarget);
  const normalized = Object.freeze({
    executionId: requiredIdentity(input.executionId, "executionId"),
    taskId: requiredIdentity(input.taskId, "taskId"),
    commitId: requiredRevision(input.commitId, "commitId"),
    receiptId: requiredIdentity(input.receiptId, "receiptId"),
    changeSetDigest: requiredDigest(input.changeSetDigest, "changeSetDigest"),
    expectedTarget,
    operationId: requiredIdentity(input.operationId, "operationId"),
    receipt,
    commit,
  });
  if (
    normalized.executionId !== receipt.executionId ||
    normalized.taskId !== receipt.taskId ||
    normalized.commitId !== commit.commitId ||
    normalized.receiptId !== receipt.receiptId ||
    normalized.changeSetDigest !== receipt.changeSetDigest ||
    normalized.expectedTarget.targetId !== receipt.expectedTarget.targetId ||
    normalized.expectedTarget.revision !== receipt.expectedTarget.revision
  ) {
    throw new WorkflowChangeMismatchError(
      "INTEGRATION_REQUEST_MISMATCH",
      "Integration request evidence is not linked to one immutable publication",
    );
  }
  return normalized;
}

function normalizeIntegrationResult(
  input: WorkflowIntegrationResult,
  request: WorkflowAuthoritativeIntegrationRequest,
): WorkflowIntegrationResult {
  assertExactObject(input, INTEGRATION_RESULT_KEYS, "integration result");
  const normalized = Object.freeze({
    integrationId: requiredIdentity(input.integrationId, "integrationId"),
    commitId: requiredRevision(input.commitId, "commitId"),
    targetId: requiredIdentity(input.targetId, "targetId"),
    previousRevision: requiredRevision(
      input.previousRevision,
      "previousRevision",
    ),
    integratedRevision: requiredRevision(
      input.integratedRevision,
      "integratedRevision",
    ),
    integratedAt: requiredNonNegativeInteger(
      input.integratedAt,
      "integratedAt",
    ),
  });
  if (
    normalized.commitId !== request.commit.commitId ||
    normalized.targetId !== request.expectedTarget.targetId ||
    normalized.previousRevision !== request.expectedTarget.revision
  ) {
    throw new WorkflowChangeMismatchError(
      "INTEGRATION_RESULT_MISMATCH",
      "Integration result does not match commit or target evidence",
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

async function digestCanonicalJson(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function assertAuthorityLease(
  lease: WorkflowChangeAuthorityLease,
  operationId: string,
  intentDigest: string,
): void {
  if (
    !lease ||
    typeof lease !== "object" ||
    lease[WORKFLOW_CHANGE_AUTHORITY_LEASE] !== true ||
    requiredIdentity(lease.leaseId, "authority leaseId") !== lease.leaseId ||
    requiredIdentity(lease.reservationId, "reservationId") !==
      lease.reservationId ||
    lease.operationId !== operationId ||
    lease.intentDigest !== intentDigest
  ) {
    throw new WorkflowChangeAuthorityError(
      "WORKFLOW_CHANGE_AUTHORITY_INVALID",
      "Change receipt authority returned an invalid mutation lease",
    );
  }
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
  if (input.includes("\\")) {
    throw new TypeError("Change paths must use forward slashes");
  }
  const path = input;
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

function normalizeEntryMode(
  value: unknown,
  entryKind: WorkflowChangeEntryKind,
): WorkflowChangeEntryMode | undefined {
  if (value === undefined) return undefined;
  const allowed: Record<
    WorkflowChangeEntryKind,
    readonly WorkflowChangeEntryMode[]
  > = {
    file: ["100644", "100755"],
    directory: ["040000"],
    symlink: ["120000"],
    submodule: ["160000"],
  };
  if (!allowed[entryKind].includes(value as WorkflowChangeEntryMode)) {
    throw new TypeError(`Entry mode does not match ${entryKind}`);
  }
  return value as WorkflowChangeEntryMode;
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
const PATH_ENTRY_MODE_KEYS = [...PATH_ENTRY_KEYS, "mode"] as const;
const RENAMED_ENTRY_KEYS = [
  "kind",
  "fromPath",
  "toPath",
  "entryKind",
  "contentDigest",
] as const;
const RENAMED_ENTRY_MODE_KEYS = [...RENAMED_ENTRY_KEYS, "mode"] as const;
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
const AUTHORITATIVE_RECEIPT_KEYS = [
  ...RECEIPT_KEYS,
  "agentId",
  "orchestrationRevision",
] as const;
const COMMIT_RESULT_KEYS = [
  "commitId",
  "receiptId",
  "changeSetDigest",
  "workspaceRevision",
  "baseRevision",
  "committedAt",
] as const;
const AUTHORITATIVE_COMMIT_RESULT_KEYS = [
  ...COMMIT_RESULT_KEYS,
  "treeId",
] as const;
const COMMIT_PREPARATION_KEYS = ["preparationId", "treeId"] as const;
const AUTHORITATIVE_INTEGRATION_REQUEST_KEYS = [
  "executionId",
  "taskId",
  "commitId",
  "receiptId",
  "changeSetDigest",
  "expectedTarget",
  "operationId",
  "receipt",
  "commit",
] as const;
const INTEGRATION_RESULT_KEYS = [
  "integrationId",
  "commitId",
  "targetId",
  "previousRevision",
  "integratedRevision",
  "integratedAt",
] as const;
