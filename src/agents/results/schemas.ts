import { z } from "zod";

/** Lane outcome shared by `implement@1` and `tests@1`. */
const laneStatus = () => z.enum(["done", "blocked", "failed"]);

/**
 * zod parser of `implement@1`, the result of an implement lane.
 *
 * @remarks
 * `status` is `done`, `blocked` or `failed`; `summary` says what the lane
 * did; `changedPaths` lists the paths it changed, relative to the project
 * root (check them with `checkChangedPaths`); `notes` is optional. Unknown
 * keys are rejected. It accepts exactly what `agentResultJsonSchemas`
 * accepts for the same id.
 *
 * @experimental
 */
export const ImplementResultV1Schema = z.strictObject({
  status: laneStatus(),
  summary: z.string(),
  changedPaths: z.array(z.string()),
  notes: z.string().optional(),
});

/**
 * zod parser of `tests@1`, the result of a tests lane.
 *
 * @remarks
 * `status` is `done`, `blocked` or `failed`; `testPaths` lists the test files
 * the lane wrote; `failingAsExpected` tells whether they fail before the
 * implementation for the reason they should. Unknown keys are rejected.
 *
 * @experimental
 */
export const TestsResultV1Schema = z.strictObject({
  status: laneStatus(),
  testPaths: z.array(z.string()),
  failingAsExpected: z.boolean(),
});

/**
 * zod parser of `review@1`, the result of a review lane.
 *
 * @remarks
 * `verdict` is `approve`, `request_changes` or `block`. Each finding has a
 * `severity` (`high`, `medium` or `low`), a `path`, an optional integer
 * `line` counted from 1 and a `summary`. Unknown keys are rejected at both levels.
 *
 * @experimental
 */
export const ReviewResultV1Schema = z.strictObject({
  verdict: z.enum(["approve", "request_changes", "block"]),
  findings: z.array(
    z.strictObject({
      severity: z.enum(["high", "medium", "low"]),
      path: z.string(),
      line: z.int().min(1).optional(),
      summary: z.string(),
    }),
  ),
});

/**
 * zod parser of `gate@1`, the result of a gate.
 *
 * @remarks
 * `passed` tells whether the gate passed; each check has an `id`, an integer
 * `exitCode` and a non-negative integer `durationMs`. Unknown keys are rejected at both
 * levels.
 *
 * @experimental
 */
export const GateResultV1Schema = z.strictObject({
  passed: z.boolean(),
  checks: z.array(
    z.strictObject({
      id: z.string(),
      exitCode: z.int(),
      durationMs: z.int().min(0),
    }),
  ),
});

/**
 * A parsed `implement@1` result.
 *
 * @experimental
 */
export type ImplementResultV1 = z.output<typeof ImplementResultV1Schema>;

/**
 * A parsed `tests@1` result.
 *
 * @experimental
 */
export type TestsResultV1 = z.output<typeof TestsResultV1Schema>;

/**
 * A parsed `review@1` result.
 *
 * @experimental
 */
export type ReviewResultV1 = z.output<typeof ReviewResultV1Schema>;

/**
 * A parsed `gate@1` result.
 *
 * @experimental
 */
export type GateResultV1 = z.output<typeof GateResultV1Schema>;

/**
 * Ids of the standard result schemas, `<kind>@<version>`.
 *
 * @remarks
 * A version never changes once released: a new shape gets a new version,
 * such as `implement@2`, next to the old one.
 *
 * @experimental
 */
export const AGENT_RESULT_SCHEMA_IDS = Object.freeze([
  "implement@1",
  "tests@1",
  "review@1",
  "gate@1",
] as const);

/**
 * Id of a standard result schema.
 *
 * @experimental
 */
export type AgentResultSchemaId = (typeof AGENT_RESULT_SCHEMA_IDS)[number];

/**
 * The parsed result type of each schema id.
 *
 * @experimental
 */
export interface AgentResultById {
  /** Result of an implement lane. */
  "implement@1": ImplementResultV1;
  /** Result of a tests lane. */
  "tests@1": TestsResultV1;
  /** Result of a review lane. */
  "review@1": ReviewResultV1;
  /** Result of a gate. */
  "gate@1": GateResultV1;
}

/**
 * The zod parser of each schema id. The map is frozen.
 *
 * @experimental
 */
export const agentResultSchemas: Readonly<{
  [Id in AgentResultSchemaId]: z.ZodType<AgentResultById[Id]>;
}> = Object.freeze({
  "implement@1": ImplementResultV1Schema,
  "tests@1": TestsResultV1Schema,
  "review@1": ReviewResultV1Schema,
  "gate@1": GateResultV1Schema,
});

/**
 * One reason a value is not a valid result.
 *
 * @experimental
 */
export interface AgentResultIssue {
  /** Keys and indexes from the result root to the bad value. */
  readonly path: readonly (string | number)[];
  /** What is wrong, for people. */
  readonly message: string;
}

/**
 * Outcome of {@link parseAgentResult}.
 *
 * @experimental
 */
export type AgentResultParse<Id extends AgentResultSchemaId> =
  | {
      /** The value is a valid result. */
      readonly ok: true;
      /** The parsed result, a copy of the input. */
      readonly value: AgentResultById[Id];
    }
  | {
      /** The value is not a valid result. */
      readonly ok: false;
      /** Why it is not valid; never empty. */
      readonly issues: readonly AgentResultIssue[];
    };

/**
 * Parses an agent's structured output against a standard result schema.
 *
 * @param id - Schema id, such as `"implement@1"`.
 * @param value - The structured output, already decoded from JSON.
 * @returns The parsed copy, or the issues that make it invalid.
 * @throws TypeError when `id` is not a standard result schema id.
 *
 * @experimental
 */
export function parseAgentResult<Id extends AgentResultSchemaId>(
  id: Id,
  value: unknown,
): AgentResultParse<Id> {
  if (!Object.hasOwn(agentResultSchemas, id)) {
    throw new TypeError(`Unknown agent result schema id: ${String(id)}`);
  }
  const schema = agentResultSchemas[id] as z.ZodType<AgentResultById[Id]>;
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map((key) =>
        typeof key === "symbol" ? String(key) : key,
      ),
      message: issue.message,
    })),
  };
}
