import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { throwIfAborted } from "../internal/abort.js";
import { canonicalJson, legacyJson } from "../internal/canonical-hash.js";
import { sha256HexSync } from "../internal/canonical-hash-node.js";
import {
  recoverDeadDirectoryLock,
  releaseDirectoryLock,
  tryAcquireDirectoryLock,
} from "../internal/directory-lock.js";
import {
  isWorkflowIdentifier,
  type WorkflowIdentifierGrammar,
} from "../internal/identifiers.js";
import { workflowIntegrationIntentDigest } from "../internal/integration-intent.js";
import { monotonicNow } from "../internal/monotonic-clock.js";
import { portablePathProblem } from "../internal/portable-path.js";
import { optionalJsonObject } from "../resources/json.js";
import type {
  ProvisionedWorkspace,
  WorkspaceDescriptor,
  WorkspaceProvisioner,
  WorkspaceProvisionOptions,
  WorkspaceProvisionRequest,
} from "../resources/workspace-provisioner.js";
import {
  assertChangeSetMatchesReceipt,
  createWorkflowChangeSet,
  normalizeAuthoritativeIntegrationRequest,
  type WorkflowChangeEntry,
  type WorkflowChangeEntryKind,
  type WorkflowChangeEntryMode,
  type WorkflowChangeInspectionRequest,
  type WorkflowChangeInspector,
  type WorkflowChangeOperationOptions,
  type WorkflowChangeSet,
  type WorkflowCommitDriver,
  type WorkflowCommitDriverInput,
  type WorkflowCommitPreparation,
  type WorkflowCommitPreparationInput,
  type WorkflowCommitResult,
  type WorkflowIntegrationDriver,
  type WorkflowIntegrationRequest,
  type WorkflowIntegrationResult,
} from "../workspace/change-driver.js";
import {
  InMemoryWorkflowHostMutationJournal,
  WORKFLOW_WORKSPACE_ATTACHMENT,
  type WorkflowHostMutationJournal,
  type WorkflowHostMutationRecord,
  type WorkflowRepositoryMutationLease,
  type WorkflowRepositoryMutationLock,
  type WorkflowWorkspaceAttachment,
  type WorkflowWorkspaceRecoveryPort,
} from "../workspace/mutation-journal.js";

const ABORTED_MESSAGE = "Git workflow operation aborted";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const SAFE_COMPONENT = /[^A-Za-z0-9._-]+/gu;
const GIT_OBJECT = /^[a-f0-9]{40,64}$/u;
const HOST_BRAND = Symbol("NodeGitWorktreeHost");
const REPOSITORY_BRAND = Symbol("NodeGitRepositoryHost");

/** Options for {@link NodeGitWorktreeChangeDriver.create}. */
export interface NodeGitWorktreeChangeDriverOptions {
  /** Root of the Git worktree to branch from; must be the repository top level. */
  repoRoot: string;
  /** Directory that holds the disposable worktrees; must differ from `repoRoot`. */
  worktreesRoot: string;
  /** Revision resolved to an immutable commit when the driver is created. */
  baseRevision: string;
  /**
   * Timeout for each Git command, also the default lock acquisition timeout.
   *
   * @defaultValue 30000
   */
  commandTimeoutMs?: number;
  /**
   * Generates workspace ids.
   *
   * @defaultValue `crypto.randomUUID`
   */
  createWorkspaceId?: () => string;
  /**
   * Clock used for journal timestamps.
   *
   * @defaultValue `Date.now`
   */
  now?: () => number;
  /** Share this durable journal with the live receipt authority. */
  mutationJournal?: WorkflowHostMutationJournal;
  /**
   * Shared with every host operation that checks out or moves target refs.
   * Defaults to a cross-process directory lock under
   * `<git common dir>/adk-workflow-locks`.
   */
  repositoryMutationLock?: WorkflowRepositoryMutationLock;
}

/** Branded host handle for the repository; the target of integration. */
export interface NodeGitRepositoryHost {
  /** Discriminator for the host kind. */
  readonly kind: "git-repository";
  /** Canonical repository root. */
  readonly repoRoot: string;
  /** Brand that proves the handle was issued by the driver. */
  readonly [REPOSITORY_BRAND]: true;
}

/** Branded host handle for one provisioned worktree. */
export interface NodeGitWorktreeHost {
  /** Discriminator for the host kind. */
  readonly kind: "git-worktree";
  /** Identity of the provisioned workspace. */
  readonly workspaceId: string;
  /** Execution that owns the workspace. */
  readonly executionId: string;
  /** Task that owns the workspace. */
  readonly taskId: string;
  /** Canonical repository root. */
  readonly repoRoot: string;
  /** Canonical path of the worktree directory. */
  readonly worktreePath: string;
  /** Canonical directory that contains all worktrees. */
  readonly worktreesRoot: string;
  /** Immutable commit the worktree was created from. */
  readonly baseRevision: string;
  /** Brand that proves the handle was issued by the driver. */
  readonly [HOST_BRAND]: true;
}

/**
 * Error codes raised by the Git worktree driver.
 *
 * @remarks
 * `GIT_CONFIGURATION_INVALID` covers caller input only: driver options, a
 * handle or descriptor the driver did not issue, a reused workspace id or an
 * invalid target ref. `GIT_COMMAND_FAILED` means a `git` process failed
 * (nonzero exit, timeout, missing binary) or returned output the driver
 * cannot read. `GIT_ENTRY_UNSUPPORTED` means a tree or filesystem entry is
 * not a regular file, executable file, symlink, directory or submodule.
 */
export type NodeGitWorktreeErrorCode =
  | "GIT_CONFIGURATION_INVALID"
  | "GIT_COMMAND_FAILED"
  | "GIT_ENTRY_UNSUPPORTED"
  | "GIT_WORKTREE_PATH_ESCAPE"
  | "GIT_WORKTREE_STALE"
  | "GIT_SYMLINK_ESCAPE"
  | "GIT_CHANGE_SET_MISMATCH"
  | "GIT_TARGET_STALE"
  | "GIT_COMMIT_NOT_FAST_FORWARD"
  | "GIT_TARGET_CHECKED_OUT"
  | "GIT_MUTATION_AMBIGUOUS";

/** Error raised by the Git worktree driver, discriminated by {@link NodeGitWorktreeErrorCode}. */
export class NodeGitWorktreeError extends Error {
  /** Machine-readable failure code. */
  readonly code: NodeGitWorktreeErrorCode;

  /**
   * @param code - Failure code.
   * @param message - Human-readable description.
   * @param options - Standard error options; `cause` holds the underlying
   * process error for `GIT_COMMAND_FAILED`.
   */
  constructor(
    code: NodeGitWorktreeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NodeGitWorktreeError";
    this.code = code;
  }
}

interface GitCommandOptions {
  signal?: AbortSignal;
  allowExitCodes?: readonly number[];
  env?: NodeJS.ProcessEnv;
}

interface GitCommandResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

type ParsedGitChange =
  | { status: "added" | "modified" | "deleted"; path: string }
  | { status: "renamed"; fromPath: string; toPath: string };

interface PreparedTree {
  workspaceId: string;
  treeId: string;
  tempRoot: string;
}

/** Options for {@link FileSystemWorkflowRepositoryMutationLock}. */
export interface FileSystemWorkflowRepositoryMutationLockOptions {
  /** Directory that holds the lock directories. */
  lockRoot: string;
  /**
   * How long to wait for the lock before failing.
   *
   * @defaultValue 30000
   */
  acquireTimeoutMs?: number;
  /**
   * Delay between acquisition attempts.
   *
   * @defaultValue 10
   */
  retryIntervalMs?: number;
}

/**
 * Cross-process lock with dead-process recovery and token-fenced release.
 *
 * @remarks
 * The lock is a directory under `lockRoot`, published atomically with its
 * owner file, so at most one process holds it. A lock whose owner file cannot
 * be read is never taken over: waiters time out instead. A normal release
 * removes its own tombstone (best effort); tombstones of recovered locks are
 * kept, because a late recovery must not remove a newer holder's lock. Remove
 * them only while no process uses the lock.
 */
export class FileSystemWorkflowRepositoryMutationLock
  implements WorkflowRepositoryMutationLock
{
  readonly #lockRoot: string;
  readonly #acquireTimeoutMs: number;
  readonly #retryIntervalMs: number;

  /**
   * @param options - Lock directory and timing.
   * @throws `TypeError` when a timing option is not a positive safe integer.
   */
  constructor(options: FileSystemWorkflowRepositoryMutationLockOptions) {
    this.#lockRoot = resolve(options.lockRoot);
    this.#acquireTimeoutMs = positiveInteger(
      options.acquireTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      "acquireTimeoutMs",
    );
    this.#retryIntervalMs = positiveInteger(
      options.retryIntervalMs ?? 10,
      "retryIntervalMs",
    );
  }

  /**
   * Acquires the lock for one repository.
   *
   * @remarks
   * A lock whose owner process is dead is reclaimed. Release is fenced by a
   * token, so a stale holder cannot release a lock it no longer owns.
   * Acquisition polls every `retryIntervalMs`.
   *
   * @param repositoryId - Repository identity, hashed into the lock name.
   * @param options - Abort signal.
   * @returns A lease whose `release` resolves false when it was already released or lost.
   * @throws {@link NodeGitWorktreeError} with code `GIT_MUTATION_AMBIGUOUS` when the timeout elapses.
   * @throws The signal's reason when `options` carries an aborted signal.
   */
  async acquire(
    repositoryId: string,
    options: WorkflowChangeOperationOptions = {},
  ): Promise<WorkflowRepositoryMutationLease> {
    const lockPath = join(
      this.#lockRoot,
      `.repository-${createHash("sha256").update(repositoryId).digest("hex")}.lock`,
    );
    const startedAt = monotonicNow();
    await mkdir(this.#lockRoot, { recursive: true });
    while (true) {
      throwIfAborted(options.signal, ABORTED_MESSAGE);
      const owner = tryAcquireDirectoryLock(lockPath);
      if (owner) {
        let released = false;
        return Object.freeze({
          repositoryId,
          release: async () => {
            if (released) return false;
            released = true;
            return releaseDirectoryLock(lockPath, owner.token);
          },
        });
      }
      recoverDeadDirectoryLock(lockPath);
      if (monotonicNow() - startedAt >= this.#acquireTimeoutMs) {
        throw new NodeGitWorktreeError(
          "GIT_MUTATION_AMBIGUOUS",
          "Timed out waiting for the shared repository mutation lock",
        );
      }
      await abortableDelay(this.#retryIntervalMs, options.signal);
    }
  }
}

/**
 * Trusted Node host adapter for disposable Git worktrees.
 *
 * @remarks
 * Inspection is read-only. Commit and integration are deliberately separate
 * mutation ports so callers can place the ownership gate between them. Host
 * handles are branded and tracked, so a handle not issued by this instance is
 * rejected. All paths are canonicalized and checked for containment in
 * `worktreesRoot` to block symlink and path escapes.
 *
 * Every Git subprocess runs with a scrubbed environment: variables that point
 * Git at another repository, index or object store, inject command-line
 * configuration (`GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`,
 * `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>`), change pathspec matching
 * or replace objects are dropped; paths are literal pathspecs and replace refs
 * are ignored. Other host variables, such as `HOME`, `GIT_CONFIG_GLOBAL` and
 * the author identity, pass through.
 */
export class NodeGitWorktreeChangeDriver
  implements
    WorkspaceProvisioner<NodeGitWorktreeHost>,
    WorkflowChangeInspector<NodeGitWorktreeHost>,
    WorkflowCommitDriver<NodeGitWorktreeHost>,
    WorkflowIntegrationDriver<NodeGitRepositoryHost>,
    WorkflowWorkspaceRecoveryPort<NodeGitWorktreeHost>
{
  readonly #repoRoot: string;
  readonly #worktreesRoot: string;
  readonly #baseRevision: string;
  readonly #timeoutMs: number;
  readonly #createWorkspaceId: () => string;
  readonly #now: () => number;
  readonly #journal: WorkflowHostMutationJournal;
  readonly #repositoryMutationLock: WorkflowRepositoryMutationLock;
  readonly #active = new Map<string, NodeGitWorktreeHost>();
  readonly #issued = new WeakSet<NodeGitWorktreeHost>();
  readonly #preparations = new Map<string, PreparedTree>();
  readonly #repository: NodeGitRepositoryHost;

  private constructor(input: {
    repoRoot: string;
    worktreesRoot: string;
    baseRevision: string;
    timeoutMs: number;
    createWorkspaceId: () => string;
    now: () => number;
    mutationJournal: WorkflowHostMutationJournal;
    repositoryMutationLock: WorkflowRepositoryMutationLock;
  }) {
    this.#repoRoot = input.repoRoot;
    this.#worktreesRoot = input.worktreesRoot;
    this.#baseRevision = input.baseRevision;
    this.#timeoutMs = input.timeoutMs;
    this.#createWorkspaceId = input.createWorkspaceId;
    this.#now = input.now;
    this.#journal = input.mutationJournal;
    this.#repositoryMutationLock = input.repositoryMutationLock;
    this.#repository = Object.freeze({
      kind: "git-repository",
      repoRoot: this.#repoRoot,
      [REPOSITORY_BRAND]: true as const,
    });
  }

  /**
   * Validates the repository and resolves the base revision to an immutable commit.
   *
   * @param options - Repository, worktree root and base revision.
   * @returns A ready driver.
   * @throws {@link NodeGitWorktreeError} with code `GIT_CONFIGURATION_INVALID` when `commandTimeoutMs` is not a positive safe integer, the roots are invalid or equal, `repoRoot` is not the Git top level, or `baseRevision` is not a safe revision or does not resolve to a commit; `GIT_COMMAND_FAILED` when Git fails or reports a common directory that does not exist.
   */
  static async create(
    options: NodeGitWorktreeChangeDriverOptions,
  ): Promise<NodeGitWorktreeChangeDriver> {
    const timeoutMs = configuration(() =>
      positiveInteger(
        options.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS,
        "commandTimeoutMs",
      ),
    );
    const requestedRevision = configuration(() =>
      requiredRevision(options.baseRevision, "baseRevision"),
    );
    const repoRoot = await canonicalDirectory(options.repoRoot, "repoRoot");
    await mkdir(resolve(options.worktreesRoot), { recursive: true });
    const worktreesRoot = await canonicalDirectory(
      options.worktreesRoot,
      "worktreesRoot",
    );
    if (repoRoot === worktreesRoot) {
      throw new NodeGitWorktreeError(
        "GIT_CONFIGURATION_INVALID",
        "worktreesRoot must be different from repoRoot",
      );
    }
    // Git exits 128 outside a repository and for an unknown revision; both
    // are caller configuration, not a failed command.
    const topLevel = await runGit(
      repoRoot,
      ["rev-parse", "--show-toplevel"],
      timeoutMs,
      { allowExitCodes: [128] },
    );
    if (
      topLevel.exitCode !== 0 ||
      (await realpath(textOutput(topLevel.stdout))) !== repoRoot
    ) {
      throw new NodeGitWorktreeError(
        "GIT_CONFIGURATION_INVALID",
        "repoRoot must identify the Git worktree root",
      );
    }
    const gitCommonDirectory = await realpath(
      resolve(
        repoRoot,
        textOutput(
          (await runGit(repoRoot, ["rev-parse", "--git-common-dir"], timeoutMs))
            .stdout,
        ),
      ),
    ).catch((error: unknown) => {
      throw new NodeGitWorktreeError(
        "GIT_COMMAND_FAILED",
        "git rev-parse returned a common directory that does not exist",
        { cause: error },
      );
    });
    const resolved = await runGit(
      repoRoot,
      [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${requestedRevision}^{commit}`,
      ],
      timeoutMs,
      { allowExitCodes: [128] },
    );
    const resolvedRevision = textOutput(resolved.stdout);
    if (resolved.exitCode !== 0 || !GIT_OBJECT.test(resolvedRevision)) {
      throw new NodeGitWorktreeError(
        "GIT_CONFIGURATION_INVALID",
        "baseRevision did not resolve to an immutable Git commit",
      );
    }
    return new NodeGitWorktreeChangeDriver({
      repoRoot,
      worktreesRoot,
      baseRevision: resolvedRevision,
      timeoutMs,
      createWorkspaceId: options.createWorkspaceId ?? randomUUID,
      now: options.now ?? Date.now,
      mutationJournal:
        options.mutationJournal ?? new InMemoryWorkflowHostMutationJournal(),
      repositoryMutationLock:
        options.repositoryMutationLock ??
        new FileSystemWorkflowRepositoryMutationLock({
          lockRoot: join(gitCommonDirectory, "adk-workflow-locks"),
          acquireTimeoutMs: timeoutMs,
        }),
    });
  }

  /** Host handle used as the target of {@link NodeGitWorktreeChangeDriver.integrate}. */
  get repository(): NodeGitRepositoryHost {
    return this.#repository;
  }

  /** Immutable commit all worktrees are created from. */
  get baseRevision(): string {
    return this.#baseRevision;
  }

  /** Host checkout/reset operations must acquire this same lock contract. */
  get repositoryMutationLock(): WorkflowRepositoryMutationLock {
    return this.#repositoryMutationLock;
  }

  /**
   * Creates a detached worktree at the base revision.
   *
   * @param request - Execution, task and parameters identifying the workspace.
   * @param options - Abort signal.
   * @returns The workspace descriptor, host handle and an idempotent `release`.
   * @throws {@link NodeGitWorktreeError} with code `GIT_CONFIGURATION_INVALID` when the generated workspace id is already active, `GIT_WORKTREE_PATH_ESCAPE` when the path leaves `worktreesRoot`, or `GIT_WORKTREE_STALE` when HEAD is not the base revision.
   */
  async provision(
    request: WorkspaceProvisionRequest,
    options: WorkspaceProvisionOptions = {},
  ): Promise<ProvisionedWorkspace<NodeGitWorktreeHost>> {
    throwIfAborted(options.signal, ABORTED_MESSAGE);
    const executionId = requiredIdentity(
      request.executionId,
      "executionId",
      "record",
    );
    const taskId = requiredIdentity(request.taskId, "taskId", "record");
    const workspaceId = requiredIdentity(
      this.#createWorkspaceId(),
      "workspaceId",
    );
    if (this.#active.has(workspaceId)) {
      throw new NodeGitWorktreeError(
        "GIT_CONFIGURATION_INVALID",
        `Workspace identity is already active: ${workspaceId}`,
      );
    }
    const parameters = optionalJsonObject(request.parameters, "parameters");
    const worktreePath = this.#workspacePath({
      workspaceId,
      executionId,
      taskId,
      revision: this.#baseRevision,
      parameters,
    });
    assertContained(this.#worktreesRoot, worktreePath);
    try {
      await this.#git(
        this.#repoRoot,
        ["worktree", "add", "--detach", worktreePath, this.#baseRevision],
        options,
      );
    } catch (error) {
      // execFile can report abort/timeout after Git has registered the
      // worktree. Reconcile canonical host state before surfacing the error.
      if (!(await this.#isRegisteredWorktree(worktreePath))) throw error;
    }
    const canonicalWorktree = await realpath(worktreePath);
    assertContained(this.#worktreesRoot, canonicalWorktree);
    const reconciledHead = await this.#resolveCommit(
      canonicalWorktree,
      "HEAD",
      {},
    );
    if (reconciledHead !== this.#baseRevision) {
      throw new NodeGitWorktreeError(
        "GIT_WORKTREE_STALE",
        "Provisioned worktree does not match its immutable base revision",
      );
    }
    const host = this.#issueHost({
      workspaceId,
      executionId,
      taskId,
      worktreePath: canonicalWorktree,
      baseRevision: this.#baseRevision,
    });
    const descriptor: WorkspaceDescriptor = Object.freeze({
      workspaceId,
      providerId: "node-git-worktree",
      executionId,
      taskId,
      revision: this.#baseRevision,
      parameters,
    });
    let released = false;
    return Object.freeze({
      descriptor,
      host,
      release: async () => {
        if (released) return false;
        const removed = await this.cleanup(host);
        if (removed) released = true;
        return removed;
      },
    });
  }

  /**
   * Re-attaches to a durable workspace after a restart.
   *
   * @param descriptor - Complete durable descriptor.
   * @param options - Abort signal.
   * @returns The attachment, or undefined when the worktree no longer exists.
   * @throws {@link NodeGitWorktreeError} with code `GIT_WORKTREE_STALE` when an active workspace or HEAD does not match the descriptor, or `GIT_WORKTREE_PATH_ESCAPE` when the path was replaced or redirected.
   */
  async attach(
    descriptor: WorkspaceDescriptor,
    options: WorkflowChangeOperationOptions = {},
  ): Promise<WorkflowWorkspaceAttachment<NodeGitWorktreeHost> | undefined> {
    throwIfAborted(options.signal, ABORTED_MESSAGE);
    const normalized = this.#normalizeDescriptor(descriptor);
    const active = this.#active.get(normalized.workspaceId);
    const canonicalPath = this.#workspacePath(normalized);
    const legacyPath = this.#workspacePath(normalized, "legacy");
    if (active) {
      const expectedPath = active.worktreePath;
      if (
        active.executionId !== normalized.executionId ||
        active.taskId !== normalized.taskId ||
        active.baseRevision !== normalized.revision ||
        (expectedPath !== canonicalPath && expectedPath !== legacyPath)
      ) {
        throw new NodeGitWorktreeError(
          "GIT_WORKTREE_STALE",
          "Active workspace does not match the complete durable descriptor",
        );
      }
      const canonical = await realpath(expectedPath).catch(() => undefined);
      if (canonical !== expectedPath) {
        throw new NodeGitWorktreeError(
          "GIT_WORKTREE_PATH_ESCAPE",
          "Active durable workspace path was replaced or redirected",
        );
      }
      await this.#assertHead(active, options);
      return this.#attachment(normalized, active);
    }
    // Older worktrees live under a legacy directory name; keep resolving them.
    let expectedPath = canonicalPath;
    let canonical = await realpath(expectedPath).catch(() => undefined);
    if (!canonical && legacyPath !== canonicalPath) {
      expectedPath = legacyPath;
      canonical = await realpath(expectedPath).catch(() => undefined);
    }
    if (!canonical) return undefined;
    if (canonical !== expectedPath) {
      throw new NodeGitWorktreeError(
        "GIT_WORKTREE_PATH_ESCAPE",
        "Durable workspace path was replaced or redirected",
      );
    }
    assertContained(this.#worktreesRoot, canonical);
    const host = this.#issueHost({
      workspaceId: normalized.workspaceId,
      executionId: normalized.executionId,
      taskId: normalized.taskId,
      worktreePath: canonical,
      baseRevision: normalized.revision,
    });
    try {
      await this.#assertHead(host, options);
    } catch (error) {
      this.#active.delete(host.workspaceId);
      throw error;
    }
    return this.#attachment(normalized, host);
  }

  /**
   * Like {@link NodeGitWorktreeChangeDriver.attach} but a missing workspace is an error.
   *
   * @param descriptor - Complete durable descriptor.
   * @param options - Abort signal.
   * @returns The attachment.
   * @throws {@link NodeGitWorktreeError} with code `GIT_WORKTREE_STALE` when the workspace is missing or stale.
   */
  async recover(
    descriptor: WorkspaceDescriptor,
    options: WorkflowChangeOperationOptions = {},
  ): Promise<WorkflowWorkspaceAttachment<NodeGitWorktreeHost>> {
    const attachment = await this.attach(descriptor, options);
    if (!attachment) {
      throw new NodeGitWorktreeError(
        "GIT_WORKTREE_STALE",
        `Durable workspace is missing: ${descriptor.workspaceId}`,
      );
    }
    return attachment;
  }

  /**
   * Removes a worktree.
   *
   * @param workspace - Host handle issued by this driver.
   * @param options - Abort signal.
   * @returns True when removed, false when the workspace was not active.
   */
  async cleanup(
    workspace: NodeGitWorktreeHost,
    options: WorkflowChangeOperationOptions = {},
  ): Promise<boolean> {
    this.#assertOwnedWorkspace(workspace);
    if (!this.#active.has(workspace.workspaceId)) return false;
    throwIfAborted(options.signal, ABORTED_MESSAGE);
    try {
      await this.#git(
        this.#repoRoot,
        ["worktree", "remove", "--force", workspace.worktreePath],
        options,
      );
    } catch (error) {
      if (await this.#worktreeExists(workspace.worktreePath)) {
        try {
          // The caller's signal no longer decides the outcome once removal may
          // have started. Finish the exact targeted cleanup and then inspect.
          await this.#git(
            this.#repoRoot,
            ["worktree", "remove", "--force", workspace.worktreePath],
            {},
          );
        } catch (retryError) {
          if (await this.#worktreeExists(workspace.worktreePath)) {
            throw retryError;
          }
        }
      }
      if (await this.#worktreeExists(workspace.worktreePath)) throw error;
    }
    this.#active.delete(workspace.workspaceId);
    return true;
  }

  /**
   * Computes the change set of a worktree against its base revision, read-only.
   *
   * @param workspace - Host handle issued by this driver.
   * @param request - Identity the change set must carry.
   * @param options - Abort signal.
   * @returns The digest-bound change set.
   * @throws {@link NodeGitWorktreeError} with code `GIT_SYMLINK_ESCAPE` or `GIT_WORKTREE_PATH_ESCAPE` for unsafe paths, `GIT_ENTRY_UNSUPPORTED` for an unsupported entry or an untracked nested Git repository, and `GIT_WORKTREE_STALE` when the workspace no longer matches the request.
   */
  async inspect(
    workspace: NodeGitWorktreeHost,
    request: WorkflowChangeInspectionRequest,
    options: WorkflowChangeOperationOptions = {},
  ): Promise<WorkflowChangeSet> {
    await this.#assertUsableWorkspace(workspace, request, options);
    const tracked = parseNameStatus(
      (
        await this.#git(
          workspace.worktreePath,
          [
            "diff",
            "--name-status",
            "-z",
            "--no-renames",
            "--no-ext-diff",
            workspace.baseRevision,
            "--",
          ],
          options,
        )
      ).stdout,
    );
    const trackedPaths = new Set(tracked.map((change) => changedPath(change)));
    const untracked = splitNul(
      (
        await this.#git(
          workspace.worktreePath,
          ["ls-files", "--others", "--exclude-standard", "-z", "--"],
          options,
        )
      ).stdout,
    )
      .map(untrackedGitPath)
      .filter((path) => !trackedPaths.has(path));
    const trustExecutableBit = await this.#trustsExecutableBit(
      workspace,
      options,
    );
    const entries: WorkflowChangeEntry[] = [];
    for (const change of tracked) {
      throwIfAborted(options.signal, ABORTED_MESSAGE);
      entries.push(
        await this.#materializeChange(
          workspace,
          change,
          trustExecutableBit,
          options.signal,
        ),
      );
    }
    for (const path of untracked) {
      throwIfAborted(options.signal, ABORTED_MESSAGE);
      const current = await this.#currentEntry(
        workspace,
        path,
        trustExecutableBit,
        options.signal,
      );
      entries.push({ kind: "added", path, ...current });
    }
    return await createWorkflowChangeSet({
      executionId: request.executionId,
      taskId: request.taskId,
      planRevision: request.planRevision,
      workspaceRevision: request.workspaceRevision,
      baseRevision: request.baseRevision,
      entries: coalesceExactRenames(entries),
    });
  }

  /**
   * Creates the commit for a prepared tree, idempotently per operation id.
   *
   * @remarks
   * The commit is a child of the base revision. Once Git starts, the abort
   * signal is no longer honored, because `commit-tree` only writes immutable
   * objects and is safe to reconcile or retry. A repeated call returns the
   * journaled result after re-verifying its tree and parent.
   *
   * @param workspace - Host handle issued by this driver.
   * @param input - Validated change set, receipt, preparation and operation identity.
   * @param options - Abort signal.
   * @returns The commit result.
   * @throws {@link NodeGitWorktreeError} with code `GIT_CHANGE_SET_MISMATCH` when the change set, receipt or preparation does not identify this worktree, `GIT_COMMIT_NOT_FAST_FORWARD` when the commit parent is not the base revision, or `GIT_MUTATION_AMBIGUOUS` when a journaled result no longer resolves.
   */
  async commit(
    workspace: NodeGitWorktreeHost,
    input: WorkflowCommitDriverInput,
    options: WorkflowChangeOperationOptions = {},
  ): Promise<WorkflowCommitResult> {
    this.#assertOwnedWorkspace(workspace);
    assertChangeSetMatchesReceipt(input.changeSet, input.receipt);
    if (
      input.changeSet.executionId !== workspace.executionId ||
      input.changeSet.taskId !== workspace.taskId ||
      input.changeSet.baseRevision !== workspace.baseRevision ||
      input.changeSet.workspaceRevision !== workspace.baseRevision
    ) {
      throw new NodeGitWorktreeError(
        "GIT_CHANGE_SET_MISMATCH",
        "Validated change snapshot does not identify this worktree",
      );
    }
    const preparation = this.#preparations.get(input.preparation.preparationId);
    if (
      !preparation ||
      preparation.workspaceId !== workspace.workspaceId ||
      preparation.treeId !== input.preparation.treeId
    ) {
      throw new NodeGitWorktreeError(
        "GIT_CHANGE_SET_MISMATCH",
        "Commit preparation is absent, stale, or belongs to another workspace",
      );
    }
    throwIfAborted(options.signal, ABORTED_MESSAGE);
    const begun = await this.#journal.beginHostMutation({
      operationId: input.operationId,
      intentDigest: input.intentDigest,
      kind: "commit",
      executionId: input.receipt.executionId,
      taskId: input.receipt.taskId,
      startedAt: nonNegativeTimestamp(this.#now()),
    });
    const completed = completedCommitResult(begun.record, input);
    if (completed) {
      const resolved = await this.#resolveCommit(
        workspace.worktreePath,
        completed.commitId,
        {},
      );
      const treeId = await this.#resolveTree(
        workspace.worktreePath,
        resolved,
        {},
      );
      const parent = await this.#resolveCommit(
        workspace.worktreePath,
        `${resolved}^`,
        {},
      );
      if (treeId !== completed.treeId || parent !== workspace.baseRevision) {
        throw new NodeGitWorktreeError(
          "GIT_MUTATION_AMBIGUOUS",
          "Durable commit result no longer resolves to its exact tree and parent",
        );
      }
      return completed;
    }

    // From this point onward AbortSignal is deliberately not passed to Git.
    // commit-tree only writes immutable objects and is safe to reconcile/retry.
    let commitId: string;
    try {
      const timestamp = stableGitTimestamp(begun.record.startedAt);
      const result = await this.#git(
        workspace.worktreePath,
        [
          "commit-tree",
          preparation.treeId,
          "-p",
          workspace.baseRevision,
          "-m",
          input.message,
        ],
        {
          env: {
            GIT_AUTHOR_DATE: timestamp,
            GIT_COMMITTER_DATE: timestamp,
          },
        },
      );
      commitId = gitObjectOutput(result, "commit-tree", "commitId");
    } catch (error) {
      await this.#journal.markAmbiguous(
        input.operationId,
        input.intentDigest,
        "commit-tree may have written an immutable commit object",
      );
      throw error;
    }
    const parent = await this.#resolveCommit(
      workspace.worktreePath,
      `${commitId}^`,
      {},
    );
    if (parent !== workspace.baseRevision) {
      throw new NodeGitWorktreeError(
        "GIT_COMMIT_NOT_FAST_FORWARD",
        "Worktree commit is not based directly on its configured base revision",
      );
    }
    const treeId = await this.#resolveTree(
      workspace.worktreePath,
      commitId,
      {},
    );
    if (treeId !== preparation.treeId) {
      throw new NodeGitWorktreeError(
        "GIT_CHANGE_SET_MISMATCH",
        "Created commit does not contain the prepared immutable tree",
      );
    }
    const result = Object.freeze({
      commitId,
      treeId,
      receiptId: input.receipt.receiptId,
      changeSetDigest: input.changeSet.changeSetDigest,
      workspaceRevision: input.changeSet.workspaceRevision,
      baseRevision: input.changeSet.baseRevision,
      committedAt: nonNegativeTimestamp(this.#now()),
    });
    await this.#journal.complete(input.operationId, input.intentDigest, result);
    return result;
  }

  /**
   * Writes the candidate tree into a private index and verifies it against the receipt.
   *
   * @param workspace - Host handle issued by this driver.
   * @param input - Change set and accepted receipt.
   * @param options - Abort signal.
   * @returns A preparation to pass to `commit` or `discardPreparation`.
   * @throws {@link WorkflowChangeMismatchError} with code `CHANGE_RECEIPT_MISMATCH` when the change set or the prepared tree differs from the receipt.
   * @throws {@link NodeGitWorktreeError} with code `GIT_CHANGE_SET_MISMATCH` when the change set does not identify this worktree, `GIT_WORKTREE_STALE` when the worktree was released or its HEAD moved, or `GIT_WORKTREE_PATH_ESCAPE` when the worktree path was replaced.
   */
  async prepareCommit(
    workspace: NodeGitWorktreeHost,
    input: WorkflowCommitPreparationInput,
    options: WorkflowChangeOperationOptions = {},
  ): Promise<WorkflowCommitPreparation> {
    await this.#assertUsableWorkspace(
      workspace,
      {
        executionId: input.changeSet.executionId,
        taskId: input.changeSet.taskId,
        planRevision: input.changeSet.planRevision,
        workspaceRevision: input.changeSet.workspaceRevision,
        baseRevision: input.changeSet.baseRevision,
      },
      options,
    );
    assertChangeSetMatchesReceipt(input.changeSet, input.receipt);
    const tempRoot = await mkdtemp(join(this.#worktreesRoot, ".prepare-"));
    const indexPath = join(tempRoot, "index");
    try {
      const environment = { GIT_INDEX_FILE: indexPath };
      await this.#git(
        workspace.worktreePath,
        ["read-tree", workspace.baseRevision],
        { ...options, env: environment },
      );
      await this.#git(workspace.worktreePath, ["add", "--all", "--"], {
        ...options,
        env: environment,
      });
      const treeId = gitObjectOutput(
        await this.#git(workspace.worktreePath, ["write-tree"], {
          ...options,
          env: environment,
        }),
        "write-tree",
        "treeId",
      );
      const preparedChangeSet = await this.#inspectTree(
        workspace,
        input.changeSet,
        treeId,
        options,
      );
      assertChangeSetMatchesReceipt(preparedChangeSet, input.receipt);
      const preparationId = randomUUID();
      this.#preparations.set(preparationId, {
        workspaceId: workspace.workspaceId,
        treeId,
        tempRoot,
      });
      return Object.freeze({ preparationId, treeId });
    } catch (error) {
      await rm(tempRoot, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * Drops a preparation and deletes its temporary index; unknown ids are ignored.
   *
   * @param workspace - Host handle issued by this driver.
   * @param preparation - Preparation to discard.
   * @throws {@link NodeGitWorktreeError} with code `GIT_CHANGE_SET_MISMATCH` when the preparation belongs to another workspace.
   */
  async discardPreparation(
    workspace: NodeGitWorktreeHost,
    preparation: WorkflowCommitPreparation,
  ): Promise<void> {
    this.#assertOwnedWorkspace(workspace);
    const stored = this.#preparations.get(preparation.preparationId);
    if (!stored) return;
    if (
      stored.workspaceId !== workspace.workspaceId ||
      stored.treeId !== preparation.treeId
    ) {
      throw new NodeGitWorktreeError(
        "GIT_CHANGE_SET_MISMATCH",
        "Cannot discard a preparation owned by another workspace",
      );
    }
    this.#preparations.delete(preparation.preparationId);
    await rm(stored.tempRoot, { recursive: true, force: true });
  }

  /**
   * Fast-forwards a target branch to an accepted commit, under the repository lock.
   *
   * @remarks
   * The target must be a full `refs/heads/*` reference, must not be checked
   * out, and must still be at the expected revision. The ref update uses
   * compare-and-swap, and the outcome is journaled so a repeat returns the
   * recorded result.
   *
   * @param repository - Repository handle issued by this driver.
   * @param request - Commit, expected target and operation identity.
   * @param options - Abort signal.
   * @returns The integration result.
   * @throws {@link NodeGitWorktreeError} with code `GIT_CONFIGURATION_INVALID` when the target is not a valid full `refs/heads/*` reference, `GIT_CHANGE_SET_MISMATCH` when the commit tree is not linked to the receipt, `GIT_TARGET_STALE` when the target moved, `GIT_COMMIT_NOT_FAST_FORWARD` when the commit's first parent is not the expected target, `GIT_TARGET_CHECKED_OUT` when the branch is checked out, or `GIT_MUTATION_AMBIGUOUS` when the outcome cannot be attributed.
   */
  async integrate(
    repository: NodeGitRepositoryHost,
    request: WorkflowIntegrationRequest,
    options: WorkflowChangeOperationOptions = {},
  ): Promise<WorkflowIntegrationResult> {
    this.#assertOwnedRepository(repository);
    const normalized = normalizeAuthoritativeIntegrationRequest(request);
    const targetId = await this.#validatedTargetRef(
      normalized.expectedTarget.targetId,
      options,
    );
    const expectedRevision = requiredGitObject(
      normalized.expectedTarget.revision,
      "expected target revision",
    );
    const commitId = await this.#resolveCommit(
      repository.repoRoot,
      requiredGitObject(normalized.commitId, "commitId"),
      options,
    );
    const treeId = await this.#resolveTree(
      repository.repoRoot,
      commitId,
      options,
    );
    if (treeId !== normalized.commit.treeId) {
      throw new NodeGitWorktreeError(
        "GIT_CHANGE_SET_MISMATCH",
        "Integration commit tree is not linked to the accepted receipt",
      );
    }
    throwIfAborted(options.signal, ABORTED_MESSAGE);
    const begun = await this.#journal.beginHostMutation({
      operationId: normalized.operationId,
      intentDigest: await workflowIntegrationIntentDigest(normalized),
      kind: "integration",
      executionId: normalized.executionId,
      taskId: normalized.taskId,
      startedAt: nonNegativeTimestamp(this.#now()),
    });
    const completed = completedIntegrationResult(begun.record, normalized);
    if (completed) {
      // The journal is historical evidence. A later legitimate publication may
      // advance the branch without invalidating this operation's result.
      return completed;
    }
    const repositoryLease = await this.#repositoryMutationLock.acquire(
      repository.repoRoot,
      options,
    );
    try {
      // All Git calls are uncancellable while the critical section owns the
      // cross-instance lock. Participating checkout operations must use it too.
      const currentRevision = await this.#resolveCommit(
        repository.repoRoot,
        targetId,
        {},
      );
      await this.#assertTargetNotCheckedOut(targetId, {});
      if (currentRevision === commitId) {
        if (begun.created) {
          await this.#journal.markAmbiguous(
            normalized.operationId,
            begun.record.intentDigest,
            "Target already contained the commit before this operation began",
          );
          throw new NodeGitWorktreeError(
            "GIT_MUTATION_AMBIGUOUS",
            "Cannot attribute a pre-existing target revision to a new integration",
          );
        }
        return await this.#completeIntegrationJournal(
          begun.record,
          normalized,
          expectedRevision,
          commitId,
          targetId,
        );
      }
      if (currentRevision !== expectedRevision) {
        throw new NodeGitWorktreeError(
          "GIT_TARGET_STALE",
          `Target ${targetId} moved from ${expectedRevision} to ${currentRevision}`,
        );
      }
      const parent = await this.#resolveCommit(
        repository.repoRoot,
        `${commitId}^`,
        {},
      );
      if (parent !== expectedRevision) {
        throw new NodeGitWorktreeError(
          "GIT_COMMIT_NOT_FAST_FORWARD",
          "Integration commit must have the expected target as its first parent",
        );
      }
      try {
        await this.#git(
          repository.repoRoot,
          ["update-ref", targetId, commitId, expectedRevision],
          {},
        );
      } catch (error) {
        const latest = await this.#resolveCommit(
          repository.repoRoot,
          targetId,
          {},
        );
        if (latest === commitId) {
          return await this.#completeIntegrationJournal(
            begun.record,
            normalized,
            expectedRevision,
            commitId,
            targetId,
          );
        }
        if (latest !== expectedRevision) {
          throw new NodeGitWorktreeError(
            "GIT_TARGET_STALE",
            `Target ${targetId} concurrently moved to ${latest}`,
          );
        }
        await this.#journal.markAmbiguous(
          normalized.operationId,
          begun.record.intentDigest,
          "Git update-ref failed and the target still has its expected revision",
        );
        throw error;
      }
      const integratedRevision = await this.#resolveCommit(
        repository.repoRoot,
        targetId,
        {},
      );
      if (integratedRevision !== commitId) {
        throw new NodeGitWorktreeError(
          "GIT_TARGET_STALE",
          "Git did not update the target to the exact requested commit",
        );
      }
      return await this.#completeIntegrationJournal(
        begun.record,
        normalized,
        currentRevision,
        integratedRevision,
        targetId,
      );
    } finally {
      await repositoryLease.release();
    }
  }

  async #inspectTree(
    workspace: NodeGitWorktreeHost,
    identity: WorkflowChangeSet,
    treeId: string,
    options: WorkflowChangeOperationOptions,
  ): Promise<WorkflowChangeSet> {
    const changes = parseNameStatus(
      (
        await this.#git(
          workspace.worktreePath,
          [
            "diff-tree",
            "--no-commit-id",
            "--name-status",
            "-r",
            "-z",
            "--no-renames",
            workspace.baseRevision,
            treeId,
            "--",
          ],
          options,
        )
      ).stdout,
    );
    const entries: WorkflowChangeEntry[] = [];
    for (const change of changes) {
      throwIfAborted(options.signal, ABORTED_MESSAGE);
      // Both diffs run with --no-renames; exact renames are coalesced below.
      if (change.status === "renamed") throw malformedDiff("R");
      const deleted = change.status === "deleted";
      entries.push({
        kind: change.status,
        path: change.path,
        ...(await this.#treeEntry(
          workspace.worktreePath,
          deleted ? workspace.baseRevision : treeId,
          change.path,
          { signal: options.signal, verifySymlink: !deleted },
        )),
      });
    }
    return await createWorkflowChangeSet({
      executionId: identity.executionId,
      taskId: identity.taskId,
      planRevision: identity.planRevision,
      workspaceRevision: identity.workspaceRevision,
      baseRevision: identity.baseRevision,
      entries: coalesceExactRenames(entries),
    });
  }

  /**
   * Reads one entry of a tree. With `verifySymlink`, a symlink must stay
   * inside the worktree (see {@link assertSymlinkContained}).
   */
  async #treeEntry(
    cwd: string,
    treeish: string,
    portablePath: string,
    options: WorkflowChangeOperationOptions & { verifySymlink: boolean },
  ): Promise<{
    entryKind: WorkflowChangeEntryKind;
    mode: WorkflowChangeEntryMode;
    contentDigest: string;
  }> {
    const listing = (
      await this.#git(cwd, ["ls-tree", "-z", treeish, "--", portablePath], {
        signal: options.signal,
      })
    ).stdout;
    const match = exactListingEntry(
      listing,
      /^(\d{6}) (\w+) ([a-f0-9]+)\t/u,
      portablePath,
    );
    if (!match) {
      throw new NodeGitWorktreeError(
        "GIT_COMMAND_FAILED",
        `Tree entry is absent from ${treeish}: ${portablePath}`,
      );
    }
    const [mode, type, objectId] = match;
    if (mode === "160000" || type === "commit") {
      return {
        entryKind: "submodule",
        mode: "160000",
        contentDigest: digest(Buffer.from(objectId)),
      };
    }
    const content = (
      await this.#git(cwd, ["cat-file", "blob", objectId], {
        signal: options.signal,
      })
    ).stdout;
    if (mode === "120000") {
      if (options.verifySymlink) {
        assertSymlinkContained(cwd, portablePath, content.toString("utf8"));
      }
      return {
        entryKind: "symlink",
        mode: "120000",
        contentDigest: digest(content),
      };
    }
    if (mode !== "100644" && mode !== "100755") {
      throw new NodeGitWorktreeError(
        "GIT_ENTRY_UNSUPPORTED",
        `Unsupported Git tree entry mode: ${mode}`,
      );
    }
    return { entryKind: "file", mode, contentDigest: digest(content) };
  }

  async #completeIntegrationJournal(
    record: WorkflowHostMutationRecord,
    request: ReturnType<typeof normalizeAuthoritativeIntegrationRequest>,
    previousRevision: string,
    integratedRevision: string,
    targetId: string,
  ): Promise<WorkflowIntegrationResult> {
    const result = Object.freeze({
      integrationId: deterministicIntegrationId(
        request.operationId,
        record.intentDigest,
      ),
      commitId: request.commitId,
      targetId,
      previousRevision,
      integratedRevision,
      integratedAt: nonNegativeTimestamp(this.#now()),
    });
    await this.#journal.complete(
      request.operationId,
      record.intentDigest,
      result,
    );
    return result;
  }

  async #assertTargetNotCheckedOut(
    targetId: string,
    options: WorkflowChangeOperationOptions,
  ): Promise<void> {
    const output = textOutput(
      (
        await this.#git(
          this.#repoRoot,
          ["worktree", "list", "--porcelain"],
          options,
        )
      ).stdout,
    );
    for (const line of output.split("\n")) {
      if (line === `branch ${targetId}`) {
        throw new NodeGitWorktreeError(
          "GIT_TARGET_CHECKED_OUT",
          `Integration target is checked out in a Git worktree: ${targetId}`,
        );
      }
    }
  }

  async #isRegisteredWorktree(path: string): Promise<boolean> {
    const output = textOutput(
      (await this.#git(this.#repoRoot, ["worktree", "list", "--porcelain"], {}))
        .stdout,
    );
    return output
      .split("\n")
      .some(
        (line) =>
          line.startsWith("worktree ") && resolve(line.slice(9)) === path,
      );
  }

  async #worktreeExists(path: string): Promise<boolean> {
    return (
      (await realpath(path).catch(() => undefined)) !== undefined ||
      (await this.#isRegisteredWorktree(path))
    );
  }

  /**
   * Durable worktree directory for a descriptor. `legacy` gives the pre-0.7.0
   * name (insertion-order JSON), used only to attach worktrees created before
   * 0.7.0; new worktrees always use the canonical name.
   */
  #workspacePath(
    descriptor: Omit<WorkspaceDescriptor, "providerId">,
    form: "canonical" | "legacy" = "canonical",
  ): string {
    const identity = {
      workspaceId: descriptor.workspaceId,
      executionId: descriptor.executionId,
      taskId: descriptor.taskId,
      revision: descriptor.revision,
      parameters: descriptor.parameters,
    };
    const workspaceSuffix = sha256HexSync(
      form === "canonical"
        ? canonicalJson(identity)
        : legacyJson(identity, "insertion"),
    ).slice(0, 12);
    const directory = `${safeComponent(descriptor.taskId)}-${safeComponent(
      descriptor.workspaceId,
    )}-${workspaceSuffix}`;
    const worktreePath = resolve(this.#worktreesRoot, directory);
    assertContained(this.#worktreesRoot, worktreePath);
    return worktreePath;
  }

  #issueHost(input: {
    workspaceId: string;
    executionId: string;
    taskId: string;
    worktreePath: string;
    baseRevision: string;
  }): NodeGitWorktreeHost {
    const host: NodeGitWorktreeHost = Object.freeze({
      kind: "git-worktree",
      ...input,
      repoRoot: this.#repoRoot,
      worktreesRoot: this.#worktreesRoot,
      [HOST_BRAND]: true as const,
    });
    this.#issued.add(host);
    this.#active.set(host.workspaceId, host);
    return host;
  }

  #normalizeDescriptor(descriptor: WorkspaceDescriptor): WorkspaceDescriptor {
    if (descriptor?.providerId !== "node-git-worktree") {
      throw new NodeGitWorktreeError(
        "GIT_CONFIGURATION_INVALID",
        "Workspace descriptor belongs to another provider",
      );
    }
    const revision = requiredGitObject(descriptor.revision, "revision");
    if (revision !== this.#baseRevision) {
      throw new NodeGitWorktreeError(
        "GIT_WORKTREE_STALE",
        "Workspace descriptor uses a different immutable base revision",
      );
    }
    return Object.freeze({
      workspaceId: requiredIdentity(descriptor.workspaceId, "workspaceId"),
      providerId: "node-git-worktree",
      executionId: requiredIdentity(
        descriptor.executionId,
        "executionId",
        "record",
      ),
      taskId: requiredIdentity(descriptor.taskId, "taskId", "record"),
      revision,
      parameters: optionalJsonObject(descriptor.parameters, "parameters"),
    });
  }

  #attachment(
    descriptor: WorkspaceDescriptor,
    host: NodeGitWorktreeHost,
  ): WorkflowWorkspaceAttachment<NodeGitWorktreeHost> {
    let attached = true;
    return Object.freeze({
      [WORKFLOW_WORKSPACE_ATTACHMENT]: true as const,
      descriptor,
      host,
      detach: async () => {
        if (!attached) return false;
        attached = false;
        if (this.#active.get(host.workspaceId) === host) {
          this.#active.delete(host.workspaceId);
        }
        return true;
      },
    });
  }

  async #materializeChange(
    workspace: NodeGitWorktreeHost,
    change: ParsedGitChange,
    trustExecutableBit: boolean,
    signal?: AbortSignal,
  ): Promise<WorkflowChangeEntry> {
    // Both diffs run with --no-renames; exact renames are coalesced later.
    if (change.status === "renamed") throw malformedDiff("R");
    if (change.status === "deleted") {
      return {
        kind: "deleted",
        path: change.path,
        ...(await this.#treeEntry(
          workspace.worktreePath,
          workspace.baseRevision,
          change.path,
          { signal, verifySymlink: false },
        )),
      };
    }
    return {
      kind: change.status,
      path: change.path,
      ...(await this.#currentEntry(
        workspace,
        change.path,
        trustExecutableBit,
        signal,
      )),
    };
  }

  /**
   * Reads `core.fileMode` as Git applies it to this worktree (true when it
   * is unset).
   */
  async #trustsExecutableBit(
    workspace: NodeGitWorktreeHost,
    options: WorkflowChangeOperationOptions,
  ): Promise<boolean> {
    const result = await runGit(
      workspace.worktreePath,
      ["config", "--type=bool", "--get", "core.fileMode"],
      this.#timeoutMs,
      { signal: options.signal, allowExitCodes: [1] },
    );
    return result.exitCode === 1 || textOutput(result.stdout) !== "false";
  }

  /**
   * Mode Git records for a regular file when `core.fileMode` is false: the
   * base tree's mode when the base has a regular file at the path, otherwise
   * `100644`. The prepared tree starts from the base tree, so this is what
   * `git add` keeps.
   */
  async #untrustedFileMode(
    workspace: NodeGitWorktreeHost,
    portablePath: string,
    signal?: AbortSignal,
  ): Promise<"100644" | "100755"> {
    const listing = (
      await this.#git(
        workspace.worktreePath,
        ["ls-tree", "-z", workspace.baseRevision, "--", portablePath],
        { signal },
      )
    ).stdout;
    const match = exactListingEntry(
      listing,
      /^(\d{6}) blob [a-f0-9]+\t/u,
      portablePath,
    );
    return match?.[0] === "100755" ? "100755" : "100644";
  }

  async #currentEntry(
    workspace: NodeGitWorktreeHost,
    portablePath: string,
    trustExecutableBit: boolean,
    signal?: AbortSignal,
  ): Promise<{
    entryKind: WorkflowChangeEntryKind;
    mode: WorkflowChangeEntryMode;
    contentDigest: string;
  }> {
    const absolutePath = resolve(workspace.worktreePath, portablePath);
    assertContained(workspace.worktreePath, absolutePath);
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      const target = await readlink(absolutePath, { encoding: "buffer" });
      assertSymlinkContained(
        workspace.worktreePath,
        portablePath,
        target.toString("utf8"),
      );
      // A target that exists must also resolve inside the worktree, so a
      // link through an escaping directory symlink is rejected.
      const resolved = await realpath(absolutePath).catch(() => undefined);
      if (resolved && !isContained(workspace.worktreePath, resolved)) {
        throw symlinkEscape(portablePath);
      }
      return {
        entryKind: "symlink",
        mode: "120000",
        contentDigest: digest(target),
      };
    }
    const indexEntry = await this.#indexEntry(workspace, portablePath);
    if (indexEntry?.mode === "160000") {
      return {
        entryKind: "submodule",
        mode: "160000",
        contentDigest: digest(Buffer.from(indexEntry.objectId)),
      };
    }
    if (stat.isDirectory()) {
      return {
        entryKind: "directory",
        mode: "040000",
        contentDigest: digest(Buffer.alloc(0)),
      };
    }
    if (!stat.isFile()) {
      throw new NodeGitWorktreeError(
        "GIT_ENTRY_UNSUPPORTED",
        `Unsupported changed filesystem entry: ${portablePath}`,
      );
    }
    return {
      entryKind: "file",
      // Git records a file as executable from the owner execute bit only,
      // and ignores the bit when core.fileMode is false.
      mode: trustExecutableBit
        ? stat.mode & 0o100
          ? "100755"
          : "100644"
        : await this.#untrustedFileMode(workspace, portablePath, signal),
      contentDigest: digest(await readFile(absolutePath)),
    };
  }

  async #indexEntry(
    workspace: NodeGitWorktreeHost,
    portablePath: string,
  ): Promise<{ mode: string; objectId: string } | undefined> {
    const output = (
      await this.#git(workspace.worktreePath, [
        "ls-files",
        "--stage",
        "-z",
        "--",
        portablePath,
      ])
    ).stdout;
    const match = exactListingEntry(
      output,
      /^(\d{6}) ([a-f0-9]+) \d+\t/u,
      portablePath,
    );
    return match ? { mode: match[0], objectId: match[1] } : undefined;
  }

  async #assertUsableWorkspace(
    workspace: NodeGitWorktreeHost,
    request: WorkflowChangeInspectionRequest,
    options: WorkflowChangeOperationOptions,
  ): Promise<void> {
    this.#assertOwnedWorkspace(workspace);
    if (!this.#active.has(workspace.workspaceId)) {
      throw new NodeGitWorktreeError(
        "GIT_WORKTREE_STALE",
        "Worktree has already been released",
      );
    }
    if (
      request.executionId !== workspace.executionId ||
      request.taskId !== workspace.taskId ||
      request.workspaceRevision !== workspace.baseRevision ||
      request.baseRevision !== workspace.baseRevision
    ) {
      throw new NodeGitWorktreeError(
        "GIT_CHANGE_SET_MISMATCH",
        "Inspection request does not identify this worktree",
      );
    }
    const canonical = await realpath(workspace.worktreePath).catch(
      () => undefined,
    );
    if (!canonical || canonical !== workspace.worktreePath) {
      throw new NodeGitWorktreeError(
        "GIT_WORKTREE_PATH_ESCAPE",
        "Worktree path was removed or replaced",
      );
    }
    assertContained(this.#worktreesRoot, canonical);
    await this.#assertHead(workspace, options);
  }

  async #assertHead(
    workspace: NodeGitWorktreeHost,
    options: WorkflowChangeOperationOptions,
  ): Promise<void> {
    const head = await this.#resolveCommit(
      workspace.worktreePath,
      "HEAD",
      options,
    );
    if (head !== workspace.baseRevision) {
      throw new NodeGitWorktreeError(
        "GIT_WORKTREE_STALE",
        `Worktree HEAD moved from ${workspace.baseRevision} to ${head}`,
      );
    }
  }

  #assertOwnedWorkspace(workspace: NodeGitWorktreeHost): void {
    if (
      workspace?.[HOST_BRAND] !== true ||
      !this.#issued.has(workspace) ||
      workspace.repoRoot !== this.#repoRoot ||
      workspace.worktreesRoot !== this.#worktreesRoot
    ) {
      throw new NodeGitWorktreeError(
        "GIT_CONFIGURATION_INVALID",
        "Worktree handle was not issued by this driver",
      );
    }
  }

  #assertOwnedRepository(repository: NodeGitRepositoryHost): void {
    if (
      repository?.[REPOSITORY_BRAND] !== true ||
      repository !== this.#repository
    ) {
      throw new NodeGitWorktreeError(
        "GIT_CONFIGURATION_INVALID",
        "Repository handle was not issued by this driver",
      );
    }
  }

  async #validatedTargetRef(
    targetId: string,
    options: WorkflowChangeOperationOptions,
  ): Promise<string> {
    if (!targetId.startsWith("refs/heads/")) {
      throw new NodeGitWorktreeError(
        "GIT_CONFIGURATION_INVALID",
        "Integration target must be a full refs/heads/* reference",
      );
    }
    // Strict check of the full ref: unlike `--branch`, it never expands
    // `@{-N}` to a previously checked-out branch.
    const result = await runGit(
      this.#repoRoot,
      ["check-ref-format", targetId],
      this.#timeoutMs,
      { signal: options.signal, allowExitCodes: [1] },
    );
    if (result.exitCode !== 0) {
      throw new NodeGitWorktreeError(
        "GIT_CONFIGURATION_INVALID",
        `Integration target is not a valid Git reference: ${targetId}`,
      );
    }
    return targetId;
  }

  async #resolveCommit(
    cwd: string,
    revision: string,
    options: WorkflowChangeOperationOptions,
  ): Promise<string> {
    const result = await this.#git(
      cwd,
      ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
      options,
    );
    const resolved = textOutput(result.stdout);
    if (!GIT_OBJECT.test(resolved)) {
      throw new NodeGitWorktreeError(
        "GIT_COMMAND_FAILED",
        `Git returned an invalid commit identity for ${revision}`,
      );
    }
    return resolved;
  }

  async #resolveTree(
    cwd: string,
    revision: string,
    options: WorkflowChangeOperationOptions,
  ): Promise<string> {
    const result = await this.#git(
      cwd,
      ["rev-parse", "--verify", "--end-of-options", `${revision}^{tree}`],
      options,
    );
    return gitObjectOutput(result, "rev-parse", "treeId");
  }

  async #git(
    cwd: string,
    args: readonly string[],
    options: WorkflowChangeOperationOptions & { env?: NodeJS.ProcessEnv } = {},
  ): Promise<GitCommandResult> {
    return await runGit(cwd, args, this.#timeoutMs, {
      signal: options.signal,
      env: options.env,
    });
  }
}

function completedCommitResult(
  record: WorkflowHostMutationRecord,
  input: WorkflowCommitDriverInput,
): WorkflowCommitResult | undefined {
  if (record.status !== "completed") return undefined;
  const result = jsonRecord(record.result, "completed commit result");
  const normalized = Object.freeze({
    commitId: requiredGitObject(result.commitId, "commitId"),
    treeId: requiredGitObject(result.treeId, "treeId"),
    receiptId: requiredIdentity(result.receiptId, "receiptId"),
    changeSetDigest: requiredDigest(result.changeSetDigest, "changeSetDigest"),
    workspaceRevision: requiredRevision(
      result.workspaceRevision,
      "workspaceRevision",
    ),
    baseRevision: requiredRevision(result.baseRevision, "baseRevision"),
    committedAt: nonNegativeTimestamp(result.committedAt),
  });
  if (
    normalized.treeId !== input.preparation.treeId ||
    normalized.receiptId !== input.receipt.receiptId ||
    normalized.changeSetDigest !== input.receipt.changeSetDigest ||
    normalized.workspaceRevision !== input.receipt.workspaceRevision ||
    normalized.baseRevision !== input.receipt.baseRevision
  ) {
    throw new NodeGitWorktreeError(
      "GIT_CHANGE_SET_MISMATCH",
      "Durable commit result is not linked to this publication",
    );
  }
  return normalized;
}

function completedIntegrationResult(
  record: WorkflowHostMutationRecord,
  request: ReturnType<typeof normalizeAuthoritativeIntegrationRequest>,
): WorkflowIntegrationResult | undefined {
  if (record.status !== "completed") return undefined;
  const result = jsonRecord(record.result, "completed integration result");
  const normalized = Object.freeze({
    integrationId: requiredIdentity(result.integrationId, "integrationId"),
    commitId: requiredGitObject(result.commitId, "commitId"),
    targetId: requiredIdentity(result.targetId, "targetId"),
    previousRevision: requiredGitObject(
      result.previousRevision,
      "previousRevision",
    ),
    integratedRevision: requiredGitObject(
      result.integratedRevision,
      "integratedRevision",
    ),
    integratedAt: nonNegativeTimestamp(result.integratedAt),
  });
  if (
    normalized.commitId !== request.commitId ||
    normalized.targetId !== request.expectedTarget.targetId ||
    normalized.previousRevision !== request.expectedTarget.revision ||
    normalized.integratedRevision !== request.commitId
  ) {
    throw new NodeGitWorktreeError(
      "GIT_CHANGE_SET_MISMATCH",
      "Durable integration result is not linked to this publication",
    );
  }
  return normalized;
}

function deterministicIntegrationId(
  operationId: string,
  intentDigest: string,
): string {
  return `integration-${createHash("sha256")
    .update(`${operationId}\0${intentDigest}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function stableGitTimestamp(timestamp: number): string {
  return `@${Math.floor(timestamp / 1000)} +0000`;
}

function jsonRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NodeGitWorktreeError(
      "GIT_MUTATION_AMBIGUOUS",
      `${field} is absent or malformed`,
    );
  }
  return value as Record<string, unknown>;
}

async function canonicalDirectory(
  path: string,
  field: string,
): Promise<string> {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new NodeGitWorktreeError(
      "GIT_CONFIGURATION_INVALID",
      `${field} must be an absolute path`,
    );
  }
  const canonical = await realpath(path).catch(() => undefined);
  if (!canonical) {
    throw new NodeGitWorktreeError(
      "GIT_CONFIGURATION_INVALID",
      `${field} must identify an existing directory`,
    );
  }
  const stat = await lstat(canonical);
  if (!stat.isDirectory()) {
    throw new NodeGitWorktreeError(
      "GIT_CONFIGURATION_INVALID",
      `${field} must identify a directory`,
    );
  }
  return canonical;
}

function assertContained(root: string, candidate: string): void {
  if (!isContained(root, candidate)) {
    throw new NodeGitWorktreeError(
      "GIT_WORKTREE_PATH_ESCAPE",
      `Path escapes configured root: ${candidate}`,
    );
  }
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`);
}

function changedPath(change: ParsedGitChange): string {
  return change.status === "renamed" ? change.toPath : change.path;
}

/**
 * Checks a path reported by Git against the portable change-path rules, so an
 * unportable worktree path fails as a driver error, not a later `TypeError`.
 */
// Git reports canonical paths; anything else (a backslash or a drive prefix
// in a tracked name) cannot be owned or claimed, so it fails here first.
/**
 * Reads one `ls-files --others` path. Git lists an untracked nested
 * repository as its directory with a trailing slash; staging it would record
 * a gitlink without a submodule entry, so it is refused instead.
 */
function untrackedGitPath(path: string): string {
  if (path.endsWith("/")) {
    const directory = portableGitPath(path.slice(0, -1));
    throw new NodeGitWorktreeError(
      "GIT_ENTRY_UNSUPPORTED",
      `Untracked nested Git repository is not supported: ${directory}; remove it or add it as a submodule`,
    );
  }
  return portableGitPath(path);
}

function portableGitPath(path: string): string {
  if (portablePathProblem(path, { canonical: true }) !== undefined) {
    throw new NodeGitWorktreeError(
      "GIT_WORKTREE_PATH_ESCAPE",
      `Worktree path is not a portable relative path: ${JSON.stringify(path)}`,
    );
  }
  return path;
}

/**
 * Lexical containment rule for a symlink target, used for the worktree and
 * for prepared trees alike: the target must be relative and resolve, from the
 * link's directory, to a path inside the worktree. A target that does not
 * exist yet is accepted when it satisfies the rule.
 */
function assertSymlinkContained(
  worktreePath: string,
  portablePath: string,
  target: string,
): void {
  const linkDirectory = dirname(resolve(worktreePath, portablePath));
  if (
    !target ||
    isAbsolute(target) ||
    !isContained(worktreePath, resolve(linkDirectory, target))
  ) {
    throw symlinkEscape(portablePath);
  }
}

function symlinkEscape(portablePath: string): NodeGitWorktreeError {
  return new NodeGitWorktreeError(
    "GIT_SYMLINK_ESCAPE",
    `Changed symlink escapes the worktree: ${portablePath}`,
  );
}

/**
 * Returns the captured fields of the `-z` listing record whose path is exactly
 * `path`, or `undefined` when there is none.
 */
function exactListingEntry(
  output: Buffer,
  pattern: RegExp,
  path: string,
): string[] | undefined {
  for (const record of splitNul(output)) {
    const match = pattern.exec(record);
    if (match && record.slice(match[0].length) === path) {
      return match.slice(1);
    }
  }
  return undefined;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseNameStatus(output: Buffer): ParsedGitChange[] {
  const fields = splitNul(output);
  const changes: ParsedGitChange[] = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (/^R\d*$/u.test(status)) {
      const fromPath = fields[index++];
      const toPath = fields[index++];
      if (!fromPath || !toPath) throw malformedDiff();
      changes.push({
        status: "renamed",
        fromPath: portableGitPath(fromPath),
        toPath: portableGitPath(toPath),
      });
      continue;
    }
    const rawPath = fields[index++];
    if (!rawPath) throw malformedDiff();
    const path = portableGitPath(rawPath);
    if (status === "A") changes.push({ status: "added", path });
    else if (status === "D") changes.push({ status: "deleted", path });
    else if (status === "M" || status === "T") {
      changes.push({ status: "modified", path });
    } else {
      throw malformedDiff(status);
    }
  }
  return changes;
}

function malformedDiff(status?: string): NodeGitWorktreeError {
  return new NodeGitWorktreeError(
    "GIT_COMMAND_FAILED",
    `Unsupported or malformed Git diff status${status ? `: ${status}` : ""}`,
  );
}

function splitNul(output: Buffer): string[] {
  const value = output.toString("utf8");
  if (!value) return [];
  const parts = value.split("\0");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

/** Git cannot report an unstaged rename to an untracked destination. */
function coalesceExactRenames(
  entries: readonly WorkflowChangeEntry[],
): WorkflowChangeEntry[] {
  const additions = entries
    .filter((entry) => entry.kind === "added")
    .sort((left, right) => compareCodeUnits(left.path, right.path));
  const consumed = new Set<WorkflowChangeEntry>();
  const renamed: WorkflowChangeEntry[] = [];
  for (const deleted of entries
    .filter((entry) => entry.kind === "deleted")
    .sort((left, right) => compareCodeUnits(left.path, right.path))) {
    const added = additions.find(
      (candidate) =>
        !consumed.has(candidate) &&
        candidate.entryKind === deleted.entryKind &&
        candidate.mode === deleted.mode &&
        candidate.contentDigest === deleted.contentDigest,
    );
    if (!added) continue;
    consumed.add(deleted);
    consumed.add(added);
    renamed.push({
      kind: "renamed",
      fromPath: deleted.path,
      toPath: added.path,
      entryKind: added.entryKind,
      ...(added.mode === undefined ? {} : { mode: added.mode }),
      contentDigest: added.contentDigest,
    });
  }
  return [...entries.filter((entry) => !consumed.has(entry)), ...renamed];
}

function digest(content: Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function safeComponent(value: string): string {
  return value.replace(SAFE_COMPONENT, "-").slice(0, 80);
}

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
    throw new TypeError(`${field} must be a safe revision`);
  }
  return value;
}

function requiredGitObject(value: unknown, field: string): string {
  if (typeof value !== "string" || !GIT_OBJECT.test(value)) {
    throw new TypeError(`${field} must be a full Git object identity`);
  }
  return value;
}

function requiredDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

/** Reads one object id from Git output; anything else is a failed command. */
function gitObjectOutput(
  result: GitCommandResult,
  command: string,
  field: string,
): string {
  const value = textOutput(result.stdout);
  if (!GIT_OBJECT.test(value)) {
    throw new NodeGitWorktreeError(
      "GIT_COMMAND_FAILED",
      `git ${command} returned an invalid ${field}`,
    );
  }
  return value;
}

/** Runs an option check and reports its TypeError as a configuration error. */
function configuration<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    throw new NodeGitWorktreeError(
      "GIT_CONFIGURATION_INVALID",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value as number;
}

function nonNegativeTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError("Clock must return a non-negative safe integer");
  }
  return value as number;
}

function textOutput(output: Buffer): string {
  return output.toString("utf8").trim();
}

/**
 * Host Git variables that would point the driver at another repository,
 * index or object store, change how paths are matched, forbid ref updates
 * (hook quarantine), or rewrite history (replace refs, grafts, shallow file).
 */
const SCRUBBED_GIT_VARIABLES = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_GLOB_PATHSPECS",
  "GIT_GRAFT_FILE",
  "GIT_ICASE_PATHSPECS",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
]);

function gitEnvironment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      SCRUBBED_GIT_VARIABLES.has(key) ||
      /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key)
    ) {
      continue;
    }
    environment[key] = value;
  }
  return {
    ...environment,
    // Paths are passed after `--` and must never be read as pathspec magic
    // or globs.
    GIT_LITERAL_PATHSPECS: "1",
    // Parent and fast-forward checks must see the stored objects, not
    // replacements.
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    ...overrides,
  };
}

async function runGit(
  cwd: string,
  args: readonly string[],
  timeoutMs: number,
  options: GitCommandOptions = {},
): Promise<GitCommandResult> {
  throwIfAborted(options.signal, ABORTED_MESSAGE);
  return await new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        encoding: "buffer",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: timeoutMs,
        signal: options.signal,
        env: gitEnvironment(options.env),
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const exitCode = typeof error?.code === "number" ? error.code : 0;
        if (error && !options.allowExitCodes?.includes(exitCode)) {
          // An abort rejects with the caller's reason, as `throwIfAborted`
          // does; every other failure becomes a driver error so callers
          // branch on one code, not on ExecException.
          reject(
            options.signal?.aborted
              ? (options.signal.reason ?? error)
              : gitCommandFailed(args, error, stderr, timeoutMs),
          );
          return;
        }
        resolvePromise({
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
          stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr),
          exitCode,
        });
      },
    );
  });
}

const MAX_GIT_ERROR_DETAIL = 512;

function gitCommandFailed(
  args: readonly string[],
  error: Error & { code?: unknown; killed?: boolean; signal?: unknown },
  stderr: Buffer | string,
  timeoutMs: number,
): NodeGitWorktreeError {
  // Node also kills the child past maxBuffer, but then sets a string code;
  // without one (and without an abort) only the timeout kills it.
  const outcome =
    typeof error.code === "number"
      ? `exit ${error.code}`
      : typeof error.code === "string"
        ? error.code
        : error.killed
          ? `timed out after ${timeoutMs} ms`
          : typeof error.signal === "string"
            ? `killed by ${error.signal}`
            : "spawn failed";
  // The last stderr line is where Git states the reason ("fatal: ...").
  const detail = (Buffer.isBuffer(stderr) ? stderr.toString("utf8") : stderr)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1)
    ?.slice(0, MAX_GIT_ERROR_DETAIL);
  return new NodeGitWorktreeError(
    "GIT_COMMAND_FAILED",
    `git ${args[0] ?? ""} failed (${outcome})${detail ? `: ${detail}` : ""}`,
    { cause: error },
  );
}

async function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal, "Repository lock acquisition aborted");
  await new Promise<void>((resolvePromise, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        signal?.reason ?? new Error("Repository lock acquisition aborted"),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
