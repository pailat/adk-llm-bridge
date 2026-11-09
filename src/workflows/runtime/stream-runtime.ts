import { AsyncQueue, type Event } from "@google/adk";
import { WorkflowError } from "../contracts.js";

/**
 * Handles given to the runtime factory by {@link streamWorkflowRuntime}.
 *
 * @internal
 */
export interface WorkflowRuntimeStreamHandles {
  /**
   * Forwards one runtime event to the consumer of the stream. Resolves once
   * the consumer has taken the event and asked for the next one, or once the
   * stream is closed.
   */
  push: (event: Event) => Promise<void>;
  /** Aborted when the consumer closes the stream before the run finishes. */
  signal: AbortSignal;
}

/**
 * Streams the events of a workflow runtime as an async generator.
 *
 * Delivery has back-pressure, like any ADK agent generator: a runtime that
 * awaits `push` continues only after the consumer has handled the event, so
 * a `step_started` reaches the consumer before the step's agent starts.
 *
 * When a consumer stops early (`break`, `iterator.return()`, or a node
 * `timeout` that ADK enforces by closing the generator) only the generator is
 * closed; the invocation signal is not necessarily aborted. Closing the stream
 * therefore aborts the runtime and waits for it to settle, so no LLM call or
 * checkpoint write is left running unattended. The wait is unbounded if the
 * runtime ignores the abort; ADK's node runner does not await `return()`.
 *
 * @internal
 */
export async function* streamWorkflowRuntime(
  createRuntime: (handles: WorkflowRuntimeStreamHandles) => {
    execute(): Promise<unknown>;
  },
  active?: ActiveExecutions,
): AsyncGenerator<Event, void, void> {
  // ADK retries a timed-out node without waiting for the previous run to wind
  // down. Wait for it here so the new run sees the failure that run records
  // instead of a step still marked `running`, and never writes concurrently.
  await active?.settled();
  const queue = new AsyncQueue<Event>();
  // One resolver per pushed event, in queue order.
  const delivered: Array<() => void> = [];
  let closed = false;
  const abort = new AbortController();
  let execution: Promise<unknown> | undefined;
  let settled = false;
  try {
    const runtime = createRuntime({
      push: (event) => {
        if (closed) return Promise.resolve();
        queue.push(event);
        return new Promise<void>((resolve) => delivered.push(resolve));
      },
      signal: abort.signal,
    });
    execution = runtime.execute();
    active?.track(execution);
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
    for await (const event of queue) {
      yield event;
      delivered.shift()?.();
    }
  } finally {
    // Never leave the runtime waiting on a consumer that is gone.
    closed = true;
    for (const resolve of delivered.splice(0)) resolve();
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

/**
 * Executions of one agent instance that have not settled yet, so a re-entry
 * (ADK node retry with the same invocation id) can wait for the previous one.
 *
 * @internal
 */
export class ActiveExecutions {
  readonly #running = new Set<Promise<unknown>>();

  /** Registers an execution until it settles, whether it resolves or rejects. */
  track(execution: Promise<unknown>): void {
    const settled = execution.then(
      () => undefined,
      () => undefined,
    );
    this.#running.add(settled);
    void settled.then(() => this.#running.delete(settled));
  }

  /** Resolves once every tracked execution, including ones added while waiting, has settled. */
  async settled(): Promise<void> {
    while (this.#running.size > 0) {
      await Promise.all([...this.#running]);
    }
  }
}
