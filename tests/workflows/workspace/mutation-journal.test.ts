/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import {
  InMemoryWorkflowHostMutationJournal,
  WorkflowHostMutationConflictError,
} from "../../../src/workflows/workspace/mutation-journal.js";

const INTENT_DIGEST = `sha256:${"c".repeat(64)}`;

function intent(operationId = "operation-1") {
  return {
    operationId,
    intentDigest: INTENT_DIGEST,
    kind: "commit" as const,
    executionId: "execution-1",
    taskId: "task-1",
    startedAt: 1000,
  };
}

describe("InMemoryWorkflowHostMutationJournal", () => {
  test("is idempotent for the same operationId and intent digest", async () => {
    const journal = new InMemoryWorkflowHostMutationJournal();
    const first = await journal.begin(intent());
    const retry = await journal.begin(intent());

    expect(first.created).toBe(true);
    expect(retry).toEqual({ record: first.record, created: false });
    expect(first.record.status).toBe("pending");
    expect(Object.isFrozen(first.record)).toBe(true);

    const completed = await journal.complete("operation-1", INTENT_DIGEST, {
      commitId: "commit-1",
    });
    const completedRetry = await journal.complete(
      "operation-1",
      INTENT_DIGEST,
      { commitId: "commit-1" },
    );
    expect(completed.status).toBe("completed");
    expect(completedRetry).toBe(completed);
    expect((await journal.begin(intent())).record).toBe(completed);
  });

  test("atomically identifies only the first host mutation attempt", async () => {
    const journal = new InMemoryWorkflowHostMutationJournal();
    await journal.begin(intent());
    const attempts = await Promise.all([
      journal.beginHostMutation(intent()),
      journal.beginHostMutation(intent()),
    ]);
    expect(attempts.filter((attempt) => attempt.created)).toHaveLength(1);
    expect(
      attempts.every((attempt) => attempt.record.hostStartedAt === 1000),
    ).toBe(true);
  });

  test("rejects operation id reuse with another intent or result", async () => {
    const journal = new InMemoryWorkflowHostMutationJournal();
    await journal.begin(intent());

    await expect(
      journal.begin({
        ...intent(),
        intentDigest: `sha256:${"d".repeat(64)}`,
      }),
    ).rejects.toBeInstanceOf(WorkflowHostMutationConflictError);
    await journal.complete("operation-1", INTENT_DIGEST, {
      commitId: "commit-1",
    });
    await expect(
      journal.complete("operation-1", INTENT_DIGEST, {
        commitId: "commit-2",
      }),
    ).rejects.toThrow("different completed result");
  });

  test("records ambiguous mutations and permits verified reconciliation", async () => {
    const journal = new InMemoryWorkflowHostMutationJournal();
    await journal.begin(intent());
    const ambiguous = await journal.markAmbiguous(
      "operation-1",
      INTENT_DIGEST,
      "host exited after mutation",
    );
    const retry = await journal.markAmbiguous(
      "operation-1",
      INTENT_DIGEST,
      "host exited after mutation",
    );

    expect(ambiguous.status).toBe("ambiguous");
    expect(retry).toBe(ambiguous);
    await expect(
      journal.complete("operation-1", INTENT_DIGEST, {
        commitId: "reconciled-commit",
      }),
    ).resolves.toMatchObject({ status: "completed", revision: 3 });
  });

  test("lists stable per-execution snapshots and rejects non-JSON results", async () => {
    const journal = new InMemoryWorkflowHostMutationJournal();
    await journal.begin(intent("operation-2"));
    await journal.begin({ ...intent("operation-1"), startedAt: 900 });

    expect(
      (await journal.list("execution-1")).map((record) => record.operationId),
    ).toEqual(["operation-1", "operation-2"]);
    await expect(
      journal.complete("operation-1", INTENT_DIGEST, {
        invalid: Number.NaN,
      }),
    ).rejects.toThrow("finite JSON numbers");
  });
});
