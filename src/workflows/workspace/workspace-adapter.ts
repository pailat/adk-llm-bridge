/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { posix } from "node:path";

/** Host-declared ownership requested for one coordinated workspace. */
export interface WorkspaceLeaseRequest {
  /** Stable coordination scope, such as a repository or worktree id. */
  workspaceId: string;
  /** Agent or host operation that will own the paths. */
  ownerId: string;
  /** Relative paths that may be written while the lease is active. */
  writePaths: readonly string[];
}

export interface WorkspaceAcquireOptions {
  signal?: AbortSignal;
}

/** JSON-safe reason exposed when a durable workspace lease is lost. */
export interface WorkspaceLeaseLossReason {
  code: "workspace_lease_lost" | "workspace_adapter_disposed";
  message: string;
  workspaceId: string;
  leaseId: string;
  fencingToken?: number;
}

/** Immutable ownership granted by the host-side workspace coordinator. */
export interface WorkspaceLease extends WorkspaceLeaseRequest {
  leaseId: string;
  acquiredAt: number;
  /**
   * Monotonic metadata for host-side fencing. The adapter does not fence
   * writes to external resources; the resource writer must enforce this token.
   */
  fencingToken?: number;
  /** Current durable expiry, when the adapter supports expiring leases. */
  expiresAt?: number;
  /** Aborts if durable ownership is lost; a normal release does not abort it. */
  lossSignal?: AbortSignal;
  /** Renews a durable lease. Returns false when ownership is already stale. */
  renew?(): Promise<boolean>;
  /** Returns true once, and false for every later release. */
  release(): Promise<boolean>;
}

export interface WorkspacePathOverlap {
  requestedPath: string;
  leasedPath: string;
}

export interface WorkspaceLeaseConflict {
  leaseId: string;
  workspaceId: string;
  ownerId: string;
  fencingToken?: number;
  expiresAt?: number;
  overlaps: readonly WorkspacePathOverlap[];
}

/** Workspace coordination injected into one workflow runtime. */
export interface WorkflowWorkspaceConfig {
  /** Stable coordination scope shared by steps in the same workspace. */
  workspaceId: string;
  adapter: WorkspaceAdapter;
}

/**
 * Host-controlled capability for coordinating write ownership.
 *
 * This contract intentionally contains no shell, Git, or sandbox-script API.
 */
export interface WorkspaceAdapter {
  acquire(
    request: WorkspaceLeaseRequest,
    options?: WorkspaceAcquireOptions,
  ): Promise<WorkspaceLease>;

  conflicts(request: WorkspaceLeaseRequest): readonly WorkspaceLeaseConflict[];
}

export function normalizeWorkspacePath(input: string): string {
  if (typeof input !== "string" || !input.trim()) {
    throw new TypeError("Workspace write paths must be non-empty strings");
  }
  if (input.includes("\0")) {
    throw new TypeError("Workspace write paths must not contain NUL bytes");
  }

  const portable = input.replaceAll("\\", "/");
  if (posix.isAbsolute(portable) || /^[A-Za-z]:\//u.test(portable)) {
    throw new TypeError(`Workspace write paths must be relative: ${input}`);
  }
  if (portable.split("/").includes("..")) {
    throw new TypeError(
      `Workspace write paths must not traverse parent directories: ${input}`,
    );
  }

  const normalized = posix
    .normalize(portable)
    .replace(/^\.\//u, "")
    .replace(/\/+$/u, "");
  return normalized === "" ? "." : normalized;
}

export function workspacePathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizeWorkspacePath(left);
  const normalizedRight = normalizeWorkspacePath(right);
  return normalizedPathsOverlap(normalizedLeft, normalizedRight);
}

export function normalizeWorkspaceLeaseRequest(
  request: WorkspaceLeaseRequest,
): WorkspaceLeaseRequest {
  const workspaceId = requiredIdentity(request.workspaceId, "workspaceId");
  const ownerId = requiredIdentity(request.ownerId, "ownerId");
  if (!Array.isArray(request.writePaths) || request.writePaths.length === 0) {
    throw new TypeError("Workspace leases require at least one write path");
  }

  const normalized = [
    ...new Set(request.writePaths.map(normalizeWorkspacePath)),
  ]
    .sort()
    .filter(
      (candidate, index, paths) =>
        !paths.some(
          (other, otherIndex) =>
            index !== otherIndex && normalizedPathsContain(other, candidate),
        ),
    );

  return Object.freeze({
    workspaceId,
    ownerId,
    writePaths: Object.freeze(normalized),
  });
}

export function findWorkspacePathOverlaps(
  requestedPaths: readonly string[],
  leasedPaths: readonly string[],
): readonly WorkspacePathOverlap[] {
  const overlaps: WorkspacePathOverlap[] = [];
  for (const requestedPath of requestedPaths) {
    for (const leasedPath of leasedPaths) {
      if (normalizedPathsOverlap(requestedPath, leasedPath)) {
        overlaps.push(Object.freeze({ requestedPath, leasedPath }));
      }
    }
  }
  return Object.freeze(overlaps);
}

function requiredIdentity(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Workspace lease ${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizedPathsContain(parent: string, child: string): boolean {
  return parent === "." || child === parent || child.startsWith(`${parent}/`);
}

function normalizedPathsOverlap(left: string, right: string): boolean {
  return (
    normalizedPathsContain(left, right) || normalizedPathsContain(right, left)
  );
}
