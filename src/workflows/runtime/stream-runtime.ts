/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { AsyncQueue, type Event } from "@google/adk";
import { WorkflowError } from "../contracts.js";

/** Handles given to the runtime factory by {@link streamWorkflowRuntime}. */
export interface WorkflowRuntimeStreamHandles {
  /** Forwards one runtime event to the consumer of the stream. */
  push: (event: Event) => void;
  /** Aborted when the consumer closes the stream before the run finishes. */
  signal: AbortSignal;
}

/**
 * Streams the events of a workflow runtime as an async generator.
 *
 * When a consumer stops early (`break`, `iterator.return()`, or a node
 * `timeout` that ADK enforces by closing the generator) only the generator is
 * closed; the invocation signal is not necessarily aborted. Closing the stream
 * therefore aborts the runtime and waits for it to settle, so no LLM call or
 * checkpoint write is left running unattended. The wait is unbounded if the
 * runtime ignores the abort; ADK's node runner does not await `return()`.
 */
export async function* streamWorkflowRuntime(
  createRuntime: (handles: WorkflowRuntimeStreamHandles) => {
    execute(): Promise<unknown>;
  },
): AsyncGenerator<Event, void, void> {
  const queue = new AsyncQueue<Event>();
  const abort = new AbortController();
  let execution: Promise<unknown> | undefined;
  let settled = false;
  try {
    const runtime = createRuntime({
      push: (event) => queue.push(event),
      signal: abort.signal,
    });
    execution = runtime.execute();
    void execution.then(
      () => {
        settled = true;
        queue.close();
      },
      (error) => {
        settled = true;
        queue.fail(error);
      },
    );
    yield* queue;
  } finally {
    if (execution && !settled) {
      abort.abort(
        new WorkflowError(
          "WORKFLOW_ABORTED",
          "Workflow invocation iterator closed before execution completed",
        ),
      );
    }
    await execution?.catch(() => undefined);
  }
}
