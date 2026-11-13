import {
  normalizePortablePath,
  portablePathContains,
  portablePathProblem,
} from "../internal/portable-path.js";

/** Host-declared ownership requested for one coordinated workspace. */
export interface WorkspaceLeaseRequest {
  /** Stable coordination scope, such as a repository or worktree id. */
  workspaceId: string;
  /** Agent or host operation that will own the paths. */
  ownerId: string;
  /** Relative paths that may be written while the lease is active. */
  writePaths: readonly string[];
}

/** Options for {@link WorkspaceAdapter.acquire}. */
export interface WorkspaceAcquireOptions {
  /** Aborts a pending acquisition. */
  signal?: AbortSignal;
}

/** JSON-safe reason exposed when a durable workspace lease is lost. */
export interface WorkspaceLeaseLossReason {
  /**
   * Why ownership ended: `WORKSPACE_LEASE_LOST` when the lease expired or was
   * taken over, `WORKSPACE_ADAPTER_DISPOSED` when the adapter was disposed.
   */
  code: "WORKSPACE_LEASE_LOST" | "WORKSPACE_ADAPTER_DISPOSED";
  /** Human-readable description of the loss. */
  message: string;
  /** Workspace the lost lease belonged to. */
  workspaceId: string;
  /** Identifier of the lost lease. */
  leaseId: string;
  /** Fencing token of the lost lease, when the adapter issues one. */
  fencingToken?: number;
}

/** Immutable ownership granted by the host-side workspace coordinator. */
export interface WorkspaceLease extends WorkspaceLeaseRequest {
  /** Unique identifier of this lease. */
  leaseId: string;
  /** Acquisition time in epoch milliseconds. */
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

/** One requested path that collides with a path already leased. */
export interface WorkspacePathOverlap {
  /** Normalized path from the new request. */
  requestedPath: string;
  /** Normalized path held by the existing lease. */
  leasedPath: string;
}

/** An existing lease that blocks a requested set of write paths. */
export interface WorkspaceLeaseConflict {
  /** Identifier of the blocking lease. */
  leaseId: string;
  /** Workspace of the blocking lease. */
  workspaceId: string;
  /** Owner of the blocking lease. */
  ownerId: string;
  /** Fencing token of the blocking lease, when issued. */
  fencingToken?: number;
  /** Expiry of the blocking lease in epoch milliseconds, when it expires. */
  expiresAt?: number;
  /** Path pairs that collide. */
  overlaps: readonly WorkspacePathOverlap[];
}

/** Workspace coordination injected into one workflow runtime. */
export interface WorkflowWorkspaceConfig {
  /** Stable coordination scope shared by steps in the same workspace. */
  workspaceId: string;
  /** Adapter that grants and tracks write leases. */
  adapter: WorkspaceAdapter;
}

/**
 * Host-controlled capability for coordinating write ownership.
 *
 * This contract intentionally contains no shell, Git, or sandbox-script API.
 */
export interface WorkspaceAdapter {
  /**
   * Acquires a lease over the requested write paths.
   *
   * @param request - Workspace, owner and relative write paths to own.
   * @param options - Optional abort signal for the wait.
   * @returns The granted lease.
   */
  acquire(
    request: WorkspaceLeaseRequest,
    options?: WorkspaceAcquireOptions,
  ): Promise<WorkspaceLease>;

  /**
   * Lists active leases that overlap the request without acquiring anything.
   *
   * @param request - Workspace, owner and relative write paths to check.
   * @returns Conflicting leases, empty when the paths are free.
   */
  conflicts(request: WorkspaceLeaseRequest): readonly WorkspaceLeaseConflict[];
}

/**
 * Normalizes a relative write path to its canonical portable form.
 *
 * @remarks
 * Uses the package's portable path rules, shared with change sets and
 * ownership claims: segments are separated by `/`; empty and `.` segments
 * and a trailing slash are dropped. Fails closed: a blank path, a path longer
 * than 4096 characters, a NUL character, a backslash, a leading `/`, a drive
 * prefix such as `C:` and any `..` segment are rejected, so a lease can never
 * cover paths outside the workspace root. The workspace root itself is
 * returned as `.`.
 *
 * @param input - Relative path using `/` separators.
 * @returns The normalized relative path.
 * @throws {@link TypeError} when the path breaks one of these rules.
 */
export function normalizeWorkspacePath(input: string): string {
  const problem = portablePathProblem(input, { allowRoot: true });
  if (problem !== undefined) {
    throw new TypeError(
      `Workspace write paths ${problem}: ${JSON.stringify(input)}`,
    );
  }
  return normalizePortablePath(input, { allowRoot: true });
}

/**
 * Tells whether two paths are equal or one contains the other.
 *
 * @param left - First relative path.
 * @param right - Second relative path.
 * @returns `true` when the paths overlap.
 * @throws {@link TypeError} when either path is rejected by
 * {@link normalizeWorkspacePath}.
 */
export function workspacePathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizeWorkspacePath(left);
  const normalizedRight = normalizeWorkspacePath(right);
  return normalizedPathsOverlap(normalizedLeft, normalizedRight);
}

/**
 * Validates a lease request and returns a frozen canonical copy.
 *
 * @remarks
 * Identities are trimmed, paths are normalized, deduplicated and sorted, and
 * paths already covered by a parent path in the request are dropped.
 *
 * @param request - Raw request.
 * @returns The canonical, frozen request.
 * @throws {@link TypeError} when an identity is blank, no write path is given
 * or a path is invalid.
 */
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

/** Options for {@link findWorkspacePathOverlaps}. */
export interface WorkspacePathOverlapOptions {
  /**
   * Compare paths without regard to letter case, after Unicode NFC
   * normalization and a full case fold. The fold is conservative: it may
   * report an overlap the filesystem would not, never miss one.
   *
   * @defaultValue false
   */
  caseInsensitive?: boolean;
}

/**
 * Finds every requested/leased path pair that overlaps.
 *
 * @param requestedPaths - Paths already normalized by
 * {@link normalizeWorkspaceLeaseRequest}.
 * @param leasedPaths - Normalized paths held by an existing lease.
 * @param options - Whether letter case is ignored.
 * @returns A frozen list of overlapping pairs, with the paths as given.
 */
export function findWorkspacePathOverlaps(
  requestedPaths: readonly string[],
  leasedPaths: readonly string[],
  options: WorkspacePathOverlapOptions = {},
): readonly WorkspacePathOverlap[] {
  const key = options.caseInsensitive ? foldWorkspacePathCase : sameSpelling;
  const overlaps: WorkspacePathOverlap[] = [];
  for (const requestedPath of requestedPaths) {
    for (const leasedPath of leasedPaths) {
      if (normalizedPathsOverlap(key(requestedPath), key(leasedPath))) {
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

function sameSpelling(path: string): string {
  return path;
}

// A full case fold, so that every spelling APFS and NTFS treat as one file
// folds to one key: lower, upper, lower again maps the long s, the micro sign,
// `ß` (to `ss`) and the Greek symbol variants together, and the final sigma
// `ς` is mapped to `σ` because `toLowerCase` picks either one by position.
// It can only add overlaps (dotless `ı` meets `i`), never miss one, which is
// the safe direction for a lock. `/` and `.` are unchanged, so containment on
// folded canonical paths is containment on the paths the filesystem sees.
function foldWorkspacePathCase(path: string): string {
  return path
    .normalize("NFC")
    .toLowerCase()
    .toUpperCase()
    .toLowerCase()
    .replaceAll("\u03c2", "\u03c3");
}

function normalizedPathsContain(parent: string, child: string): boolean {
  return portablePathContains(parent, child);
}

function normalizedPathsOverlap(left: string, right: string): boolean {
  return (
    normalizedPathsContain(left, right) || normalizedPathsContain(right, left)
  );
}
