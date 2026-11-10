/**
 * One conformance test: a name that states the guarantee and a function that
 * rejects when the provider breaks it.
 *
 * @experimental
 */
export interface WorkflowStorageConformanceCase {
  /** The guarantee under test, as a sentence. */
  name: string;
  /**
   * Set when the provider's capability flags say the guarantee does not
   * apply; the text names the flag. A skipped case is reported, not run.
   */
  skip?: string;
  /** Runs the case against a fresh provider; rejects on a violation. */
  run(): Promise<void>;
}

/**
 * Error a conformance case rejects with when a provider breaks a guarantee.
 *
 * @experimental
 */
export class WorkflowStorageConformanceFailure extends Error {
  /**
   * Creates the failure.
   *
   * @param message - What was expected and what the provider did.
   */
  constructor(message: string) {
    super(message);
    this.name = "WorkflowStorageConformanceFailure";
  }
}

/**
 * Registers conformance cases with any test runner.
 *
 * @param cases - Cases from a `...ConformanceCases` function.
 * @param runner - The runner's `test` function and, optionally, its skip
 * function. Without `skip`, skipped cases are not registered.
 *
 * @example
 * ```ts
 * import { test } from "bun:test";
 * import {
 *   defineWorkflowStorageConformanceTests,
 *   workflowCheckpointStoreConformanceCases,
 * } from "adk-llm-bridge/workflows/storage/conformance";
 *
 * defineWorkflowStorageConformanceTests(
 *   await workflowCheckpointStoreConformanceCases({ createStore: () => new MyCheckpointStore() }),
 *   { test, skip: test.skip },
 * );
 * ```
 *
 * @experimental
 */
export function defineWorkflowStorageConformanceTests(
  cases: readonly WorkflowStorageConformanceCase[],
  runner: {
    test: (name: string, run: () => Promise<void>) => unknown;
    skip?: (name: string, run: () => Promise<void>) => unknown;
  },
): void {
  for (const conformanceCase of cases) {
    if (conformanceCase.skip === undefined) {
      runner.test(conformanceCase.name, () => conformanceCase.run());
    } else if (runner.skip) {
      runner.skip(`${conformanceCase.name} (${conformanceCase.skip})`, () =>
        conformanceCase.run(),
      );
    }
  }
}
