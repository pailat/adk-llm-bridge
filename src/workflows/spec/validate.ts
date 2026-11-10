import {
  RUN_SPEC_MAX_ISSUES,
  type RunSpecIssue,
  runSpecIssue,
} from "./issues.js";
import { checkBudgetRules } from "./rules/budget.js";
import { checkGateRules } from "./rules/gates.js";
import { checkGraphRules } from "./rules/graph.js";
import { checkModelRules } from "./rules/models.js";
import { checkPathRules } from "./rules/paths.js";
import { type RunRules, RunRulesSchema } from "./schema.js";
import { parseRunSpecShape } from "./shape.js";
import type { RunSpecValidationResult } from "./types.js";

type Family = (
  spec: Parameters<typeof checkPathRules>[0],
  rules: RunRules,
  issues: RunSpecIssue[],
) => void;

/** Rule families in the order their issues are reported. */
const FAMILIES: readonly Family[] = [
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
 * mutated. The rule set is checked first, then the shape; the rule
 * families run, in a fixed order, only on a spec with a valid shape. An
 * exception inside a family becomes an issue (reported as
 * `RUN_SPEC_RULES_INVALID` with a fixed message, so it also means an
 * internal failure), never a success and never a throw; the families after
 * it are skipped. A list longer than `RUN_SPEC_MAX_ISSUES` is cut and ends with
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
  let rulesValid = false;
  try {
    rulesValid = RunRulesSchema.safeParse(rules).success;
  } catch {
    rulesValid = false;
  }
  if (!rulesValid) {
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
  for (const family of FAMILIES) {
    try {
      family(parsed, rules, issues);
    } catch {
      issues.push(
        runSpecIssue(
          "RUN_SPEC_RULES_INVALID",
          [],
          "A rule family failed unexpectedly; the families after it did not run.",
        ),
      );
      break;
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
