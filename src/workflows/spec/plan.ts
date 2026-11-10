import { immutableJson } from "../execution/json.js";
import { canonicalDigest } from "../internal/canonical-hash.js";
import {
  layerRunSpecLanes,
  type RunRuleKey,
  type RunRules,
  type RunSpec,
  type RunSpecLane,
  runSpecLaneMaxAgentRuns,
  runSpecPlanTopology,
} from "./schema.js";
import type {
  RunPlan,
  RunPlanAgent,
  RunPlanLane,
  RunPlanLimit,
  RunPlanResult,
  RunPlanStartInput,
} from "./types.js";
import { checkRunSpec } from "./validate.js";

function limit(
  rules: RunRules,
  rule: RunRuleKey,
  value: number,
  ceiling: number,
): RunPlanLimit {
  return {
    value,
    ceiling,
    rule,
    ruleSets: [...(rules.origins?.[rule] ?? [rules.id])],
  };
}

function laneAgents(lane: RunSpecLane): RunPlanAgent[] {
  const agents: RunPlanAgent[] = [];
  const rounds =
    lane.steps.review.kind === "agent" ? lane.steps.review.maxChangeRounds : 0;
  const base = {
    providerId: lane.agent.providerId,
    model: lane.agent.model,
    mode: lane.agent.mode,
    allowNetwork: lane.agent.allowNetwork ?? false,
    tools: [...lane.agent.tools],
  };
  if (lane.steps.testsFirst) {
    agents.push({ purpose: "tests", ...base, maxRuns: 1 });
  }
  agents.push({ purpose: "implement", ...base, maxRuns: 1 + rounds });
  const review = lane.steps.review;
  if (review.kind === "agent") {
    agents.push({
      purpose: "review",
      providerId: review.providerId,
      model: review.model,
      mode: "read-only",
      allowNetwork: false,
      tools: [],
      maxRuns: 1 + rounds,
    });
  }
  return agents;
}

function startInput(spec: RunSpec): RunPlanStartInput {
  try {
    immutableJson(spec);
    return "inline";
  } catch {
    return "reference";
  }
}

/**
 * Resolves the dry-run plan of a run spec.
 *
 * @remarks
 * Validates first with `validateRunSpec` and returns its issues unchanged
 * when the spec is invalid. The rule set is read once: the ceilings and rule
 * set ids in the plan come from the copy that was validated, never from a
 * second read of the host's object. For a valid spec the plan lists the
 * lanes in dependency order (by wave, then spec order), the waves, the
 * agents of each lane, the
 * effective limits with the rule sets behind each ceiling, the worst-case
 * cost bound, and the effective denied path patterns the host enforces on
 * writes. The result depends only on the arguments: it reads no clock and
 * no random source, and the input is not modified.
 *
 * @param spec - The value to plan.
 * @param rules - The host's rules.
 * @returns The plan, or the validation issues.
 * @experimental
 */
export function resolveRunPlan(spec: unknown, rules: RunRules): RunPlanResult {
  const checked = checkRunSpec(spec, rules);
  if (!checked.ok) return { ok: false, errors: checked.errors };
  const valid = checked.spec;

  const layering = layerRunSpecLanes(valid.lanes);
  const waves = layering.waves;
  const byId = new Map<string, RunSpecLane>();
  for (const lane of valid.lanes) byId.set(lane.taskId, lane);

  const lanes: RunPlanLane[] = [];
  let totalRuns = 0;
  let widest = 0;
  let rounds = 0;
  for (const [waveIndex, wave] of waves.entries()) {
    widest = Math.max(widest, wave.taskIds.length);
    for (const taskId of wave.taskIds) {
      const lane = byId.get(taskId) as RunSpecLane;
      const agents = laneAgents(lane);
      const maxAgentRuns = runSpecLaneMaxAgentRuns(lane.steps);
      totalRuns += maxAgentRuns;
      if (lane.steps.review.kind === "agent") {
        rounds = Math.max(rounds, lane.steps.review.maxChangeRounds);
      }
      lanes.push({
        taskId: lane.taskId,
        title: lane.title,
        role: lane.role,
        dependsOn: [...lane.dependsOn],
        allowedPaths: [...lane.allowedPaths],
        waveId: wave.waveId,
        waveIndex,
        agents,
        maxAgentRuns,
      });
    }
  }

  const topology = runSpecPlanTopology(valid, waves);

  const plan: RunPlan = {
    specVersion: valid.specVersion,
    workflowId: valid.workflowId,
    workflowVersion: valid.workflowVersion,
    projectRoot: valid.projectRoot,
    lanes,
    waves,
    limits: {
      budgetUsd: limit(
        checked.rules,
        "maxBudgetUsd",
        valid.budget.maxUsd,
        checked.rules.maxBudgetUsd,
      ),
      maxConcurrency: limit(
        checked.rules,
        "maxConcurrency",
        valid.maxConcurrency,
        checked.rules.maxConcurrency,
      ),
      lanes: limit(
        checked.rules,
        "maxLanes",
        valid.lanes.length,
        checked.rules.maxLanes,
      ),
      agentRuns: limit(
        checked.rules,
        "maxAgentRuns",
        totalRuns,
        checked.rules.maxAgentRuns,
      ),
      changeRounds: limit(
        checked.rules,
        "maxChangeRounds",
        rounds,
        checked.rules.maxChangeRounds,
      ),
    },
    costBound: {
      maxUsd: valid.budget.maxUsd,
      maxAgentRuns: totalRuns,
      peakConcurrency: Math.min(
        valid.maxConcurrency,
        checked.rules.maxConcurrency,
        widest,
      ),
    },
    startInput: startInput(valid),
    deniedPathPatterns: [...checked.rules.deniedPathPatterns],
    topology,
  };
  return { ok: true, plan };
}

/**
 * Canonical `sha256:` hash of a validated run spec.
 *
 * @remarks
 * The digest of the canonical JSON with sorted keys. Object key order does
 * not change it, and neither does spelling a lane agent's network access as
 * an explicit `false` instead of leaving `allowNetwork` out, because the two
 * mean the same thing. Array order and every other semantic change do change
 * it. The spec passed in is not modified.
 *
 * @param spec - The validated spec.
 * @returns The canonical digest.
 * @experimental
 */
export function runSpecHash(spec: RunSpec): Promise<string> {
  return canonicalDigest({
    ...spec,
    lanes: spec.lanes.map((lane) => {
      if (lane.agent.allowNetwork !== false) return lane;
      const { allowNetwork: _omitted, ...agent } = lane.agent;
      return { ...lane, agent };
    }),
  });
}
