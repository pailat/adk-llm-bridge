import { describe, expect, test } from "bun:test";
import {
  RUN_SPEC_ISSUE_FAMILIES,
  RUN_SPEC_MAX_ISSUE_MESSAGE_LENGTH,
  RUN_SPEC_MAX_UNKNOWN_KEYS_REPORTED,
  type RunSpecIssue,
  type RunSpecIssueCode,
  RunSpecIssueSchema,
} from "../../../src/workflows/spec/issues.js";
import {
  RUN_SPEC_INPUT_LIMITS,
  RUN_SPEC_LIMITS,
} from "../../../src/workflows/spec/schema.js";
import { parseRunSpecShape } from "../../../src/workflows/spec/shape.js";
import { validSpec, wideSpec } from "./helpers.js";

// biome-ignore lint/suspicious/noExplicitAny: tests build deliberately broken specs.
type Loose = any;

function run(input: unknown) {
  const issues: RunSpecIssue[] = [];
  const value = parseRunSpecShape(input, issues);
  return { value, issues };
}

function broken(edit: (spec: Loose) => void) {
  const spec: Loose = validSpec();
  edit(spec);
  return run(spec);
}

function codes(issues: RunSpecIssue[]): RunSpecIssueCode[] {
  return issues.map((issue) => issue.code);
}

/** Asserts exactly one issue with the given code and path. */
/** Wraps an array in a proxy that counts the properties read from it. */
function countingArray(target: unknown[]): {
  array: unknown[];
  reads: () => number;
} {
  let reads = 0;
  const array = new Proxy(target, {
    getOwnPropertyDescriptor(inner, key) {
      reads += 1;
      return Reflect.getOwnPropertyDescriptor(inner, key);
    },
    ownKeys(inner) {
      reads += 1;
      return Reflect.ownKeys(inner);
    },
  });
  return { array, reads: () => reads };
}

function expectOne(
  result: ReturnType<typeof run>,
  code: RunSpecIssueCode,
  path: (string | number)[],
) {
  expect(result.issues.map((i) => [i.code, i.path])).toEqual([[code, path]]);
  expect(result.value).toBeUndefined();
}

function has(
  issues: RunSpecIssue[],
  code: RunSpecIssueCode,
  path: (string | number)[],
) {
  return issues.some(
    (i) => i.code === code && JSON.stringify(i.path) === JSON.stringify(path),
  );
}

function nest(depth: number): unknown {
  let node: unknown = { leaf: 1 };
  for (let level = 0; level < depth; level++) node = { next: node };
  return node;
}

describe("parseRunSpecShape: valid input", () => {
  test("returns the spec and adds no issue for a valid spec", () => {
    const { value, issues } = run(validSpec());
    expect(issues).toEqual([]);
    expect(value).toEqual(validSpec());
  });

  test("accepts a spec with one thousand lanes", () => {
    const { value, issues } = run(wideSpec(1_000));
    expect(issues).toEqual([]);
    expect(value?.lanes.length).toBe(1_000);
  });

  test("accepts optional keys, the none publish kind and an integration publish", () => {
    const spec: Loose = validSpec();
    spec.extensions = { "x-acme": { any: ["json", 1, null] } };
    spec.lanes[0].extensions = { "x-acme-two": 1 };
    spec.lanes[0].agent.allowNetwork = true;
    spec.gates.publish = {
      kind: "integration",
      hitl: true,
      targetRef: "refs/heads/main",
    };
    const result = run(spec);
    expect(result.issues).toEqual([]);
    expect(result.value).toEqual(spec);
    expect(run(broken(() => {}).value).issues).toEqual([]);
    const none: Loose = validSpec();
    none.gates.publish = { kind: "none" };
    expect(run(none).issues).toEqual([]);
  });

  test("returns a frozen copy that later changes to the input cannot reach", () => {
    const spec: Loose = validSpec();
    const { value } = run(spec);
    expect(value).toBeDefined();
    expect(value).not.toBe(spec);
    expect(Object.isFrozen(value)).toBe(true);
    spec.lanes[0].taskId = "changed";
    spec.budget.maxUsd = 999;
    expect(value?.lanes[0]?.taskId).toBe("api");
    expect(value?.budget.maxUsd).toBe(5);
  });

  test("does not change the input", () => {
    const spec = validSpec();
    const snapshot = structuredClone(spec);
    run(spec);
    expect(spec).toEqual(snapshot);
    const bad: Loose = validSpec();
    bad.extra = 1;
    delete bad.budget;
    const badSnapshot = structuredClone(bad);
    run(bad);
    expect(bad).toEqual(badSnapshot);
  });

  test("appends to the issues already in the list and keeps them", () => {
    const existing: RunSpecIssue[] = [
      { code: "RUN_SPEC_RULES_INVALID", path: [], message: "earlier" },
    ];
    const spec: Loose = validSpec();
    spec.extra = 1;
    parseRunSpecShape(spec, existing);
    expect(existing[0]?.message).toBe("earlier");
    expect(codes(existing)).toEqual([
      "RUN_SPEC_RULES_INVALID",
      "RUN_SPEC_UNKNOWN_KEY",
    ]);
  });

  test("returns a value exactly when it adds no issue", () => {
    for (const input of [validSpec(), null, 1, {}, wideSpec(3)]) {
      const { value, issues } = run(input);
      expect(value === undefined).toBe(issues.length > 0);
    }
  });
});

describe("parseRunSpecShape: input guard", () => {
  test("reports a cyclic object as not JSON, once, at the root", () => {
    const spec: Loose = validSpec();
    spec.lanes[0].self = spec;
    expectOne(run(spec), "RUN_SPEC_INPUT_NOT_JSON", []);
  });

  test("reports a cycle through an array", () => {
    const spec: Loose = validSpec();
    spec.env.push(spec.env);
    expectOne(run(spec), "RUN_SPEC_INPUT_NOT_JSON", []);
  });

  test("reports values that are not plain JSON", () => {
    const withNan: Loose = validSpec();
    withNan.budget.maxUsd = Number.NaN;
    const withInfinity: Loose = validSpec();
    withInfinity.maxConcurrency = Number.POSITIVE_INFINITY;
    const withFunction: Loose = validSpec();
    withFunction.title = () => 1;
    const withSymbolKey: Loose = validSpec();
    withSymbolKey[Symbol("k")] = 1;
    const withBigInt: Loose = validSpec();
    withBigInt.maxConcurrency = 1n;
    const withDate: Loose = validSpec();
    withDate.extensions = { "x-a": new Date(0) };
    const withMap: Loose = validSpec();
    withMap.extensions = { "x-a": new Map() };
    const sparse: Loose = validSpec();
    sparse.env = new Array(3);
    class Spec {
      specVersion = 1;
    }
    for (const input of [
      withNan,
      withInfinity,
      withFunction,
      withSymbolKey,
      withBigInt,
      withDate,
      withMap,
      sparse,
      new Spec(),
      Symbol("s"),
      () => 1,
    ]) {
      const { value, issues } = run(input);
      expect(value).toBeUndefined();
      expect(codes(issues)).toEqual(["RUN_SPEC_INPUT_NOT_JSON"]);
      expect(issues[0]?.path).toEqual([]);
    }
  });

  test("reports a getter that throws instead of throwing", () => {
    const spec: Loose = validSpec();
    Object.defineProperty(spec, "budget", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    expect(() => run(spec)).not.toThrow();
    const { value, issues } = run(spec);
    expect(value).toBeUndefined();
    expect(issues.length).toBeGreaterThan(0);
  });

  test("does not let a getter or proxy answer differently on a later read", () => {
    let reads = 0;
    const spec: Loose = validSpec();
    Object.defineProperty(spec, "maxConcurrency", {
      enumerable: true,
      get() {
        reads++;
        return reads === 1 ? 2 : 9_999;
      },
    });
    const { value, issues } = run(spec);
    if (value) {
      expect(issues).toEqual([]);
      expect(value.maxConcurrency).toBe(value.maxConcurrency);
      expect(value.maxConcurrency).toBeLessThanOrEqual(
        RUN_SPEC_LIMITS.maxConcurrency,
      );
    } else {
      expect(issues.length).toBeGreaterThan(0);
    }
    const proxy = new Proxy(validSpec(), {
      get() {
        throw new Error("trap");
      },
      ownKeys() {
        throw new Error("trap");
      },
    });
    expect(() => run(proxy)).not.toThrow();
    expect(run(proxy).issues.length).toBeGreaterThan(0);
  });

  test("reports input nested beyond the depth limit as too deep, once, at the root", () => {
    const spec: Loose = validSpec();
    spec.extensions = { "x-deep": nest(RUN_SPEC_INPUT_LIMITS.maxDepth + 1) };
    expectOne(run(spec), "RUN_SPEC_INPUT_TOO_DEEP", []);
  });

  test("accepts a spec at the input depth limit and does not call it too deep", () => {
    const { issues } = run(validSpec());
    expect(codes(issues)).not.toContain("RUN_SPEC_INPUT_TOO_DEEP");
  });

  test("survives nesting of one hundred thousand levels without a stack overflow", () => {
    const spec: Loose = validSpec();
    spec.extensions = { "x-deep": nest(100_000) };
    let result: ReturnType<typeof run> | undefined;
    expect(() => {
      result = run(spec);
    }).not.toThrow();
    expect(result?.value).toBeUndefined();
    expect(codes(result?.issues ?? [])).toEqual(["RUN_SPEC_INPUT_TOO_DEEP"]);
    let arrays: unknown = [];
    for (let level = 0; level < 100_000; level++) arrays = [arrays];
    expect(() => run(arrays)).not.toThrow();
    expect(run(arrays).issues.length).toBeGreaterThan(0);
  });

  test("survives a deeply nested value placed under the root key itself", () => {
    expect(() => run(nest(50_000))).not.toThrow();
    const result = run(nest(50_000));
    expect(codes(result.issues)).toEqual(["RUN_SPEC_INPUT_TOO_DEEP"]);
  });

  test("reports more values than the node limit as too large, once, at the root", () => {
    const spec: Loose = validSpec();
    spec.extensions = {
      "x-big": new Array(RUN_SPEC_INPUT_LIMITS.maxNodes + 1).fill(0),
    };
    expectOne(run(spec), "RUN_SPEC_INPUT_TOO_LARGE", []);
  });

  test("rejects a huge array as too large without copying it", () => {
    const spec: Loose = validSpec();
    spec.env = new Array(5_000_000).fill("CI");
    expectOne(run(spec), "RUN_SPEC_INPUT_TOO_LARGE", []);
    const counted = countingArray(new Array(5_000_000).fill("CI"));
    spec.env = counted.array;
    expectOne(run(spec), "RUN_SPEC_INPUT_TOO_LARGE", []);
    expect(counted.reads()).toBeLessThan(10);
  });

  test("rejects a huge array of any item type without reading its items", () => {
    const spec: Loose = validSpec();
    spec.env = new Array(5_000_000).fill(0);
    expectOne(run(spec), "RUN_SPEC_INPUT_TOO_LARGE", []);
    const counted = countingArray(new Array(5_000_000).fill(0));
    spec.env = counted.array;
    expectOne(run(spec), "RUN_SPEC_INPUT_TOO_LARGE", []);
    expect(counted.reads()).toBeLessThan(10);
  });

  test("rejects a huge array inside an extension value without reading its items", () => {
    const spec: Loose = validSpec();
    spec.lanes[0].extensions = {
      "x-vendor": { list: new Array(5_000_000).fill(1) },
    };
    expectOne(run(spec), "RUN_SPEC_INPUT_TOO_LARGE", []);
    const counted = countingArray(new Array(5_000_000).fill(1));
    spec.lanes[0].extensions = { "x-vendor": { list: counted.array } };
    expectOne(run(spec), "RUN_SPEC_INPUT_TOO_LARGE", []);
    expect(counted.reads()).toBeLessThan(10);
  });

  test("rejects an object with more keys than the node limit quickly", () => {
    const spec: Loose = validSpec();
    const wide: Record<string, number> = {};
    for (let i = 0; i <= RUN_SPEC_INPUT_LIMITS.maxNodes; i++) wide[`k${i}`] = i;
    spec.extensions = { "x-vendor": wide };
    expectOne(run(spec), "RUN_SPEC_INPUT_TOO_LARGE", []);
  });

  test("rejects many small arrays that together pass the node limit", () => {
    const spec: Loose = validSpec();
    const chunk = Math.ceil(RUN_SPEC_INPUT_LIMITS.maxNodes / 4);
    spec.extensions = {
      "x-vendor": [0, 1, 2, 3, 4].map(() => new Array(chunk).fill(0)),
    };
    expectOne(run(spec), "RUN_SPEC_INPUT_TOO_LARGE", []);
  });

  test("never calls a getter while counting", () => {
    const spec: Loose = validSpec();
    let reads = 0;
    Object.defineProperty(spec, "title", {
      enumerable: true,
      get() {
        reads += 1;
        return "Title";
      },
    });
    run(spec);
    expect(reads).toBe(1);
  });

  test("still reports a cycle as not JSON", () => {
    const spec: Loose = validSpec();
    spec.extensions = { "x-vendor": {} };
    spec.extensions["x-vendor"].self = spec.extensions["x-vendor"];
    expectOne(run(spec), "RUN_SPEC_INPUT_NOT_JSON", []);
  });

  test("rejects a huge nested array as too large", () => {
    const spec: Loose = validSpec();
    spec.lanes[0].allowedPaths = new Array(1_000_000).fill("src/a");
    expectOne(run(spec), "RUN_SPEC_INPUT_TOO_LARGE", []);
  });

  /** A huge array behind a proxy that counts the properties read from it. */
  function countedHugeArray(): { array: unknown[]; reads: () => number } {
    let reads = 0;
    const array = new Proxy(new Array(5_000_000).fill("Read"), {
      getOwnPropertyDescriptor(target, key) {
        reads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      ownKeys(target) {
        reads += 1;
        return Reflect.ownKeys(target);
      },
    });
    return { array, reads: () => reads };
  }

  test("rejects a huge array that follows a shared object without reading its items", () => {
    const spec: Loose = validSpec();
    const qa = { id: "test", command: ["bun", "test"] };
    spec.gates.qa = [qa, qa];
    const huge = countedHugeArray();
    spec.lanes[0].agent.tools = huge.array;
    expectOne(run(spec), "RUN_SPEC_INPUT_TOO_LARGE", []);
    expect(huge.reads()).toBeLessThan(10);
  });

  test("rejects a huge array returned by a getter, calling the getter once", () => {
    const spec: Loose = validSpec();
    const huge = countedHugeArray();
    let calls = 0;
    Object.defineProperty(spec.lanes[0].agent, "tools", {
      enumerable: true,
      get() {
        calls += 1;
        return huge.array;
      },
    });
    expectOne(run(spec), "RUN_SPEC_INPUT_TOO_LARGE", []);
    expect(calls).toBe(1);
    expect(huge.reads()).toBeLessThan(10);
  });

  test("rejects an object with more keys than the node limit before reading them", () => {
    let reads = 0;
    const keys = Array.from(
      { length: RUN_SPEC_INPUT_LIMITS.maxNodes + 1 },
      (_, index) => `k${index}`,
    );
    // Hidden keys are skipped without spending budget, so only the key count
    // can stop the walk early.
    const hidden = new Proxy(
      {},
      {
        ownKeys: () => keys,
        getOwnPropertyDescriptor() {
          reads += 1;
          return {
            value: 1,
            enumerable: false,
            configurable: true,
            writable: true,
          };
        },
      },
    );
    const spec: Loose = validSpec();
    spec.extensions = { "x-vendor": hidden };
    expectOne(run(spec), "RUN_SPEC_INPUT_TOO_LARGE", []);
    expect(reads).toBe(0);
  });

  test("counts a shared object once per place it appears", () => {
    const spec: Loose = validSpec();
    const block = new Array(1_000).fill(0);
    spec.extensions = { "x-vendor": new Array(300).fill(block) };
    expectOne(run(spec), "RUN_SPEC_INPUT_TOO_LARGE", []);
  });

  test("accepts a shared object that is small enough in every place", () => {
    const spec: Loose = validSpec();
    const qa = { id: "test", command: ["bun", "test"] };
    spec.gates.qa = [qa, { ...qa, id: "again" }];
    spec.extensions = { "x-a": { n: 1 }, "x-b": spec.lanes[0].agent };
    const result = run(spec);
    expect(result.issues).toEqual([]);
    expect(result.value?.extensions?.["x-b"]).toEqual(spec.lanes[0].agent);
  });

  test("still reports a long sparse array as not JSON", () => {
    const spec: Loose = validSpec();
    spec.env = [];
    spec.env.length = 4_000_000_000;
    expectOne(run(spec), "RUN_SPEC_INPUT_NOT_JSON", []);
  });

  test("reports a string longer than the input limit as too large, even as a key", () => {
    const longString: Loose = validSpec();
    longString.title = "a".repeat(RUN_SPEC_INPUT_LIMITS.maxStringLength + 1);
    expectOne(run(longString), "RUN_SPEC_INPUT_TOO_LARGE", []);
    const longKey: Loose = validSpec();
    longKey.extensions = {
      [`x-${"a".repeat(RUN_SPEC_INPUT_LIMITS.maxStringLength + 1)}`]: 1,
    };
    expectOne(run(longKey), "RUN_SPEC_INPUT_TOO_LARGE", []);
  });

  test("handles a huge array quickly and with one bounded issue", () => {
    const spec: Loose = validSpec();
    spec.lanes = new Array(200_000).fill(0);
    const started = performance.now();
    const result = run(spec);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(codes(result.issues)).toEqual(["RUN_SPEC_TOO_MANY_LANES"]);
    expect(result.issues[0]?.path).toEqual(["lanes"]);
  });

  test("handles a spec with ten thousand unknown keys without a long list", () => {
    const spec: Loose = validSpec();
    for (let i = 0; i < 10_000; i++) spec[`k${i}`] = i;
    const { issues, value } = run(spec);
    expect(value).toBeUndefined();
    expect(issues.length).toBeLessThanOrEqual(
      RUN_SPEC_MAX_UNKNOWN_KEYS_REPORTED + 1,
    );
  });

  test("does not throw on any primitive or odd root", () => {
    for (const input of [
      undefined,
      null,
      true,
      0,
      "text",
      [],
      [1, 2],
      {},
      Object.create(null),
      new Error("x"),
      /re/u,
    ]) {
      expect(() => run(input)).not.toThrow();
      const { value, issues } = run(input);
      expect(value).toBeUndefined();
      expect(issues.length).toBeGreaterThan(0);
    }
  });

  test("reports a non-object root as a wrong type at the root", () => {
    for (const input of [null, 42, "text", true, []]) {
      expectOne(run(input), "RUN_SPEC_INVALID_TYPE", []);
    }
  });
});

describe("parseRunSpecShape: array length pre-check", () => {
  /** A proxy over `target` whose `length` descriptor reports `length`. */
  function lyingLength(target: unknown[], length: unknown): unknown[] {
    return new Proxy(target, {
      getOwnPropertyDescriptor(inner, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(inner, key);
        return key === "length" ? { ...descriptor, value: length } : descriptor;
      },
    });
  }

  /** Counts the times the key list of `target` is asked for. */
  function countingKeys(target: unknown[]): {
    array: unknown[];
    listed: () => number;
  } {
    let listed = 0;
    const array = new Proxy(target, {
      ownKeys(inner) {
        listed += 1;
        return Reflect.ownKeys(inner);
      },
    });
    return { array, listed: () => listed };
  }

  test("an array that reports a length shorter than its items is not JSON, and its keys are never listed", () => {
    const { array, listed } = countingKeys(["CI", "NODE_ENV", "EXTRA"]);
    const lying = new Proxy(array, {
      getOwnPropertyDescriptor(inner, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(inner, key);
        return key === "length" ? { ...descriptor, value: 1 } : descriptor;
      },
    });
    const spec: Loose = validSpec();
    spec.env = lying;
    expectOne(run(spec), "RUN_SPEC_INPUT_NOT_JSON", []);
    expect(listed()).toBe(0);
  });

  test("an array whose length is not a safe integer is not JSON", () => {
    for (const length of [1.5, -1, Number.NaN, "1", 2 ** 53]) {
      const spec: Loose = validSpec();
      spec.env = lyingLength(["CI"], length);
      expectOne(run(spec), "RUN_SPEC_INPUT_NOT_JSON", []);
    }
  });

  test("a proxy over 5,000,000 items that reports length 1 or 1.5 is rejected without listing or reading its items", () => {
    const huge = new Array(5_000_000).fill(0);
    for (const length of [1, 1.5]) {
      let listed = 0;
      let itemReads = 0;
      const lying = lyingLength(huge, length);
      const counted = new Proxy(lying, {
        ownKeys(inner) {
          listed += 1;
          return Reflect.ownKeys(inner);
        },
        get(inner, key, receiver) {
          if (key !== "length") itemReads += 1;
          return Reflect.get(inner, key, receiver);
        },
      });
      const spec: Loose = validSpec();
      spec.env = counted;
      const { value } = run(spec);
      expect(value).toBeUndefined();
      expect({ listed, fewReads: itemReads < 10 }).toEqual({
        listed: 0,
        fewReads: true,
      });
    }
  });

  test("a plain array is still copied and accepted", () => {
    const spec: Loose = validSpec();
    spec.env = countingKeys(["CI"]).array;
    const { value, issues } = run(spec);
    expect(issues).toEqual([]);
    expect(value?.env).toEqual(["CI"]);
  });
});

describe("parseRunSpecShape: specVersion", () => {
  test("reports a missing, unknown or mistyped version with one issue at specVersion", () => {
    for (const edit of [
      (s: Loose) => delete s.specVersion,
      (s: Loose) => {
        s.specVersion = 2;
      },
      (s: Loose) => {
        s.specVersion = "1";
      },
      (s: Loose) => {
        s.specVersion = null;
      },
      (s: Loose) => {
        s.specVersion = 0;
      },
    ]) {
      expectOne(broken(edit), "RUN_SPEC_VERSION_UNSUPPORTED", ["specVersion"]);
    }
  });

  test("reports an empty object as an unsupported version, not as a list of missing keys", () => {
    expectOne(run({}), "RUN_SPEC_VERSION_UNSUPPORTED", ["specVersion"]);
  });
});

describe("parseRunSpecShape: missing keys", () => {
  test("reports each missing top-level key at its own path", () => {
    for (const key of [
      "workflowId",
      "workflowVersion",
      "projectRoot",
      "budget",
      "maxConcurrency",
      "lanes",
      "gates",
      "env",
    ]) {
      expectOne(
        broken((s) => delete s[key]),
        "RUN_SPEC_MISSING_KEY",
        [key],
      );
    }
  });

  test("reports missing keys deep in a lane", () => {
    for (const key of [
      "taskId",
      "title",
      "role",
      "dependsOn",
      "allowedPaths",
      "agent",
      "steps",
    ]) {
      expectOne(
        broken((s) => delete s.lanes[1][key]),
        "RUN_SPEC_MISSING_KEY",
        ["lanes", 1, key],
      );
    }
    for (const key of ["providerId", "model", "mode", "tools"]) {
      expectOne(
        broken((s) => delete s.lanes[0].agent[key]),
        "RUN_SPEC_MISSING_KEY",
        ["lanes", 0, "agent", key],
      );
    }
    expectOne(
      broken((s) => delete s.lanes[0].steps.testsFirst),
      "RUN_SPEC_MISSING_KEY",
      ["lanes", 0, "steps", "testsFirst"],
    );
    expectOne(
      broken((s) => delete s.lanes[0].steps.review),
      "RUN_SPEC_MISSING_KEY",
      ["lanes", 0, "steps", "review"],
    );
  });

  test("reports missing keys of reviews, gates, QA commands and budget", () => {
    expectOne(
      broken((s) => delete s.lanes[0].steps.review.maxChangeRounds),
      "RUN_SPEC_MISSING_KEY",
      ["lanes", 0, "steps", "review", "maxChangeRounds"],
    );
    expectOne(
      broken((s) => delete s.lanes[0].steps.review.model),
      "RUN_SPEC_MISSING_KEY",
      ["lanes", 0, "steps", "review", "model"],
    );
    expectOne(
      broken((s) => delete s.gates.qa),
      "RUN_SPEC_MISSING_KEY",
      ["gates", "qa"],
    );
    expectOne(
      broken((s) => delete s.gates.publish),
      "RUN_SPEC_MISSING_KEY",
      ["gates", "publish"],
    );
    expectOne(
      broken((s) => delete s.gates.publish.hitl),
      "RUN_SPEC_MISSING_KEY",
      ["gates", "publish", "hitl"],
    );
    expectOne(
      broken((s) => {
        s.gates.publish = { kind: "integration", hitl: true };
      }),
      "RUN_SPEC_MISSING_KEY",
      ["gates", "publish", "targetRef"],
    );
    expectOne(
      broken((s) => delete s.gates.qa[0].id),
      "RUN_SPEC_MISSING_KEY",
      ["gates", "qa", 0, "id"],
    );
    expectOne(
      broken((s) => delete s.gates.qa[0].command),
      "RUN_SPEC_MISSING_KEY",
      ["gates", "qa", 0, "command"],
    );
    expectOne(
      broken((s) => delete s.budget.maxUsd),
      "RUN_SPEC_MISSING_KEY",
      ["budget", "maxUsd"],
    );
  });

  test("reports one issue per missing key when several are missing", () => {
    const { issues } = broken((s) => {
      delete s.budget;
      delete s.env;
      delete s.lanes[0].title;
    });
    expect(issues.length).toBe(3);
    expect(has(issues, "RUN_SPEC_MISSING_KEY", ["budget"])).toBe(true);
    expect(has(issues, "RUN_SPEC_MISSING_KEY", ["env"])).toBe(true);
    expect(has(issues, "RUN_SPEC_MISSING_KEY", ["lanes", 0, "title"])).toBe(
      true,
    );
  });

  test("does not call an optional key missing", () => {
    const { issues } = broken((s) => {
      delete s.lanes[1].agent.allowNetwork;
      delete s.extensions;
    });
    expect(issues).toEqual([]);
  });
});

describe("parseRunSpecShape: unknown keys", () => {
  test("reports an unknown top-level key at its own path", () => {
    expectOne(
      broken((s) => {
        s.surprise = 1;
      }),
      "RUN_SPEC_UNKNOWN_KEY",
      ["surprise"],
    );
  });

  test("reports unknown keys in every nested object", () => {
    const { issues, value } = broken((s) => {
      s.lanes[0].extra = 1;
      s.lanes[0].agent.extra = 1;
      s.lanes[0].steps.extra = 1;
      s.lanes[0].steps.review.extra = 1;
      s.gates.extra = 1;
      s.gates.qa[0].extra = 1;
      s.gates.publish.extra = 1;
      s.budget.extra = 1;
    });
    expect(value).toBeUndefined();
    expect(issues.map((i) => i.path)).toEqual(
      expect.arrayContaining([
        ["lanes", 0, "extra"],
        ["lanes", 0, "agent", "extra"],
        ["lanes", 0, "steps", "extra"],
        ["lanes", 0, "steps", "review", "extra"],
        ["gates", "extra"],
        ["gates", "qa", 0, "extra"],
        ["gates", "publish", "extra"],
        ["budget", "extra"],
      ]),
    );
    expect(issues.length).toBe(8);
    expect(new Set(codes(issues))).toEqual(new Set(["RUN_SPEC_UNKNOWN_KEY"]));
  });

  test("reports one issue per unknown key, in sorted order", () => {
    const { issues } = broken((s) => {
      s.zeta = 1;
      s.alpha = 2;
      s.mid = 3;
    });
    expect(issues.map((i) => [i.code, i.path])).toEqual([
      ["RUN_SPEC_UNKNOWN_KEY", ["alpha"]],
      ["RUN_SPEC_UNKNOWN_KEY", ["mid"]],
      ["RUN_SPEC_UNKNOWN_KEY", ["zeta"]],
    ]);
  });

  test("reports only the first sixteen unknown keys of one object, in sorted order", () => {
    const { issues } = broken((s) => {
      for (let i = 0; i < 40; i++) s[`key${String(i).padStart(2, "0")}`] = i;
    });
    const unknown = issues.filter((i) => i.code === "RUN_SPEC_UNKNOWN_KEY");
    expect(unknown.length).toBe(RUN_SPEC_MAX_UNKNOWN_KEYS_REPORTED);
    expect(unknown.map((i) => i.path[0])).toEqual(
      Array.from(
        { length: RUN_SPEC_MAX_UNKNOWN_KEYS_REPORTED },
        (_, i) => `key${String(i).padStart(2, "0")}`,
      ),
    );
  });

  test("reports unknown keys that look dangerous without polluting prototypes", () => {
    const parsed = JSON.parse(
      JSON.stringify({ ...validSpec(), constructor: 1, prototype: 2 }).replace(
        "{",
        '{"__proto__":{"polluted":true},',
      ),
    );
    const { issues, value } = run(parsed);
    expect(value).toBeUndefined();
    expect(has(issues, "RUN_SPEC_UNKNOWN_KEY", ["__proto__"])).toBe(true);
    expect(has(issues, "RUN_SPEC_UNKNOWN_KEY", ["constructor"])).toBe(true);
    expect(has(issues, "RUN_SPEC_UNKNOWN_KEY", ["prototype"])).toBe(true);
    expect(({} as Loose).polluted).toBeUndefined();
  });

  test("reports the version key of a future version as unsupported, not as unknown keys", () => {
    const { issues } = broken((s) => {
      s.specVersion = 2;
      s.newField = true;
    });
    expect(codes(issues)).toEqual(["RUN_SPEC_VERSION_UNSUPPORTED"]);
  });

  test("rejects a key a publish kind does not define", () => {
    expectOne(
      broken((s) => {
        s.gates.publish = { kind: "none", hitl: true };
      }),
      "RUN_SPEC_UNKNOWN_KEY",
      ["gates", "publish", "hitl"],
    );
    expectOne(
      broken((s) => {
        s.lanes[0].steps.review = { kind: "none", model: "x" };
      }),
      "RUN_SPEC_UNKNOWN_KEY",
      ["lanes", 0, "steps", "review", "model"],
    );
  });

  test("rejects a key from the old spec design such as waves or id", () => {
    const { issues } = broken((s) => {
      s.waves = [];
      s.lanes[0].id = "api";
    });
    expect(has(issues, "RUN_SPEC_UNKNOWN_KEY", ["waves"])).toBe(true);
    expect(has(issues, "RUN_SPEC_UNKNOWN_KEY", ["lanes", 0, "id"])).toBe(true);
  });
});

describe("parseRunSpecShape: wrong types", () => {
  test("reports a wrong JSON type at the value's path", () => {
    const cases: [(s: Loose) => void, (string | number)[]][] = [
      [(s) => (s.workflowId = 1), ["workflowId"]],
      [(s) => (s.projectRoot = null), ["projectRoot"]],
      [(s) => (s.budget = "5"), ["budget"]],
      [(s) => (s.budget.maxUsd = "5"), ["budget", "maxUsd"]],
      [(s) => (s.maxConcurrency = "2"), ["maxConcurrency"]],
      [(s) => (s.lanes = {}), ["lanes"]],
      [(s) => (s.lanes[0] = "api"), ["lanes", 0]],
      [(s) => (s.lanes[0].dependsOn = "api"), ["lanes", 0, "dependsOn"]],
      [(s) => (s.lanes[0].dependsOn = [1]), ["lanes", 0, "dependsOn", 0]],
      [
        (s) => (s.lanes[0].allowedPaths = [null]),
        ["lanes", 0, "allowedPaths", 0],
      ],
      [(s) => (s.lanes[0].title = ["x"]), ["lanes", 0, "title"]],
      [
        (s) => (s.lanes[0].agent.allowNetwork = "no"),
        ["lanes", 0, "agent", "allowNetwork"],
      ],
      [
        (s) => (s.lanes[0].agent.tools = "Read"),
        ["lanes", 0, "agent", "tools"],
      ],
      [
        (s) => (s.lanes[0].steps.testsFirst = 1),
        ["lanes", 0, "steps", "testsFirst"],
      ],
      [(s) => (s.lanes[0].steps = []), ["lanes", 0, "steps"]],
      [(s) => (s.gates.qa = {}), ["gates", "qa"]],
      [
        (s) => (s.gates.qa[0].command = "bun test"),
        ["gates", "qa", 0, "command"],
      ],
      [(s) => (s.gates.publish.hitl = "yes"), ["gates", "publish", "hitl"]],
      [(s) => (s.env = "CI"), ["env"]],
      [(s) => (s.env = [7]), ["env", 0]],
      [(s) => (s.extensions = []), ["extensions"]],
    ];
    for (const [edit, path] of cases) {
      expectOne(broken(edit), "RUN_SPEC_INVALID_TYPE", path);
    }
  });

  test("reports a number that must be an integer and is not as a wrong type", () => {
    expectOne(
      broken((s) => (s.maxConcurrency = 1.5)),
      "RUN_SPEC_INVALID_TYPE",
      ["maxConcurrency"],
    );
    expectOne(
      broken((s) => (s.lanes[0].steps.review.maxChangeRounds = 0.5)),
      "RUN_SPEC_INVALID_TYPE",
      ["lanes", 0, "steps", "review", "maxChangeRounds"],
    );
  });

  test("reports an undefined value as missing, a wrong type or not JSON, but never throws", () => {
    const { value, issues } = broken((s) => {
      s.budget = undefined;
    });
    expect(value).toBeUndefined();
    expect(issues.length).toBeGreaterThan(0);
  });

  test("reports a key whose value is null as a wrong type, not as missing", () => {
    expectOne(
      broken((s) => (s.budget = null)),
      "RUN_SPEC_INVALID_TYPE",
      ["budget"],
    );
  });
});

describe("parseRunSpecShape: allowed values", () => {
  test("reports a role outside the roles", () => {
    expectOne(
      broken((s) => (s.lanes[0].role = "boss")),
      "RUN_SPEC_INVALID_VALUE",
      ["lanes", 0, "role"],
    );
  });

  test("reports a permission mode outside the modes, but accepts each real one", () => {
    expectOne(
      broken((s) => (s.lanes[0].agent.mode = "root")),
      "RUN_SPEC_INVALID_VALUE",
      ["lanes", 0, "agent", "mode"],
    );
    for (const mode of ["read-only", "ask", "workspace-write", "full-access"]) {
      expect(broken((s) => (s.lanes[0].agent.mode = mode)).issues).toEqual([]);
    }
    for (const role of ["architect", "worker", "integration", "critic"]) {
      expect(broken((s) => (s.lanes[0].role = role)).issues).toEqual([]);
    }
  });

  test("reports an unknown review kind at the kind path", () => {
    expectOne(
      broken((s) => (s.lanes[0].steps.review = { kind: "human" })),
      "RUN_SPEC_INVALID_VALUE",
      ["lanes", 0, "steps", "review", "kind"],
    );
  });

  test("reports a review without a kind as a bad kind", () => {
    expectOne(
      broken((s) => (s.lanes[0].steps.review = {})),
      "RUN_SPEC_INVALID_VALUE",
      ["lanes", 0, "steps", "review", "kind"],
    );
  });

  test("reports an unknown publish kind, including merge, at the kind path", () => {
    for (const kind of ["push", "merge", "", "COMMIT"]) {
      expectOne(
        broken((s) => (s.gates.publish = { kind })),
        "RUN_SPEC_INVALID_VALUE",
        ["gates", "publish", "kind"],
      );
    }
  });

  test("reports a publish or review whose kind is not a string", () => {
    expectOne(
      broken((s) => (s.gates.publish = { kind: 1 })),
      "RUN_SPEC_INVALID_VALUE",
      ["gates", "publish", "kind"],
    );
    expectOne(
      broken((s) => (s.lanes[1].steps.review = { kind: null })),
      "RUN_SPEC_INVALID_VALUE",
      ["lanes", 1, "steps", "review", "kind"],
    );
  });
});

describe("parseRunSpecShape: formats", () => {
  test("reports identifiers that fail their pattern", () => {
    const cases: [(s: Loose) => void, (string | number)[]][] = [
      [(s) => (s.workflowId = "has space"), ["workflowId"]],
      [(s) => (s.workflowVersion = "-1"), ["workflowVersion"]],
      [(s) => (s.lanes[0].taskId = "bad id"), ["lanes", 0, "taskId"]],
      [(s) => (s.lanes[0].taskId = "../x"), ["lanes", 0, "taskId"]],
      [(s) => (s.lanes[0].dependsOn = ["a b"]), ["lanes", 0, "dependsOn", 0]],
      [
        (s) => (s.lanes[0].agent.providerId = "claude code"),
        ["lanes", 0, "agent", "providerId"],
      ],
      [
        (s) => (s.lanes[0].agent.model = "gpt 5"),
        ["lanes", 0, "agent", "model"],
      ],
      [
        (s) => (s.lanes[0].agent.tools = ["Read file"]),
        ["lanes", 0, "agent", "tools", 0],
      ],
      [
        (s) => (s.lanes[0].steps.review.providerId = "a b"),
        ["lanes", 0, "steps", "review", "providerId"],
      ],
      [
        (s) => (s.lanes[0].steps.review.model = "a b"),
        ["lanes", 0, "steps", "review", "model"],
      ],
      [(s) => (s.gates.qa[0].id = "a b"), ["gates", "qa", 0, "id"]],
      [
        (s) => (s.gates.qa[0].command = ["bun\u0000"]),
        ["gates", "qa", 0, "command", 0],
      ],
      [
        (s) => (s.gates.qa[0].command = ["bun", "a\nb"]),
        ["gates", "qa", 0, "command", 1],
      ],
      [(s) => (s.env = ["1BAD"]), ["env", 0]],
      [(s) => (s.env = ["A-B"]), ["env", 0]],
    ];
    for (const [edit, path] of cases) {
      expectOne(broken(edit), "RUN_SPEC_INVALID_FORMAT", path);
    }
  });

  test("reports a target ref that fails the opaque pattern", () => {
    expectOne(
      broken((s) => {
        s.gates.publish = { kind: "integration", hitl: true, targetRef: "a b" };
      }),
      "RUN_SPEC_INVALID_FORMAT",
      ["gates", "publish", "targetRef"],
    );
  });

  test("reports a target ref that is not a valid git ref name", () => {
    for (const targetRef of [
      "refs/heads/../../config",
      "main:refs/heads/prod",
      "refs//heads/main",
      "refs/heads/.hidden",
      "refs/heads/main.lock",
      "refs/heads/main/",
      "refs/heads/main.",
    ]) {
      expectOne(
        broken((s) => {
          s.gates.publish = { kind: "integration", hitl: true, targetRef };
        }),
        "RUN_SPEC_INVALID_FORMAT",
        ["gates", "publish", "targetRef"],
      );
    }
  });

  test("accepts target refs that are valid git ref names", () => {
    for (const targetRef of [
      "main",
      "refs/heads/main",
      "refs/heads/release-1.2",
      "refs/heads/feature/a.b_c+d",
    ]) {
      const { issues } = broken((s) => {
        s.gates.publish = { kind: "integration", hitl: true, targetRef };
      });
      expect(issues).toEqual([]);
    }
  });

  test("reports an environment entry that holds a value, and never echoes it", () => {
    const { issues } = broken((s) => (s.env = ["TOKEN=sk-secret-123"]));
    expect(codes(issues)).toEqual(["RUN_SPEC_INVALID_FORMAT"]);
    expect(issues[0]?.path).toEqual(["env", 0]);
    expect(issues[0]?.message).not.toContain("sk-secret-123");
    expect(issues[0]?.message).not.toContain("TOKEN=");
  });

  test("keeps both a length issue and a format issue for one string", () => {
    const { issues } = broken((s) => (s.lanes[0].taskId = ""));
    expect(codes(issues).sort()).toEqual([
      "RUN_SPEC_INVALID_FORMAT",
      "RUN_SPEC_STRING_TOO_SHORT",
    ]);
    expect(
      issues.every((i) => JSON.stringify(i.path) === '["lanes",0,"taskId"]'),
    ).toBe(true);
    const long = broken(
      (s) => (s.lanes[0].taskId = `a b${"x".repeat(300)}`),
    ).issues;
    expect(codes(long).sort()).toEqual([
      "RUN_SPEC_INVALID_FORMAT",
      "RUN_SPEC_STRING_TOO_LONG",
    ]);
  });
});

describe("parseRunSpecShape: strings", () => {
  test("reports empty strings as too short", () => {
    for (const [edit, path] of [
      [(s: Loose) => (s.lanes[0].title = ""), ["lanes", 0, "title"]],
      [(s: Loose) => (s.projectRoot = ""), ["projectRoot"]],
      [
        (s: Loose) => (s.lanes[0].allowedPaths = [""]),
        ["lanes", 0, "allowedPaths", 0],
      ],
    ] as const) {
      expectOne(broken(edit), "RUN_SPEC_STRING_TOO_SHORT", [...path]);
    }
  });

  test("reports strings above their hard limit as too long", () => {
    expectOne(
      broken(
        (s) =>
          (s.lanes[0].title = "t".repeat(RUN_SPEC_LIMITS.maxTitleLength + 1)),
      ),
      "RUN_SPEC_STRING_TOO_LONG",
      ["lanes", 0, "title"],
    );
    expectOne(
      broken(
        (s) => (s.projectRoot = "p".repeat(RUN_SPEC_LIMITS.maxPathLength + 1)),
      ),
      "RUN_SPEC_STRING_TOO_LONG",
      ["projectRoot"],
    );
    expectOne(
      broken(
        (s) =>
          (s.lanes[0].allowedPaths[0] = "p".repeat(
            RUN_SPEC_LIMITS.maxPathLength + 1,
          )),
      ),
      "RUN_SPEC_STRING_TOO_LONG",
      ["lanes", 0, "allowedPaths", 0],
    );
    expectOne(
      broken(
        (s) =>
          (s.gates.qa[0].command = [
            "a".repeat(RUN_SPEC_LIMITS.maxCommandArgLength + 1),
          ]),
      ),
      "RUN_SPEC_STRING_TOO_LONG",
      ["gates", "qa", 0, "command", 0],
    );
  });

  test("counts code points, as JSON Schema does, so an emoji is one character", () => {
    const emoji = (count: number) => "\u{1F600}".repeat(count);
    const title = RUN_SPEC_LIMITS.maxTitleLength;
    expect(broken((s) => (s.lanes[0].title = emoji(title))).issues).toEqual([]);
    expectOne(
      broken((s) => (s.lanes[0].title = emoji(title + 1))),
      "RUN_SPEC_STRING_TOO_LONG",
      ["lanes", 0, "title"],
    );
    const arg = RUN_SPEC_LIMITS.maxCommandArgLength;
    expect(
      broken((s) => (s.gates.qa[0].command = ["bun", emoji(arg)])).issues,
    ).toEqual([]);
    expectOne(
      broken((s) => (s.gates.qa[0].command = ["bun", emoji(arg + 1)])),
      "RUN_SPEC_STRING_TOO_LONG",
      ["gates", "qa", 0, "command", 1],
    );
    const path = RUN_SPEC_LIMITS.maxPathLength;
    expect(
      broken((s) => (s.lanes[0].allowedPaths[0] = `s/${emoji(path - 2)}`))
        .issues,
    ).toEqual([]);
    expectOne(
      broken((s) => (s.lanes[0].allowedPaths[0] = `s/${emoji(path - 1)}`)),
      "RUN_SPEC_STRING_TOO_LONG",
      ["lanes", 0, "allowedPaths", 0],
    );
  });

  test("counts a lone surrogate as one character", () => {
    const title = `${"t".repeat(RUN_SPEC_LIMITS.maxTitleLength - 1)}\ud800`;
    expect(broken((s) => (s.lanes[0].title = title)).issues).toEqual([]);
  });

  test("accepts strings exactly at their limit", () => {
    const { issues } = broken((s) => {
      s.lanes[0].title = "t".repeat(RUN_SPEC_LIMITS.maxTitleLength);
      s.gates.qa[0].command = ["a".repeat(RUN_SPEC_LIMITS.maxCommandArgLength)];
    });
    expect(issues).toEqual([]);
  });

  test("does not judge path content: the paths family does", () => {
    const { issues } = broken((s) => {
      s.projectRoot = "/abs";
      s.lanes[0].allowedPaths = ["../x", "a\\b", "src//", "."];
    });
    expect(issues).toEqual([]);
  });
});

describe("parseRunSpecShape: arrays", () => {
  test("reports empty lanes and empty QA command as too short", () => {
    expectOne(
      broken((s) => (s.lanes = [])),
      "RUN_SPEC_ARRAY_TOO_SHORT",
      ["lanes"],
    );
    expectOne(
      broken((s) => (s.gates.qa[0].command = [])),
      "RUN_SPEC_ARRAY_TOO_SHORT",
      ["gates", "qa", 0, "command"],
    );
  });

  test("reports arrays above their hard limit as too long", () => {
    const cases: [(s: Loose) => void, (string | number)[]][] = [
      [
        (s) =>
          (s.lanes[0].agent.tools = Array.from(
            { length: RUN_SPEC_LIMITS.maxTools + 1 },
            (_, i) => `t${i}`,
          )),
        ["lanes", 0, "agent", "tools"],
      ],
      [
        (s) =>
          (s.lanes[0].allowedPaths = Array.from(
            { length: RUN_SPEC_LIMITS.maxAllowedPaths + 1 },
            (_, i) => `p${i}`,
          )),
        ["lanes", 0, "allowedPaths"],
      ],
      [
        (s) =>
          (s.env = Array.from(
            { length: RUN_SPEC_LIMITS.maxEnvNames + 1 },
            (_, i) => `E${i}`,
          )),
        ["env"],
      ],
      [
        (s) =>
          (s.gates.qa = Array.from(
            { length: RUN_SPEC_LIMITS.maxQaCommands + 1 },
            (_, i) => ({ id: `q${i}`, command: ["a"] }),
          )),
        ["gates", "qa"],
      ],
      [
        (s) =>
          (s.gates.qa[0].command = Array.from(
            { length: RUN_SPEC_LIMITS.maxCommandArgs + 1 },
            () => "a",
          )),
        ["gates", "qa", 0, "command"],
      ],
    ];
    for (const [edit, path] of cases) {
      expectOne(broken(edit), "RUN_SPEC_ARRAY_TOO_LONG", path);
    }
  });

  test("reports too many lanes with its own code and does not read the lanes", () => {
    const { issues, value } = broken((s) => {
      s.lanes = Array.from(
        { length: RUN_SPEC_LIMITS.maxLanes + 1 },
        () => ({}),
      );
    });
    expect(value).toBeUndefined();
    expect(issues.map((i) => [i.code, i.path])).toEqual([
      ["RUN_SPEC_TOO_MANY_LANES", ["lanes"]],
    ]);
  });

  test("reports too many dependencies with its own code", () => {
    expectOne(
      broken((s) => {
        s.lanes[1].dependsOn = Array.from(
          { length: RUN_SPEC_LIMITS.maxDependsOn + 1 },
          (_, i) => `l${i}`,
        );
      }),
      "RUN_SPEC_TOO_MANY_DEPENDENCIES",
      ["lanes", 1, "dependsOn"],
    );
  });

  test("accepts arrays exactly at their limit", () => {
    const { issues } = broken((s) => {
      s.lanes[0].agent.tools = Array.from(
        { length: RUN_SPEC_LIMITS.maxTools },
        (_, i) => `t${i}`,
      );
      s.lanes[1].dependsOn = Array.from(
        { length: RUN_SPEC_LIMITS.maxDependsOn },
        (_, i) => `l${i}`,
      );
    });
    expect(issues).toEqual([]);
  });

  test("reports each bad item of an array at its own index", () => {
    const { issues } = broken((s) => (s.env = ["OK", "1x", "fine", "a-b"]));
    expect(issues.map((i) => [i.code, i.path])).toEqual([
      ["RUN_SPEC_INVALID_FORMAT", ["env", 1]],
      ["RUN_SPEC_INVALID_FORMAT", ["env", 3]],
    ]);
  });
});

describe("parseRunSpecShape: numbers", () => {
  test("reports numbers outside their range", () => {
    const cases: [(s: Loose) => void, (string | number)[]][] = [
      [(s) => (s.budget.maxUsd = 0), ["budget", "maxUsd"]],
      [(s) => (s.budget.maxUsd = -1), ["budget", "maxUsd"]],
      [
        (s) => (s.budget.maxUsd = RUN_SPEC_LIMITS.maxBudgetUsd + 1),
        ["budget", "maxUsd"],
      ],
      [(s) => (s.maxConcurrency = 0), ["maxConcurrency"]],
      [
        (s) => (s.maxConcurrency = RUN_SPEC_LIMITS.maxConcurrency + 1),
        ["maxConcurrency"],
      ],
      [
        (s) => (s.lanes[0].steps.review.maxChangeRounds = -1),
        ["lanes", 0, "steps", "review", "maxChangeRounds"],
      ],
      [
        (s) =>
          (s.lanes[0].steps.review.maxChangeRounds =
            RUN_SPEC_LIMITS.maxChangeRounds + 1),
        ["lanes", 0, "steps", "review", "maxChangeRounds"],
      ],
    ];
    for (const [edit, path] of cases) {
      expectOne(broken(edit), "RUN_SPEC_NUMBER_OUT_OF_RANGE", path);
    }
  });

  test("accepts numbers at the edges of their range", () => {
    const { issues } = broken((s) => {
      s.budget.maxUsd = RUN_SPEC_LIMITS.maxBudgetUsd;
      s.maxConcurrency = 1;
      s.lanes[0].steps.review.maxChangeRounds = 0;
    });
    expect(issues).toEqual([]);
    const tiny = broken((s) => (s.budget.maxUsd = 0.000001));
    expect(tiny.issues).toEqual([]);
    expect(
      broken((s) => (s.maxConcurrency = RUN_SPEC_LIMITS.maxConcurrency)).issues,
    ).toEqual([]);
  });
});

describe("parseRunSpecShape: extensions", () => {
  test("reports a key that is not of the form x-vendor", () => {
    for (const key of [
      "foo",
      "x-",
      "x-Foo",
      "X-foo",
      "x_foo",
      "x-a--b",
      "x-a b",
    ]) {
      const { issues, value } = broken((s) => (s.extensions = { [key]: 1 }));
      expect(value).toBeUndefined();
      expect(codes(issues)).toEqual(["RUN_SPEC_EXTENSION_KEY_INVALID"]);
      expect(issues[0]?.path[0]).toBe("extensions");
    }
  });

  test("reports bad keys on a lane's extensions too", () => {
    const { issues } = broken((s) => (s.lanes[0].extensions = { nope: 1 }));
    expect(codes(issues)).toEqual(["RUN_SPEC_EXTENSION_KEY_INVALID"]);
    expect(issues[0]?.path.slice(0, 3)).toEqual(["lanes", 0, "extensions"]);
  });

  test("reports each bad key separately and keeps good ones quiet", () => {
    const { issues } = broken(
      (s) => (s.extensions = { "x-ok": 1, a: 2, b: 3 }),
    );
    expect(codes(issues)).toEqual([
      "RUN_SPEC_EXTENSION_KEY_INVALID",
      "RUN_SPEC_EXTENSION_KEY_INVALID",
    ]);
  });

  test("reports an own __proto__ key on the spec and on a lane", () => {
    const onSpec = broken(
      (s) => (s.extensions = JSON.parse('{"__proto__":{"polluted":true}}')),
    );
    expect(onSpec.value).toBeUndefined();
    expect(codes(onSpec.issues)).toEqual(["RUN_SPEC_EXTENSION_KEY_INVALID"]);
    expect(onSpec.issues[0]?.path).toEqual(["extensions", "__proto__"]);
    const onLane = broken((s) => {
      s.lanes[0].extensions = JSON.parse('{"x-ok":1,"__proto__":{}}');
    });
    expect(codes(onLane.issues)).toEqual(["RUN_SPEC_EXTENSION_KEY_INVALID"]);
    expect(onLane.issues[0]?.path).toEqual([
      "lanes",
      0,
      "extensions",
      "__proto__",
    ]);
  });

  test("reports a __proto__ key next to other shape issues", () => {
    const { issues } = broken((s) => {
      s.extensions = JSON.parse('{"__proto__":1}');
      s.title = 1;
    });
    expect(codes(issues)).toContain("RUN_SPEC_EXTENSION_KEY_INVALID");
  });

  test("accepts any JSON value under a good key", () => {
    const { issues } = broken((s) => {
      s.extensions = { "x-a": null, "x-b": [1, { c: "d" }], "x-c-d": "text" };
    });
    expect(issues).toEqual([]);
  });
});

describe("parseRunSpecShape: issues", () => {
  test("reports one issue per problem, in schema order, all valid issues of the shape family", () => {
    const { issues, value } = broken((s) => {
      s.workflowId = "bad id";
      s.budget.maxUsd = 0;
      s.lanes[0].role = "boss";
      s.lanes[1].extra = true;
      delete s.gates.qa;
    });
    expect(value).toBeUndefined();
    expect(issues.length).toBe(5);
    expect(new Set(issues.map((i) => JSON.stringify(i.path))).size).toBe(5);
    for (const issue of issues) {
      expect(RunSpecIssueSchema.safeParse(issue).success).toBe(true);
      expect(RUN_SPEC_ISSUE_FAMILIES[issue.code]).toBe("shape");
    }
  });

  test("every message is clear, bounded and never echoes the offending value", () => {
    const secret = "SECRET-VALUE-9f3a";
    const { issues } = broken((s) => {
      s.workflowId = `${secret} bad`;
      s.lanes[0].taskId = `${secret} id`;
      s.lanes[0].role = secret;
      s.lanes[0].agent.mode = secret;
      s.gates.publish = { kind: secret };
      s.env = [`${secret}=1`];
      s.extensions = { [secret]: 1 };
      s.surprise = secret;
      s[secret] = 1;
      s.maxConcurrency = secret;
    });
    expect(issues.length).toBeGreaterThanOrEqual(9);
    for (const issue of issues) {
      expect(issue.message.length).toBeGreaterThan(0);
      expect(issue.message.length).toBeLessThanOrEqual(
        RUN_SPEC_MAX_ISSUE_MESSAGE_LENGTH,
      );
      expect(issue.message).not.toContain(secret);
    }
  });

  test("messages differ for different problems so a person can tell them apart", () => {
    const missing = broken((s) => delete s.budget).issues[0]?.message;
    const unknown = broken((s) => (s.zzz = 1)).issues[0]?.message;
    const type = broken((s) => (s.budget = 1)).issues[0]?.message;
    expect(new Set([missing, unknown, type]).size).toBe(3);
  });

  test("path segments are plain strings and non-negative integers", () => {
    const { issues } = broken((s) => {
      s.lanes[1].agent.tools = [1];
      s.env = ["ok", 2];
    });
    for (const issue of issues) {
      for (const segment of issue.path) {
        expect(
          typeof segment === "string" ||
            (Number.isInteger(segment) && segment >= 0),
        ).toBe(true);
      }
    }
  });

  test("keeps the list bounded when thousands of lanes each have several faults", () => {
    const spec: Loose = wideSpec(1_000);
    for (const lane of spec.lanes) {
      lane.extra = 1;
      lane.role = "boss";
      delete lane.title;
    }
    const started = performance.now();
    expect(() => run(spec)).not.toThrow();
    expect(performance.now() - started).toBeLessThan(5_000);
    const { issues } = run(spec);
    for (const issue of issues) {
      expect(issue.message.length).toBeLessThanOrEqual(
        RUN_SPEC_MAX_ISSUE_MESSAGE_LENGTH,
      );
    }
    expect(issues.length).toBeGreaterThanOrEqual(3_000);
  });
});
