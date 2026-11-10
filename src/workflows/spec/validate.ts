import {
  RUN_SPEC_MAX_ISSUES,
  type RunSpecIssue,
  runSpecIssue,
} from "./issues.js";
import { checkBudgetRules } from "./rules/budget.js";
import { checkGateRules } from "./rules/gates.js";
import { checkFullWorkflowPlan, checkGraphRules } from "./rules/graph.js";
import { checkModelRules } from "./rules/models.js";
import { checkPathRules } from "./rules/paths.js";
import { type RunRules, RunRulesSchema, readRuleSet } from "./schema.js";
import { parseRunSpecShape } from "./shape.js";
import type { RunSpecValidationResult } from "./types.js";

/**
 * A rule family: appends the issues it finds for a spec with a valid shape.
 *
 * @internal
 */
export type RunSpecRuleFamily = (
  spec: Parameters<typeof checkPathRules>[0],
  rules: RunRules,
  issues: RunSpecIssue[],
) => void;

/** Rule families in the order their issues are reported. */
const FAMILIES: readonly RunSpecRuleFamily[] = [
  checkPathRules,
  checkBudgetRules,
  checkModelRules,
  checkGraphRules,
  checkGateRules,
];

/**
 * Validates a run spec against the host's rules.
 *
 * @remarks
 * Pure and synchronous: no I/O and no fixes, and the input is never
 * mutated. The rule set is read once into a plain copy (own keys only) and
 * checked first, then the shape; the rule
 * families run, in a fixed order, only on a spec with a valid shape. When
 * every family accepts the spec, the existing plan validator runs on its full
 * plan, owned paths included, as `resolveRunPlan` does. A rule set that does
 * not match `RunRulesSchema` is `RUN_SPEC_RULES_INVALID`, a host error. An
 * exception inside a family is `RUN_SPEC_INTERNAL_ERROR`, a library defect,
 * never a success and never a throw; the families after it are skipped. A
 * list longer than `RUN_SPEC_MAX_ISSUES` is cut and ends with
 * `RUN_SPEC_ISSUES_TRUNCATED`.
 *
 * @param spec - The value to validate.
 * @param rules - The host's rules.
 * @returns The typed spec, or every issue found.
 * @experimental
 */
export function validateRunSpec(
  spec: unknown,
  rules: RunRules,
): RunSpecValidationResult {
  return validateRunSpecWith(spec, rules, FAMILIES);
}

/**
 * {@link validateRunSpec} with the rule families given by the caller.
 *
 * @remarks
 * Lets the tests check how a failing family is reported.
 *
 * @param spec - The value to validate.
 * @param rules - The host's rules.
 * @param families - The rule families, in report order.
 * @returns The typed spec, or every issue found.
 * @internal
 */
export function validateRunSpecWith(
  spec: unknown,
  rules: RunRules,
  families: readonly RunSpecRuleFamily[],
): RunSpecValidationResult {
  // The families read this copy, never the host's object.
  const checkedRules = readRuleSet(RunRulesSchema, rules);
  if (checkedRules === undefined) {
    return {
      ok: false,
      errors: [
        runSpecIssue(
          "RUN_SPEC_RULES_INVALID",
          [],
          "The host rule set does not match the run rules schema.",
        ),
      ],
    };
  }
  const issues: RunSpecIssue[] = [];
  const parsed = parseRunSpecShape(spec, issues);
  if (parsed === undefined || issues.length > 0) {
    return { ok: false, errors: truncate(issues) };
  }
  for (const family of families) {
    try {
      family(parsed, checkedRules, issues);
    } catch {
      issues.push(
        runSpecIssue(
          "RUN_SPEC_INTERNAL_ERROR",
          [],
          "A rule family failed unexpectedly; the families after it did not run.",
        ),
      );
      break;
    }
  }
  if (issues.length === 0) {
    try {
      checkFullWorkflowPlan(parsed, issues);
    } catch {
      issues.push(
        runSpecIssue(
          "RUN_SPEC_INTERNAL_ERROR",
          [],
          "The full plan check failed unexpectedly.",
        ),
      );
    }
  }
  return issues.length === 0
    ? { ok: true, spec: parsed }
    : { ok: false, errors: truncate(issues) };
}

function truncate(issues: RunSpecIssue[]): RunSpecIssue[] {
  if (issues.length <= RUN_SPEC_MAX_ISSUES) return issues;
  return [
    ...issues.slice(0, RUN_SPEC_MAX_ISSUES - 1),
    runSpecIssue(
      "RUN_SPEC_ISSUES_TRUNCATED",
      [],
      `More than ${RUN_SPEC_MAX_ISSUES} issues were found; the list was cut.`,
    ),
  ];
}
