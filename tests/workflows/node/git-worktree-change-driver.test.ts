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
  WORKFLOW_CHANGE_AUTHORITY_LEASE,
  type WorkflowAcceptedChangeReceipt,
  type WorkflowChangeReceiptAuthority,
  type WorkflowCommitAuthorityRequest,
  type WorkflowIntegrationAuthorityRequest,
  WorkflowValidatedCommitter,
  WorkflowValidatedIntegrator,
} from "../../../src/workflows/workspace/change-driver.js";
import {
  InMemoryWorkflowHostMutationJournal,
  type WorkflowHostMutationJournal,
} from "../../../src/workflows/workspace/mutation-journal.js";

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
  targetId: string;
  journal: WorkflowHostMutationJournal;
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
  const targetId = "refs/heads/publication";
  git(repoRoot, "branch", "publication", baseRevision);
  const journal = new InMemoryWorkflowHostMutationJournal();
  const driver = await NodeGitWorktreeChangeDriver.create({
    repoRoot,
    worktreesRoot,
    baseRevision,
    createWorkspaceId: (() => {
      let next = 0;
      return () => `workspace-${++next}`;
    })(),
    now: () => 1234,
    mutationJournal: journal,
  });
  return {
    root,
    repoRoot,
    worktreesRoot,
    baseRevision,
    targetId,
    journal,
    driver,
  };
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
      targetId: "refs/heads/publication",
      revision: expectedTargetRevision,
    },
    agentId: "agent-1",
    orchestrationRevision: 2,
  };
}

function authority(
  journal: WorkflowHostMutationJournal,
  hooks: {
    acquireCommit?: (request: WorkflowCommitAuthorityRequest) => Promise<void>;
    acquireIntegration?: (
      request: WorkflowIntegrationAuthorityRequest,
    ) => Promise<void>;
  } = {},
): WorkflowChangeReceiptAuthority {
  return {
    acquireCommit: async (request) => {
      await journal.begin({
        operationId: request.operationId,
        intentDigest: request.intentDigest,
        kind: "commit",
        executionId: request.receipt.executionId,
        taskId: request.receipt.taskId,
        startedAt: 1234,
      });
      await hooks.acquireCommit?.(request);
      return {
        [WORKFLOW_CHANGE_AUTHORITY_LEASE]: true,
        leaseId: `lease-${request.operationId}`,
        reservationId: `reservation-${request.operationId}`,
        operationId: request.operationId,
        intentDigest: request.intentDigest,
      };
    },
    completeCommit: async (lease, result) => {
      await journal.complete(lease.operationId, lease.intentDigest, result);
    },
    acquireIntegration: async (request) => {
      await journal.begin({
        operationId: request.operationId,
        intentDigest: request.intentDigest,
        kind: "integration",
        executionId: request.receipt.executionId,
        taskId: request.receipt.taskId,
        startedAt: 1234,
      });
      await hooks.acquireIntegration?.(request);
      return {
        [WORKFLOW_CHANGE_AUTHORITY_LEASE]: true,
        leaseId: `lease-${request.operationId}`,
        reservationId: `reservation-${request.operationId}`,
        operationId: request.operationId,
        intentDigest: request.intentDigest,
      };
    },
    completeIntegration: async (lease, result) => {
      await journal.complete(lease.operationId, lease.intentDigest, result);
    },
    release: async () => {},
    reconcile: async (request) => {
      const record = await journal.get(request.operationId);
      return { status: record?.status ?? "absent" };
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
        authority(repository.journal),
      ).commit(workspace.host, {
        receipt,
        message: "must not commit",
        operationId: "commit-changed-snapshot",
      }),
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
      authority(repository.journal),
    ).commit(workspace.host, {
      receipt,
      message: "atomic workflow change",
      operationId: "commit-atomic",
    });

    expect(commit.baseRevision).toBe(repository.baseRevision);
    expect(git(workspace.host.worktreePath, "rev-parse", "HEAD")).toBe(
      repository.baseRevision,
    );
    const integrator = new WorkflowValidatedIntegrator(
      repository.driver,
      authority(repository.journal),
    );
    await expect(
      integrator.integrate(repository.driver.repository, {
        executionId: "execution-1",
        taskId: "task-1",
        commitId: commit.commitId,
        receiptId: receipt.receiptId,
        changeSetDigest: changeSet.changeSetDigest,
        expectedTarget: {
          targetId: "refs/heads/main",
          revision: "f".repeat(40),
        },
        operationId: "integration-stale",
        receipt: {
          ...receipt,
          expectedTarget: {
            targetId: "refs/heads/main",
            revision: "f".repeat(40),
          },
        },
        commit,
      }),
    ).rejects.toMatchObject({ code: "GIT_TARGET_CHECKED_OUT" });
    expect(git(repository.repoRoot, "rev-parse", "refs/heads/main")).toBe(
      repository.baseRevision,
    );

    const integration = await integrator.integrate(
      repository.driver.repository,
      {
        executionId: "execution-1",
        taskId: "task-1",
        commitId: commit.commitId,
        receiptId: receipt.receiptId,
        changeSetDigest: changeSet.changeSetDigest,
        expectedTarget: receipt.expectedTarget,
        operationId: "integration-atomic",
        receipt,
        commit,
      },
    );
    expect(integration.previousRevision).toBe(repository.baseRevision);
    expect(integration.integratedRevision).toBe(commit.commitId);
    expect(git(repository.repoRoot, "rev-parse", repository.targetId)).toBe(
      commit.commitId,
    );
  });

  test("commits the prepared tree even when the worktree changes after authority validation", async () => {
    const repository = await createRepository();
    const workspace = await provision(repository);
    await writeFile(
      join(workspace.host.worktreePath, "tracked.txt"),
      "accepted snapshot\n",
    );
    const changeSet = await repository.driver.inspect(
      workspace.host,
      inspectionRequest(repository),
    );
    const receipt = receiptFor(changeSet, repository.baseRevision);
    const liveAuthority = authority(repository.journal, {
      acquireCommit: async () => {
        await writeFile(
          join(workspace.host.worktreePath, "late.txt"),
          "must not enter the commit\n",
        );
      },
    });

    const commit = await new WorkflowValidatedCommitter(
      repository.driver,
      repository.driver,
      liveAuthority,
    ).commit(workspace.host, {
      receipt,
      message: "prepared tree only",
      operationId: "commit-prepared-tree",
    });

    expect(
      git(repository.repoRoot, "ls-tree", "-r", "--name-only", commit.commitId),
    ).not.toContain("late.txt");
    expect(
      git(repository.repoRoot, "show", `${commit.commitId}:tracked.txt`),
    ).toBe("accepted snapshot");
    expect(
      git(repository.repoRoot, "rev-parse", `${commit.commitId}^{tree}`),
    ).toBe(commit.treeId);
  });

  test("attaches a durable workspace descriptor after a driver restart", async () => {
    const repository = await createRepository();
    const workspace = await provision(repository);
    await writeFile(join(workspace.host.worktreePath, "restart.txt"), "kept\n");
    const restarted = await NodeGitWorktreeChangeDriver.create({
      repoRoot: repository.repoRoot,
      worktreesRoot: repository.worktreesRoot,
      baseRevision: repository.baseRevision,
      mutationJournal: repository.journal,
      now: () => 1234,
    });

    await expect(
      restarted.attach({
        ...workspace.descriptor,
        executionId: "forged-execution",
      }),
    ).resolves.toBeUndefined();
    const attached = await restarted.recover(workspace.descriptor);
    const inspected = await restarted.inspect(
      attached.host,
      inspectionRequest(repository),
    );

    expect(inspected.entries.map((entry) => entry.kind)).toContain("added");
    expect(attached.host.workspaceId).toBe(workspace.descriptor.workspaceId);
    expect(await attached.detach()).toBe(true);
    expect(await attached.detach()).toBe(false);
    await expect(
      restarted.inspect(attached.host, inspectionRequest(repository)),
    ).rejects.toMatchObject({ code: "GIT_WORKTREE_STALE" });
    await expect(
      restarted.recover(workspace.descriptor),
    ).resolves.toBeDefined();
  });

  test("reconciles an ambiguous commit journal entry and returns it idempotently", async () => {
    const repository = await createRepository();
    const workspace = await provision(repository);
    await writeFile(
      join(workspace.host.worktreePath, "tracked.txt"),
      "retry\n",
    );
    const changeSet = await repository.driver.inspect(
      workspace.host,
      inspectionRequest(repository),
    );
    const receipt = receiptFor(changeSet, repository.baseRevision);
    let firstAcquire = true;
    const liveAuthority = authority(repository.journal, {
      acquireCommit: async (request) => {
        if (!firstAcquire) return;
        firstAcquire = false;
        await repository.journal.markAmbiguous(
          request.operationId,
          request.intentDigest,
          "simulated host restart after immutable object write",
        );
      },
    });
    const committer = new WorkflowValidatedCommitter(
      repository.driver,
      repository.driver,
      liveAuthority,
    );

    const first = await committer.commit(workspace.host, {
      receipt,
      message: "idempotent commit",
      operationId: "commit-recovery",
    });
    const retry = await committer.commit(workspace.host, {
      receipt,
      message: "idempotent commit",
      operationId: "commit-recovery",
    });

    expect(retry).toEqual(first);
    expect((await repository.journal.get("commit-recovery"))?.status).toBe(
      "completed",
    );
    expect(git(repository.repoRoot, "cat-file", "-t", first.commitId)).toBe(
      "commit",
    );
  });

  test("rejects integration into a branch checked out by any worktree", async () => {
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
    const liveAuthority = authority(repository.journal);
    const commit = await new WorkflowValidatedCommitter(
      repository.driver,
      repository.driver,
      liveAuthority,
    ).commit(workspace.host, {
      receipt,
      message: "checked target",
      operationId: "commit-checked-target",
    });
    const checkedOutReceipt = {
      ...receipt,
      expectedTarget: {
        targetId: "refs/heads/main",
        revision: repository.baseRevision,
      },
    };

    await expect(
      new WorkflowValidatedIntegrator(
        repository.driver,
        liveAuthority,
      ).integrate(repository.driver.repository, {
        executionId: receipt.executionId,
        taskId: receipt.taskId,
        commitId: commit.commitId,
        receiptId: receipt.receiptId,
        changeSetDigest: receipt.changeSetDigest,
        expectedTarget: checkedOutReceipt.expectedTarget,
        operationId: "integration-checked-target",
        receipt: checkedOutReceipt,
        commit,
      }),
    ).rejects.toMatchObject({ code: "GIT_TARGET_CHECKED_OUT" });
    expect(git(repository.repoRoot, "rev-parse", "refs/heads/main")).toBe(
      repository.baseRevision,
    );
  });

  test("rejects stale receipt authority before publishing a commit", async () => {
    const repository = await createRepository();
    const workspace = await provision(repository);
    await writeFile(
      join(workspace.host.worktreePath, "tracked.txt"),
      "stale\n",
    );
    const changeSet = await repository.driver.inspect(
      workspace.host,
      inspectionRequest(repository),
    );
    const receipt = receiptFor(changeSet, repository.baseRevision);
    const staleAuthority = authority(repository.journal, {
      acquireCommit: async () => {
        throw Object.assign(new Error("receipt lost live ownership"), {
          code: "WORKFLOW_CHANGE_AUTHORITY_INVALID",
        });
      },
    });

    await expect(
      new WorkflowValidatedCommitter(
        repository.driver,
        repository.driver,
        staleAuthority,
      ).commit(workspace.host, {
        receipt,
        message: "must not publish",
        operationId: "commit-stale-receipt",
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_CHANGE_AUTHORITY_INVALID" });
    expect(git(repository.repoRoot, "rev-parse", repository.targetId)).toBe(
      repository.baseRevision,
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
