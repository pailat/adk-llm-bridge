/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NodeGitWorktreeChangeDriver,
  type NodeGitWorktreeHost,
} from "../../../src/workflows/node/git-worktree-change-driver.js";
import {
  type WorkflowAcceptedChangeReceipt,
  WorkflowValidatedCommitter,
} from "../../../src/workflows/workspace/change-driver.js";

const temporaryRoots = new Set<string>();

afterEach(async () => {
  for (const root of temporaryRoots) {
    await rm(root, { recursive: true, force: true });
  }
  temporaryRoots.clear();
});

interface TestRepository {
  root: string;
  repoRoot: string;
  worktreesRoot: string;
  baseRevision: string;
  driver: NodeGitWorktreeChangeDriver;
}

async function createRepository(): Promise<TestRepository> {
  const root = await mkdtemp(join(tmpdir(), "adk-git-workflow-"));
  temporaryRoots.add(root);
  const repoRoot = join(root, "repo");
  const worktreesRoot = join(root, "worktrees");
  await mkdir(repoRoot);
  await mkdir(worktreesRoot);
  git(root, "init", "--initial-branch=main", repoRoot);
  git(repoRoot, "config", "user.name", "Workflow Test");
  git(repoRoot, "config", "user.email", "workflow@example.test");
  await writeFile(join(repoRoot, "tracked.txt"), "base\n");
  await writeFile(join(repoRoot, "delete.txt"), "delete me\n");
  await writeFile(join(repoRoot, "rename-from.txt"), "rename me\n");
  git(repoRoot, "add", "--all", "--");
  git(repoRoot, "commit", "--no-gpg-sign", "--no-verify", "-m", "base");
  const baseRevision = git(repoRoot, "rev-parse", "HEAD");
  const driver = await NodeGitWorktreeChangeDriver.create({
    repoRoot,
    worktreesRoot,
    baseRevision,
    createWorkspaceId: (() => {
      let next = 0;
      return () => `workspace-${++next}`;
    })(),
    now: () => 1234,
  });
  return { root, repoRoot, worktreesRoot, baseRevision, driver };
}

async function provision(repository: TestRepository, taskId = "task-1") {
  return await repository.driver.provision({
    executionId: "execution-1",
    taskId,
  });
}

function inspectionRequest(repository: TestRepository, taskId = "task-1") {
  return {
    executionId: "execution-1",
    taskId,
    planRevision: 1,
    workspaceRevision: repository.baseRevision,
    baseRevision: repository.baseRevision,
  };
}

function receiptFor(
  changeSet: Awaited<ReturnType<NodeGitWorktreeChangeDriver["inspect"]>>,
  expectedTargetRevision: string,
): WorkflowAcceptedChangeReceipt {
  return {
    receiptId: "receipt-1",
    verdict: "accepted",
    executionId: changeSet.executionId,
    taskId: changeSet.taskId,
    planRevision: changeSet.planRevision,
    workspaceRevision: changeSet.workspaceRevision,
    baseRevision: changeSet.baseRevision,
    changeSetDigest: changeSet.changeSetDigest,
    ownership: [{ grantId: "grant-1", fencingToken: 1 }],
    issuedAt: 1000,
    expectedTarget: {
      targetId: "refs/heads/main",
      revision: expectedTargetRevision,
    },
  };
}

describe("NodeGitWorktreeChangeDriver", () => {
  test("provisions at an immutable base and inspects a stable diff without mutation", async () => {
    const repository = await createRepository();
    const workspace = await provision(repository);
    await writeFile(
      join(workspace.host.worktreePath, "tracked.txt"),
      "changed\n",
    );
    await unlink(join(workspace.host.worktreePath, "delete.txt"));
    await writeFile(join(workspace.host.worktreePath, "new.txt"), "new\n");
    await rename(
      join(workspace.host.worktreePath, "rename-from.txt"),
      join(workspace.host.worktreePath, "rename-to.txt"),
    );

    const headBefore = git(workspace.host.worktreePath, "rev-parse", "HEAD");
    const statusBefore = gitRaw(
      workspace.host.worktreePath,
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
    );
    const first = await repository.driver.inspect(
      workspace.host,
      inspectionRequest(repository),
    );
    const second = await repository.driver.inspect(
      workspace.host,
      inspectionRequest(repository),
    );

    expect(first).toEqual(second);
    expect(first.entries.map((entry) => entry.kind)).toEqual([
      "deleted",
      "added",
      "renamed",
      "modified",
    ]);
    expect(first.entries.every((entry) => entry.entryKind === "file")).toBe(
      true,
    );
    expect(
      first.entries.every((entry) =>
        /^sha256:[a-f0-9]{64}$/u.test(entry.contentDigest),
      ),
    ).toBe(true);
    expect(git(workspace.host.worktreePath, "rev-parse", "HEAD")).toBe(
      headBefore,
    );
    expect(
      gitRaw(
        workspace.host.worktreePath,
        "status",
        "--porcelain=v2",
        "-z",
        "--untracked-files=all",
      ),
    ).toEqual(statusBefore);

    expect(await workspace.release()).toBe(true);
    expect(await workspace.release()).toBe(false);
  });

  test("validated committer refuses a changed snapshot before Git mutation", async () => {
    const repository = await createRepository();
    const workspace = await provision(repository);
    await writeFile(
      join(workspace.host.worktreePath, "tracked.txt"),
      "accepted\n",
    );
    const accepted = await repository.driver.inspect(
      workspace.host,
      inspectionRequest(repository),
    );
    const receipt = receiptFor(accepted, repository.baseRevision);
    await writeFile(
      join(workspace.host.worktreePath, "unreviewed.txt"),
      "not accepted\n",
    );

    await expect(
      new WorkflowValidatedCommitter(
        repository.driver,
        repository.driver,
      ).commit(workspace.host, { receipt, message: "must not commit" }),
    ).rejects.toMatchObject({ code: "CHANGE_RECEIPT_MISMATCH" });
    expect(git(workspace.host.worktreePath, "rev-parse", "HEAD")).toBe(
      repository.baseRevision,
    );
    expect(
      git(workspace.host.worktreePath, "diff", "--cached", "--name-only"),
    ).toBe("");
  });

  test("commits a revalidated snapshot and atomically integrates exactly that commit", async () => {
    const repository = await createRepository();
    const workspace = await provision(repository);
    await writeFile(
      join(workspace.host.worktreePath, "tracked.txt"),
      "ready\n",
    );
    const changeSet = await repository.driver.inspect(
      workspace.host,
      inspectionRequest(repository),
    );
    const receipt = receiptFor(changeSet, repository.baseRevision);
    const commit = await new WorkflowValidatedCommitter(
      repository.driver,
      repository.driver,
    ).commit(workspace.host, { receipt, message: "atomic workflow change" });

    expect(commit.baseRevision).toBe(repository.baseRevision);
    expect(git(workspace.host.worktreePath, "rev-parse", "HEAD")).toBe(
      commit.commitId,
    );
    await expect(
      repository.driver.integrate(repository.driver.repository, {
        executionId: "execution-1",
        taskId: "task-1",
        commitId: commit.commitId,
        receiptId: receipt.receiptId,
        changeSetDigest: changeSet.changeSetDigest,
        expectedTarget: {
          targetId: "refs/heads/main",
          revision: "f".repeat(40),
        },
      }),
    ).rejects.toMatchObject({ code: "GIT_TARGET_STALE" });
    expect(git(repository.repoRoot, "rev-parse", "refs/heads/main")).toBe(
      repository.baseRevision,
    );

    const integration = await repository.driver.integrate(
      repository.driver.repository,
      {
        executionId: "execution-1",
        taskId: "task-1",
        commitId: commit.commitId,
        receiptId: receipt.receiptId,
        changeSetDigest: changeSet.changeSetDigest,
        expectedTarget: receipt.expectedTarget,
      },
    );
    expect(integration.previousRevision).toBe(repository.baseRevision);
    expect(integration.integratedRevision).toBe(commit.commitId);
    expect(git(repository.repoRoot, "rev-parse", "refs/heads/main")).toBe(
      commit.commitId,
    );
  });

  test("rejects a changed symlink that escapes its worktree", async () => {
    const repository = await createRepository();
    const workspace = await provision(repository);
    const outside = join(repository.root, "outside.txt");
    await writeFile(outside, "secret\n");
    await symlink(outside, join(workspace.host.worktreePath, "escape.txt"));

    await expect(
      repository.driver.inspect(workspace.host, inspectionRequest(repository)),
    ).rejects.toMatchObject({ code: "GIT_SYMLINK_ESCAPE" });
    expect(git(workspace.host.worktreePath, "rev-parse", "HEAD")).toBe(
      repository.baseRevision,
    );
  });

  test("rejects forged host handles and stale inspection identities", async () => {
    const repository = await createRepository();
    const workspace = await provision(repository);
    await expect(
      repository.driver.inspect(
        { ...workspace.host } as NodeGitWorktreeHost,
        inspectionRequest(repository),
      ),
    ).rejects.toMatchObject({ code: "GIT_CONFIGURATION_INVALID" });
    await expect(
      repository.driver.inspect(workspace.host, {
        ...inspectionRequest(repository),
        workspaceRevision: "wrong-revision",
      }),
    ).rejects.toMatchObject({ code: "GIT_CHANGE_SET_MISMATCH" });
  });
});

function git(cwd: string, ...args: string[]): string {
  return gitRaw(cwd, ...args)
    .toString("utf8")
    .trim();
}

function gitRaw(cwd: string, ...args: string[]): Buffer {
  return execFileSync("git", args, {
    cwd,
    encoding: "buffer",
    maxBuffer: 8 * 1024 * 1024,
  });
}
