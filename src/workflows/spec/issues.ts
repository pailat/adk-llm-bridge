/**
 * Issue codes of run spec validation.
 *
 * @remarks
 * Every way a run spec can be rejected has one stable code. Branch on the
 * code, never on the message. Each code belongs to one family, and each
 * family is checked by one module.
 *
 * @packageDocumentation
 */
import { z } from "zod";

/**
 * Families of run spec issues, in the order they are checked.
 *
 * @remarks
 * `shape` runs first and alone: the other families read a spec whose
 * structure is already valid, and all of them run so one call reports every
 * rule a spec breaks.
 *
 * @experimental
 */
export const RUN_SPEC_ISSUE_FAMILY_NAMES = [
  "shape",
  "paths",
  "budget",
  "models",
  "graph",
  "gates",
] as const;

/**
 * Family of a run spec issue code.
 *
 * @experimental
 */
export type RunSpecIssueFamily = (typeof RUN_SPEC_ISSUE_FAMILY_NAMES)[number];

/**
 * Every run spec issue code, with its family.
 *
 * @experimental
 */
export const RUN_SPEC_ISSUE_FAMILIES = {
  // --- shape -----------------------------------------------------------
  /** The rule set passed to the validator does not match `RunRulesSchema`. */
  RUN_SPEC_RULES_INVALID: "shape",
  /** The input is not plain JSON: a cycle, a class instance, a sparse array, a non-finite number, a function or a symbol key. */
  RUN_SPEC_INPUT_NOT_JSON: "shape",
  /** The input has more values, or a longer string or key, than `RUN_SPEC_INPUT_LIMITS` allows. */
  RUN_SPEC_INPUT_TOO_LARGE: "shape",
  /** The input is nested deeper than `RUN_SPEC_INPUT_LIMITS.maxDepth`. */
  RUN_SPEC_INPUT_TOO_DEEP: "shape",
  /** `specVersion` is missing or names a version this library does not support. */
  RUN_SPEC_VERSION_UNSUPPORTED: "shape",
  /** A required key is absent. */
  RUN_SPEC_MISSING_KEY: "shape",
  /** An object has a key the schema does not define. */
  RUN_SPEC_UNKNOWN_KEY: "shape",
  /** A value has the wrong JSON type, including a number that must be an integer and is not. */
  RUN_SPEC_INVALID_TYPE: "shape",
  /** A value is not one of the allowed constants, including the `kind` of a variant. */
  RUN_SPEC_INVALID_VALUE: "shape",
  /** A string does not match the pattern of its field, such as an identifier, a model id, a tool name or an environment variable name. */
  RUN_SPEC_INVALID_FORMAT: "shape",
  /** A string is empty or shorter than its field allows. */
  RUN_SPEC_STRING_TOO_SHORT: "shape",
  /** A string is longer than the hard limit of its field. */
  RUN_SPEC_STRING_TOO_LONG: "shape",
  /** An array has fewer items than its field requires, such as an empty `lanes` or an empty QA `command`. */
  RUN_SPEC_ARRAY_TOO_SHORT: "shape",
  /** An array other than `lanes` and `dependsOn` has more items than its hard limit. */
  RUN_SPEC_ARRAY_TOO_LONG: "shape",
  /** `lanes` has more items than `RUN_SPEC_LIMITS.maxLanes`. */
  RUN_SPEC_TOO_MANY_LANES: "shape",
  /** A lane's `dependsOn` has more items than `RUN_SPEC_LIMITS.maxDependsOn`. */
  RUN_SPEC_TOO_MANY_DEPENDENCIES: "shape",
  /** A number is outside the range of its field, such as a budget of zero or a concurrency above the hard limit. */
  RUN_SPEC_NUMBER_OUT_OF_RANGE: "shape",
  /** A key of `extensions` is not of the form `x-<vendor>`. */
  RUN_SPEC_EXTENSION_KEY_INVALID: "shape",
  /** More issues were found than `RUN_SPEC_MAX_ISSUES`; the list was cut and this issue is its last entry. */
  RUN_SPEC_ISSUES_TRUNCATED: "shape",

  // --- paths -----------------------------------------------------------
  /** A path starts with `/` or with a drive prefix such as `C:`. */
  RUN_SPEC_PATH_ABSOLUTE: "paths",
  /** A path has a `..` segment. */
  RUN_SPEC_PATH_TRAVERSAL: "paths",
  /** A path contains a backslash. */
  RUN_SPEC_PATH_BACKSLASH: "paths",
  /** A path is valid but not in canonical form: it has an empty segment, a `.` segment or a trailing slash. */
  RUN_SPEC_PATH_NOT_CANONICAL: "paths",
  /** A lane's allowed path names the project root itself. */
  RUN_SPEC_PATH_ROOT_NOT_ALLOWED: "paths",
  /** A path is blank, contains a NUL character or fails the portable path grammar for another reason. */
  RUN_SPEC_PATH_INVALID: "paths",
  /** A segment of a path matches one of the rule set's denied patterns, such as `.env` or `*.pem`. */
  RUN_SPEC_PATH_DENIED: "paths",
  /** Two allowed paths of one lane are equal, or one contains the other, ignoring case. */
  RUN_SPEC_PATH_DUPLICATE: "paths",
  /** Allowed paths of two lanes are equal, or one contains the other, ignoring case. */
  RUN_SPEC_PATH_OVERLAP: "paths",

  // --- budget ----------------------------------------------------------
  /** `budget.maxUsd` is above the rule set's `maxBudgetUsd`. */
  RUN_SPEC_BUDGET_EXCEEDED: "budget",
  /** `maxConcurrency` is above the rule set's `maxConcurrency`. */
  RUN_SPEC_CONCURRENCY_EXCEEDED: "budget",
  /** The spec has more lanes than the rule set's `maxLanes`. */
  RUN_SPEC_LANE_LIMIT_EXCEEDED: "budget",
  /** A string outside `extensions` is longer than the rule set's `maxStringLength`. */
  RUN_SPEC_STRING_LIMIT_EXCEEDED: "budget",
  /** An array other than `lanes` is longer than the rule set's `maxArrayLength`. */
  RUN_SPEC_ARRAY_LIMIT_EXCEEDED: "budget",
  /** A lane's review declares more change rounds than the rule set's `maxChangeRounds`. */
  RUN_SPEC_CHANGE_ROUNDS_EXCEEDED: "budget",
  /** The worst-case number of agent runs, summed over the lanes, is above the rule set's `maxAgentRuns`. */
  RUN_SPEC_AGENT_RUN_LIMIT_EXCEEDED: "budget",
  /** An `extensions` object has too many keys, or one of its values is not plain JSON or is beyond `RUN_SPEC_EXTENSION_LIMITS`. */
  RUN_SPEC_EXTENSION_TOO_LARGE: "budget",
  /** The workflow plan the spec maps to is beyond the size limits of the plan stores. */
  RUN_SPEC_PLAN_TOO_LARGE: "budget",

  // --- models ----------------------------------------------------------
  /** A lane's agent or reviewer names a provider outside the rule set's `allowedProviderIds`. */
  RUN_SPEC_PROVIDER_NOT_ALLOWED: "models",
  /** A lane's agent or reviewer names a model outside the rule set's `allowedModels`. */
  RUN_SPEC_MODEL_NOT_ALLOWED: "models",
  /** A lane's agent asks for a permission mode outside the rule set's `allowedPermissionModes`; `full-access` is always outside. */
  RUN_SPEC_PERMISSION_MODE_NOT_ALLOWED: "models",
  /** A lane's agent sets `allowNetwork` to true and the rule set's `allowNetwork` is false. */
  RUN_SPEC_NETWORK_NOT_ALLOWED: "models",
  /** A lane's agent lists a tool outside the rule set's `allowedTools`. */
  RUN_SPEC_TOOL_NOT_ALLOWED: "models",
  /** A lane's agent lists the same tool twice. */
  RUN_SPEC_TOOL_DUPLICATE: "models",
  /** `env` lists a name outside the rule set's `allowedEnvNames`. */
  RUN_SPEC_ENV_NAME_NOT_ALLOWED: "models",
  /** `env` lists the same name twice. */
  RUN_SPEC_ENV_NAME_DUPLICATE: "models",

  // --- graph -----------------------------------------------------------
  /** Two lanes have the same `taskId`. */
  RUN_SPEC_LANE_ID_DUPLICATE: "graph",
  /** A lane's `dependsOn` names a task id that no lane has. */
  RUN_SPEC_DEPENDENCY_UNKNOWN: "graph",
  /** A lane's `dependsOn` names the lane itself. */
  RUN_SPEC_DEPENDENCY_SELF: "graph",
  /** A lane's `dependsOn` names the same lane twice. */
  RUN_SPEC_DEPENDENCY_DUPLICATE: "graph",
  /** A lane is on a dependency cycle or waits for a lane that is. */
  RUN_SPEC_DEPENDENCY_CYCLE: "graph",
  /** The existing workflow plan validator rejects the plan the spec maps to, for a reason no other graph code names. */
  RUN_SPEC_PLAN_REJECTED: "graph",

  // --- gates -----------------------------------------------------------
  /** Two QA commands have the same `id`. */
  RUN_SPEC_QA_ID_DUPLICATE: "gates",
  /** A QA command does not equal any entry of the rule set's `allowedQaCommands`. */
  RUN_SPEC_QA_COMMAND_NOT_ALLOWED: "gates",
  /** The spec publishes, the rule set's `requireQa` is true and `gates.qa` is empty. */
  RUN_SPEC_QA_REQUIRED: "gates",
  /** `gates.publish.kind` is outside the rule set's `allowedPublishKinds`. */
  RUN_SPEC_PUBLISH_KIND_NOT_ALLOWED: "gates",
  /** The spec commits or merges and `gates.publish.hitl` is not true. */
  RUN_SPEC_HITL_REQUIRED: "gates",
} as const satisfies Record<`RUN_SPEC_${string}`, RunSpecIssueFamily>;

/**
 * Stable code of a run spec issue.
 *
 * @experimental
 */
export type RunSpecIssueCode = keyof typeof RUN_SPEC_ISSUE_FAMILIES;

/**
 * Every run spec issue code, in declaration order.
 *
 * @experimental
 */
export const RUN_SPEC_ISSUE_CODES = Object.freeze(
  Object.keys(RUN_SPEC_ISSUE_FAMILIES) as RunSpecIssueCode[],
);

/**
 * Shape codes the JSON Schema agrees with the validator on.
 *
 * @remarks
 * For any JSON document that does not trip the input guard
 * (`RUN_SPEC_INPUT_NOT_JSON`, `RUN_SPEC_INPUT_TOO_LARGE`,
 * `RUN_SPEC_INPUT_TOO_DEEP`), `runSpecJsonSchema` rejects the document
 * exactly when the validator reports at least one of these codes. The other
 * shape codes describe the call (the rule set, the input guard, the cut of a
 * long issue list), which a JSON Schema cannot express.
 *
 * @experimental
 */
export const RUN_SPEC_SCHEMA_ISSUE_CODES = Object.freeze([
  "RUN_SPEC_VERSION_UNSUPPORTED",
  "RUN_SPEC_MISSING_KEY",
  "RUN_SPEC_UNKNOWN_KEY",
  "RUN_SPEC_INVALID_TYPE",
  "RUN_SPEC_INVALID_VALUE",
  "RUN_SPEC_INVALID_FORMAT",
  "RUN_SPEC_STRING_TOO_SHORT",
  "RUN_SPEC_STRING_TOO_LONG",
  "RUN_SPEC_ARRAY_TOO_SHORT",
  "RUN_SPEC_ARRAY_TOO_LONG",
  "RUN_SPEC_TOO_MANY_LANES",
  "RUN_SPEC_TOO_MANY_DEPENDENCIES",
  "RUN_SPEC_NUMBER_OUT_OF_RANGE",
  "RUN_SPEC_EXTENSION_KEY_INVALID",
] as const satisfies readonly RunSpecIssueCode[]);

/**
 * Most issues one validation returns.
 *
 * @remarks
 * A longer list is cut to this length, with `RUN_SPEC_ISSUES_TRUNCATED` as
 * its last entry, so a hostile spec cannot make the result large.
 *
 * @experimental
 */
export const RUN_SPEC_MAX_ISSUES = 256;

/**
 * Longest issue message, in UTF-16 code units.
 *
 * @experimental
 */
export const RUN_SPEC_MAX_ISSUE_MESSAGE_LENGTH = 512;

/**
 * Most unknown keys of one object reported as separate issues.
 *
 * @experimental
 */
export const RUN_SPEC_MAX_UNKNOWN_KEYS_REPORTED = 16;

/**
 * Schema of one validation issue.
 *
 * @experimental
 */
export const RunSpecIssueSchema = z
  .strictObject({
    code: z
      .enum(RUN_SPEC_ISSUE_CODES as [RunSpecIssueCode, ...RunSpecIssueCode[]])
      .describe("Stable code of the issue. Branch on it."),
    path: z
      .array(z.union([z.string(), z.int().min(0)]))
      .max(32)
      .describe(
        "Location of the value in the spec, as object keys and array indexes from the root. Empty for the whole spec.",
      ),
    message: z
      .string()
      .min(1)
      .max(RUN_SPEC_MAX_ISSUE_MESSAGE_LENGTH)
      .describe(
        "Explanation for people. It may change between releases and never holds a secret.",
      ),
  })
  .meta({
    id: "RunSpecIssue",
    description: "One reason a run spec was rejected.",
  });

/**
 * One reason a run spec was rejected.
 *
 * @experimental
 */
export type RunSpecIssue = z.infer<typeof RunSpecIssueSchema>;

/**
 * Location of a value in a run spec: object keys and array indexes from the
 * root.
 *
 * @experimental
 */
export type RunSpecIssuePath = RunSpecIssue["path"];

/**
 * Family of an issue code.
 *
 * @param code - Issue code.
 * @returns The family that reports the code.
 * @experimental
 */
export function runSpecIssueFamily(code: RunSpecIssueCode): RunSpecIssueFamily {
  return RUN_SPEC_ISSUE_FAMILIES[code];
}

/**
 * Builds an issue, cutting the message to
 * {@link RUN_SPEC_MAX_ISSUE_MESSAGE_LENGTH}.
 *
 * @remarks
 * Rule families build every issue through this function so a value copied
 * from the spec into a message cannot make the result large.
 *
 * @param code - Issue code.
 * @param path - Location of the value in the spec.
 * @param message - Explanation for people.
 * @returns The issue.
 * @experimental
 */
export function runSpecIssue(
  code: RunSpecIssueCode,
  path: RunSpecIssuePath,
  message: string,
): RunSpecIssue {
  return {
    code,
    path: [...path],
    message:
      message.length > RUN_SPEC_MAX_ISSUE_MESSAGE_LENGTH
        ? `${message.slice(0, RUN_SPEC_MAX_ISSUE_MESSAGE_LENGTH - 3)}...`
        : message,
  };
}
