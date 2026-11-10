import type { WorkflowPlan } from "../../orchestration/contracts.js";
import { validateWorkflowPlan } from "../../orchestration/json.js";
import { type RunSpecIssue, runSpecIssue } from "../issues.js";
import {
  layerRunSpecLanes,
  RUN_SPEC_DRY_RUN_BINDING,
  type RunRules,
  type RunSpec,
  runSpecPlanTopology,
  runSpecWorkflowPlan,
} from "../schema.js";

/** Most lane ids written into one cycle message. */
const MAX_CYCLE_IDS_SHOWN = 12;

/** Most characters of a spec-supplied id echoed into a message. */
const MAX_ECHOED_ID_LENGTH = 64;

/** Shortens an id taken from the spec so a message stays small. */
function echo(id: string): string {
  return id.length > MAX_ECHOED_ID_LENGTH
    ? `${JSON.stringify(id.slice(0, MAX_ECHOED_ID_LENGTH))}...`
    : JSON.stringify(id);
}

/**
 * Describes the cycle a lane is on, or the cycle it waits for, as a path in
 * dependency order such as `a -> b -> a`.
 */
function describeCycle(
  ring: readonly string[],
  start: number,
  onCycle: boolean,
): string {
  const count = Math.min(ring.length, MAX_CYCLE_IDS_SHOWN);
  const shown: string[] = [];
  for (let i = 0; i < count; i += 1) {
    shown.push(echo(ring[(start + i) % ring.length] as string));
  }
  const more = ring.length > MAX_CYCLE_IDS_SHOWN ? ["..."] : [];
  const path = [...shown, ...more, shown[0] as string].join(" -> ");
  return onCycle
    ? `Lane is on a dependency cycle: ${path}.`
    : `Lane waits for a dependency cycle: ${path}.`;
}

/**
 * The full dry-run plan of a spec, owned paths included.
 *
 * @param spec - A spec that passed every rule family.
 * @returns The plan the existing plan validator checks.
 * @internal
 */
export function fullWorkflowPlan(spec: RunSpec): WorkflowPlan {
  const { waves } = layerRunSpecLanes(spec.lanes);
  return runSpecWorkflowPlan(
    runSpecPlanTopology(spec, waves),
    RUN_SPEC_DRY_RUN_BINDING,
  );
}

/**
 * The dry-run plan of a spec's lane graph, with no owned paths, because path
 * failures belong to the paths family.
 *
 * @param spec - A spec whose graph family found nothing so far.
 * @returns The plan the existing plan validator checks.
 * @internal
 */
export function laneGraphWorkflowPlan(spec: RunSpec): WorkflowPlan {
  const topology = runSpecPlanTopology(
    spec,
    layerRunSpecLanes(spec.lanes).waves,
  );
  return runSpecWorkflowPlan(
    {
      ...topology,
      lanes: topology.lanes.map((lane) => ({ ...lane, ownedPaths: [] })),
    },
    RUN_SPEC_DRY_RUN_BINDING,
  );
}

/**
 * Runs the existing plan validator on `plan` and appends
 * `RUN_SPEC_PLAN_REJECTED` when it objects. Only the validator is guarded:
 * building the plan happens before this call, so a defect there is thrown
 * and reported as `RUN_SPEC_INTERNAL_ERROR` by the caller.
 */
function checkPlanValidator(
  plan: WorkflowPlan,
  what: string,
  issues: RunSpecIssue[],
): void {
  try {
    validateWorkflowPlan(plan);
  } catch (error) {
    issues.push(
      runSpecIssue(
        "RUN_SPEC_PLAN_REJECTED",
        ["lanes"],
        `The workflow plan validator rejected ${what}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      ),
    );
  }
}

/**
 * Runs the existing plan validator on the full plan of a spec, owned paths
 * included, and appends `RUN_SPEC_PLAN_REJECTED` when it objects.
 *
 * @remarks
 * Call it only on a spec every rule family accepted: the paths and budget
 * families then guarantee valid, non-overlapping paths and at most
 * `RUN_SPEC_LIMITS.maxTotalAllowedPaths` claims, which bounds the validator's
 * pairwise ownership check. A defect while building the plan is thrown, not
 * reported as a rejection.
 *
 * @param spec - A spec that passed every rule family.
 * @param issues - Receives the issue, if any.
 * @param project - Builds the plan; tests replace it.
 * @internal
 */
export function checkFullWorkflowPlan(
  spec: RunSpec,
  issues: RunSpecIssue[],
  project: (spec: RunSpec) => WorkflowPlan = fullWorkflowPlan,
): void {
  checkPlanValidator(project(spec), "the plan", issues);
}

/**
 * Checks the graph rules of a run spec whose shape is already valid and
 * appends one issue per violation.
 *
 * @remarks
 * Task ids and dependencies are compared as exact strings, with no trimming
 * or decoding, and are looked up in a `Map`, so ids such as `__proto__` are
 * ordinary names. Two lane ids that differ only in case are also reported as
 * duplicates, because a host may turn an id into a branch, worktree or file
 * name on a case-insensitive file system. The id grammar is ASCII, so lower
 * case is a complete fold. Such a lane still takes part in the other checks
 * under its exact id. Every pass is iterative and linear in
 * lanes plus dependencies. The existing plan validator runs last, on the
 * projected topology without paths, and only when this family found nothing.
 *
 * @param spec - The spec, already shape-checked.
 * @param _rules - The host's rules; no graph rule depends on them.
 * @param issues - Receives the issues found.
 * @param project - Builds the lane graph plan; tests replace it.
 * @experimental
 */
export function checkGraphRules(
  spec: RunSpec,
  _rules: RunRules,
  issues: RunSpecIssue[],
  project: (spec: RunSpec) => WorkflowPlan = laneGraphWorkflowPlan,
): void {
  const before = issues.length;
  const firstIndex = new Map<string, number>();
  const firstFolded = new Map<string, number>();

  // Linear checks, in spec order.
  const clean: { taskId: string; dependsOn: string[] }[] = [];
  const known = new Set<string>();
  for (const lane of spec.lanes) known.add(lane.taskId);
  for (const [index, lane] of spec.lanes.entries()) {
    const duplicateLane = firstIndex.has(lane.taskId);
    if (duplicateLane) {
      issues.push(
        runSpecIssue(
          "RUN_SPEC_LANE_ID_DUPLICATE",
          ["lanes", index, "taskId"],
          `Lane id ${echo(lane.taskId)} is already used by lane ${firstIndex.get(lane.taskId)}.`,
        ),
      );
    } else {
      firstIndex.set(lane.taskId, index);
      const folded = lane.taskId.toLowerCase();
      const caseTwin = firstFolded.get(folded);
      if (caseTwin === undefined) {
        firstFolded.set(folded, index);
      } else {
        issues.push(
          runSpecIssue(
            "RUN_SPEC_LANE_ID_DUPLICATE",
            ["lanes", index, "taskId"],
            `Lane id ${echo(lane.taskId)} differs only in case from the id of lane ${caseTwin}.`,
          ),
        );
      }
    }
    const seen = new Set<string>();
    const kept: string[] = [];
    for (const [position, dependency] of lane.dependsOn.entries()) {
      const path = ["lanes", index, "dependsOn", position];
      if (seen.has(dependency)) {
        issues.push(
          runSpecIssue(
            "RUN_SPEC_DEPENDENCY_DUPLICATE",
            path,
            `Dependency ${echo(dependency)} is listed more than once.`,
          ),
        );
        continue;
      }
      seen.add(dependency);
      if (dependency === lane.taskId) {
        issues.push(
          runSpecIssue(
            "RUN_SPEC_DEPENDENCY_SELF",
            path,
            `Lane ${echo(lane.taskId)} depends on itself.`,
          ),
        );
      } else if (!known.has(dependency)) {
        issues.push(
          runSpecIssue(
            "RUN_SPEC_DEPENDENCY_UNKNOWN",
            path,
            `Dependency ${echo(dependency)} does not name a lane of the spec.`,
          ),
        );
      } else {
        kept.push(dependency);
      }
    }
    if (!duplicateLane) clean.push({ taskId: lane.taskId, dependsOn: kept });
  }

  // Cycles, on the lanes and edges that passed the linear checks.
  const layering = layerRunSpecLanes(clean);
  if (layering.unresolved.length > 0) {
    const unresolved = new Set(layering.unresolved);
    const next = new Map<string, string>();
    for (const lane of clean) {
      if (!unresolved.has(lane.taskId)) continue;
      const target = lane.dependsOn.find((id) => unresolved.has(id));
      if (target !== undefined) next.set(lane.taskId, target);
    }
    // 0 = unseen, 1 = on the current walk, 2 = finished.
    const state = new Map<string, number>();
    const ringOf = new Map<string, readonly string[]>();
    const onCycle = new Set<string>();
    const ringPosition = new Map<string, number>();
    for (const start of layering.unresolved) {
      if (state.has(start)) continue;
      const walk: string[] = [];
      let current: string | undefined = start;
      while (current !== undefined && !state.has(current)) {
        state.set(current, 1);
        walk.push(current);
        current = next.get(current);
      }
      let ring: readonly string[] = [];
      if (current !== undefined && state.get(current) === 1) {
        ring = walk.slice(walk.indexOf(current));
        for (const [position, id] of ring.entries()) {
          onCycle.add(id);
          ringPosition.set(id, position);
        }
      } else if (current !== undefined) {
        ring = ringOf.get(current) ?? [];
      }
      for (const id of walk) {
        ringOf.set(id, ring);
        state.set(id, 2);
      }
    }
    for (const [index, lane] of spec.lanes.entries()) {
      if (firstIndex.get(lane.taskId) !== index) continue;
      if (!unresolved.has(lane.taskId)) continue;
      const ring = ringOf.get(lane.taskId) ?? [];
      if (ring.length === 0) continue;
      const mine = onCycle.has(lane.taskId);
      const at = mine ? (ringPosition.get(lane.taskId) ?? 0) : 0;
      issues.push(
        runSpecIssue(
          "RUN_SPEC_DEPENDENCY_CYCLE",
          ["lanes", index, "dependsOn"],
          describeCycle(ring, at, mine),
        ),
      );
    }
  }

  // The existing validator is the authority; it sees no paths here because
  // path failures belong to the paths family. A defect while building the
  // plan is thrown, so the caller reports it as an internal error.
  if (issues.length === before) {
    checkPlanValidator(project(spec), "the lane graph", issues);
  }
}
