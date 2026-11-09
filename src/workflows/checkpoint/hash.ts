import { WorkflowError } from "../contracts.js";
import { canonicalJson, sha256Digest } from "../internal/canonical-hash.js";

/**
 * Serializes a value to the stable JSON used to detect incompatible workflow resumes.
 *
 * @remarks
 * Canonical form: keys sorted by UTF-16 code unit (see `canonical-hash.ts`).
 *
 * @param value - JSON-compatible value.
 * @returns The canonical JSON string.
 * @throws {@link WorkflowError} with code `WORKFLOW_EXECUTION_ERROR` when the value cannot be serialized.
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

/**
 * Hashes the canonical JSON of a value with SHA-256.
 *
 * @param value - JSON-compatible value.
 * @returns The digest string.
 * @throws {@link WorkflowError} with code `WORKFLOW_EXECUTION_ERROR` when the value cannot be serialized.
 */
export async function hashWorkflowValue(value: unknown): Promise<string> {
  return await sha256Digest(stableSerializeWorkflowValue(value));
}

/**
 * Hashes a script workflow source so a resume can detect source edits.
 *
 * @param source - Script source text.
 * @returns The digest string.
 */
export function hashWorkflowSource(source: string): Promise<string> {
  return hashWorkflowValue(source);
}

/**
 * Hashes a workflow or step input so a resume can detect input changes.
 *
 * @param input - JSON-compatible input.
 * @returns The digest string.
 * @throws {@link WorkflowError} with code `WORKFLOW_EXECUTION_ERROR` when the input cannot be serialized.
 */
export function hashWorkflowInput(input: unknown): Promise<string> {
  return hashWorkflowValue(input);
}
