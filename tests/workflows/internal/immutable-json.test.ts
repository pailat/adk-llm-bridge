import { describe, expect, test } from "bun:test";
import { WorkflowExecutionControlError } from "../../../src/workflows/execution/contracts.js";
import { immutableJson } from "../../../src/workflows/execution/json.js";
import { canonicalJson } from "../../../src/workflows/internal/canonical-hash.js";
import { freezeJson } from "../../../src/workflows/internal/immutable-json.js";
import { WorkflowOrchestrationControlError } from "../../../src/workflows/orchestration/contracts.js";
import { immutableWorkflowOrchestrationJson } from "../../../src/workflows/orchestration/json.js";
import { WorkflowTaskControlError } from "../../../src/workflows/tasks/contracts.js";
import { immutableTaskJson } from "../../../src/workflows/tasks/json.js";

const LIMITS = { maxDepth: 8, maxNodes: 100, maxStringLength: 16 };

function fail(message: string): never {
  throw new Error(message);
}

describe("freezeJson", () => {
  test("keeps an own __proto__ key as plain data on every copy", () => {
    const input = JSON.parse('{"__proto__":{"x":1},"y":2}');
    const copy = freezeJson(input, LIMITS, fail) as Record<string, unknown>;

    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(Object.hasOwn(copy, "__proto__")).toBe(true);
    expect(copy.x).toBeUndefined();
    expect(Object.isFrozen(copy)).toBe(true);
    expect(JSON.stringify(copy)).toBe('{"__proto__":{"x":1},"y":2}');
    expect(canonicalJson(copy)).toBe('{"__proto__":{"x":1},"y":2}');
    // The copy is valid input again, as a store transition re-copies it.
    expect(JSON.stringify(freezeJson(copy, LIMITS, fail))).toBe(
      '{"__proto__":{"x":1},"y":2}',
    );
  });

  test("reads each limit once", () => {
    const reads: Record<string, number> = {};
    const limits = {} as typeof LIMITS;
    for (const [name, value] of Object.entries(LIMITS)) {
      Object.defineProperty(limits, name, {
        enumerable: true,
        get: () => {
          reads[name] = (reads[name] ?? 0) + 1;
          return value;
        },
      });
    }

    freezeJson({ a: [1, 2, { b: "x" }], c: "y" }, limits, fail);

    expect(reads).toEqual({ maxDepth: 1, maxNodes: 1, maxStringLength: 1 });
  });

  test("returns a detached, deeply frozen copy and drops undefined fields", () => {
    const input = { a: [1, { b: "x" }], skipped: undefined, n: null };
    const copy = freezeJson(input, LIMITS, fail);

    expect<unknown>(copy).toEqual({ a: [1, { b: "x" }], n: null });
    expect("skipped" in copy).toBe(false);
    expect(Object.isFrozen(copy)).toBe(true);
    expect(Object.isFrozen(copy.a)).toBe(true);
    expect(Object.isFrozen(copy.a[1])).toBe(true);
    expect(copy).not.toBe(input);
  });

  test("reads a proxy through descriptors, never through its get trap", () => {
    let reads = 0;
    const proxy = new Proxy(
      { path: "src/ok.ts" },
      {
        get: (target, key) => {
          reads++;
          return Reflect.get(target, key);
        },
      },
    );
    expect(freezeJson(proxy, LIMITS, fail)).toEqual({ path: "src/ok.ts" });
    // Values are read through descriptors, never through `get`.
    expect(reads).toBe(0);
  });

  test("calls each getter exactly once and copies its result as data", () => {
    let reads = 0;
    const object = {};
    Object.defineProperty(object, "path", {
      enumerable: true,
      get: () => {
        reads++;
        return reads === 1 ? "src/ok.ts" : "../../etc/passwd";
      },
    });
    const array = [0];
    Object.defineProperty(array, 0, {
      enumerable: true,
      get: () => {
        reads++;
        return 1;
      },
    });

    const copy = freezeJson({ object, array }, LIMITS, fail);
    expect(copy).toEqual({ object: { path: "src/ok.ts" }, array: [1] });
    expect(Object.getOwnPropertyDescriptor(copy.object, "path")).toEqual(
      expect.objectContaining({ value: "src/ok.ts", writable: false }),
    );
    expect(reads).toBe(2);
  });

  test("validates what a getter returns", () => {
    const object = Object.defineProperty({}, "n", {
      enumerable: true,
      get: () => Number.NaN,
    });
    expect(() => freezeJson(object, LIMITS, fail)).toThrow(
      "JSON numbers must be finite",
    );
  });

  test("rejects symbol keys, sparse arrays and extra array properties", () => {
    expect(() => freezeJson({ [Symbol("x")]: 1 }, LIMITS, fail)).toThrow(
      "JSON objects must not have symbol keys",
    );
    // biome-ignore lint/suspicious/noSparseArray: a hole is the input under test.
    expect(() => freezeJson([1, , 3], LIMITS, fail)).toThrow(
      "JSON arrays must be dense plain arrays",
    );
    const extra = Object.assign([1], { label: "x" });
    expect(() => freezeJson(extra, LIMITS, fail)).toThrow(
      "JSON arrays must be dense plain arrays",
    );
  });

  test("keeps the existing structural rules", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => freezeJson(cycle, LIMITS, fail)).toThrow(
      "JSON value must not contain cycles",
    );
    expect(() => freezeJson({ n: Number.NaN }, LIMITS, fail)).toThrow(
      "JSON numbers must be finite",
    );
    expect(() => freezeJson(new Date(0), LIMITS, fail)).toThrow(
      "JSON objects must use a plain prototype",
    );
    expect(() => freezeJson([undefined], LIMITS, fail)).toThrow(
      "Value must be JSON-safe",
    );
    expect(() => freezeJson("x".repeat(17), LIMITS, fail)).toThrow(
      "JSON string exceeds length limit",
    );
    expect(() => freezeJson({ ["k".repeat(17)]: 1 }, LIMITS, fail)).toThrow(
      "JSON object key exceeds length limit",
    );
    expect(() =>
      freezeJson(
        Array.from({ length: 101 }, () => 0),
        LIMITS,
        fail,
      ),
    ).toThrow("JSON value exceeds node limit");
    let deep: unknown = 0;
    for (let level = 0; level < 9; level++) deep = [deep];
    expect(() => freezeJson(deep, LIMITS, fail)).toThrow(
      "JSON value exceeds depth limit",
    );
  });

  test("rejects missing or invalid limits instead of disabling them", () => {
    expect(() =>
      freezeJson(1, { maxDepth: 1, maxNodes: 1 } as never, fail),
    ).toThrow("JSON limit maxStringLength must be a positive safe integer");
    expect(() => freezeJson(1, { ...LIMITS, maxNodes: 0 }, fail)).toThrow(
      "JSON limit maxNodes must be a positive safe integer",
    );
  });
});

describe("domain JSON wrappers", () => {
  const symbolKeyed = { [Symbol("hidden")]: true };
  // biome-ignore lint/suspicious/noSparseArray: a hole is the input under test.
  const sparse = [1, , 3];

  test("execution JSON rejects symbol keys and holes with its own code", () => {
    for (const value of [symbolKeyed, sparse]) {
      expect(() => immutableJson(value)).toThrow(WorkflowExecutionControlError);
      expect(() => immutableJson(value)).toThrow(
        expect.objectContaining({ code: "WORKFLOW_EXECUTION_INVALID_REQUEST" }),
      );
    }
  });

  test("task JSON rejects symbol keys and holes with its own code", () => {
    for (const value of [symbolKeyed, sparse]) {
      expect(() => immutableTaskJson(value)).toThrow(WorkflowTaskControlError);
      expect(() => immutableTaskJson(value)).toThrow(
        expect.objectContaining({ code: "WORKFLOW_TASK_INVALID_REQUEST" }),
      );
    }
  });

  test("orchestration JSON rejects symbol keys and holes with its own code", () => {
    for (const value of [symbolKeyed, sparse]) {
      expect(() => immutableWorkflowOrchestrationJson(value)).toThrow(
        WorkflowOrchestrationControlError,
      );
      expect(() => immutableWorkflowOrchestrationJson(value)).toThrow(
        expect.objectContaining({
          code: "WORKFLOW_ORCHESTRATION_INVALID_REQUEST",
        }),
      );
    }
  });

  test("each wrapper keeps its default node limit", () => {
    const nodes = (count: number) => Array.from({ length: count - 1 }, () => 0);
    expect(() => immutableJson(nodes(10_000))).not.toThrow();
    expect(() => immutableJson(nodes(10_001))).toThrow("node limit");
    expect(() => immutableTaskJson(nodes(10_001))).toThrow("node limit");
    expect(() =>
      immutableWorkflowOrchestrationJson(nodes(20_000)),
    ).not.toThrow();
    expect(() => immutableWorkflowOrchestrationJson(nodes(20_001))).toThrow(
      "node limit",
    );
  });
});
