/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import {
  assertChangeSetMatchesReceipt,
  normalizeAuthoritativeChangeReceipt,
  verifyWorkflowChangeSet,
  WORKFLOW_CHANGE_AUTHORITY_LEASE,
  type WorkflowAuthoritativeChangeReceipt,
  type WorkflowAuthoritativeCommitResult,
  WorkflowChangeAuthorityError,
  type WorkflowChangeAuthorityLease,
  type WorkflowChangeOperationOptions,
  type WorkflowChangeReceiptAuthority,
  type WorkflowCommitAuthorityRequest,
  type WorkflowIntegrationAuthorityRequest,
  type WorkflowIntegrationResult,
  type WorkflowMutationReconcileRequest,
  type WorkflowMutationReconcileResult,
} from "../workspace/change-driver.js";
import type {
  WorkflowHostMutationJournal,
  WorkflowHostMutationRecord,
} from "../workspace/mutation-journal.js";
import {
  type WorkflowMutationReservation,
  WorkflowOrchestrationControlError,
  type WorkflowOrchestrationState,
} from "./contracts.js";
import { immutableWorkflowOrchestrationJson } from "./json.js";
import type {
  WorkflowChangeReceiptStore,
  WorkflowOrchestrationStateStore,
} from "./stores.js";

export interface WorkflowLiveChangeReceiptAuthorityConfig {
  state: WorkflowOrchestrationStateStore;
  receipts: WorkflowChangeReceiptStore;
  journal: WorkflowHostMutationJournal;
  now?: () => number;
  reservationTtlMs?: number;
  maxCasRetries?: number;
}

interface LeaseBinding {
  executionId: string;
  phase: "commit" | "integration";
  reservationId: string;
  operationId: string;
  intentDigest: string;
}

export class WorkflowLiveChangeReceiptAuthority
  implements WorkflowChangeReceiptAuthority
{
  readonly #state: WorkflowOrchestrationStateStore;
  readonly #receipts: WorkflowChangeReceiptStore;
  readonly #journal: WorkflowHostMutationJournal;
  readonly #now: () => number;
  readonly #reservationTtlMs: number;
  readonly #maxCasRetries: number;

  constructor(config: WorkflowLiveChangeReceiptAuthorityConfig) {
    if (!config?.state || !config.receipts || !config.journal) {
      invalid(
        "Live receipt authority requires state, receipt, and journal stores",
      );
    }
    this.#state = config.state;
    this.#receipts = config.receipts;
    this.#journal = config.journal;
    this.#now = config.now ?? Date.now;
    this.#reservationTtlMs = positiveInteger(
      config.reservationTtlMs ?? 60_000,
      "reservationTtlMs",
    );
    this.#maxCasRetries = positiveInteger(
      config.maxCasRetries ?? 16,
      "maxCasRetries",
    );
  }

  async acquireCommit(
    request: WorkflowCommitAuthorityRequest,
    options: WorkflowChangeOperationOptions = {},
  ): Promise<WorkflowChangeAuthorityLease> {
    throwIfAborted(options.signal);
    const receipt = await this.#issuedReceipt(request.receipt);
    const changeSet = await verifyWorkflowChangeSet(request.changeSet);
    assertChangeSetMatchesReceipt(changeSet, receipt);
    const treeId = revision(request.treeId, "treeId");
    const operationId = identity(request.operationId, "operationId");
    const intentDigest = digest(request.intentDigest, "intentDigest");
    return await this.#acquire(
      {
        phase: "commit",
        operationId,
        intentDigest,
        receipt,
        treeId,
        targetId: receipt.expectedTarget.targetId,
        targetRevision: receipt.expectedTarget.revision,
      },
      options,
    );
  }

  async completeCommit(
    lease: WorkflowChangeAuthorityLease,
    result: WorkflowAuthoritativeCommitResult,
    options: WorkflowChangeOperationOptions = {},
  ): Promise<void> {
    const binding = await this.#binding(lease, "commit");
    const commitId = revision(result.commitId, "commitId");
    const treeId = revision(result.treeId, "treeId");
    await this.#complete(
      binding,
      (reservation) => {
        if (
          reservation.receiptId !== identity(result.receiptId, "receiptId") ||
          reservation.changeSetDigest !==
            digest(result.changeSetDigest, "changeSetDigest") ||
          reservation.treeId !== treeId ||
          (reservation.commitId !== undefined &&
            reservation.commitId !== commitId)
        ) {
          authorityInvalid("Commit result does not match its reservation");
        }
        return { ...reservation, commitId };
      },
      result,
      options,
    );
  }

  async acquireIntegration(
    request: WorkflowIntegrationAuthorityRequest,
    options: WorkflowChangeOperationOptions = {},
  ): Promise<WorkflowChangeAuthorityLease> {
    throwIfAborted(options.signal);
    const receipt = await this.#issuedReceipt(request.receipt);
    const operationId = identity(request.operationId, "operationId");
    const intentDigest = digest(request.intentDigest, "intentDigest");
    const commitId = revision(request.commit.commitId, "commitId");
    const treeId = revision(request.commit.treeId, "treeId");
    if (
      request.commit.receiptId !== receipt.receiptId ||
      request.commit.changeSetDigest !== receipt.changeSetDigest ||
      request.commit.workspaceRevision !== receipt.workspaceRevision ||
      request.commit.baseRevision !== receipt.baseRevision ||
      request.expectedTarget.targetId !== receipt.expectedTarget.targetId ||
      request.expectedTarget.revision !== receipt.expectedTarget.revision
    ) {
      authorityInvalid("Integration evidence is not linked to its receipt");
    }
    return await this.#acquire(
      {
        phase: "integration",
        operationId,
        intentDigest,
        receipt,
        treeId,
        commitId,
        targetId: identity(request.expectedTarget.targetId, "targetId"),
        targetRevision: revision(
          request.expectedTarget.revision,
          "targetRevision",
        ),
      },
      options,
    );
  }

  async completeIntegration(
    lease: WorkflowChangeAuthorityLease,
    result: WorkflowIntegrationResult,
    options: WorkflowChangeOperationOptions = {},
  ): Promise<void> {
    const binding = await this.#binding(lease, "integration");
    await this.#complete(
      binding,
      (reservation) => {
        if (
          reservation.commitId !== revision(result.commitId, "commitId") ||
          reservation.targetId !== identity(result.targetId, "targetId") ||
          reservation.targetRevision !==
            revision(result.previousRevision, "previousRevision") ||
          revision(result.integratedRevision, "integratedRevision") !==
            reservation.commitId
        ) {
          authorityInvalid("Integration result does not match its reservation");
        }
        return reservation;
      },
      result,
      options,
    );
  }

  async release(
    lease: WorkflowChangeAuthorityLease,
    options: WorkflowChangeOperationOptions = {},
  ): Promise<void> {
    throwIfAborted(options.signal);
    const binding = await this.#binding(lease);
    for (let retry = 0; retry < this.#maxCasRetries; retry++) {
      const state = await this.#requiredState(binding.executionId);
      const reservation = findReservation(state, binding.reservationId);
      if (!reservation) {
        await this.#markOperationAmbiguous(
          binding,
          "Mutation reservation was superseded before release",
        );
        return;
      }
      assertLeaseReservation(reservation, binding);
      if (reservation.status === "completed") {
        return;
      }
      if (reservation.status !== "reserved") {
        return;
      }
      try {
        await this.#replaceReservation(state, reservation.reservationId, {
          ...reservation,
          status: "released",
        });
        await this.#journal.markAmbiguous(
          binding.operationId,
          binding.intentDigest,
          "Mutation lease was released before durable completion",
        );
        return;
      } catch (error) {
        if (isCasConflict(error)) continue;
        throw error;
      }
    }
    contended(binding.executionId);
  }

  /**
   * Explicitly abandons a completed commit handoff. Normal `release()` cannot
   * do this because committers call it after every successful completion.
   */
  async abandonCommit(
    lease: WorkflowChangeAuthorityLease,
    options: WorkflowChangeOperationOptions = {},
  ): Promise<void> {
    throwIfAborted(options.signal);
    const binding = await this.#binding(lease, "commit");
    for (let retry = 0; retry < this.#maxCasRetries; retry++) {
      const state = await this.#requiredState(binding.executionId);
      const reservation = findReservation(state, binding.reservationId);
      if (!reservation) return;
      assertLeaseReservation(reservation, binding);
      if (reservation.status === "released") return;
      if (reservation.status !== "completed") {
        authorityInvalid("Only a completed commit handoff can be abandoned");
      }
      try {
        await this.#replaceReservation(state, reservation.reservationId, {
          ...reservation,
          status: "released",
          completedAt: undefined,
        });
        return;
      } catch (error) {
        if (isCasConflict(error)) continue;
        throw error;
      }
    }
    contended(binding.executionId);
  }

  async reconcile(
    request: WorkflowMutationReconcileRequest,
    options: WorkflowChangeOperationOptions = {},
  ): Promise<WorkflowMutationReconcileResult> {
    throwIfAborted(options.signal);
    const operationId = identity(request.operationId, "operationId");
    const intentDigest = digest(request.intentDigest, "intentDigest");
    if (request.kind !== "commit" && request.kind !== "integration") {
      invalid("Mutation reconcile kind is invalid");
    }
    const journal = await this.#journal.get(operationId);
    if (!journal) return Object.freeze({ status: "absent" });
    assertJournalIntent(journal, intentDigest, request.kind);
    if (journal.status === "completed")
      return Object.freeze({ status: "completed" });
    if (journal.status === "ambiguous")
      return Object.freeze({ status: "ambiguous" });
    for (let retry = 0; retry < this.#maxCasRetries; retry++) {
      const state = await this.#state.get(journal.executionId);
      const reservation = state?.reservations?.find(
        (item) =>
          item.reservationId === reservationId(request.kind, intentDigest),
      );
      if (!state || !reservation) {
        return await this.#reconcileAmbiguous(
          journal,
          "Mutation reservation was superseded while its journal was pending",
        );
      }
      if (reservation.status === "completed") {
        return Object.freeze({ status: "completed" });
      }
      if (
        reservation.status === "released" ||
        reservation.status === "expired"
      ) {
        return await this.#reconcileAmbiguous(
          journal,
          "Mutation reservation is no longer active",
        );
      }
      if (reservation.expiresAt <= this.#timestamp()) {
        try {
          await this.#replaceReservation(state, reservation.reservationId, {
            ...reservation,
            status: "expired",
          });
        } catch (error) {
          if (isCasConflict(error)) continue;
          throw error;
        }
        return await this.#reconcileAmbiguous(
          journal,
          "Mutation reservation expired",
        );
      }
      return Object.freeze({ status: "pending" });
    }
    contended(journal.executionId);
  }

  async #acquire(
    input: {
      phase: "commit" | "integration";
      operationId: string;
      intentDigest: string;
      receipt: WorkflowAuthoritativeChangeReceipt;
      treeId: string;
      commitId?: string;
      targetId: string;
      targetRevision: string;
    },
    options: WorkflowChangeOperationOptions,
  ): Promise<WorkflowChangeAuthorityLease> {
    const reservationKey = reservationId(input.phase, input.intentDigest);
    for (let retry = 0; retry < this.#maxCasRetries; retry++) {
      throwIfAborted(options.signal);
      const state = await this.#liveReceiptState(input.receipt);
      const now = this.#timestamp(state.updatedAt);
      const begun = await this.#journal.begin({
        operationId: input.operationId,
        intentDigest: input.intentDigest,
        kind: input.phase,
        executionId: input.receipt.executionId,
        taskId: input.receipt.taskId,
        startedAt: now,
      });
      assertJournalAuthority(begun.record, input);
      if (begun.record.status === "ambiguous") {
        authorityInvalid("Mutation operation has an ambiguous durable outcome");
      }
      const existing = state.reservations?.find(
        (item) => item.reservationId === reservationKey,
      );
      if (existing) {
        assertReservationMatches(existing, input);
        if (
          existing.status === "completed" ||
          (existing.status === "reserved" && existing.expiresAt > now)
        ) {
          return this.#lease(input, reservationKey);
        }
      }
      let replaceReservationId: string | undefined;
      if (existing) {
        replaceReservationId = existing.reservationId;
      } else if (input.phase === "integration") {
        const publishedCommit = state.reservations?.find(
          (item) =>
            item.phase === "commit" &&
            item.status === "completed" &&
            item.receiptId === input.receipt.receiptId &&
            item.changeSetDigest === input.receipt.changeSetDigest &&
            item.treeId === input.treeId &&
            item.commitId === input.commitId &&
            item.targetId === input.targetId &&
            item.targetRevision === input.targetRevision,
        );
        if (!publishedCommit) {
          authorityInvalid(
            "Integration requires an exactly linked completed commit reservation",
          );
        }
        // A receipt has one live publication authority record. Integration
        // atomically consumes the completed commit reservation and carries its
        // immutable commit/tree evidence forward.
        replaceReservationId = publishedCommit.reservationId;
      }
      const reservation = immutableWorkflowOrchestrationJson({
        reservationId: reservationKey,
        receiptId: input.receipt.receiptId,
        phase: input.phase,
        taskId: input.receipt.taskId,
        agentId: input.receipt.agentId,
        planRevision: input.receipt.planRevision,
        orchestrationRevision: input.receipt.orchestrationRevision,
        grants: input.receipt.ownership,
        changeSetDigest: input.receipt.changeSetDigest,
        treeId: input.treeId,
        ...(input.commitId === undefined ? {} : { commitId: input.commitId }),
        targetId: input.targetId,
        targetRevision: input.targetRevision,
        status: "reserved",
        createdAt: now,
        expiresAt: now + this.#reservationTtlMs,
      } satisfies WorkflowMutationReservation);
      try {
        await this.#replaceReservation(
          state,
          replaceReservationId,
          reservation,
        );
        return this.#lease(input, reservationKey);
      } catch (error) {
        if (isCasConflict(error)) continue;
        throw error;
      }
    }
    contended(input.receipt.executionId);
  }

  async #complete(
    binding: LeaseBinding,
    link: (
      reservation: WorkflowMutationReservation,
    ) => WorkflowMutationReservation,
    result: object,
    options: WorkflowChangeOperationOptions,
  ): Promise<void> {
    throwIfAborted(options.signal);
    for (let retry = 0; retry < this.#maxCasRetries; retry++) {
      const state = await this.#requiredState(binding.executionId);
      const reservation = findReservation(state, binding.reservationId);
      if (!reservation) {
        const durable = await this.#journal.get(binding.operationId);
        if (durable?.status === "completed") {
          await this.#journal.complete(
            binding.operationId,
            binding.intentDigest,
            JSON.parse(JSON.stringify(result)),
          );
          return;
        }
        await this.#markOperationAmbiguous(
          binding,
          "Mutation reservation was superseded before host completion",
        );
        authorityInvalid(
          "Mutation outcome is ambiguous because its reservation was superseded",
        );
      }
      assertLeaseReservation(reservation, binding);
      if (reservation.status === "completed") {
        link(reservation);
        await this.#journal.complete(
          binding.operationId,
          binding.intentDigest,
          JSON.parse(JSON.stringify(result)),
        );
        return;
      }
      if (
        (reservation.status === "expired" ||
          (reservation.status === "reserved" &&
            reservation.expiresAt <= this.#timestamp())) &&
        !reservationAuthorityIsLive(state, reservation)
      ) {
        if (reservation.status === "reserved") {
          try {
            await this.#replaceReservation(state, reservation.reservationId, {
              ...reservation,
              status: "expired",
            });
          } catch (error) {
            if (isCasConflict(error)) continue;
            throw error;
          }
        }
        await this.#markOperationAmbiguous(
          binding,
          "Mutation authority changed after reservation expiry",
        );
        authorityInvalid(
          "Mutation outcome is ambiguous because authority changed after reservation expiry",
        );
      }
      if (
        reservation.status !== "reserved" &&
        reservation.status !== "expired"
      ) {
        authorityInvalid("Mutation reservation is no longer active");
      }
      const completedAt = this.#timestamp(state.updatedAt);
      const completed = immutableWorkflowOrchestrationJson({
        ...link(reservation),
        status: "completed",
        completedAt,
      } satisfies WorkflowMutationReservation);
      try {
        await this.#replaceReservation(
          state,
          reservation.reservationId,
          completed,
        );
        await this.#journal.complete(
          binding.operationId,
          binding.intentDigest,
          JSON.parse(JSON.stringify(result)),
        );
        return;
      } catch (error) {
        if (isCasConflict(error)) continue;
        throw error;
      }
    }
    contended(binding.executionId);
  }

  async #issuedReceipt(
    value: WorkflowAuthoritativeChangeReceipt,
  ): Promise<WorkflowAuthoritativeChangeReceipt> {
    const receipt = normalizeAuthoritativeChangeReceipt(value);
    const issued = await this.#receipts.get(
      receipt.executionId,
      receipt.receiptId,
    );
    if (!issued || JSON.stringify(issued) !== JSON.stringify(receipt)) {
      authorityInvalid(
        "Change receipt was not issued by the trusted validator",
      );
    }
    return issued;
  }

  async #liveReceiptState(
    receipt: WorkflowAuthoritativeChangeReceipt,
  ): Promise<WorkflowOrchestrationState> {
    const state = await this.#requiredState(receipt.executionId);
    if (
      state.activePlanRevision !== receipt.planRevision ||
      receipt.orchestrationRevision > state.revision
    ) {
      authorityInvalid("Change receipt is stale for the active plan");
    }
    for (const fence of receipt.ownership) {
      const grant = state.grants.find(
        (item) =>
          item.grantId === fence.grantId &&
          item.fencingToken === fence.fencingToken &&
          item.taskId === receipt.taskId &&
          item.agentId === receipt.agentId &&
          item.planRevision === receipt.planRevision,
      );
      if (!grant)
        authorityInvalid(`Receipt ownership is stale: ${fence.grantId}`);
    }
    return state;
  }

  async #requiredState(
    executionId: string,
  ): Promise<WorkflowOrchestrationState> {
    const state = await this.#state.get(executionId);
    if (!state) {
      throw new WorkflowOrchestrationControlError(
        "WORKFLOW_ORCHESTRATION_STATE_NOT_FOUND",
        `Workflow orchestration state was not found: ${executionId}`,
        { executionId },
      );
    }
    return state;
  }

  async #replaceReservation(
    state: WorkflowOrchestrationState,
    replaceId: string | undefined,
    reservation: WorkflowMutationReservation,
  ): Promise<WorkflowOrchestrationState> {
    const reservations = state.reservations ?? [];
    const next =
      replaceId === undefined
        ? [...reservations, reservation]
        : reservations.map((item) =>
            item.reservationId === replaceId ? reservation : item,
          );
    return await this.#state.compareAndSet(
      immutableWorkflowOrchestrationJson({
        ...state,
        revision: state.revision + 1,
        reservations: next,
        updatedAt: this.#timestamp(state.updatedAt),
      }),
      state.revision,
    );
  }

  async #markAmbiguous(
    journal: WorkflowHostMutationRecord,
    reason: string,
  ): Promise<void> {
    if (journal.status !== "pending") return;
    try {
      await this.#journal.markAmbiguous(
        journal.operationId,
        journal.intentDigest,
        reason,
      );
    } catch (error) {
      const latest = await this.#journal.get(journal.operationId);
      if (latest?.status === "completed") return;
      throw error;
    }
  }

  async #reconcileAmbiguous(
    journal: WorkflowHostMutationRecord,
    reason: string,
  ): Promise<WorkflowMutationReconcileResult> {
    await this.#markAmbiguous(journal, reason);
    const latest = await this.#journal.get(journal.operationId);
    return Object.freeze({
      status: latest?.status === "completed" ? "completed" : "ambiguous",
    });
  }

  #lease(
    input: {
      phase: "commit" | "integration";
      operationId: string;
      intentDigest: string;
      receipt: WorkflowAuthoritativeChangeReceipt;
    },
    reservationKey: string,
  ): WorkflowChangeAuthorityLease {
    return Object.freeze({
      [WORKFLOW_CHANGE_AUTHORITY_LEASE]: true as const,
      leaseId: `lease-${reservationKey}`,
      reservationId: reservationKey,
      operationId: input.operationId,
      intentDigest: input.intentDigest,
    });
  }

  async #binding(
    lease: WorkflowChangeAuthorityLease,
    phase?: "commit" | "integration",
  ): Promise<LeaseBinding> {
    if (
      !lease ||
      typeof lease !== "object" ||
      lease[WORKFLOW_CHANGE_AUTHORITY_LEASE] !== true
    ) {
      authorityInvalid("Mutation authority lease is forged");
    }
    const operationId = identity(lease.operationId, "operationId");
    const intentDigest = digest(lease.intentDigest, "intentDigest");
    const journal = await this.#journal.get(operationId);
    if (!journal) authorityInvalid("Mutation authority lease has no journal");
    assertJournalIntent(journal, intentDigest, journal.kind);
    const reservationKey = reservationId(journal.kind, intentDigest);
    if (
      lease.reservationId !== reservationKey ||
      lease.leaseId !== `lease-${reservationKey}` ||
      (phase !== undefined && journal.kind !== phase)
    ) {
      authorityInvalid(
        "Mutation authority lease is forged or has the wrong phase",
      );
    }
    return {
      executionId: journal.executionId,
      phase: journal.kind,
      reservationId: reservationKey,
      operationId,
      intentDigest,
    };
  }

  async #markOperationAmbiguous(
    binding: LeaseBinding,
    reason: string,
  ): Promise<void> {
    const journal = await this.#journal.get(binding.operationId);
    if (journal?.status === "pending") {
      await this.#markAmbiguous(journal, reason);
    }
  }

  #timestamp(floor = 0): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0)
      invalid("Live receipt authority clock returned an invalid timestamp");
    return Math.max(value, floor);
  }
}

function findReservation(
  state: WorkflowOrchestrationState,
  reservationId: string,
): WorkflowMutationReservation | undefined {
  return state.reservations?.find(
    (item) => item.reservationId === reservationId,
  );
}

function reservationAuthorityIsLive(
  state: WorkflowOrchestrationState,
  reservation: WorkflowMutationReservation,
): boolean {
  return (
    state.activePlanRevision === reservation.planRevision &&
    reservation.grants.every((fence) =>
      state.grants.some(
        (grant) =>
          grant.grantId === fence.grantId &&
          grant.fencingToken === fence.fencingToken &&
          grant.taskId === reservation.taskId &&
          grant.agentId === reservation.agentId &&
          grant.planRevision === reservation.planRevision,
      ),
    )
  );
}

function assertReservationMatches(
  reservation: WorkflowMutationReservation,
  input: {
    phase: "commit" | "integration";
    receipt: WorkflowAuthoritativeChangeReceipt;
    treeId: string;
    commitId?: string;
    targetId: string;
    targetRevision: string;
  },
): void {
  if (
    reservation.phase !== input.phase ||
    reservation.receiptId !== input.receipt.receiptId ||
    reservation.taskId !== input.receipt.taskId ||
    reservation.agentId !== input.receipt.agentId ||
    reservation.planRevision !== input.receipt.planRevision ||
    reservation.changeSetDigest !== input.receipt.changeSetDigest ||
    reservation.treeId !== input.treeId ||
    ((reservation.phase !== "commit" || reservation.status !== "completed") &&
      reservation.commitId !== input.commitId) ||
    reservation.targetId !== input.targetId ||
    reservation.targetRevision !== input.targetRevision
  ) {
    authorityInvalid("Mutation reservation linkage does not match");
  }
}

function assertLeaseReservation(
  reservation: WorkflowMutationReservation,
  binding: LeaseBinding,
): void {
  if (
    reservation.reservationId !== binding.reservationId ||
    reservation.phase !== binding.phase
  ) {
    authorityInvalid("Mutation lease does not match its durable reservation");
  }
}

function assertJournalIntent(
  journal: WorkflowHostMutationRecord,
  intentDigest: string,
  kind: "commit" | "integration",
): void {
  if (journal.intentDigest !== intentDigest || journal.kind !== kind) {
    authorityInvalid("Mutation operation was reused with different intent");
  }
}

function assertJournalAuthority(
  journal: WorkflowHostMutationRecord,
  input: {
    phase: "commit" | "integration";
    operationId: string;
    intentDigest: string;
    receipt: WorkflowAuthoritativeChangeReceipt;
  },
): void {
  assertJournalIntent(journal, input.intentDigest, input.phase);
  if (
    journal.operationId !== input.operationId ||
    journal.executionId !== input.receipt.executionId ||
    journal.taskId !== input.receipt.taskId
  ) {
    authorityInvalid("Mutation journal authority does not match its receipt");
  }
}

function reservationId(
  phase: "commit" | "integration",
  intentDigest: string,
): string {
  return `${phase}-${intentDigest.slice("sha256:".length)}`;
}

function identity(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,255}$/u.test(value)
  ) {
    invalid(`${field} must be a safe identity`);
  }
  return value;
}

function revision(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,511}$/u.test(value)
  ) {
    invalid(`${field} must be an immutable revision`);
  }
  return value;
}

function digest(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    invalid(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    invalid(`${field} must be a positive safe integer`);
  }
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Operation aborted");
}

function isCasConflict(error: unknown): boolean {
  return (
    error instanceof WorkflowOrchestrationControlError &&
    error.code === "WORKFLOW_PLAN_REVISION_CONFLICT"
  );
}

function contended(executionId: string): never {
  throw new WorkflowOrchestrationControlError(
    "WORKFLOW_PLAN_REVISION_CONFLICT",
    `Workflow mutation reservation remained contended: ${executionId}`,
    { executionId },
  );
}

function authorityInvalid(message: string): never {
  throw new WorkflowChangeAuthorityError(
    "WORKFLOW_CHANGE_AUTHORITY_INVALID",
    message,
  );
}

function invalid(message: string): never {
  throw new WorkflowOrchestrationControlError(
    "WORKFLOW_ORCHESTRATION_INVALID_REQUEST",
    message,
  );
}
