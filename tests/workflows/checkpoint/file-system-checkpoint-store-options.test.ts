import { describe, expect, test } from "bun:test";
import { FileSystemWorkflowCheckpointStore } from "../../../src/workflows/checkpoint/file-system-checkpoint-store.js";
import { WorkflowError } from "../../../src/workflows/contracts.js";

function build(options: Record<string, unknown>) {
  return new FileSystemWorkflowCheckpointStore(
    options as unknown as ConstructorParameters<
      typeof FileSystemWorkflowCheckpointStore
    >[0],
  );
}

function refusal(run: () => unknown): WorkflowError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowError);
    return error as WorkflowError;
  }
  throw new Error("expected the store constructor to throw");
}

describe("FileSystemWorkflowCheckpointStore unknown options", () => {
  test("a misspelled option is refused with WORKFLOW_DEFINITION_INVALID naming it", () => {
    const error = refusal(() =>
      build({ root: "/tmp/cp", maxCheckpointByte: 5 }),
    );
    expect(error.code).toBe("WORKFLOW_DEFINITION_INVALID");
    expect(error.message).toContain("unknown checkpoint store option");
    expect(error.message).toContain("maxCheckpointByte");
  });

  test("several unknown options are all listed, sorted", () => {
    const error = refusal(() =>
      build({ root: "/tmp/cp", zeta: 1, lockTimeoutM: 2 }),
    );
    expect(error.message).toContain("lockTimeoutM, zeta");
  });

  test("all five documented options are accepted", () => {
    const store = build({
      root: "/tmp/cp",
      lockTimeoutMs: 1000,
      lockRetryMs: 10,
      signal: new AbortController().signal,
      maxCheckpointBytes: 4096,
    });
    expect(store.maxCheckpointBytes).toBe(4096);
  });

  test("a non-absolute root keeps its own error", () => {
    const error = refusal(() => build({ root: "relative" }));
    expect(error.message).toContain("must be absolute");
  });
});
