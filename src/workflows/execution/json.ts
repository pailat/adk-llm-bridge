/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import {
  WorkflowExecutionControlError,
  type WorkflowExecutionJsonValue,
} from "./contracts.js";

export interface WorkflowExecutionJsonLimits {
  maxDepth: number;
  maxNodes: number;
  maxStringLength: number;
}

export const DEFAULT_WORKFLOW_EXECUTION_JSON_LIMITS: Readonly<WorkflowExecutionJsonLimits> =
  Object.freeze({
    maxDepth: 32,
    maxNodes: 10_000,
    maxStringLength: 1_048_576,
  });

export function immutableJson<T>(
  value: T,
  limits: WorkflowExecutionJsonLimits = DEFAULT_WORKFLOW_EXECUTION_JSON_LIMITS,
): T {
  validateLimits(limits);
  const seen = new Set<object>();
  let nodes = 0;

  const visit = (
    candidate: unknown,
    depth: number,
  ): WorkflowExecutionJsonValue => {
    nodes++;
    if (nodes > limits.maxNodes) invalid("JSON value exceeds node limit");
    if (depth > limits.maxDepth) invalid("JSON value exceeds depth limit");
    if (candidate === null || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "string") {
      if (candidate.length > limits.maxStringLength) {
        invalid("JSON string exceeds length limit");
      }
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) invalid("JSON numbers must be finite");
      return candidate;
    }
    if (!candidate || typeof candidate !== "object") {
      invalid("Value must be JSON-safe");
    }
    if (seen.has(candidate)) invalid("JSON value must not contain cycles");
    seen.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        const values = candidate.map((item) => visit(item, depth + 1));
        return Object.freeze(values);
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        invalid("JSON objects must use a plain prototype");
      }
      const result: Record<string, WorkflowExecutionJsonValue> = {};
      for (const [key, item] of Object.entries(candidate)) {
        if (key.length > limits.maxStringLength) {
          invalid("JSON object key exceeds length limit");
        }
        if (item === undefined) continue;
        result[key] = visit(item, depth + 1);
      }
      return Object.freeze(result);
    } finally {
      seen.delete(candidate);
    }
  };

  return visit(value, 0) as T;
}

function validateLimits(limits: WorkflowExecutionJsonLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      invalid(`JSON limit ${name} must be a positive safe integer`);
    }
  }
}

function invalid(message: string): never {
  throw new WorkflowExecutionControlError(
    "WORKFLOW_EXECUTION_INVALID_REQUEST",
    message,
  );
}
