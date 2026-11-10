/**
 * Output types of run spec validation and planning.
 *
 * @remarks
 * These are plain TypeScript types, not zod schemas: the library produces
 * these values and never parses them from untrusted input, and several of
 * them are the existing plan types, which have no zod schema to infer from.
 *
 * @packageDocumentation
 */
import type { WorkflowPlanWave } from "../orchestration/contracts.js";
import type { RunSpecIssue } from "./issues.js";
import type {
  RunRuleKey,
  RunSpec,
  RunSpecLane,
  RunSpecPermissionMode,
  RunSpecTopology,
  RunSpecV1,
} from "./schema.js";

/**
 * Result of `validateRunSpec`.
 *
 * @remarks
 * On success `spec` is a deep-frozen copy of the input, unchanged: the
 * validator never repairs a spec. On failure `errors` has at least one issue
 * and at most `RUN_SPEC_MAX_ISSUES`.
 *
 * @experimental
 */
export type RunSpecValidationResult =
  | { ok: true; spec: RunSpec }
  | { ok: false; errors: RunSpecIssue[] };

/**
 * A wave of the dry-run plan: the existing plan wave, unchanged.
 *
 * @remarks
 * `waveId` is `wave-1`, `wave-2` and so on. Every lane of a wave depends only
 * on lanes of earlier waves, so the lanes of one wave can run in parallel, up
 * to the concurrency limit of the plan.
 *
 * @experimental
 */
export type RunPlanWave = WorkflowPlanWave;

/**
 * What an agent run of a lane is for.
 *
 * @experimental
 */
export type RunPlanAgentPurpose = "tests" | "implement" | "review";

/**
 * One agent a lane uses, with the settings the host must apply.
 *
 * @experimental
 */
export type RunPlanAgent = {
  /** What the agent's runs are for. */
  purpose: RunPlanAgentPurpose;
  /** Provider that runs the agent. */
  providerId: string;
  /** Model the agent uses. */
  model: string;
  /**
   * Permission mode of the agent. A reviewer always runs `read-only`.
   */
  mode: RunSpecPermissionMode;
  /** Whether the agent may reach the network. A reviewer never may. */
  allowNetwork: boolean;
  /** Tools the agent may use. A reviewer has none. */
  tools: string[];
  /** Most runs of this agent the lane can need. */
  maxRuns: number;
};

/**
 * One lane of the dry-run plan.
 *
 * @experimental
 */
export type RunPlanLane = Pick<
  RunSpecLane,
  "taskId" | "title" | "role" | "dependsOn" | "allowedPaths"
> & {
  /** Wave the lane runs in. */
  waveId: string;
  /** Zero-based position of that wave. */
  waveIndex: number;
  /**
   * Agents of the lane, in the order of their first run: tests (when the
   * lane writes tests first), implement, review (when the lane is reviewed).
   */
  agents: RunPlanAgent[];
  /** Most agent runs the lane can need; the sum of its agents' `maxRuns`. */
  maxAgentRuns: number;
};

/**
 * One effective limit of the plan and where its ceiling came from.
 *
 * @remarks
 * `value` is what the run will use and never exceeds `ceiling`: a spec above
 * a ceiling is rejected, not reduced.
 *
 * @experimental
 */
export type RunPlanLimit = {
  /** Value the run uses, taken from the spec. */
  value: number;
  /** Largest value the rule set allows. */
  ceiling: number;
  /** Rule the ceiling comes from. */
  rule: RunRuleKey;
  /**
   * Ids of the rule sets that decided the ceiling: the `origins` entry of
   * the rule, or the id of the rule set when it was not merged.
   */
  ruleSets: string[];
};

/**
 * Effective limits of the plan.
 *
 * @experimental
 */
export type RunPlanLimits = {
  /** Budget of the run in USD, against `maxBudgetUsd`. */
  budgetUsd: RunPlanLimit;
  /** Lanes running at the same time, against `maxConcurrency`. */
  maxConcurrency: RunPlanLimit;
  /** Number of lanes, against `maxLanes`. */
  lanes: RunPlanLimit;
  /** Worst-case agent runs of the whole run, against `maxAgentRuns`. */
  agentRuns: RunPlanLimit;
  /** Largest change-round count of any lane, against `maxChangeRounds`. */
  changeRounds: RunPlanLimit;
};

/**
 * Worst-case cost of the run.
 *
 * @remarks
 * The library knows no model price, so the bound is not an estimate. It is
 * the ceiling the host must enforce: `maxUsd` is the budget of the spec, and
 * the run stays within it only because the host stops starting agent runs
 * once the metered cost reaches it. `maxAgentRuns` is exact arithmetic on the
 * step policies and needs no enforcement to hold.
 *
 * @experimental
 */
export type RunPlanCostBound = {
  /** Most the run may cost in USD: the budget of the spec. */
  maxUsd: number;
  /** Most agent runs the run can start, summed over the lanes. */
  maxAgentRuns: number;
  /**
   * Most lanes that can be running at once: the smaller of the concurrency
   * limit and the widest wave. Runs already started when the budget is
   * reached are what can overshoot it.
   */
  peakConcurrency: number;
};

/**
 * How the spec travels in the `execution.start` request.
 *
 * @remarks
 * `inline`: the spec fits the size limits of an execution input and is sent
 * as `input`. `reference`: it does not, so the host stores it under its spec
 * hash and sends only the hash.
 *
 * @experimental
 */
export type RunPlanStartInput = "inline" | "reference";

/**
 * The dry-run plan of a valid run spec.
 *
 * @remarks
 * The same spec and rule set always give the same plan: it holds no time, no
 * random value and no host path. It does not hold the spec hash, which is
 * asynchronous to compute; call `runSpecHash` on the validated spec.
 *
 * @experimental
 */
export type RunPlan = {
  /** Version of the spec the plan was made from. */
  specVersion: RunSpecV1["specVersion"];
  /** Workflow that executes the spec. */
  workflowId: string;
  /** Version of that workflow. */
  workflowVersion: string;
  /** Project root of the spec. */
  projectRoot: string;
  /** Lanes in dependency order: by wave, then in spec order. */
  lanes: RunPlanLane[];
  /** Waves in dependency order. */
  waves: RunPlanWave[];
  /** Effective limits and the rule sets behind their ceilings. */
  limits: RunPlanLimits;
  /** Worst-case cost of the run. */
  costBound: RunPlanCostBound;
  /** How the spec travels in the start request. */
  startInput: RunPlanStartInput;
  /**
   * Plan fields the spec determines, accepted by the existing plan
   * validator. The host completes them with `runSpecWorkflowPlan`.
   */
  topology: RunSpecTopology;
};

/**
 * Result of `resolveRunPlan`.
 *
 * @remarks
 * The spec is validated first; `errors` are the issues of `validateRunSpec`.
 *
 * @experimental
 */
export type RunPlanResult =
  | { ok: true; plan: RunPlan }
  | { ok: false; errors: RunSpecIssue[] };

/**
 * The newest version of the run spec.
 *
 * @experimental
 */
export type RunSpecLatest = RunSpecV1;

/**
 * Reserved signature of `upgradeRunSpec`, which will turn a valid spec of any
 * supported version into the newest version.
 *
 * @remarks
 * No implementation exists while version 1 is the only version. An upgrade is
 * pure and never changes the meaning of a spec; the upgraded spec has a new
 * hash.
 *
 * @experimental
 */
export type RunSpecUpgrade = (spec: RunSpec) => RunSpecLatest;
