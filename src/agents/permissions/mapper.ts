import { networkAllowed } from "./network.js";
import type {
  ExternalAgentPermissionMode,
  ExternalAgentPermissionPolicy,
  ProviderPermissionFlags,
} from "./schema.js";

/**
 * Translates a policy into provider-neutral permission flags.
 *
 * @param policy - Policy to translate.
 * @returns Flags for the policy's mode, plus `network` (`true` only for
 * `allowNetwork: true`) and `paths` copied from `allowedPaths`. An unknown
 * mode maps to the read-only flags.
 */
export function mapPermissionPolicyToFlags(
  policy: ExternalAgentPermissionPolicy,
): ProviderPermissionFlags {
  const common = {
    network: networkAllowed(policy),
    paths: policy.allowedPaths,
  };

  switch (policy.mode) {
    case "read-only":
      return { ...common, readOnly: true, requireApproval: false };
    case "ask":
      return { ...common, requireApproval: true };
    case "workspace-write":
      return { ...common, workspaceWrite: true, requireApproval: false };
    case "full-access":
      return { ...common, fullAccess: true, requireApproval: false };
    default:
      // An unknown mode (only reachable from untyped input) fails closed.
      return { ...common, readOnly: true, requireApproval: false };
  }
}

/**
 * Builds a policy from a bare mode, with no network or path settings.
 *
 * @param mode - Permission mode.
 * @returns A policy that only sets `mode`.
 */
export function mapPermissionModeToPolicy(
  mode: ExternalAgentPermissionMode,
): ExternalAgentPermissionPolicy {
  return { mode };
}
