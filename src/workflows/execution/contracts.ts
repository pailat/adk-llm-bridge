/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type { WorkflowEvent } from "../events.js";

export type WorkflowExecutionJsonPrimitive = string | number | boolean | null;
export type WorkflowExecutionJsonValue =
  | WorkflowExecutionJsonPrimitive
  | { readonly [key: string]: WorkflowExecutionJsonValue }
  | readonly WorkflowExecutionJsonValue[];

export type WorkflowExecutionStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkflowExecutionRequest {
  executionId: string;
  workflowId: string;
  workflowVersion: string;
  input?: WorkflowExecutionJsonValue;
  metadata?: Readonly<Record<string, WorkflowExecutionJsonValue>>;
}

export interface WorkflowExecutionError {
  code: string;
  message: string;
  details?: Readonly<Record<string, WorkflowExecutionJsonValue>>;
}

export interface WorkflowExecutionRecord extends WorkflowExecutionRequest {
  status: WorkflowExecutionStatus;
  revision: number;
  attempt: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  cancelRequestedAt?: number;
  output?: WorkflowExecutionJsonValue;
  error?: WorkflowExecutionError;
}

export interface WorkflowExecutionListRequest {
  status?: WorkflowExecutionStatus;
  cursor?: string;
  limit?: number;
}

export interface WorkflowExecutionListResult {
  records: readonly WorkflowExecutionRecord[];
  nextCursor?: string;
}

export interface WorkflowExecutionEventCursor {
  executionId: string;
  afterSequence: number;
}

export interface WorkflowExecutionEventRecord {
  executionId: string;
  sequence: number;
  event: WorkflowEvent;
}

export interface WorkflowExecutionEventReadRequest {
  executionId: string;
  cursor?: WorkflowExecutionEventCursor;
  limit?: number;
}

export interface WorkflowExecutionEventReadResult {
  events: readonly WorkflowExecutionEventRecord[];
  cursor: WorkflowExecutionEventCursor;
  hasMore: boolean;
}

export interface WorkflowExecutionResumeRequest {
  executionId: string;
  /** Explicit acknowledgement that the driver resumes from durable checkpoints. */
  strategy: "checkpoint";
}

export interface WorkflowExecutionDriverRequest {
  execution: WorkflowExecutionRecord;
  signal: AbortSignal;
  resumed: boolean;
  emit(event: WorkflowEvent): Promise<void>;
}

export interface WorkflowExecutionDriverResult {
  output?: WorkflowExecutionJsonValue;
}

export interface WorkflowExecutionDriver {
  execute(
    request: WorkflowExecutionDriverRequest,
  ): Promise<WorkflowExecutionDriverResult>;
}

export type WorkflowExecutionControlErrorCode =
  | "WORKFLOW_EXECUTION_INVALID_REQUEST"
  | "WORKFLOW_EXECUTION_NOT_FOUND"
  | "WORKFLOW_EXECUTION_DUPLICATE"
  | "WORKFLOW_EXECUTION_CONFLICT"
  | "WORKFLOW_EXECUTION_CAPACITY_EXCEEDED"
  | "WORKFLOW_EXECUTION_INVALID_TRANSITION"
  | "WORKFLOW_EXECUTION_NOT_OWNED";

export class WorkflowExecutionControlError extends Error {
  readonly code: WorkflowExecutionControlErrorCode;
  readonly details?: Readonly<Record<string, WorkflowExecutionJsonValue>>;

  constructor(
    code: WorkflowExecutionControlErrorCode,
    message: string,
    details?: Readonly<Record<string, WorkflowExecutionJsonValue>>,
  ) {
    super(message);
    this.name = "WorkflowExecutionControlError";
    this.code = code;
    this.details = details;
  }
}
