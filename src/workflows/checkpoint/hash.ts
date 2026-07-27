/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { WorkflowError } from "../contracts.js";

/** Stable JSON representation used to detect incompatible workflow resumes. */
export function stableSerializeWorkflowValue(value: unknown): string {
  try {
    return (
      JSON.stringify(value, (_key, current) => {
        if (current && typeof current === "object" && !Array.isArray(current)) {
          return Object.fromEntries(
            Object.entries(current).sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          );
        }
        return current;
      }) ?? "undefined"
    );
  } catch (error) {
    throw new WorkflowError(
      "WORKFLOW_EXECUTION_ERROR",
      "Workflow value cannot be hashed",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

export async function hashWorkflowValue(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableSerializeWorkflowValue(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${toHex(new Uint8Array(digest))}`;
}

export function hashWorkflowSource(source: string): Promise<string> {
  return hashWorkflowValue(source);
}

export function hashWorkflowInput(input: unknown): Promise<string> {
  return hashWorkflowValue(input);
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
