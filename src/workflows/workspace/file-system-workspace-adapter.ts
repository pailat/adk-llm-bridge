/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  findWorkspacePathOverlaps,
  normalizeWorkspaceLeaseRequest,
  type WorkspaceAcquireOptions,
  type WorkspaceAdapter,
  type WorkspaceLease,
  type WorkspaceLeaseConflict,
  type WorkspaceLeaseLossReason,
  type WorkspaceLeaseRequest,
} from "./workspace-adapter.js";

const STATE_VERSION = 1;
const LOCK_OWNER_FILE = "owner.json";
const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 25;
const DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const SAFE_WORKSPACE_DIRECTORY = /^[a-f0-9]{64}$/u;
const SAFE_WORKSPACE_TOMBSTONE = /^lock\.retired\.([a-f0-9]{64})$/u;

export interface FileSystemWorkspaceAdapterOptions {
  /** Absolute host directory used only for coordination metadata. */
  stateDirectory: string;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  lockAcquireTimeoutMs?: number;
  createLeaseId?: () => string;
  now?: () => number;
}

export interface DurableWorkspaceLease extends WorkspaceLease {
  fencingToken: number;
  expiresAt: number;
  lossSignal: AbortSignal;
  renew(): Promise<boolean>;
}

export interface OfflineWorkspaceTombstoneCollectionOptions {
  /** Absolute host-controlled workspace coordination root. */
  root: string;
  /** Nominal acknowledgement that no adapter or writer is active. */
  confirmNoActiveWriters: true;
}

export interface OfflineWorkspaceTombstoneCollectionResult {
  removedTombstones: number;
}

interface PersistedLease extends WorkspaceLeaseRequest {
  leaseId: string;
  acquiredAt: number;
  expiresAt: number;
  fencingToken: number;
}

interface PersistedWorkspaceState {
  version: 1;
  workspaceId: string;
  nextFencingToken: number;
  leases: PersistedLease[];
}

interface WorkspaceFiles {
  directory: string;
  state: string;
  lock: string;
}

interface LockOwner {
  token: string;
  pid: number;
  acquiredAt: number;
}

interface LockedMutation<T> {
  value: T;
  dirty: boolean;
}

interface LocalLease {
  record: PersistedLease;
  expiresAt: number;
  closed: boolean;
  releasing: boolean;
  lossController: AbortController;
  heartbeat?: ReturnType<typeof setInterval>;
  expiryTimer?: ReturnType<typeof setTimeout>;
  renewal?: Promise<boolean>;
}

interface NormalizedOptions {
  stateDirectory: string;
  leaseTtlMs: number;
  heartbeatIntervalMs: number;
  pollIntervalMs: number;
  lockAcquireTimeoutMs: number;
  createLeaseId: () => string;
  now: () => number;
}

interface OfflineTombstone {
  path: string;
  device: number;
  inode: number;
}

/**
 * OFFLINE ONLY: removes retired workspace-lock tombstones after proving that
 * the host-controlled tree has no lock or candidate. This is not safe to run
 * concurrently with adapters or writers, and intentionally has no age-based
 * mode.
 */
export function collectFileSystemWorkspaceTombstonesOffline(
  options: OfflineWorkspaceTombstoneCollectionOptions,
): OfflineWorkspaceTombstoneCollectionResult {
  const root = offlineRoot(
    options?.root,
    options?.confirmNoActiveWriters,
    "workspace",
  );
  const tombstones: OfflineTombstone[] = [];
  scanWorkspaceOfflineTree(root, root, tombstones);
  for (const tombstone of tombstones) {
    removeOfflineTombstone(tombstone, "workspace");
  }
  return Object.freeze({ removedTombstones: tombstones.length });
}

/**
 * Durable single-host coordinator for cross-process workspace ownership.
 *
 * `fencingToken` is metadata exposed to the host. This adapter cannot prevent
 * a stale process from writing to external resources unless each resource
 * writer validates the latest token before accepting a write.
 */
export class FileSystemWorkspaceAdapter implements WorkspaceAdapter {
  readonly #options: NormalizedOptions;
  readonly #localLeases = new Set<LocalLease>();
  #disposed = false;

  constructor(options: FileSystemWorkspaceAdapterOptions) {
    this.#options = normalizeOptions(options);
    mkdirSync(this.#options.stateDirectory, { recursive: true, mode: 0o700 });
  }

  async acquire(
    request: WorkspaceLeaseRequest,
    options: WorkspaceAcquireOptions = {},
  ): Promise<DurableWorkspaceLease> {
    if (this.#disposed) {
      throw new Error("FileSystemWorkspaceAdapter is disposed");
    }
    const normalized = normalizeWorkspaceLeaseRequest(request);
    throwIfAborted(options.signal);

    while (true) {
      const record = await this.withLockedState(
        normalized.workspaceId,
        options.signal,
        (state) => {
          const dirty = purgeExpired(state, this.#options.now());
          if (stateConflicts(state, normalized).length > 0) {
            return { value: undefined, dirty };
          }

          const fencingToken = nextFencingToken(state);
          const acquiredAt = this.#options.now();
          const leaseId = requiredLeaseId(this.#options.createLeaseId());
          if (state.leases.some((lease) => lease.leaseId === leaseId)) {
            throw new Error(`Workspace lease id is already active: ${leaseId}`);
          }
          const lease: PersistedLease = {
            ...normalized,
            leaseId,
            acquiredAt,
            expiresAt: acquiredAt + this.#options.leaseTtlMs,
            fencingToken,
          };
          state.leases.push(lease);
          return { value: lease, dirty: true };
        },
      );
      if (record) return this.createLease(record);
      await abortableDelay(this.#options.pollIntervalMs, options.signal);
    }
  }

  conflicts(request: WorkspaceLeaseRequest): readonly WorkspaceLeaseConflict[] {
    const normalized = normalizeWorkspaceLeaseRequest(request);
    const files = workspaceFiles(
      this.#options.stateDirectory,
      normalized.workspaceId,
    );
    const snapshot = readStateSync(files.state, normalized.workspaceId);
    purgeExpired(snapshot, this.#options.now());
    return Object.freeze(stateConflicts(snapshot, normalized));
  }

  /**
   * Reports local leases lost and stops their timers without releasing durable
   * state. Calling it twice is safe. Process death has the same persistence
   * behavior: leases expire.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const lease of this.#localLeases) {
      this.reportLoss(lease, "workspace_adapter_disposed");
      this.stopLifecycle(lease);
    }
    this.#localLeases.clear();
  }

  private createLease(record: PersistedLease): DurableWorkspaceLease {
    const local: LocalLease = {
      record: Object.freeze({
        ...record,
        writePaths: Object.freeze([...record.writePaths]),
      }),
      expiresAt: record.expiresAt,
      closed: false,
      releasing: false,
      lossController: new AbortController(),
    };
    this.#localLeases.add(local);
    const lease = Object.freeze({
      ...local.record,
      get expiresAt() {
        return local.expiresAt;
      },
      lossSignal: local.lossController.signal,
      renew: () => this.renewLocal(local),
      release: () => this.releaseLocal(local),
    });
    this.startHeartbeat(local);
    this.scheduleExpiry(local);
    return lease;
  }

  private startHeartbeat(local: LocalLease): void {
    if (this.#disposed || local.closed || local.heartbeat) return;
    local.heartbeat = setInterval(() => {
      void this.renewLocal(local).then(
        (renewed) => {
          if (!renewed) this.stopHeartbeat(local);
        },
        () => {
          // A transient filesystem failure must not create an unhandled
          // rejection. The expiry timer remains the recovery boundary.
          if (this.#options.now() >= local.expiresAt) {
            this.markLost(local);
          }
        },
      );
    }, this.#options.heartbeatIntervalMs);
    local.heartbeat.unref?.();
  }

  private stopHeartbeat(local: LocalLease): void {
    if (!local.heartbeat) return;
    clearInterval(local.heartbeat);
    local.heartbeat = undefined;
  }

  private scheduleExpiry(local: LocalLease): void {
    if (local.closed || local.lossController.signal.aborted) return;
    if (local.expiryTimer) clearTimeout(local.expiryTimer);
    const delay = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(0, local.expiresAt - this.#options.now()),
    );
    local.expiryTimer = setTimeout(() => {
      local.expiryTimer = undefined;
      if (local.closed || local.lossController.signal.aborted) return;
      if (this.#options.now() >= local.expiresAt) {
        this.markLost(local);
        return;
      }
      this.scheduleExpiry(local);
    }, delay);
    local.expiryTimer.unref?.();
  }

  private stopLifecycle(local: LocalLease): void {
    this.stopHeartbeat(local);
    if (!local.expiryTimer) return;
    clearTimeout(local.expiryTimer);
    local.expiryTimer = undefined;
  }

  private renewLocal(local: LocalLease): Promise<boolean> {
    if (this.#disposed || local.closed) return Promise.resolve(false);
    if (local.renewal) return local.renewal;
    const renewal = this.renewPersisted(local).finally(() => {
      if (local.renewal === renewal) local.renewal = undefined;
    });
    local.renewal = renewal;
    return renewal;
  }

  private async renewPersisted(local: LocalLease): Promise<boolean> {
    const renewed = await this.withLockedState(
      local.record.workspaceId,
      undefined,
      (state) => {
        const dirty = purgeExpired(state, this.#options.now());
        const lease = matchingLease(state, local.record);
        if (!lease) return { value: undefined, dirty };
        lease.expiresAt = this.#options.now() + this.#options.leaseTtlMs;
        return { value: lease.expiresAt, dirty: true };
      },
    );
    if (renewed === undefined) {
      this.markLost(local);
      return false;
    }
    local.expiresAt = renewed;
    this.scheduleExpiry(local);
    return true;
  }

  private async releaseLocal(local: LocalLease): Promise<boolean> {
    if (local.closed || local.releasing) return false;
    local.releasing = true;
    try {
      const released = await this.withLockedState(
        local.record.workspaceId,
        undefined,
        (state) => {
          const dirty = purgeExpired(state, this.#options.now());
          const index = state.leases.findIndex(
            (lease) =>
              lease.leaseId === local.record.leaseId &&
              lease.fencingToken === local.record.fencingToken,
          );
          if (index < 0) return { value: false, dirty };
          state.leases.splice(index, 1);
          return { value: true, dirty: true };
        },
      );
      local.closed = true;
      this.stopLifecycle(local);
      this.#localLeases.delete(local);
      if (!released) this.reportLoss(local, "workspace_lease_lost");
      return released;
    } finally {
      local.releasing = false;
    }
  }

  private markLost(local: LocalLease): void {
    if (local.closed) return;
    local.closed = true;
    this.reportLoss(local, "workspace_lease_lost");
    this.stopLifecycle(local);
    this.#localLeases.delete(local);
  }

  private reportLoss(
    local: LocalLease,
    code: WorkspaceLeaseLossReason["code"],
  ): void {
    if (local.lossController.signal.aborted) return;
    const reason: WorkspaceLeaseLossReason = Object.freeze({
      code,
      message:
        code === "workspace_adapter_disposed"
          ? "Workspace adapter was disposed while the lease was active"
          : "Durable workspace lease ownership was lost",
      workspaceId: local.record.workspaceId,
      leaseId: local.record.leaseId,
      fencingToken: local.record.fencingToken,
    });
    local.lossController.abort(reason);
  }

  private async withLockedState<T>(
    workspaceId: string,
    signal: AbortSignal | undefined,
    operation: (state: PersistedWorkspaceState) => LockedMutation<T>,
  ): Promise<T> {
    const files = ensureWorkspaceFilesSync(
      this.#options.stateDirectory,
      workspaceId,
    );
    const owner = await acquireLock(files.lock, this.#options, signal);
    try {
      const state = readStateSync(files.state, workspaceId);
      const result = operation(state);
      if (result.dirty) writeStateSync(files, state, owner.token);
      return result.value;
    } finally {
      releaseLockSync(files.lock, owner.token);
    }
  }
}

function normalizeOptions(
  options: FileSystemWorkspaceAdapterOptions,
): NormalizedOptions {
  if (!options || typeof options.stateDirectory !== "string") {
    throw new TypeError("Workspace stateDirectory is required");
  }
  if (!isAbsolute(options.stateDirectory)) {
    throw new TypeError("Workspace stateDirectory must be absolute");
  }
  const normalized = {
    stateDirectory: resolve(options.stateDirectory),
    leaseTtlMs: options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
    heartbeatIntervalMs:
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    lockAcquireTimeoutMs:
      options.lockAcquireTimeoutMs ?? DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS,
    createLeaseId: options.createLeaseId ?? randomUUID,
    now: options.now ?? Date.now,
  };
  for (const [name, value] of Object.entries(normalized)) {
    if (typeof value === "string" || typeof value === "function") continue;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(
        `Workspace adapter ${name} must be a positive integer`,
      );
    }
  }
  if (normalized.heartbeatIntervalMs >= normalized.leaseTtlMs) {
    throw new TypeError(
      "Workspace heartbeatIntervalMs must be less than leaseTtlMs",
    );
  }
  return normalized;
}

function workspaceFiles(
  stateDirectory: string,
  workspaceId: string,
): WorkspaceFiles {
  const key = createHash("sha256").update(workspaceId).digest("hex");
  const directory = join(stateDirectory, key);
  return {
    directory,
    state: join(directory, "state.json"),
    lock: join(directory, "lock"),
  };
}

function ensureWorkspaceFilesSync(
  stateDirectory: string,
  workspaceId: string,
): WorkspaceFiles {
  const files = workspaceFiles(stateDirectory, workspaceId);
  mkdirSync(files.directory, { recursive: true, mode: 0o700 });
  return files;
}

function offlineRoot(
  value: string | undefined,
  confirmed: boolean | undefined,
  kind: string,
): string {
  if (confirmed !== true) {
    throw new TypeError(
      `Offline ${kind} tombstone collection requires confirmNoActiveWriters: true`,
    );
  }
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new TypeError(
      `Offline ${kind} tombstone collection root must be absolute`,
    );
  }
  const root = resolve(value);
  const info = lstatSync(root);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(
      `Offline ${kind} tombstone collection root is not a safe directory`,
    );
  }
  return root;
}

function scanWorkspaceOfflineTree(
  root: string,
  directory: string,
  tombstones: OfflineTombstone[],
): void {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
      throw new Error(
        `Offline workspace tombstone collection rejects symlinks: ${path}`,
      );
    }
    if (entry === "lock" || entry.startsWith("lock.candidate-")) {
      throw new Error(
        `Offline workspace tombstone collection found an active lock or candidate: ${path}`,
      );
    }
    if (!info.isDirectory() && !info.isFile()) {
      throw new Error(
        `Offline workspace tombstone collection found an unsafe entry: ${path}`,
      );
    }
    const match = SAFE_WORKSPACE_TOMBSTONE.exec(entry);
    if (
      match &&
      info.isDirectory() &&
      dirname(directory) === root &&
      SAFE_WORKSPACE_DIRECTORY.test(basename(directory))
    ) {
      assertValidWorkspaceTombstone(path, match[1] as string);
      tombstones.push({ path, device: info.dev, inode: info.ino });
      continue;
    }
    if (entry.startsWith("lock.retired.")) {
      throw new Error(
        `Offline workspace tombstone is malformed or misplaced: ${path}`,
      );
    }
    if (info.isDirectory()) {
      scanWorkspaceOfflineTree(root, path, tombstones);
    }
  }
}

function assertValidWorkspaceTombstone(
  tombstonePath: string,
  expectedTokenKey: string,
): void {
  const entries = readdirSync(tombstonePath);
  if (entries.length !== 1 || entries[0] !== LOCK_OWNER_FILE) {
    throw new Error(
      `Offline workspace tombstone has unsafe contents: ${tombstonePath}`,
    );
  }
  const ownerPath = join(tombstonePath, LOCK_OWNER_FILE);
  const ownerInfo = lstatSync(ownerPath);
  if (ownerInfo.isSymbolicLink() || !ownerInfo.isFile()) {
    throw new Error(
      `Offline workspace tombstone has an unsafe owner: ${tombstonePath}`,
    );
  }
  const owner = parseLockOwner(readFileSync(ownerPath, "utf8"));
  if (tokenKey(owner.token) !== expectedTokenKey) {
    throw new Error(
      `Offline workspace tombstone token does not match its owner: ${tombstonePath}`,
    );
  }
}

function removeOfflineTombstone(
  tombstone: OfflineTombstone,
  kind: string,
): void {
  const current = lstatSync(tombstone.path);
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    current.dev !== tombstone.device ||
    current.ino !== tombstone.inode
  ) {
    throw new Error(
      `Offline ${kind} tombstone changed during collection: ${tombstone.path}`,
    );
  }
  rmSync(tombstone.path, { recursive: true });
  fsyncDirectorySync(dirname(tombstone.path));
}

async function acquireLock(
  lockPath: string,
  options: NormalizedOptions,
  signal?: AbortSignal,
): Promise<LockOwner> {
  const deadline = Date.now() + options.lockAcquireTimeoutMs;
  while (true) {
    throwIfAborted(signal);
    const owner = tryAcquireLock(lockPath);
    if (owner) return owner;
    recoverDeadLockSync(lockPath);
    if (Date.now() >= deadline) {
      throw new Error(`Timed out acquiring workspace lock: ${lockPath}`);
    }
    await abortableDelay(options.pollIntervalMs, signal);
  }
}

function tryAcquireLock(lockPath: string): LockOwner | undefined {
  const owner = newLockOwner();
  const candidate = `${lockPath}.candidate-${owner.token}`;
  mkdirSync(candidate, { mode: 0o700 });
  try {
    writeDurableFileSync(
      join(candidate, LOCK_OWNER_FILE),
      JSON.stringify(owner),
    );
    try {
      renameSync(candidate, lockPath);
      fsyncDirectorySync(resolve(lockPath, ".."));
      return owner;
    } catch (error) {
      if (hasErrorCode(error, "EEXIST") || hasErrorCode(error, "ENOTEMPTY")) {
        return undefined;
      }
      throw error;
    }
  } finally {
    rmSync(candidate, { recursive: true, force: true });
  }
}

function recoverDeadLockSync(lockPath: string): void {
  let owner: LockOwner;
  try {
    owner = parseLockOwner(
      readFileSync(join(lockPath, LOCK_OWNER_FILE), "utf8"),
    );
  } catch {
    // An atomically published lock should always contain a valid owner. A
    // malformed lock is never stolen automatically because ownership cannot
    // be proven dead.
    return;
  }
  if (isProcessAlive(owner.pid)) return;
  retireLockSync(lockPath, owner.token);
}

function retireLockSync(lockPath: string, observedToken: string): void {
  const retired = `${lockPath}.retired.${tokenKey(observedToken)}`;
  try {
    renameSync(lockPath, retired);
  } catch (error) {
    if (
      hasErrorCode(error, "ENOENT") ||
      hasErrorCode(error, "EEXIST") ||
      hasErrorCode(error, "ENOTEMPTY")
    ) {
      return;
    }
    throw error;
  }
  fsyncDirectorySync(resolve(lockPath, ".."));
}

function releaseLockSync(lockPath: string, token: string): void {
  if (!lockTokenMatchesSync(lockPath, token)) return;
  retireLockSync(lockPath, token);
}

function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function readStateSync(
  statePath: string,
  workspaceId: string,
): PersistedWorkspaceState {
  try {
    return parseState(readFileSync(statePath, "utf8"), workspaceId);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return emptyState(workspaceId);
    throw error;
  }
}

function writeStateSync(
  files: WorkspaceFiles,
  state: PersistedWorkspaceState,
  lockToken: string,
): void {
  const temporary = `${files.state}.tmp-${randomUUID()}`;
  try {
    writeDurableFileSync(temporary, serializeState(state));
    if (!lockTokenMatchesSync(files.lock, lockToken)) {
      throw new Error("Workspace lock ownership changed before state commit");
    }
    renameSync(temporary, files.state);
    fsyncDirectorySync(files.directory);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function writeDurableFileSync(path: string, content: string): void {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, content, { encoding: "utf8" });
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectorySync(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch (error) {
    if (
      hasErrorCode(error, "EINVAL") ||
      hasErrorCode(error, "ENOTSUP") ||
      hasErrorCode(error, "EPERM") ||
      hasErrorCode(error, "EISDIR")
    ) {
      return;
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function lockTokenMatchesSync(lockPath: string, token: string): boolean {
  try {
    return (
      parseLockOwner(readFileSync(join(lockPath, LOCK_OWNER_FILE), "utf8"))
        .token === token
    );
  } catch {
    return false;
  }
}

function parseLockOwner(input: string): LockOwner {
  const value: unknown = JSON.parse(input);
  if (
    !isRecord(value) ||
    typeof value.token !== "string" ||
    !value.token ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    typeof value.acquiredAt !== "number" ||
    !Number.isFinite(value.acquiredAt)
  ) {
    throw new Error("Invalid workspace lock owner");
  }
  return {
    token: value.token,
    pid: value.pid as number,
    acquiredAt: value.acquiredAt,
  };
}

function parseState(
  input: string,
  workspaceId: string,
): PersistedWorkspaceState {
  const value: unknown = JSON.parse(input);
  if (
    !isRecord(value) ||
    value.version !== STATE_VERSION ||
    value.workspaceId !== workspaceId ||
    !Number.isSafeInteger(value.nextFencingToken) ||
    (value.nextFencingToken as number) < 0 ||
    !Array.isArray(value.leases)
  ) {
    throw new Error(`Invalid workspace state for ${workspaceId}`);
  }
  const leases = value.leases.map((lease) => parseLease(lease, workspaceId));
  const maxFencingToken = leases.reduce(
    (maximum, lease) => Math.max(maximum, lease.fencingToken),
    0,
  );
  if ((value.nextFencingToken as number) < maxFencingToken) {
    throw new Error(`Invalid workspace fencing sequence for ${workspaceId}`);
  }
  return {
    version: STATE_VERSION,
    workspaceId,
    nextFencingToken: value.nextFencingToken as number,
    leases,
  };
}

function parseLease(input: unknown, workspaceId: string): PersistedLease {
  const writePaths = isRecord(input) ? input.writePaths : undefined;
  if (
    !isRecord(input) ||
    typeof input.leaseId !== "string" ||
    !input.leaseId ||
    typeof input.ownerId !== "string" ||
    !Array.isArray(writePaths) ||
    !writePaths.every((path) => typeof path === "string") ||
    typeof input.acquiredAt !== "number" ||
    !Number.isFinite(input.acquiredAt) ||
    typeof input.expiresAt !== "number" ||
    !Number.isFinite(input.expiresAt) ||
    !Number.isSafeInteger(input.fencingToken) ||
    (input.fencingToken as number) <= 0
  ) {
    throw new Error(`Invalid persisted workspace lease for ${workspaceId}`);
  }
  const normalized = normalizeWorkspaceLeaseRequest({
    workspaceId,
    ownerId: input.ownerId,
    writePaths: writePaths as string[],
  });
  if (
    normalized.ownerId !== input.ownerId ||
    normalized.writePaths.length !== writePaths.length ||
    normalized.writePaths.some((path, index) => path !== writePaths[index])
  ) {
    throw new Error(
      `Non-canonical persisted workspace lease for ${workspaceId}`,
    );
  }
  return {
    ...normalized,
    leaseId: input.leaseId,
    acquiredAt: input.acquiredAt,
    expiresAt: input.expiresAt,
    fencingToken: input.fencingToken as number,
  };
}

function emptyState(workspaceId: string): PersistedWorkspaceState {
  return {
    version: STATE_VERSION,
    workspaceId,
    nextFencingToken: 0,
    leases: [],
  };
}

function serializeState(state: PersistedWorkspaceState): string {
  return `${JSON.stringify({
    ...state,
    leases: [...state.leases].sort(
      (left, right) => left.fencingToken - right.fencingToken,
    ),
  })}\n`;
}

function purgeExpired(state: PersistedWorkspaceState, now: number): boolean {
  const active = state.leases.filter((lease) => lease.expiresAt > now);
  if (active.length === state.leases.length) return false;
  state.leases = active;
  return true;
}

function stateConflicts(
  state: PersistedWorkspaceState,
  request: WorkspaceLeaseRequest,
): WorkspaceLeaseConflict[] {
  const conflicts: WorkspaceLeaseConflict[] = [];
  for (const lease of state.leases) {
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
        fencingToken: lease.fencingToken,
        expiresAt: lease.expiresAt,
        overlaps,
      }),
    );
  }
  return conflicts;
}

function matchingLease(
  state: PersistedWorkspaceState,
  expected: PersistedLease,
): PersistedLease | undefined {
  return state.leases.find(
    (lease) =>
      lease.leaseId === expected.leaseId &&
      lease.fencingToken === expected.fencingToken,
  );
}

function nextFencingToken(state: PersistedWorkspaceState): number {
  if (state.nextFencingToken >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Workspace fencing token sequence is exhausted");
  }
  state.nextFencingToken++;
  return state.nextFencingToken;
}

function requiredLeaseId(value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Workspace lease id must be a non-empty string");
  }
  return value.trim();
}

function newLockOwner(): LockOwner {
  return { token: randomUUID(), pid: process.pid, acquiredAt: Date.now() };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, "ESRCH");
  }
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }, delayMs);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      rejectPromise(
        signal?.reason ?? new Error("Workspace acquisition aborted"),
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new Error("Workspace acquisition aborted");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === code,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
