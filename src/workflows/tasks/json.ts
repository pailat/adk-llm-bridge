/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import {
  WorkflowTaskControlError,
  type WorkflowTaskJsonValue,
} from "./contracts.js";

export interface WorkflowTaskJsonLimits {
  maxDepth: number;
  maxNodes: number;
  maxStringLength: number;
}

export const DEFAULT_WORKFLOW_TASK_JSON_LIMITS: Readonly<WorkflowTaskJsonLimits> =
  Object.freeze({
    maxDepth: 32,
    maxNodes: 10_000,
    maxStringLength: 1_048_576,
  });

export function immutableTaskJson<T>(
  value: T,
  limits: WorkflowTaskJsonLimits = DEFAULT_WORKFLOW_TASK_JSON_LIMITS,
): T {
  validateLimits(limits);
  const seen = new Set<object>();
  let nodes = 0;

  const visit = (candidate: unknown, depth: number): WorkflowTaskJsonValue => {
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
        return Object.freeze(candidate.map((item) => visit(item, depth + 1)));
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        invalid("JSON objects must use a plain prototype");
      }
      const result: Record<string, WorkflowTaskJsonValue> = {};
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

function validateLimits(limits: WorkflowTaskJsonLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      invalid(`JSON limit ${name} must be a positive safe integer`);
    }
  }
}

function invalid(message: string): never {
  throw new WorkflowTaskControlError("WORKFLOW_TASK_INVALID_REQUEST", message);
}
