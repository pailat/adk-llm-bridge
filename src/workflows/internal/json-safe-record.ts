/** Containers nested deeper than this are dropped from the projection. */
const MAX_DEPTH = 32;

/**
 * Projects a value onto a plain JSON object, the way `JSON.stringify` would
 * keep it, without ever throwing.
 *
 * @remarks
 * Used for error `details`, which must always be recordable in a checkpoint
 * and an event. Object properties that are `undefined`, functions or symbols
 * are dropped; in arrays they become `null`, as do non-finite numbers. A
 * `bigint` becomes its decimal string. A `toJSON()` method is called. Other
 * objects keep their own enumerable string keys, so an `Error` becomes `{}`.
 * A cycle, a container deeper than 32 levels, a throwing getter or a throwing
 * Proxy trap drops only that value. Keys are copied as own data properties,
 * so a `__proto__` key never changes the copy's prototype.
 *
 * @param value - Value to project.
 * @returns A new plain object, or `undefined` when `value` does not project
 * onto an object (for example a string, an array or `undefined`).
 * @internal
 */
export function toJsonSafeRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  const projected = project(value, new Set(), 0);
  return projected !== null &&
    typeof projected === "object" &&
    !Array.isArray(projected)
    ? (projected as Record<string, unknown>)
    : undefined;
}

/** Returns the JSON projection, or `undefined` when the value is omitted. */
function project(value: unknown, seen: Set<object>, depth: number): unknown {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return undefined;
  if (seen.has(value) || depth >= MAX_DEPTH) return undefined;
  seen.add(value);
  try {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      return project(toJSON.call(value), seen, depth + 1);
    }
    if (Array.isArray(value)) {
      const length = value.length;
      const items: unknown[] = [];
      for (let index = 0; index < length; index++) {
        items.push(project(guardedRead(value, index), seen, depth + 1) ?? null);
      }
      return items;
    }
    const record: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const item = project(guardedRead(value, key), seen, depth + 1);
      if (item === undefined) continue;
      Object.defineProperty(record, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: item,
      });
    }
    return record;
  } catch {
    // A throwing toJSON() or Proxy trap drops only this value.
    return undefined;
  } finally {
    seen.delete(value);
  }
}

function guardedRead(value: object, key: string | number): unknown {
  try {
    return (value as Record<string | number, unknown>)[key];
  } catch {
    // A throwing getter drops only this property.
    return undefined;
  }
}
