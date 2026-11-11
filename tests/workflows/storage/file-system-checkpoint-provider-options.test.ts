import { describe, expect, test } from "bun:test";
import { WorkflowError } from "../../../src/workflows/contracts.js";
import { FileSystemWorkflowCheckpointProvider } from "../../../src/workflows/storage/file-system-checkpoint-provider.js";

function build(options: Record<string, unknown>) {
  return new FileSystemWorkflowCheckpointProvider(
    options as unknown as ConstructorParameters<
      typeof FileSystemWorkflowCheckpointProvider
    >[0],
  );
}

describe("FileSystemWorkflowCheckpointProvider unknown options", () => {
  test("a misspelled root option is refused naming it", () => {
    try {
      build({ root: "/tmp/cp", rooot: "/tmp/other" });
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowError);
      expect((error as WorkflowError).code).toBe("WORKFLOW_DEFINITION_INVALID");
      expect((error as Error).message).toContain("rooot");
      return;
    }
    throw new Error("expected the provider constructor to throw");
  });

  test("base provider options and every store option are accepted", () => {
    const provider = build({
      root: "/tmp/cp",
      lockTimeoutMs: 1000,
      lockRetryMs: 10,
      signal: new AbortController().signal,
      maxCheckpointBytes: 4096,
      operationTimeoutMs: 5000,
      retry: { maxAttempts: 1 },
      onOperation: () => undefined,
    });
    expect(provider.providerName).toBe("file");
    expect(provider.capabilities.maxCheckpointBytes).toBe(4096);
  });
});
