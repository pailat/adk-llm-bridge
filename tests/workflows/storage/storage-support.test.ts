import { afterAll, describe, expect, test } from "bun:test";
import { type MeterProvider, metrics } from "@opentelemetry/api";
import { WorkflowCheckpointConflictError } from "../../../src/workflows/checkpoint/store.js";
import type { BaseWorkflowCheckpointStore } from "../../../src/workflows/storage/checkpoint-store.js";
import {
  isWorkflowStorageError,
  WorkflowStorageError,
} from "../../../src/workflows/storage/errors.js";
import type { WorkflowStorageOperationMetric } from "../../../src/workflows/storage/support.js";

// A recording meter provider installed before the support module is first
// used, so the histograms the module creates are the ones observed here.
interface RecordedPoint {
  meter: string;
  instrument: string;
  value: number;
  attributes: Record<string, unknown>;
}

const recorded: RecordedPoint[] = [];
const createdInstruments: Array<{ meter: string; name: string }> = [];

const recordingProvider = {
  getMeter(meter: string) {
    const instrument = (name: string) => {
      createdInstruments.push({ meter, name });
      return {
        record(value: number, attributes: Record<string, unknown> = {}) {
          recorded.push({ meter, instrument: name, value, attributes });
        },
        add(value: number, attributes: Record<string, unknown> = {}) {
          recorded.push({ meter, instrument: name, value, attributes });
        },
      };
    };
    return {
      createHistogram: instrument,
      createCounter: instrument,
      createUpDownCounter: instrument,
      createGauge: instrument,
      createObservableGauge: () => ({ addCallback() {}, removeCallback() {} }),
      createObservableCounter: () => ({
        addCallback() {},
        removeCallback() {},
      }),
      createObservableUpDownCounter: () => ({
        addCallback() {},
        removeCallback() {},
      }),
      addBatchObservableCallback() {},
      removeBatchObservableCallback() {},
    };
  },
} as unknown as MeterProvider;

metrics.disable();
metrics.setGlobalMeterProvider(recordingProvider);

const support = await import("../../../src/workflows/storage/support.js");

afterAll(() => {
  metrics.disable();
});

function metric(
  overrides: Partial<WorkflowStorageOperationMetric> = {},
): WorkflowStorageOperationMetric {
  return {
    capability: "checkpoints",
    provider: "memory",
    operation: "save",
    durationMs: 12,
    outcome: "ok",
    bytes: 2048,
    ...overrides,
  };
}

const fastRetry = { initialDelayMs: 1, maxDelayMs: 4, jitter: 0 } as const;

function transient(code: "UNAVAILABLE" | "TIMEOUT" = "UNAVAILABLE") {
  return new WorkflowStorageError(`WORKFLOW_STORAGE_${code}`, "transient");
}

describe("recordWorkflowStorageOperation", () => {
  test("gives the observer the metric it was handed", () => {
    const seen: WorkflowStorageOperationMetric[] = [];
    const input = metric({ operation: "load", bytes: 10 });
    support.recordWorkflowStorageOperation(input, (m) => seen.push(m));
    expect(seen).toEqual([input]);
  });

  test("ignores an observer that throws", () => {
    expect(() =>
      support.recordWorkflowStorageOperation(metric(), () => {
        throw new Error("observer bug");
      }),
    ).not.toThrow();
  });

  test("still records the histograms when the observer throws", () => {
    recorded.length = 0;
    support.recordWorkflowStorageOperation(metric({ durationMs: 33 }), () => {
      throw new Error("observer bug");
    });
    expect(
      recorded.some(
        (point) =>
          point.instrument === support.WORKFLOW_STORAGE_DURATION_METRIC &&
          point.value === 33,
      ),
    ).toBe(true);
  });

  test("records the duration and size histograms on the adk-llm-bridge meter", () => {
    recorded.length = 0;
    support.recordWorkflowStorageOperation(
      metric({ durationMs: 7, bytes: 4096 }),
    );
    const duration = recorded.find(
      (point) => point.instrument === support.WORKFLOW_STORAGE_DURATION_METRIC,
    );
    const size = recorded.find(
      (point) => point.instrument === support.WORKFLOW_STORAGE_SIZE_METRIC,
    );
    expect(duration?.meter).toBe("adk-llm-bridge");
    expect(duration?.value).toBe(7);
    expect(size?.meter).toBe("adk-llm-bridge");
    expect(size?.value).toBe(4096);
    expect(support.WORKFLOW_STORAGE_DURATION_METRIC).toBe(
      "adk_llm_bridge.workflow.storage.operation.duration",
    );
    expect(support.WORKFLOW_STORAGE_SIZE_METRIC).toBe(
      "adk_llm_bridge.workflow.storage.operation.size",
    );
  });

  test("records no size point when the operation has no byte count", () => {
    recorded.length = 0;
    support.recordWorkflowStorageOperation(metric({ bytes: undefined }));
    expect(
      recorded.some(
        (point) => point.instrument === support.WORKFLOW_STORAGE_SIZE_METRIC,
      ),
    ).toBe(false);
  });

  test("histogram attributes carry only capability, provider, operation, outcome and error type", () => {
    recorded.length = 0;
    support.recordWorkflowStorageOperation(
      metric({
        outcome: "error",
        errorCode: "WORKFLOW_STORAGE_TIMEOUT",
        records: 3,
      }),
    );
    expect(recorded.length).toBeGreaterThan(0);
    const allowed = new Set([
      "capability",
      "provider",
      "operation",
      "outcome",
      "error.type",
    ]);
    for (const point of recorded) {
      for (const key of Object.keys(point.attributes)) {
        expect(allowed.has(key)).toBe(true);
      }
      expect(point.attributes.capability).toBe("checkpoints");
      expect(point.attributes.provider).toBe("memory");
      expect(point.attributes.operation).toBe("save");
      expect(point.attributes.outcome).toBe("error");
      expect(point.attributes["error.type"]).toBe("WORKFLOW_STORAGE_TIMEOUT");
    }
  });

  test("works with no observer", () => {
    expect(() =>
      support.recordWorkflowStorageOperation(metric()),
    ).not.toThrow();
    expect(createdInstruments.length).toBeGreaterThan(0);
  });
});

describe("retryWorkflowStorageOperation", () => {
  test("returns the value of a first try that succeeds without delay", async () => {
    const attempts: number[] = [];
    const value = await support.retryWorkflowStorageOperation(async (n) => {
      attempts.push(n);
      return "done";
    }, fastRetry);
    expect(value).toBe("done");
    expect(attempts).toEqual([1]);
  });

  test("retries a retryable error and passes the one-based attempt number", async () => {
    const attempts: number[] = [];
    const value = await support.retryWorkflowStorageOperation(async (n) => {
      attempts.push(n);
      if (n < 3) throw transient();
      return n;
    }, fastRetry);
    expect(value).toBe(3);
    expect(attempts).toEqual([1, 2, 3]);
  });

  test("retries WORKFLOW_STORAGE_TIMEOUT", async () => {
    let calls = 0;
    await support.retryWorkflowStorageOperation(async () => {
      calls += 1;
      if (calls === 1) throw transient("TIMEOUT");
      return "ok";
    }, fastRetry);
    expect(calls).toBe(2);
  });

  test("throws the error of the last try when every try failed, after maxAttempts tries", async () => {
    let calls = 0;
    const error = await support
      .retryWorkflowStorageOperation(
        async (n) => {
          calls += 1;
          throw new WorkflowStorageError(
            "WORKFLOW_STORAGE_UNAVAILABLE",
            `try ${n}`,
          );
        },
        { ...fastRetry, maxAttempts: 3 },
      )
      .catch((e: unknown) => e);
    expect(calls).toBe(3);
    expect(isWorkflowStorageError(error)).toBe(true);
    expect((error as WorkflowStorageError).message).toBe("try 3");
  });

  test("uses 4 tries by default", async () => {
    let calls = 0;
    await support
      .retryWorkflowStorageOperation(
        async () => {
          calls += 1;
          throw transient();
        },
        { initialDelayMs: 1, maxDelayMs: 2, jitter: 0 },
      )
      .catch(() => undefined);
    expect(calls).toBe(4);
  });

  test("never retries a non-retryable storage error", async () => {
    for (const code of [
      "WORKFLOW_STORAGE_CORRUPT",
      "WORKFLOW_STORAGE_LEASE_LOST",
      "WORKFLOW_STORAGE_LEASE_HELD",
      "WORKFLOW_STORAGE_UNSUPPORTED",
      "WORKFLOW_STORAGE_CLOSED",
    ] as const) {
      let calls = 0;
      await expect(
        support.retryWorkflowStorageOperation(async () => {
          calls += 1;
          throw new WorkflowStorageError(code, "no");
        }, fastRetry),
      ).rejects.toMatchObject({ code });
      expect(calls).toBe(1);
    }
  });

  test("never retries a compare-and-set conflict or a plain error", async () => {
    let calls = 0;
    await expect(
      support.retryWorkflowStorageOperation(async () => {
        calls += 1;
        throw new WorkflowCheckpointConflictError("key", "a", "b");
      }, fastRetry),
    ).rejects.toBeInstanceOf(WorkflowCheckpointConflictError);
    expect(calls).toBe(1);
    await expect(
      support.retryWorkflowStorageOperation(async () => {
        calls += 1;
        throw new Error("plain");
      }, fastRetry),
    ).rejects.toThrow("plain");
    expect(calls).toBe(2);
  });

  test("honors a retryable override on an error whose code is not transient", async () => {
    let calls = 0;
    await support.retryWorkflowStorageOperation(async () => {
      calls += 1;
      if (calls === 1) {
        throw new WorkflowStorageError("WORKFLOW_STORAGE_CORRUPT", "x", {
          retryable: true,
        });
      }
    }, fastRetry);
    expect(calls).toBe(2);
  });

  test("waits with exponential backoff capped by maxDelayMs", async () => {
    const stamps: number[] = [];
    await support
      .retryWorkflowStorageOperation(
        async () => {
          stamps.push(performance.now());
          throw transient();
        },
        { maxAttempts: 4, initialDelayMs: 20, maxDelayMs: 40, jitter: 0 },
      )
      .catch(() => undefined);
    expect(stamps).toHaveLength(4);
    const gaps = stamps.slice(1).map((stamp, i) => stamp - (stamps[i] ?? 0));
    // 20 ms, then 40 ms, then capped at 40 ms (not 80).
    expect(gaps[0]).toBeGreaterThanOrEqual(15);
    expect(gaps[0]).toBeLessThan(38);
    expect(gaps[1]).toBeGreaterThanOrEqual(35);
    expect(gaps[1]).toBeLessThan(75);
    expect(gaps[2]).toBeGreaterThanOrEqual(35);
    expect(gaps[2]).toBeLessThan(75);
  });

  test("jitter keeps each delay within the configured fraction", async () => {
    const stamps: number[] = [];
    await support
      .retryWorkflowStorageOperation(
        async () => {
          stamps.push(performance.now());
          throw transient();
        },
        { maxAttempts: 6, initialDelayMs: 20, maxDelayMs: 20, jitter: 0.5 },
      )
      .catch(() => undefined);
    const gaps = stamps.slice(1).map((stamp, i) => stamp - (stamps[i] ?? 0));
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(8);
      expect(gap).toBeLessThan(60);
    }
    expect(new Set(gaps.map((gap) => Math.round(gap))).size).toBeGreaterThan(1);
  });

  test("an aborted signal stops waiting and throws the pending error", async () => {
    const controller = new AbortController();
    let calls = 0;
    const started = performance.now();
    const pending = support
      .retryWorkflowStorageOperation(
        async () => {
          calls += 1;
          throw new WorkflowStorageError(
            "WORKFLOW_STORAGE_UNAVAILABLE",
            "still down",
          );
        },
        {
          maxAttempts: 5,
          initialDelayMs: 5000,
          maxDelayMs: 5000,
          jitter: 0,
          signal: controller.signal,
        },
      )
      .catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const error = await pending;
    expect(performance.now() - started).toBeLessThan(1500);
    expect(calls).toBe(1);
    expect((error as WorkflowStorageError).message).toBe("still down");
  });

  test("a signal that is already aborted does not start a second try", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await support
      .retryWorkflowStorageOperation(
        async () => {
          calls += 1;
          throw transient();
        },
        { ...fastRetry, signal: controller.signal },
      )
      .catch(() => undefined);
    expect(calls).toBe(1);
  });

  test("a try longer than attemptTimeoutMs fails with WORKFLOW_STORAGE_TIMEOUT", async () => {
    const error = await support
      .retryWorkflowStorageOperation(() => new Promise<never>(() => {}), {
        ...fastRetry,
        maxAttempts: 1,
        attemptTimeoutMs: 20,
      })
      .catch((e: unknown) => e);
    expect(isWorkflowStorageError(error, "WORKFLOW_STORAGE_TIMEOUT")).toBe(
      true,
    );
    expect((error as WorkflowStorageError).retryable).toBe(true);
  });

  test("a timed-out try is retried, and a later try can succeed", async () => {
    let calls = 0;
    const value = await support.retryWorkflowStorageOperation(
      (n) => {
        calls += 1;
        return n === 1 ? new Promise<string>(() => {}) : Promise.resolve("ok");
      },
      { ...fastRetry, maxAttempts: 2, attemptTimeoutMs: 20 },
    );
    expect(value).toBe("ok");
    expect(calls).toBe(2);
  });
});

describe("requireWorkflowCheckpointCapability", () => {
  function fakeStore(
    compareAndSet: "atomic" | "advisory",
  ): BaseWorkflowCheckpointStore {
    return {
      providerName: "advisory-fake",
      capabilities: {
        compareAndSet,
        leases: true,
        durable: false,
        multiProcess: false,
        listing: false,
        pruning: false,
        maxCheckpointBytes: 1024,
      },
    } as unknown as BaseWorkflowCheckpointStore;
  }

  test("is an exported function", () => {
    expect(support.requireWorkflowCheckpointCapability).toBeFunction();
  });

  test("accepts a store that declares compareAndSet atomic", () => {
    expect(() =>
      support.requireWorkflowCheckpointCapability(
        fakeStore("atomic"),
        "compareAndSet",
      ),
    ).not.toThrow();
  });

  test("refuses an advisory store with a typed unsupported error that names the capability", () => {
    let thrown: unknown;
    try {
      support.requireWorkflowCheckpointCapability(
        fakeStore("advisory"),
        "compareAndSet",
      );
    } catch (error) {
      thrown = error;
    }
    expect(isWorkflowStorageError(thrown, "WORKFLOW_STORAGE_UNSUPPORTED")).toBe(
      true,
    );
    const error = thrown as WorkflowStorageError & { capability?: unknown };
    expect(error.capability ?? error.details.capability).toBe("compareAndSet");
    expect(error.retryable).toBe(false);
  });
});
