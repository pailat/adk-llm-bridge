/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { randomUUID } from "node:crypto";
import {
  findWorkspacePathOverlaps,
  normalizeWorkspaceLeaseRequest,
  type WorkspaceAcquireOptions,
  type WorkspaceAdapter,
  type WorkspaceLease,
  type WorkspaceLeaseConflict,
  type WorkspaceLeaseRequest,
} from "./workspace-adapter.js";

export interface InMemoryWorkspaceAdapterOptions {
  createLeaseId?: () => string;
  now?: () => number;
}

interface ActiveLease extends WorkspaceLeaseRequest {
  leaseId: string;
  acquiredAt: number;
}

interface PendingAcquisition {
  request: WorkspaceLeaseRequest;
  signal?: AbortSignal;
  onAbort?: () => void;
  settled: boolean;
  resolve: (lease: WorkspaceLease) => void;
  reject: (reason: unknown) => void;
}

/** In-process coordinator for host-owned workspace write leases. */
export class InMemoryWorkspaceAdapter implements WorkspaceAdapter {
  readonly #active = new Map<string, ActiveLease>();
  readonly #pending: PendingAcquisition[] = [];
  readonly #issuedLeaseIds = new Set<string>();
  readonly #createLeaseId: () => string;
  readonly #now: () => number;

  constructor(options: InMemoryWorkspaceAdapterOptions = {}) {
    this.#createLeaseId = options.createLeaseId ?? randomUUID;
    this.#now = options.now ?? Date.now;
  }

  async acquire(
    request: WorkspaceLeaseRequest,
    options: WorkspaceAcquireOptions = {},
  ): Promise<WorkspaceLease> {
    const normalized = normalizeWorkspaceLeaseRequest(request);
    throwIfAborted(options.signal);

    return new Promise<WorkspaceLease>((resolve, reject) => {
      const pending: PendingAcquisition = {
        request: normalized,
        signal: options.signal,
        settled: false,
        resolve,
        reject,
      };
      if (options.signal) {
        pending.onAbort = () => this.abortPending(pending);
        options.signal.addEventListener("abort", pending.onAbort, {
          once: true,
        });
      }

      if (this.conflictsNormalized(normalized).length === 0) {
        this.grant(pending);
      } else {
        this.#pending.push(pending);
      }
    });
  }

  conflicts(request: WorkspaceLeaseRequest): readonly WorkspaceLeaseConflict[] {
    return this.conflictsNormalized(normalizeWorkspaceLeaseRequest(request));
  }

  private conflictsNormalized(
    request: WorkspaceLeaseRequest,
  ): readonly WorkspaceLeaseConflict[] {
    const conflicts: WorkspaceLeaseConflict[] = [];
    for (const lease of this.#active.values()) {
      if (lease.workspaceId !== request.workspaceId) continue;
      const overlaps = findWorkspacePathOverlaps(
        request.writePaths,
        lease.writePaths,
      );
      if (overlaps.length === 0) continue;
      conflicts.push(
        Object.freeze({
          leaseId: lease.leaseId,
          workspaceId: lease.workspaceId,
          ownerId: lease.ownerId,
          overlaps,
        }),
      );
    }
    return Object.freeze(conflicts);
  }

  private grant(pending: PendingAcquisition): void {
    if (pending.settled) return;
    pending.settled = true;
    this.removeAbortListener(pending);

    try {
      const leaseId = this.#createLeaseId().trim();
      if (!leaseId || this.#issuedLeaseIds.has(leaseId)) {
        throw new Error("Workspace lease ids must be non-empty and unique");
      }
      this.#issuedLeaseIds.add(leaseId);
      const active = Object.freeze({
        ...pending.request,
        leaseId,
        acquiredAt: this.#now(),
      });
      this.#active.set(leaseId, active);
      pending.resolve(
        Object.freeze({
          ...active,
          release: () => Promise.resolve(this.release(leaseId)),
        }),
      );
    } catch (error) {
      pending.reject(error);
      this.drain();
    }
  }

  private release(leaseId: string): boolean {
    if (!this.#active.delete(leaseId)) return false;
    this.drain();
    return true;
  }

  private abortPending(pending: PendingAcquisition): void {
    if (pending.settled) return;
    pending.settled = true;
    const index = this.#pending.indexOf(pending);
    if (index >= 0) this.#pending.splice(index, 1);
    this.removeAbortListener(pending);
    pending.reject(
      pending.signal?.reason ??
        new Error("Workspace lease acquisition aborted"),
    );
  }

  private drain(): void {
    for (let index = 0; index < this.#pending.length; ) {
      const pending = this.#pending[index];
      if (pending.signal?.aborted) {
        this.#pending.splice(index, 1);
        this.abortPending(pending);
        continue;
      }
      if (this.conflictsNormalized(pending.request).length > 0) {
        index++;
        continue;
      }
      this.#pending.splice(index, 1);
      this.grant(pending);
    }
  }

  private removeAbortListener(pending: PendingAcquisition): void {
    if (pending.onAbort) {
      pending.signal?.removeEventListener("abort", pending.onAbort);
      pending.onAbort = undefined;
    }
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new Error("Workspace lease acquisition aborted");
}
