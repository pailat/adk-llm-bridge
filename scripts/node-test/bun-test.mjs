/**
 * The part of `bun:test` the repository's suites use, on top of `node:test`,
 * for `scripts/node-test.mjs`. Semantics follow Bun where they differ from
 * Jest: `toEqual` ignores properties whose value is `undefined`, and `spyOn`
 * calls through until given an implementation. An unsupported matcher throws.
 */

import { createRequire, isBuiltin, syncBuiltinESMExports } from "node:module";
import {
  after,
  before,
  afterEach as nodeAfterEach,
  beforeEach as nodeBeforeEach,
  describe as nodeDescribe,
  it as nodeIt,
} from "node:test";
import { inspect, isDeepStrictEqual } from "node:util";

// Bun's default is 5 s. Under Node every child process a test starts loads
// the TypeScript sources through the hooks, which is several times slower.
const DEFAULT_TIMEOUT_MS = 30_000;

// --- test structure -------------------------------------------------------

function formatName(name, args, index) {
  const row = args.length === 1 ? args[0] : undefined;
  let position = 0;
  let text = name.replace(/%[sdifjop#%]/gu, (token) => {
    if (token === "%%") return "%";
    if (token === "%#") return String(index);
    const value = args[position++];
    return token === "%s" ? String(value) : inspect(value);
  });
  if (row !== null && typeof row === "object" && !Array.isArray(row)) {
    text = text.replace(/\$([A-Za-z_][\w.]*)/gu, (_, path) =>
      String(path.split(".").reduce((value, key) => value?.[key], row)),
    );
  }
  return text;
}

function rowArgs(row) {
  return Array.isArray(row) ? row : [row];
}

function makeTest(options = {}) {
  const run = (name, fn, timeout) => {
    const settings = {
      timeout: typeof timeout === "number" ? timeout : DEFAULT_TIMEOUT_MS,
      skip: options.skip,
      todo: options.todo,
    };
    return nodeIt(name, settings, fn ? async () => await fn() : undefined);
  };
  run.skip = (name, fn) => makeTest({ skip: true })(name, fn);
  run.todo = (name, fn) => makeTest({ todo: true })(name, fn);
  run.only = run;
  run.if = (condition) =>
    makeTest({ ...options, skip: !condition || options.skip });
  run.skipIf = (condition) =>
    makeTest({ ...options, skip: Boolean(condition) || options.skip });
  run.each = (table) => (name, fn, timeout) => {
    table.forEach((row, index) => {
      const args = rowArgs(row);
      run(formatName(name, args, index), () => fn(...args), timeout);
    });
  };
  return run;
}

function makeDescribe(options = {}) {
  const run = (name, fn) => nodeDescribe(name, { skip: options.skip }, fn);
  run.skip = (name, fn) => makeDescribe({ skip: true })(name, fn);
  run.only = run;
  run.if = (condition) => makeDescribe({ skip: !condition || options.skip });
  run.skipIf = (condition) =>
    makeDescribe({ skip: Boolean(condition) || options.skip });
  run.each = (table) => (name, fn) => {
    table.forEach((row, index) => {
      const args = rowArgs(row);
      run(formatName(name, args, index), () => fn(...args));
    });
  };
  return run;
}

export const test = makeTest();
export const it = test;
export const describe = makeDescribe();
export const beforeAll = (fn) => before(async () => await fn());
export const afterAll = (fn) => after(async () => await fn());
export const beforeEach = (fn) => nodeBeforeEach(async () => await fn());
export const afterEach = (fn) => nodeAfterEach(async () => await fn());

// --- mocks ----------------------------------------------------------------

function mockFunction(implementation) {
  let current = implementation;
  const calls = [];
  const results = [];
  const fn = function (...args) {
    calls.push(args);
    const value = current?.apply(this, args);
    results.push({ type: "return", value });
    return value;
  };
  fn.mock = { calls, results };
  fn.mockImplementation = (next) => {
    current = next;
    return fn;
  };
  fn.mockReturnValue = (value) => fn.mockImplementation(() => value);
  fn.mockClear = () => {
    calls.length = 0;
    results.length = 0;
    return fn;
  };
  fn._isMockFunction = true;
  return fn;
}

export function mock(implementation) {
  return mockFunction(implementation ?? (() => undefined));
}

// Bun's `mock.module` for builtin modules: the replacement is written onto the
// module itself and pushed to every ESM import of it, so code imported before
// or after sees it, as under Bun. Unlike Bun, Node's own use of the module
// sees it too (the module loader reads source files through `fs`), so a
// replacement must fault only on the paths the test is about. A value equal
// to the current one is left alone (some, such as `fs.promises`, cannot be
// assigned).
const requireBuiltin = createRequire(import.meta.url);
mock.module = (name, factory) => {
  if (!isBuiltin(name)) {
    throw new Error(
      `node-test: mock.module supports builtin modules only: ${name}`,
    );
  }
  const value = factory();
  if (value && typeof value.then === "function") {
    throw new Error("node-test: mock.module needs a synchronous factory");
  }
  const target = requireBuiltin(name);
  for (const [key, replacement] of Object.entries(value)) {
    if (target[key] !== replacement) target[key] = replacement;
  }
  syncBuiltinESMExports();
};
mock.restore = () => {};

export function spyOn(object, key) {
  const original = object[key];
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  const spy = mockFunction(function (...args) {
    return original.apply(this, args);
  });
  spy.mockRestore = () => {
    if (descriptor) Object.defineProperty(object, key, descriptor);
    else delete object[key];
  };
  Object.defineProperty(object, key, {
    configurable: true,
    writable: true,
    value: spy,
  });
  return spy;
}

export const jest = { fn: mock };

// --- equality -------------------------------------------------------------

class Asymmetric {
  constructor(match, label) {
    this.match = match;
    this.label = label;
  }
  [inspect.custom]() {
    return this.label;
  }
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object";
}

/** Bun's `toEqual`: recursive, `undefined` properties ignored, no type check. */
function equals(actual, expected, subset = false) {
  if (expected instanceof Asymmetric) return expected.match(actual);
  if (Object.is(actual, expected)) return true;
  if (!isPlainRecord(actual) || !isPlainRecord(expected)) return false;
  if (expected instanceof Date || actual instanceof Date) {
    return (
      actual instanceof Date &&
      expected instanceof Date &&
      actual.getTime() === expected.getTime()
    );
  }
  if (expected instanceof RegExp || actual instanceof RegExp) {
    return String(actual) === String(expected);
  }
  if (expected instanceof Error && actual instanceof Error) {
    if (actual.message !== expected.message || actual.name !== expected.name) {
      return false;
    }
  }
  if (ArrayBuffer.isView(actual) || ArrayBuffer.isView(expected)) {
    return isDeepStrictEqual(actual, expected);
  }
  if (expected instanceof Map || actual instanceof Map) {
    if (!(expected instanceof Map && actual instanceof Map)) return false;
    if (!subset && actual.size !== expected.size) return false;
    for (const [key, value] of expected) {
      if (!actual.has(key) || !equals(actual.get(key), value, subset))
        return false;
    }
    return true;
  }
  if (expected instanceof Set || actual instanceof Set) {
    if (!(expected instanceof Set && actual instanceof Set)) return false;
    if (actual.size !== expected.size) return false;
    for (const value of expected) {
      if (![...actual].some((item) => equals(item, value, subset)))
        return false;
    }
    return true;
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!(Array.isArray(expected) && Array.isArray(actual))) return false;
    if (actual.length !== expected.length) return false;
    return expected.every((value, index) =>
      equals(actual[index], value, subset),
    );
  }
  const keys = new Set(
    Object.keys(expected).filter((key) => expected[key] !== undefined),
  );
  if (!subset) {
    for (const key of Object.keys(actual)) {
      if (actual[key] !== undefined) keys.add(key);
    }
  }
  for (const key of keys) {
    if (subset && !(key in Object(actual))) return false;
    if (!equals(actual[key], expected[key], subset)) return false;
  }
  return true;
}

// --- expect ---------------------------------------------------------------

function show(value) {
  return inspect(value, { depth: 8, breakLength: 100 });
}

function propertyPath(path) {
  return Array.isArray(path) ? path : String(path).split(".");
}

function thrownMatches(error, expected) {
  if (expected === undefined) return true;
  const message = error?.message ?? String(error);
  if (typeof expected === "string") return message.includes(expected);
  if (expected instanceof RegExp) return expected.test(message);
  if (typeof expected === "function") return error instanceof expected;
  if (expected instanceof Error) return message === expected.message;
  return equals(error, expected, true);
}

const MATCHERS = {
  toBe: (actual, expected) => [
    Object.is(actual, expected),
    `to be ${show(expected)}`,
  ],
  toEqual: (actual, expected) => [
    equals(actual, expected),
    `to equal ${show(expected)}`,
  ],
  toStrictEqual: (actual, expected) => [
    isDeepStrictEqual(actual, expected),
    `to strictly equal ${show(expected)}`,
  ],
  toMatchObject: (actual, expected) => [
    isPlainRecord(actual) && equals(actual, expected, true),
    `to match object ${show(expected)}`,
  ],
  toBeUndefined: (actual) => [actual === undefined, "to be undefined"],
  toBeDefined: (actual) => [actual !== undefined, "to be defined"],
  toBeNull: (actual) => [actual === null, "to be null"],
  toBeTruthy: (actual) => [Boolean(actual), "to be truthy"],
  toBeFalsy: (actual) => [!actual, "to be falsy"],
  toBeNaN: (actual) => [Number.isNaN(actual), "to be NaN"],
  toBeArray: (actual) => [Array.isArray(actual), "to be an array"],
  toBeTypeOf: (actual, type) => [
    typeof actual === type,
    `to be of type ${type}`,
  ],
  toBeInstanceOf: (actual, type) => [
    actual instanceof type,
    `to be an instance of ${type?.name}`,
  ],
  toBeGreaterThan: (actual, n) => [actual > n, `to be > ${n}`],
  toBeGreaterThanOrEqual: (actual, n) => [actual >= n, `to be >= ${n}`],
  toBeLessThan: (actual, n) => [actual < n, `to be < ${n}`],
  toBeLessThanOrEqual: (actual, n) => [actual <= n, `to be <= ${n}`],
  toHaveLength: (actual, n) => [actual?.length === n, `to have length ${n}`],
  toContain: (actual, item) => [
    typeof actual === "string"
      ? actual.includes(item)
      : [...(actual ?? [])].some((value) => Object.is(value, item)),
    `to contain ${show(item)}`,
  ],
  toContainEqual: (actual, item) => [
    [...(actual ?? [])].some((value) => equals(value, item)),
    `to contain equal ${show(item)}`,
  ],
  toMatch: (actual, pattern) => [
    typeof actual === "string" &&
      (pattern instanceof RegExp
        ? pattern.test(actual)
        : actual.includes(pattern)),
    `to match ${show(pattern)}`,
  ],
  toHaveProperty: (actual, path, ...value) => {
    let current = actual;
    for (const key of propertyPath(path)) {
      if (
        current === null ||
        current === undefined ||
        !(key in Object(current))
      ) {
        return [false, `to have property ${show(path)}`];
      }
      current = current[key];
    }
    return value.length === 0
      ? [true, `to have property ${show(path)}`]
      : [
          equals(current, value[0]),
          `to have property ${show(path)} = ${show(value[0])}`,
        ];
  },
  toHaveBeenCalled: (actual) => [
    actual.mock.calls.length > 0,
    "to have been called",
  ],
  toHaveBeenCalledTimes: (actual, n) => [
    actual.mock.calls.length === n,
    `to have been called ${n} times`,
  ],
  toHaveBeenCalledWith: (actual, ...args) => [
    actual.mock.calls.some((call) => equals(call, args)),
    `to have been called with ${show(args)}`,
  ],
};

function assertion(actual, negate, label) {
  return new Proxy(
    {},
    {
      get(_, name) {
        if (name === "not") return assertion(actual, !negate, label);
        if (name === "then") return undefined;
        if (name === "toThrow" || name === "toThrowError") {
          return (expected) => {
            let threw = false;
            let error;
            if (label === "rejects") {
              threw = true;
              error = actual;
            } else {
              try {
                actual();
              } catch (caught) {
                threw = true;
                error = caught;
              }
            }
            const pass = threw && thrownMatches(error, expected);
            if (pass === negate) {
              throw new Error(
                `expected function ${negate ? "not " : ""}to throw ${expected === undefined ? "" : show(expected)}` +
                  (threw ? `, it threw ${show(error)}` : ", it did not throw"),
              );
            }
          };
        }
        const matcher = MATCHERS[name];
        if (!matcher) {
          throw new Error(`node-test: unsupported matcher ${String(name)}`);
        }
        return (...args) => {
          const [pass, description] = matcher(actual, ...args);
          if (pass === negate) {
            throw new Error(
              `expected ${show(actual)} ${negate ? "not " : ""}${description}`,
            );
          }
        };
      },
    },
  );
}

export function expect(actual) {
  const base = assertion(actual, false, "value");
  return new Proxy(base, {
    get(target, name) {
      if (name === "resolves" || name === "rejects") {
        return new Proxy(
          {},
          {
            get(_, matcher) {
              return async (...args) => {
                let settled;
                let rejected = false;
                try {
                  settled = await (typeof actual === "function"
                    ? actual()
                    : actual);
                } catch (error) {
                  rejected = true;
                  settled = error;
                }
                if (name === "resolves" && rejected) {
                  throw new Error(
                    `expected promise to resolve, it rejected with ${show(settled)}`,
                  );
                }
                if (name === "rejects" && !rejected) {
                  throw new Error(
                    `expected promise to reject, it resolved with ${show(settled)}`,
                  );
                }
                const chain =
                  matcher === "not"
                    ? undefined
                    : assertion(
                        settled,
                        false,
                        name === "rejects" ? "rejects" : "value",
                      );
                if (!chain)
                  throw new Error(
                    "node-test: .resolves.not/.rejects.not is unsupported",
                  );
                return chain[matcher](...args);
              };
            },
          },
        );
      }
      return target[name];
    },
  });
}

expect.objectContaining = (shape) =>
  new Asymmetric(
    (value) => isPlainRecord(value) && equals(value, shape, true),
    `ObjectContaining ${show(shape)}`,
  );
expect.stringContaining = (text) =>
  new Asymmetric(
    (value) => typeof value === "string" && value.includes(text),
    `StringContaining ${show(text)}`,
  );
expect.stringMatching = (pattern) =>
  new Asymmetric(
    (value) => typeof value === "string" && new RegExp(pattern).test(value),
    `StringMatching ${show(pattern)}`,
  );
expect.arrayContaining = (items) =>
  new Asymmetric(
    (value) =>
      Array.isArray(value) &&
      items.every((item) => value.some((v) => equals(v, item))),
    `ArrayContaining ${show(items)}`,
  );
expect.any = (type) =>
  new Asymmetric(
    (value) =>
      value !== null &&
      value !== undefined &&
      (Object(value) instanceof type || value.constructor === type),
    `Any<${type?.name}>`,
  );
expect.anything = () =>
  new Asymmetric((value) => value !== null && value !== undefined, "Anything");
