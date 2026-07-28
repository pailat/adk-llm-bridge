/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readlink, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
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
  type WorkflowChangeEntry,
  type WorkflowChangeEntryKind,
  type WorkflowChangeInspectionRequest,
  type WorkflowChangeInspector,
  type WorkflowChangeOperationOptions,
  type WorkflowChangeSet,
  type WorkflowCommitDriver,
  type WorkflowCommitDriverInput,
  type WorkflowCommitResult,
  type WorkflowIntegrationDriver,
  type WorkflowIntegrationRequest,
  type WorkflowIntegrationResult,
} from "../workspace/change-driver.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const SAFE_COMPONENT = /[^A-Za-z0-9._-]+/gu;
const GIT_OBJECT = /^[a-f0-9]{40,64}$/u;
const HOST_BRAND = Symbol("NodeGitWorktreeHost");
const REPOSITORY_BRAND = Symbol("NodeGitRepositoryHost");

export interface NodeGitWorktreeChangeDriverOptions {
  repoRoot: string;
  worktreesRoot: string;
  /** Revision resolved to an immutable commit when the driver is created. */
  baseRevision: string;
  commandTimeoutMs?: number;
  createWorkspaceId?: () => string;
  now?: () => number;
}

export interface NodeGitRepositoryHost {
  readonly kind: "git-repository";
  readonly repoRoot: string;
  readonly [REPOSITORY_BRAND]: true;
}

export interface NodeGitWorktreeHost {
  readonly kind: "git-worktree";
  readonly workspaceId: string;
  readonly executionId: string;
  readonly taskId: string;
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly worktreesRoot: string;
  readonly baseRevision: string;
  readonly [HOST_BRAND]: true;
}

export type NodeGitWorktreeErrorCode =
  | "GIT_CONFIGURATION_INVALID"
  | "GIT_WORKTREE_PATH_ESCAPE"
  | "GIT_WORKTREE_STALE"
  | "GIT_SYMLINK_ESCAPE"
  | "GIT_CHANGE_SET_MISMATCH"
  | "GIT_TARGET_STALE"
  | "GIT_COMMIT_NOT_FAST_FORWARD";

export class NodeGitWorktreeError extends Error {
  readonly code: NodeGitWorktreeErrorCode;

  constructor(code: NodeGitWorktreeErrorCode, message: string) {
    super(message);
    this.name = "NodeGitWorktreeError";
    this.code = code;
  }
}

interface GitCommandOptions {
  signal?: AbortSignal;
  allowExitCodes?: readonly number[];
}

interface GitCommandResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

interface ParsedGitChange {
  status: "added" | "modified" | "deleted" | "renamed";
  path?: string;
  fromPath?: string;
  toPath?: string;
}

/**
 * Trusted Node host adapter for disposable Git worktrees.
 *
 * Inspection is read-only. Commit and integration are deliberately separate
 * mutation ports so callers can place the ownership gate between them.
 */
export class NodeGitWorktreeChangeDriver
  implements
    WorkspaceProvisioner<NodeGitWorktreeHost>,
    WorkflowChangeInspector<NodeGitWorktreeHost>,
    WorkflowCommitDriver<NodeGitWorktreeHost>,
    WorkflowIntegrationDriver<NodeGitRepositoryHost>
{
  readonly #repoRoot: string;
  readonly #worktreesRoot: string;
  readonly #baseRevision: string;
  readonly #timeoutMs: number;
  readonly #createWorkspaceId: () => string;
  readonly #now: () => number;
  readonly #active = new Map<string, NodeGitWorktreeHost>();
  readonly #issued = new WeakSet<NodeGitWorktreeHost>();
  readonly #repository: NodeGitRepositoryHost;

  private constructor(input: {
    repoRoot: string;
    worktreesRoot: string;
    baseRevision: string;
    timeoutMs: number;
    createWorkspaceId: () => string;
    now: () => number;
  }) {
    this.#repoRoot = input.repoRoot;
    this.#worktreesRoot = input.worktreesRoot;
    this.#baseRevision = input.baseRevision;
    this.#timeoutMs = input.timeoutMs;
    this.#createWorkspaceId = input.createWorkspaceId;
    this.#now = input.now;
    this.#repository = Object.freeze({
      kind: "git-repository",
      repoRoot: this.#repoRoot,
      [REPOSITORY_BRAND]: true as const,
    });
  }

  static async create(
    options: NodeGitWorktreeChangeDriverOptions,
  ): Promise<NodeGitWorktreeChangeDriver> {
    const timeoutMs = positiveInteger(
      options.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      "commandTimeoutMs",
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
    const topLevel = await runGit(
      repoRoot,
      ["rev-parse", "--show-toplevel"],
      timeoutMs,
    );
    if ((await realpath(textOutput(topLevel.stdout))) !== repoRoot) {
      throw new NodeGitWorktreeError(
        "GIT_CONFIGURATION_INVALID",
        "repoRoot must identify the Git worktree root",
      );
    }
    const requestedRevision = requiredRevision(
      options.baseRevision,
      "baseRevision",
    );
    const resolvedRevision = textOutput(
      (
        await runGit(
          repoRoot,
          [
            "rev-parse",
            "--verify",
            "--end-of-options",
            `${requestedRevision}^{commit}`,
          ],
          timeoutMs,
        )
      ).stdout,
    );
    if (!GIT_OBJECT.test(resolvedRevision)) {
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
    });
  }

  get repository(): NodeGitRepositoryHost {
    return this.#repository;
  }

  get baseRevision(): string {
    return this.#baseRevision;
  }

  async provision(
    request: WorkspaceProvisionRequest,
    options: WorkspaceProvisionOptions = {},
  ): Promise<ProvisionedWorkspace<NodeGitWorktreeHost>> {
    throwIfAborted(options.signal);
    const executionId = requiredIdentity(request.executionId, "executionId");
    const taskId = requiredIdentity(request.taskId, "taskId");
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
    const workspaceSuffix = createHash("sha256")
      .update(workspaceId)
      .digest("hex")
      .slice(0, 12);
    const directory = `${safeComponent(taskId)}-${safeComponent(
      workspaceId,
    )}-${workspaceSuffix}`;
    const worktreePath = resolve(this.#worktreesRoot, directory);
    assertContained(this.#worktreesRoot, worktreePath);
    await this.#git(
      this.#repoRoot,
      ["worktree", "add", "--detach", worktreePath, this.#baseRevision],
      options,
    );
    const canonicalWorktree = await realpath(worktreePath);
    assertContained(this.#worktreesRoot, canonicalWorktree);
    const host: NodeGitWorktreeHost = Object.freeze({
      kind: "git-worktree",
      workspaceId,
      executionId,
      taskId,
      repoRoot: this.#repoRoot,
      worktreePath: canonicalWorktree,
      worktreesRoot: this.#worktreesRoot,
      baseRevision: this.#baseRevision,
      [HOST_BRAND]: true as const,
    });
    this.#issued.add(host);
    this.#active.set(workspaceId, host);
    const descriptor: WorkspaceDescriptor = Object.freeze({
      workspaceId,
      providerId: "node-git-worktree",
      executionId,
      taskId,
      revision: this.#baseRevision,
      parameters: optionalJsonObject(request.parameters, "parameters"),
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

  async cleanup(
    workspace: NodeGitWorktreeHost,
    options: WorkflowChangeOperationOptions = {},
  ): Promise<boolean> {
    this.#assertOwnedWorkspace(workspace);
    if (!this.#active.has(workspace.workspaceId)) return false;
    throwIfAborted(options.signal);
    await this.#git(
      this.#repoRoot,
      ["worktree", "remove", "--force", workspace.worktreePath],
      options,
    );
    this.#active.delete(workspace.workspaceId);
    return true;
  }

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
            "--find-renames",
            "--no-ext-diff",
            workspace.baseRevision,
            "--",
          ],
          options,
        )
      ).stdout,
    );
    const trackedPaths = new Set(
      tracked.flatMap((change) =>
        change.status === "renamed"
          ? [change.fromPath as string, change.toPath as string]
          : [change.path as string],
      ),
    );
    const untracked = splitNul(
      (
        await this.#git(
          workspace.worktreePath,
          ["ls-files", "--others", "--exclude-standard", "-z", "--"],
          options,
        )
      ).stdout,
    ).filter((path) => !trackedPaths.has(path));
    const entries: WorkflowChangeEntry[] = [];
    for (const change of tracked) {
      throwIfAborted(options.signal);
      entries.push(
        await this.#materializeChange(workspace, change, options.signal),
      );
    }
    for (const path of untracked) {
      throwIfAborted(options.signal);
      const current = await this.#currentEntry(workspace, path);
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
    await this.#assertHead(workspace, options);
    throwIfAborted(options.signal);
    await this.#git(workspace.worktreePath, ["add", "--all", "--"], options);
    await this.#git(
      workspace.worktreePath,
      ["commit", "--no-gpg-sign", "--no-verify", "-m", input.message],
      options,
    );
    const commitId = await this.#resolveCommit(
      workspace.worktreePath,
      "HEAD",
      options,
    );
    const parent = await this.#resolveCommit(
      workspace.worktreePath,
      `${commitId}^`,
      options,
    );
    if (parent !== workspace.baseRevision) {
      throw new NodeGitWorktreeError(
        "GIT_COMMIT_NOT_FAST_FORWARD",
        "Worktree commit is not based directly on its configured base revision",
      );
    }
    return Object.freeze({
      commitId,
      receiptId: input.receipt.receiptId,
      changeSetDigest: input.changeSet.changeSetDigest,
      workspaceRevision: input.changeSet.workspaceRevision,
      baseRevision: input.changeSet.baseRevision,
      committedAt: nonNegativeTimestamp(this.#now()),
    });
  }

  async integrate(
    repository: NodeGitRepositoryHost,
    request: WorkflowIntegrationRequest,
    options: WorkflowChangeOperationOptions = {},
  ): Promise<WorkflowIntegrationResult> {
    this.#assertOwnedRepository(repository);
    const targetId = await this.#validatedTargetRef(
      request.expectedTarget.targetId,
      options,
    );
    const expectedRevision = requiredGitObject(
      request.expectedTarget.revision,
      "expected target revision",
    );
    const commitId = await this.#resolveCommit(
      repository.repoRoot,
      requiredGitObject(request.commitId, "commitId"),
      options,
    );
    const currentRevision = await this.#resolveCommit(
      repository.repoRoot,
      targetId,
      options,
    );
    if (currentRevision !== expectedRevision) {
      throw new NodeGitWorktreeError(
        "GIT_TARGET_STALE",
        `Target ${targetId} moved from ${expectedRevision} to ${currentRevision}`,
      );
    }
    const parent = await this.#resolveCommit(
      repository.repoRoot,
      `${commitId}^`,
      options,
    );
    if (parent !== expectedRevision) {
      throw new NodeGitWorktreeError(
        "GIT_COMMIT_NOT_FAST_FORWARD",
        "Integration commit must have the expected target as its sole parent",
      );
    }
    try {
      await this.#git(
        repository.repoRoot,
        ["update-ref", targetId, commitId, expectedRevision],
        options,
      );
    } catch (error) {
      throwIfAborted(options.signal);
      const latest = await this.#resolveCommit(
        repository.repoRoot,
        targetId,
        options,
      );
      if (latest !== expectedRevision) {
        throw new NodeGitWorktreeError(
          "GIT_TARGET_STALE",
          `Target ${targetId} concurrently moved to ${latest}`,
        );
      }
      throw error;
    }
    const integratedRevision = await this.#resolveCommit(
      repository.repoRoot,
      targetId,
      options,
    );
    if (integratedRevision !== commitId) {
      throw new NodeGitWorktreeError(
        "GIT_TARGET_STALE",
        "Git did not update the target to the exact requested commit",
      );
    }
    return Object.freeze({
      integrationId: randomUUID(),
      commitId,
      targetId,
      previousRevision: currentRevision,
      integratedRevision,
      integratedAt: nonNegativeTimestamp(this.#now()),
    });
  }

  async #materializeChange(
    workspace: NodeGitWorktreeHost,
    change: ParsedGitChange,
    signal?: AbortSignal,
  ): Promise<WorkflowChangeEntry> {
    if (change.status === "renamed") {
      const toPath = change.toPath as string;
      return {
        kind: "renamed",
        fromPath: change.fromPath as string,
        toPath,
        ...(await this.#currentEntry(workspace, toPath)),
      };
    }
    const path = change.path as string;
    if (change.status === "deleted") {
      return {
        kind: "deleted",
        path,
        ...(await this.#baseEntry(workspace, path, signal)),
      };
    }
    return {
      kind: change.status,
      path,
      ...(await this.#currentEntry(workspace, path)),
    };
  }

  async #currentEntry(
    workspace: NodeGitWorktreeHost,
    portablePath: string,
  ): Promise<{
    entryKind: WorkflowChangeEntryKind;
    contentDigest: string;
  }> {
    const absolutePath = resolve(workspace.worktreePath, portablePath);
    assertContained(workspace.worktreePath, absolutePath);
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      const target = await realpath(absolutePath).catch(() => undefined);
      if (!target || !isContained(workspace.worktreePath, target)) {
        throw new NodeGitWorktreeError(
          "GIT_SYMLINK_ESCAPE",
          `Changed symlink escapes the worktree: ${portablePath}`,
        );
      }
      return {
        entryKind: "symlink",
        contentDigest: digest(Buffer.from(await readlink(absolutePath))),
      };
    }
    const indexEntry = await this.#indexEntry(workspace, portablePath);
    if (indexEntry?.mode === "160000") {
      return {
        entryKind: "submodule",
        contentDigest: digest(Buffer.from(indexEntry.objectId)),
      };
    }
    if (stat.isDirectory()) {
      return {
        entryKind: "directory",
        contentDigest: digest(Buffer.alloc(0)),
      };
    }
    if (!stat.isFile()) {
      throw new NodeGitWorktreeError(
        "GIT_CONFIGURATION_INVALID",
        `Unsupported changed filesystem entry: ${portablePath}`,
      );
    }
    return {
      entryKind: "file",
      contentDigest: digest(await readFile(absolutePath)),
    };
  }

  async #baseEntry(
    workspace: NodeGitWorktreeHost,
    portablePath: string,
    signal?: AbortSignal,
  ): Promise<{
    entryKind: WorkflowChangeEntryKind;
    contentDigest: string;
  }> {
    const listing = textOutput(
      (
        await this.#git(
          workspace.worktreePath,
          ["ls-tree", workspace.baseRevision, "--", portablePath],
          { signal },
        )
      ).stdout,
    );
    const match = /^(\d{6})\s+(\w+)\s+([a-f0-9]+)\t/u.exec(listing);
    if (!match) {
      throw new NodeGitWorktreeError(
        "GIT_CONFIGURATION_INVALID",
        `Deleted entry is absent from base revision: ${portablePath}`,
      );
    }
    const [, mode, type, objectId] = match;
    if (mode === "160000" || type === "commit") {
      return {
        entryKind: "submodule",
        contentDigest: digest(Buffer.from(objectId)),
      };
    }
    const content = (
      await this.#git(
        workspace.worktreePath,
        ["show", `${workspace.baseRevision}:${portablePath}`],
        { signal },
      )
    ).stdout;
    return {
      entryKind: mode === "120000" ? "symlink" : "file",
      contentDigest: digest(content),
    };
  }

  async #indexEntry(
    workspace: NodeGitWorktreeHost,
    portablePath: string,
  ): Promise<{ mode: string; objectId: string } | undefined> {
    const output = textOutput(
      (
        await this.#git(workspace.worktreePath, [
          "ls-files",
          "--stage",
          "--",
          portablePath,
        ])
      ).stdout,
    );
    const match = /^(\d{6})\s+([a-f0-9]+)\s+\d+\t/u.exec(output);
    return match ? { mode: match[1], objectId: match[2] } : undefined;
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
    await this.#git(
      this.#repoRoot,
      ["check-ref-format", "--branch", targetId.slice("refs/heads/".length)],
      options,
    );
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
        "GIT_CONFIGURATION_INVALID",
        `Git returned an invalid commit identity for ${revision}`,
      );
    }
    return resolved;
  }

  async #git(
    cwd: string,
    args: readonly string[],
    options: WorkflowChangeOperationOptions = {},
  ): Promise<GitCommandResult> {
    return await runGit(cwd, args, this.#timeoutMs, {
      signal: options.signal,
    });
  }
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

function parseNameStatus(output: Buffer): ParsedGitChange[] {
  const fields = splitNul(output);
  const changes: ParsedGitChange[] = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (/^R\d*$/u.test(status)) {
      const fromPath = fields[index++];
      const toPath = fields[index++];
      if (!fromPath || !toPath) throw malformedDiff();
      changes.push({ status: "renamed", fromPath, toPath });
      continue;
    }
    const path = fields[index++];
    if (!path) throw malformedDiff();
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
    "GIT_CONFIGURATION_INVALID",
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
    .sort((left, right) => left.path.localeCompare(right.path));
  const consumed = new Set<WorkflowChangeEntry>();
  const renamed: WorkflowChangeEntry[] = [];
  for (const deleted of entries
    .filter((entry) => entry.kind === "deleted")
    .sort((left, right) => left.path.localeCompare(right.path))) {
    const added = additions.find(
      (candidate) =>
        !consumed.has(candidate) &&
        candidate.entryKind === deleted.entryKind &&
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

function requiredIdentity(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,255}$/u.test(value)
  ) {
    throw new TypeError(`${field} must be a safe identity`);
  }
  return value;
}

function requiredRevision(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,511}$/u.test(value)
  ) {
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

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new Error("Git workflow operation aborted");
}

async function runGit(
  cwd: string,
  args: readonly string[],
  timeoutMs: number,
  options: GitCommandOptions = {},
): Promise<GitCommandResult> {
  throwIfAborted(options.signal);
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
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const exitCode = typeof error?.code === "number" ? error.code : 0;
        if (error && !options.allowExitCodes?.includes(exitCode)) {
          reject(error);
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
