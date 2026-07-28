/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvent, InvocationContext, PluginManager } from "@google/adk";
import {
  type AdkWorkflowTaskCapabilityBinder,
  AdkWorkflowTaskDriver,
  AgentInvocationGateway,
  BaseAgent,
  InMemoryWorkflowChangeReceiptStore,
  InMemoryWorkflowHostMutationJournal,
  InMemoryWorkflowOrchestrationStateStore,
  InMemoryWorkflowPlanStore,
  InMemoryWorkflowTaskCommandStore,
  InMemoryWorkflowTaskMessageStore,
  InMemoryWorkflowTaskStore,
  WORKFLOW_PLAN_PROTOCOL,
  WORKFLOW_PLAN_VERSION,
  WorkflowActorContext,
  WorkflowLiveChangeReceiptAuthority,
  WorkflowOrchestrationTaskAuthorityPort,
  WorkflowOwnershipChangeSetValidator,
  WorkflowOwnershipController,
  type WorkflowPlan,
  WorkflowPlanController,
  WorkflowTaskController,
  WorkflowValidatedCommitter,
  WorkflowValidatedIntegrator,
} from "../../../src/workflows/index.js";
import { NodeGitWorktreeChangeDriver } from "../../../src/workflows/node/index.js";

const temporaryRoots = new Set<string>();

afterEach(async () => {
  for (const root of temporaryRoots) {
    await rm(root, { recursive: true, force: true });
  }
  temporaryRoots.clear();
});

class DeterministicWorker extends BaseAgent {
  calls = 0;

  constructor() {
    super({ name: "builder" });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.calls++;
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {
        role: "model",
        parts: [{ text: "implemented tracked.txt" }],
      },
      turnComplete: true,
    });
  }

  protected async *runLiveImpl() {}
}

describe("public workflow orchestration", () => {
  test("runs an authenticated ADK task through owned Git publication", async () => {
    const repository = await createRepository();
    let clock = 1_000;
    const now = () => clock++;
    const authorizer = {
      authorize: ({ actorId, agentId }: { actorId: string; agentId: string }) =>
        actorId === `principal-${agentId}`,
    };
    const plans = new InMemoryWorkflowPlanStore();
    const orchestration = new InMemoryWorkflowOrchestrationStateStore();
    const receipts = new InMemoryWorkflowChangeReceiptStore();
    const journal = new InMemoryWorkflowHostMutationJournal();
    const planController = new WorkflowPlanController({
      plans,
      state: orchestration,
      authorizer,
      bootstrapAuthorizer: authorizer,
      now,
    });
    const coordinator = actor("coordinator", "integration");
    const builder = actor("builder", "implementation");
    const workflowPlan = plan(repository.baseRevision);

    await planController.put(workflowPlan, coordinator);
    await planController.activate("execution-public", 1, coordinator);

    let nextGrant = 0;
    const ownership = new WorkflowOwnershipController({
      plans,
      state: orchestration,
      authorizer,
      createId: () => `grant-${++nextGrant}`,
      now,
    });
    const originalGrant = await ownership.claim(
      {
        executionId: "execution-public",
        planRevision: 1,
        claims: [{ path: "tracked.txt", scope: "exact" }],
      },
      builder,
    );

    const gitDriver = await NodeGitWorktreeChangeDriver.create({
      repoRoot: repository.repoRoot,
      worktreesRoot: repository.worktreesRoot,
      baseRevision: repository.baseRevision,
      createWorkspaceId: () => "workspace-public",
      mutationJournal: journal,
      now,
    });
    const worker = new DeterministicWorker();
    const parentContext = invocationContext(worker);
    let workspace:
      | Awaited<ReturnType<NodeGitWorktreeChangeDriver["provision"]>>
      | undefined;
    let binderReleased = false;
    const binder: AdkWorkflowTaskCapabilityBinder = {
      bind: async (request) => {
        expect(request.agent).toBe(worker);
        expect(request.binding).toEqual({
          planRevision: 1,
          ownership: [
            {
              grantId: originalGrant.grantId,
              fencingToken: originalGrant.fencingToken,
            },
          ],
        });
        workspace = await gitDriver.provision({
          executionId: request.task.executionId,
          taskId: request.task.taskId,
        });
        await writeFile(
          join(workspace.host.worktreePath, "tracked.txt"),
          "implemented by durable ADK task\n",
        );
        await request.capabilities.send({
          taskId: request.task.taskId,
          payload: { kind: "workspace-ready" },
          operationId: "binder-ready",
        });
        return {
          release() {
            binderReleased = true;
          },
        };
      },
    };
    const taskAuthority = new WorkflowOrchestrationTaskAuthorityPort({
      plans,
      state: orchestration,
      authorizer,
      now,
    });
    const taskStore = new InMemoryWorkflowTaskStore({ now });
    const mailbox = new InMemoryWorkflowTaskMessageStore();
    const taskController = new WorkflowTaskController({
      store: taskStore,
      messageStore: mailbox,
      commandStore: new InMemoryWorkflowTaskCommandStore({
        taskStore,
        messageStore: mailbox,
      }),
      authorityPort: taskAuthority,
      driver: new AdkWorkflowTaskDriver({
        gateway: new AgentInvocationGateway({
          resolveAgent: (agentId) =>
            agentId === worker.name ? worker : undefined,
        }),
        contextProvider: { acquire: () => ({ context: parentContext }) },
        attemptAuthority: taskAuthority,
        capabilityBinder: binder,
      }),
      durable: {
        workerId: "worker-public",
        leaseDurationMs: 10_000,
        heartbeatIntervalMs: 1_000,
        createLeaseId: () => "lease-public",
      },
      now,
    });

    const handle = await taskController.spawn(
      {
        executionId: "execution-public",
        taskId: "implementation",
        agentId: "builder",
        input: { instruction: "edit tracked.txt" },
        operationId: "spawn-public",
      },
      { capability: builder, operationId: "spawn-public" },
    );
    const completedTask = await taskController.join(handle);

    expect(completedTask).toMatchObject({
      status: "completed",
      output: "implemented tracked.txt",
      orchestration: {
        planRevision: 1,
        ownership: [
          {
            grantId: originalGrant.grantId,
            fencingToken: originalGrant.fencingToken,
          },
        ],
      },
    });
    expect(worker.calls).toBe(1);
    expect(binderReleased).toBe(true);
    expect(
      (await taskController.readMailbox(handle)).messages[0]?.payload,
    ).toEqual({ kind: "workspace-ready" });
    if (!workspace) throw new Error("ADK binder did not provision a worktree");

    const changeSet = await gitDriver.inspect(workspace.host, {
      executionId: "execution-public",
      taskId: "implementation",
      planRevision: 1,
      workspaceRevision: repository.baseRevision,
      baseRevision: repository.baseRevision,
    });
    expect(changeSet.entries).toEqual([
      expect.objectContaining({
        kind: "modified",
        path: "tracked.txt",
        entryKind: "file",
      }),
    ]);

    let nextReceipt = 0;
    const validator = new WorkflowOwnershipChangeSetValidator({
      ownership,
      plans,
      receipts,
      createReceiptId: () => `receipt-${++nextReceipt}`,
      now,
    });
    const validate = async (grant: { grantId: string; fencingToken: number }) =>
      await validator.validate(
        {
          changeSet,
          expectedBaseRevision: repository.baseRevision,
          expectedPlanRevision: 1,
          agentId: "builder",
          ownership: [
            {
              grantId: grant.grantId,
              fencingToken: grant.fencingToken,
            },
          ],
          expectedTarget: {
            targetId: repository.targetId,
            revision: repository.baseRevision,
          },
        },
        coordinator,
      );
    const staleReceipt = await validate(originalGrant);
    expect(await receipts.get("execution-public", staleReceipt.receiptId)).toBe(
      staleReceipt,
    );

    const reviewerGrant = await ownership.transfer(
      {
        executionId: "execution-public",
        planRevision: 1,
        sourceGrantId: originalGrant.grantId,
        targetTaskId: "review",
      },
      coordinator,
    );
    const authority = new WorkflowLiveChangeReceiptAuthority({
      state: orchestration,
      receipts,
      journal,
      now,
      reservationTtlMs: 10_000,
    });
    const committer = new WorkflowValidatedCommitter(
      gitDriver,
      gitDriver,
      authority,
    );
    await expect(
      committer.commit(workspace.host, {
        receipt: staleReceipt,
        message: "must reject revoked ownership",
        operationId: "commit-revoked",
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_CHANGE_AUTHORITY_INVALID" });

    const currentGrant = await ownership.transfer(
      {
        executionId: "execution-public",
        planRevision: 1,
        sourceGrantId: reviewerGrant.grantId,
        targetTaskId: "implementation",
      },
      coordinator,
    );
    const receipt = await validate(currentGrant);
    const commit = await committer.commit(workspace.host, {
      receipt,
      message: "publish public orchestration E2E",
      operationId: "commit-public",
    });

    expect(commit.changeSetDigest).toBe(receipt.changeSetDigest);
    expect(commit.treeId).toBe(
      git(repository.repoRoot, "show", "-s", "--format=%T", commit.commitId),
    );
    await expect(
      ownership.transfer(
        {
          executionId: "execution-public",
          planRevision: 1,
          sourceGrantId: currentGrant.grantId,
          targetTaskId: "review",
        },
        coordinator,
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_MUTATION_RESERVATION_ACTIVE" });

    const integration = await new WorkflowValidatedIntegrator(
      gitDriver,
      authority,
    ).integrate(gitDriver.repository, {
      executionId: "execution-public",
      taskId: "implementation",
      commitId: commit.commitId,
      receiptId: receipt.receiptId,
      changeSetDigest: receipt.changeSetDigest,
      expectedTarget: receipt.expectedTarget,
      operationId: "integration-public",
      receipt,
      commit,
    });

    expect(integration.previousRevision).toBe(repository.baseRevision);
    expect(integration.integratedRevision).toBe(commit.commitId);
    expect(git(repository.repoRoot, "rev-parse", repository.targetId)).toBe(
      commit.commitId,
    );
    expect(
      git(repository.repoRoot, "show", `${repository.targetId}:tracked.txt`),
    ).toBe("implemented by durable ADK task");
    expect((await orchestration.get("execution-public"))?.reservations).toEqual(
      [
        expect.objectContaining({
          phase: "integration",
          status: "completed",
          receiptId: receipt.receiptId,
          treeId: commit.treeId,
          commitId: commit.commitId,
        }),
      ],
    );
    expect(
      await readFile(join(workspace.host.worktreePath, "tracked.txt"), "utf8"),
    ).toBe("implemented by durable ADK task\n");
    expect(await workspace.release()).toBe(true);
  });
});

function actor(agentId: string, taskId: string): WorkflowActorContext {
  return new WorkflowActorContext({
    actorId: `principal-${agentId}`,
    agentId,
    executionId: "execution-public",
    taskId,
    planRevision: 1,
  });
}

function plan(baseRevision: string): WorkflowPlan {
  return {
    protocol: WORKFLOW_PLAN_PROTOCOL,
    version: WORKFLOW_PLAN_VERSION,
    executionId: "execution-public",
    planRevision: 1,
    baseRevision,
    objective: "Publish one owned ADK task change through a Git worktree",
    status: "ready",
    createdAt: 1,
    agents: [
      {
        agentId: "builder",
        policy: {
          role: "worker",
          permissions: [
            "plan:read",
            "task:spawn",
            "task:mailbox:send",
            "task:read",
            "ownership:claim",
          ],
          canDelegate: false,
        },
      },
      {
        agentId: "reviewer",
        policy: {
          role: "worker",
          permissions: ["plan:read"],
          canDelegate: false,
        },
      },
      {
        agentId: "coordinator",
        policy: {
          role: "integration",
          permissions: [
            "plan:read",
            "plan:activate",
            "ownership:transfer",
            "changes:validate",
            "integration:publish",
          ],
          canDelegate: true,
          allowedDelegateRoles: ["worker"],
        },
      },
    ],
    lanes: [
      {
        taskId: "implementation",
        agentId: "builder",
        role: "worker",
        ownedPaths: [{ path: "tracked.txt", scope: "exact" }],
        mayCreateUnder: [],
        dependsOn: [],
        acceptance: ["tracked.txt is integrated exactly"],
      },
      {
        taskId: "review",
        agentId: "reviewer",
        role: "worker",
        ownedPaths: [{ path: "review.txt", scope: "exact" }],
        mayCreateUnder: [],
        dependsOn: ["implementation"],
        acceptance: ["stale ownership is fenced"],
      },
      {
        taskId: "integration",
        agentId: "coordinator",
        role: "integration",
        ownedPaths: [],
        mayCreateUnder: [],
        dependsOn: ["implementation", "review"],
        acceptance: ["publication target advances atomically"],
      },
    ],
    waves: [
      { waveId: "implementation-wave", taskIds: ["implementation"] },
      { waveId: "review-wave", taskIds: ["review"] },
      { waveId: "integration-wave", taskIds: ["integration"] },
    ],
    invariants: [],
    reservedPaths: [],
  };
}

function invocationContext(agent: BaseAgent): InvocationContext {
  return new InvocationContext({
    invocationId: "invocation-public",
    branch: "root",
    agent,
    userContent: {
      role: "user",
      parts: [{ text: "execute public orchestration" }],
    },
    session: {
      id: "session-public",
      appName: "public-orchestration-e2e",
      userId: "test-user",
      state: {},
      events: [],
      lastUpdateTime: 1,
    },
    pluginManager: new PluginManager(),
  });
}

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), "adk-public-orchestration-"));
  temporaryRoots.add(root);
  const repoRoot = join(root, "repo");
  const worktreesRoot = join(root, "worktrees");
  await mkdir(repoRoot);
  await mkdir(worktreesRoot);
  git(root, "init", "--initial-branch=main", repoRoot);
  git(repoRoot, "config", "user.name", "Workflow E2E");
  git(repoRoot, "config", "user.email", "workflow-e2e@example.test");
  await writeFile(join(repoRoot, "tracked.txt"), "base\n");
  git(repoRoot, "add", "--all", "--");
  git(repoRoot, "commit", "--no-gpg-sign", "--no-verify", "-m", "base");
  const baseRevision = git(repoRoot, "rev-parse", "HEAD");
  const targetId = "refs/heads/publication";
  git(repoRoot, "branch", "publication", baseRevision);
  return { root, repoRoot, worktreesRoot, baseRevision, targetId };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    },
  }).trim();
}
