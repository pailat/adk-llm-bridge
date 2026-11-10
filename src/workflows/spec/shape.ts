/**
 * Shape check of a run spec: the first family of issues.
 *
 * @remarks
 * The input is copied and frozen by the JSON guard before the schema reads
 * it, so a cycle, a hostile getter, a very deep value or a huge value
 * becomes an issue instead of an exception. Zod issues are translated into
 * the `shape` codes of `issues.ts`, one issue per problem.
 *
 * @packageDocumentation
 */
import type { z } from "zod";
import { freezeJson } from "../internal/immutable-json.js";
import {
  RUN_SPEC_MAX_UNKNOWN_KEYS_REPORTED,
  type RunSpecIssue,
  type RunSpecIssueCode,
  type RunSpecIssuePath,
  runSpecIssue,
} from "./issues.js";
import {
  RUN_SPEC_INPUT_LIMITS,
  RUN_SPEC_LIMITS,
  type RunSpec,
  RunSpecSchema,
} from "./schema.js";

type ZodIssue = z.core.$ZodIssue;

/** Thrown by the JSON guard callback; carries the guard's fixed message. */
class InputGuardFailure extends Error {}

const EXTENSION_KEY_MESSAGE =
  "Extension keys must have the form x-<vendor>: lower-case letters and digits, joined by single hyphens.";

function failGuard(message: string): never {
  throw new InputGuardFailure(message);
}

/** Maps a failure of the JSON guard to an input issue. */
function guardIssue(error: unknown): RunSpecIssue {
  const message = error instanceof InputGuardFailure ? error.message : "";
  if (message.includes("depth limit")) {
    return runSpecIssue(
      "RUN_SPEC_INPUT_TOO_DEEP",
      [],
      `The input is nested deeper than ${RUN_SPEC_INPUT_LIMITS.maxDepth} levels.`,
    );
  }
  if (message.includes("node limit") || message.includes("length limit")) {
    return runSpecIssue(
      "RUN_SPEC_INPUT_TOO_LARGE",
      [],
      `The input has more than ${RUN_SPEC_INPUT_LIMITS.maxNodes} values, or a string or key longer than ${RUN_SPEC_INPUT_LIMITS.maxStringLength} characters.`,
    );
  }
  return runSpecIssue(
    "RUN_SPEC_INPUT_NOT_JSON",
    [],
    "The input is not plain JSON: it has a cycle, a class instance, a sparse array, a non-finite number, a function, a symbol key or a property that cannot be read.",
  );
}

const TYPE_NAMES: Readonly<Record<string, string>> = {
  string: "a string",
  number: "a number",
  int: "an integer",
  boolean: "a boolean",
  array: "an array",
  object: "an object",
  record: "an object",
};

function toPath(path: readonly PropertyKey[]): RunSpecIssuePath {
  return path.map((segment) =>
    typeof segment === "number" ? segment : String(segment),
  );
}

/** True when the value at `path` is an object whose own key `key` exists. */
function hasKeyAt(
  root: unknown,
  parent: readonly PropertyKey[],
  key: PropertyKey,
): boolean {
  let node: unknown = root;
  for (const segment of parent) {
    if (node === null || typeof node !== "object") return false;
    if (!Object.hasOwn(node, segment)) return false;
    node = (node as Record<PropertyKey, unknown>)[segment];
  }
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    return false;
  }
  return Object.hasOwn(node, key);
}

function missingKeyIssue(
  path: readonly PropertyKey[],
  key: string,
): RunSpecIssue {
  return runSpecIssue(
    "RUN_SPEC_MISSING_KEY",
    toPath(path),
    `The required key "${key}" is missing.`,
  );
}

/**
 * True when `lanes` is an array above the hard lane limit.
 *
 * @remarks
 * Reads the property descriptor, which never calls a getter, so an oversized
 * array is rejected before the JSON guard copies it. Any failure to look
 * means "not oversized": the guard then reports it.
 */
function hasTooManyLanes(input: unknown): boolean {
  try {
    if (input === null || typeof input !== "object") return false;
    const lanes = Object.getOwnPropertyDescriptor(input, "lanes")?.value;
    return Array.isArray(lanes) && lanes.length > RUN_SPEC_LIMITS.maxLanes;
  } catch {
    return false;
  }
}

/**
 * True when the input has more values than the node limit, found without
 * copying it.
 *
 * @remarks
 * The JSON guard reads every descriptor of an array before it counts, so a
 * dense array of millions of items would take seconds to reject. This walk
 * reads only data descriptors, one at a time, never calls a getter, and
 * stops as soon as the count passes the limit, so its cost is bounded by
 * the limit. An array longer than the remaining budget counts as too large
 * when its last index is set; a sparse one is left to the guard, which
 * reports it as not JSON. A repeated object, a depth beyond the limit or a
 * failure to look ends the walk with "not too large": the guard then
 * reports it.
 */
function exceedsNodeLimit(input: unknown): boolean {
  const { maxDepth, maxNodes } = RUN_SPEC_INPUT_LIMITS;
  try {
    let budget = maxNodes;
    const seen = new Set<object>();
    const stack: [unknown, number][] = [[input, 0]];
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
      const [value, depth] = next;
      budget -= 1;
      if (budget < 0) return true;
      if (value === null || typeof value !== "object" || depth >= maxDepth) {
        continue;
      }
      if (seen.has(value)) return false;
      seen.add(value);
      const items: unknown[] = [];
      if (Array.isArray(value)) {
        const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
        if (!Number.isSafeInteger(length)) return false;
        if (length > budget) {
          return (
            Object.getOwnPropertyDescriptor(value, String(length - 1)) !==
            undefined
          );
        }
        for (let index = 0; index < length; index += 1) {
          items.push(Object.getOwnPropertyDescriptor(value, String(index)));
        }
      } else {
        const keys = Object.keys(value);
        if (keys.length > budget) return true;
        for (const key of keys) {
          items.push(Object.getOwnPropertyDescriptor(value, key));
        }
      }
      for (const descriptor of items) {
        const item = descriptor as PropertyDescriptor | undefined;
        if (item !== undefined && "value" in item) {
          stack.push([item.value, depth + 1]);
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

function limitText(value: unknown): string {
  return typeof value === "number" || typeof value === "bigint"
    ? String(value)
    : "its limit";
}

function tooSmall(issue: ZodIssue & { code: "too_small" }): {
  code: RunSpecIssueCode;
  message: string;
} {
  const minimum = limitText(issue.minimum);
  if (issue.origin === "string") {
    return {
      code: "RUN_SPEC_STRING_TOO_SHORT",
      message: `The string is too short: at least ${minimum} characters are required.`,
    };
  }
  if (issue.origin === "array") {
    return {
      code: "RUN_SPEC_ARRAY_TOO_SHORT",
      message: `The array has too few items: at least ${minimum} are required.`,
    };
  }
  return {
    code: "RUN_SPEC_NUMBER_OUT_OF_RANGE",
    message: issue.inclusive
      ? `The number is below the minimum of ${minimum}.`
      : `The number must be greater than ${minimum}.`,
  };
}

function tooBig(
  issue: ZodIssue & { code: "too_big" },
  path: readonly PropertyKey[],
): { code: RunSpecIssueCode; message: string } {
  const maximum = limitText(issue.maximum);
  if (issue.origin === "string") {
    return {
      code: "RUN_SPEC_STRING_TOO_LONG",
      message: `The string is too long: at most ${maximum} characters are allowed.`,
    };
  }
  if (issue.origin === "array") {
    if (path.length === 1 && path[0] === "lanes") {
      return {
        code: "RUN_SPEC_TOO_MANY_LANES",
        message: `The spec has too many lanes: at most ${RUN_SPEC_LIMITS.maxLanes} are allowed.`,
      };
    }
    if (path[path.length - 1] === "dependsOn") {
      return {
        code: "RUN_SPEC_TOO_MANY_DEPENDENCIES",
        message: `The lane has too many dependencies: at most ${RUN_SPEC_LIMITS.maxDependsOn} are allowed.`,
      };
    }
    return {
      code: "RUN_SPEC_ARRAY_TOO_LONG",
      message: `The array has too many items: at most ${maximum} are allowed.`,
    };
  }
  return {
    code: "RUN_SPEC_NUMBER_OUT_OF_RANGE",
    message: issue.inclusive
      ? `The number is above the maximum of ${maximum}.`
      : `The number must be less than ${maximum}.`,
  };
}

function allowedValues(values: readonly unknown[]): string {
  const shown = values.filter(
    (value) =>
      (typeof value === "string" && value.length <= 32) ||
      typeof value === "number" ||
      typeof value === "boolean",
  );
  return shown.length === values.length && shown.length <= 8
    ? `The value must be one of: ${shown.map(String).join(", ")}.`
    : "The value is not one of the allowed values.";
}

/** Translates one zod issue, appending zero or more run spec issues. */
function translate(
  issue: ZodIssue,
  frozen: unknown,
  out: RunSpecIssue[],
): void {
  const path = issue.path;
  switch (issue.code) {
    case "invalid_union": {
      if (path.length === 1 && path[0] === "specVersion") {
        out.push(
          runSpecIssue(
            "RUN_SPEC_VERSION_UNSUPPORTED",
            toPath(path),
            "specVersion is missing or names a version this library does not support; the supported version is 1.",
          ),
        );
      } else {
        out.push(
          runSpecIssue(
            "RUN_SPEC_INVALID_VALUE",
            toPath(path),
            "The kind is missing or is not one of the kinds this field defines.",
          ),
        );
      }
      return;
    }
    case "invalid_type": {
      const key = path[path.length - 1];
      if (
        key !== undefined &&
        typeof key === "string" &&
        !hasKeyAt(frozen, path.slice(0, -1), key)
      ) {
        out.push(missingKeyIssue(path, key));
        return;
      }
      const expected = TYPE_NAMES[issue.expected] ?? `a ${issue.expected}`;
      out.push(
        runSpecIssue(
          "RUN_SPEC_INVALID_TYPE",
          toPath(path),
          `Wrong type: expected ${expected}.`,
        ),
      );
      return;
    }
    case "unrecognized_keys": {
      const keys = [...issue.keys]
        .sort()
        .slice(0, RUN_SPEC_MAX_UNKNOWN_KEYS_REPORTED);
      for (const key of keys) {
        out.push(
          runSpecIssue(
            "RUN_SPEC_UNKNOWN_KEY",
            [...toPath(path), key],
            "Unknown key: this object does not define it.",
          ),
        );
      }
      return;
    }
    case "invalid_value": {
      // An enum or literal given `undefined` reports a bad value, not a type.
      const key = path[path.length - 1];
      if (
        typeof key === "string" &&
        !hasKeyAt(frozen, path.slice(0, -1), key)
      ) {
        out.push(missingKeyIssue(path, key));
        return;
      }
      out.push(
        runSpecIssue(
          "RUN_SPEC_INVALID_VALUE",
          toPath(path),
          allowedValues(issue.values),
        ),
      );
      return;
    }
    case "invalid_format":
      out.push(
        runSpecIssue(
          "RUN_SPEC_INVALID_FORMAT",
          toPath(path),
          "The string does not match the format this field requires.",
        ),
      );
      return;
    case "invalid_key":
      out.push(
        runSpecIssue(
          "RUN_SPEC_EXTENSION_KEY_INVALID",
          toPath(path),
          EXTENSION_KEY_MESSAGE,
        ),
      );
      return;
    case "too_small": {
      const { code, message } = tooSmall(issue);
      out.push(runSpecIssue(code, toPath(path), message));
      return;
    }
    case "too_big": {
      const { code, message } = tooBig(issue, path);
      out.push(runSpecIssue(code, toPath(path), message));
      return;
    }
    default:
      out.push(
        runSpecIssue(
          "RUN_SPEC_INVALID_VALUE",
          toPath(path),
          "The value is not valid for this field.",
        ),
      );
  }
}

/**
 * Reports an own `__proto__` key of the spec's or a lane's `extensions`.
 *
 * @remarks
 * zod's record schema skips an own `__proto__` key without checking it
 * against the key schema, so the schema alone would accept it, while the
 * JSON Schema's key pattern rejects it. Every other key is checked by the
 * schema. Reads only the frozen copy, so it never throws.
 */
function protoExtensionKeyIssues(frozen: unknown): RunSpecIssue[] {
  const found: RunSpecIssue[] = [];
  const check = (owner: unknown, path: (string | number)[]): void => {
    if (owner === null || typeof owner !== "object") return;
    const extensions = (owner as { extensions?: unknown }).extensions;
    if (
      extensions !== null &&
      typeof extensions === "object" &&
      Object.hasOwn(extensions, "__proto__")
    ) {
      found.push(
        runSpecIssue(
          "RUN_SPEC_EXTENSION_KEY_INVALID",
          [...path, "extensions", "__proto__"],
          EXTENSION_KEY_MESSAGE,
        ),
      );
    }
  };
  check(frozen, []);
  const lanes =
    frozen !== null && typeof frozen === "object"
      ? (frozen as { lanes?: unknown }).lanes
      : undefined;
  if (Array.isArray(lanes)) {
    lanes.forEach((lane, index) => {
      check(lane, ["lanes", index]);
    });
  }
  return found;
}

/**
 * Checks the structure of an unknown value against the run spec shape and
 * appends one issue per problem.
 *
 * @remarks
 * Never throws. The input is copied and frozen first; a value that is not
 * plain JSON, or is too deep or too large, gives one issue at the root and
 * the schema is not run. The returned spec is the frozen copy, so a getter
 * or proxy in the input cannot answer differently later. A `lanes` array
 * above the hard limit is reported alone, before it is copied, and so is an
 * input with more values than the node limit.
 *
 * @param input - The value to check.
 * @param issues - Receives the issues found.
 * @returns The value typed as a run spec when it has no shape issue,
 * otherwise `undefined`.
 * @experimental
 */
export function parseRunSpecShape(
  input: unknown,
  issues: RunSpecIssue[],
): RunSpec | undefined {
  if (hasTooManyLanes(input)) {
    issues.push(
      runSpecIssue(
        "RUN_SPEC_TOO_MANY_LANES",
        ["lanes"],
        `The spec has too many lanes: at most ${RUN_SPEC_LIMITS.maxLanes} are allowed.`,
      ),
    );
    return undefined;
  }
  if (exceedsNodeLimit(input)) {
    issues.push(guardIssue(new InputGuardFailure("node limit")));
    return undefined;
  }
  let frozen: unknown;
  try {
    frozen = freezeJson(input, RUN_SPEC_INPUT_LIMITS, failGuard);
  } catch (error) {
    issues.push(guardIssue(error));
    return undefined;
  }

  const found: RunSpecIssue[] = [];
  try {
    const parsed = RunSpecSchema.safeParse(frozen);
    if (parsed.success) {
      const keyIssues = protoExtensionKeyIssues(frozen as RunSpec);
      if (keyIssues.length === 0) return frozen as RunSpec;
      for (const issue of keyIssues) issues.push(issue);
      return undefined;
    }
    for (const issue of parsed.error.issues) translate(issue, frozen, found);
    for (const issue of protoExtensionKeyIssues(frozen)) found.push(issue);
  } catch {
    found.push(
      runSpecIssue(
        "RUN_SPEC_INPUT_NOT_JSON",
        [],
        "The input could not be checked against the run spec schema.",
      ),
    );
  }
  if (found.length === 0) {
    found.push(
      runSpecIssue(
        "RUN_SPEC_INVALID_VALUE",
        [],
        "The input does not match the run spec schema.",
      ),
    );
  }
  for (const issue of found) issues.push(issue);
  return undefined;
}
