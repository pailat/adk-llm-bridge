import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  FileSystemWorkflowRepositoryMutationLock,
  NodeGitWorktreeChangeDriver,
  type NodeGitWorktreeHost,
} from "../../../src/workflows/node/git-worktree-change-driver.js";
import type { WorkflowResourceJsonObject } from "../../../src/workflows/resources/json.js";
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
/** Above the default `pid_max` of Linux and macOS, so no process has it. */
const DEAD_PID = 2_147_483_646;

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

/**
 * Command limit of the timeout test: well above what real Git needs, even
 * with several test runs sharing one machine.
 */
const SLOW_HOST_COMMAND_TIMEOUT_MS = 2_000;

/** Per-test deadline of the timeout test: the limit above plus ample room to provision. */
const TIMEOUT_TEST_DEADLINE_MS = 15_000;

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
      await journal.complete(
        lease.operationId,
        lease.intentDigest,
        flatJson(result),
      );
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
      await journal.complete(
        lease.operationId,
        lease.intentDigest,
        flatJson(result),
      );
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

  test("binds executable mode into the accepted and prepared tree", async () => {
    const repository = await createRepository();
    const workspace = await provision(repository);
    const tracked = join(workspace.host.worktreePath, "tracked.txt");
    await writeFile(tracked, "accepted\n");
    const accepted = await repository.driver.inspect(
      workspace.host,
      inspectionRequest(repository),
    );
    expect(
      accepted.entries.find((entry) => entry.kind === "modified")?.mode,
    ).toBe("100644");
    await chmod(tracked, 0o755);

    await expect(
      new WorkflowValidatedCommitter(
        repository.driver,
        repository.driver,
        authority(repository.journal),
      ).commit(workspace.host, {
        receipt: receiptFor(accepted, repository.baseRevision),
        message: "mode must be reviewed",
        operationId: "commit-mode-race",
      }),
    ).rejects.toMatchObject({ code: "CHANGE_RECEIPT_MISMATCH" });
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

  test("rejects an altered descriptor before reusing an active host capability", async () => {
    const repository = await createRepository();
    const workspace = await provision(repository);
    await expect(
      repository.driver.attach({
        ...workspace.descriptor,
        executionId: "forged-execution",
      }),
    ).rejects.toMatchObject({ code: "GIT_WORKTREE_STALE" });
  });

  test("reconciles provision and cleanup after a previous Git mutation succeeded", async () => {
    const repository = await createRepository();
    const first = await provision(repository);
    const restarted = await NodeGitWorktreeChangeDriver.create({
      repoRoot: repository.repoRoot,
      worktreesRoot: repository.worktreesRoot,
      baseRevision: repository.baseRevision,
      createWorkspaceId: () => "workspace-1",
      mutationJournal: repository.journal,
    });
    const replay = await restarted.provision({
      executionId: "execution-1",
      taskId: "task-1",
    });
    expect(replay.host.worktreePath).toBe(first.host.worktreePath);

    git(
      repository.repoRoot,
      "worktree",
      "remove",
      "--force",
      replay.host.worktreePath,
    );
    await expect(restarted.cleanup(replay.host)).resolves.toBe(true);
    await expect(
      restarted.inspect(replay.host, inspectionRequest(repository)),
    ).rejects.toMatchObject({ code: "GIT_WORKTREE_STALE" });
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

  test("does not attribute a pre-existing target commit to a new integration", async () => {
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
      message: "pre-existing target",
      operationId: "commit-pre-existing",
    });
    git(
      repository.repoRoot,
      "update-ref",
      repository.targetId,
      commit.commitId,
      repository.baseRevision,
    );

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
        expectedTarget: receipt.expectedTarget,
        operationId: "integration-pre-existing",
        receipt,
        commit,
      }),
    ).rejects.toMatchObject({ code: "GIT_MUTATION_AMBIGUOUS" });
  });

  test("replays completed integration after the target legitimately advances", async () => {
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
      message: "historical replay",
      operationId: "commit-historical",
    });
    const integrator = new WorkflowValidatedIntegrator(
      repository.driver,
      liveAuthority,
    );
    const request = {
      executionId: receipt.executionId,
      taskId: receipt.taskId,
      commitId: commit.commitId,
      receiptId: receipt.receiptId,
      changeSetDigest: receipt.changeSetDigest,
      expectedTarget: receipt.expectedTarget,
      operationId: "integration-historical",
      receipt,
      commit,
    };
    const first = await integrator.integrate(
      repository.driver.repository,
      request,
    );
    const tree = git(
      repository.repoRoot,
      "rev-parse",
      `${commit.commitId}^{tree}`,
    );
    const later = git(
      repository.repoRoot,
      "commit-tree",
      tree,
      "-p",
      commit.commitId,
      "-m",
      "later publication",
    );
    git(
      repository.repoRoot,
      "update-ref",
      repository.targetId,
      later,
      commit.commitId,
    );

    await expect(
      integrator.integrate(repository.driver.repository, request),
    ).resolves.toEqual(first);
  });

  test("serializes repository mutations across lock instances", async () => {
    const repository = await createRepository();
    const firstLock = new FileSystemWorkflowRepositoryMutationLock({
      lockRoot: repository.worktreesRoot,
    });
    const secondLock = new FileSystemWorkflowRepositoryMutationLock({
      lockRoot: repository.worktreesRoot,
    });
    const first = await firstLock.acquire(repository.repoRoot);
    let acquired = false;
    const secondPending = secondLock
      .acquire(repository.repoRoot)
      .then((lease) => {
        acquired = true;
        return lease;
      });
    await Bun.sleep(20);
    expect(acquired).toBe(false);
    await first.release();
    const second = await secondPending;
    expect(acquired).toBe(true);
    await second.release();
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

/** Commits extra files to the repository and returns a driver based on them. */
async function withBaseFiles(
  repository: TestRepository,
  files: Record<string, string>,
): Promise<TestRepository> {
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(repository.repoRoot, path), content);
  }
  git(repository.repoRoot, "add", "--all", "--");
  git(
    repository.repoRoot,
    "commit",
    "--no-gpg-sign",
    "--no-verify",
    "-m",
    "extra base",
  );
  const worktreesRoot = await mkdtemp(join(repository.root, "worktrees-"));
  const driver = await NodeGitWorktreeChangeDriver.create({
    repoRoot: repository.repoRoot,
    worktreesRoot,
    baseRevision: "HEAD",
    mutationJournal: repository.journal,
  });
  return {
    ...repository,
    worktreesRoot,
    driver,
    baseRevision: driver.baseRevision,
  };
}

async function commitWorktree(
  repository: TestRepository,
  host: NodeGitWorktreeHost,
  operationId: string,
) {
  const changeSet = await repository.driver.inspect(
    host,
    inspectionRequest(repository),
  );
  const receipt = receiptFor(changeSet, repository.baseRevision);
  const commit = await new WorkflowValidatedCommitter(
    repository.driver,
    repository.driver,
    authority(repository.journal),
  ).commit(host, { receipt, message: operationId, operationId });
  return { changeSet, receipt, commit };
}

async function integrateCommit(
  repository: TestRepository,
  accepted: Awaited<ReturnType<typeof commitWorktree>>,
  operationId: string,
) {
  const { receipt, commit } = accepted;
  return await new WorkflowValidatedIntegrator(
    repository.driver,
    authority(repository.journal),
  ).integrate(repository.driver.repository, {
    executionId: receipt.executionId,
    taskId: receipt.taskId,
    commitId: commit.commitId,
    receiptId: receipt.receiptId,
    changeSetDigest: receipt.changeSetDigest,
    expectedTarget: receipt.expectedTarget,
    operationId,
    receipt,
    commit,
  });
}

describe("NodeGitWorktreeChangeDriver path and tree consistency", () => {
  test("commits a moved and edited file as a deletion plus an addition", async () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index}\n`);
    const repository = await withBaseFiles(await createRepository(), {
      "large.txt": lines.join(""),
    });
    const workspace = await provision(repository);
    await unlink(join(workspace.host.worktreePath, "large.txt"));
    await writeFile(
      join(workspace.host.worktreePath, "moved.txt"),
      `${lines.join("")}edited\n`,
    );

    const { changeSet, commit } = await commitWorktree(
      repository,
      workspace.host,
      "commit-move-edit",
    );

    expect(
      changeSet.entries.map((entry) =>
        entry.kind === "renamed"
          ? `renamed:${entry.toPath}`
          : `${entry.kind}:${entry.path}`,
      ),
    ).toEqual(["deleted:large.txt", "added:moved.txt"]);
    expect(
      git(repository.repoRoot, "show", `${commit.commitId}:moved.txt`),
    ).toEndWith("line 19\nedited");
  });

  test("commits an exact move as the same rename it inspected", async () => {
    const repository = await createRepository();
    const workspace = await provision(repository);
    await rename(
      join(workspace.host.worktreePath, "rename-from.txt"),
      join(workspace.host.worktreePath, "rename-to.txt"),
    );

    const { changeSet, commit } = await commitWorktree(
      repository,
      workspace.host,
      "commit-exact-move",
    );

    expect(changeSet.entries).toMatchObject([
      { kind: "renamed", fromPath: "rename-from.txt", toPath: "rename-to.txt" },
    ]);
    expect(
      git(repository.repoRoot, "ls-tree", "--name-only", commit.commitId),
    ).toContain("rename-to.txt");
  });

  test("pairs an exact move with the first addition in code-unit order", async () => {
    const repository = await createRepository();
    const workspace = await provision(repository);
    await unlink(join(workspace.host.worktreePath, "delete.txt"));
    await writeFile(join(workspace.host.worktreePath, "a.txt"), "delete me\n");
    await writeFile(join(workspace.host.worktreePath, "B.txt"), "delete me\n");

    const { changeSet } = await commitWorktree(
      repository,
      workspace.host,
      "commit-code-unit-order",
    );

    expect(
      changeSet.entries.find((entry) => entry.kind === "renamed"),
    ).toMatchObject({ fromPath: "delete.txt", toPath: "B.txt" });
  });

  test("records only the owner execute bit, as Git does", async () => {
    const repository = await createRepository();
    const workspace = await provision(repository);
    const tracked = join(workspace.host.worktreePath, "tracked.txt");
    await writeFile(tracked, "group executable\n");
    await chmod(tracked, 0o654);

    const { changeSet, commit } = await commitWorktree(
      repository,
      workspace.host,
      "commit-group-exec",
    );

    expect(changeSet.entries[0]?.mode).toBe("100644");
    expect(
      git(repository.repoRoot, "ls-tree", commit.commitId, "--", "tracked.txt"),
    ).toStartWith("100644 ");
  });

  test("treats paths that look like pathspec magic as literal paths", async () => {
    const magic = await withBaseFiles(await createRepository(), {
      ":magic.txt": "base\n",
    });
    const workspace = await provision(magic);
    await writeFile(
      join(workspace.host.worktreePath, ":magic.txt"),
      "edited\n",
    );

    const { commit } = await commitWorktree(
      magic,
      workspace.host,
      "commit-magic-path",
    );
    expect(git(magic.repoRoot, "show", `${commit.commitId}::magic.txt`)).toBe(
      "edited",
    );

    const second = await provision(magic, "task-2");
    await unlink(join(second.host.worktreePath, ":magic.txt"));
    const deleted = await magic.driver.inspect(second.host, {
      ...inspectionRequest(magic, "task-2"),
    });
    expect(deleted.entries).toMatchObject([
      { kind: "deleted", path: ":magic.txt", entryKind: "file" },
    ]);
  });

  test("accepts a dangling in-tree symlink on inspection and commit alike", async () => {
    const repository = await createRepository();
    const workspace = await provision(repository);
    await symlink(
      "missing/target.txt",
      join(workspace.host.worktreePath, "dangling.txt"),
    );

    const { changeSet, commit } = await commitWorktree(
      repository,
      workspace.host,
      "commit-dangling-symlink",
    );

    expect(changeSet.entries).toMatchObject([
      { kind: "added", path: "dangling.txt", entryKind: "symlink" },
    ]);
    expect(
      git(
        repository.repoRoot,
        "ls-tree",
        commit.commitId,
        "--",
        "dangling.txt",
      ),
    ).toStartWith("120000 ");
  });

  test("rejects a relative symlink that leaves the worktree, even when dangling", async () => {
    const repository = await createRepository();
    const workspace = await provision(repository);
    await symlink(
      "../../outside-missing.txt",
      join(workspace.host.worktreePath, "escape.txt"),
    );

    await expect(
      repository.driver.inspect(workspace.host, inspectionRequest(repository)),
    ).rejects.toMatchObject({ code: "GIT_SYMLINK_ESCAPE" });
  });

  test("reports a backslash in a worktree path as a path escape", async () => {
    const repository = await createRepository();
    const workspace = await provision(repository);
    await writeFile(
      join(workspace.host.worktreePath, "back\\slash.txt"),
      "x\n",
    );

    await expect(
      repository.driver.inspect(workspace.host, inspectionRequest(repository)),
    ).rejects.toMatchObject({ code: "GIT_WORKTREE_PATH_ESCAPE" });
  });

  test("ignores GIT_* variables inherited from the host process", async () => {
    const repository = await createRepository();
    const other = await createRepository();
    await writeFile(join(other.repoRoot, "other.txt"), "other\n");
    git(other.repoRoot, "add", "--all", "--");
    git(
      other.repoRoot,
      "commit",
      "--no-gpg-sign",
      "--no-verify",
      "-m",
      "other",
    );
    const saved = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
    };
    process.env.GIT_DIR = join(other.repoRoot, ".git");
    process.env.GIT_INDEX_FILE = join(other.repoRoot, ".git", "index");
    try {
      const driver = await NodeGitWorktreeChangeDriver.create({
        repoRoot: repository.repoRoot,
        worktreesRoot: join(repository.root, "env-worktrees"),
        baseRevision: "main",
      });
      expect(driver.baseRevision).toBe(repository.baseRevision);
      const workspace = await driver.provision({
        executionId: "execution-1",
        taskId: "task-1",
      });
      await writeFile(
        join(workspace.host.worktreePath, "tracked.txt"),
        "env\n",
      );
      const changeSet = await driver.inspect(
        workspace.host,
        inspectionRequest(repository),
      );
      expect(changeSet.entries).toMatchObject([
        { kind: "modified", path: "tracked.txt" },
      ]);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("NodeGitWorktreeChangeDriver inherited Git environment", () => {
  for (const variable of [
    "GIT_GLOB_PATHSPECS",
    "GIT_NOGLOB_PATHSPECS",
    "GIT_ICASE_PATHSPECS",
  ]) {
    test(`inspects and commits with ${variable} inherited from the host`, async () => {
      const repository = await createRepository();
      const workspace = await provision(repository);
      await writeFile(
        join(workspace.host.worktreePath, "tracked.txt"),
        "pathspec\n",
      );
      const { changeSet } = await withEnvironment({ [variable]: "1" }, () =>
        commitWorktree(repository, workspace.host, `commit-${variable}`),
      );
      expect(changeSet.entries).toMatchObject([
        { kind: "modified", path: "tracked.txt" },
      ]);
    });
  }

  test("integrates with quarantine, replace and graft variables inherited from the host", async () => {
    const repository = await createRepository();
    const quarantine = join(repository.repoRoot, ".git", "objects", "incoming");
    await mkdir(quarantine);
    const workspace = await provision(repository);
    await writeFile(
      join(workspace.host.worktreePath, "tracked.txt"),
      "quarantine\n",
    );
    const result = await withEnvironment(
      {
        GIT_QUARANTINE_PATH: quarantine,
        GIT_REPLACE_REF_BASE: "refs/replace/",
        GIT_GRAFT_FILE: join(repository.root, "grafts"),
        GIT_SHALLOW_FILE: join(repository.root, "shallow"),
      },
      async () => {
        const accepted = await commitWorktree(
          repository,
          workspace.host,
          "commit-quarantine",
        );
        await integrateCommit(repository, accepted, "integrate-quarantine");
        return accepted;
      },
    );
    expect(git(repository.repoRoot, "rev-parse", repository.targetId)).toBe(
      result.commit.commitId,
    );
  });

  test("ignores replace refs in the repository", async () => {
    const repository = await createRepository();
    await writeFile(join(repository.root, "fake.txt"), "fake\n");
    const blob = git(
      repository.repoRoot,
      "hash-object",
      "-w",
      "--",
      join(repository.root, "fake.txt"),
    );
    const tree = execFileSync("git", ["mktree"], {
      cwd: repository.repoRoot,
      input: `100644 blob ${blob}\ttracked.txt\n`,
    })
      .toString("utf8")
      .trim();
    const fake = git(
      repository.repoRoot,
      "commit-tree",
      "--no-gpg-sign",
      "-m",
      "fake",
      tree,
    );
    git(repository.repoRoot, "replace", repository.baseRevision, fake);

    const workspace = await provision(repository);
    await writeFile(
      join(workspace.host.worktreePath, "tracked.txt"),
      "replaced\n",
    );
    const { changeSet, commit } = await commitWorktree(
      repository,
      workspace.host,
      "commit-replace",
    );

    expect(changeSet.entries).toMatchObject([
      { kind: "modified", path: "tracked.txt" },
    ]);
    expect(
      git(
        repository.repoRoot,
        "--no-replace-objects",
        "ls-tree",
        "--name-only",
        commit.commitId,
      ).split("\n"),
    ).toEqual(["delete.txt", "rename-from.txt", "tracked.txt"]);
  });
});

describe("NodeGitWorktreeChangeDriver with core.fileMode disabled", () => {
  test("keeps the base mode of a tracked file whose execute bit changed", async () => {
    const repository = await createRepository();
    git(repository.repoRoot, "config", "core.fileMode", "false");
    const workspace = await provision(repository);
    const tracked = join(workspace.host.worktreePath, "tracked.txt");
    await writeFile(tracked, "now executable\n");
    await chmod(tracked, 0o755);

    const { changeSet, commit } = await commitWorktree(
      repository,
      workspace.host,
      "commit-filemode-tracked",
    );

    expect(changeSet.entries).toMatchObject([
      { kind: "modified", path: "tracked.txt", mode: "100644" },
    ]);
    expect(
      git(repository.repoRoot, "ls-tree", commit.commitId, "--", "tracked.txt"),
    ).toStartWith("100644 ");
  });

  test("keeps an executable base mode when the file lost its execute bit", async () => {
    const base = await createRepository();
    await writeFile(join(base.repoRoot, "run.sh"), "echo base\n");
    await chmod(join(base.repoRoot, "run.sh"), 0o755);
    const repository = await withBaseFiles(base, {});
    git(repository.repoRoot, "config", "core.fileMode", "false");
    const workspace = await provision(repository);
    const script = join(workspace.host.worktreePath, "run.sh");
    await writeFile(script, "echo edited\n");
    await chmod(script, 0o644);

    const { changeSet } = await commitWorktree(
      repository,
      workspace.host,
      "commit-filemode-executable",
    );

    expect(changeSet.entries).toMatchObject([
      { kind: "modified", path: "run.sh", mode: "100755" },
    ]);
  });

  test("records a new executable file as 100644", async () => {
    const repository = await createRepository();
    git(repository.repoRoot, "config", "core.fileMode", "false");
    const workspace = await provision(repository);
    const created = join(workspace.host.worktreePath, "new.sh");
    await writeFile(created, "echo new\n");
    await chmod(created, 0o755);

    const { changeSet, commit } = await commitWorktree(
      repository,
      workspace.host,
      "commit-filemode-new",
    );

    expect(changeSet.entries).toMatchObject([
      { kind: "added", path: "new.sh", mode: "100644" },
    ]);
    expect(
      git(repository.repoRoot, "ls-tree", commit.commitId, "--", "new.sh"),
    ).toStartWith("100644 ");
  });
});

describe("NodeGitWorktreeChangeDriver integration targets", () => {
  test("rejects a malformed target ref with a driver error", async () => {
    const repository = await createRepository();
    const workspace = await provision(repository);
    await writeFile(join(workspace.host.worktreePath, "tracked.txt"), "x\n");
    const accepted = await commitWorktree(
      repository,
      workspace.host,
      "commit-bad-ref",
    );
    const expectedTarget = {
      targetId: "refs/heads/bad..name",
      revision: repository.baseRevision,
    };

    await expect(
      integrateCommit(
        repository,
        {
          ...accepted,
          receipt: { ...accepted.receipt, expectedTarget },
        },
        "integration-bad-ref",
      ),
    ).rejects.toMatchObject({ code: "GIT_CONFIGURATION_INVALID" });
  });

  test("rejects integration when the target moved after acceptance", async () => {
    const repository = await createRepository();
    const workspace = await provision(repository);
    await writeFile(join(workspace.host.worktreePath, "tracked.txt"), "x\n");
    const accepted = await commitWorktree(
      repository,
      workspace.host,
      "commit-stale-target",
    );
    const moved = git(
      repository.repoRoot,
      "commit-tree",
      `${repository.baseRevision}^{tree}`,
      "-p",
      repository.baseRevision,
      "-m",
      "concurrent publication",
    );
    git(repository.repoRoot, "update-ref", repository.targetId, moved);

    await expect(
      integrateCommit(repository, accepted, "integration-stale-target"),
    ).rejects.toMatchObject({ code: "GIT_TARGET_STALE" });
    expect(git(repository.repoRoot, "rev-parse", repository.targetId)).toBe(
      moved,
    );
  });

  test("rejects a commit that is not a direct child of the expected target", async () => {
    const repository = await createRepository();
    const workspace = await provision(repository);
    await writeFile(join(workspace.host.worktreePath, "tracked.txt"), "x\n");
    const moved = git(
      repository.repoRoot,
      "commit-tree",
      `${repository.baseRevision}^{tree}`,
      "-p",
      repository.baseRevision,
      "-m",
      "earlier publication",
    );
    git(repository.repoRoot, "update-ref", repository.targetId, moved);
    const changeSet = await repository.driver.inspect(
      workspace.host,
      inspectionRequest(repository),
    );
    const receipt = receiptFor(changeSet, moved);
    const commit = await new WorkflowValidatedCommitter(
      repository.driver,
      repository.driver,
      authority(repository.journal),
    ).commit(workspace.host, {
      receipt,
      message: "based on the old base",
      operationId: "commit-not-fast-forward",
    });

    await expect(
      integrateCommit(
        repository,
        { changeSet, receipt, commit },
        "integration-not-fast-forward",
      ),
    ).rejects.toMatchObject({ code: "GIT_COMMIT_NOT_FAST_FORWARD" });
    expect(git(repository.repoRoot, "rev-parse", repository.targetId)).toBe(
      moved,
    );
  });
});

describe("FileSystemWorkflowRepositoryMutationLock", () => {
  async function lockRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "adk-repository-lock-"));
    temporaryRoots.add(root);
    return root;
  }

  function lockPath(root: string, repositoryId: string): string {
    return join(
      root,
      `.repository-${createHash("sha256").update(repositoryId).digest("hex")}.lock`,
    );
  }

  async function plantLock(root: string, owner: unknown): Promise<string> {
    const path = lockPath(root, "repo");
    await mkdir(path);
    await writeFile(join(path, "owner.json"), JSON.stringify(owner));
    return path;
  }

  test("never grants two concurrent holders after a dead owner's lock", async () => {
    for (let round = 0; round < 30; round++) {
      const root = await lockRoot();
      await plantLock(root, {
        token: "dead-owner",
        pid: DEAD_PID,
        acquiredAt: 1,
      });
      const lock = new FileSystemWorkflowRepositoryMutationLock({
        lockRoot: root,
        retryIntervalMs: 1,
        acquireTimeoutMs: 10_000,
      });
      let holders = 0;
      let maxHolders = 0;
      await Promise.all(
        Array.from({ length: 8 }, async () => {
          const lease = await lock.acquire("repo");
          holders++;
          maxHolders = Math.max(maxHolders, holders);
          await Bun.sleep(2);
          holders--;
          expect(await lease.release()).toBe(true);
        }),
      );
      expect(maxHolders).toBe(1);
    }
    // 30 rounds of real lock work (about 1.5 s alone, several times that on a
    // loaded host): the 5 s default is not a deadline on the property tested.
  }, 60_000);

  test("reclaims a lock whose owner process is dead", async () => {
    const root = await lockRoot();
    await plantLock(root, {
      token: "dead-owner",
      pid: DEAD_PID,
      acquiredAt: 1,
    });
    const lease = await new FileSystemWorkflowRepositoryMutationLock({
      lockRoot: root,
      acquireTimeoutMs: 1_000,
    }).acquire("repo");
    expect(lease.repositoryId).toBe("repo");
    expect(await lease.release()).toBe(true);
    expect(await lease.release()).toBe(false);
  });

  test("never steals a lock whose owner cannot be read", async () => {
    const root = await lockRoot();
    const path = await plantLock(root, { token: "", pid: "not-a-pid" });
    await expect(
      new FileSystemWorkflowRepositoryMutationLock({
        lockRoot: root,
        acquireTimeoutMs: 50,
        retryIntervalMs: 5,
      }).acquire("repo"),
    ).rejects.toMatchObject({ code: "GIT_MUTATION_AMBIGUOUS" });
    expect(await readdir(path)).toEqual(["owner.json"]);
  });

  test("a lost lease cannot release the lock of its successor", async () => {
    const root = await lockRoot();
    const lock = new FileSystemWorkflowRepositoryMutationLock({
      lockRoot: root,
      acquireTimeoutMs: 1_000,
    });
    const lost = await lock.acquire("repo");
    const path = lockPath(root, "repo");
    // Simulate recovery by another process that judged the owner dead.
    await rm(path, { recursive: true, force: true });
    const successor = await lock.acquire("repo");

    expect(await lost.release()).toBe(false);
    expect(await readdir(root)).toContain(basename(path));
    expect(await successor.release()).toBe(true);
  });

  test("stops waiting when the signal aborts", async () => {
    const root = await lockRoot();
    const lock = new FileSystemWorkflowRepositoryMutationLock({
      lockRoot: root,
      acquireTimeoutMs: 10_000,
      retryIntervalMs: 5,
    });
    const held = await lock.acquire("repo");
    const controller = new AbortController();
    const pending = lock.acquire("repo", { signal: controller.signal });
    controller.abort(new Error("stop waiting"));
    await expect(pending).rejects.toThrow("stop waiting");
    expect(await held.release()).toBe(true);
  });
});

/**
 * Runs `operation` with extra variables in the process environment, as a host
 * (a Git hook or a CI wrapper) would pass them to the driver.
 */
async function withEnvironment<T>(
  variables: Record<string, string>,
  operation: () => Promise<T>,
): Promise<T> {
  const saved = Object.fromEntries(
    Object.keys(variables).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, variables);
  try {
    return await operation();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

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

/** Types a flat record of strings and numbers as a journal JSON object. */
function flatJson<T extends { [Key in keyof T]: string | number }>(
  value: T,
): WorkflowResourceJsonObject {
  return value as WorkflowResourceJsonObject;
}

describe("NodeGitWorktreeChangeDriver error codes", () => {
  test("create reports a non-repository root and an unknown base as configuration errors", async () => {
    const repository = await createRepository();
    const plain = join(repository.root, "plain");
    await mkdir(plain);
    await expect(
      NodeGitWorktreeChangeDriver.create({
        repoRoot: plain,
        worktreesRoot: join(repository.root, "plain-worktrees"),
        baseRevision: repository.baseRevision,
        mutationJournal: repository.journal,
      }),
    ).rejects.toMatchObject({
      name: "NodeGitWorktreeError",
      code: "GIT_CONFIGURATION_INVALID",
    });
    await expect(
      NodeGitWorktreeChangeDriver.create({
        repoRoot: repository.repoRoot,
        worktreesRoot: repository.worktreesRoot,
        baseRevision: "refs/heads/does-not-exist",
        mutationJournal: repository.journal,
      }),
    ).rejects.toMatchObject({
      name: "NodeGitWorktreeError",
      code: "GIT_CONFIGURATION_INVALID",
    });
  });

  test("a failed git command is GIT_COMMAND_FAILED with the process error as cause", async () => {
    const repository = await createRepository();
    const workspace = await provision(repository);
    // A worktree's `.git` file points at its admin directory; a broken one
    // makes every Git command in the worktree exit 128.
    await writeFile(
      join(workspace.host.worktreePath, ".git"),
      "not a gitdir\n",
    );

    const error = await repository.driver
      .inspect(workspace.host, inspectionRequest(repository))
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toMatchObject({
      name: "NodeGitWorktreeError",
      code: "GIT_COMMAND_FAILED",
    });
    expect((error as Error).message).toStartWith("git ");
    expect((error as Error).cause).toBeInstanceOf(Error);
  });

  test("an untracked nested repository is GIT_ENTRY_UNSUPPORTED", async () => {
    const repository = await createRepository();
    const workspace = await provision(repository);
    const inner = join(workspace.host.worktreePath, "inner");
    await mkdir(inner);
    git(inner, "init", "--initial-branch=main");
    await writeFile(join(inner, "file.txt"), "nested\n");

    await expect(
      repository.driver.inspect(workspace.host, inspectionRequest(repository)),
    ).rejects.toMatchObject({
      name: "NodeGitWorktreeError",
      code: "GIT_ENTRY_UNSUPPORTED",
      message:
        "Untracked nested Git repository is not supported: inner; remove it or add it as a submodule",
    });
  });

  test("create reports an invalid timeout or base revision as configuration errors", async () => {
    const repository = await createRepository();
    for (const options of [
      { commandTimeoutMs: 0 },
      { commandTimeoutMs: 1.5 },
      { baseRevision: "-c" },
      { baseRevision: "" },
    ]) {
      await expect(
        NodeGitWorktreeChangeDriver.create({
          repoRoot: repository.repoRoot,
          worktreesRoot: repository.worktreesRoot,
          baseRevision: repository.baseRevision,
          mutationJournal: repository.journal,
          ...options,
        }),
      ).rejects.toMatchObject({
        name: "NodeGitWorktreeError",
        code: "GIT_CONFIGURATION_INVALID",
      });
    }
  });

  test("a malformed object id from Git is GIT_COMMAND_FAILED", async () => {
    const expectCommandFailed = async (
      root: string,
      prelude: string,
      message: string,
      run: () => Promise<unknown>,
    ) => {
      const bin = await fakeGit(root, prelude);
      const error = await withEnvironment({ PATH: bin }, run).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({
        name: "NodeGitWorktreeError",
        code: "GIT_COMMAND_FAILED",
        message,
      });
    };

    const preparing = await createRepository();
    const prepared = await provision(preparing);
    await writeFile(join(prepared.host.worktreePath, "tracked.txt"), "x\n");
    await expectCommandFailed(
      preparing.root,
      'if [ "$1" = write-tree ]; then echo not-an-object; exit 0; fi',
      "git write-tree returned an invalid treeId",
      () => commitWorktree(preparing, prepared.host, "commit"),
    );

    const integrating = await createRepository();
    const committed = await provision(integrating);
    await writeFile(join(committed.host.worktreePath, "tracked.txt"), "y\n");
    const accepted = await commitWorktree(
      integrating,
      committed.host,
      "commit",
    );
    await expectCommandFailed(
      integrating.root,
      'case "$1 $4" in "rev-parse "*"^{tree}") echo not-a-tree; exit 0;; esac',
      "git rev-parse returned an invalid treeId",
      () => integrateCommit(integrating, accepted, "integrate"),
    );
  });

  test(
    "a Git command that runs past its timeout says so",
    async () => {
      // The limit applies to every Git command of the driver, `git worktree add`
      // of `provision` included, and a worktree handle works only on the driver
      // that issued it. So the limit is far above what real Git needs on a
      // loaded host (a 200 ms limit failed provisioning there), and the fake Git
      // sleeps far longer than the limit.
      const repository = await createRepository();
      const driver = await NodeGitWorktreeChangeDriver.create({
        repoRoot: repository.repoRoot,
        worktreesRoot: repository.worktreesRoot,
        baseRevision: repository.baseRevision,
        mutationJournal: repository.journal,
        commandTimeoutMs: SLOW_HOST_COMMAND_TIMEOUT_MS,
      });
      const workspace = await driver.provision({
        executionId: "execution-1",
        taskId: "task-1",
      });
      const bin = await fakeGit(repository.root, "exec sleep 60");

      const error = await withEnvironment({ PATH: bin }, () =>
        driver.inspect(workspace.host, inspectionRequest(repository)),
      ).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({
        name: "NodeGitWorktreeError",
        code: "GIT_COMMAND_FAILED",
      });
      expect((error as Error).message).toContain(
        `timed out after ${SLOW_HOST_COMMAND_TIMEOUT_MS} ms`,
      );
      // The test spends the limit (2 s) plus provisioning: state its own
      // timeout, so Bun's 5 s default is not the margin on a loaded host.
    },
    TIMEOUT_TEST_DEADLINE_MS,
  );

  test("the limit of the timeout test lets provisioning finish when `git worktree` commands are slow", async () => {
    // Guards the limit above: a Git whose `worktree` subcommands (`add`,
    // `list`, ...) are slow (a loaded host) must not fail the provisioning
    // that comes before the command under test. 300 ms is more than the
    // 200 ms that used to fail.
    const repository = await createRepository();
    const driver = await NodeGitWorktreeChangeDriver.create({
      repoRoot: repository.repoRoot,
      worktreesRoot: repository.worktreesRoot,
      baseRevision: repository.baseRevision,
      mutationJournal: repository.journal,
      commandTimeoutMs: SLOW_HOST_COMMAND_TIMEOUT_MS,
    });
    const bin = await fakeGit(
      repository.root,
      'if [ "$1" = worktree ]; then sleep 0.3; fi',
    );
    const workspace = await withEnvironment({ PATH: bin }, () =>
      driver.provision({ executionId: "execution-1", taskId: "task-1" }),
    );
    expect(workspace.host.worktreePath).toBeString();
  });

  test("an abort during a Git command rejects with the signal's reason", async () => {
    const repository = await createRepository();
    const workspace = await provision(repository);
    const bin = await fakeGit(repository.root, "exec sleep 30");
    const controller = new AbortController();
    const reason = new Error("caller stopped");

    const error = await withEnvironment({ PATH: bin }, async () => {
      const pending = repository.driver.inspect(
        workspace.host,
        inspectionRequest(repository),
        { signal: controller.signal },
      );
      setTimeout(() => controller.abort(reason), 100);
      return await pending.then(
        () => undefined,
        (caught: unknown) => caught,
      );
    });
    expect(error).toBe(reason);
  });
});

/**
 * Writes a `git` wrapper that runs `prelude` (a POSIX shell fragment) and
 * then the real Git, and returns a PATH that finds the wrapper first.
 */
async function fakeGit(root: string, prelude: string): Promise<string> {
  const realGit = execFileSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
  const bin = await mkdtemp(join(root, "fake-git-"));
  const script = join(bin, "git");
  await writeFile(script, `#!/bin/sh\n${prelude}\nexec "${realGit}" "$@"\n`);
  await chmod(script, 0o755);
  return `${bin}:${process.env.PATH ?? ""}`;
}
