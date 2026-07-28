/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import {
  createWorkflowChangeSet,
  normalizeAcceptedChangeReceipt,
  verifyWorkflowChangeSet,
  type WorkflowAcceptedChangeReceipt,
  type WorkflowChangeInspector,
  WorkflowChangeMismatchError,
  type WorkflowCommitDriver,
  WorkflowValidatedCommitter,
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
      new WorkflowValidatedCommitter(inspector, driver).commit(
        { id: "host-only" },
        { receipt, message: "atomic change" },
      ),
    ).rejects.toBeInstanceOf(WorkflowChangeMismatchError);
    expect(commitCalls).toBe(0);
  });

  test("commits only the reverified snapshot and rejects a mismatched result", async () => {
    const changeSet = await exampleChangeSet();
    const receipt = receiptFor(changeSet);
    let inspected = 0;
    const committer = new WorkflowValidatedCommitter(
      {
        inspect: async () => {
          inspected++;
          return changeSet;
        },
      },
      {
        commit: async (_workspace, input) => {
          expect(input.changeSet).toEqual(changeSet);
          expect(input.receipt).toEqual(
            normalizeAcceptedChangeReceipt(receipt),
          );
          return {
            commitId: "commit-1",
            receiptId: input.receipt.receiptId,
            changeSetDigest: input.changeSet.changeSetDigest,
            workspaceRevision: input.changeSet.workspaceRevision,
            baseRevision: input.changeSet.baseRevision,
            committedAt: 2000,
          };
        },
      },
    );

    await expect(
      committer.commit(
        { hostHandle: "not-serialized" },
        { receipt, message: "  atomic change  " },
      ),
    ).resolves.toEqual({
      commitId: "commit-1",
      receiptId: "receipt-1",
      changeSetDigest: changeSet.changeSetDigest,
      workspaceRevision: "workspace-revision-1",
      baseRevision: "base-revision-1",
      committedAt: 2000,
    });
    expect(inspected).toBe(1);
  });
});
