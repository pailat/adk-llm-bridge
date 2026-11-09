import { throwIfAborted } from "../internal/abort.js";
import { canonicalDigest, legacyDigest } from "../internal/canonical-hash.js";
import {
  isWorkflowIdentifier,
  type WorkflowIdentifierGrammar,
} from "../internal/identifiers.js";
import { workflowIntegrationIntentDigest } from "../internal/integration-intent.js";
import {
  normalizePortablePath,
  portablePathProblem,
} from "../internal/portable-path.js";

/** Kind of filesystem entry a change refers to. */
export type WorkflowChangeEntryKind =
  | "file"
  | "directory"
  | "symlink"
  | "submodule";

/**
 * Portable Git-style entry mode.
 *
 * @remarks
 * Optional for legacy adapters; Git inspectors must always provide one.
 */
export type WorkflowChangeEntryMode =
  | "040000"
  | "100644"
  | "100755"
  | "120000"
  | "160000";

interface WorkflowChangeEntryBase {
  /** Kind of entry the change applies to. */
  entryKind: WorkflowChangeEntryKind;
  /** Exact portable entry mode when the host filesystem exposes one. */
  mode?: WorkflowChangeEntryMode;
  /** Digest of the entry at the side of the change being proposed. */
  contentDigest: string;
}

/** A path that exists in the proposed tree but not in the base. */
export interface WorkflowAddedChange extends WorkflowChangeEntryBase {
  /** Discriminant. */
  kind: "added";
  /** Relative portable path of the entry. */
  path: string;
}

/** A path whose content or mode differs from the base. */
export interface WorkflowModifiedChange extends WorkflowChangeEntryBase {
  /** Discriminant. */
  kind: "modified";
  /** Relative portable path of the entry. */
  path: string;
}

/** A path removed from the base. */
export interface WorkflowDeletedChange extends WorkflowChangeEntryBase {
  /** Discriminant. */
  kind: "deleted";
  /** Relative portable path of the entry. */
  path: string;
}

/** A path moved from `fromPath` to `toPath`. */
export interface WorkflowRenamedChange extends WorkflowChangeEntryBase {
  /** Discriminant. */
  kind: "renamed";
  /** Original relative path. */
  fromPath: string;
  /** New relative path; must differ from `fromPath`. */
  toPath: string;
}

/** One entry of a change set. */
export type WorkflowChangeEntry =
  | WorkflowAddedChange
  | WorkflowModifiedChange
  | WorkflowDeletedChange
  | WorkflowRenamedChange;

/** Identity, revisions and entries of a change set, before it is digested. */
export interface WorkflowChangeSetInput {
  /** Workflow execution that produced the changes. */
  executionId: string;
  /** Task that produced the changes. */
  taskId: string;
  /** Orchestration plan revision the task ran under. */
  planRevision: number;
  /** Immutable revision identity of the inspected workspace. */
  workspaceRevision: string;
  /** Revision the changes are relative to. */
  baseRevision: string;
  /** Changed entries; sorted and checked for ambiguous paths on creation. */
  entries: readonly WorkflowChangeEntry[];
}

/** JSON-only snapshot returned by a read-only workspace inspection. */
export interface WorkflowChangeSet extends WorkflowChangeSetInput {
  /** SHA-256 digest of the canonical contents, as `sha256:<hex>`. */
  changeSetDigest: string;
}

/** Fencing token of one ownership grant that covered the change. */
export interface WorkflowOwnershipFence {
  /** Identifier of the workspace grant. */
  grantId: string;
  /** Positive fencing token issued with the grant. */
  fencingToken: number;
}

/** Publication target and the revision it must still be at. */
export interface WorkflowExpectedTarget {
  /** Identifier of the publication target, such as a branch. */
  targetId: string;
  /** Immutable revision the target is expected to point at. */
  revision: string;
}

/**
 * Immutable evidence that a particular inspected snapshot was accepted.
 * It is deliberately JSON-only; host workspace handles never belong here.
 */
export interface WorkflowAcceptedChangeReceipt {
  /** Unique receipt identifier. */
  receiptId: string;
  /** Always `accepted`. */
  verdict: "accepted";
  /** Workflow execution the receipt belongs to. */
  executionId: string;
  /** Task the receipt belongs to. */
  taskId: string;
  /** Orchestration plan revision at acceptance. */
  planRevision: number;
  /** Workspace revision that was inspected. */
  workspaceRevision: string;
  /** Base revision of the change set. */
  baseRevision: string;
  /** Digest of the accepted change set. */
  changeSetDigest: string;
  /** Ownership fencing evidence; at least one grant is required. */
  ownership: readonly WorkflowOwnershipFence[];
  /** Issue time in epoch milliseconds. */
  issuedAt: number;
  /** Target revision the change may be integrated onto. */
  expectedTarget: WorkflowExpectedTarget;
  /** @deprecated Required by authoritative publication APIs. */
  agentId?: string;
  /** @deprecated Required by authoritative publication APIs. */
  orchestrationRevision?: number;
}

/** Receipt shape required at every live mutation boundary. */
export interface WorkflowAuthoritativeChangeReceipt
  extends WorkflowAcceptedChangeReceipt {
  /** Agent that owned the task. */
  agentId: string;
  /** Orchestration revision validated against live state. */
  orchestrationRevision: number;
}

/** What a host inspector must inspect: one task's workspace at a revision. */
export interface WorkflowChangeInspectionRequest {
  /** Workflow execution. */
  executionId: string;
  /** Task whose workspace is inspected. */
  taskId: string;
  /** Plan revision the change set must carry. */
  planRevision: number;
  /** Workspace revision to inspect. */
  workspaceRevision: string;
  /** Revision to diff against. */
  baseRevision: string;
}

/** Options shared by change inspection, commit and integration ports. */
export interface WorkflowChangeOperationOptions {
  /** Aborts the operation before the host mutation starts. */
  signal?: AbortSignal;
}

/** Read-only host port. Implementations must not mutate the workspace. */
export interface WorkflowChangeInspector<HostWorkspace = unknown> {
  /**
   * Reads the workspace and returns its change set without mutating it.
   *
   * @param workspace - Host workspace handle.
   * @param request - Revisions to inspect.
   * @param options - Optional abort signal.
   * @returns The change set with its digest.
   */
  inspect(
    workspace: HostWorkspace,
    request: WorkflowChangeInspectionRequest,
    options?: WorkflowChangeOperationOptions,
  ): Promise<WorkflowChangeSet>;
}

/** Request to commit an accepted change set. */
export interface WorkflowCommitRequest {
  /** Receipt proving the change set was accepted. */
  receipt: WorkflowAcceptedChangeReceipt;
  /** Commit message; must be non-empty. */
  message: string;
  /** Required at runtime. Optional only while legacy callers migrate. */
  operationId?: string;
}

/** Input visible to a host commit implementation after reinspection. */
export interface WorkflowCommitPreparationInput {
  /** Freshly inspected and verified change set. */
  changeSet: WorkflowChangeSet;
  /** Normalized receipt that matches the change set. */
  receipt: WorkflowAuthoritativeChangeReceipt;
  /** Commit message. */
  message: string;
  /** Idempotency key of the commit operation. */
  operationId: string;
}

/** JSON evidence for a host-prepared tree; host temp handles stay internal. */
/** Immutable tree the host built for a commit. */
export interface WorkflowCommitPreparation {
  /** Identifier of the host-side preparation, used to discard it. */
  preparationId: string;
  /** Immutable identity of the prepared tree. */
  treeId: string;
}

/** Input passed to {@link WorkflowCommitDriver.commit}. */
export interface WorkflowCommitDriverInput
  extends WorkflowCommitPreparationInput {
  /** Digest of the reserved commit intent. */
  intentDigest: string;
  /** Tree prepared for this commit. */
  preparation: WorkflowCommitPreparation;
}

/** Evidence returned by a host after it created a commit. */
export interface WorkflowCommitResult {
  /** Immutable commit identity. */
  commitId: string;
  /** Receipt the commit was made under. */
  receiptId: string;
  /** Digest of the committed change set. */
  changeSetDigest: string;
  /** Required at runtime. Optional only while legacy drivers migrate. */
  treeId?: string;
  /** Workspace revision that was committed. */
  workspaceRevision: string;
  /** Base revision of the commit. */
  baseRevision: string;
  /** Commit time in epoch milliseconds. */
  committedAt: number;
}

/** Commit result whose tree identity is present. */
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
  /**
   * Creates the commit from the prepared tree.
   *
   * @param workspace - Host workspace handle.
   * @param input - Verified change set, receipt and preparation.
   * @param options - Optional abort signal.
   * @returns Commit evidence, validated by the caller.
   */
  commit(
    workspace: HostWorkspace,
    input: WorkflowCommitDriverInput,
    options?: WorkflowChangeOperationOptions,
  ): Promise<WorkflowCommitResult>;
  /**
   * Releases host resources of a preparation, called after commit or failure.
   */
  discardPreparation?(
    workspace: HostWorkspace,
    preparation: WorkflowCommitPreparation,
    options?: WorkflowChangeOperationOptions,
  ): Promise<void>;
}

/** Request to integrate a commit into its publication target. */
export interface WorkflowIntegrationRequest {
  /** Workflow execution. */
  executionId: string;
  /** Task that produced the commit. */
  taskId: string;
  /** Commit to integrate. */
  commitId: string;
  /** Receipt the commit was made under. */
  receiptId: string;
  /** Digest of the committed change set. */
  changeSetDigest: string;
  /** Target and revision the integration must start from. */
  expectedTarget: WorkflowExpectedTarget;
  /** Required by authoritative integration callers. */
  operationId?: string;
  /** Full validation evidence; scalar fields above are legacy projections. */
  receipt?: WorkflowAcceptedChangeReceipt;
  /** Full immutable commit evidence. */
  commit?: WorkflowCommitResult;
}

/** Integration request carrying all evidence required at runtime. */
export interface WorkflowAuthoritativeIntegrationRequest
  extends WorkflowIntegrationRequest {
  operationId: string;
  receipt: WorkflowAuthoritativeChangeReceipt;
  commit: WorkflowAuthoritativeCommitResult;
}

/** Evidence returned by a host after integrating a commit. */
export interface WorkflowIntegrationResult {
  /** Identifier of the integration. */
  integrationId: string;
  /** Commit that was integrated. */
  commitId: string;
  /** Target that moved. */
  targetId: string;
  /** Target revision before the integration. */
  previousRevision: string;
  /** Target revision after the integration. */
  integratedRevision: string;
  /** Integration time in epoch milliseconds. */
  integratedAt: number;
}

/**
 * Explicit host mutation port. Implementations must atomically compare
 * expectedTarget.revision and integrate exactly commitId; no mutable branch
 * name may be resolved after the comparison.
 */
export interface WorkflowIntegrationDriver<HostRepository = unknown> {
  /**
   * Integrates the commit into the target.
   *
   * @param repository - Host repository handle.
   * @param request - Commit and expected target.
   * @param options - Optional abort signal.
   * @returns Integration evidence, validated by the caller.
   */
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

  /**
   * @param driver - Host integration port.
   * @param authority - Authority that validates and records each integration.
   * @throws {@link TypeError} when `authority` is missing.
   */
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

  /**
   * Validates the request, integrates under an authority lease and verifies the result.
   *
   * @remarks
   * Completion and lease release run without the caller's signal: once the host
   * mutation returned, the outcome must be recorded.
   *
   * @param repository - Host repository handle.
   * @param request - Request with full receipt and commit evidence.
   * @param options - Optional abort signal, honored until the host call starts.
   * @returns The verified integration result.
   * @throws {@link WorkflowChangeMismatchError} when evidence or the result do not
   * link to one immutable publication.
   * @throws {@link WorkflowChangeAuthorityError} when the authority returns an
   * invalid lease.
   * @throws {@link TypeError} when the request is malformed.
   */
  async integrate(
    repository: HostRepository,
    request: WorkflowIntegrationRequest,
    options: WorkflowChangeOperationOptions = {},
  ): Promise<WorkflowIntegrationResult> {
    throwIfAborted(options.signal, ABORTED_MESSAGE);
    const normalized = normalizeAuthoritativeIntegrationRequest(request);
    const intentDigest = await workflowIntegrationIntentDigest(normalized);
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
      throwIfAborted(options.signal, ABORTED_MESSAGE);
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

/** Brand symbol identifying a {@link WorkflowChangeAuthorityLease}. */
export const WORKFLOW_CHANGE_AUTHORITY_LEASE = Symbol(
  "WorkflowChangeAuthorityLease",
);

/** Opaque host-only authority capability. Symbols are not JSON-serializable. */
export interface WorkflowChangeAuthorityLease {
  /** Brand marker. */
  readonly [WORKFLOW_CHANGE_AUTHORITY_LEASE]: true;
  /** Identifier of the lease. */
  readonly leaseId: string;
  /** Identifier of the durable reservation behind the lease. */
  readonly reservationId: string;
  /** Operation the lease was granted for. */
  readonly operationId: string;
  /** Digest of the intent the lease was granted for. */
  readonly intentDigest: string;
}

/** Request to reserve authority for one commit. */
export interface WorkflowCommitAuthorityRequest {
  /** Idempotency key of the commit. */
  operationId: string;
  /** Digest of the commit intent. */
  intentDigest: string;
  /** Receipt to validate against live orchestration state. */
  receipt: WorkflowAuthoritativeChangeReceipt;
  /** Verified change set being committed. */
  changeSet: WorkflowChangeSet;
  /** Identity of the prepared tree. */
  treeId: string;
}

/** Request to reserve authority for one integration. */
export interface WorkflowIntegrationAuthorityRequest {
  /** Idempotency key of the integration. */
  operationId: string;
  /** Digest of the integration intent. */
  intentDigest: string;
  /** Receipt to validate against live orchestration state. */
  receipt: WorkflowAuthoritativeChangeReceipt;
  /** Commit being integrated. */
  commit: WorkflowAuthoritativeCommitResult;
  /** Target revision the integration must start from. */
  expectedTarget: WorkflowExpectedTarget;
}

/** Asks the authority what happened to a journaled mutation. */
export interface WorkflowMutationReconcileRequest {
  /** Mutation kind. */
  kind: "commit" | "integration";
  /** Operation to reconcile. */
  operationId: string;
  /** Digest the operation was reserved with. */
  intentDigest: string;
}

/** Outcome of a reconcile request. */
export interface WorkflowMutationReconcileResult {
  /** State of the operation; `absent` means it was never reserved. */
  status: "pending" | "completed" | "ambiguous" | "absent";
}

/**
 * Trusted host authority. Implementations must validate the receipt against
 * live orchestration state while acquiring each mutation lease.
 */
export interface WorkflowChangeReceiptAuthority {
  /**
   * Reserves authority for a commit after validating the receipt against live state.
   *
   * @returns A lease that must be completed or released.
   */
  acquireCommit(
    request: WorkflowCommitAuthorityRequest,
    options?: WorkflowChangeOperationOptions,
  ): Promise<WorkflowChangeAuthorityLease>;
  /** Records the verified commit result under the lease. */
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
  /**
   * Reserves authority for an integration after validating the receipt.
   *
   * @returns A lease that must be completed and released.
   */
  acquireIntegration(
    request: WorkflowIntegrationAuthorityRequest,
    options?: WorkflowChangeOperationOptions,
  ): Promise<WorkflowChangeAuthorityLease>;
  /** Records the verified integration result under the lease. */
  completeIntegration(
    lease: WorkflowChangeAuthorityLease,
    result: WorkflowIntegrationResult,
    options?: WorkflowChangeOperationOptions,
  ): Promise<void>;
  /** Releases a lease; must be safe after completion. */
  release(
    lease: WorkflowChangeAuthorityLease,
    options?: WorkflowChangeOperationOptions,
  ): Promise<void>;
  /** Reports the state of a journaled mutation, for crash recovery. */
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

  /**
   * @param inspector - Read-only port that re-inspects the workspace.
   * @param driver - Host port that prepares and creates the commit.
   * @param authority - Live authority; without it every commit fails closed.
   */
  constructor(
    inspector: WorkflowChangeInspector<HostWorkspace>,
    driver: WorkflowCommitDriver<HostWorkspace>,
    authority?: WorkflowChangeReceiptAuthority,
  ) {
    this.#inspector = inspector;
    this.#driver = driver;
    this.#authority = authority;
  }

  /**
   * Re-inspects the workspace, reserves authority and creates the commit.
   *
   * @remarks
   * Fails closed: no authority, no `prepareCommit`, a receipt that does not match
   * the fresh inspection, or a result that does not match the receipt all abort
   * the commit. Completion and cleanup run without the caller's signal so a
   * commit that already happened is always recorded.
   *
   * @param workspace - Host workspace handle.
   * @param request - Accepted receipt, message and operation id.
   * @param options - Optional abort signal, honored until the host call starts.
   * @returns The verified commit result.
   * @throws {@link WorkflowChangeAuthorityError} when no authority is configured,
   * the driver cannot prepare, or the authority returns an invalid lease.
   * @throws {@link WorkflowChangeMismatchError} when the change set, receipt or
   * commit result disagree.
   * @throws {@link TypeError} when the request or any evidence is malformed.
   */
  async commit(
    workspace: HostWorkspace,
    request: WorkflowCommitRequest,
    options: WorkflowChangeOperationOptions = {},
  ): Promise<WorkflowAuthoritativeCommitResult> {
    throwIfAborted(options.signal, ABORTED_MESSAGE);
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
    throwIfAborted(options.signal, ABORTED_MESSAGE);
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
      const intentDigest = await canonicalDigest({
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
        throwIfAborted(options.signal, ABORTED_MESSAGE);
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
  const changeSetDigest = await canonicalDigest(normalized);
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
  if (
    declaredDigest !== (await canonicalDigest(normalized)) &&
    declaredDigest !== (await legacyChangeSetDigest(normalized))
  ) {
    throw new WorkflowChangeMismatchError(
      "CHANGE_SET_DIGEST_MISMATCH",
      "Change set digest does not match its canonical contents",
    );
  }
  return Object.freeze({ ...normalized, changeSetDigest: declaredDigest });
}

/**
 * Validates the exact shape of a receipt and returns a frozen copy.
 *
 * @param input - Receipt to validate.
 * @returns The frozen receipt.
 * @throws {@link TypeError} when keys, identities, digests or ownership fences
 * are invalid.
 */
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
    const grantId = requiredIdentity(fence.grantId, "grantId", "record");
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
    executionId: requiredIdentity(input.executionId, "executionId", "record"),
    taskId: requiredIdentity(input.taskId, "taskId", "record"),
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
    normalized.agentId = requiredIdentity(input.agentId, "agentId", "record");
    normalized.orchestrationRevision = requiredPositiveInteger(
      input.orchestrationRevision,
      "orchestrationRevision",
    );
  }
  return Object.freeze(normalized);
}

/**
 * Like {@link normalizeAcceptedChangeReceipt}, but requires `agentId` and `orchestrationRevision`.
 *
 * @param input - Receipt to validate.
 * @returns The frozen receipt with authority fields.
 * @throws {@link WorkflowChangeAuthorityError} with code
 * `WORKFLOW_CHANGE_AUTHORITY_REQUIRED` when the authority fields are missing.
 * @throws {@link TypeError} when the receipt is malformed.
 */
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

/**
 * Throws unless the change set and the receipt agree on identity, revisions and digest.
 *
 * @param changeSet - Verified change set.
 * @param receipt - Accepted receipt.
 * @throws {@link WorkflowChangeMismatchError} with code `CHANGE_RECEIPT_MISMATCH`.
 */
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

/**
 * Codes of {@link WorkflowChangeMismatchError}.
 *
 * @remarks
 * - `CHANGE_SET_DIGEST_MISMATCH`: a change set's declared digest does not
 *   match its entries.
 * - `CHANGE_RECEIPT_MISMATCH`: the change set (inspected or prepared) differs
 *   from the accepted receipt.
 * - `COMMIT_RESULT_MISMATCH`: a commit result is not linked to its receipt or
 *   preparation.
 * - `INTEGRATION_REQUEST_MISMATCH`: an integration request's scalar fields
 *   disagree with its receipt and commit evidence.
 * - `INTEGRATION_RESULT_MISMATCH`: an integration result is not linked to its
 *   request.
 */
export type WorkflowChangeMismatchErrorCode =
  | "CHANGE_SET_DIGEST_MISMATCH"
  | "CHANGE_RECEIPT_MISMATCH"
  | "COMMIT_RESULT_MISMATCH"
  | "INTEGRATION_REQUEST_MISMATCH"
  | "INTEGRATION_RESULT_MISMATCH";

/**
 * Codes of {@link WorkflowChangeAuthorityError}.
 *
 * @remarks
 * - `WORKFLOW_CHANGE_AUTHORITY_REQUIRED`: authority evidence is absent.
 * - `WORKFLOW_CHANGE_AUTHORITY_INVALID`: the authority returned a malformed
 *   or foreign lease.
 */
export type WorkflowChangeAuthorityErrorCode =
  | "WORKFLOW_CHANGE_AUTHORITY_REQUIRED"
  | "WORKFLOW_CHANGE_AUTHORITY_INVALID";

/**
 * Thrown when change evidence (digest, receipt, commit or integration) disagrees.
 */
export class WorkflowChangeMismatchError extends Error {
  /** Which comparison failed. */
  readonly code: WorkflowChangeMismatchErrorCode;

  /**
   * @param code - Failed comparison.
   * @param message - Description of the mismatch.
   */
  constructor(code: WorkflowChangeMismatchErrorCode, message: string) {
    super(message);
    this.name = "WorkflowChangeMismatchError";
    this.code = code;
  }
}

/**
 * Thrown when the receipt authority is missing or returns an invalid lease.
 */
export class WorkflowChangeAuthorityError extends Error {
  /**
   * `REQUIRED` when authority evidence is absent, `INVALID` when it is malformed.
   */
  readonly code: WorkflowChangeAuthorityErrorCode;

  /**
   * @param code - Failure code.
   * @param message - Description of the failure.
   */
  constructor(code: WorkflowChangeAuthorityErrorCode, message: string) {
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
  // Code-unit order, like the canonical digest; see legacyChangeSetDigest.
  entries.sort((left, right) =>
    compareCodeUnits(changeEntryKey(left), changeEntryKey(right)),
  );
  return Object.freeze({
    executionId: requiredIdentity(input.executionId, "executionId", "record"),
    taskId: requiredIdentity(input.taskId, "taskId", "record"),
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
    const fromPath = changePath(input.fromPath);
    const toPath = changePath(input.toPath);
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
    path: changePath(input.path),
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

/**
 * Validates an integration request and links its receipt, commit and target.
 *
 * @param input - Request with full receipt and commit evidence.
 * @returns The frozen request.
 * @throws {@link WorkflowChangeMismatchError} with code
 * `INTEGRATION_REQUEST_MISMATCH` when the evidence does not describe one
 * publication.
 * @throws {@link WorkflowChangeAuthorityError} when the receipt lacks authority
 * fields.
 * @throws {@link TypeError} when the request is malformed.
 */
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
    executionId: requiredIdentity(input.executionId, "executionId", "record"),
    taskId: requiredIdentity(input.taskId, "taskId", "record"),
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

/**
 * Pre-0.7.0 change set digest: `JSON.stringify` in property order, with the
 * entries sorted by `localeCompare`. Accepted by verifyWorkflowChangeSet so
 * receipts and change sets stored before 0.7.0 keep verifying; never written.
 */
function legacyChangeSetDigest(
  normalized: WorkflowChangeSetInput,
): Promise<string> {
  const entries = [...normalized.entries].sort((left, right) =>
    changeEntryKey(left).localeCompare(changeEntryKey(right)),
  );
  return legacyDigest({ ...normalized, entries }, "insertion");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
    requiredIdentity(lease.reservationId, "reservationId", "record") !==
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

function changePath(input: string): string {
  const problem = portablePathProblem(input);
  if (problem !== undefined) {
    throw new TypeError(`Change paths ${problem}: ${JSON.stringify(input)}`);
  }
  return normalizePortablePath(input);
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

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;

function requiredIdentity(
  value: unknown,
  field: string,
  grammar: WorkflowIdentifierGrammar = "opaque",
): string {
  if (!isWorkflowIdentifier(value, grammar)) {
    throw new TypeError(`${field} must be a safe identity`);
  }
  return value;
}

function requiredRevision(value: unknown, field: string): string {
  if (!isWorkflowIdentifier(value, "revision")) {
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

const ABORTED_MESSAGE = "Workflow change operation aborted";

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
