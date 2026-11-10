import { freezeJson } from "../../internal/immutable-json.js";
import { immutableWorkflowOrchestrationJson } from "../../orchestration/json.js";
import {
  RUN_SPEC_MAX_ISSUES,
  type RunSpecIssue,
  type RunSpecIssuePath,
  runSpecIssue,
} from "../issues.js";
import {
  layerRunSpecLanes,
  RUN_SPEC_DRY_RUN_BINDING,
  RUN_SPEC_EXTENSION_LIMITS,
  RUN_SPEC_INPUT_LIMITS,
  RUN_SPEC_LIMITS,
  type RunRules,
  type RunSpec,
  runSpecLaneMaxAgentRuns,
  runSpecPlanTopology,
  runSpecWorkflowPlan,
} from "../schema.js";

type Report = (
  code: Parameters<typeof runSpecIssue>[0],
  path: RunSpecIssuePath,
  message: string,
) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `value` is a number that is at most `limit`; fails closed. */
function withinCap(value: unknown, limit: number): boolean {
  return typeof value === "number" && value <= limit;
}

/**
 * Looks for an accessor or an oversized value in an extension without
 * reading any property through a getter.
 *
 * @returns A reason, or `undefined` when `freezeJson` can safely check it.
 */
function scanExtensionValue(value: unknown): string | undefined {
  const { maxDepth, maxNodes } = RUN_SPEC_EXTENSION_LIMITS;
  let nodes = 0;
  const stack: Array<[unknown, number]> = [[value, 0]];
  while (stack.length > 0) {
    const [candidate, depth] = stack.pop() as [unknown, number];
    nodes++;
    if (nodes > maxNodes) return "has too many values";
    if (depth > maxDepth) return "is nested too deeply";
    if (typeof candidate !== "object" || candidate === null) continue;
    if (Array.isArray(candidate) && candidate.length > maxNodes) {
      return "has too many values";
    }
    // A null prototype is accepted by `freezeJson`; a spec must not carry one.
    const prototype = Object.getPrototypeOf(candidate);
    if (
      prototype !==
      (Array.isArray(candidate) ? Array.prototype : Object.prototype)
    ) {
      return "is not plain JSON";
    }
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key as string] as PropertyDescriptor;
      if (!("value" in descriptor)) return "has an accessor property";
      if (key === "length" && Array.isArray(candidate)) continue;
      stack.push([descriptor.value, depth + 1]);
    }
  }
  return undefined;
}

/** Reports the keys of an `extensions` object whose value is not bounded plain JSON. */
function checkExtensions(
  extensions: unknown,
  path: RunSpecIssuePath,
  report: Report,
): void {
  if (extensions === undefined) return;
  if (!isRecord(extensions)) {
    report(
      "RUN_SPEC_EXTENSION_TOO_LARGE",
      path,
      "extensions must be a plain JSON object.",
    );
    return;
  }
  const keys = Object.keys(extensions);
  if (keys.length > RUN_SPEC_LIMITS.maxExtensions) {
    report(
      "RUN_SPEC_EXTENSION_TOO_LARGE",
      path,
      `extensions has ${keys.length} keys; at most ${RUN_SPEC_LIMITS.maxExtensions} are allowed.`,
    );
    return;
  }
  for (const key of keys) {
    const keyPath = [...path, key];
    const descriptor = Object.getOwnPropertyDescriptor(extensions, key);
    const value = descriptor && "value" in descriptor ? descriptor.value : null;
    let reason: string | undefined =
      descriptor && "value" in descriptor
        ? scanExtensionValue(value)
        : "has an accessor property";
    if (reason === undefined) {
      try {
        freezeJson(value, RUN_SPEC_EXTENSION_LIMITS, (message) => {
          throw new Error(message);
        });
      } catch {
        reason = "is not bounded plain JSON";
      }
    }
    if (reason !== undefined) {
      report(
        "RUN_SPEC_EXTENSION_TOO_LARGE",
        keyPath,
        `The value of an extension ${reason}; the limits are ${RUN_SPEC_EXTENSION_LIMITS.maxDepth} levels, ${RUN_SPEC_EXTENSION_LIMITS.maxNodes} values and ${RUN_SPEC_EXTENSION_LIMITS.maxStringLength} characters per string.`,
      );
    }
  }
}

/** Reports long strings and long arrays everywhere but in `extensions`. */
function checkSizes(
  spec: RunSpec,
  rules: RunRules,
  report: Report,
  full: () => boolean,
): void {
  const stack: Array<[unknown, RunSpecIssuePath]> = [[spec, []]];
  while (stack.length > 0 && !full()) {
    const [value, path] = stack.pop() as [unknown, RunSpecIssuePath];
    if (typeof value === "string") {
      if (!(value.length <= rules.maxStringLength)) {
        report(
          "RUN_SPEC_STRING_LIMIT_EXCEEDED",
          path,
          `A string is ${value.length} characters long; at most ${rules.maxStringLength} are allowed.`,
        );
      }
      continue;
    }
    if (path.length > RUN_SPEC_INPUT_LIMITS.maxDepth) continue;
    if (Array.isArray(value)) {
      const lanes = path.length === 1 && path[0] === "lanes";
      if (!lanes && !(value.length <= rules.maxArrayLength)) {
        report(
          "RUN_SPEC_ARRAY_LIMIT_EXCEEDED",
          path,
          `An array has ${value.length} items; at most ${rules.maxArrayLength} are allowed.`,
        );
      }
      // Children are pushed in reverse so they pop in spec order.
      for (let index = value.length - 1; index >= 0; index--) {
        stack.push([value[index], [...path, index]]);
      }
      continue;
    }
    if (!isRecord(value)) continue;
    const keys = Object.keys(value);
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index] as string;
      // Extension objects sit on the spec and on each lane only.
      const exempt =
        key === "extensions" &&
        (path.length === 0 || (path.length === 2 && path[0] === "lanes"));
      if (!exempt) stack.push([value[key], [...path, key]]);
    }
  }
}

/**
 * Checks the budget rules of a run spec whose shape is already valid and
 * appends one issue per violation.
 *
 * @remarks
 * Covers the budget and concurrency ceilings, the size caps (lanes, strings,
 * arrays, change rounds, worst-case agent runs), the bounds of `extensions`
 * and whether the projected plan fits the plan store, with at most
 * `RUN_SPEC_LIMITS.maxTotalAllowedPaths` paths over all lanes. Every comparison fails
 * closed: a value that is not a number at or below its cap is reported. The
 * function never throws and reads no extension value through a getter.
 *
 * @param spec - The spec, already shape-checked.
 * @param rules - The host's rules.
 * @param issues - Receives the issues found.
 * @experimental
 */
export function checkBudgetRules(
  spec: RunSpec,
  rules: RunRules,
  issues: RunSpecIssue[],
): void {
  const start = issues.length;
  const report: Report = (code, path, message) => {
    issues.push(runSpecIssue(code, path, message));
  };
  // A hostile spec cannot make this family produce an unbounded list.
  const full = (): boolean => issues.length - start >= RUN_SPEC_MAX_ISSUES;

  const maxUsd = (spec.budget as { maxUsd?: unknown } | undefined)?.maxUsd;
  const maxBudget = Math.min(rules.maxBudgetUsd, RUN_SPEC_LIMITS.maxBudgetUsd);
  if (!withinCap(maxUsd, maxBudget)) {
    report(
      "RUN_SPEC_BUDGET_EXCEEDED",
      ["budget", "maxUsd"],
      `The budget must be a number of at most ${rules.maxBudgetUsd} USD.`,
    );
  }

  const maxConcurrency = Math.min(
    rules.maxConcurrency,
    RUN_SPEC_LIMITS.maxConcurrency,
  );
  if (!withinCap(spec.maxConcurrency, maxConcurrency)) {
    report(
      "RUN_SPEC_CONCURRENCY_EXCEEDED",
      ["maxConcurrency"],
      `maxConcurrency must be a number of at most ${rules.maxConcurrency}.`,
    );
  }

  const lanes: unknown[] = Array.isArray(spec.lanes) ? spec.lanes : [];
  if (!(lanes.length <= Math.min(rules.maxLanes, RUN_SPEC_LIMITS.maxLanes))) {
    report(
      "RUN_SPEC_LANE_LIMIT_EXCEEDED",
      ["lanes"],
      `The spec has ${lanes.length} lanes; at most ${rules.maxLanes} are allowed.`,
    );
  }

  let agentRuns = 0;
  for (const lane of lanes) {
    try {
      agentRuns += runSpecLaneMaxAgentRuns(
        (lane as RunSpec["lanes"][number]).steps,
      );
    } catch {
      agentRuns = Number.POSITIVE_INFINITY;
      break;
    }
  }
  if (!(agentRuns <= rules.maxAgentRuns)) {
    report(
      "RUN_SPEC_AGENT_RUN_LIMIT_EXCEEDED",
      ["lanes"],
      `The lanes can use up to ${agentRuns} agent runs; at most ${rules.maxAgentRuns} are allowed.`,
    );
  }

  checkPlanSize(spec, report);

  for (const [index, lane] of lanes.entries()) {
    if (full()) break;
    const review = (lane as RunSpec["lanes"][number] | undefined)?.steps
      ?.review;
    if (review?.kind !== "agent") continue;
    const cap = Math.min(
      rules.maxChangeRounds,
      RUN_SPEC_LIMITS.maxChangeRounds,
    );
    if (!(review.maxChangeRounds <= cap)) {
      report(
        "RUN_SPEC_CHANGE_ROUNDS_EXCEEDED",
        ["lanes", index, "steps", "review", "maxChangeRounds"],
        `A lane allows ${review.maxChangeRounds} change rounds; at most ${rules.maxChangeRounds} are allowed.`,
      );
    }
  }

  checkSizes(spec, rules, report, full);

  checkExtensions(spec.extensions, ["extensions"], report);
  for (const [index, lane] of lanes.entries()) {
    if (full()) break;
    if (isRecord(lane)) {
      checkExtensions(lane.extensions, ["lanes", index, "extensions"], report);
    }
  }
}

/**
 * Reports when the projected plan would not fit the plan store limits, or
 * when the lanes own more paths in total than
 * `RUN_SPEC_LIMITS.maxTotalAllowedPaths`.
 */
function checkPlanSize(spec: RunSpec, report: Report): void {
  let paths = 0;
  for (const lane of spec.lanes) {
    paths += Array.isArray(lane?.allowedPaths) ? lane.allowedPaths.length : 0;
  }
  if (paths > RUN_SPEC_LIMITS.maxTotalAllowedPaths) {
    report(
      "RUN_SPEC_PLAN_TOO_LARGE",
      ["lanes"],
      `The lanes own ${paths} paths in total; at most ${RUN_SPEC_LIMITS.maxTotalAllowedPaths} are allowed in one plan.`,
    );
    return;
  }
  let plan: ReturnType<typeof runSpecWorkflowPlan>;
  try {
    const { waves } = layerRunSpecLanes(spec.lanes);
    plan = runSpecWorkflowPlan(
      runSpecPlanTopology(spec, waves),
      RUN_SPEC_DRY_RUN_BINDING,
    );
  } catch {
    // A spec the projection cannot read has a shape or graph problem that
    // another family reports.
    return;
  }
  try {
    immutableWorkflowOrchestrationJson(plan);
  } catch {
    report(
      "RUN_SPEC_PLAN_TOO_LARGE",
      ["lanes"],
      "The plan this spec maps to is larger than the plan store allows; use fewer lanes or fewer paths per lane.",
    );
  }
}
