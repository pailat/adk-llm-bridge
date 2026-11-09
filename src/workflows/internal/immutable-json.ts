/**
 * Size bounds for {@link freezeJson}. Every field must be a positive safe
 * integer.
 *
 * @internal
 */
export interface FreezeJsonLimits {
  /** Maximum nesting depth. */
  maxDepth: number;
  /** Maximum number of values, counting containers and leaves. */
  maxNodes: number;
  /** Maximum length of any string value or object key. */
  maxStringLength: number;
}

const LIMIT_NAMES = ["maxDepth", "maxNodes", "maxStringLength"] as const;

/**
 * Validates a JSON value and returns a deep-frozen copy.
 *
 * @remarks
 * Every property is read exactly once, through its own descriptor (a getter
 * is called once), so the copy is exactly what was validated: a getter or
 * proxy cannot answer differently later. Callers validate the copy, never
 * the input. Symbol keys, sparse arrays, extra array properties, cycles,
 * non-finite numbers and non-plain prototypes are rejected. Object
 * properties whose value is `undefined` are dropped, as are non-enumerable
 * properties. Keys are copied as own data properties, so a `__proto__` key
 * stays a plain key and never changes the copy's prototype. Each field of
 * `limits` is read once.
 *
 * @param value - Value to validate and copy.
 * @param limits - Size bounds to enforce.
 * @param invalid - Throws the caller's error for a message; it must not return.
 * @returns A deep-frozen copy of `value`.
 * @throws Whatever `invalid` throws, when the value or `limits` is invalid.
 * @internal
 */
export function freezeJson<T>(
  value: T,
  limits: Readonly<FreezeJsonLimits>,
  invalid: (message: string) => never,
): T {
  const { maxDepth, maxNodes, maxStringLength } = readLimits(limits, invalid);
  const seen = new Set<object>();
  let nodes = 0;

  const visit = (candidate: unknown, depth: number): unknown => {
    nodes++;
    if (nodes > maxNodes) invalid("JSON value exceeds node limit");
    if (depth > maxDepth) invalid("JSON value exceeds depth limit");
    if (candidate === null || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "string") {
      if (candidate.length > maxStringLength) {
        invalid("JSON string exceeds length limit");
      }
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) invalid("JSON numbers must be finite");
      return candidate;
    }
    if (!candidate || typeof candidate !== "object") {
      invalid("Value must be JSON-safe");
    }
    if (seen.has(candidate)) invalid("JSON value must not contain cycles");
    seen.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        return Object.freeze(copyArray(candidate, depth));
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        invalid("JSON objects must use a plain prototype");
      }
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      const result: Record<string, unknown> = {};
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key === "symbol") {
          invalid("JSON objects must not have symbol keys");
        }
        const descriptor = descriptors[key] as PropertyDescriptor;
        if (!descriptor.enumerable) continue;
        if (key.length > maxStringLength) {
          invalid("JSON object key exceeds length limit");
        }
        const item = readOnce(descriptor, candidate);
        if (item === undefined) continue;
        // An assignment would turn an own `__proto__` key into the prototype.
        Object.defineProperty(result, key, {
          value: visit(item, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return Object.freeze(result);
    } finally {
      seen.delete(candidate);
    }
  };

  const copyArray = (array: readonly unknown[], depth: number): unknown[] => {
    const descriptors = Object.getOwnPropertyDescriptors(
      array,
    ) as unknown as Record<PropertyKey, PropertyDescriptor>;
    const length = descriptors.length?.value;
    if (!Number.isSafeInteger(length)) {
      invalid("JSON arrays must be dense plain arrays");
    }
    // Indexes plus `length` must be every own key: no holes, no extras.
    if (Reflect.ownKeys(descriptors).length !== length + 1) {
      invalid("JSON arrays must be dense plain arrays");
    }
    const values: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor?.enumerable) {
        invalid("JSON arrays must be dense plain arrays");
      }
      values.push(visit(readOnce(descriptor, array), depth + 1));
    }
    return values;
  };

  return visit(value, 0) as T;
}

/** Reads each limit once and checks it by name. */
function readLimits(
  limits: Readonly<FreezeJsonLimits>,
  invalid: (message: string) => never,
): FreezeJsonLimits {
  const values = { maxDepth: 0, maxNodes: 0, maxStringLength: 0 };
  for (const name of LIMIT_NAMES) {
    const limit = limits?.[name];
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      invalid(`JSON limit ${name} must be a positive safe integer`);
    }
    values[name] = limit;
  }
  return values;
}

/** The descriptor's value, or its getter's result from one call. */
function readOnce(descriptor: PropertyDescriptor, receiver: object): unknown {
  return "value" in descriptor
    ? descriptor.value
    : descriptor.get?.call(receiver);
}
