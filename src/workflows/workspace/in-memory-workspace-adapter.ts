import { randomUUID } from "node:crypto";
import { throwIfAborted } from "../internal/abort.js";
import {
  findWorkspacePathOverlaps,
  normalizeWorkspaceLeaseRequest,
  type WorkspaceAcquireOptions,
  type WorkspaceAdapter,
  type WorkspaceLease,
  type WorkspaceLeaseConflict,
  type WorkspaceLeaseRequest,
} from "./workspace-adapter.js";

const ABORTED = "Workspace lease acquisition aborted";

/** Options for {@link InMemoryWorkspaceAdapter}. */
export interface InMemoryWorkspaceAdapterOptions {
  /**
   * Produces lease ids; duplicates and blank values are rejected at grant time.
   *
   * @defaultValue `crypto.randomUUID`
   */
  createLeaseId?: () => string;
  /**
   * Clock for `acquiredAt` in epoch milliseconds.
   *
   * @defaultValue `Date.now`
   */
  now?: () => number;
  /**
   * Compare write paths without regard to letter case, for workspaces on a
   * case-insensitive filesystem (the macOS and Windows defaults), where
   * `Src/a` and `src/a` are the same file.
   *
   * @remarks
   * Paths are compared after Unicode NFC normalization and a full case fold
   * (so `ß` meets `ss` and `ς` meets `σ`). The fold is conservative: it may
   * report an overlap the filesystem would not, never miss one. Lease paths
   * keep the caller's spelling.
   *
   * @defaultValue false
   */
  caseInsensitivePaths?: boolean;
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

/**
 * In-process coordinator for host-owned workspace write leases.
 *
 * @remarks
 * Conflicting requests wait in FIFO order and are granted as leases are
 * released. Leases do not expire and are lost with the process; use
 * {@link FileSystemWorkspaceAdapter} for durable ownership.
 */
export class InMemoryWorkspaceAdapter implements WorkspaceAdapter {
  readonly #active = new Map<string, ActiveLease>();
  readonly #pending: PendingAcquisition[] = [];
  readonly #issuedLeaseIds = new Set<string>();
  readonly #createLeaseId: () => string;
  readonly #now: () => number;
  readonly #caseInsensitive: boolean;

  /**
   * @param options - Optional lease id and clock overrides and path case
   * handling.
   */
  constructor(options: InMemoryWorkspaceAdapterOptions = {}) {
    this.#createLeaseId = options.createLeaseId ?? randomUUID;
    this.#now = options.now ?? Date.now;
    this.#caseInsensitive = options.caseInsensitivePaths === true;
  }

  /**
   * Acquires a lease, waiting while any active lease overlaps the paths.
   *
   * @param request - Workspace, owner and relative write paths to own.
   * @param options - Optional abort signal for the wait.
   * @returns The granted lease.
   * @throws {@link TypeError} when the request is invalid.
   * @throws The signal's reason (or an `Error`) when aborted before the grant.
   * @throws `Error` when the lease id factory returns a blank or duplicate id.
   */
  async acquire(
    request: WorkspaceLeaseRequest,
    options: WorkspaceAcquireOptions = {},
  ): Promise<WorkspaceLease> {
    const normalized = normalizeWorkspaceLeaseRequest(request);
    throwIfAborted(options.signal, ABORTED);

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

  /**
   * Lists active leases that overlap the request without acquiring anything.
   *
   * @param request - Workspace, owner and relative write paths to check.
   * @returns Conflicting leases, empty when the paths are free.
   * @throws {@link TypeError} when the request is invalid.
   */
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
        { caseInsensitive: this.#caseInsensitive },
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
