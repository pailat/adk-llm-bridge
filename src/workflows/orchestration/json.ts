import { isWorkflowIdentifier } from "../internal/identifiers.js";
import { freezeJson } from "../internal/immutable-json.js";
import { portablePathProblem } from "../internal/portable-path.js";
import {
  WORKFLOW_ORCHESTRATION_STATE_PROTOCOL,
  WORKFLOW_ORCHESTRATION_STATE_VERSION,
  WORKFLOW_PLAN_PROTOCOL,
  WORKFLOW_PLAN_VERSION,
  type WorkflowActorPermission,
  type WorkflowActorRole,
  type WorkflowMutationReservation,
  WorkflowOrchestrationControlError,
  type WorkflowOrchestrationState,
  type WorkflowOwnershipGrant,
  type WorkflowOwnershipProposal,
  type WorkflowPathClaim,
  type WorkflowPlan,
  type WorkflowPlanAgent,
  type WorkflowPlanInvariant,
  type WorkflowPlanLane,
  type WorkflowPlanWave,
} from "./contracts.js";

/**
 * Bounds enforced on JSON values stored in plans and orchestration state.
 *
 * @internal
 */
export interface WorkflowOrchestrationJsonLimits {
  /** Maximum nesting depth. */
  maxDepth: number;
  /** Maximum number of values, counting containers and leaves. */
  maxNodes: number;
  /** Maximum length of any string value or object key. */
  maxStringLength: number;
}

/**
 * Default {@link WorkflowOrchestrationJsonLimits}: depth 32, 20,000 nodes, 1 MiB strings.
 *
 * @internal
 */
export const DEFAULT_WORKFLOW_ORCHESTRATION_JSON_LIMITS: Readonly<WorkflowOrchestrationJsonLimits> =
  Object.freeze({
    maxDepth: 32,
    maxNodes: 20_000,
    maxStringLength: 1_048_576,
  });

const ACTOR_ROLES = new Set<WorkflowActorRole>([
  "architect",
  "worker",
  "integration",
  "critic",
]);
const ACTOR_PERMISSIONS = new Set<WorkflowActorPermission>([
  "plan:read",
  "plan:activate",
  "task:spawn",
  "task:mailbox:send",
  "task:read",
  "task:cancel",
  "task:manage",
  "ownership:claim",
  "ownership:propose",
  "ownership:approve",
  "ownership:transfer",
  "ownership:release",
  "changes:validate",
  "integration:publish",
]);

/**
 * Validates a JSON value and returns a deep-frozen copy.
 *
 * @param value - Value to validate and copy.
 * @param limits - Size bounds to enforce.
 * @returns A deep-frozen copy of `value`.
 * @throws {@link WorkflowOrchestrationControlError} with code `WORKFLOW_ORCHESTRATION_INVALID_REQUEST`
 * when the value has a cycle, a non-finite number, a non-plain object, a
 * symbol-keyed property, a sparse array, or
 * exceeds `limits`.
 * @internal
 */
export function immutableWorkflowOrchestrationJson<T>(
  value: T,
  limits: WorkflowOrchestrationJsonLimits = DEFAULT_WORKFLOW_ORCHESTRATION_JSON_LIMITS,
): T {
  return freezeJson(value, limits, invalid);
}

/**
 * Validates the structure of a {@link WorkflowPlan}.
 *
 * @remarks
 * Checks protocol and version, identifiers, role and permission values, lane
 * and wave references, normalized claim paths, that no two lanes own
 * overlapping paths, and that only `integration` lanes touch `reservedPaths`.
 *
 * @param plan - Plan to validate.
 * @throws {@link WorkflowOrchestrationControlError} with code `WORKFLOW_ORCHESTRATION_INVALID_REQUEST`
 * when any rule fails.
 */
export function validateWorkflowPlan(plan: WorkflowPlan): void {
  snapshotWorkflowPlan(plan);
}

/**
 * Copies a plan into a deep-frozen JSON snapshot and validates the snapshot.
 *
 * @remarks
 * The checks run on the copy, so the returned plan is exactly the one that
 * was validated even when the input has getters or is a proxy.
 *
 * @param value - Untrusted plan.
 * @returns The validated, frozen plan.
 * @throws {@link WorkflowOrchestrationControlError} with code `WORKFLOW_ORCHESTRATION_INVALID_REQUEST`
 * under the same conditions as {@link validateWorkflowPlan}.
 * @internal
 */
export function snapshotWorkflowPlan(value: WorkflowPlan): WorkflowPlan {
  const plan = immutableWorkflowOrchestrationJson(value);
  objectWithFields(
    plan,
    [
      "protocol",
      "version",
      "executionId",
      "planRevision",
      "baseRevision",
      "objective",
      "status",
      "createdAt",
      "agents",
      "lanes",
      "waves",
      "invariants",
      "reservedPaths",
    ],
    "Workflow plan",
  );
  if (
    plan.protocol !== WORKFLOW_PLAN_PROTOCOL ||
    plan.version !== WORKFLOW_PLAN_VERSION ||
    !positiveSafeInteger(plan.planRevision) ||
    (plan.status !== "draft" && plan.status !== "ready") ||
    !validTimestamp(plan.createdAt)
  ) {
    invalid("Workflow plan header is invalid");
  }
  identifier(plan.executionId, "executionId");
  // The same grammar as change sets, which must name this base revision.
  if (!isWorkflowIdentifier(plan.baseRevision, "revision")) {
    invalid("Workflow baseRevision is invalid");
  }
  nonEmptyText(plan.objective, "objective", 16_384);
  array(plan.agents, "agents");
  array(plan.lanes, "lanes");
  array(plan.waves, "waves");
  array(plan.invariants, "invariants");
  array(plan.reservedPaths, "reservedPaths");
  if (plan.agents.length === 0 || plan.lanes.length === 0) {
    invalid("Workflow plan requires agents and lanes");
  }

  const agents = uniqueBy(plan.agents, (agent) => agent.agentId, "agentId");
  for (const agent of plan.agents) validateAgent(agent);
  const lanes = uniqueBy(plan.lanes, (lane) => lane.taskId, "taskId");
  for (const lane of plan.lanes) validateLane(lane, agents);
  validateLaneDependencies(plan.lanes, lanes);
  validateWaves(plan.waves, plan.lanes, lanes);
  uniqueBy(
    plan.invariants,
    (invariant) => invariant.invariantId,
    "invariantId",
  );
  for (const invariant of plan.invariants) validateInvariant(invariant);
  validateClaimSet(plan.reservedPaths, "reservedPaths");
  validateOwnershipLayout(plan);
  return plan;
}

/**
 * Validates the structure of a {@link WorkflowOrchestrationState}.
 *
 * @param state - State aggregate to validate.
 * @throws {@link WorkflowOrchestrationControlError} with code `WORKFLOW_ORCHESTRATION_INVALID_REQUEST`
 * when any field, grant, proposal or reservation is malformed.
 */
export function validateWorkflowOrchestrationState(
  state: WorkflowOrchestrationState,
): void {
  snapshotWorkflowOrchestrationState(state);
}

/**
 * Copies orchestration state into a deep-frozen JSON snapshot and validates
 * the snapshot.
 *
 * @remarks
 * The checks run on the copy, so the returned state is exactly the one that
 * was validated even when the input has getters or is a proxy.
 *
 * @param value - Untrusted state aggregate.
 * @returns The validated, frozen state.
 * @throws {@link WorkflowOrchestrationControlError} with code `WORKFLOW_ORCHESTRATION_INVALID_REQUEST`
 * under the same conditions as {@link validateWorkflowOrchestrationState}.
 * @internal
 */
export function snapshotWorkflowOrchestrationState(
  value: WorkflowOrchestrationState,
): WorkflowOrchestrationState {
  const state = immutableWorkflowOrchestrationJson(value);
  objectWithFields(
    state,
    [
      "protocol",
      "version",
      "executionId",
      "revision",
      "activePlanRevision",
      "nextFencingToken",
      "grants",
      "proposals",
      "reservations",
      "updatedAt",
    ],
    "Workflow orchestration state",
  );
  if (
    state.protocol !== WORKFLOW_ORCHESTRATION_STATE_PROTOCOL ||
    state.version !== WORKFLOW_ORCHESTRATION_STATE_VERSION ||
    !positiveSafeInteger(state.revision) ||
    !positiveSafeInteger(state.nextFencingToken) ||
    !validTimestamp(state.updatedAt) ||
    (state.activePlanRevision !== undefined &&
      !positiveSafeInteger(state.activePlanRevision))
  ) {
    invalid("Workflow orchestration state header is invalid");
  }
  identifier(state.executionId, "executionId");
  array(state.grants, "grants");
  array(state.proposals, "proposals");
  const reservations = state.reservations ?? [];
  array(reservations, "reservations");
  if (
    state.activePlanRevision === undefined &&
    (state.grants.length > 0 ||
      state.proposals.length > 0 ||
      reservations.length > 0)
  ) {
    invalid("Ownership state requires an active plan revision");
  }
  uniqueBy(state.grants, (grant) => grant.grantId, "grantId");
  uniqueBy(state.grants, (grant) => String(grant.fencingToken), "fencingToken");
  for (const grant of state.grants) validateGrant(grant, state);
  assertNoOverlappingGrants(state.grants);
  uniqueBy(state.proposals, (proposal) => proposal.proposalId, "proposalId");
  for (const proposal of state.proposals) validateProposal(proposal, state);
  uniqueBy(
    reservations,
    (reservation) => reservation.reservationId,
    "reservationId",
  );
  uniqueBy(reservations, (reservation) => reservation.receiptId, "receiptId");
  for (const reservation of reservations)
    validateReservation(reservation, state);
  return state;
}

/**
 * Backward-compatible projection for state records created before v1 reservations.
 *
 * @internal
 */
export function workflowMutationReservations(
  state: WorkflowOrchestrationState,
): readonly WorkflowMutationReservation[] {
  return state.reservations ?? Object.freeze([]);
}

/**
 * Validates a repository-relative path used in ownership claims.
 *
 * @remarks
 * Uses the package's portable path rules, shared with workspace leases and
 * change sets, and accepts only their canonical spelling: rejects blank paths,
 * absolute paths, drive prefixes such as `C:`, backslashes, NUL, empty, `.`
 * and `..` segments, trailing slashes and paths longer than 4096 characters.
 * This keeps claims normalized so overlap checks cannot be bypassed by
 * alternate spellings.
 *
 * @param path - Path to validate.
 * @param field - Field name used in the error message.
 * @throws {@link WorkflowOrchestrationControlError} with code `WORKFLOW_ORCHESTRATION_INVALID_REQUEST`
 * when the path is not normalized and repository-relative.
 * @internal
 */
export function validateWorkflowPath(path: string, field = "path"): void {
  if (portablePathProblem(path, { canonical: true }) !== undefined) {
    invalid(`Workflow ${field} must be a normalized repository-relative path`);
  }
}

/**
 * Tells whether two path claims cover any common path.
 *
 * @remarks
 * Equal paths overlap; a `subtree` claim also overlaps every descendant path.
 *
 * @param left - First claim.
 * @param right - Second claim.
 * @returns `true` when the claims overlap.
 */
export function workflowPathClaimsOverlap(
  left: WorkflowPathClaim,
  right: WorkflowPathClaim,
): boolean {
  if (left.path === right.path) return true;
  return (
    (left.scope === "subtree" && isDescendant(right.path, left.path)) ||
    (right.scope === "subtree" && isDescendant(left.path, right.path))
  );
}

function validateAgent(agent: WorkflowPlanAgent): void {
  objectWithFields(
    agent,
    ["agentId", "policy", "metadata"],
    "Workflow plan agent",
  );
  identifier(agent.agentId, "agentId");
  objectWithFields(
    agent.policy,
    [
      "role",
      "permissions",
      "canDelegate",
      "allowedDelegateRoles",
      "maxChildren",
    ],
    "Workflow actor policy",
  );
  if (!ACTOR_ROLES.has(agent.policy.role))
    invalid("Workflow actor role is invalid");
  array(agent.policy.permissions, "actor permissions");
  uniqueStrings(agent.policy.permissions, "actor permissions");
  if (agent.policy.permissions.some((value) => !ACTOR_PERMISSIONS.has(value))) {
    invalid("Workflow actor permission is invalid");
  }
  if (typeof agent.policy.canDelegate !== "boolean") {
    invalid("Workflow actor canDelegate must be boolean");
  }
  if (agent.policy.allowedDelegateRoles !== undefined) {
    array(agent.policy.allowedDelegateRoles, "allowedDelegateRoles");
    uniqueStrings(agent.policy.allowedDelegateRoles, "allowedDelegateRoles");
    if (
      agent.policy.allowedDelegateRoles.some((role) => !ACTOR_ROLES.has(role))
    ) {
      invalid("Workflow allowed delegate role is invalid");
    }
    if (
      !agent.policy.canDelegate &&
      agent.policy.allowedDelegateRoles.length > 0
    ) {
      invalid("Non-delegating actors cannot declare allowed delegate roles");
    }
  }
  if (
    agent.policy.maxChildren !== undefined &&
    (!agent.policy.canDelegate ||
      !Number.isSafeInteger(agent.policy.maxChildren) ||
      agent.policy.maxChildren < 1)
  ) {
    invalid("Workflow actor maxChildren is invalid");
  }
  if (agent.metadata !== undefined) {
    plainObject(agent.metadata, "agent metadata");
    immutableWorkflowOrchestrationJson(agent.metadata);
  }
}

function validateLane(
  lane: WorkflowPlanLane,
  agents: ReadonlyMap<string, WorkflowPlanAgent>,
): void {
  objectWithFields(
    lane,
    [
      "taskId",
      "agentId",
      "role",
      "ownedPaths",
      "mayCreateUnder",
      "dependsOn",
      "acceptance",
    ],
    "Workflow plan lane",
  );
  identifier(lane.taskId, "taskId");
  identifier(lane.agentId, "agentId");
  const agent = agents.get(lane.agentId);
  if (!agent)
    invalid(`Workflow lane references unknown agent: ${lane.agentId}`);
  if (!ACTOR_ROLES.has(lane.role) || agent.policy.role !== lane.role) {
    invalid(`Workflow lane role does not match agent policy: ${lane.taskId}`);
  }
  array(lane.ownedPaths, "ownedPaths");
  array(lane.mayCreateUnder, "mayCreateUnder");
  array(lane.dependsOn, "dependsOn");
  array(lane.acceptance, "acceptance");
  validateClaimSet(lane.ownedPaths, `ownedPaths for ${lane.taskId}`);
  uniqueStrings(lane.mayCreateUnder, `mayCreateUnder for ${lane.taskId}`);
  for (const path of lane.mayCreateUnder)
    validateWorkflowPath(path, "mayCreateUnder");
  uniqueStrings(lane.dependsOn, `dependsOn for ${lane.taskId}`);
  uniqueStrings(lane.acceptance, `acceptance for ${lane.taskId}`);
  for (const item of lane.acceptance) nonEmptyText(item, "acceptance", 4_096);
}

function validateLaneDependencies(
  lanes: readonly WorkflowPlanLane[],
  lanesById: ReadonlyMap<string, WorkflowPlanLane>,
): void {
  for (const lane of lanes) {
    for (const dependency of lane.dependsOn) {
      if (dependency === lane.taskId)
        invalid("Workflow lane cannot depend on itself");
      if (!lanesById.has(dependency)) {
        invalid(`Workflow lane dependency does not exist: ${dependency}`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visiting.has(taskId))
      invalid("Workflow lane dependency graph must be acyclic");
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependency of lanesById.get(taskId)?.dependsOn ?? [])
      visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const lane of lanes) visit(lane.taskId);
}

function validateWaves(
  waves: readonly WorkflowPlanWave[],
  lanes: readonly WorkflowPlanLane[],
  lanesById: ReadonlyMap<string, WorkflowPlanLane>,
): void {
  if (waves.length === 0) invalid("Workflow plan requires waves");
  uniqueBy(waves, (wave) => wave.waveId, "waveId");
  const taskWave = new Map<string, number>();
  for (const [index, wave] of waves.entries()) {
    objectWithFields(wave, ["waveId", "taskIds"], "Workflow plan wave");
    identifier(wave.waveId, "waveId");
    array(wave.taskIds, "wave taskIds");
    if (wave.taskIds.length === 0)
      invalid("Workflow plan waves cannot be empty");
    uniqueStrings(wave.taskIds, `taskIds for ${wave.waveId}`);
    for (const taskId of wave.taskIds) {
      if (!lanesById.has(taskId))
        invalid(`Workflow wave references unknown lane: ${taskId}`);
      if (taskWave.has(taskId))
        invalid(`Workflow lane occurs in multiple waves: ${taskId}`);
      taskWave.set(taskId, index);
    }
  }
  if (taskWave.size !== lanes.length)
    invalid("Every workflow lane must occur in one wave");
  for (const lane of lanes) {
    const laneWave = taskWave.get(lane.taskId) as number;
    for (const dependency of lane.dependsOn) {
      const dependencyWave = taskWave.get(dependency) as number;
      if (dependencyWave >= laneWave) {
        invalid(
          `Workflow dependency must be in an earlier wave: ${lane.taskId}`,
        );
      }
    }
  }
}

function validateInvariant(invariant: WorkflowPlanInvariant): void {
  objectWithFields(
    invariant,
    ["invariantId", "description", "appliesTo", "enforcedBy"],
    "Workflow plan invariant",
  );
  identifier(invariant.invariantId, "invariantId");
  nonEmptyText(invariant.description, "invariant description", 4_096);
  if (
    !["workflow", "ownership", "changes", "integration"].includes(
      invariant.appliesTo,
    ) ||
    !["control-plane", "driver", "host"].includes(invariant.enforcedBy)
  ) {
    invalid("Workflow invariant scope or enforcement is invalid");
  }
}

function validateOwnershipLayout(plan: WorkflowPlan): void {
  const assignments: { lane: WorkflowPlanLane; claim: WorkflowPathClaim }[] =
    [];
  for (const lane of plan.lanes) {
    for (const claim of lane.ownedPaths) {
      for (const existing of assignments) {
        if (workflowPathClaimsOverlap(existing.claim, claim)) {
          invalid(
            `Workflow lanes have overlapping ownership: ${existing.lane.taskId} and ${lane.taskId}`,
          );
        }
      }
      assignments.push({ lane, claim });
    }
    if (lane.role !== "integration") {
      for (const reserved of plan.reservedPaths) {
        if (
          lane.ownedPaths.some((claim) =>
            workflowPathClaimsOverlap(claim, reserved),
          ) ||
          lane.mayCreateUnder.some((path) =>
            workflowPathClaimsOverlap({ path, scope: "subtree" }, reserved),
          )
        ) {
          invalid(
            `Non-integration lane overlaps a reserved path: ${lane.taskId}`,
          );
        }
      }
    }
  }
  if (
    plan.reservedPaths.length > 0 &&
    !plan.lanes.some((lane) => lane.role === "integration")
  ) {
    invalid("Reserved paths require an integration lane");
  }
}

function validateGrant(
  grant: WorkflowOwnershipGrant,
  state: WorkflowOrchestrationState,
): void {
  objectWithFields(
    grant,
    [
      "grantId",
      "taskId",
      "agentId",
      "planRevision",
      "fencingToken",
      "claims",
      "grantedAt",
    ],
    "Workflow ownership grant",
  );
  identifier(grant.grantId, "grantId");
  identifier(grant.taskId, "taskId");
  identifier(grant.agentId, "agentId");
  if (
    !positiveSafeInteger(grant.planRevision) ||
    grant.planRevision !== state.activePlanRevision ||
    !positiveSafeInteger(grant.fencingToken) ||
    grant.fencingToken >= state.nextFencingToken ||
    !validTimestamp(grant.grantedAt) ||
    grant.grantedAt > state.updatedAt
  ) {
    invalid("Workflow ownership grant is invalid");
  }
  array(grant.claims, "grant claims");
  if (grant.claims.length === 0)
    invalid("Workflow ownership grant requires claims");
  validateClaimSet(grant.claims, `claims for ${grant.grantId}`);
}

function validateProposal(
  proposal: WorkflowOwnershipProposal,
  state: WorkflowOrchestrationState,
): void {
  objectWithFields(
    proposal,
    [
      "proposalId",
      "kind",
      "requestedByTaskId",
      "targetTaskId",
      "sourceGrantId",
      "planRevision",
      "claims",
      "status",
      "createdAt",
      "decidedAt",
      "decidedByTaskId",
      "reason",
    ],
    "Workflow ownership proposal",
  );
  identifier(proposal.proposalId, "proposalId");
  identifier(proposal.requestedByTaskId, "requestedByTaskId");
  if (proposal.targetTaskId !== undefined)
    identifier(proposal.targetTaskId, "targetTaskId");
  if (proposal.sourceGrantId !== undefined)
    identifier(proposal.sourceGrantId, "sourceGrantId");
  if (
    !["claim", "transfer", "release"].includes(proposal.kind) ||
    !["pending", "approved", "rejected"].includes(proposal.status) ||
    !positiveSafeInteger(proposal.planRevision) ||
    proposal.planRevision !== state.activePlanRevision ||
    !validTimestamp(proposal.createdAt) ||
    proposal.createdAt > state.updatedAt
  ) {
    invalid("Workflow ownership proposal is invalid");
  }
  array(proposal.claims, "proposal claims");
  validateClaimSet(proposal.claims, `claims for ${proposal.proposalId}`);
  if (
    proposal.kind === "claim" &&
    (!proposal.targetTaskId || proposal.claims.length === 0)
  ) {
    invalid("Ownership claim proposals require targetTaskId and claims");
  }
  if (
    proposal.kind === "transfer" &&
    (!proposal.targetTaskId || !proposal.sourceGrantId)
  ) {
    invalid(
      "Ownership transfer proposals require targetTaskId and sourceGrantId",
    );
  }
  if (proposal.kind === "release" && !proposal.sourceGrantId) {
    invalid("Ownership release proposals require sourceGrantId");
  }
  if (proposal.status === "pending") {
    if (
      proposal.decidedAt !== undefined ||
      proposal.decidedByTaskId !== undefined ||
      proposal.reason !== undefined
    ) {
      invalid("Pending ownership proposals cannot include decision fields");
    }
  } else {
    if (
      proposal.decidedAt === undefined ||
      !validTimestamp(proposal.decidedAt) ||
      proposal.decidedAt < proposal.createdAt ||
      proposal.decidedAt > state.updatedAt ||
      proposal.decidedByTaskId === undefined
    ) {
      invalid("Decided ownership proposals require valid decision fields");
    }
    identifier(proposal.decidedByTaskId, "decidedByTaskId");
    if (proposal.reason !== undefined)
      nonEmptyText(proposal.reason, "proposal reason", 4_096);
  }
}

function validateReservation(
  reservation: WorkflowMutationReservation,
  state: WorkflowOrchestrationState,
): void {
  objectWithFields(
    reservation,
    [
      "reservationId",
      "receiptId",
      "phase",
      "taskId",
      "agentId",
      "planRevision",
      "orchestrationRevision",
      "grants",
      "changeSetDigest",
      "treeId",
      "commitId",
      "targetId",
      "targetRevision",
      "status",
      "createdAt",
      "expiresAt",
      "completedAt",
    ],
    "Workflow mutation reservation",
  );
  identifier(reservation.reservationId, "reservationId");
  identifier(reservation.receiptId, "receiptId");
  identifier(reservation.taskId, "taskId");
  identifier(reservation.agentId, "agentId");
  if (
    !["commit", "integration"].includes(reservation.phase) ||
    !["reserved", "completed", "released", "expired"].includes(
      reservation.status,
    ) ||
    !positiveSafeInteger(reservation.planRevision) ||
    reservation.planRevision !== state.activePlanRevision ||
    !positiveSafeInteger(reservation.orchestrationRevision) ||
    reservation.orchestrationRevision > state.revision ||
    !validTimestamp(reservation.createdAt) ||
    !validTimestamp(reservation.expiresAt) ||
    reservation.expiresAt <= reservation.createdAt ||
    reservation.createdAt > state.updatedAt
  ) {
    invalid("Workflow mutation reservation is invalid");
  }
  array(reservation.grants, "reservation grants");
  if (reservation.grants.length === 0)
    invalid("Workflow mutation reservation requires ownership fences");
  uniqueBy(reservation.grants, (grant) => grant.grantId, "reservation grantId");
  for (const grant of reservation.grants) {
    objectWithFields(
      grant,
      ["grantId", "fencingToken"],
      "Workflow mutation reservation grant",
    );
    identifier(grant.grantId, "grantId");
    if (!positiveSafeInteger(grant.fencingToken))
      invalid("Workflow mutation reservation fencing token is invalid");
    if (
      reservation.status === "reserved" &&
      !state.grants.some(
        (authority) =>
          authority.grantId === grant.grantId &&
          authority.fencingToken === grant.fencingToken &&
          authority.taskId === reservation.taskId &&
          authority.agentId === reservation.agentId &&
          authority.planRevision === reservation.planRevision,
      )
    ) {
      invalid("Active mutation reservation has stale ownership authority");
    }
  }
  digest(reservation.changeSetDigest, "changeSetDigest");
  optionalOpaqueRevision(reservation.treeId, "treeId");
  optionalOpaqueRevision(reservation.commitId, "commitId");
  optionalOpaqueRevision(reservation.targetId, "targetId");
  optionalOpaqueRevision(reservation.targetRevision, "targetRevision");
  if (
    reservation.phase === "commit" &&
    reservation.status === "reserved" &&
    reservation.commitId !== undefined
  ) {
    invalid("Commit reservations cannot bind a commit before completion");
  }
  if (reservation.phase === "commit" && !reservation.treeId) {
    invalid("Commit reservations require an immutable tree revision");
  }
  if (
    reservation.phase === "commit" &&
    reservation.status === "completed" &&
    !reservation.commitId
  ) {
    invalid("Completed commit reservations require a commit revision");
  }
  if (
    reservation.phase === "integration" &&
    (!reservation.commitId ||
      !reservation.targetId ||
      !reservation.targetRevision)
  ) {
    invalid("Integration reservations require commit and target revisions");
  }
  if (reservation.status === "completed") {
    if (
      reservation.completedAt === undefined ||
      !validTimestamp(reservation.completedAt) ||
      reservation.completedAt < reservation.createdAt ||
      reservation.completedAt > state.updatedAt
    ) {
      invalid("Completed mutation reservations require completedAt");
    }
  } else if (reservation.completedAt !== undefined) {
    invalid("Incomplete mutation reservations cannot include completedAt");
  }
}

function validateClaimSet(
  claims: readonly WorkflowPathClaim[],
  field: string,
): void {
  for (const claim of claims) {
    objectWithFields(claim, ["path", "scope"], "Workflow path claim");
    validateWorkflowPath(claim.path, field);
    if (claim.scope !== "exact" && claim.scope !== "subtree") {
      invalid("Workflow path claim scope is invalid");
    }
  }
  for (let left = 0; left < claims.length; left++) {
    for (let right = left + 1; right < claims.length; right++) {
      if (
        workflowPathClaimsOverlap(
          claims[left] as WorkflowPathClaim,
          claims[right] as WorkflowPathClaim,
        )
      ) {
        invalid(`Workflow ${field} contains overlapping claims`);
      }
    }
  }
}

function assertNoOverlappingGrants(
  grants: readonly WorkflowOwnershipGrant[],
): void {
  for (let left = 0; left < grants.length; left++) {
    for (let right = left + 1; right < grants.length; right++) {
      const leftGrant = grants[left] as WorkflowOwnershipGrant;
      const rightGrant = grants[right] as WorkflowOwnershipGrant;
      if (
        leftGrant.claims.some((leftClaim) =>
          rightGrant.claims.some((rightClaim) =>
            workflowPathClaimsOverlap(leftClaim, rightClaim),
          ),
        )
      ) {
        invalid(
          `Workflow ownership grants overlap: ${leftGrant.grantId} and ${rightGrant.grantId}`,
        );
      }
    }
  }
}

function objectWithFields(
  value: unknown,
  fields: readonly string[],
  name: string,
): asserts value is Record<string, unknown> {
  plainObject(value, name);
  const allowed = new Set(fields);
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    invalid(`${name} contains an unknown field`);
  }
}

function plainObject(
  value: unknown,
  name: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${name} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${name} must be a plain object`);
  }
}

function array(
  value: unknown,
  field: string,
): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) invalid(`Workflow ${field} must be an array`);
}

function uniqueBy<T>(
  values: readonly T[],
  key: (value: T) => string,
  field: string,
): ReadonlyMap<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const itemKey = key(value);
    if (result.has(itemKey)) invalid(`Workflow ${field} values must be unique`);
    result.set(itemKey, value);
  }
  return result;
}

function uniqueStrings(values: readonly string[], field: string): void {
  if (values.some((value) => typeof value !== "string")) {
    invalid(`Workflow ${field} must contain strings`);
  }
  if (new Set(values).size !== values.length) {
    invalid(`Workflow ${field} values must be unique`);
  }
}

function identifier(value: string, field: string): void {
  if (!isWorkflowIdentifier(value, "record")) {
    invalid(`Workflow ${field} is invalid`);
  }
}

function nonEmptyText(value: string, field: string, maximum: number): void {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > maximum
  ) {
    invalid(`Workflow ${field} is invalid`);
  }
}

function digest(value: string, field: string): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    invalid(`Workflow ${field} is invalid`);
  }
}

function optionalOpaqueRevision(
  value: string | undefined,
  field: string,
): void {
  if (value !== undefined) nonEmptyText(value, field, 512);
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validTimestamp(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function isDescendant(path: string, ancestor: string): boolean {
  return path.startsWith(`${ancestor}/`);
}

function invalid(message: string): never {
  throw new WorkflowOrchestrationControlError(
    "WORKFLOW_ORCHESTRATION_INVALID_REQUEST",
    message,
  );
}
