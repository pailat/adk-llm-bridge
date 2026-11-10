import { immutableJson } from "../execution/json.js";
import { canonicalDigest } from "../internal/canonical-hash.js";
import { validateWorkflowPlan } from "../orchestration/json.js";
import { type RunSpecIssue, runSpecIssue } from "./issues.js";
import {
  layerRunSpecLanes,
  RUN_SPEC_DRY_RUN_BINDING,
  type RunRuleKey,
  type RunRules,
  type RunSpec,
  type RunSpecLane,
  runSpecLaneMaxAgentRuns,
  runSpecPlanTopology,
  runSpecWorkflowPlan,
} from "./schema.js";
import type {
  RunPlan,
  RunPlanAgent,
  RunPlanLane,
  RunPlanLimit,
  RunPlanResult,
  RunPlanStartInput,
} from "./types.js";
import { validateRunSpec } from "./validate.js";

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
 * when the spec is invalid. Otherwise the plan lists the lanes in dependency
 * order (by wave, then spec order), the waves, the agents of each lane, the
 * effective limits with the rule sets behind each ceiling, and the worst-case
 * cost bound. The result depends only on the arguments: it reads no clock and
 * no random source, and the input is not modified.
 *
 * @param spec - The value to plan.
 * @param rules - The host's rules.
 * @returns The plan, or the validation issues.
 * @experimental
 */
export function resolveRunPlan(spec: unknown, rules: RunRules): RunPlanResult {
  const validated = validateRunSpec(spec, rules);
  if (!validated.ok) return { ok: false, errors: validated.errors };
  const valid = validated.spec;

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
  try {
    validateWorkflowPlan(
      runSpecWorkflowPlan(topology, RUN_SPEC_DRY_RUN_BINDING),
    );
  } catch (error) {
    const errors: RunSpecIssue[] = [
      runSpecIssue(
        "RUN_SPEC_PLAN_REJECTED",
        ["lanes"],
        `The workflow plan validator rejected the plan: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      ),
    ];
    return { ok: false, errors };
  }

  const plan: RunPlan = {
    specVersion: valid.specVersion,
    workflowId: valid.workflowId,
    workflowVersion: valid.workflowVersion,
    projectRoot: valid.projectRoot,
    lanes,
    waves,
    limits: {
      budgetUsd: limit(
        rules,
        "maxBudgetUsd",
        valid.budget.maxUsd,
        rules.maxBudgetUsd,
      ),
      maxConcurrency: limit(
        rules,
        "maxConcurrency",
        valid.maxConcurrency,
        rules.maxConcurrency,
      ),
      lanes: limit(rules, "maxLanes", valid.lanes.length, rules.maxLanes),
      agentRuns: limit(rules, "maxAgentRuns", totalRuns, rules.maxAgentRuns),
      changeRounds: limit(
        rules,
        "maxChangeRounds",
        rounds,
        rules.maxChangeRounds,
      ),
    },
    costBound: {
      maxUsd: valid.budget.maxUsd,
      maxAgentRuns: totalRuns,
      peakConcurrency: Math.min(
        valid.maxConcurrency,
        rules.maxConcurrency,
        widest,
      ),
    },
    startInput: startInput(valid),
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
