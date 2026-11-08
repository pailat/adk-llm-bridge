/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { WorkflowError } from "../contracts.js";
import { canonicalJson, sha256Digest } from "../internal/canonical-hash.js";

/**
 * Stable JSON representation used to detect incompatible workflow resumes.
 * Canonical form: keys sorted by UTF-16 code unit (see `canonical-hash.ts`).
 */
export function stableSerializeWorkflowValue(value: unknown): string {
  try {
    return canonicalJson(value);
  } catch (error) {
    throw new WorkflowError(
      "WORKFLOW_EXECUTION_ERROR",
      "Workflow value cannot be hashed",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

export async function hashWorkflowValue(value: unknown): Promise<string> {
  return await sha256Digest(stableSerializeWorkflowValue(value));
}

export function hashWorkflowSource(source: string): Promise<string> {
  return hashWorkflowValue(source);
}

export function hashWorkflowInput(input: unknown): Promise<string> {
  return hashWorkflowValue(input);
}
