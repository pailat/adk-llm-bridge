import { describe, expect, test } from "bun:test";
import { WorkflowLiveChangeReceiptAuthority } from "../../../src/workflows/orchestration/change-receipt-authority.js";
import {
  InMemoryWorkflowChangeReceiptStore,
  InMemoryWorkflowOrchestrationStateStore,
} from "../../../src/workflows/orchestration/stores.js";
import { InMemoryWorkflowHostMutationJournal } from "../../../src/workflows/workspace/mutation-journal.js";

function deps() {
  return {
    state: new InMemoryWorkflowOrchestrationStateStore(),
    receipts: new InMemoryWorkflowChangeReceiptStore(),
    journal: new InMemoryWorkflowHostMutationJournal(),
  };
}

describe("WorkflowLiveChangeReceiptAuthority options", () => {
  test("constructor rejects a missing store with WORKFLOW_ORCHESTRATION_INVALID_REQUEST", () => {
    let error: { code?: string; message?: string } | undefined;
    try {
      new WorkflowLiveChangeReceiptAuthority({
        ...deps(),
        journal: undefined as never,
      });
    } catch (caught) {
      error = caught as { code?: string; message?: string };
    }
    expect(error?.code).toBe("WORKFLOW_ORCHESTRATION_INVALID_REQUEST");
    expect(error?.message).toMatch(
      /requires state, receipt, and journal stores/,
    );
  });

  test("constructor rejects non-positive reservationTtlMs and maxCasRetries", () => {
    expect(
      () =>
        new WorkflowLiveChangeReceiptAuthority({
          ...deps(),
          reservationTtlMs: 0,
        }),
    ).toThrow(/reservationTtlMs must be a positive safe integer/);
    expect(
      () =>
        new WorkflowLiveChangeReceiptAuthority({
          ...deps(),
          maxCasRetries: 1.5,
        }),
    ).toThrow(/maxCasRetries must be a positive safe integer/);
  });
});
