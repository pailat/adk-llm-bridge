/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import {
  createWorkflowChangeSet,
  normalizeAcceptedChangeReceipt,
  normalizeAuthoritativeIntegrationRequest,
  verifyWorkflowChangeSet,
  WORKFLOW_CHANGE_AUTHORITY_LEASE,
  type WorkflowAcceptedChangeReceipt,
  type WorkflowChangeInspector,
  WorkflowChangeMismatchError,
  type WorkflowChangeReceiptAuthority,
  type WorkflowCommitDriver,
  WorkflowValidatedCommitter,
  WorkflowValidatedIntegrator,
} from "../../../src/workflows/workspace/change-driver.js";

const FILE_DIGEST = `sha256:${"a".repeat(64)}`;

async function exampleChangeSet() {
  return await createWorkflowChangeSet({
    executionId: "execution-1",
    taskId: "task-1",
    planRevision: 3,
    workspaceRevision: "workspace-revision-1",
    baseRevision: "base-revision-1",
    entries: [
      {
        kind: "renamed",
        fromPath: "src/old.ts",
        toPath: "src/new.ts",
        entryKind: "file",
        contentDigest: FILE_DIGEST,
      },
      {
        kind: "modified",
        path: "src/index.ts",
        entryKind: "file",
        contentDigest: FILE_DIGEST,
      },
    ],
  });
}

function receiptFor(
  changeSet: Awaited<ReturnType<typeof exampleChangeSet>>,
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
    ownership: [
      { grantId: "grant-src", fencingToken: 12 },
      { grantId: "grant-tests", fencingToken: 13 },
    ],
    issuedAt: 1234,
    expectedTarget: { targetId: "refs/heads/main", revision: "head-1" },
    agentId: "agent-1",
    orchestrationRevision: 9,
  };
}

function authority(events: string[] = []): WorkflowChangeReceiptAuthority {
  return {
    acquireCommit: async (request) => {
      events.push("acquire-commit");
      return {
        [WORKFLOW_CHANGE_AUTHORITY_LEASE]: true,
        leaseId: "lease-1",
        reservationId: "reservation-1",
        operationId: request.operationId,
        intentDigest: request.intentDigest,
      };
    },
    completeCommit: async () => {
      events.push("complete-commit");
    },
    acquireIntegration: async (request) => ({
      [WORKFLOW_CHANGE_AUTHORITY_LEASE]: true,
      leaseId: "lease-integration",
      reservationId: "reservation-integration",
      operationId: request.operationId,
      intentDigest: request.intentDigest,
    }),
    completeIntegration: async () => {},
    release: async () => {
      events.push("release");
    },
    reconcile: async () => ({ status: "absent" }),
  };
}

describe("workspace change ports", () => {
  test("creates a stable canonical digest for immutable JSON change sets", async () => {
    const first = await exampleChangeSet();
    const reordered = await createWorkflowChangeSet({
      executionId: "execution-1",
      taskId: "task-1",
      planRevision: 3,
      workspaceRevision: "workspace-revision-1",
      baseRevision: "base-revision-1",
      entries: [...first.entries].reverse(),
    });

    expect(first.changeSetDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(reordered.changeSetDigest).toBe(first.changeSetDigest);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.entries)).toBe(true);
    expect(Object.isFrozen(first.entries[0])).toBe(true);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    await expect(verifyWorkflowChangeSet(first)).resolves.toEqual(first);
  });

  test("rejects forged digests and host handles in serialized values", async () => {
    const changeSet = await exampleChangeSet();
    await expect(
      verifyWorkflowChangeSet({
        ...changeSet,
        changeSetDigest: `sha256:${"b".repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: "CHANGE_SET_DIGEST_MISMATCH" });

    await expect(
      verifyWorkflowChangeSet({
        ...changeSet,
        host: { worktree: "/tmp/repo" },
      } as never),
    ).rejects.toThrow("unknown or non-JSON properties");
    expect(() =>
      normalizeAcceptedChangeReceipt({
        ...receiptFor(changeSet),
        host: { process: 42 },
      } as never),
    ).toThrow("unknown or non-JSON properties");
  });

  test("rejects backslashes instead of changing their path semantics", async () => {
    await expect(
      createWorkflowChangeSet({
        executionId: "execution-1",
        taskId: "task-1",
        planRevision: 3,
        workspaceRevision: "workspace-revision-1",
        baseRevision: "base-revision-1",
        entries: [
          {
            kind: "added",
            path: "src\\index.ts",
            entryKind: "file",
            contentDigest: FILE_DIGEST,
          },
        ],
      }),
    ).rejects.toThrow("must use forward slashes");
  });

  test("normalizes accepted receipts with immutable fencing and target evidence", async () => {
    const receipt = normalizeAcceptedChangeReceipt(
      receiptFor(await exampleChangeSet()),
    );

    expect(receipt.verdict).toBe("accepted");
    expect(receipt.expectedTarget).toEqual({
      targetId: "refs/heads/main",
      revision: "head-1",
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.ownership)).toBe(true);
    expect(Object.isFrozen(receipt.expectedTarget)).toBe(true);
    expect(() =>
      normalizeAcceptedChangeReceipt({
        ...receipt,
        verdict: "rejected",
      } as never),
    ).toThrow("verdict must be accepted");
  });

  test("reinspects before commit and refuses a changed workspace", async () => {
    const accepted = await exampleChangeSet();
    const receipt = receiptFor(accepted);
    const changed = await createWorkflowChangeSet({
      executionId: accepted.executionId,
      taskId: accepted.taskId,
      planRevision: accepted.planRevision,
      workspaceRevision: accepted.workspaceRevision,
      baseRevision: accepted.baseRevision,
      entries: [
        ...accepted.entries,
        {
          kind: "added",
          path: "src/unreviewed.ts",
          entryKind: "file",
          contentDigest: FILE_DIGEST,
        },
      ],
    });
    let commitCalls = 0;
    const inspector: WorkflowChangeInspector<{ id: string }> = {
      inspect: async (_workspace, request) => {
        expect(request).toEqual({
          executionId: receipt.executionId,
          taskId: receipt.taskId,
          planRevision: receipt.planRevision,
          workspaceRevision: receipt.workspaceRevision,
          baseRevision: receipt.baseRevision,
        });
        return changed;
      },
    };
    const driver: WorkflowCommitDriver<{ id: string }> = {
      commit: async () => {
        commitCalls++;
        throw new Error("must not mutate");
      },
    };

    await expect(
      new WorkflowValidatedCommitter(inspector, driver, authority()).commit(
        { id: "host-only" },
        { receipt, message: "atomic change", operationId: "operation-1" },
      ),
    ).rejects.toBeInstanceOf(WorkflowChangeMismatchError);
    expect(commitCalls).toBe(0);
  });

  test("commits only the reverified snapshot and rejects a mismatched result", async () => {
    const changeSet = await exampleChangeSet();
    const receipt = receiptFor(changeSet);
    let inspected = 0;
    const events: string[] = [];
    const committer = new WorkflowValidatedCommitter(
      {
        inspect: async () => {
          inspected++;
          return changeSet;
        },
      },
      {
        prepareCommit: async () => ({
          preparationId: "preparation-1",
          treeId: "tree-1",
        }),
        commit: async (_workspace, input) => {
          expect(input.changeSet).toEqual(changeSet);
          expect(input.receipt).toEqual(
            normalizeAcceptedChangeReceipt(receipt),
          );
          return {
            commitId: "commit-1",
            treeId: "tree-1",
            receiptId: input.receipt.receiptId,
            changeSetDigest: input.changeSet.changeSetDigest,
            workspaceRevision: input.changeSet.workspaceRevision,
            baseRevision: input.changeSet.baseRevision,
            committedAt: 2000,
          };
        },
      },
      authority(events),
    );

    await expect(
      committer.commit(
        { hostHandle: "not-serialized" },
        {
          receipt,
          message: "  atomic change  ",
          operationId: "operation-1",
        },
      ),
    ).resolves.toEqual({
      commitId: "commit-1",
      treeId: "tree-1",
      receiptId: "receipt-1",
      changeSetDigest: changeSet.changeSetDigest,
      workspaceRevision: "workspace-revision-1",
      baseRevision: "base-revision-1",
      committedAt: 2000,
    });
    expect(inspected).toBe(1);
    expect(events).toEqual(["acquire-commit", "complete-commit", "release"]);
  });

  test("records a returned commit even when cancellation wins the return race", async () => {
    const changeSet = await exampleChangeSet();
    const receipt = receiptFor(changeSet);
    const cancellation = new AbortController();
    const events: string[] = [];
    const baseAuthority = authority(events);
    const liveAuthority: WorkflowChangeReceiptAuthority = {
      ...baseAuthority,
      completeCommit: async (_lease, result, options) => {
        expect(options?.signal).toBeUndefined();
        expect(result).toMatchObject({
          commitId: "commit-after-abort",
          treeId: "tree-after-abort",
          receiptId: receipt.receiptId,
        });
        events.push("complete-commit");
      },
      release: async (_lease, options) => {
        expect(options?.signal).toBeUndefined();
        events.push("release");
      },
    };
    const committer = new WorkflowValidatedCommitter(
      { inspect: async () => changeSet },
      {
        prepareCommit: async () => ({
          preparationId: "preparation-after-abort",
          treeId: "tree-after-abort",
        }),
        commit: async (_workspace, input) => {
          events.push("host-commit");
          cancellation.abort(new Error("caller stopped waiting"));
          return {
            commitId: "commit-after-abort",
            treeId: input.preparation.treeId,
            receiptId: input.receipt.receiptId,
            changeSetDigest: input.changeSet.changeSetDigest,
            workspaceRevision: input.changeSet.workspaceRevision,
            baseRevision: input.changeSet.baseRevision,
            committedAt: 2001,
          };
        },
        discardPreparation: async (_workspace, _preparation, options) => {
          expect(options?.signal).toBeUndefined();
          events.push("discard-preparation");
        },
      },
      liveAuthority,
    );

    await expect(
      committer.commit(
        {},
        {
          receipt,
          message: "commit despite late cancellation",
          operationId: "operation-after-abort",
        },
        { signal: cancellation.signal },
      ),
    ).resolves.toMatchObject({
      commitId: "commit-after-abort",
      treeId: "tree-after-abort",
      receiptId: receipt.receiptId,
    });
    expect(cancellation.signal.aborted).toBe(true);
    expect(events).toEqual([
      "acquire-commit",
      "host-commit",
      "complete-commit",
      "release",
      "discard-preparation",
    ]);
  });

  test("denies legacy shape-only receipts without live authority", async () => {
    const changeSet = await exampleChangeSet();
    let inspected = 0;
    let committed = 0;
    const committer = new WorkflowValidatedCommitter(
      {
        inspect: async () => {
          inspected++;
          return changeSet;
        },
      },
      {
        commit: async () => {
          committed++;
          throw new Error("unsafe commit");
        },
      },
    );

    await expect(
      committer.commit(
        {},
        {
          receipt: receiptFor(changeSet),
          message: "must be denied",
          operationId: "operation-1",
        },
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_CHANGE_AUTHORITY_REQUIRED" });
    expect(inspected).toBe(0);
    expect(committed).toBe(0);
  });

  test("releases live authority when the host mutation fails", async () => {
    const changeSet = await exampleChangeSet();
    const events: string[] = [];
    const committer = new WorkflowValidatedCommitter(
      { inspect: async () => changeSet },
      {
        prepareCommit: async () => ({
          preparationId: "preparation-failure",
          treeId: "tree-failure",
        }),
        commit: async () => {
          events.push("host-commit");
          throw new Error("host failed after invocation");
        },
        discardPreparation: async () => {
          events.push("discard-preparation");
        },
      },
      authority(events),
    );

    await expect(
      committer.commit(
        {},
        {
          receipt: receiptFor(changeSet),
          message: "atomic change",
          operationId: "operation-failure",
        },
      ),
    ).rejects.toThrow("host failed after invocation");
    expect(events).toEqual([
      "acquire-commit",
      "host-commit",
      "release",
      "discard-preparation",
    ]);
  });

  test("requires full receipt and commit linkage for integration", async () => {
    const changeSet = await exampleChangeSet();
    const receipt = receiptFor(changeSet);
    const commit = {
      commitId: "commit-1",
      treeId: "tree-1",
      receiptId: receipt.receiptId,
      changeSetDigest: receipt.changeSetDigest,
      workspaceRevision: receipt.workspaceRevision,
      baseRevision: receipt.baseRevision,
      committedAt: 2000,
    };
    const request = {
      executionId: receipt.executionId,
      taskId: receipt.taskId,
      commitId: commit.commitId,
      receiptId: receipt.receiptId,
      changeSetDigest: receipt.changeSetDigest,
      expectedTarget: receipt.expectedTarget,
      operationId: "integrate-1",
      receipt,
      commit,
    };

    expect(normalizeAuthoritativeIntegrationRequest(request)).toEqual(request);
    expect(() =>
      normalizeAuthoritativeIntegrationRequest({
        ...request,
        commitId: "commit-forged",
      }),
    ).toThrow("not linked");
  });

  test("records a returned integration even when cancellation wins the return race", async () => {
    const changeSet = await exampleChangeSet();
    const receipt = receiptFor(changeSet);
    const commit = {
      commitId: "commit-integration-abort",
      treeId: "tree-integration-abort",
      receiptId: receipt.receiptId,
      changeSetDigest: receipt.changeSetDigest,
      workspaceRevision: receipt.workspaceRevision,
      baseRevision: receipt.baseRevision,
      committedAt: 2000,
    };
    const request = {
      executionId: receipt.executionId,
      taskId: receipt.taskId,
      commitId: commit.commitId,
      receiptId: receipt.receiptId,
      changeSetDigest: receipt.changeSetDigest,
      expectedTarget: receipt.expectedTarget,
      operationId: "integrate-after-abort",
      receipt,
      commit,
    };
    const cancellation = new AbortController();
    const events: string[] = [];
    const liveAuthority: WorkflowChangeReceiptAuthority = {
      ...authority(),
      acquireIntegration: async (input) => {
        events.push("acquire-integration");
        return {
          [WORKFLOW_CHANGE_AUTHORITY_LEASE]: true,
          leaseId: "lease-integration-abort",
          reservationId: "reservation-integration-abort",
          operationId: input.operationId,
          intentDigest: input.intentDigest,
        };
      },
      completeIntegration: async (_lease, result, options) => {
        expect(options?.signal).toBeUndefined();
        expect(result).toMatchObject({
          integrationId: "integration-after-abort",
          commitId: commit.commitId,
          previousRevision: receipt.expectedTarget.revision,
        });
        events.push("complete-integration");
      },
      release: async (_lease, options) => {
        expect(options?.signal).toBeUndefined();
        events.push("release");
      },
    };
    const integrator = new WorkflowValidatedIntegrator(
      {
        integrate: async (_repository, normalized) => {
          events.push("host-integrate");
          cancellation.abort(new Error("caller stopped waiting"));
          return {
            integrationId: "integration-after-abort",
            commitId: normalized.commitId,
            targetId: normalized.expectedTarget.targetId,
            previousRevision: normalized.expectedTarget.revision,
            integratedRevision: "head-after-integration",
            integratedAt: 3000,
          };
        },
      },
      liveAuthority,
    );

    await expect(
      integrator.integrate({}, request, { signal: cancellation.signal }),
    ).resolves.toEqual({
      integrationId: "integration-after-abort",
      commitId: commit.commitId,
      targetId: receipt.expectedTarget.targetId,
      previousRevision: receipt.expectedTarget.revision,
      integratedRevision: "head-after-integration",
      integratedAt: 3000,
    });
    expect(cancellation.signal.aborted).toBe(true);
    expect(events).toEqual([
      "acquire-integration",
      "host-integrate",
      "complete-integration",
      "release",
    ]);
  });
});
