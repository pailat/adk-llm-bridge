/**
 * Bounded copy of an untrusted value before the JSON guard reads it.
 *
 * @packageDocumentation
 */
import type { FreezeJsonLimits } from "../internal/immutable-json.js";

/**
 * Copies the input into plain data within the limits, reading each property
 * once.
 *
 * @remarks
 * The JSON guard reads every descriptor of an array before it counts, and
 * reads a property through its getter. A huge array behind a getter, or after
 * an object that appears twice, would reach it and take seconds. This copy
 * follows the guard's rules but checks each array's `length` against the
 * remaining budget before it reads any item, calls each getter once, and
 * counts an object again in every place it appears, as the guard does. Only
 * an object that contains itself is a cycle.
 *
 * An array whose `length` is not a safe integer, or that has an own item at
 * index `length`, cannot be a plain array (a proxy can report such a length)
 * and is rejected before its keys are listed. Only inherited keys are never
 * read: an object with a prototype other than `Object.prototype` or `null` is
 * kept as it is, so the guard rejects it with its own words.
 *
 * Listing the keys of an array or object calls the `ownKeys` trap of a proxy,
 * whose cost the proxy decides, as a getter decides its own cost. Hosts must
 * not pass proxies or getters they do not control; parsed JSON has neither.
 *
 * @param input - The value to copy.
 * @param limits - Size bounds, the same as the guard's.
 * @param fail - Throws the caller's error for a guard message; it must not
 * return.
 * @returns A plain copy of `input`, or `input` itself when its prototype is
 * not plain.
 * @throws Whatever `fail` throws, for a value over a limit or one that is not
 * JSON. Any error of a getter or proxy is passed on.
 * @internal
 */
export function boundedCopy(
  input: unknown,
  limits: Readonly<FreezeJsonLimits>,
  fail: (message: string) => never,
): unknown {
  const { maxDepth, maxNodes, maxStringLength } = limits;
  let budget = maxNodes;
  const ancestors = new Set<object>();
  // One descriptor per property, so a proxy cannot answer twice.
  const read = (descriptor: PropertyDescriptor, owner: object): unknown =>
    "value" in descriptor ? descriptor.value : descriptor.get?.call(owner);
  const visit = (value: unknown, depth: number): unknown => {
    budget -= 1;
    if (budget < 0) fail("JSON value exceeds node limit");
    if (depth > maxDepth) fail("JSON value exceeds depth limit");
    if (value === null || typeof value !== "object") return value;
    if (ancestors.has(value)) fail("JSON value must not contain cycles");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const length: unknown = Reflect.getOwnPropertyDescriptor(
          value,
          "length",
        )?.value;
        if (typeof length !== "number" || !Number.isSafeInteger(length)) {
          fail("JSON arrays must be dense plain arrays");
        }
        if (length > budget) {
          // A long sparse array is not JSON; a dense one is too large.
          if (
            Reflect.getOwnPropertyDescriptor(value, String(length - 1)) ===
            undefined
          ) {
            fail("JSON arrays must be dense plain arrays");
          }
          fail("JSON value exceeds node limit");
        }
        // A plain array has no own item at its length; a proxy that reports
        // a short length over a long target does.
        if (
          Reflect.getOwnPropertyDescriptor(value, String(length)) !== undefined
        ) {
          fail("JSON arrays must be dense plain arrays");
        }
        if (Reflect.ownKeys(value).length !== length + 1) {
          fail("JSON arrays must be dense plain arrays");
        }
        const items: unknown[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = Reflect.getOwnPropertyDescriptor(
            value,
            String(index),
          );
          if (!descriptor?.enumerable) {
            fail("JSON arrays must be dense plain arrays");
          }
          items.push(visit(read(descriptor, value), depth + 1));
        }
        return items;
      }
      const prototype = Reflect.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return value;
      const keys = Reflect.ownKeys(value);
      if (keys.length > budget) fail("JSON value exceeds node limit");
      const copy: Record<string, unknown> = {};
      for (const key of keys) {
        if (typeof key === "symbol") {
          fail("JSON objects must not have symbol keys");
        }
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable) continue;
        if (key.length > maxStringLength) {
          fail("JSON object key exceeds length limit");
        }
        const item = read(descriptor, value);
        if (item === undefined) continue;
        // An assignment would turn an own `__proto__` key into the prototype.
        Object.defineProperty(copy, key, {
          value: visit(item, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return copy;
    } finally {
      ancestors.delete(value);
    }
  };
  return visit(input, 0);
}
