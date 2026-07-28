/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type { Event } from "@google/adk";
import type { Content } from "@google/genai";
import type { WorkflowUserEvent } from "./events.js";

/** Input accepted by a workflow step. */
export type WorkflowStepInputContent = string | Content;

/** Retry policy applied to one workflow step. */
export interface WorkflowRetryPolicy {
  /** Total number of attempts, including the first execution. */
  maxAttempts: number;
  /** Delay before the second attempt. Defaults to no delay. */
  delayMs?: number;
  /** Multiplier applied to the delay after each failed attempt. */
  backoffMultiplier?: number;
  /** Optional upper bound for a backoff delay. */
  maxDelayMs?: number;
}

/** Behavior when a checkpoint contains a step whose completion is unknown. */
export type WorkflowResumePolicy = "fail" | "retry";

/** A deterministic invocation of a declared ADK sub-agent. */
export interface WorkflowStep {
  /** Stable identifier used for checkpointing and replay. */
  id: string;
  /** Name of a sub-agent declared by the containing WorkflowAgent. */
  agentName: string;
  input: WorkflowStepInputContent;
  /**
   * Relative workspace paths this step may write while its agent is running.
   * Declaring paths requires a workspace adapter on the containing workflow.
   */
  writePaths?: readonly string[];
  retry?: WorkflowRetryPolicy;
  /** Defaults to `fail`, preventing accidental duplicate side effects. */
  resumePolicy?: WorkflowResumePolicy;
  metadata?: Record<string, unknown>;
}

/** Successful result returned by `WorkflowContext.run`. */
export interface WorkflowStepResult {
  status: "completed";
  id: string;
  agentName: string;
  output: string;
  content?: Content;
  events?: readonly Event[];
  stateDelta?: Record<string, unknown>;
  attempts: number;
  startedAt: number;
  completedAt: number;
  replayed?: boolean;
}

/** Failed item returned by all-settled parallel execution. */
export interface WorkflowStepFailure {
  status: "failed";
  id: string;
  agentName: string;
  error: WorkflowSerializedError;
  attempts: number;
  startedAt: number;
  completedAt: number;
}

export type WorkflowStepOutcome = WorkflowStepResult | WorkflowStepFailure;

export type WorkflowParallelFailureMode = "fail-fast" | "all-settled";

export interface WorkflowParallelOptions {
  /** Per-call concurrency override, bounded by the execution-wide limit. */
  concurrency?: number;
  /** Defaults to `fail-fast`. */
  failureMode?: WorkflowParallelFailureMode;
}

/** Limits shared by trusted and sandboxed workflow runtimes. */
export interface WorkflowExecutionLimits {
  maxSteps?: number;
  maxConcurrency?: number;
  maxAttemptsPerStep?: number;
  timeoutMs?: number;
  /** Sandboxed runtime CPU budget per uninterrupted guest turn. */
  cpuTimeMs?: number;
  memoryBytes?: number;
  stackBytes?: number;
  maxSourceBytes?: number;
  maxMessageBytes?: number;
}

export const DEFAULT_WORKFLOW_EXECUTION_LIMITS: Readonly<
  Required<WorkflowExecutionLimits>
> = Object.freeze({
  maxSteps: 100,
  maxConcurrency: 4,
  maxAttemptsPerStep: 1,
  timeoutMs: 5 * 60 * 1000,
  cpuTimeMs: 5 * 1000,
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 512 * 1024,
  maxSourceBytes: 256 * 1024,
  maxMessageBytes: 1024 * 1024,
});

/** Public API available to a trusted workflow handler. */
export interface WorkflowContext {
  readonly input: Content;
  readonly inputText: string;
  readonly signal: AbortSignal;
  run(step: WorkflowStep): Promise<WorkflowStepResult>;
  parallel(
    steps: readonly WorkflowStep[],
    options?: WorkflowParallelOptions,
  ): Promise<WorkflowStepOutcome[]>;
  emit(event: WorkflowUserEvent): void;
}

export type WorkflowOutput = string | Content | undefined;

export type WorkflowHandler = (
  context: WorkflowContext,
) => WorkflowOutput | Promise<WorkflowOutput>;

export interface WorkflowExecutionSummary {
  workflowId: string;
  workflowVersion: string;
  executionId: string;
  status: "completed" | "failed" | "cancelled";
  steps: number;
  replayedSteps: number;
  startedAt: number;
  completedAt: number;
}

export type WorkflowErrorCode =
  | "WORKFLOW_ABORTED"
  | "WORKFLOW_DEFINITION_INVALID"
  | "WORKFLOW_EXECUTION_ERROR"
  | "WORKFLOW_INDETERMINATE_STEP"
  | "WORKFLOW_INPUT_MISMATCH"
  | "WORKFLOW_LIMIT_EXCEEDED"
  | "WORKFLOW_SANDBOX_UNAVAILABLE"
  | "WORKFLOW_SCRIPT_INVALID"
  | "WORKFLOW_SOURCE_MISMATCH"
  | "WORKFLOW_STEP_MISMATCH"
  | "WORKFLOW_UNKNOWN_AGENT"
  | "WORKFLOW_VERSION_MISMATCH";

export interface WorkflowSerializedError {
  code: WorkflowErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: WorkflowErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.details = details;
  }

  toJSON(): WorkflowSerializedError {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}
