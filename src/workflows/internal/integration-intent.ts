import type { WorkflowAuthoritativeIntegrationRequest } from "../workspace/change-driver.js";
import { canonicalDigest } from "./canonical-hash.js";

/**
 * Digest that identifies the intent of one integration.
 *
 * @remarks
 * The validated integrator and the Git driver both journal an integration
 * under this digest, so a replay is recognized by either of them.
 *
 * @param request - Normalized authoritative integration request.
 * @returns The canonical SHA-256 digest of the operation id, receipt id,
 * commit id, tree id and expected target.
 * @internal
 */
export async function workflowIntegrationIntentDigest(
  request: WorkflowAuthoritativeIntegrationRequest,
): Promise<string> {
  return await canonicalDigest({
    operationId: request.operationId,
    receiptId: request.receipt.receiptId,
    commitId: request.commit.commitId,
    treeId: request.commit.treeId,
    expectedTarget: request.expectedTarget,
  });
}
