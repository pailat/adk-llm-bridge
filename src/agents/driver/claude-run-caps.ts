/**
 * Run caps and native structured output of `ClaudeAgentSdkDriver`: the
 * checks its constructor runs on `maxBudgetUsd`, `effort`,
 * `maxThinkingTokens` and `outputSchema`, the budget read when each
 * `query()` call starts, and the check of the structured value a run returns.
 *
 * @internal
 */

import { InputValidationError } from "@google/adk";
import type { ExternalAgentEvent } from "../events.js";

/**
 * Code of the non-recoverable `error` event a Claude Agent SDK run reports,
 * before `query()` is called, when a `maxBudgetUsd` function throws or
 * returns a value that is not a finite number above 0.
 */
export const CLAUDE_MAX_BUDGET_INVALID = "CLAUDE_MAX_BUDGET_INVALID";

/**
 * Code of the non-recoverable `error` event a Claude Agent SDK run with an
 * `outputSchema` reports when its successful result carries no structured
 * value, or one that does not match the schema. The run ends with exit
 * code 1 and no `output` event: the raw text never stands in for the value.
 * The SDK giving up after its own retries is `MAX_STRUCTURED_OUTPUT_RETRIES`.
 */
export const CLAUDE_OUTPUT_SCHEMA_MISMATCH = "CLAUDE_OUTPUT_SCHEMA_MISMATCH";

/**
 * The tool Claude Code adds to a session with an `outputSchema`; the model
 * calls it to give the structured answer. `system/init` lists it.
 */
export const CLAUDE_STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

/**
 * Reasoning effort levels of the Claude Agent SDK (its `EffortLevel`).
 *
 * @experimental Follows the Claude Agent SDK's `EffortLevel`.
 */
export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

const CLAUDE_EFFORTS: readonly ClaudeEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** A spend cap in US dollars, or a function the driver reads on every run. */
export type ClaudeMaxBudgetUsd = number | (() => number);

/** The caps a driver config gives, once checked. */
export interface ClaudeRunCaps {
  maxBudgetUsd?: ClaudeMaxBudgetUsd;
  effort?: ClaudeEffort;
  maxThinkingTokens?: number;
  outputSchema?: Record<string, unknown>;
}

const isBudget = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * Checks the caps of a driver config.
 *
 * @param driver - The driver's class name, for the message.
 * @param config - The constructor's config.
 * @returns The caps, with `outputSchema` deep-copied.
 * @throws InputValidationError (from `@google/adk`) for a `maxBudgetUsd`
 * that is neither a finite number above 0 nor a function, an `effort` that
 * is not one of the SDK's levels, a `maxThinkingTokens` that is not a
 * positive integer, and an `outputSchema` that is not a JSON object.
 */
export function checkClaudeRunCaps(
  driver: string,
  config: Readonly<Record<string, unknown>>,
): ClaudeRunCaps {
  const { maxBudgetUsd, effort, maxThinkingTokens, outputSchema } = config;
  const caps: ClaudeRunCaps = {};
  if (maxBudgetUsd !== undefined) {
    if (!isBudget(maxBudgetUsd) && typeof maxBudgetUsd !== "function") {
      throw new InputValidationError(
        `${driver}: maxBudgetUsd must be a finite number above 0, or a function that returns one.`,
      );
    }
    caps.maxBudgetUsd = maxBudgetUsd as ClaudeMaxBudgetUsd;
  }
  if (effort !== undefined) {
    if (!CLAUDE_EFFORTS.includes(effort as ClaudeEffort)) {
      throw new InputValidationError(
        `${driver}: effort must be one of ${CLAUDE_EFFORTS.map((level) => JSON.stringify(level)).join(", ")}.`,
      );
    }
    caps.effort = effort as ClaudeEffort;
  }
  if (maxThinkingTokens !== undefined) {
    if (
      !(
        typeof maxThinkingTokens === "number" &&
        Number.isSafeInteger(maxThinkingTokens) &&
        maxThinkingTokens > 0
      )
    ) {
      throw new InputValidationError(
        `${driver}: maxThinkingTokens must be a positive integer.`,
      );
    }
    caps.maxThinkingTokens = maxThinkingTokens;
  }
  if (outputSchema !== undefined) {
    caps.outputSchema = checkOutputSchema(driver, outputSchema);
  }
  return caps;
}

function checkOutputSchema(
  driver: string,
  schema: unknown,
): Record<string, unknown> {
  const proto =
    typeof schema === "object" && schema !== null
      ? Object.getPrototypeOf(schema)
      : undefined;
  if (proto !== Object.prototype && proto !== null) {
    throw new InputValidationError(
      `${driver}: outputSchema must be a JSON Schema object.`,
    );
  }
  try {
    // A copy, so a caller's later edit cannot change what the runs send.
    return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  } catch (error) {
    throw new InputValidationError(
      `${driver}: outputSchema must be JSON (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

/** A `maxBudgetUsd` function failed; reported as CLAUDE_MAX_BUDGET_INVALID. */
export class ClaudeMaxBudgetInvalidError extends Error {
  constructor(reason: string, cause?: unknown) {
    super(`ClaudeAgentSdkDriver: ${reason}. The run did not start.`, {
      cause,
    });
    this.name = "ClaudeMaxBudgetInvalidError";
  }

  /** The non-recoverable error event that ends the run. */
  event(): ExternalAgentEvent {
    return {
      type: "error",
      message: this.message,
      code: CLAUDE_MAX_BUDGET_INVALID,
      recoverable: false,
      timestamp: Date.now(),
    };
  }
}

/**
 * The budget of one `query()` call: the number, or what the function
 * returns now.
 *
 * @throws {@link ClaudeMaxBudgetInvalidError} when the function throws or
 * returns anything but a finite number above 0.
 */
export function resolveClaudeMaxBudget(
  budget: ClaudeMaxBudgetUsd | undefined,
): number | undefined {
  if (typeof budget !== "function") return budget;
  let value: unknown;
  try {
    value = budget();
  } catch (error) {
    throw new ClaudeMaxBudgetInvalidError(
      `the maxBudgetUsd function threw: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
  if (!isBudget(value)) {
    throw new ClaudeMaxBudgetInvalidError(
      `the maxBudgetUsd function returned ${typeof value === "number" ? String(value) : typeof value}, not a finite number above 0`,
    );
  }
  return value;
}

/** Tells whether a value matches the schema; `undefined` when unknown. */
export type StructuredOutputCheck = (value: unknown) => boolean | undefined;

/** Keywords whose value is one subschema. */
const SUBSCHEMA_KEYWORDS = [
  "additionalItems",
  "additionalProperties",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
];
/** Keywords whose value is a list of subschemas. */
const SUBSCHEMA_LIST_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems"];
/** Keywords whose value maps names to subschemas. */
const SUBSCHEMA_MAP_KEYWORDS = [
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
];

/** Whether `value` is a JSON primitive (zod compares the rest by reference). */
function isPrimitive(value: unknown): boolean {
  return value === null || typeof value !== "object";
}

/**
 * A copy of `schema` that accepts at least every value `schema` accepts,
 * with the keywords zod reads more strictly than JSON Schema relaxed, in
 * every subschema. Property names are kept: a property named `format` or
 * `pattern` stays.
 *
 * @remarks Relaxed, and so left to the SDK:
 * - `format`: zod reads some formats more strictly (it reads
 *   `uri-reference` as an absolute URL).
 * - `pattern` and `patternProperties`, with any sibling
 *   `additionalProperties`: zod compiles them without the `u` flag, so a
 *   pattern such as `\p{L}` matches other text.
 * - `oneOf`, read as `anyOf`: zod's exclusive union refuses a value that
 *   matches more than one branch, which untyped branches and branches told
 *   apart only by format or pattern always do.
 * - A `const` that is an object or array, and an `enum` with such a member:
 *   zod compares them by reference, so no value matches.
 */
export function looserSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(looserSchema);
  if (typeof schema !== "object" || schema === null) return schema;
  const {
    format: _format,
    pattern: _pattern,
    ...rest
  } = schema as Record<string, unknown>;
  if ("patternProperties" in rest) {
    delete rest.patternProperties;
    delete rest.additionalProperties;
  }
  if ("const" in rest && !isPrimitive(rest.const)) delete rest.const;
  if (Array.isArray(rest.enum) && !rest.enum.every(isPrimitive)) {
    delete rest.enum;
  }
  if (Array.isArray(rest.oneOf)) {
    const branches = rest.oneOf;
    delete rest.oneOf;
    if (rest.anyOf === undefined) {
      rest.anyOf = branches;
    } else {
      const allOf = Array.isArray(rest.allOf) ? rest.allOf : [];
      rest.allOf = [...allOf, { anyOf: branches }];
    }
  }
  for (const key of SUBSCHEMA_KEYWORDS) {
    if (key in rest) rest[key] = looserSchema(rest[key]);
  }
  for (const key of SUBSCHEMA_LIST_KEYWORDS) {
    if (Array.isArray(rest[key])) rest[key] = looserSchema(rest[key]);
  }
  for (const key of SUBSCHEMA_MAP_KEYWORDS) {
    const map = rest[key];
    if (typeof map === "object" && map !== null && !Array.isArray(map)) {
      rest[key] = Object.fromEntries(
        Object.entries(map).map(([name, sub]) => [name, looserSchema(sub)]),
      );
    }
  }
  return rest;
}

/**
 * A check of values against `schema`, built with zod's JSON Schema reader.
 * The SDK already validates the value before it reports success; this is
 * the second check, and it is only ever looser than JSON Schema: keywords
 * zod reads more strictly are left to the SDK (see {@link looserSchema}).
 * When zod is missing or cannot read the schema the check answers
 * `undefined` and the SDK's validation stands alone.
 */
export async function structuredOutputCheck(
  schema: Record<string, unknown>,
): Promise<StructuredOutputCheck> {
  try {
    const { z } = await import("zod/v4");
    const validator = z.fromJSONSchema(looserSchema(schema) as never);
    return (value) => validator.safeParse(value).success;
  } catch {
    return () => undefined;
  }
}

/**
 * The events a successful result of a run with an `outputSchema` adds
 * before its `completed` event.
 *
 * @param result - The SDK's `result` message (subtype `success`).
 * @param check - The check from {@link structuredOutputCheck}.
 * @returns The structured value as one `output` event (its JSON, with
 * `metadata.structuredOutput: true`), or a `CLAUDE_OUTPUT_SCHEMA_MISMATCH`
 * error event.
 */
export function structuredOutputEvent(
  result: Readonly<Record<string, unknown>>,
  check: StructuredOutputCheck,
):
  | { ok: true; event: ExternalAgentEvent }
  | { ok: false; event: ExternalAgentEvent } {
  const value = result.structured_output;
  const mismatch = (reason: string) => ({
    ok: false as const,
    event: {
      type: "error" as const,
      message: `Claude Agent SDK: ${reason}, so the run has no structured output.`,
      code: CLAUDE_OUTPUT_SCHEMA_MISMATCH,
      recoverable: false,
      timestamp: Date.now(),
    },
  });
  if (value === undefined || value === null) {
    return mismatch("the result carries no value for outputSchema");
  }
  if (check(value) === false) {
    return mismatch("the result's value does not match outputSchema");
  }
  return {
    ok: true,
    event: {
      type: "output",
      content: JSON.stringify(value),
      turnComplete: true,
      metadata: { structuredOutput: true },
      timestamp: Date.now(),
    },
  };
}
