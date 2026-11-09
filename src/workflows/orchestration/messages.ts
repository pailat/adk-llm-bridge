import { isWorkflowIdentifier } from "../internal/identifiers.js";
import { WorkflowOrchestrationControlError } from "./contracts.js";
import {
  immutableWorkflowOrchestrationJson,
  validateWorkflowPath,
} from "./json.js";

/** Protocol identifier carried by every orchestration message. */
export const WORKFLOW_ORCHESTRATION_MESSAGE_PROTOCOL =
  "adk-llm-bridge/orchestration-message" as const;
/** Schema version of {@link WorkflowOrchestrationMessage}. */
export const WORKFLOW_ORCHESTRATION_MESSAGE_VERSION = 1 as const;

interface WorkflowOrchestrationMessageBase<Kind extends string, Payload> {
  protocol: typeof WORKFLOW_ORCHESTRATION_MESSAGE_PROTOCOL;
  version: typeof WORKFLOW_ORCHESTRATION_MESSAGE_VERSION;
  messageId: string;
  executionId: string;
  planRevision: number;
  senderTaskId: string;
  recipientTaskId: string;
  correlationId?: string;
  createdAt: number;
  kind: Kind;
  payload: Payload;
}

/** Announces a published contract and the paths it covers. */
export type WorkflowContractPublishedMessage = WorkflowOrchestrationMessageBase<
  "ContractPublished",
  {
    contractId: string;
    paths: readonly string[];
    summary: string;
  }
>;

/** Asks another task for something this task depends on. */
export type WorkflowDependencyRequestMessage = WorkflowOrchestrationMessageBase<
  "DependencyRequest",
  {
    dependencyTaskId: string;
    request: string;
  }
>;

/** Answers a {@link WorkflowDependencyRequestMessage}. */
export type WorkflowDependencyResponseMessage =
  WorkflowOrchestrationMessageBase<
    "DependencyResponse",
    {
      requestMessageId: string;
      outcome: "accepted" | "rejected" | "fulfilled";
      response: string;
    }
  >;

/**
 * Tells the deciding task that ownership proposal `proposalId` awaits a decision.
 */
export type WorkflowOwnershipRequestMessage = WorkflowOrchestrationMessageBase<
  "OwnershipRequest",
  {
    proposalId: string;
  }
>;

/** Reports the decision on an ownership proposal. */
export type WorkflowOwnershipDecisionMessage = WorkflowOrchestrationMessageBase<
  "OwnershipDecision",
  {
    proposalId: string;
    status: "approved" | "rejected";
    reason?: string;
  }
>;

/**
 * Reports that a task created a new path under a directory it may create under.
 */
export type WorkflowPathCreatedMessage = WorkflowOrchestrationMessageBase<
  "PathCreated",
  {
    path: string;
  }
>;

/**
 * Asks the integration task to integrate a commit that changed the listed paths.
 */
export type WorkflowIntegrationRequestMessage =
  WorkflowOrchestrationMessageBase<
    "IntegrationRequest",
    {
      commit: string;
      changedPaths: readonly string[];
    }
  >;

/** Reports a review finding with its severity and affected paths. */
export type WorkflowReviewFindingMessage = WorkflowOrchestrationMessageBase<
  "ReviewFinding",
  {
    severity: "info" | "warning" | "error";
    summary: string;
    paths: readonly string[];
  }
>;

/** Reports that a task is blocked and which tasks it blocks. */
export type WorkflowBlockerMessage = WorkflowOrchestrationMessageBase<
  "Blocker",
  {
    summary: string;
    blockedTaskIds: readonly string[];
  }
>;

/**
 * Typed message exchanged between orchestrated tasks through their mailboxes.
 *
 * @remarks
 * Discriminated by `kind`. Use {@link parseWorkflowOrchestrationMessage} for
 * untrusted input.
 */
export type WorkflowOrchestrationMessage =
  | WorkflowContractPublishedMessage
  | WorkflowDependencyRequestMessage
  | WorkflowDependencyResponseMessage
  | WorkflowOwnershipRequestMessage
  | WorkflowOwnershipDecisionMessage
  | WorkflowPathCreatedMessage
  | WorkflowIntegrationRequestMessage
  | WorkflowReviewFindingMessage
  | WorkflowBlockerMessage;

const MESSAGE_FIELDS = [
  "protocol",
  "version",
  "messageId",
  "executionId",
  "planRevision",
  "senderTaskId",
  "recipientTaskId",
  "correlationId",
  "createdAt",
  "kind",
  "payload",
] as const;

/**
 * Strictly validates an untrusted JSON envelope and returns a frozen snapshot.
 *
 * @remarks
 * The value is copied first (each getter is called once) and the copy is
 * validated, so the result is exactly what was checked. Symbol keys are
 * rejected.
 *
 * @param value - Untrusted message.
 * @returns The validated, deep-frozen message.
 * @throws {@link WorkflowOrchestrationControlError} with code `WORKFLOW_ORCHESTRATION_INVALID_REQUEST`
 * when the envelope, its kind or its payload is invalid.
 */
export function parseWorkflowOrchestrationMessage(
  value: unknown,
): WorkflowOrchestrationMessage {
  // Validate the frozen copy, never the caller's object: a getter or proxy
  // could otherwise answer the checks and the copy differently.
  const message = plainObject(
    immutableWorkflowOrchestrationJson(
      plainObject(value, "Workflow orchestration message"),
    ),
    "Workflow orchestration message",
  );
  exactFields(message, MESSAGE_FIELDS, "Workflow orchestration message");
  if (
    message.protocol !== WORKFLOW_ORCHESTRATION_MESSAGE_PROTOCOL ||
    message.version !== WORKFLOW_ORCHESTRATION_MESSAGE_VERSION
  ) {
    invalid("Workflow orchestration message protocol or version is invalid");
  }
  identifier(message.messageId, "messageId");
  identifier(message.executionId, "executionId");
  positiveInteger(message.planRevision, "planRevision");
  identifier(message.senderTaskId, "senderTaskId");
  identifier(message.recipientTaskId, "recipientTaskId");
  if (message.correlationId !== undefined)
    identifier(message.correlationId, "correlationId");
  timestamp(message.createdAt, "createdAt");
  const payload = plainObject(message.payload, "Workflow message payload");

  switch (message.kind) {
    case "ContractPublished":
      exactFields(
        payload,
        ["contractId", "paths", "summary"],
        "ContractPublished payload",
      );
      identifier(payload.contractId, "contractId");
      paths(payload.paths, "paths", false);
      text(payload.summary, "summary");
      break;
    case "DependencyRequest":
      exactFields(
        payload,
        ["dependencyTaskId", "request"],
        "DependencyRequest payload",
      );
      identifier(payload.dependencyTaskId, "dependencyTaskId");
      text(payload.request, "request");
      break;
    case "DependencyResponse":
      exactFields(
        payload,
        ["requestMessageId", "outcome", "response"],
        "DependencyResponse payload",
      );
      identifier(payload.requestMessageId, "requestMessageId");
      enumeration(
        payload.outcome,
        ["accepted", "rejected", "fulfilled"],
        "outcome",
      );
      text(payload.response, "response");
      break;
    case "OwnershipRequest":
      exactFields(payload, ["proposalId"], "OwnershipRequest payload");
      identifier(payload.proposalId, "proposalId");
      break;
    case "OwnershipDecision":
      exactFields(
        payload,
        ["proposalId", "status", "reason"],
        "OwnershipDecision payload",
      );
      identifier(payload.proposalId, "proposalId");
      enumeration(payload.status, ["approved", "rejected"], "status");
      if (payload.reason !== undefined) text(payload.reason, "reason");
      break;
    case "PathCreated":
      exactFields(payload, ["path"], "PathCreated payload");
      validateWorkflowPath(valueString(payload.path, "path"));
      break;
    case "IntegrationRequest":
      exactFields(
        payload,
        ["commit", "changedPaths"],
        "IntegrationRequest payload",
      );
      text(payload.commit, "commit", 512);
      paths(payload.changedPaths, "changedPaths", true);
      break;
    case "ReviewFinding":
      exactFields(
        payload,
        ["severity", "summary", "paths"],
        "ReviewFinding payload",
      );
      enumeration(payload.severity, ["info", "warning", "error"], "severity");
      text(payload.summary, "summary");
      paths(payload.paths, "paths", true);
      break;
    case "Blocker":
      exactFields(payload, ["summary", "blockedTaskIds"], "Blocker payload");
      text(payload.summary, "summary");
      identifiers(payload.blockedTaskIds, "blockedTaskIds", true);
      break;
    default:
      invalid("Workflow orchestration message kind is invalid");
  }

  return message as unknown as WorkflowOrchestrationMessage;
}

/**
 * Type guard that tells whether a value is a valid orchestration message.
 *
 * @param value - Candidate value.
 * @returns `true` when {@link parseWorkflowOrchestrationMessage} accepts `value`.
 */
export function isWorkflowOrchestrationMessage(
  value: unknown,
): value is WorkflowOrchestrationMessage {
  try {
    parseWorkflowOrchestrationMessage(value);
    return true;
  } catch {
    return false;
  }
}

function plainObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(`${name} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    invalid(`${name} must be a plain object`);
  return value as Record<string, unknown>;
}

function exactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  name: string,
): void {
  const allowed = new Set(fields);
  if (Object.keys(value).some((field) => !allowed.has(field)))
    invalid(`${name} contains an unknown field`);
}

function identifier(value: unknown, field: string): asserts value is string {
  if (!isWorkflowIdentifier(value, "record")) {
    invalid(`Workflow message ${field} is invalid`);
  }
}

function identifiers(value: unknown, field: string, allowEmpty: boolean): void {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0))
    invalid(`Workflow message ${field} must be an array`);
  for (const item of value) identifier(item, field);
  if (new Set(value).size !== value.length)
    invalid(`Workflow message ${field} values must be unique`);
}

function paths(value: unknown, field: string, allowEmpty: boolean): void {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0))
    invalid(`Workflow message ${field} must be an array`);
  for (const item of value) validateWorkflowPath(valueString(item, field));
  if (new Set(value).size !== value.length)
    invalid(`Workflow message ${field} values must be unique`);
}

function valueString(value: unknown, field: string): string {
  if (typeof value !== "string")
    invalid(`Workflow message ${field} must be a string`);
  return value;
}

function text(value: unknown, field: string, maximum = 16_384): void {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length === 0 ||
    value.length > maximum
  ) {
    invalid(`Workflow message ${field} is invalid`);
  }
}

function positiveInteger(value: unknown, field: string): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    invalid(`Workflow message ${field} must be a positive integer`);
}

function timestamp(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    invalid(`Workflow message ${field} is invalid`);
}

function enumeration(
  value: unknown,
  values: readonly string[],
  field: string,
): void {
  if (typeof value !== "string" || !values.includes(value))
    invalid(`Workflow message ${field} is invalid`);
}

function invalid(message: string): never {
  throw new WorkflowOrchestrationControlError(
    "WORKFLOW_ORCHESTRATION_INVALID_REQUEST",
    message,
  );
}
